import type { SearchTextAnalysis, SearchTextAnalysisOptions } from '../core/search/analysis/index.js';
import type { SearchAnalyzer, SearchAnalyzerIdentity } from '../core/search/analyzer.js';
import {
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings,
} from '../core/search/index-settings.js';
import {
  DEFAULT_PARTITION_BITS,
  buildCanonicalSearchSnapshot,
  buildCanonicalSearchSnapshotFromSegments,
  documentProjectionsFromParses,
  scanBuildDocuments,
  shuffleParsedBuildDocumentsByPartition,
  sortParsedBuildDocuments,
  type BuildSnapshotBase,
  type ReduceBuildSegmentInput,
} from './search-store/builder.js';
import type { BuiltSegment, BuiltSnapshot, ParsedBuildDocument } from './search-store/types.js';
import {
  DaemonWorkerPool,
  defaultSearchExecutionWorkerCount,
  optionalWorkerCountFromEnv,
  workerCountFromEnv,
  type WorkerPoolRunOptions,
} from './worker-pool.js';
import type {
  SearchExecutionCacheStats,
  SearchExecutionJob,
  SearchExecutionPreloadResult,
  SearchExecutionResult,
  SearchExecutionSnapshotHandle,
  SearchShardExecutionJob,
  SearchShardExecutionResult,
} from './search-execution.js';
import type {
  ModelEncodeWorkerPayload,
  ModelEncodeWorkerResult,
  ModelStatsWorkerResult,
  ModelUnloadWorkerResult,
  ParseBuildDocumentsWorkerResult,
  ReduceBuildSegmentWorkerResult,
  SearchIndexProgressUpdate,
  VectorBuildWorkerPayload,
  VectorCloseWorkerPayload,
  VectorPrewarmWorkerPayload,
  VectorUpsertWorkerPayload,
  VectorWorkerResult,
} from './protocol.js';
import { readOptsidianSettings, type OptsidianSettings } from '../core/settings.js';

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
  embedding: EmbeddingWorkerPool;
  vector: VectorWorkerPool;
  warmup(): Promise<void>;
  cancel(cancellationId: string): void;
  close(): Promise<void>;
  stats(options: WorkerPoolRunOptions): Promise<unknown>;
};

