import type { SearchTextAnalysis, SearchTextAnalysisOptions } from "../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import {
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../core/search/index-settings.js";
import {
  DEFAULT_PARTITION_BITS,
  buildCanonicalSearchSnapshotFromSegments,
  scanBuildDocuments,
  shuffleParsedBuildDocumentsByPartition,
  sortParsedBuildDocuments
} from "./search-store/builder.js";
import type { BuiltSegment, BuiltSnapshot, ParsedBuildDocument } from "./search-store/types.js";
import { DaemonWorkerPool, logicalCpuWorkerBudget, optionalWorkerCountFromEnv, workerCountFromEnv, type WorkerPoolRunOptions } from "./worker-pool.js";
import type {
  SearchExecutionCacheStats,
  SearchExecutionJob,
  SearchExecutionPreloadResult,
  SearchExecutionResult,
  SearchExecutionSnapshotHandle,
  SearchShardExecutionJob,
  SearchShardExecutionResult
} from "./search-execution.js";
import type { ParseBuildDocumentsWorkerResult, ReduceBuildSegmentWorkerResult } from "./protocol.js";
import { readOptsidianSettings, type OptsidianSettings } from "../core/settings.js";

export type AnalyzerPoolAnalysis = {
  analyzerIdentity: SearchAnalyzerIdentity;
  analysis: SearchTextAnalysis;
};

export type AnalyzerPoolTokenization = {
  analyzerIdentity: SearchAnalyzerIdentity;
  tokens: string[][];
};

export type DaemonPools = {
  latencyAnalyzer: AnalyzerWorkerPool;
  throughputAnalyzer: AnalyzerWorkerPool;
  searchExecution: SearchExecutionWorkerPool;
  warmup(): Promise<void>;
  cancel(cancellationId: string): void;
  close(): Promise<void>;
  stats(options: WorkerPoolRunOptions): Promise<unknown>;
};

export type SearchExecutionPreloadOptions = {
  minimumWorkers?: number;
  backgroundRemaining?: boolean;
};

export class AnalyzerWorkerPool {
  private analyzerIdentityValue: SearchAnalyzerIdentity | undefined;
  private readonly pool: DaemonWorkerPool;

  constructor(pool: DaemonWorkerPool) {
    this.pool = pool;
  }

  get analyzerIdentity(): SearchAnalyzerIdentity | undefined {
    return this.analyzerIdentityValue;
  }

  async warmup(minimumReady?: number): Promise<void> {
    const warmed = await this.pool.warmup<{ analyzerIdentity?: SearchAnalyzerIdentity }>(minimumReady);
    const identity = warmed.find((result) => result.analyzerIdentity)?.analyzerIdentity;
    if (identity) this.analyzerIdentityValue = identity;
  }

  async analyzeQuery(
    rawQuery: string,
    options: WorkerPoolRunOptions,
    analysisOptions: SearchTextAnalysisOptions = {}
  ): Promise<AnalyzerPoolAnalysis> {
    const result = await this.pool.run<AnalyzerPoolAnalysis>({
      type: "analyzeQuery",
      payload: { rawQuery, options: analysisOptions }
    }, options);
    this.analyzerIdentityValue = result.analyzerIdentity;
    return result;
  }

  async tokenizeBatch(texts: readonly string[], options: WorkerPoolRunOptions): Promise<AnalyzerPoolTokenization> {
    if (texts.length === 0) {
      const analyzerIdentity = this.requireAnalyzerIdentity();
      return { analyzerIdentity, tokens: [] };
    }
    const chunks = chunk(texts, this.pool.microbatchSize);
    const results = await Promise.all(chunks.map((batch) =>
      this.pool.run<AnalyzerPoolTokenization>({ type: "tokenizeBatch", payload: { texts: batch } }, options)
    ));
    const analyzerIdentity = commonAnalyzerIdentity(
      results.map((result) => result.analyzerIdentity),
      this.analyzerIdentityValue
    );
    const tokens = results.flatMap((result) => result.tokens);
    this.analyzerIdentityValue = analyzerIdentity;
    return { analyzerIdentity, tokens };
  }

