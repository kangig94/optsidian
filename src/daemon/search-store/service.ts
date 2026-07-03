import fs from 'node:fs';
import crypto from 'node:crypto';
import { UsageError } from '../../errors.js';
import { matchesPathFilter, matchesTagFilter, normalizeSearchParams } from '../../core/search/params.js';
import { DEFAULT_RRF_K, SEARCH_SCORING_LAMBDAS, type SearchScoringLambdas } from '../../core/search/constants.js';
import { createInlineQueryAnalyzer, type SearchAnalyzerIdentity } from '../../core/search/analyzer.js';
import { emptySearchTokenChannels, SEARCH_TOKEN_CHANNELS } from '../../core/search/analysis/channels.js';
import type { SearchTextAnalysis } from '../../core/search/analysis/channels.js';
import { analyzeSearchQuery } from '../../core/search/analysis/query.js';
import { denseAgreementFromCosine } from '../../core/search/dense/provider.js';
import {
  indexAffectingSearchSettingsHash,
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings,
} from '../../core/search/index-settings.js';
import type { NormalizedSearchParams, PathFilter } from '../../core/search/internal-types.js';
import { searchExecutionWarningLabels } from '../../core/search/internal-types.js';
import type { RetrieveResult, SearchIndexMutationResult, SearchMatch, SearchResult } from '../../core/types.js';
import { resolveVaultPath } from '../../core/path.js';
import type {
  ExplainRequestPayload,
  ExplainResult,
  ModelProviderPayload,
  RetrieveRequestPayload,
  SearchIndexProgressUpdate,
  SearchRequestPayload,
} from '../protocol.js';
import { remainingDeadlineMs } from '../protocol.js';
import type { EmbedSchedulerLane } from '../embed-scheduler.js';
import { DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES } from '../query-analysis-cache-defaults.js';
import { QueryAnalysisCache } from '../query-analysis-cache.js';
import {
  executeMetadataSearchFromSnapshotHandle,
  warmSearchExecutionSnapshot,
  type SearchExecutionSnapshotHandle,
} from '../search-execution.js';
import type {
  AnalyzerWorkerPool,
  EmbeddingWorkerPool,
  SearchExecutionPreloadOptions,
  SearchExecutionWorkerPool,
} from '../pools.js';
import {
  type DaemonSnapshotStore,
  type DenseSignal,
  type DenseGenerationPin,
  type PinnedRetrievalReadContext,
  type PinnedRetrievalSnapshot,
  type SnapshotMutationResult,
  type SnapshotRequestContext,
} from './snapshot-store.js';
import { SearchQueryScheduler } from './query-scheduler.js';
import { applySearchWarnings } from './result-shaping.js';
import { readOptsidianSettings, type OptsidianSettings } from '../../core/settings.js';
import type { DenseVectorSearchHit } from '../search-execution.js';
import { snippetsForDocument } from './result-shaping.js';

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

type ResolvedRetrieveOriginText = {
  queryText: string;
  sourceDocumentId?: string;
  sourcePath?: string;
  rightSourceDocumentId?: string;
  rightSourcePath?: string;
  excludeDocumentIds?: readonly string[];
  warnings: string[];
};

type ResolvedRetrieveOrigin = ResolvedRetrieveOriginText & {
  queryVector?: readonly number[];
};

type ResolveRetrieveOriginVectorResult =
  | { status: 'ready'; resolved: ResolvedRetrieveOrigin }
  | { status: 'index-not-ready'; reason: string; warnings: string[] };

type ScheduledEmbeddingEncoder = {
  encode(
    payload: Parameters<EmbeddingWorkerPool['encode']>[0],
    options: Parameters<EmbeddingWorkerPool['encode']>[1],
    lane?: EmbedSchedulerLane,
  ): ReturnType<EmbeddingWorkerPool['encode']>;
};

export type SearchRankingTuning = {
  rrfK: number;
  lambdas: Partial<SearchScoringLambdas>;
};

export class DaemonSearchStoreService {
  private readonly queryAnalysisCache: QueryAnalysisCache;
  private readonly store: DaemonSnapshotStore;
  private readonly latencyAnalyzer: AnalyzerWorkerPool;
  private readonly embedding: ScheduledEmbeddingEncoder;
  private readonly searchExecution: SearchExecutionWorkerPool;
  private readonly queryScheduler: SearchQueryScheduler;
  private readonly searchSettings: IndexAffectingSearchSettings;
  private readonly searchSettingsHash: string;
  private readonly rankingTuning: SearchRankingTuning;