export type DaemonPoolsOptions = {
  embedding?: EmbeddingWorkerPool;
  closeSharedEmbedding?: boolean;
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
    analysisOptions: SearchTextAnalysisOptions = {},
  ): Promise<AnalyzerPoolAnalysis> {
    const result = await this.pool.run<AnalyzerPoolAnalysis>(
      {
        type: 'analyzeQuery',
        payload: { rawQuery, options: analysisOptions },
      },
      options,
    );
    this.analyzerIdentityValue = result.analyzerIdentity;
    return result;
  }

  async tokenizeBatch(texts: readonly string[], options: WorkerPoolRunOptions): Promise<AnalyzerPoolTokenization> {
    if (texts.length === 0) {
      const analyzerIdentity = this.requireAnalyzerIdentity();
      return { analyzerIdentity, tokens: [] };
    }
    const chunks = chunk(texts, this.pool.microbatchSize);
    const results = await Promise.all(
      chunks.map((batch) =>
        this.pool.run<AnalyzerPoolTokenization>({ type: 'tokenizeBatch', payload: { texts: batch } }, options),
      ),
    );
    const analyzerIdentity = commonAnalyzerIdentity(
      results.map((result) => result.analyzerIdentity),
      this.analyzerIdentityValue,
    );
    const tokens = results.flatMap((result) => result.tokens);
    this.analyzerIdentityValue = analyzerIdentity;
    return { analyzerIdentity, tokens };
  }

  async buildSnapshot(
    vaultRoot: string,
    partitionBits: number | undefined,
    options: WorkerPoolRunOptions,
    searchSettings?: Partial<IndexAffectingSearchSettings>,
    base?: BuildSnapshotBase,
  ): Promise<BuiltSnapshot> {
    const analyzerIdentity = await this.warmAnalyzerIdentity();
    if (base) {
      const analyzer = this.buildSnapshotAnalyzer(analyzerIdentity, options);
      const built = await buildCanonicalSearchSnapshot({
        vaultRoot,
        analyzer,
        partitionBits,
        searchSettings,
        base,
        reduceSegments: (inputs, progress) => this.reduceBuildSegmentInputs(inputs, options, progress),
        progress: options.onProgress,
      });
      this.analyzerIdentityValue = built.diagnostics.analyzer;
      return built;
    }
    options.onProgress?.({ phase: 'scanning', completed: 0 });
    const scan = scanBuildDocuments(vaultRoot);
    options.onProgress?.({ phase: 'scanning', total: scan.files.length, completed: scan.files.length });
    const effectivePartitionBits = partitionBits ?? DEFAULT_PARTITION_BITS;
    const effectiveSearchSettings = normalizeIndexAffectingSearchSettings(searchSettings);
    const parseBatches = chunk(scan.files, this.pool.microbatchSize);
    const documents = sortParsedBuildDocuments(
      await this.parseBuildDocumentBatches(
        scan.root,
        parseBatches,
        effectivePartitionBits,
        effectiveSearchSettings,
        options,
      ),
    );
    const partitionEntries = shuffleParsedBuildDocumentsByPartition(documents);
    const segments = sortBuiltSegmentsByPartitionId(await this.reduceBuildSegments(partitionEntries, options));
    const built = buildCanonicalSearchSnapshotFromSegments({
      vaultRoot: scan.root,
      scannedPaths: scan.files,
      analyzerIdentity,
      partitionBits: effectivePartitionBits,
      searchSettings: effectiveSearchSettings,
      documents: documentProjectionsFromParses(documents, scan.documents),
      segments,
    });
    this.analyzerIdentityValue = built.diagnostics.analyzer;
    return built;
  }

  private buildSnapshotAnalyzer(identity: SearchAnalyzerIdentity, options: WorkerPoolRunOptions): SearchAnalyzer {
    return {
      identity,
      tokenize: async (text) => {
        const result = await this.tokenizeBatch([text], options);
        return result.tokens[0] ?? [];
      },
      tokenizeBatch: async (texts) => {
        const result = await this.tokenizeBatch(texts, options);
        return result.tokens;
      },
    };
  }

  private async warmAnalyzerIdentity(): Promise<SearchAnalyzerIdentity> {
    const warmed = await this.pool.warmup<{ analyzerIdentity?: SearchAnalyzerIdentity }>(1);
    const analyzerIdentity =
      warmed.find((result) => result.analyzerIdentity)?.analyzerIdentity ?? this.analyzerIdentityValue;
    if (!analyzerIdentity) {
      throw Object.assign(new Error('analyzer pool is not warmed'), { code: 'SEARCH_DAEMON_NOT_READY' });
    }
    this.analyzerIdentityValue = analyzerIdentity;
    return analyzerIdentity;
  }

  private async parseBuildDocumentBatches(
    vaultRoot: string,
    batches: readonly (readonly string[])[],
    partitionBits: number,
    searchSettings: IndexAffectingSearchSettings,
    options: WorkerPoolRunOptions,
  ): Promise<ParsedBuildDocument[]> {
    options.onProgress?.({ phase: 'parsing', total: totalItems(batches), completed: 0 });
    let completed = 0;
    let indexed = 0;
    const interval = progressInterval(totalItems(batches));
    const workerOptions = withoutProgress(options);
    const results = await Promise.all(
      batches.map(async (batch) => {
        const result = await this.pool.run<ParseBuildDocumentsWorkerResult>(
          {
            type: 'parseBuildDocuments',
            payload: {
              vaultRoot,
              relPaths: batch,
              partitionBits,
              searchSettings,
            },
          },
          workerOptions,
        );
        const nextCompleted = completed + batch.length;
        const nextIndexed = indexed + result.documents.length;
        completed = nextCompleted;
        indexed = nextIndexed;
        if (completed === totalItems(batches) || completed % interval === 0) {
          options.onProgress?.({
            phase: 'parsing',
            total: totalItems(batches),
            completed,
            current: batch[batch.length - 1],
            message: `${indexed} indexed`,
          });
        }
        this.analyzerIdentityValue = commonAnalyzerIdentity([result.analyzerIdentity], this.analyzerIdentityValue);
        return result.documents;
      }),
    );
    return results.flat();
  }

  private async reduceBuildSegments(
    partitionEntries: readonly (readonly [partitionId: number, documents: readonly ParsedBuildDocument[]])[],
    options: WorkerPoolRunOptions,
  ): Promise<BuiltSegment[]> {
    options.onProgress?.({ phase: 'segmenting', total: partitionEntries.length, completed: 0 });
    let completed = 0;
    const workerOptions = withoutProgress(options);
    const segments = await Promise.all(
      partitionEntries.map(async ([partitionId, documents]) => {
        const segment = await this.pool.run<ReduceBuildSegmentWorkerResult>(
          {
            type: 'reduceBuildSegment',
            payload: { mode: 'full', partitionId, documents },
          },
          workerOptions,
        );
        completed += 1;
        options.onProgress?.({
          phase: 'segmenting',
          total: partitionEntries.length,
          completed,
          current: String(partitionId),
        });
        return segment;
      }),
    );
    return segments;
  }

  private async reduceBuildSegmentInputs(
    inputs: readonly ReduceBuildSegmentInput[],
    options: WorkerPoolRunOptions,
    progress?: (progress: SearchIndexProgressUpdate) => void,
  ): Promise<BuiltSegment[]> {
    progress?.({ phase: 'segmenting', total: inputs.length, completed: 0 });
    let completed = 0;
    const workerOptions = withoutProgress(options);
    const segments = await Promise.all(
      inputs.map(async (input) => {
        const segment = await this.pool.run<ReduceBuildSegmentWorkerResult>(
          {
            type: 'reduceBuildSegment',
            payload: input,
          },
          workerOptions,
        );
        completed += 1;
        progress?.({
          phase: 'segmenting',
          total: inputs.length,
          completed,
          current: String(input.partitionId),
        });
        return segment;
      }),
    );
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
      throw Object.assign(new Error('analyzer pool is not warmed'), { code: 'SEARCH_DAEMON_NOT_READY' });
    }
    return this.analyzerIdentityValue;
  }
}