  async buildSnapshot(
    vaultRoot: string,
    partitionBits: number | undefined,
    options: WorkerPoolRunOptions,
    searchSettings?: Partial<IndexAffectingSearchSettings>
  ): Promise<BuiltSnapshot> {
    const analyzerIdentity = await this.warmAnalyzerIdentity();
    options.onProgress?.({ phase: "scanning", completed: 0 });
    const scan = scanBuildDocuments(vaultRoot);
    const effectivePartitionBits = partitionBits ?? DEFAULT_PARTITION_BITS;
    const effectiveSearchSettings = normalizeIndexAffectingSearchSettings(searchSettings);
    const parseBatches = chunk(scan.files, this.pool.microbatchSize);
    const documents = sortParsedBuildDocuments(await this.parseBuildDocumentBatches(
      scan.root,
      parseBatches,
      effectivePartitionBits,
      effectiveSearchSettings,
      options
    ));
    const partitionEntries = shuffleParsedBuildDocumentsByPartition(documents);
    const segments = sortBuiltSegmentsByPartitionId(await this.reduceBuildSegments(partitionEntries, options));
    const built = buildCanonicalSearchSnapshotFromSegments({
      analyzerIdentity,
      partitionBits: effectivePartitionBits,
      searchSettings: effectiveSearchSettings,
      documents,
      segments
    });
    this.analyzerIdentityValue = built.diagnostics.analyzer;
    return built;
  }

  private async warmAnalyzerIdentity(): Promise<SearchAnalyzerIdentity> {
    const warmed = await this.pool.warmup<{ analyzerIdentity?: SearchAnalyzerIdentity }>(1);
    const analyzerIdentity = warmed.find((result) => result.analyzerIdentity)?.analyzerIdentity ?? this.analyzerIdentityValue;
    if (!analyzerIdentity) {
      throw Object.assign(new Error("analyzer pool is not warmed"), { code: "SEARCH_DAEMON_NOT_READY" });
    }
    this.analyzerIdentityValue = analyzerIdentity;
    return analyzerIdentity;
  }

  private async parseBuildDocumentBatches(
    vaultRoot: string,
    batches: readonly (readonly string[])[],
    partitionBits: number,
    searchSettings: IndexAffectingSearchSettings,
    options: WorkerPoolRunOptions
  ): Promise<ParsedBuildDocument[]> {
    options.onProgress?.({ phase: "parsing", total: totalItems(batches), completed: 0 });
    let completed = 0;
    let indexed = 0;
    const interval = progressInterval(totalItems(batches));
    const workerOptions = withoutProgress(options);
    const results = await Promise.all(batches.map(async (batch) => {
      const result = await this.pool.run<ParseBuildDocumentsWorkerResult>({
        type: "parseBuildDocuments",
        payload: {
          vaultRoot,
          relPaths: batch,
          partitionBits,
          searchSettings
        }
      }, workerOptions);
      const nextCompleted = completed + batch.length;
      const nextIndexed = indexed + result.documents.length;
      completed = nextCompleted;
      indexed = nextIndexed;
      if (completed === totalItems(batches) || completed % interval === 0) {
        options.onProgress?.({
          phase: "parsing",
          total: totalItems(batches),
          completed,
          current: batch[batch.length - 1],
          message: `${indexed} indexed`
        });
      }
      this.analyzerIdentityValue = commonAnalyzerIdentity([result.analyzerIdentity], this.analyzerIdentityValue);
      return result.documents;
    }));
    return results.flat();
  }

  private async reduceBuildSegments(
    partitionEntries: readonly (readonly [partitionId: number, documents: readonly ParsedBuildDocument[]])[],
    options: WorkerPoolRunOptions
  ): Promise<BuiltSegment[]> {
    options.onProgress?.({ phase: "segmenting", total: partitionEntries.length, completed: 0 });
    let completed = 0;
    const workerOptions = withoutProgress(options);
    const segments = await Promise.all(partitionEntries.map(async ([partitionId, documents]) => {
      const segment = await this.pool.run<ReduceBuildSegmentWorkerResult>({
        type: "reduceBuildSegment",
        payload: { partitionId, documents }
      }, workerOptions);
      completed += 1;
      options.onProgress?.({
        phase: "segmenting",
        total: partitionEntries.length,
        completed,
        current: String(partitionId)
      });
      return segment;
    }));
    return segments;
  }

  cancel(cancellationId: string): void {
    this.pool.cancel(cancellationId);
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  stats() {
    return this.pool.stats();
  }

  private requireAnalyzerIdentity(): SearchAnalyzerIdentity {
    if (!this.analyzerIdentityValue) {
      throw Object.assign(new Error("analyzer pool is not warmed"), { code: "SEARCH_DAEMON_NOT_READY" });
    }
    return this.analyzerIdentityValue;
  }
}

export class SearchExecutionWorkerPool {
  private readonly pool: DaemonWorkerPool;
  private readonly env: NodeJS.ProcessEnv;

