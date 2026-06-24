import crypto from "node:crypto";
import { SEARCH_TOKEN_CHANNELS, emptySearchTokenChannels, type SearchTextAnalysis, type SearchTokenChannel, type SearchTokenChannelTerms } from "../core/search/analysis/index.js";
import { uniqueSearchTerms } from "../core/search/analysis/channels.js";
import type {
  CandidateCoverageFeature,
  CandidateBm25Feature,
  CandidateFeaturePayload,
  CandidateRef,
  CandidateSet,
  ExplainTrace,
  FeatureStore,
  RetrievalCandidate,
  RetrievalQuery
} from "../core/search/contracts.js";
import { SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION } from "../core/search/contracts.js";
import { CANDIDATE_LIMIT_MIN, CANDIDATE_LIMIT_MULTIPLIER, RANKING_CONSTANTS, RANK_BUCKET, RANK_SIGNAL_WEIGHTS, RRF_K, RRF_WEIGHTS, SEARCH_TOKEN_CHANNEL_WEIGHT } from "../core/search/constants.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import type { SearchDocument } from "../core/search/markdown.js";
import {
  bm25TermScore,
  bm25TermStats,
  createSearchEngine,
  createPositionalRetriever,
  POSITIONAL_FIELD_BY_ID,
  POSITIONAL_FIELD_ID,
  positionsForTerm,
  buildSearchSnapshotFromSegments,
  type SearchSnapshot
} from "../core/search/retrieval/positional/index.js";
import { compareTagOnlyMatches, metadataCoverage, bestExactPriority, bestPhrasePriority, identityPhraseCandidates, nullableRankPriority, rankBucketName, rerankCandidatesWithSignals, rrfContribution, type CandidateRankSignals } from "../core/search/ranking/index.js";
import { matchesPathFilter, matchesTagFilter } from "../core/search/params.js";
import { SEARCH_BOOST } from "../core/search/schema.js";
import { SEARCH_PROPERTIES } from "../core/search/schema.js";
import type { NormalizedSearchParams, PathFilter, QueryContext, RankedCandidate } from "../core/search/internal-types.js";
import type { SearchField, SearchMatch, SearchResult } from "../core/types.js";
import type { SnapshotEnvelope, PersistedDocumentRecord, SnapshotSnippetLine } from "./search-store/types.js";

export type SharedBytesHandle = {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  byteLength: number;
};

export type SearchExecutionSnapshotHandle = {
  snapshotId: string;
  pinToken: string;
  documents: SharedBytesHandle;
  segments: Array<{
    segmentId: string;
    bytes: SharedBytesHandle;
  }>;
};

export type SearchExecutionJob = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis?: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  explain?: boolean;
};

export type SearchExecutionCacheStats = {
  entries: number;
  limit: number;
  hits: number;
  misses: number;
  evictions: number;
  preloads: number;
  snapshotIds: string[];
};

export type SearchExecutionPreloadResult = {
  snapshotId: string;
  cacheHit: boolean;
  cache: SearchExecutionCacheStats;
};

type SearchExecutionState = {
  snapshot: SearchSnapshot;
  documents: Map<string, PersistedDocumentRecord>;
};

type MetadataExecutionState = {
  snapshotId: string;
  documents: Map<string, PersistedDocumentRecord>;
};

const SEARCH_EXECUTION_STATE_CACHE_LIMIT = envPositiveInt("OPTSIDIAN_SEARCH_EXECUTION_CACHE_SNAPSHOTS") ?? 2;
const searchExecutionStateCache = new Map<string, SearchExecutionState>();
const searchExecutionMetadataCache = new Map<string, MetadataExecutionState>();
const searchExecutionStateCacheCounters = {
  hits: 0,
  misses: 0,
  evictions: 0,
  preloads: 0
};
const textDecoder = new TextDecoder();

type PositionalHit = {
  document: SearchDocument;
  score: number;
  queryTerms: string[];
  queryChannels: SearchTokenChannelTerms;
  matchedChannels: SearchTokenChannel[];
  channelScores: Partial<Record<SearchTokenChannel, number>>;
  candidate: RetrievalCandidate;
  source: "persisted";
};