export class SearchExecutionWorkerPool {
  private readonly pool: DaemonWorkerPool;

  constructor(pool: DaemonWorkerPool) {
    this.pool = pool;
  }

  search(job: SearchExecutionJob, options: WorkerPoolRunOptions): Promise<SearchExecutionResult> {
    return this.pool.run<SearchExecutionResult>({ type: 'search', payload: job }, options);
  }

  idleReadySlotIds(): number[] {
    return this.pool.idleReadySlotIds();
  }

  leaseIdleSlot(): number | undefined {
    return this.pool.leaseIdleSlot();
  }

  releaseIdleSlot(slotId: number): boolean {
    return this.pool.releaseIdleSlot(slotId);
  }

  runOnSlot(
    job: SearchShardExecutionJob,
    options: WorkerPoolRunOptions,
    slotId: number,
  ): Promise<SearchShardExecutionResult> {
    return this.pool.runOnSlot<SearchShardExecutionResult>({ type: 'searchShard', payload: job }, options, slotId);
  }

  async preloadSnapshot(
    snapshot: SearchExecutionSnapshotHandle,
    options: WorkerPoolRunOptions,
    preloadOptions: SearchExecutionPreloadOptions = {},
  ): Promise<SearchExecutionPreloadResult[]> {
    const allSlotIds = this.pool.slotIds();
    const minimumWorkers = Math.max(
      1,
      Math.min(allSlotIds.length, Math.floor(preloadOptions.minimumWorkers ?? allSlotIds.length)),
    );
    await this.pool.warmup(minimumWorkers);
    const blockingSlotIds = this.pool.readySlotIds().slice(0, minimumWorkers);
    const warmed = await this.pool.runOnSlots<SearchExecutionPreloadResult>(
      { type: 'preloadSnapshot', payload: snapshot },
      options,
      blockingSlotIds,
    );
    if (preloadOptions.backgroundRemaining) {
      const blocking = new Set(blockingSlotIds);
      const backgroundSlotIds = this.pool.slotIds().filter((slotId) => !blocking.has(slotId));
      if (backgroundSlotIds.length > 0) {
        void this.pool
          .runOnSlots<SearchExecutionPreloadResult>(
            { type: 'preloadSnapshot', payload: snapshot },
            options,
            backgroundSlotIds,
          )
          .catch(() => undefined);
      }
    }
    return warmed;
  }

