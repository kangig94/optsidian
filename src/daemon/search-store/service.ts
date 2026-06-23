import fs from "node:fs";
import { normalizeSearchParams } from "../../core/search/params.js";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchTextAnalysis } from "../../core/search/analysis/index.js";
import type { NormalizedSearchParams, PathFilter } from "../../core/search/internal-types.js";
import type { SearchIndexMutationResult, SearchResult } from "../../core/types.js";
import { resolveVaultPath } from "../../core/path.js";
import type { ExplainRequestPayload, ExplainResult, SearchRequestPayload } from "../protocol.js";
import { remainingDeadlineMs } from "../protocol.js";
import { QueryAnalysisCache } from "../query-analysis-cache.js";
import type { AnalyzerWorkerPool, SearchExecutionWorkerPool } from "../pools.js";
import { INDEX_AFFECTING_SEARCH_SETTINGS_HASH } from "./builder.js";
import { DaemonSnapshotStore, type SnapshotMutationResult, type SnapshotRequestContext } from "./snapshot-store.js";

export type DaemonRequestContext = {
  deadline: number;
  cancellationId: string;
  requestId: string;
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

  loadVault(vault: string, context: DaemonRequestContext) {
    return this.store.loadVault(vault, snapshotContext(context));
  }

  rebuild(vault: string, context: DaemonRequestContext): Promise<SnapshotMutationResult> {
    return this.store.rebuild(vault, snapshotContext(context));
  }

  refresh(vault: string, context: DaemonRequestContext) {
    return this.store.refresh(vault, snapshotContext(context));
  }

  compact(vault: string, context: DaemonRequestContext) {
    return this.store.compact(vault, snapshotContext(context));
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
    if (cached) return { analysis: cached, analyzerIdentity };

    assertRemainingDeadline(context.deadline);
    const result = await this.latencyAnalyzer.analyzeQuery(rawQuery, {
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      vault
    });
    this.queryAnalysisCache.set({
      analyzerIdentity: result.analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: INDEX_AFFECTING_SEARCH_SETTINGS_HASH
    }, result.analysis);
    return result;
  }

  private requireAnalyzerIdentity(): SearchAnalyzerIdentity {
    const identity = this.latencyAnalyzer.analyzerIdentity;
    if (!identity) throw Object.assign(new Error("latency analyzer pool is not ready"), { code: "SEARCH_DAEMON_NOT_READY" });
    return identity;
  }
}

function snapshotContext(context: DaemonRequestContext): SnapshotRequestContext {
  return {
    deadline: context.deadline,
    cancellationId: context.cancellationId
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