type MutablePositionalPostings = Map<string, Array<{ docId: number; fieldId: number; positions: readonly number[] }>>;

export type SearchExecutionResult = SearchResult & { snapshotId: string; explainTrace?: ExplainTrace };

export function executeSearchJob(job: SearchExecutionJob): SearchExecutionResult {
  if (!job.search.query || !job.analysis) {
    const metadataState = cachedMetadataStateFromHandle(job.snapshot).state;
    const result = metadataSearch(job.search, job.pathFilter, metadataState.documents, metadataState.snapshotId, job.analyzerIdentity);
    return { ...result, snapshotId: metadataState.snapshotId };
  }
  const state = cachedStateFromHandle(job.snapshot).state;
  const result = querySearch(job.search, job.pathFilter, state.snapshot, state.documents, job.analysis, job.analyzerIdentity, job.explain === true);
  return { ...result, snapshotId: state.snapshot.snapshotId };
}

export function preloadSearchExecutionSnapshot(handle: SearchExecutionSnapshotHandle): SearchExecutionPreloadResult {
  const result = cachedStateFromHandle(handle);
  searchExecutionStateCacheCounters.preloads += 1;
  return {
    snapshotId: result.state.snapshot.snapshotId,
    cacheHit: result.cacheHit,
    cache: searchExecutionCacheStats()
  };
}

export function searchExecutionCacheStats(): SearchExecutionCacheStats {
  return {
    entries: searchExecutionStateCache.size,
    limit: SEARCH_EXECUTION_STATE_CACHE_LIMIT,
    hits: searchExecutionStateCacheCounters.hits,
    misses: searchExecutionStateCacheCounters.misses,
    evictions: searchExecutionStateCacheCounters.evictions,
    preloads: searchExecutionStateCacheCounters.preloads,
    snapshotIds: [...searchExecutionStateCache.keys()]
  };
}

function cachedStateFromHandle(handle: SearchExecutionSnapshotHandle): { state: SearchExecutionState; cacheHit: boolean } {
  const cacheKey = handle.snapshotId;
  const cached = searchExecutionStateCache.get(cacheKey);
  if (cached) {
    searchExecutionStateCacheCounters.hits += 1;
    searchExecutionStateCache.delete(cacheKey);
    searchExecutionStateCache.set(cacheKey, cached);
    return { state: cached, cacheHit: true };
  }
  searchExecutionStateCacheCounters.misses += 1;
  const state = stateFromHandle(handle);
  searchExecutionStateCache.set(cacheKey, state);
  while (searchExecutionStateCache.size > SEARCH_EXECUTION_STATE_CACHE_LIMIT) {
    const oldest = searchExecutionStateCache.keys().next().value;
    if (!oldest) break;
    searchExecutionStateCache.delete(oldest);
    searchExecutionStateCacheCounters.evictions += 1;
  }
  return { state, cacheHit: false };
}

function cachedMetadataStateFromHandle(handle: SearchExecutionSnapshotHandle): { state: MetadataExecutionState; cacheHit: boolean } {
  const cacheKey = handle.snapshotId;
  const cached = searchExecutionMetadataCache.get(cacheKey);
  if (cached) {
    searchExecutionMetadataCache.delete(cacheKey);
    searchExecutionMetadataCache.set(cacheKey, cached);
    return { state: cached, cacheHit: true };
  }
  const state = metadataStateFromHandle(handle);
  searchExecutionMetadataCache.set(cacheKey, state);
  while (searchExecutionMetadataCache.size > SEARCH_EXECUTION_STATE_CACHE_LIMIT) {
    const oldest = searchExecutionMetadataCache.keys().next().value;
    if (!oldest) break;
    searchExecutionMetadataCache.delete(oldest);
  }
  return { state, cacheHit: false };
}