  constructor(
    store: DaemonSnapshotStore,
    latencyAnalyzer: AnalyzerWorkerPool,
    embedding: ScheduledEmbeddingEncoder,
    searchExecution: SearchExecutionWorkerPool,
    options: {
      queryCacheSize?: number;
      searchSettings?: Partial<IndexAffectingSearchSettings>;
      rankingTuning?: Partial<SearchRankingTuning>;
      settings?: OptsidianSettings;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.store = store;
    this.latencyAnalyzer = latencyAnalyzer;
    this.embedding = embedding;
    this.searchExecution = searchExecution;
    this.queryScheduler = new SearchQueryScheduler(searchExecution);
    this.searchSettings = normalizeIndexAffectingSearchSettings(options.searchSettings);
    this.searchSettingsHash = indexAffectingSearchSettingsHash(this.searchSettings);
    this.rankingTuning = normalizeRankingTuning(
      options.rankingTuning,
      options.settings ?? readOptsidianSettings(process.cwd(), options.env ?? process.env),
      options.env ?? process.env,
    );
    this.queryAnalysisCache = new QueryAnalysisCache(
      options.queryCacheSize ??
        envNumber(process.env.OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE) ??
        DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES,
    );
  }

  private async encodeRetrieveQueryVector(
    queryText: string,
    payload: RetrieveRequestPayload,
    densePin: DenseGenerationPin,
    context: DaemonRequestContext,
    warnings: string[],
  ): Promise<readonly number[] | undefined> {
    if (remainingDeadlineMs(context.deadline) <= 100) {
      warnings.push('dense query encode skipped because the request deadline was too close');
      return undefined;
    }
    try {
      const encoded = await this.embedding.encode(
        {
          texts: [queryText],
          inputKind: 'query',
          provider: modelProviderPayloadForEmbeddingSet(densePin.embeddingSet),
        },
        {
          deadline: context.deadline,
          cancellationId: context.cancellationId,
          requestId: context.requestId,
          vault: payload.vault,
        },
        'query',
      );
      return encoded.vectors[0];
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code === 'DEADLINE_EXCEEDED') {
        warnings.push('dense query encode skipped because the request deadline expired');
        return undefined;
      }
      throw error;
    }
  }

  async loadVault(vault: string, context: DaemonRequestContext, options: LoadVaultOptions = {}) {
    const queryAnalyzerWarmup = options.warmupQueryAnalyzer ? this.latencyAnalyzer.warmup(1) : undefined;
    const result = await this.store.loadVault(vault, snapshotContext(context));
    const failed = result.vaults.find((candidate) => candidate.status === 'failed');
    if (failed) {
      await queryAnalyzerWarmup?.catch(() => undefined);
      return result;
    }
    const warmups: Array<Promise<unknown>> = [];
    if (!failed && 'snapshotId' in result && result.snapshotId && options.preload !== false) {
      warmups.push(this.preloadSnapshot(vault, result.snapshotId, context, options.preload));
    }
    if (queryAnalyzerWarmup) warmups.push(queryAnalyzerWarmup);
    await Promise.all(warmups);
    return result;
  }

  async rebuild(vault: string, context: DaemonRequestContext): Promise<SnapshotMutationResult> {
    const result = await this.store.rebuild(vault, snapshotContext(context, 'rebuild'));
    if (result.snapshotId) await this.preloadSnapshot(vault, result.snapshotId, context);
    return result;
  }

  publishSaveSnapshot(vault: string, context: DaemonRequestContext): Promise<string> {
    return this.store.publishSaveSnapshot(vault, snapshotContext(context, 'save'));
  }

