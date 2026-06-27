import type { SearchTextAnalysis, SearchTextAnalysisOptions } from "../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import type { IndexAffectingSearchSettings } from "../core/search/index-settings.js";
import type { BuiltSnapshot } from "./search-store/types.js";
import { DaemonWorkerPool, logicalCpuWorkerBudget, optionalWorkerCountFromEnv, workerCountFromEnv, type WorkerPoolRunOptions } from "./worker-pool.js";
import type {
  SearchExecutionCacheStats,
  SearchExecutionJob,
  SearchExecutionPreloadResult,
  SearchExecutionResult,
  SearchExecutionSnapshotHandle
} from "./search-execution.js";
import type { SearchResult } from "../core/types.js";
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
    const tokens: string[][] = [];
    let analyzerIdentity = this.analyzerIdentityValue;
    for (const batch of chunks) {
      const result = await this.pool.run<AnalyzerPoolTokenization>({ type: "tokenizeBatch", payload: { texts: batch } }, options);
      analyzerIdentity = result.analyzerIdentity;
      tokens.push(...result.tokens);
    }
    this.analyzerIdentityValue = analyzerIdentity;
    return { analyzerIdentity: this.requireAnalyzerIdentity(), tokens };
  }

  async buildSnapshot(
    vaultRoot: string,
    partitionBits: number | undefined,
    options: WorkerPoolRunOptions,
    searchSettings?: Partial<IndexAffectingSearchSettings>
  ): Promise<BuiltSnapshot> {
    const built = await this.pool.run<BuiltSnapshot>({
      type: "buildSnapshot",
      payload: { vaultRoot, partitionBits, searchSettings }
    }, options);
    this.analyzerIdentityValue = built.diagnostics.analyzer;
    return built;
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

  constructor(pool: DaemonWorkerPool) {
    this.pool = pool;
  }

  search(job: SearchExecutionJob, options: WorkerPoolRunOptions): Promise<SearchExecutionResult> {
    return this.pool.run<SearchExecutionResult>({ type: "search", payload: job }, options);
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
  }));
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