function querySearch(
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  snapshot: SearchSnapshot,
  documents: Map<string, PersistedDocumentRecord>,
  analysis: SearchTextAnalysis,
  analyzerIdentity: SearchAnalyzerIdentity,
  explain: boolean
): SearchExecutionResult {
  const query = search.query ?? "";
  if (analysis.primaryTerms.length === 0) return { ...searchResult([], snapshot.snapshotId, analyzerIdentity, search, 0), snapshotId: snapshot.snapshotId };
  const engine = createSearchEngine(snapshot, createPositionalRetriever(snapshot), createSnapshotFeatureStore(snapshot, documents));
  const retrievalQuery: RetrievalQuery = {
    rawQuery: query,
    analysis,
    fields: search.fields,
    tags: search.tags,
    limit: positionalCandidateLimit(snapshot.documents.length, search, analysis.channels),
    snapshotId: snapshot.snapshotId
  };
  const candidateSet = engine.retrieve(retrievalQuery) as CandidateSet;
  const hits = candidateSet.candidates
    .map((candidate) => hitFromCandidate(candidate, documents, analysis.channels))
    .filter((hit): hit is PositionalHit => Boolean(hit))
    .filter((hit) =>
      (!pathFilter || matchesPathFilter(hit.document.path, pathFilter)) &&
      matchesTagFilter(hit.document.tags, search.tags)
    );
  const rerankCandidateSet = candidateSetForHits(candidateSet, hits);
  const featurePayloads = engine.featureStore.featuresFor(retrievalQuery, rerankCandidateSet) as readonly CandidateFeaturePayload[];
  const signals = rankSignalsFromFeatures(featurePayloads);
  const rankedAll = rerankCandidatesWithSignals(query, analysis.primaryTerms, hits, search.fields, signals);
  const ranked = rankedAll.slice(0, search.limit);
  const hitByPath = new Map(hits.map((hit) => [hit.document.path, hit]));
  const documentsByRelPath = documentsByPath(documents);
  const matches = ranked.map((rank): SearchMatch => {
    const hit = hitByPath.get(rank.path);
    const record = hit ? documents.get(hit.candidate.documentId) : documentsByRelPath.get(rank.path);
    const document = hit?.document ?? record?.searchDocument;
    const snippets = record ? snippetsForDocument(record, analysis.channels) : [];
    return {
      path: rank.path,
      title: rank.title,
      tags: rank.tags,
      snippets: document ? snippets : [],
      ...(search.debug && hit
        ? {
            debug: matchDebug({
              hit,
              rank,
              snapshotId: snapshot.snapshotId,
              analyzer: analyzerIdentity,
              snippetSource: "snapshot-field-text"
            })
          }
      : {})
    };
  });
  const result = searchResult(matches, snapshot.snapshotId, analyzerIdentity, search, hits.length, analysis.channels) as SearchExecutionResult;
  if (explain) {
    result.explainTrace = explainTrace({
      candidateSet: rerankCandidateSet,
      featurePayloads,
      queryAnalysis: analysis,
      ranked: rankedAll
    });
  }
  return result;
}

function metadataSearch(
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  documents: Map<string, PersistedDocumentRecord>,
  snapshotId: string,
  analyzerIdentity: SearchAnalyzerIdentity
): SearchResult {
  const matches = [...documents.values()]
    .filter((record) =>
      (!pathFilter || matchesPathFilter(record.path, pathFilter)) &&
      matchesTagFilter(record.searchDocument.tags, search.tags)
    )
    .map((record) => ({
      path: record.path,
      title: record.searchDocument.title,
      tags: record.searchDocument.tags,
      snippets: snippetsForDocument(record, emptySearchTokenChannels())
    }))
    .sort(compareTagOnlyMatches)
    .slice(0, search.limit);
  return searchResult(matches, snapshotId, analyzerIdentity, search, matches.length);
}