  async refresh(vault: string, context: DaemonRequestContext) {
    const result = await this.store.refresh(vault, snapshotContext(context, 'refresh'));
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

  async search(
    payload: SearchRequestPayload,
    context: DaemonRequestContext,
  ): Promise<SearchResult & { snapshotId: string }> {
    const search = normalizeSearchParams(payload);
    if (search.retrieval !== 'lexical') {
      throw Object.assign(
        new Error('Search method supports retrieval=lexical only; use Retrieve for vector or hybrid retrieval'),
        { code: 'BAD_REQUEST' },
      );
    }
    const result = await this.executeSearch(payload, context, false);
    const { explainTrace: _trace, ...searchResult } = result;
    return searchResult;
  }

  private retrieveIndexNotReadyResult(
    payload: RetrieveRequestPayload,
    reason: string,
    dense: DenseSignal,
    warnings: readonly string[] = [],
  ): RetrieveResult {
    return {
      ok: true,
      command: 'retrieve',
      schemaVersion: 1,
      available: false,
      status: 'index-not-ready',
      origin: payload.origin,
      reason,
      dense,
      matches: [],
      results: [],
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    };
  }

  async retrieve(payload: RetrieveRequestPayload, context: DaemonRequestContext): Promise<RetrieveResult> {
    const readContextResult = await this.store.pinLexicalReadContext(payload.vault, snapshotContext(context));
    if (readContextResult.status !== 'ready') {
      return this.retrieveIndexNotReadyResult(payload, readContextResult.reason, coldRetrieveDenseSignal());
    }
    const readContext = readContextResult.readContext;
    try {
      const resolvedText = this.resolveRetrieveOriginText(payload, readContext);
      const missingGlobalSource = payload.origin === 'global' && !resolvedText.sourcePath;
      const searchPayload = missingGlobalSource ? undefined : retrieveSearchPayload(payload, resolvedText.queryText);
      const search = searchPayload ? normalizeSearchParams(searchPayload) : undefined;
      const desiredEmbeddingSpace = this.store.currentEmbeddingSpaceId();
      const denseAttachment = await this.store.tryAttachDenseGeneration(readContext, desiredEmbeddingSpace);
      if (denseAttachment.status === 'attached')
        assertRetrieveProviderModel(payload, denseAttachment.densePin.embeddingSet.model);
      const modeConsumesDense = missingGlobalSource || search?.retrieval !== 'lexical';
      const denseComparable =
        denseAttachment.status === 'attached' && readContext.denseUsability.spaceMatch && modeConsumesDense;
      const originVector = await this.resolveRetrieveOriginVector(
        payload,
        readContext,
        resolvedText,
        context,
        denseComparable,
      );
      if (originVector.status === 'index-not-ready') {
        return this.retrieveIndexNotReadyResult(
          payload,
          originVector.reason,
          readContext.denseSignal,
          originVector.warnings,
        );
      }
      if (!searchPayload || !search) {
        return this.retrieveIndexNotReadyResult(
          payload,
          'source-vector-missing',
          readContext.denseSignal,
          originVector.resolved.warnings,
        );
      }
      const resolved = originVector.resolved;
      let denseSearchResults: readonly DenseVectorSearchHit[] | undefined;
      if (denseComparable && resolved.queryVector && readContext.densePin) {
        const denseSearch = await this.searchAttachedDenseGeneration(
          searchPayload,
          readContext.densePin,
          resolved.queryVector,
        );
        if (denseSearch.status === 'ready') {
          denseSearchResults = denseSearch.results;
        } else {
          resolved.warnings.push(`dense retrieval skipped: ${denseSearch.reason}`);
        }
      }
      const densePin = readContext.densePin;
      const denseContributed =
        Boolean(denseComparable && resolved.queryVector && denseSearchResults && densePin) &&
        (densePin
          ? this.hasUsableDenseSearchResult(
              payload,
              searchPayload,
              readContext,
              densePin,
              denseSearchResults ?? [],
              resolved.excludeDocumentIds,
            )
          : false);
      if (search.retrieval === 'vector' && denseContributed && densePin) {
        return this.vectorOnlyRetrieveResult(payload, searchPayload, readContext, densePin, denseSearchResults ?? [], {
          excludeDocumentIds: resolved.excludeDocumentIds,
          warnings: resolved.warnings,
        });
      }
      const explain = payload.explain === true;
      const result = await this.executeSearchWithPin(
        { ...searchPayload, debug: true },
        context,
        explain,
        readContext.lexicalPin,
        {
          queryVector: denseContributed ? resolved.queryVector : undefined,
          denseEmbeddingSet: denseContributed ? densePin?.embeddingSet : undefined,
          denseSearchResults: denseContributed ? denseSearchResults : undefined,
          denseLiveContentHashes: denseContributed ? readContext.liveContentHashes : undefined,
          sourceDocumentId: resolved.sourceDocumentId,
          sourcePath: resolved.sourcePath,
          excludeDocumentIds: resolved.excludeDocumentIds,
          warnings: resolved.warnings,
        },
      );
      const scoredMatches = filterMatchesByMinScore(result.matches, payload.minScore);
      const matches = payload.debug ? scoredMatches : scoredMatches.map(({ debug: _debug, ...match }) => match);
      return {
        ok: true,
        command: 'retrieve',
        schemaVersion: 1,
        available: true,
        status: 'ready',
        origin: payload.origin,
        snapshotId: readContext.lexicalPin.snapshotId,
        ...(readContext.densePin ? { retrievalSnapshotId: readContext.densePin.retrieval.retrievalSnapshotId } : {}),
        dense: readContext.denseSignal,
        matches,
        results: scoredMatches.map((match) => ({
          path: match.path,
          title: match.title,
          score: scoreForMatch(match),
          tags: match.tags,
          snippets: match.snippets,
          ...(payload.debug && match.debug ? { debug: match.debug } : {}),
        })),
        ...(payload.debug && result.debug ? { debug: result.debug } : {}),
        ...(explain && result.explainTrace ? { explainTrace: result.explainTrace } : {}),
        ...(resolved.warnings.length > 0 || (result.warnings?.length ?? 0) > 0
          ? { warnings: [...resolved.warnings, ...(result.warnings ?? [])] }
          : {}),
      };
    } finally {
      this.store.releaseReadContext(readContext);
    }
  }

  async explain(payload: ExplainRequestPayload, context: DaemonRequestContext): Promise<ExplainResult> {
    const result = await this.executeSearch({ ...payload, debug: true }, context, true);
    const { explainTrace, ...search } = result;
    if (!explainTrace) throw Object.assign(new Error('explain requires a query search trace'), { code: 'BAD_REQUEST' });
    return {
      ok: true,
      command: 'explain',
      snapshotId: search.snapshotId,
      search,
      trace: explainTrace,
      ...(search.warnings && search.warnings.length > 0 ? { warnings: search.warnings } : {}),
    };
  }

  private async executeSearch(payload: SearchRequestPayload, context: DaemonRequestContext, explain: boolean) {
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
    pin: Parameters<DaemonSnapshotStore['snapshotHandleForPin']>[0] | PinnedRetrievalSnapshot,
    retrieval: {
      queryVector?: readonly number[];
      denseEmbeddingSet?: DenseGenerationPin['embeddingSet'];
      denseSearchResults?: readonly DenseVectorSearchHit[];
      denseLiveContentHashes?: ReadonlyMap<string, string>;
      sourceDocumentId?: string;
      sourcePath?: string;
      excludeDocumentIds?: readonly string[];
      warnings?: readonly string[];
    } = {},
  ) {
    const search = normalizeSearchParams(payload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const snapshot = this.store.snapshotHandleForPin(pin);
    const documents = this.documentsForPin(pin);
    if (!search.query && !retrieval.queryVector) {
      return applySearchWarnings(
        executeMetadataSearchFromSnapshotHandle({
          search,
          pathFilter,
          snapshot,
          analyzerIdentity: this.requireAnalyzerIdentity(),
          documents,
          excludeDocumentIds: retrieval.excludeDocumentIds,
        }),
        [...searchExecutionWarningLabels(search), ...(retrieval.warnings ?? [])],
      );
    }
    const rawQuery = search.query ? search.query : retrieval.sourcePath ? retrieval.sourcePath : '';
    const analysisResult = rawQuery ? await this.queryAnalysis(rawQuery, search, payload.vault, context) : undefined;
    if (!analysisResult)
      throw Object.assign(new Error('query analysis is required for retrieve search'), { code: 'INTERNAL' });
    return await this.queryScheduler.execute({
      vault: payload.vault,
      search: search.query ? search : { ...search, query: rawQuery },
      pathFilter,
      analysis: analysisResult.analysis,
      analyzerIdentity: analysisResult.analyzerIdentity,
      snapshot,
      documents,
      denseEmbeddingSet: retrieval.denseEmbeddingSet ?? ('embeddingSet' in pin ? pin.embeddingSet : undefined),
      queryVector: retrieval.queryVector,
      denseSearchResults: retrieval.denseSearchResults,
      denseLiveContentHashes: retrieval.denseLiveContentHashes,
      sourceDocumentId: retrieval.sourceDocumentId,
      sourcePath: retrieval.sourcePath,
      excludeDocumentIds: retrieval.excludeDocumentIds,
      rrfK: this.rankingTuning.rrfK,
      scoringLambdas: this.rankingTuning.lambdas,
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      requestId: context.requestId,
      explain,
    });
  }

  stats() {
    return {
      queryAnalysisCache: this.queryAnalysisCache.stats(),
      rankingTuningHash: rankingTuningHash(this.rankingTuning),
    };
  }

  resultIdentityForQuery(input: {
    snapshotId: string;
    query: string;
    filters?: unknown;
    limit: number;
    rankingVersion: string;
    analyzerIdentity: SearchAnalyzerIdentity;
  }) {
    return {
      ...input,
      rankingTuningHash: rankingTuningHash(this.rankingTuning),
    };
  }

  private documentsForPin(pin: Parameters<DaemonSnapshotStore['documentsForPin']>[0]) {
    const store = this.store as { documentsForPin?: DaemonSnapshotStore['documentsForPin'] };
    return store.documentsForPin?.(pin);
  }

  private async searchAttachedDenseGeneration(
    payload: SearchRequestPayload,
    densePin: DenseGenerationPin,
    queryVector: readonly number[] | undefined,
  ): Promise<
    { status: 'ready'; results?: readonly DenseVectorSearchHit[] } | { status: 'unreadable'; reason: string }
  > {
    if (!queryVector) return { status: 'ready' };
    const search = normalizeSearchParams(payload);
    try {
      const results = await densePin.vectorLease.searchVector(queryVector, Math.max(search.limit, search.limit * 4));
      return {
        status: 'ready',
        results: results.map((entry) => ({
          chunkId: entry.chunkId,
          entryId: entry.entryId,
          similarity: entry.similarity,
        })),
      };
    } catch {
      return { status: 'unreadable', reason: 'vector-search-failed' };
    }
  }

  private vectorOnlyRetrieveResult(
    payload: RetrieveRequestPayload,
    searchPayload: SearchRequestPayload,
    readContext: PinnedRetrievalReadContext,
    densePin: DenseGenerationPin,
    denseResults: readonly DenseVectorSearchHit[],
    resolved: {
      excludeDocumentIds?: readonly string[];
      warnings?: readonly string[];
    },
  ): RetrieveResult {
    const search = normalizeSearchParams(searchPayload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const documents = readContext.liveDocuments;
    const excluded = new Set(resolved.excludeDocumentIds ?? []);
    const matchesWithScore: Array<{ match: SearchMatch; score: number }> = [];
    for (const [index, result] of denseResults.entries()) {
      const document = documents?.get(result.entryId);
      if (!document || excluded.has(document.documentId)) continue;
      const denseRecord = densePin.recordsByDocumentId.get(document.documentId);
      if (!denseRecord || denseRecord.contentHash !== document.contentHash) continue;
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
                  source: 'persisted' as const,
                  queryTerms: [],
                  analyzer: this.requireAnalyzerIdentity(),
                  retrievalScore: score,
                  denseAgreement: score,
                  baseRank: index + 1,
                  snapshotId: readContext.lexicalPin.snapshotId,
                },
              }
            : {}),
        },
      });
      if (matchesWithScore.length >= search.limit) break;
    }
    const matches = matchesWithScore.map((entry) => entry.match);
    return {
      ok: true,
      command: 'retrieve',
      schemaVersion: 1,
      available: true,
      status: 'ready',
      origin: payload.origin,
      snapshotId: readContext.lexicalPin.snapshotId,
      retrievalSnapshotId: densePin.retrieval.retrievalSnapshotId,
      dense: readContext.denseSignal,
      matches,
      results: matchesWithScore.map(({ match, score }) => ({
        path: match.path,
        title: match.title,
        score,
        tags: match.tags,
        snippets: match.snippets,
        ...(payload.debug && match.debug ? { debug: match.debug } : {}),
      })),
      ...((resolved.warnings?.length ?? 0) > 0 ? { warnings: [...(resolved.warnings ?? [])] } : {}),
    };
  }

  private hasUsableDenseSearchResult(
    payload: RetrieveRequestPayload,
    searchPayload: SearchRequestPayload,
    readContext: PinnedRetrievalReadContext,
    densePin: DenseGenerationPin,
    denseResults: readonly DenseVectorSearchHit[],
    excludeDocumentIds?: readonly string[],
  ): boolean {
    const search = normalizeSearchParams(searchPayload);
    const pathFilter = search.path ? resolvePathFilter(payload.vault, search.path) : undefined;
    const excluded = new Set(excludeDocumentIds ?? []);
    return denseResults.some((result) =>
      this.denseSearchResultUsableForRetrieval(result, search, pathFilter, readContext, densePin, excluded),
    );
  }

  private denseSearchResultUsableForRetrieval(
    result: DenseVectorSearchHit,
    search: NormalizedSearchParams,
    pathFilter: PathFilter | undefined,
    readContext: PinnedRetrievalReadContext,
    densePin: DenseGenerationPin,
    excluded: ReadonlySet<string>,
  ): boolean {
    const document = readContext.liveDocuments.get(result.entryId);
    if (!document || excluded.has(document.documentId)) return false;
    const denseRecord = densePin.recordsByDocumentId.get(document.documentId);
    if (!denseRecord || denseRecord.contentHash !== document.contentHash) return false;
    if (pathFilter && !matchesPathFilter(document.path, pathFilter)) return false;
    return matchesTagFilter(document.tags, search.tags);
  }

  private async preloadSnapshot(
    vault: string,
    snapshotId: string,
    context: DaemonRequestContext,
    options: SearchExecutionPreloadOptions = {},
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
    options: SearchExecutionPreloadOptions = {},
  ): Promise<void> {
    assertRemainingDeadline(context.deadline);
    context.progress?.({
      phase: 'preloading',
      completed: 0,
      message: 'warming search planner',
    });
    warmSearchExecutionSnapshot(snapshot);
    assertRemainingDeadline(context.deadline);
    context.progress?.({
      phase: 'preloading',
      completed: 0,
      message: 'warming search workers',
    });
    const warmed = await this.searchExecution.preloadSnapshot(
      snapshot,
      {
        deadline: context.deadline,
        cancellationId: context.cancellationId,
        requestId: context.requestId,
        vault,
      },
      options,
    );
    context.progress?.({
      phase: 'preloading',
      total: warmed.length,
      completed: warmed.length,
      message: 'search workers warm',
    });
  }

  private async queryAnalysis(
    rawQuery: string,
    search: NormalizedSearchParams,
    vault: string,
    context: DaemonRequestContext,
  ): Promise<{ analysis: SearchTextAnalysis; analyzerIdentity: SearchAnalyzerIdentity }> {
    const baseAnalyzerIdentity = this.requireAnalyzerIdentity();
    const inlineAnalyzer = createInlineQueryAnalyzer(baseAnalyzerIdentity, rawQuery);
    const analyzerIdentity = inlineAnalyzer?.identity ?? baseAnalyzerIdentity;
    const cached = this.queryAnalysisCache.get({
      analyzerIdentity,
      rawQuery,
      fields: search.fields,
      searchSettingsHash: this.searchSettingsHash,
    });
    if (cached) {
      assertQueryAnalysisTermCount(cached);
      return { analysis: cached, analyzerIdentity };
    }

    assertRemainingDeadline(context.deadline);
    if (inlineAnalyzer) {
      const analysis = await analyzeSearchQuery(rawQuery, inlineAnalyzer, { ngram: this.searchSettings.ngram });
      assertQueryAnalysisTermCount(analysis);
      this.queryAnalysisCache.set(
        {
          analyzerIdentity,
          rawQuery,
          fields: search.fields,
          searchSettingsHash: this.searchSettingsHash,
        },
        analysis,
      );
      return { analysis, analyzerIdentity };
    }
    const result = await this.latencyAnalyzer.analyzeQuery(
      rawQuery,
      {
        deadline: context.deadline,
        cancellationId: context.cancellationId,
        requestId: context.requestId,
        vault,
      },
      { ngram: this.searchSettings.ngram },
    );
    assertQueryAnalysisTermCount(result.analysis);
    this.queryAnalysisCache.set(
      {
        analyzerIdentity: result.analyzerIdentity,
        rawQuery,
        fields: search.fields,
        searchSettingsHash: this.searchSettingsHash,
      },
      result.analysis,
    );
    return result;
  }

  private resolveRetrieveOriginText(
    payload: RetrieveRequestPayload,
    readContext: PinnedRetrievalReadContext,
  ): ResolvedRetrieveOriginText {
    const warnings: string[] = [];
    if (payload.origin === 'text') {
      const queryText = (payload.text ?? payload.query ?? '').trim();
      if (!queryText) throw Object.assign(new Error('origin=text requires text or query'), { code: 'BAD_REQUEST' });
      return { queryText, warnings };
    }
    if (payload.origin === 'note') {
      const sourcePath = payload.sourcePath ?? payload.path ?? payload.left?.path;
      if (!sourcePath)
        throw Object.assign(new Error('origin=note requires sourcePath or path'), { code: 'BAD_REQUEST' });
      const source = liveDocumentByPath(readContext.liveDocuments, sourcePath);
      if (!source)
        throw Object.assign(new Error(`source note is not indexed: ${sourcePath}`), {
          code: 'SEARCH_DAEMON_NOT_READY',
        });
      return {
        queryText: denseTextForLiveDocument(source),
        sourceDocumentId: source.documentId,
        sourcePath: source.path,
        excludeDocumentIds: [source.documentId],
        warnings,
      };
    }
    if (payload.origin === 'pair') {
      const leftPath = payload.left?.path ?? payload.sourcePath ?? payload.path;
      const rightPath = payload.right?.path;
      if (
        payload.left?.text !== undefined ||
        payload.right?.text !== undefined ||
        payload.text !== undefined ||
        payload.query !== undefined
      ) {
        throw Object.assign(new Error('origin=pair accepts note-path sides only; use origin=text for raw text'), {
          code: 'BAD_REQUEST',
        });
      }
      if (!leftPath || !rightPath) {
        throw Object.assign(new Error('origin=pair requires left.path and right.path'), { code: 'BAD_REQUEST' });
      }
      const left = liveDocumentByPath(readContext.liveDocuments, leftPath);
      if (!left)
        throw Object.assign(new Error(`left note is not indexed: ${leftPath}`), { code: 'SEARCH_DAEMON_NOT_READY' });
      const right = liveDocumentByPath(readContext.liveDocuments, rightPath);
      if (!right)
        throw Object.assign(new Error(`right note is not indexed: ${rightPath}`), { code: 'SEARCH_DAEMON_NOT_READY' });
      return {
        queryText: denseTextForLiveDocument(left),
        sourceDocumentId: left.documentId,
        sourcePath: left.path,
        rightSourceDocumentId: right.documentId,
        rightSourcePath: right.path,
        warnings,
      };
    }
    if (payload.origin === 'global') {
      const sourcePath = payload.sourcePath ?? payload.path ?? payload.left?.path;
      if (!sourcePath) return { queryText: '', warnings };
      const source = liveDocumentByPath(readContext.liveDocuments, sourcePath);
      if (!source)
        throw Object.assign(new Error(`global source note is not indexed: ${sourcePath}`), {
          code: 'SEARCH_DAEMON_NOT_READY',
        });
      return {
        queryText: denseTextForLiveDocument(source),
        sourceDocumentId: source.documentId,
        sourcePath: source.path,
        warnings,
      };
    }
    return {
      queryText: payload.query?.trim() ?? '',
      warnings,
    };
  }

  private async resolveRetrieveOriginVector(
    payload: RetrieveRequestPayload,
    readContext: PinnedRetrievalReadContext,
    resolved: ResolvedRetrieveOriginText,
    context: DaemonRequestContext,
    denseComparable: boolean,
  ): Promise<ResolveRetrieveOriginVectorResult> {
    const densePin = readContext.densePin;
    if (payload.origin === 'text') {
      if (!denseComparable || !densePin) return { status: 'ready', resolved };
      return {
        status: 'ready',
        resolved: {
          ...resolved,
          queryVector: await this.encodeRetrieveQueryVector(
            resolved.queryText,
            payload,
            densePin,
            context,
            resolved.warnings,
          ),
        },
      };
    }
    if (!denseComparable || !densePin) {
      return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
    }
    if (payload.origin === 'note') {
      const sourcePath = payload.sourcePath ?? payload.path ?? payload.left?.path;
      const record = sourcePath ? recordByPath(densePin.embeddingSet.records, sourcePath) : undefined;
      const queryVector = usableStoredVector(record, readContext.liveContentHashes, sourcePath);
      if (!queryVector)
        return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
      return {
        status: 'ready',
        resolved: {
          ...resolved,
          queryVector,
        },
      };
    }
    if (payload.origin === 'pair') {
      const leftPath = payload.left?.path ?? payload.sourcePath ?? payload.path;
      const rightPath = payload.right?.path ?? resolved.rightSourcePath;
      if (!rightPath || !leftPath)
        return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
      const leftRecord = recordByPath(densePin.embeddingSet.records, leftPath);
      const rightRecord = recordByPath(densePin.embeddingSet.records, rightPath);
      const queryVector = usableStoredVector(leftRecord, readContext.liveContentHashes, leftPath);
      const rightVector = usableStoredVector(rightRecord, readContext.liveContentHashes, rightPath);
      if (!queryVector || !rightVector)
        return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
      return {
        status: 'ready',
        resolved: {
          ...resolved,
          queryVector,
        },
      };
    }
    if (payload.origin === 'global') {
      const sourcePath = resolved.sourcePath ?? payload.sourcePath ?? payload.path ?? payload.left?.path;
      if (!sourcePath)
        return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
      const record = recordByPath(densePin.embeddingSet.records, sourcePath);
      const queryVector = usableStoredVector(record, readContext.liveContentHashes, sourcePath);
      if (!queryVector)
        return { status: 'index-not-ready', reason: 'source-vector-missing', warnings: resolved.warnings };
      return {
        status: 'ready',
        resolved: {
          ...resolved,
          queryVector,
        },
      };
    }
    return { status: 'ready', resolved };
  }

  private requireAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.latencyAnalyzer.analyzerIdentity ?? this.store.searchAnalyzerIdentity();
  }
}