  constructor(pool: DaemonWorkerPool, env: NodeJS.ProcessEnv = process.env) {
    this.pool = pool;
    this.env = env;
  }

  search(job: SearchExecutionJob, options: WorkerPoolRunOptions): Promise<SearchExecutionResult> {
    return this.pool.run<SearchExecutionResult>({ type: "search", payload: job }, options);
  }

  async dispatchSearchShards(
    jobs: readonly SearchShardExecutionJob[],
    options: WorkerPoolRunOptions
  ): Promise<Array<{ job: SearchShardExecutionJob; slotId: number; promise: Promise<SearchShardExecutionResult> }>> {
    if (jobs.length === 0) return [];
    await this.pool.warmup(Math.min(jobs.length, this.pool.slotIds().length));
    const readySlotIds = this.orderedFanoutSlotIds(this.pool.readySlotIds());
    if (readySlotIds.length === 0) {
      throw Object.assign(new Error("search execution pool has no ready workers"), { code: "SEARCH_DAEMON_NOT_READY" });
    }
    return jobs.map((job, index) => {
      const slotId = readySlotIds[index % readySlotIds.length];
      return {
        job,
        slotId,
        promise: this.pool.runOnSlot<SearchShardExecutionResult>({ type: "searchShard", payload: job }, options, slotId)
      };
    });
  }

  async preloadSnapshot(
    snapshot: SearchExecutionSnapshotHandle,
    options: WorkerPoolRunOptions,
    preloadOptions: SearchExecutionPreloadOptions = {}
  ): Promise<SearchExecutionPreloadResult[]> {
    const allSlotIds = this.pool.slotIds();
    const minimumWorkers = Math.max(
      1,
      Math.min(allSlotIds.length, Math.floor(preloadOptions.minimumWorkers ?? allSlotIds.length))
    );
    await this.pool.warmup(minimumWorkers);
    const blockingSlotIds = this.pool.readySlotIds().slice(0, minimumWorkers);
    const warmed = await this.pool.runOnSlots<SearchExecutionPreloadResult>(
      { type: "preloadSnapshot", payload: snapshot },
      options,
      blockingSlotIds
    );
    if (preloadOptions.backgroundRemaining) {
      const blocking = new Set(blockingSlotIds);
      const backgroundSlotIds = this.pool.slotIds().filter((slotId) => !blocking.has(slotId));
      if (backgroundSlotIds.length > 0) {
        void this.pool.runOnSlots<SearchExecutionPreloadResult>(
          { type: "preloadSnapshot", payload: snapshot },
          options,
          backgroundSlotIds
        ).catch(() => undefined);
      }
    }
    return warmed;
  }

  cacheStats(options: WorkerPoolRunOptions): Promise<SearchExecutionCacheStats[]> {
    const readySlotIds = this.pool.readySlotIds();
    if (readySlotIds.length === 0) return Promise.resolve([]);
    return this.pool.runOnSlots<SearchExecutionCacheStats>({ type: "searchExecutionStats" }, options, readySlotIds);
  }

  async warmup(minimumReady?: number): Promise<void> {
    await this.pool.warmup(minimumReady);
  }