function stateFromHandle(handle: SearchExecutionSnapshotHandle): SearchExecutionState {
  const metadataState = cachedMetadataStateFromHandle(handle).state;
  const documents = metadataState.documents;
  const documentMetadata = new Map<string, { documentId: string; tags: readonly string[] }>();
  for (const document of documents.values()) {
    documentMetadata.set(document.documentId, {
      documentId: document.documentId,
      tags: document.searchDocument.tags
    });
  }
  const snapshot = buildSearchSnapshotFromSegments({
    snapshotId: handle.snapshotId,
    documents: documentMetadata,
    segments: handle.segments.map((segment) => ({
      segmentId: segment.segmentId,
      bytes: sharedBytes(segment.bytes)
    }))
  });
  return { snapshot, documents };
}

function metadataStateFromHandle(handle: SearchExecutionSnapshotHandle): MetadataExecutionState {
  const records = JSON.parse(textDecoder.decode(sharedBytes(handle.documents))) as PersistedDocumentRecord[];
  return {
    snapshotId: handle.snapshotId,
    documents: new Map(records.map((document) => [document.documentId, document]))
  };
}

function sharedBytes(handle: SharedBytesHandle): Uint8Array {
  return new Uint8Array(handle.buffer, handle.byteOffset, handle.byteLength);
}

function envPositiveInt(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
}

function hitFromCandidate(
  candidate: RetrievalCandidate,
  documents: Map<string, PersistedDocumentRecord>,
  queryChannels: SearchTokenChannelTerms
): PositionalHit | undefined {
  const record = documents.get(candidate.documentId);
  if (!record) return undefined;
  return {
    document: record.searchDocument,
    score: candidate.retrievalScore,
    queryTerms: [...(candidate.channels[0]?.matchedTerms ?? [])],
    queryChannels,
    matchedChannels: [...new Set(candidate.channels.map((channel) => channel.channel))],
    channelScores: Object.fromEntries(candidate.channels.map((channel) => [channel.channel, channel.score])),
    candidate,
    source: "persisted"
  };
}

function createSnapshotFeatureStore(snapshot: SearchSnapshot, documents: ReadonlyMap<string, PersistedDocumentRecord>): FeatureStore {
  return {
    featuresFor: (query, candidateSet) => {
      const allowedFields = query.fields ?? [...SEARCH_PROPERTIES];
      const terms = weightedQueryTerms(query.analysis.channels);
      const documentFrequency = documentFrequencyByTerm(snapshot, terms, allowedFields);
      const rarityWeights = new Map(terms.map((term) => [
        term.id,
        term.weight * rarityWeight(candidateSet.candidates.length, documentFrequency.get(term.id) ?? 0)
      ]));
      const totalRarityWeight = [...rarityWeights.values()].reduce((sum, weight) => sum + weight, 0);
      const rawRarityScores = new Map<string, number>();
      for (const candidate of candidateSet.candidates) {
        const matched = matchedTermIds(snapshot, candidate, terms, allowedFields);
        const matchedRarityWeight = [...matched].reduce((sum, term) => sum + (rarityWeights.get(term) ?? 0), 0);
        rawRarityScores.set(candidate.candidateId, totalRarityWeight > 0 ? matchedRarityWeight / totalRarityWeight : 0);
      }
      const maxRarityScore = Math.max(0, ...rawRarityScores.values());
      return candidateSet.candidates.map((candidate) => {
        const record = documents.get(candidate.documentId);
        const context = featureQueryContext(query);
        const coverage = record ? metadataCoverage(record.searchDocument, context) : { terms: 0, fieldScore: 0 };
        const exactPriority = record ? nullableRankPriority(bestExactPriority(record.searchDocument, context)) : null;
        const phrasePriority = record ? nullableRankPriority(bestPhrasePriority(record.searchDocument, context)) : null;
        const rawRarityScore = rawRarityScores.get(candidate.candidateId) ?? 0;
        return {
          candidate: candidateRef(candidate),
          bm25: bm25Features(snapshot, candidate, allowedFields),
          phrasePositions: candidate.phraseMatches,
          proximity: candidate.proximityMatches,
          rarity: {
            matchedWeightedTerms: rawRarityScore * totalRarityWeight,
            totalWeightedTerms: totalRarityWeight,
            score: maxRarityScore > 0 ? rawRarityScore / maxRarityScore : 0
          },
          coverage: {
            terms: coverage.terms,
            fieldScore: coverage.fieldScore,
            matched: coverageMatches(snapshot, candidate, terms, allowedFields)
          },
          identity: {
            exactPriority,
            phrasePriority,
            canonicalFieldText: canonicalFieldTextPayload(snapshot, candidate.documentId)
          },
          tags: record?.searchDocument.tags ?? [],
          snippetScoringInputs: (record?.snippetLines ?? []).map((line) => ({
            snippetId: line.snippetId,
            line: line.line,
            channels: line.channels,
            byteSpan: {
              start: line.byteStart,
              end: line.byteEnd
            }
          }))
        } satisfies CandidateFeaturePayload;
      });
    },
    canonicalFieldText: (candidate, field) => {
      if (!candidate.documentId) return undefined;
      return snapshot.canonicalFieldText?.get(candidate.documentId)?.[field];
    }
  };
}

