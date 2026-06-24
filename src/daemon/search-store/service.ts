import fs from "node:fs";
import { UsageError } from "../../errors.js";
import { normalizeSearchParams } from "../../core/search/params.js";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import { SEARCH_TOKEN_CHANNELS, type SearchTextAnalysis } from "../../core/search/analysis/index.js";
import type { NormalizedSearchParams, PathFilter } from "../../core/search/internal-types.js";
import type { SearchIndexMutationResult, SearchResult } from "../../core/types.js";
import { resolveVaultPath } from "../../core/path.js";
import type { ExplainRequestPayload, ExplainResult, SearchIndexProgressUpdate, SearchRequestPayload } from "../protocol.js";
import { remainingDeadlineMs } from "../protocol.js";
import { QueryAnalysisCache } from "../query-analysis-cache.js";
import type { AnalyzerWorkerPool, SearchExecutionPreloadOptions, SearchExecutionWorkerPool } from "../pools.js";
import { INDEX_AFFECTING_SEARCH_SETTINGS_HASH } from "./builder.js";
import { DaemonSnapshotStore, type SnapshotMutationResult, type SnapshotRequestContext } from "./snapshot-store.js";

const MAX_SEARCH_QUERY_TERMS_PER_CHANNEL = 2048;

export type LoadVaultOptions = {
  preload?: SearchExecutionPreloadOptions;
};

