import fs from "node:fs";
import { UsageError } from "../../errors.js";
import { matchesPathFilter, matchesTagFilter, normalizeSearchParams } from "../../core/search/params.js";
import { DEFAULT_RRF_K, SEARCH_SCORING_LAMBDAS, type SearchScoringLambdas } from "../../core/search/constants.js";
import { createInlineQueryAnalyzer, type SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import { analyzeSearchQuery, emptySearchTokenChannels, SEARCH_TOKEN_CHANNELS, type SearchTextAnalysis } from "../../core/search/analysis/index.js";
import { denseAgreementFromCosine } from "../../core/search/dense/index.js";
import {
  indexAffectingSearchSettingsHash,
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../../core/search/index-settings.js";
import type { NormalizedSearchParams, PathFilter } from "../../core/search/internal-types.js";
import { searchExecutionWarningLabels } from "../../core/search/internal-types.js";
import type { RetrieveResult, SearchIndexMutationResult, SearchMatch, SearchResult } from "../../core/types.js";
import { resolveVaultPath } from "../../core/path.js";
import type { ExplainRequestPayload, ExplainResult, ModelProviderPayload, RetrieveRequestPayload, SearchIndexProgressUpdate, SearchRequestPayload } from "../protocol.js";
import { remainingDeadlineMs } from "../protocol.js";
import { DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES } from "../query-analysis-cache-defaults.js";
import { QueryAnalysisCache } from "../query-analysis-cache.js";
import {
  executeMetadataSearchFromSnapshotHandle,
  warmSearchExecutionSnapshot,
  type SearchExecutionSnapshotHandle
} from "../search-execution.js";
import type { AnalyzerWorkerPool, EmbeddingWorkerPool, SearchExecutionPreloadOptions, SearchExecutionWorkerPool } from "../pools.js";
import { DaemonSnapshotStore, type PinnedRetrievalSnapshot, type SnapshotMutationResult, type SnapshotRequestContext } from "./snapshot-store.js";
import { SearchQueryScheduler } from "./query-scheduler.js";
import { applySearchWarnings } from "./result-shaping.js";
import { readOptsidianSettings, type OptsidianSettings } from "../../core/settings.js";
import type { DenseVectorSearchHit } from "../search-execution.js";
import type { VectorGenerationPool } from "../vector-store/index.js";
import { snippetsForDocument } from "./result-shaping.js";

const MAX_SEARCH_QUERY_TERMS_PER_CHANNEL = 2048;

export type LoadVaultOptions = {
  preload?: SearchExecutionPreloadOptions | false;
  warmupQueryAnalyzer?: boolean;
};

export type DaemonRequestContext = {
  deadline: number;
  cancellationId: string;
  requestId: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type SearchRankingTuning = {
  rrfK: number;
  lambdas: Partial<SearchScoringLambdas>;
};

export class DaemonSearchStoreService {
  private readonly queryAnalysisCache: QueryAnalysisCache;
  private readonly store: DaemonSnapshotStore;
  private readonly latencyAnalyzer: AnalyzerWorkerPool;
  private readonly embedding: EmbeddingWorkerPool;
  private readonly searchExecution: SearchExecutionWorkerPool;
  private readonly vectorPool: Pick<VectorGenerationPool, "searchActiveBuiltIndex"> | undefined;
  private readonly queryScheduler: SearchQueryScheduler;
  private readonly searchSettings: IndexAffectingSearchSettings;
  private readonly searchSettingsHash: string;
  private readonly rankingTuning: SearchRankingTuning;

  constructor(
    store: DaemonSnapshotStore,
    latencyAnalyzer: AnalyzerWorkerPool,
    embedding: EmbeddingWorkerPool,
    searchExecution: SearchExecutionWorkerPool,
    options: {
      queryCacheSize?: number;
      searchSettings?: Partial<IndexAffectingSearchSettings>;
      rankingTuning?: Partial<SearchRankingTuning>;
      settings?: OptsidianSettings;
      vectorPool?: Pick<VectorGenerationPool, "searchActiveBuiltIndex">;
    } = {}
  ) {
    this.store = store;
    this.latencyAnalyzer = latencyAnalyzer;
    this.embedding = embedding;
    this.searchExecution = searchExecution;
    this.vectorPool = options.vectorPool;
    this.queryScheduler = new SearchQueryScheduler(searchExecution);
    this.searchSettings = normalizeIndexAffectingSearchSettings(options.searchSettings);
    this.searchSettingsHash = indexAffectingSearchSettingsHash(this.searchSettings);
    this.rankingTuning = normalizeRankingTuning(options.rankingTuning, options.settings ?? readOptsidianSettings(process.cwd(), process.env), process.env);
    this.queryAnalysisCache = new QueryAnalysisCache(
      options.queryCacheSize ?? envNumber(process.env.OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE) ?? DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES
    );
  }

  private async encodeRetrieveQueryVector(
    queryText: string,
    payload: RetrieveRequestPayload,
    pin: PinnedRetrievalSnapshot,
    context: DaemonRequestContext,
    warnings: string[]
  ): Promise<readonly number[] | undefined> {
    if (remainingDeadlineMs(context.deadline) <= 100) {
      warnings.push("dense query encode skipped because the request deadline was too close");
      return undefined;
    }
    try {
      const encoded = await this.embedding.encode({
        texts: [queryText],
        inputKind: "query",
        provider: modelProviderPayloadForEmbeddingSet(pin.embeddingSet)
      }, {
        deadline: context.deadline,
        cancellationId: context.cancellationId,
        requestId: context.requestId,
        vault: payload.vault
      });
      return encoded.vectors[0];
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "DEADLINE_EXCEEDED") {
        warnings.push("dense query encode skipped because the request deadline expired");
        return undefined;
      }
      throw error;
    }
  }

  async loadVault(vault: string, context: DaemonRequestContext, options: LoadVaultOptions = {}) {
    const queryAnalyzerWarmup = options.warmupQueryAnalyzer
      ? this.latencyAnalyzer.warmup(1)
      : undefined;
    const result = await this.store.loadVault(vault, snapshotContext(context));
    const failed = result.vaults.find((candidate) => candidate.status === "failed");
    if (failed) {
      await queryAnalyzerWarmup?.catch(() => undefined);
      return result;
    }
    const warmups: Array<Promise<unknown>> = [];
    if (!failed && "snapshotId" in result && result.snapshotId && options.preload !== false) {
      warmups.push(this.preloadSnapshot(vault, result.snapshotId, context, options.preload));
    }
    if (queryAnalyzerWarmup) warmups.push(queryAnalyzerWarmup);
    await Promise.all(warmups);
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

  protectedStoreIdsForPrune(): Set<string> {
    return this.store.protectedStoreIdsForPrune();
  }

  cancel(cancellationId: string): void {
    this.queryScheduler.cancel(cancellationId);
  }

  async search(payload: SearchRequestPayload, context: DaemonRequestContext): Promise<SearchResult & { snapshotId: string }> {
    const search = normalizeSearchParams(payload);
    if (search.retrieval !== "lexical") {
      throw Object.assign(new Error("Search method supports retrieval=lexical only; use Retrieve for vector or hybrid retrieval"), { code: "BAD_REQUEST" });
    }
    const result = await this.executeSearch(payload, context, false);
    const { explainTrace: _trace, ...searchResult } = result;
    return searchResult;
  }

  async retrieve(payload: RetrieveRequestPayload, context: DaemonRequestContext): Promise<RetrieveResult> {
    const pinResult = await this.store.ensureActiveRetrievalSnapshot(payload.vault, snapshotContext(context));
    if (pinResult.status !== "ready") {
      return {
        ok: true,
        command: "retrieve",
        schemaVersion: 1,
        available: false,
        status: "index-not-ready",
        origin: payload.origin,
        reason: pinResult.reason,
        matches: [],
        results: []
      };
    }
    const pin = pinResult.pin;
    try {
      assertRetrieveProviderModel(payload, pin);
      const resolved = await this.resolveRetrieveOrigin(payload, pin, context);
      const searchPayload = retrieveSearchPayload(payload, resolved.queryText);
      const search = normalizeSearchParams(searchPayload);
      if (search.retrieval === "vector" && !resolved.queryVector) {
        return {
          ok: true,
          command: "retrieve",
          schemaVersion: 1,
          available: false,
          status: "index-not-ready",
          origin: payload.origin,
          reason: "vector-active-spec-missing",
          matches: [],
          results: [],
          ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {})
        };
      }
      const denseSearch = await this.searchActiveDenseGeneration(searchPayload, pin, resolved.queryVector);
      if (denseSearch.status !== "ready") {
        return {
          ok: true,
          command: "retrieve",
          schemaVersion: 1,
          available: false,
          status: "index-not-ready",
          origin: payload.origin,
          reason: denseSearch.reason,
          matches: [],
          results: []
        };
      }
      if (search.retrieval === "vector") {
        return this.vectorOnlyRetrieveResult(payload, searchPayload, pin, denseSearch.results ?? [], {
          excludeDocumentIds: resolved.excludeDocumentIds,
          warnings: resolved.warnings
        });
      }
      const explain = payload.explain === true;
      const result = await this.executeSearchWithPin({ ...searchPayload, debug: true }, context, explain, pin, {
        queryVector: resolved.queryVector,
        denseSearchResults: denseSearch.results,
        sourceDocumentId: resolved.sourceDocumentId,
        sourcePath: resolved.sourcePath,
        excludeDocumentIds: resolved.excludeDocumentIds,
        warnings: resolved.warnings
      });
      const scoredMatches = filterMatchesByMinScore(result.matches, payload.minScore);
      const matches = payload.debug ? scoredMatches : scoredMatches.map(({ debug: _debug, ...match }) => match);
      return {
        ok: true,
        command: "retrieve",
        schemaVersion: 1,
        available: true,
        status: "ready",
        origin: payload.origin,
        snapshotId: pin.snapshotId,
        retrievalSnapshotId: pin.retrievalSnapshotId,
        matches,
        results: scoredMatches.map((match) => ({
          path: match.path,
          title: match.title,
          score: scoreForMatch(match),
          tags: match.tags,
          snippets: match.snippets,
          ...(payload.debug && match.debug ? { debug: match.debug } : {})
        })),
        ...(payload.debug && result.debug ? { debug: result.debug } : {}),
        ...(explain && result.explainTrace ? { explainTrace: result.explainTrace } : {}),
        ...((resolved.warnings.length > 0 || (result.warnings?.length ?? 0) > 0)
          ? { warnings: [...resolved.warnings, ...(result.warnings ?? [])] }
          : {})
      };
    } finally {
      this.store.release(pin);
    }
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
      trace: explainTrace,
      ...(search.warnings && search.warnings.length > 0 ? { warnings: search.warnings } : {})
    };
  }

  private async executeSearch(payload: SearchRequestPayload, context: DaemonRequestContext, explain: boolean) {
    const search = normalizeSearchParams(payload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const pin = await this.store.pin(payload.vault, payload.snapshotId, snapshotContext(context));
    try {
      return await this.executeSearchWithPin(payload, context, explain, pin);
    } finally {
      this.store.release(pin);
    }
  }

  private async executeSearchWithPin(
    payload: SearchRequestPayload,
    context: DaemonRequestContext,
    explain: boolean,
    pin: Parameters<DaemonSnapshotStore["snapshotHandleForPin"]>[0] | PinnedRetrievalSnapshot,
    retrieval: {
      queryVector?: readonly number[];
      denseSearchResults?: readonly DenseVectorSearchHit[];
      sourceDocumentId?: string;
      sourcePath?: string;
      excludeDocumentIds?: readonly string[];
      warnings?: readonly string[];
    } = {}
  ) {
    const search = normalizeSearchParams(payload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const snapshot = this.store.snapshotHandleForPin(pin);
    const documents = this.documentsForPin(pin);
    if (!search.query && !retrieval.queryVector) {
      return applySearchWarnings(executeMetadataSearchFromSnapshotHandle({
        search,
        pathFilter,
        snapshot,
        analyzerIdentity: this.requireAnalyzerIdentity(),
        documents,
        excludeDocumentIds: retrieval.excludeDocumentIds
      }), [...searchExecutionWarningLabels(search), ...(retrieval.warnings ?? [])]);
    }
    const rawQuery = search.query || retrieval.sourcePath || "";
    const analysisResult = rawQuery
      ? await this.queryAnalysis(rawQuery, search, payload.vault, context)
      : undefined;
    if (!analysisResult) throw Object.assign(new Error("query analysis is required for retrieve search"), { code: "INTERNAL" });
    return await this.queryScheduler.execute({
      vault: payload.vault,
      search: search.query ? search : { ...search, query: rawQuery },
      pathFilter,
      analysis: analysisResult.analysis,
      analyzerIdentity: analysisResult.analyzerIdentity,
      snapshot,
      documents,
      denseEmbeddingSet: "embeddingSet" in pin ? pin.embeddingSet : undefined,
      queryVector: retrieval.queryVector,
      denseSearchResults: retrieval.denseSearchResults,
      sourceDocumentId: retrieval.sourceDocumentId,
      sourcePath: retrieval.sourcePath,
      excludeDocumentIds: retrieval.excludeDocumentIds,
      rrfK: this.rankingTuning.rrfK,
      scoringLambdas: this.rankingTuning.lambdas,
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      requestId: context.requestId,
      explain
    });
  }

  stats() {
    return {
      queryAnalysisCache: this.queryAnalysisCache.stats()
    };
  }

  private documentsForPin(pin: Parameters<DaemonSnapshotStore["documentsForPin"]>[0]) {
    const store = this.store as { documentsForPin?: DaemonSnapshotStore["documentsForPin"] };
    return store.documentsForPin?.(pin);
  }

  private async searchActiveDenseGeneration(
    payload: SearchRequestPayload,
    pin: PinnedRetrievalSnapshot,
    queryVector: readonly number[] | undefined
  ): Promise<
    | { status: "ready"; results?: readonly DenseVectorSearchHit[] }
    | { status: "index-not-ready"; reason: string }
  > {
    if (!queryVector) return { status: "ready" };
    if (!this.vectorPool) return { status: "index-not-ready", reason: "vector-active-spec-missing" };
    const search = normalizeSearchParams(payload);
    const result = await this.vectorPool.searchActiveBuiltIndex({
      key: pin.vectorKey,
      queryVector,
      candidateK: Math.max(search.limit, search.limit * 4),
      expectedGenerationId: pin.vector.generationId
    });
    if (result.status !== "ready") {
      return {
        status: "index-not-ready",
        reason: result.reason === "active-generation-mismatched"
          ? "vector-active-spec-mismatched"
          : "vector-active-spec-missing"
      };
    }
    if (result.generationId !== pin.vector.generationId) {
      return { status: "index-not-ready", reason: "vector-active-spec-mismatched" };
    }
    return {
      status: "ready",
      results: result.results.map((entry) => ({
        chunkId: entry.chunkId,
        entryId: entry.entryId,
        similarity: entry.similarity
      }))
    };
  }

  private vectorOnlyRetrieveResult(
    payload: RetrieveRequestPayload,
    searchPayload: SearchRequestPayload,
    pin: PinnedRetrievalSnapshot,
    denseResults: readonly DenseVectorSearchHit[],
    resolved: {
      excludeDocumentIds?: readonly string[];
      warnings?: readonly string[];
    }
  ): RetrieveResult {
    const search = normalizeSearchParams(searchPayload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const documents = this.documentsForPin(pin);
    const excluded = new Set(resolved.excludeDocumentIds ?? []);
    const matchesWithScore: Array<{ match: SearchMatch; score: number }> = [];
    for (const [index, result] of denseResults.entries()) {
      const document = documents?.get(result.entryId);
      if (!document || excluded.has(document.documentId)) continue;
      const relPath = document.path;
      if (pathFilter && !matchesPathFilter(relPath, pathFilter)) continue;
      const tags = document.tags;
      if (!matchesTagFilter(tags, search.tags)) continue;
      const score = denseAgreementFromCosine(result.similarity);
      matchesWithScore.push({
        score,
        match: {
          path: relPath,
          title: document.title ?? titleFromPath(relPath),
          tags,
          snippets: snippetsForDocument(document, emptySearchTokenChannels()),
          ...(search.debug
            ? {
                debug: {
                  source: "persisted" as const,
                  queryTerms: [],
                  analyzer: this.requireAnalyzerIdentity(),
                  retrievalScore: score,
                  denseAgreement: score,
                  baseRank: index + 1,
                  snapshotId: pin.snapshotId
                }
              }
            : {})
        }
      });
      if (matchesWithScore.length >= search.limit) break;
    }
    const matches = matchesWithScore.map((entry) => entry.match);
    return {
      ok: true,
      command: "retrieve",
      schemaVersion: 1,
      available: true,
      status: "ready",
      origin: payload.origin,
      snapshotId: pin.snapshotId,
      retrievalSnapshotId: pin.retrievalSnapshotId,
      matches,
      results: matchesWithScore.map(({ match, score }) => ({
        path: match.path,
        title: match.title,
        score,
        tags: match.tags,
        snippets: match.snippets,
        ...(payload.debug && match.debug ? { debug: match.debug } : {})
      })),
      ...((resolved.warnings?.length ?? 0) > 0 ? { warnings: [...(resolved.warnings ?? [])] } : {})
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
      await this.preloadSnapshotHandle(vault, snapshot, context, options);
    } finally {
      this.store.release(pin);
    }
  }

  private async preloadSnapshotHandle(
    vault: string,
    snapshot: SearchExecutionSnapshotHandle,
    context: DaemonRequestContext,
    options: SearchExecutionPreloadOptions = {}
  ): Promise<void> {
    assertRemainingDeadline(context.deadline);
    context.progress?.({
      phase: "preloading",
      completed: 0,
      message: "warming search planner"
    });
    warmSearchExecutionSnapshot(snapshot);
    assertRemainingDeadline(context.deadline);
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
        requestId: context.requestId,
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
  }

  private async queryAnalysis(
    rawQuery: string,
    search: NormalizedSearchParams,
    vault: string,
    context: DaemonRequestContext
  ): Promise<{ analysis: SearchTextAnalysis; analyzerIdentity: SearchAnalyzerIdentity }> {
    const baseAnalyzerIdentity = this.requireAnalyzerIdentity();
    const inlineAnalyzer = createInlineQueryAnalyzer(baseAnalyzerIdentity, rawQuery);
    const analyzerIdentity = inlineAnalyzer?.identity ?? baseAnalyzerIdentity;
    const cached = this.queryAnalysisCache.get({
      analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: this.searchSettingsHash
    });
    if (cached) {
      assertQueryAnalysisTermCount(cached);
      return { analysis: cached, analyzerIdentity };
    }

    assertRemainingDeadline(context.deadline);
    if (inlineAnalyzer) {
      const analysis = await analyzeSearchQuery(rawQuery, inlineAnalyzer, { ngram: this.searchSettings.ngram });
      assertQueryAnalysisTermCount(analysis);
      this.queryAnalysisCache.set({
        analyzerIdentity,
        rawQuery,
        fields: search.fields,
        searchSettingsHash: this.searchSettingsHash
      }, analysis);
      return { analysis, analyzerIdentity };
    }
    const result = await this.latencyAnalyzer.analyzeQuery(rawQuery, {
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      requestId: context.requestId,
      vault
    }, { ngram: this.searchSettings.ngram });
    assertQueryAnalysisTermCount(result.analysis);
    this.queryAnalysisCache.set({
      analyzerIdentity: result.analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: this.searchSettingsHash
    }, result.analysis);
    return result;
  }

  private async resolveRetrieveOrigin(
    payload: RetrieveRequestPayload,
    pin: PinnedRetrievalSnapshot,
    context: DaemonRequestContext
  ): Promise<{
    queryText: string;
    queryVector?: readonly number[];
    sourceDocumentId?: string;
    sourcePath?: string;
    excludeDocumentIds?: readonly string[];
    warnings: string[];
  }> {
    const records = pin.embeddingSet.records;
    const warnings: string[] = [];
    if (payload.origin === "text") {
      const queryText = (payload.text ?? payload.query ?? "").trim();
      if (!queryText) throw Object.assign(new Error("origin=text requires text or query"), { code: "BAD_REQUEST" });
      return { queryText, queryVector: await this.encodeRetrieveQueryVector(queryText, payload, pin, context, warnings), warnings };
    }
    if (payload.origin === "note") {
      const sourcePath = payload.sourcePath ?? payload.path ?? payload.left?.path;
      if (!sourcePath) throw Object.assign(new Error("origin=note requires sourcePath or path"), { code: "BAD_REQUEST" });
      const source = recordByPath(records, sourcePath);
      if (!source) throw Object.assign(new Error(`source note is not embedded: ${sourcePath}`), { code: "SEARCH_DAEMON_NOT_READY" });
      return {
        queryText: source.text,
        queryVector: await this.encodeRetrieveQueryVector(source.text, payload, pin, context, warnings),
        sourceDocumentId: source.documentId,
        sourcePath: source.path,
        excludeDocumentIds: [source.documentId],
        warnings
      };
    }
    if (payload.origin === "pair") {
      const leftPath = payload.left?.path ?? payload.sourcePath ?? payload.path;
      const rightPath = payload.right?.path;
      if (!leftPath || !rightPath) throw Object.assign(new Error("origin=pair requires left.path and right.path"), { code: "BAD_REQUEST" });
      const left = recordByPath(records, leftPath);
      if (!left) throw Object.assign(new Error(`left note is not embedded: ${leftPath}`), { code: "SEARCH_DAEMON_NOT_READY" });
      return {
        queryText: left.text,
        queryVector: await this.encodeRetrieveQueryVector(left.text, payload, pin, context, warnings),
        sourceDocumentId: left.documentId,
        sourcePath: left.path,
        warnings
      };
    }
    return {
      queryText: payload.query?.trim() || "",
      warnings
    };
  }

  private requireAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.latencyAnalyzer.analyzerIdentity ?? this.store.searchAnalyzerIdentity();
  }
}

function retrieveSearchPayload(payload: RetrieveRequestPayload, queryText: string): SearchRequestPayload {
  const limit = payload.limit ?? payload.topK;
  const pairRightPath = payload.origin === "pair" ? payload.right?.path : undefined;
  return {
    vault: payload.vault,
    query: queryText || payload.query || undefined,
    path: pairRightPath ?? payload.path,
    tags: payload.tags,
    fields: payload.fields,
    limit,
    debug: payload.debug,
    retrieval: payload.retrieval ?? "hybrid",
    coverage: payload.coverage,
    budget: payload.budget,
    snapshotId: payload.snapshotId,
    profile: payload.profile
  };
}

function assertRetrieveProviderModel(payload: RetrieveRequestPayload, pin: PinnedRetrievalSnapshot): void {
  const requested = payload.providerModel?.trim();
  if (!requested || requested === "default" || requested === pin.embeddingSet.model) return;
  throw new UsageError(
    `Retrieve provider model ${requested} does not match the active embedding model ${pin.embeddingSet.model}; rebuild with that model before querying`
  );
}

function modelProviderPayloadForEmbeddingSet(embeddingSet: PinnedRetrievalSnapshot["embeddingSet"]): ModelProviderPayload {
  if (embeddingSet.recipe.provider.id === "local-onnx") {
    return {
      kind: "local-onnx",
      model: embeddingSet.recipe.provider.model === "multilingual-e5-small" ? "multilingual-e5-small" : "bge-m3"
    };
  }
  if (embeddingSet.recipe.provider.id === "deterministic-hash") {
    return {
      kind: "deterministic-hash",
      model: embeddingSet.model,
      dim: embeddingSet.dim
    };
  }
  throw new UsageError(`Unsupported embedding provider ${embeddingSet.recipe.provider.id}`);
}

function filterMatchesByMinScore(matches: readonly SearchMatch[], minScore: number | undefined): SearchMatch[] {
  if (minScore === undefined || minScore <= 0) return [...matches];
  return matches.filter((match) => scoreForMatch(match) >= minScore);
}

function scoreForMatch(match: SearchMatch): number {
  return match.debug?.rerankScore ?? match.debug?.retrievalScore ?? 0;
}

function titleFromPath(relPath: string): string {
  return relPath.split(/[\\/]/u).pop()?.replace(/\.[^.]+$/u, "") || relPath;
}

function recordByPath(records: readonly { path?: string; documentId: string; text: string }[], relPath: string) {
  const normalized = normalizeRelPath(relPath);
  return records.find((record) => record.path && normalizeRelPath(record.path) === normalized);
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).join("/").normalize("NFC");
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

function normalizeRankingTuning(
  override: Partial<SearchRankingTuning> | undefined,
  settings: OptsidianSettings,
  env: NodeJS.ProcessEnv
): SearchRankingTuning {
  return {
    rrfK: positiveInteger(
      override?.rrfK ??
      envInteger(env.OPTSIDIAN_SEARCH_RRF_K) ??
      settings.search?.rrfK ??
      DEFAULT_RRF_K,
      "search.rrfK"
    ),
    lambdas: {
      phrase: SEARCH_SCORING_LAMBDAS.phrase,
      exact: SEARCH_SCORING_LAMBDAS.exact,
      dense: nonNegativeNumber(
        override?.lambdas?.dense ??
        envFloat(env.OPTSIDIAN_SEARCH_DENSE_LAMBDA) ??
        settings.search?.denseLambda ??
        SEARCH_SCORING_LAMBDAS.dense,
        "search.denseLambda"
      ),
      link: nonNegativeNumber(
        override?.lambdas?.link ??
        envFloat(env.OPTSIDIAN_SEARCH_LINK_LAMBDA) ??
        settings.search?.linkLambda ??
        SEARCH_SCORING_LAMBDAS.link,
        "search.linkLambda"
      )
    }
  };
}

function envInteger(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw);
}

function envFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`${label} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new UsageError(`${label} must be a non-negative number`);
  return value;
}