function documentFrequencyByTerm(
  snapshot: SearchSnapshot,
  terms: ReadonlyArray<{ id: string; channel: SearchTokenChannel; term: string }>,
  fields: readonly SearchField[]
): Map<string, number> {
  const documentFrequency = new Map(terms.map((term) => [term.id, 0]));
  for (const document of snapshot.documents) {
    for (const term of terms) {
      if (documentHasTerm(snapshot, document.docId, term, fields)) {
        documentFrequency.set(term.id, (documentFrequency.get(term.id) ?? 0) + 1);
      }
    }
  }
  return documentFrequency;
}

function documentHasTerm(
  snapshot: SearchSnapshot,
  docId: number,
  term: { channel: SearchTokenChannel; term: string },
  fields: readonly SearchField[]
): boolean {
  for (const field of fields) {
    const fieldId = POSITIONAL_FIELD_ID[field];
    if (positionsForTerm(snapshot.postingsByChannel[term.channel] ?? new Map(), term.term, docId, fieldId).length > 0) {
      return true;
    }
  }
  return false;
}

function matchedTermIds(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  terms: ReadonlyArray<{ id: string; channel: SearchTokenChannel; term: string }>,
  fields: readonly SearchField[]
): Set<string> {
  const matched = new Set<string>();
  const docId = candidate.ordinalDocId;
  if (typeof docId !== "number") return matched;
  for (const term of terms) {
    if (documentHasTerm(snapshot, docId, term, fields)) matched.add(term.id);
  }
  return matched;
}

function bm25Features(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  fields: readonly SearchField[]
): CandidateFeaturePayload["bm25"] {
  const docId = candidate.ordinalDocId;
  if (typeof docId !== "number") return [];
  const output: CandidateBm25Feature[] = [];
  for (const channelRank of candidate.channels) {
    const stats = snapshot.bm25ByChannel?.[channelRank.channel] ?? snapshot.bm25;
    for (const term of channelRank.matchedTerms) {
      for (const field of fields) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        const frequency = positionsForTerm(snapshot.postingsByChannel[channelRank.channel] ?? new Map(), term, docId, fieldId).length;
        if (frequency <= 0) continue;
        const termStats = bm25TermStats(stats, term, fieldId);
        const fieldStats = stats.fields.get(fieldId);
        output.push({
          channel: channelRank.channel,
          field,
          fieldId,
          term,
          frequency,
          documentFrequency: termStats.documentFrequency,
          documentCount: termStats.documentCount,
          fieldLength: fieldStats?.documentLengths.get(docId) ?? 0,
          averageFieldLength: termStats.averageFieldLength,
          score: bm25TermScore(stats, term, docId, fieldId)
        });
      }
    }
  }
  return output;
}

function coverageMatches(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  terms: ReadonlyArray<{ channel: SearchTokenChannel; term: string; weight: number }>,
  fields: readonly SearchField[]
): CandidateCoverageFeature["matched"] {
  const docId = candidate.ordinalDocId;
  if (typeof docId !== "number") return [];
  const matched: Array<CandidateCoverageFeature["matched"][number]> = [];
  for (const term of terms) {
    for (const field of fields) {
      if (field === "body") continue;
      const fieldId = POSITIONAL_FIELD_ID[field];
      if (positionsForTerm(snapshot.postingsByChannel[term.channel] ?? new Map(), term.term, docId, fieldId).length > 0) {
        matched.push({ channel: term.channel, field, term: term.term, weight: term.weight });
      }
    }
  }
  return matched;
}