export type DaemonRequestContext = {
  deadline: number;
  cancellationId: string;
  requestId: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export class DaemonSearchStoreService {
  private readonly queryAnalysisCache: QueryAnalysisCache;
  private readonly store: DaemonSnapshotStore;
  private readonly latencyAnalyzer: AnalyzerWorkerPool;
  private readonly searchExecution: SearchExecutionWorkerPool;

  constructor(
    store: DaemonSnapshotStore,
    latencyAnalyzer: AnalyzerWorkerPool,
    searchExecution: SearchExecutionWorkerPool,
    options: { queryCacheSize?: number } = {}
  ) {
    this.store = store;
    this.latencyAnalyzer = latencyAnalyzer;
    this.searchExecution = searchExecution;
    this.queryAnalysisCache = new QueryAnalysisCache(options.queryCacheSize ?? envNumber(process.env.OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE) ?? 512);
  }

  async loadVault(vault: string, context: DaemonRequestContext, options: LoadVaultOptions = {}) {
    const result = await this.store.loadVault(vault, snapshotContext(context));
    const failed = result.vaults.find((candidate) => candidate.status === "failed");
    if (!failed && "snapshotId" in result && result.snapshotId) {
      await this.preloadSnapshot(vault, result.snapshotId, context, options.preload);
    }
    return result;
  }

  async rebuild(vault: string, context: DaemonRequestContext): Promise<SnapshotMutationResult> {
    const result = await this.store.rebuild(vault, snapshotContext(context));
    if (result.snapshotId) await this.preloadSnapshot(vault, result.snapshotId, context);
    return result;
  }

  async refresh(vault: string, context: DaemonRequestContext) {
    const result = await this.store.refresh(vault, snapshotContext(context));
    if (result.snapshotId) await this.preloadSnapshot(vault, result.snapshotId, context);
    return result;
  }

  async compact(vault: string, context: DaemonRequestContext) {
    const result = await this.store.compact(vault, snapshotContext(context));
    if (result.snapshotId) await this.preloadSnapshot(vault, result.snapshotId, context);
    return result;
  }

  clear(vault: string): Promise<SearchIndexMutationResult> {
    return this.store.clear(vault);
  }

  async search(payload: SearchRequestPayload, context: DaemonRequestContext): Promise<SearchResult & { snapshotId: string }> {
    const result = await this.executeSearch(payload, context, false);
    const { explainTrace: _trace, ...search } = result;
    return search;
  }

  async explain(payload: ExplainRequestPayload, context: DaemonRequestContext): Promise<ExplainResult> {
    const result = await this.executeSearch({ ...payload, debug: true }, context, true);
    const { explainTrace, ...search } = result;
    if (!explainTrace) throw Object.assign(new Error("explain requires a query search trace"), { code: "BAD_REQUEST" });
    return {
      ok: true,
      command: "explain",
      snapshotId: search.snapshotId,
      search,
      trace: explainTrace
    };
  }

  private async executeSearch(payload: SearchRequestPayload, context: DaemonRequestContext, explain: boolean) {
    const search = normalizeSearchParams(payload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const pin = await this.store.pin(payload.vault, payload.snapshotId, snapshotContext(context));
    try {
      const analysisResult = search.query
        ? await this.queryAnalysis(search.query, search, payload.vault, context)
        : undefined;
      const snapshot = this.store.snapshotHandleForPin(pin);
      return await this.searchExecution.search({
        vault: payload.vault,
        search,
        pathFilter,
        analysis: analysisResult?.analysis,
        analyzerIdentity: analysisResult?.analyzerIdentity ?? this.requireAnalyzerIdentity(),
        snapshot,
        explain
      }, {
        deadline: context.deadline,
        cancellationId: context.cancellationId,
        vault: payload.vault
      });
    } finally {
      this.store.release(pin);
    }
  }

  stats() {
    return {
      queryAnalysisCache: this.queryAnalysisCache.stats()
    };
  }

  private async preloadSnapshot(
    vault: string,
    snapshotId: string,
    context: DaemonRequestContext,
    options: SearchExecutionPreloadOptions = {}
  ): Promise<void> {
    assertRemainingDeadline(context.deadline);
    const pin = await this.store.pin(vault, snapshotId, snapshotContext(context));
    try {
      const snapshot = this.store.snapshotHandleForPin(pin);
      context.progress?.({
        phase: "preloading",
        completed: 0,
        message: "warming search workers"
      });
      const warmed = await this.searchExecution.preloadSnapshot(
        snapshot,
        {
          deadline: context.deadline,
          cancellationId: context.cancellationId,
          vault
        },
        options
      );
      context.progress?.({
        phase: "preloading",
        total: warmed.length,
        completed: warmed.length,
        message: "search workers warm"
      });
    } finally {
      this.store.release(pin);
    }
  }

  private async queryAnalysis(
    rawQuery: string,
    search: NormalizedSearchParams,
    vault: string,
    context: DaemonRequestContext
  ): Promise<{ analysis: SearchTextAnalysis; analyzerIdentity: SearchAnalyzerIdentity }> {
    const analyzerIdentity = this.requireAnalyzerIdentity();
    const cached = this.queryAnalysisCache.get({
      analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: INDEX_AFFECTING_SEARCH_SETTINGS_HASH
    });
    if (cached) {
      assertQueryAnalysisTermCount(cached);
      return { analysis: cached, analyzerIdentity };
    }

    assertRemainingDeadline(context.deadline);
    const result = await this.latencyAnalyzer.analyzeQuery(rawQuery, {
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      vault
    });
    assertQueryAnalysisTermCount(result.analysis);
    this.queryAnalysisCache.set({
      analyzerIdentity: result.analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: INDEX_AFFECTING_SEARCH_SETTINGS_HASH
    }, result.analysis);
    return result;
  }

  private requireAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.latencyAnalyzer.analyzerIdentity ?? this.store.searchAnalyzerIdentity();
  }
}

function assertQueryAnalysisTermCount(analysis: SearchTextAnalysis): void {
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const count = analysis.channels[channel].length;
    if (count > MAX_SEARCH_QUERY_TERMS_PER_CHANNEL) {
      throw new UsageError(
        `query expands to too many ${channel} terms (${count}; max ${MAX_SEARCH_QUERY_TERMS_PER_CHANNEL})`
      );
    }
  }
}

function snapshotContext(context: DaemonRequestContext): SnapshotRequestContext {
  return {
    deadline: context.deadline,
    cancellationId: context.cancellationId,
    progress: context.progress
  };
}

function assertRemainingDeadline(deadline: number): void {
  if (remainingDeadlineMs(deadline) <= 0) {
    throw Object.assign(new Error("request deadline expired before query analysis"), { code: "DEADLINE_EXCEEDED" });
  }
}

function resolvePathFilter(vaultRoot: string, input: string): PathFilter {
  const resolved = resolveVaultPath(vaultRoot, input, { mustExist: true });
  const stat = fs.statSync(resolved.abs);
  return { rel: resolved.rel === "." ? "" : resolved.rel, directory: stat.isDirectory() };
}

function envNumber(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}