  cancel(cancellationId: string): void {
    this.pool.cancel(cancellationId);
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  stats() {
    return this.pool.stats();
  }

  private orderedFanoutSlotIds(slotIds: readonly number[]): number[] {
    const ordered = [...slotIds].sort((left, right) => left - right);
    const assignment = this.env.OPTSIDIAN_SEARCH_FANOUT_ASSIGNMENT?.trim().toLowerCase();
    if (!assignment || assignment === "identity") return ordered;
    if (assignment === "reverse") return ordered.reverse();
    const rotate = /^rotate:(\d+)$/u.exec(assignment);
    if (rotate) {
      const offset = Number(rotate[1]) % Math.max(ordered.length, 1);
      return [...ordered.slice(offset), ...ordered.slice(0, offset)];
    }
    return ordered;
  }
}

export async function createDaemonPools(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env)
): Promise<DaemonPools> {
  const logicalBudget = logicalCpuWorkerBudget();
  const singleWorkers = optionalWorkerCountFromEnv(env, "OPTSIDIAN_SEARCH_WORKERS");
  const queryWorkers = optionalWorkerCountFromEnv(env, "OPTSIDIAN_SEARCH_QUERY_WORKERS") ?? (singleWorkers ? 1 : settings.search?.queryWorkers ?? 1);
  const indexWorkers = optionalWorkerCountFromEnv(env, "OPTSIDIAN_SEARCH_INDEX_WORKERS") ?? (singleWorkers ? 1 : settings.search?.indexWorkers ?? 1);
  const searchWorkers = optionalWorkerCountFromEnv(env, "OPTSIDIAN_SEARCH_EXECUTION_WORKERS") ?? singleWorkers ?? Math.max(2, Math.min(4, logicalBudget - queryWorkers - indexWorkers));
  const latencyAnalyzer = new AnalyzerWorkerPool(new DaemonWorkerPool({
    name: "latency-analyzer",
    kind: "analyzer",
    size: queryWorkers,
    env,
    microbatchSize: workerCountFromEnv(env, "OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH", 16),
    autoWarmup: false
  }));
  const throughputAnalyzer = new AnalyzerWorkerPool(new DaemonWorkerPool({
    name: "throughput-analyzer",
    kind: "analyzer",
    size: indexWorkers,
    env,
    microbatchSize: workerCountFromEnv(env, "OPTSIDIAN_SEARCH_INDEX_MICROBATCH", 128),
    autoWarmup: false
  }));
  const searchExecution = new SearchExecutionWorkerPool(new DaemonWorkerPool({
    name: "search-execution",
    kind: "search",
    size: searchWorkers,
    env,
    microbatchSize: 1
  }), env);
  const pools: DaemonPools = {
    latencyAnalyzer,
    throughputAnalyzer,
    searchExecution,
    async warmup() {
      await searchExecution.warmup(1);
    },
    cancel(cancellationId) {
      latencyAnalyzer.cancel(cancellationId);
      throughputAnalyzer.cancel(cancellationId);
      searchExecution.cancel(cancellationId);
    },
    async close() {
      await Promise.all([
        latencyAnalyzer.close(),
        throughputAnalyzer.close(),
        searchExecution.close()
      ]);
    },
    async stats(options) {
      let searchExecutionCache: unknown;
      try {
        searchExecutionCache = await searchExecution.cacheStats(options);
      } catch (error) {
        searchExecutionCache = {
          error: error instanceof Error ? error.message : String(error)
        };
      }
      return {
        latencyAnalyzer: latencyAnalyzer.stats(),
        throughputAnalyzer: throughputAnalyzer.stats(),
        searchExecution: {
          ...searchExecution.stats(),
          cache: searchExecutionCache
        }
      };
    }
  };
  await pools.warmup();
  return pools;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push([...values.slice(index, index + size)]);
  }
  return output;
}

function commonAnalyzerIdentity(
  identities: readonly SearchAnalyzerIdentity[],
  fallback?: SearchAnalyzerIdentity
): SearchAnalyzerIdentity {
  const checked = fallback ? [fallback, ...identities] : [...identities];
  const first = checked[0];
  if (!first) throw Object.assign(new Error("analyzer pool is not warmed"), { code: "SEARCH_DAEMON_NOT_READY" });
  const expected = stableJson(first);
  for (const identity of checked) {
    if (stableJson(identity) !== expected) {
      throw Object.assign(new Error("analyzer worker identities diverged during parallel build"), { code: "INTERNAL" });
    }
  }
  return first;
}

function sortBuiltSegmentsByPartitionId(segments: readonly BuiltSegment[]): BuiltSegment[] {
  const sorted = [...segments].sort((left, right) => left.partitionId - right.partitionId);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].partitionId === sorted[index].partitionId) {
      throw Object.assign(new Error(`duplicate partition ${sorted[index].partitionId} in parallel build reduce`), { code: "INTERNAL" });
    }
  }
  return sorted;
}

function withoutProgress(options: WorkerPoolRunOptions): WorkerPoolRunOptions {
  const { onProgress: _onProgress, ...rest } = options;
  return rest;
}

function totalItems<T>(batches: readonly (readonly T[])[]): number {
  return batches.reduce((sum, batch) => sum + batch.length, 0);
}

function progressInterval(total: number): number {
  if (total <= 200) return 1;
  return Math.max(1, Math.floor(total / 100));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