function canonicalFieldTextPayload(snapshot: SearchSnapshot, documentId: string): Partial<Record<SearchField, readonly string[]>> {
  return { ...(snapshot.canonicalFieldText?.get(documentId) ?? {}) };
}

function candidateRef(candidate: RetrievalCandidate): CandidateRef {
  return {
    candidateId: candidate.candidateId,
    documentId: candidate.documentId,
    ordinalDocId: candidate.ordinalDocId,
    path: candidate.path
  };
}

function featureQueryContext(query: RetrievalQuery): QueryContext {
  const phrases = uniquePhrases([
    ...identityPhraseCandidates(query.rawQuery),
    ...identityPhraseCandidates(query.analysis.primaryTerms.join(" "))
  ]);
  return {
    phrase: phrases[0] ?? "",
    phrases,
    terms: query.analysis.primaryTerms,
    channels: normalizedQueryChannels(query.analysis.primaryTerms, query.analysis.channels),
    allowed: new Set(query.fields ?? [...SEARCH_PROPERTIES])
  };
}

function normalizedQueryChannels(
  queryTerms: readonly string[],
  queryChannels: SearchTokenChannelTerms | undefined
): SearchTokenChannelTerms {
  const channels = emptySearchTokenChannels();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    channels[channel] = uniqueSearchTerms(queryChannels?.[channel] ?? []);
  }
  if (SEARCH_TOKEN_CHANNELS.some((channel) => channels[channel].length > 0)) return channels;
  channels.morph = uniqueSearchTerms(queryTerms);
  return channels;
}

function uniquePhrases(phrases: readonly string[]): string[] {
  return [...new Set(phrases.filter(Boolean))];
}

function weightedQueryTerms(channels: SearchTokenChannelTerms): Array<{ id: string; channel: SearchTokenChannel; term: string; weight: number }> {
  const terms: Array<{ id: string; channel: SearchTokenChannel; term: string; weight: number }> = [];
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const term of [...new Set(channels[channel])]) {
      if (!term) continue;
      terms.push({
        id: `${channel}:${term}`,
        channel,
        term,
        weight: SEARCH_TOKEN_CHANNEL_WEIGHT[channel]
      });
    }
  }
  return terms;
}

function bestCandidateProximity(candidate: RetrievalCandidate): number {
  let best = 0;
  for (const match of candidate.proximityMatches) {
    best = Math.max(best, match.score * fieldWeight(match.field) * SEARCH_TOKEN_CHANNEL_WEIGHT[match.channel]);
  }
  return best;
}

function bestFeatureProximity(feature: CandidateFeaturePayload): number {
  let best = 0;
  for (const match of feature.proximity) {
    best = Math.max(best, match.score * fieldWeight(match.field) * SEARCH_TOKEN_CHANNEL_WEIGHT[match.channel]);
  }
  return best;
}

function rankSignalsFromFeatures(features: readonly CandidateFeaturePayload[]): Map<string, CandidateRankSignals> {
  const signals = new Map<string, CandidateRankSignals>();
  for (const feature of features) {
    const path = feature.candidate.path;
    if (!path) continue;
    signals.set(path, {
      rarityScore: feature.rarity.score,
      proximityScore: bestFeatureProximity(feature)
    });
  }
  return signals;
}

function candidateSetForHits(candidateSet: CandidateSet, hits: readonly PositionalHit[]): CandidateSet {
  const candidateIds = new Set(hits.map((hit) => hit.candidate.candidateId));
  return {
    ...candidateSet,
    candidates: candidateSet.candidates.filter((candidate) => candidateIds.has(candidate.candidateId))
  };
}