  cacheStats(options: WorkerPoolRunOptions): Promise<SearchExecutionCacheStats[]> {
    const readySlotIds = this.pool.readySlotIds();
    if (readySlotIds.length === 0) return Promise.resolve([]);
    return this.pool.runOnSlots<SearchExecutionCacheStats>({ type: 'searchExecutionStats' }, options, readySlotIds);
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
}

export class EmbeddingWorkerPool {
  private readonly pool: DaemonWorkerPool;

  constructor(pool: DaemonWorkerPool) {
    this.pool = pool;
  }

  encode(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): Promise<ModelEncodeWorkerResult> {
    return this.pool.run<ModelEncodeWorkerResult>({ type: 'modelEncode', payload }, options);
  }

  unload(options: WorkerPoolRunOptions): Promise<ModelUnloadWorkerResult> {
    return this.pool.run<ModelUnloadWorkerResult>({ type: 'modelUnload' }, options);
  }

  modelStats(options: WorkerPoolRunOptions): Promise<ModelStatsWorkerResult> {
    return this.pool.run<ModelStatsWorkerResult>({ type: 'modelStats' }, options);
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
}

export class VectorWorkerPool {
  private readonly pool: DaemonWorkerPool;

  constructor(pool: DaemonWorkerPool) {
    this.pool = pool;
  }

  upsert(payload: VectorUpsertWorkerPayload, options: WorkerPoolRunOptions): Promise<VectorWorkerResult> {
    return this.pool.run<VectorWorkerResult>({ type: 'vectorUpsert', payload }, options);
  }

  build(payload: VectorBuildWorkerPayload, options: WorkerPoolRunOptions): Promise<VectorWorkerResult> {
    return this.pool.run<VectorWorkerResult>({ type: 'vectorBuild', payload }, options);
  }

  prewarm(payload: VectorPrewarmWorkerPayload, options: WorkerPoolRunOptions): Promise<VectorWorkerResult> {
    return this.pool.run<VectorWorkerResult>({ type: 'vectorPrewarm', payload }, options);
  }

