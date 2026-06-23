import type { SearchTextAnalysis } from "../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import type { BuiltSnapshot } from "./search-store/types.js";
import { DaemonWorkerPool, logicalCpuWorkerBudget, workerCountFromEnv, type WorkerPoolRunOptions } from "./worker-pool.js";
import type { SearchExecutionJob, SearchExecutionResult } from "./search-execution.js";
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
  stats(): unknown;
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

  async warmup(): Promise<void> {
    const warmed = await this.pool.warmup<{ analyzerIdentity?: SearchAnalyzerIdentity }>();
    const identity = warmed.find((result) => result.analyzerIdentity)?.analyzerIdentity;
    if (identity) this.analyzerIdentityValue = identity;
  }

  async analyzeQuery(rawQuery: string, options: WorkerPoolRunOptions): Promise<AnalyzerPoolAnalysis> {
    const result = await this.pool.run<AnalyzerPoolAnalysis>({ type: "analyzeQuery", payload: { rawQuery } }, options);
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

  async buildSnapshot(vaultRoot: string, partitionBits: number | undefined, options: WorkerPoolRunOptions): Promise<BuiltSnapshot> {
    const built = await this.pool.run<BuiltSnapshot>({ type: "buildSnapshot", payload: { vaultRoot, partitionBits } }, options);
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

  async warmup(): Promise<void> {
    await this.pool.warmup();
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
  const queryWorkers = workerCountFromEnv(env, "OPTSIDIAN_SEARCH_QUERY_WORKERS", settings.search?.queryWorkers ?? 1);
  const indexWorkers = workerCountFromEnv(env, "OPTSIDIAN_SEARCH_INDEX_WORKERS", settings.search?.indexWorkers ?? 1);
  const searchWorkers = workerCountFromEnv(env, "OPTSIDIAN_SEARCH_EXECUTION_WORKERS", Math.max(2, Math.min(4, logicalBudget - queryWorkers - indexWorkers)));
  const latencyAnalyzer = new AnalyzerWorkerPool(new DaemonWorkerPool({
    name: "latency-analyzer",
    kind: "analyzer",
    size: queryWorkers,
    env,
    microbatchSize: workerCountFromEnv(env, "OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH", 16)
  }));
  const throughputAnalyzer = new AnalyzerWorkerPool(new DaemonWorkerPool({
    name: "throughput-analyzer",
    kind: "analyzer",
    size: indexWorkers,
    env,
    microbatchSize: workerCountFromEnv(env, "OPTSIDIAN_SEARCH_INDEX_MICROBATCH", 128)
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
      await Promise.all([
        latencyAnalyzer.warmup(),
        throughputAnalyzer.warmup(),
        searchExecution.warmup()
      ]);
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
    stats() {
      return {
        latencyAnalyzer: latencyAnalyzer.stats(),
        throughputAnalyzer: throughputAnalyzer.stats(),
        searchExecution: searchExecution.stats()
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