function explainTrace(input: {
  candidateSet: CandidateSet;
  featurePayloads: readonly CandidateFeaturePayload[];
  queryAnalysis: SearchTextAnalysis;
  ranked: readonly RankedCandidate[];
}): ExplainTrace {
  const rankingConfig = rankingConfigTrace();
  const rankedOutput = rankedOutputFromRanked(input.ranked);
  return {
    schemaVersion: SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION,
    rankingAlgorithmId: "rrf-metadata-v1",
    frozenReplayFormulaVersion: "rrf-metadata-v1/offline-1",
    rankingConfig,
    inputs: {
      candidateSet: input.candidateSet,
      featurePayloads: input.featurePayloads,
      queryAnalysis: input.queryAnalysis,
      rankingConfig
    },
    expectedOutputHash: hashRankedOutput(rankedOutput)
  };
}

function rankedOutputFromRanked(ranked: readonly RankedCandidate[]) {
  return ranked.map((candidate) => ({
    path: candidate.path,
    bucket: rankBucketName(candidate.bucket),
    score: candidate.score,
    baseRank: candidate.baseRank,
    exactPriority: nullableRankPriority(candidate.exactPriority),
    phrasePriority: nullableRankPriority(candidate.phrasePriority),
    coverageTerms: candidate.coverageTerms,
    coverageFieldScore: candidate.coverageFieldScore,
    rarityScore: candidate.rarityScore,
    proximityScore: candidate.proximityScore
  }));
}

function rankingConfigTrace() {
  return {
    rrfK: RRF_K,
    weights: RRF_WEIGHTS,
    signalWeights: RANK_SIGNAL_WEIGHTS,
    constants: RANKING_CONSTANTS
  };
}