  closeInstance(payload: VectorCloseWorkerPayload, options: WorkerPoolRunOptions): Promise<VectorWorkerResult> {
    return this.pool.run<VectorWorkerResult>({ type: 'vectorClose', payload }, options);
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
}

export async function createDaemonPools(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env),
  options: DaemonPoolsOptions = {},
): Promise<DaemonPools> {
  const singleWorkers = optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_WORKERS');
  const queryWorkers =
    optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_QUERY_WORKERS') ??
    (singleWorkers ? 1 : (settings.search?.queryWorkers ?? 1));
  const indexWorkers =
    optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_INDEX_WORKERS') ??
    (singleWorkers ? 1 : (settings.search?.indexWorkers ?? 1));
  const searchWorkers =
    optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_EXECUTION_WORKERS') ??
    singleWorkers ??
    settings.search?.executionWorkers ??
    defaultSearchExecutionWorkerCount();
  const vectorWorkers = optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_VECTOR_WORKERS') ?? 1;
  const latencyAnalyzer = new AnalyzerWorkerPool(
    new DaemonWorkerPool({
      name: 'latency-analyzer',
      kind: 'analyzer',
      size: queryWorkers,
      env,
      microbatchSize: workerCountFromEnv(env, 'OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH', 16),
      autoWarmup: false,
    }),
  );
  const throughputAnalyzer = new AnalyzerWorkerPool(
    new DaemonWorkerPool({
      name: 'throughput-analyzer',
      kind: 'analyzer',
      size: indexWorkers,
      env,
      microbatchSize: workerCountFromEnv(env, 'OPTSIDIAN_SEARCH_INDEX_MICROBATCH', 128),
      autoWarmup: false,
    }),
  );
  const searchExecution = new SearchExecutionWorkerPool(
    new DaemonWorkerPool({
      name: 'search-execution',
      kind: 'search',
      size: searchWorkers,
      env,
      microbatchSize: 1,
    }),
  );
  const embedding = options.embedding ?? createEmbeddingWorkerPool(env, settings);
  const vector = new VectorWorkerPool(
    new DaemonWorkerPool({
      name: 'vector-store',
      kind: 'vector',
      size: vectorWorkers,
      env,
      microbatchSize: 1,
      rssGuardBytes:
        envBytesForPool(env, 'OPTSIDIAN_SEARCH_VECTOR_RSS_GUARD_MB') ??
        envBytesForPool(env, 'OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_MB'),
      autoWarmup: false,
    }),
  );
  const pools: DaemonPools = {
    latencyAnalyzer,
    throughputAnalyzer,
    searchExecution,
    embedding,
    vector,
    async warmup() {
      await searchExecution.warmup(1);
    },
    cancel(cancellationId) {
      latencyAnalyzer.cancel(cancellationId);
      throughputAnalyzer.cancel(cancellationId);
      searchExecution.cancel(cancellationId);
      embedding.cancel(cancellationId);
      vector.cancel(cancellationId);
    },
    async close() {
      await Promise.all([
        latencyAnalyzer.close(),
        throughputAnalyzer.close(),
        searchExecution.close(),
        options.embedding && options.closeSharedEmbedding !== true ? Promise.resolve() : embedding.close(),
        vector.close(),
      ]);
    },
    async stats(options) {
      let searchExecutionCache: unknown;
      try {
        searchExecutionCache = await searchExecution.cacheStats(options);
      } catch (error) {
        searchExecutionCache = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        latencyAnalyzer: latencyAnalyzer.stats(),
        throughputAnalyzer: throughputAnalyzer.stats(),
        embedding: embedding.stats(),
        vector: vector.stats(),
        searchExecution: {
          ...searchExecution.stats(),
          cache: searchExecutionCache,
        },
      };
    },
  };
  try {
    await pools.warmup();
  } catch (error) {
    // Warmup failure leaves the worker-thread pools already constructed (their Workers spawn
    // eagerly). Tear them down before propagating, otherwise every retried createDaemonPools leaks
    // another full set of threads that keep the process alive past shutdown.
    await pools.close().catch(() => undefined);
    throw error;
  }
  return pools;
}

export function createEmbeddingWorkerPool(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env),
): EmbeddingWorkerPool {
  const embeddingWorkers = optionalWorkerCountFromEnv(env, 'OPTSIDIAN_SEARCH_EMBEDDING_WORKERS') ?? 1;
  const modelRssGuardBytes =
    envBytesForPool(env, 'OPTSIDIAN_SEARCH_MODEL_RSS_GUARD_MB') ??
    envBytesForPool(env, 'OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_MB');
  void settings;
  return new EmbeddingWorkerPool(
    new DaemonWorkerPool({
      name: 'embedding-model',
      kind: 'embedding',
      size: embeddingWorkers,
      env,
      microbatchSize: 1,
      rssGuardBytes: modelRssGuardBytes,
      rssGuardExempt: true,
      autoWarmup: false,
    }),
  );
}

function envBytesForPool(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw)) * 1024 * 1024;
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
  fallback?: SearchAnalyzerIdentity,
): SearchAnalyzerIdentity {
  const checked = fallback ? [fallback, ...identities] : [...identities];
  const first = checked[0];
  if (!first) throw Object.assign(new Error('analyzer pool is not warmed'), { code: 'SEARCH_DAEMON_NOT_READY' });
  const expected = stableJson(first);
  for (const identity of checked) {
    if (stableJson(identity) !== expected) {
      throw Object.assign(new Error('analyzer worker identities diverged during parallel build'), { code: 'INTERNAL' });
    }
  }
  return first;
}

function sortBuiltSegmentsByPartitionId(segments: readonly BuiltSegment[]): BuiltSegment[] {
  const sorted = [...segments].sort((left, right) => left.partitionId - right.partitionId);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].partitionId === sorted[index].partitionId) {
      throw Object.assign(new Error(`duplicate partition ${sorted[index].partitionId} in parallel build reduce`), {
        code: 'INTERNAL',
      });
    }
  }
  return sorted;
}

function withoutProgress(options: WorkerPoolRunOptions): WorkerPoolRunOptions {
  const { onProgress: _onProgress, ...rest } = options;
  return rest;
}

function totalItems(batches: readonly (readonly unknown[])[]): number {
  return batches.reduce((sum, batch) => sum + batch.length, 0);
}

function progressInterval(total: number): number {
  if (total <= 200) return 1;
  return Math.max(1, Math.floor(total / 100));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