function retrieveSearchPayload(payload: RetrieveRequestPayload, queryText: string): SearchRequestPayload {
  const limit = payload.limit ?? payload.topK;
  const pairRightPath =
    payload.origin === 'pair'
      ? (payload.right?.path ??
        (payload.right?.text !== undefined ? (payload.left?.path ?? payload.sourcePath) : undefined))
      : undefined;
  return {
    vault: payload.vault,
    query: queryText ? queryText : payload.query ? payload.query : undefined,
    path: pairRightPath ?? payload.path,
    tags: payload.tags,
    fields: payload.fields,
    limit,
    debug: payload.debug,
    retrieval: payload.retrieval ?? 'hybrid',
    coverage: payload.coverage,
    budget: payload.budget,
    snapshotId: payload.snapshotId,
    profile: payload.profile,
  };
}

function assertRetrieveProviderModel(payload: RetrieveRequestPayload, activeModel: string): void {
  const requested = payload.providerModel?.trim();
  if (!requested || requested === 'default' || requested === activeModel) return;
  throw new UsageError(
    `Retrieve provider model ${requested} does not match the active embedding model ${activeModel}; rebuild with that model before querying`,
  );
}

function modelProviderPayloadForEmbeddingSet(embeddingSet: DenseGenerationPin['embeddingSet']): ModelProviderPayload {
  if (embeddingSet.recipe.provider.id === 'local-onnx') {
    return {
      kind: 'local-onnx',
      model: embeddingSet.recipe.provider.model === 'multilingual-e5-small' ? 'multilingual-e5-small' : 'bge-m3',
    };
  }
  if (embeddingSet.recipe.provider.id === 'deterministic-hash') {
    return {
      kind: 'deterministic-hash',
      model: embeddingSet.model,
      dim: embeddingSet.dim,
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
  const basename = relPath
    .split(/[\\/]/u)
    .pop()
    ?.replace(/\.[^.]+$/u, '');
  return basename ? basename : relPath;
}

function recordByPath(
  records: readonly {
    path?: string;
    documentId: string;
    text: string;
    contentHash: string;
    vector?: readonly number[];
  }[],
  relPath: string,
) {
  const normalized = normalizeRelPath(relPath);
  return records.find((record) => record.path && normalizeRelPath(record.path) === normalized);
}

function liveDocumentByPath<T extends { path: string }>(
  documents: ReadonlyMap<string, T>,
  relPath: string,
): T | undefined {
  const normalized = normalizeRelPath(relPath);
  for (const document of documents.values()) {
    if (normalizeRelPath(document.path) === normalized) return document;
  }
  return undefined;
}

function denseTextForLiveDocument(document: {
  title: string;
  path: string;
  tags: readonly string[];
  snippetCorpus: { lines: readonly { text: string }[] };
}): string {
  const snippets = document.snippetCorpus.lines.map((line) => line.text).join('\n');
  const tags = document.tags.length > 0 ? `\n${document.tags.join(' ')}` : '';
  return `${document.title}\n${document.path}\n${snippets}${tags}`.trim();
}

function usableStoredVector(
  record: { documentId: string; contentHash: string; vector?: readonly number[] } | undefined,
  liveContentHashes: ReadonlyMap<string, string>,
  relPath: string | undefined,
): readonly number[] | undefined {
  if (!record || !relPath) return undefined;
  const liveHash = liveContentHashes.get(record.documentId);
  if (liveHash !== record.contentHash) return undefined;
  return Array.isArray(record.vector) ? record.vector : undefined;
}

function coldRetrieveDenseSignal(pendingCount = 0): DenseSignal {
  return {
    state: 'cold',
    pendingCount,
    generationAgeMs: null,
  };
}

function normalizeRelPath(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).join('/').normalize('NFC');
}

function assertQueryAnalysisTermCount(analysis: SearchTextAnalysis): void {
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const count = analysis.channels[channel].length;
    if (count > MAX_SEARCH_QUERY_TERMS_PER_CHANNEL) {
      throw new UsageError(
        `query expands to too many ${channel} terms (${count}; max ${MAX_SEARCH_QUERY_TERMS_PER_CHANNEL})`,
      );
    }
  }
}