function hashRankedOutput(rankedOutput: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(rankedOutput)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fieldWeight(field: SearchField): number {
  return SEARCH_BOOST[field] / SEARCH_BOOST.title;
}

function rarityWeight(documentCount: number, frequency: number): number {
  if (frequency <= 0) return 0;
  return Math.log1p(documentCount / frequency);
}

function rawSearchLimit(documentCount: number, search: NormalizedSearchParams): number {
  return search.query
    ? Math.min(documentCount, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : search.path || search.tags
      ? documentCount
      : search.limit;
}

function positionalCandidateLimit(
  documentCount: number,
  search: NormalizedSearchParams,
  channels: SearchTokenChannelTerms
): number {
  const perChannelLimit = rawSearchLimit(documentCount, search);
  if (!search.query) return perChannelLimit;
  const channelCount = SEARCH_TOKEN_CHANNELS.filter((channel) => channels[channel].length > 0).length || 1;
  return Math.min(documentCount, perChannelLimit * channelCount);
}

function snippetsForDocument(record: PersistedDocumentRecord, queryChannels: SearchTokenChannelTerms) {
  const storedSnippetLines = record.snippetLines ?? [];
  const lines = storedSnippetLines.length > 0
    ? storedSnippetLines
    : record.lineSnippets.map((line): SnapshotSnippetLine => ({
        ...line,
        snippetId: `${record.documentId}:${line.line}`,
        segmentId: "",
        documentId: record.documentId,
        byteStart: 0,
        byteEnd: 0,
        channels: emptySearchTokenChannels()
      }));
  const bodyStart = bodyStartLine(lines);
  const candidates = lines.filter((line) => line.line > bodyStart && line.text.trim().length > 0);
  const scored = candidates
    .map((line) => ({ line, score: snippetScore(line, queryChannels) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.line.line - right.line.line);
  if (scored.length > 0) return uniqueSnippets(scored.map((entry) => entry.line)).slice(0, 3);
  const heading = candidates.find((line) => /^#{1,6}\s+/.test(line.text));
  if (heading) return [heading];
  const first = candidates[0];
  if (first) return [first];
  return record.searchDocument.title ? [{ line: 1, text: record.searchDocument.title }] : [];
}

function snippetScore(line: SnapshotSnippetLine, queryChannels: SearchTokenChannelTerms): number {
  let score = 0;
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const lineTerms = new Set(line.channels[channel]);
    for (const term of queryChannels[channel]) {
      if (lineTerms.has(term)) score += SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
    }
  }
  return score;
}

function bodyStartLine(lines: readonly { line: number; text: string }[]): number {
  if (lines[0]?.text.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].text.trim();
    if (trimmed === "---" || trimmed === "...") return lines[index].line;
  }
  return 0;
}

function uniqueSnippets<T extends { line: number }>(snippets: readonly T[]): T[] {
  const seen = new Set<number>();
  const output: T[] = [];
  for (const snippet of snippets) {
    if (seen.has(snippet.line)) continue;
    seen.add(snippet.line);
    output.push(snippet);
  }
  return output;
}

function searchResult(
  matches: SearchMatch[],
  snapshotId: string,
  analyzer: SearchAnalyzerIdentity,
  search: NormalizedSearchParams,
  candidates: number,
  channels: SearchTokenChannelTerms = emptySearchTokenChannels()
): SearchResult {
  return {
    ok: true,
    command: "search",
    matches,
    ...(search.debug
      ? {
          debug: {
            ...(search.query
              ? {
                  query: {
                    raw: search.query,
                    terms: channels.morph.length > 0 ? channels.morph : channels.surface,
                    primaryChannel: channels.morph.length > 0 ? "morph" : channels.surface.length > 0 ? "surface" : "ngram",
                    channels: Object.fromEntries(Object.entries(channels).filter(([, terms]) => terms.length > 0))
                  }
                }
              : {}),
            projection: {
              source: matches.length > 0 ? "persisted" : "none",
              tokenizerTier: (analyzer.activeAnalyzers ?? []).includes("ko") ? "kiwi" : "intl",
              documents: candidates,
              files: candidates
            },
            analyzer: analyzerDebugInfo(analyzer),
            candidates,
            snapshotId,
            ...(search.query ? { reranker: "rrf-metadata-v1" as const } : {})
          }
        }
      : {})
  };
}

function matchDebug(input: {
  hit: PositionalHit;
  rank: ReturnType<typeof rerankCandidatesWithSignals>[number];
  snapshotId: string;
  analyzer: SearchAnalyzerIdentity;
  snippetSource: "snapshot-field-text";
}): NonNullable<SearchMatch["debug"]> {
  return {
    source: input.hit.source,
    queryTerms: input.hit.queryTerms,
    queryChannels: Object.fromEntries(Object.entries(input.hit.queryChannels).filter(([, terms]) => terms.length > 0)),
    matchedChannels: input.hit.matchedChannels,
    channelScores: Object.fromEntries(Object.entries(input.hit.channelScores).filter(([, score]) => score !== undefined)),
    analyzer: analyzerDebugInfo(input.analyzer),
    candidateScore: input.hit.score,
    retrievalScore: input.hit.candidate.retrievalScore,
    rerankScore: input.rank.score,
    baseRank: input.rank.baseRank,
    bucket: rankBucketName(input.rank.bucket),
    exactPriority: nullableRankPriority(input.rank.exactPriority),
    phrasePriority: nullableRankPriority(input.rank.phrasePriority),
    coverageTerms: input.rank.coverageTerms,
    coverageFieldScore: input.rank.coverageFieldScore,
    rarityScore: input.rank.rarityScore,
    proximityScore: input.rank.proximityScore,
    snippetSource: input.snippetSource,
    snapshotId: input.snapshotId
  };
}

function analyzerDebugInfo(identity: SearchAnalyzerIdentity) {
  return {
    name: identity.name,
    version: identity.version,
    ...(identity.runtime ? { runtime: identity.runtime } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.declaredAnalyzers ? { declaredAnalyzers: [...identity.declaredAnalyzers] } : {}),
    ...(identity.activeAnalyzers ? { activeAnalyzers: [...identity.activeAnalyzers] } : {})
  };
}

function documentsByPath(documents: Map<string, PersistedDocumentRecord>): Map<string, PersistedDocumentRecord> {
  return new Map([...documents.values()].map((record) => [record.path, record]));
}