function snapshotContext(context: DaemonRequestContext, embeddingLane?: EmbedSchedulerLane): SnapshotRequestContext {
  return {
    deadline: context.deadline,
    cancellationId: context.cancellationId,
    progress: context.progress,
    ...(embeddingLane ? { embeddingLane } : {}),
  };
}

function assertRemainingDeadline(deadline: number): void {
  if (remainingDeadlineMs(deadline) <= 0) {
    throw Object.assign(new Error('request deadline expired before query analysis'), { code: 'DEADLINE_EXCEEDED' });
  }
}

function resolvePathFilter(vaultRoot: string, input: string): PathFilter {
  const resolved = resolveVaultPath(vaultRoot, input, { mustExist: true });
  const stat = fs.statSync(resolved.abs);
  return { rel: resolved.rel === '.' ? '' : resolved.rel, directory: stat.isDirectory() };
}

function envNumber(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function normalizeRankingTuning(
  override: Partial<SearchRankingTuning> | undefined,
  settings: OptsidianSettings,
  env: NodeJS.ProcessEnv,
): SearchRankingTuning {
  return {
    rrfK: positiveInteger(
      override?.rrfK ?? envInteger(env.OPTSIDIAN_SEARCH_RRF_K) ?? settings.search?.rrfK ?? DEFAULT_RRF_K,
      'search.rrfK',
    ),
    lambdas: {
      phrase: SEARCH_SCORING_LAMBDAS.phrase,
      exact: SEARCH_SCORING_LAMBDAS.exact,
      dense: nonNegativeNumber(
        override?.lambdas?.dense ??
          envFloat(env.OPTSIDIAN_SEARCH_DENSE_LAMBDA) ??
          settings.search?.denseLambda ??
          SEARCH_SCORING_LAMBDAS.dense,
        'search.denseLambda',
      ),
      link: nonNegativeNumber(
        override?.lambdas?.link ??
          envFloat(env.OPTSIDIAN_SEARCH_LINK_LAMBDA) ??
          settings.search?.linkLambda ??
          SEARCH_SCORING_LAMBDAS.link,
        'search.linkLambda',
      ),
    },
  };
}

export function rankingTuningHash(tuning: SearchRankingTuning): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        denseLambda: tuning.lambdas.dense ?? SEARCH_SCORING_LAMBDAS.dense,
        linkLambda: tuning.lambdas.link ?? SEARCH_SCORING_LAMBDAS.link,
        rrfK: tuning.rrfK,
      }),
    )
    .digest('hex');
}

function envInteger(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw);
}

function envFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
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
