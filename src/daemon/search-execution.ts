import { SEARCH_TOKEN_CHANNELS, emptySearchTokenChannels, type SearchTextAnalysis, type SearchTokenChannel, type SearchTokenChannelTerms } from "../core/search/analysis/index.js";
import { uniqueSearchTerms } from "../core/search/analysis/channels.js";
import type {
  CandidateCoverageFeature,
  CandidateBm25Feature,
  CandidateFeaturePayload,
  CandidateRef,
  CandidateSet,
  FeatureStore,
  RetrievalCandidate,
  RetrievalQuery
} from "../core/search/contracts.js";
import { CANDIDATE_LIMIT_MIN, CANDIDATE_LIMIT_MULTIPLIER, COVERAGE_FIELD_WEIGHT, EXACT_PRIORITY, PHRASE_PRIORITY, SEARCH_TOKEN_CHANNEL_WEIGHT, WEAK_METADATA_COVERAGE_TERMS, type SearchScoringLambdas } from "../core/search/constants.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import {
  bm25TermScoreFromStatsLookup,
  createPositionalBm25StatsLookup,
  createQueryPostingsLookup,
  createSearchFieldLengthLookup,
  createSearchEngine,
  createPositionalRetriever,
  POSITIONAL_FIELD_ID,
  type PositionalBm25StatsLookup,
  type QueryPostingsLookup,
  type SearchFieldLengthLookup,
  type SearchSnapshot,
  type SearchSnapshotSegment
} from "../core/search/retrieval/positional/index.js";
import {
  denseAgreementFromCosine
} from "../core/search/dense/index.js";
import { createLinkAdjacencyRetriever } from "../core/search/retrieval/link.js";
import { fuseCandidateSets } from "../core/search/retrieval/fusion.js";
import { identityPhraseCandidates } from "../core/search/ranking/identity.js";
import { compareCanonicalBm25Terms, compareTagOnlyMatches, identityScoreFromExactPriority, nullableRankPriority, rerankCandidatesWithSignals, type CandidateRankSignals, type ExactDominanceBound, type RankDocument } from "../core/search/ranking/index.js";
import { matchesPathFilter, matchesTagFilter } from "../core/search/params.js";
import { SEARCH_FIELD_CHANNEL_BOOST } from "../core/search/schema.js";
import { SEARCH_PROPERTIES } from "../core/search/schema.js";
import type { NormalizedSearchParams, PathFilter, QueryContext, RankedCandidate } from "../core/search/internal-types.js";
import type { SearchField, SearchMatch, SearchResult } from "../core/types.js";
import { compareRankedHitEntries, type RankedHitEntry } from "./search-store/finalist-order.js";
import {
  cachedSearchExecutionStateFromHandle,
  exactDominanceBoundForSearchSnapshot,
  searchExecutionStateFromShardHandle
} from "./search-store/search-execution-state.js";
import {
  documentsFromHandle,
  explainTrace,
  matchDebug,
  searchResult,
  snippetsForDocument,
  type SearchExecutionResult,
  type SearchExecutionSnapshotHandle,
  type SearchHitEvidence,
  type SearchShardFinalist
} from "./search-store/result-shaping.js";
import type { PersistedDocumentRecord, RetrievalEmbeddingSetEnvelope } from "./search-store/types.js";

export type {
  SearchExecutionResult,
  SearchExecutionSnapshotHandle,
  SearchHitEvidence,
  SearchShardFinalist,
  SharedBytesHandle
} from "./search-store/result-shaping.js";
export {
  exactDominanceBoundForSearchHandle,
  preloadSearchExecutionSnapshot,
  searchExecutionCacheStats,
  type SearchExecutionCacheStats,
  type SearchExecutionPreloadResult,
  type SearchExecutionWarmResult,
  warmSearchExecutionSnapshot
} from "./search-store/search-execution-state.js";

export type SearchExecutionJob = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis?: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  denseEmbeddingSet?: RetrievalEmbeddingSetEnvelope;
  queryVector?: readonly number[];
  denseSearchResults?: readonly DenseVectorSearchHit[];
  denseLiveContentHashes?: ReadonlyMap<string, string>;
  sourceDocumentId?: string;
  sourcePath?: string;
  excludeDocumentIds?: readonly string[];
  rrfK?: number;
  scoringLambdas?: Partial<SearchScoringLambdas>;
  explain?: boolean;
};

export type SearchShardExecutionJob = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  denseEmbeddingSet?: RetrievalEmbeddingSetEnvelope;
  queryVector?: readonly number[];
  denseSearchResults?: readonly DenseVectorSearchHit[];
  denseLiveContentHashes?: ReadonlyMap<string, string>;
  sourceDocumentId?: string;
  sourcePath?: string;
  excludeDocumentIds?: readonly string[];
  rrfK?: number;
  scoringLambdas?: Partial<SearchScoringLambdas>;
  channels?: readonly SearchTokenChannel[];
  exactBound: ExactDominanceBound;
  requestedLimit: number;
  workEstimate: number;
  deadline: number;
  cancellationId: string;
  explain?: boolean;
};

const WEAK_METADATA_COVERAGE_TERM_SET = new Set<string>(WEAK_METADATA_COVERAGE_TERMS);

type PositionalHit = {
  document: RankDocument;
  score: number;
  queryTerms: string[];
  queryChannels: SearchTokenChannelTerms;
  matchedChannels: SearchTokenChannel[];
  channelScores: Partial<Record<SearchTokenChannel, number>>;
  candidate: RetrievalCandidate;
  source: "persisted";
};

type SearchExecutionLookupContext = {
  segmentByKey: ReadonlyMap<string, SearchSnapshotSegment>;
  bm25StatsLookup: PositionalBm25StatsLookup;
  fieldLengthLookup: SearchFieldLengthLookup;
  positionsLookup: CandidateTermPositionsLookup;
};

type RetrievalExecutionContext = {
  denseEmbeddingSet?: RetrievalEmbeddingSetEnvelope;
  queryVector?: readonly number[];
  denseSearchResults?: readonly DenseVectorSearchHit[];
  denseLiveContentHashes?: ReadonlyMap<string, string>;
  sourceDocumentId?: string;
  sourcePath?: string;
  excludeDocumentIds?: readonly string[];
  rrfK?: number;
  scoringLambdas?: Partial<SearchScoringLambdas>;
};

export type DenseVectorSearchHit = {
  chunkId: string;
  entryId: string;
  similarity: number;
};

type CandidateTermPositionsLookup = (
  segment: SearchSnapshotSegment,
  localDocId: number,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number,
  postingsLookup?: QueryPostingsLookup
) => readonly number[];

const EMPTY_SEARCH_POSITIONS: readonly number[] = [];
type CandidateTermPositionsIndex = ReadonlyMap<string, readonly number[]>;

export type SearchShardExecutionResult = {
  snapshotId: string;
  partitionIds: number[];
  requestedLimit: number;
  workEstimate: number;
  scoredCount: number;
  finalists: SearchShardFinalist[];
  explain?: {
    candidateSet: CandidateSet;
    exactBound: ExactDominanceBound;
  };
};

export function executeSearchJob(job: SearchExecutionJob): SearchExecutionResult {
  if (!job.search.query || !job.analysis) {
    const documents = documentsFromHandle(job.snapshot);
    return metadataSearch(job.search, job.pathFilter, documents, job.snapshot.snapshotId, job.analyzerIdentity, job.excludeDocumentIds);
  }
  const state = cachedSearchExecutionStateFromHandle(job.snapshot).state;
  const documents = documentsFromHandle(job.snapshot);
  return querySearch(job.search, job.pathFilter, state.snapshot, documents, job.analysis, job.analyzerIdentity, job.explain === true, {
    denseEmbeddingSet: job.denseEmbeddingSet,
    queryVector: job.queryVector,
    denseSearchResults: job.denseSearchResults,
    denseLiveContentHashes: job.denseLiveContentHashes,
    sourceDocumentId: job.sourceDocumentId,
    sourcePath: job.sourcePath,
    excludeDocumentIds: job.excludeDocumentIds,
    rrfK: job.rrfK,
    scoringLambdas: job.scoringLambdas
  });
}

export function executeSearchShardJob(job: SearchShardExecutionJob): SearchShardExecutionResult {
  assertSearchShardDeadline(job);
  if (!job.search.query || job.analysis.primaryTerms.length === 0) {
    return {
      snapshotId: job.snapshot.snapshotId,
      partitionIds: sortedPartitionIds(job.snapshot),
      requestedLimit: job.requestedLimit,
      workEstimate: job.workEstimate,
      scoredCount: 0,
      finalists: []
    };
  }
  const state = searchExecutionStateFromShardHandle(job.snapshot);
  const result = querySearchShard(job, state.snapshot);
  assertSearchShardDeadline(job);
  return result;
}

function querySearch(
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  snapshot: SearchSnapshot,
  documents: Map<string, PersistedDocumentRecord>,
  analysis: SearchTextAnalysis,
  analyzerIdentity: SearchAnalyzerIdentity,
  explain: boolean,
  retrieval: RetrievalExecutionContext = {}
): SearchExecutionResult {
  const query = search.query ?? "";
  if (analysis.primaryTerms.length === 0) return searchResult([], snapshot.snapshotId, analyzerIdentity, search, 0);
  const postingsLookup = createQueryPostingsLookup();
  const lookupContext = createSearchExecutionLookupContext(snapshot);
  const lexicalRetriever = createPositionalRetriever(snapshot, postingsLookup, lookupContext.bm25StatsLookup);
  const engine = createSearchEngine(
    snapshot,
    lexicalRetriever,
    createSnapshotFeatureStore(snapshot, postingsLookup, lookupContext)
  );
  const retrievalQuery: RetrievalQuery = {
    rawQuery: query,
    analysis,
    fields: search.fields,
    tags: search.tags,
    limit: exhaustiveCandidateLimit(snapshot.documentCount, search, analysis.channels),
    snapshotId: snapshot.snapshotId,
    sourceDocumentId: retrieval.sourceDocumentId,
    sourcePath: retrieval.sourcePath,
    queryVector: retrieval.queryVector
  };
  const candidateSet = retrieveCandidateSet({
    lexicalRetriever,
    lexicalSet: engine.retrieve(retrievalQuery) as CandidateSet,
    retrievalQuery,
    snapshot,
    retrieval
  });
  const hits = candidateSet.candidates
    .map((candidate) => hitFromCandidate(candidate, documents, analysis.channels))
    .filter((hit): hit is PositionalHit => Boolean(hit))
    .filter((hit) =>
      !retrieval.excludeDocumentIds?.includes(hit.candidate.documentId) &&
      (!pathFilter || matchesPathFilter(hit.candidate.path ?? hit.document.path, pathFilter)) &&
      matchesTagFilter(candidateTags(snapshot, hit.candidate, lookupContext), search.tags)
    );
  const rerankCandidateSet = candidateSetForHits(candidateSet, hits);
  const featurePayloads = engine.featureStore.featuresFor(retrievalQuery, rerankCandidateSet) as readonly CandidateFeaturePayload[];
  const exactBound = exactDominanceBoundForSearchSnapshot({ snapshot, analysis, search });
  const signals = rankSignalsFromFeatures(featurePayloads, exactBound.lambdaExact);
  const rankedHits = deterministicRankedHits(
    hits,
    rerankCandidatesWithSignals(query, analysis.primaryTerms, hits, search.fields, signals, {
      lambdas: retrieval.scoringLambdas
    })
  );
  const rankedAll = rankedHits.map((entry) => entry.rank);
  const ranked = rankedHits.slice(0, search.limit);
  const matches = ranked.map(({ hit, rank }): SearchMatch => {
    const record = documents.get(hit.candidate.documentId);
    const snippets = record ? snippetsForDocument(record, analysis.channels) : [];
    return {
      path: rank.path,
      title: rank.title,
      tags: rank.tags,
      snippets: record ? snippets : [],
      ...(search.debug
        ? {
            debug: matchDebug({
              hit,
              rank,
              snapshotId: snapshot.snapshotId,
              analyzer: analyzerIdentity
            })
          }
      : {})
    };
  });
  const result: SearchExecutionResult = searchResult(matches, snapshot.snapshotId, analyzerIdentity, search, hits.length, analysis.channels);
  if (explain) {
    result.explainTrace = explainTrace({
      candidateSet: rerankCandidateSet,
      exactBound,
      featurePayloads,
      queryAnalysis: analysis,
      ranked: rankedAll
    });
  }
  return result;
}

export function executeMetadataSearchFromSnapshotHandle(input: {
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  snapshot: SearchExecutionSnapshotHandle;
  analyzerIdentity: SearchAnalyzerIdentity;
  documents?: ReadonlyMap<string, PersistedDocumentRecord>;
  excludeDocumentIds?: readonly string[];
}): SearchExecutionResult {
  const documents = input.documents ?? documentsFromHandle(input.snapshot);
  return metadataSearch(input.search, input.pathFilter, documents, input.snapshot.snapshotId, input.analyzerIdentity, input.excludeDocumentIds);
}

function querySearchShard(job: SearchShardExecutionJob, snapshot: SearchSnapshot): SearchShardExecutionResult {
  const search = job.search;
  const query = search.query ?? "";
  const postingsLookup = createQueryPostingsLookup();
  const lookupContext = createSearchExecutionLookupContext(snapshot);
  const lexicalRetriever = createPositionalRetriever(snapshot, postingsLookup, lookupContext.bm25StatsLookup);
  const engine = createSearchEngine(
    snapshot,
    lexicalRetriever,
    createSnapshotFeatureStore(snapshot, postingsLookup, lookupContext)
  );
  const retrievalQuery: RetrievalQuery = {
    rawQuery: query,
    analysis: job.analysis,
    fields: search.fields,
    tags: search.tags,
    limit: exhaustiveCandidateLimit(snapshot.documentCount, search, job.analysis.channels),
    channels: job.channels,
    snapshotId: snapshot.snapshotId,
    sourceDocumentId: job.sourceDocumentId,
    sourcePath: job.sourcePath,
    queryVector: job.queryVector
  };
  const candidateSet = retrieveCandidateSet({
    lexicalRetriever,
    lexicalSet: engine.retrieve(retrievalQuery) as CandidateSet,
    retrievalQuery,
    snapshot,
    retrieval: {
      denseEmbeddingSet: job.denseEmbeddingSet,
      queryVector: job.queryVector,
      denseSearchResults: job.denseSearchResults,
      denseLiveContentHashes: job.denseLiveContentHashes,
      sourceDocumentId: job.sourceDocumentId,
      sourcePath: job.sourcePath,
      excludeDocumentIds: job.excludeDocumentIds,
      rrfK: job.rrfK,
      scoringLambdas: job.scoringLambdas
    }
  });
  assertSearchShardDeadline(job);
  const hits = candidateSet.candidates
    .map((candidate) => shardHitFromCandidate(snapshot, candidate, job.analysis.channels, lookupContext))
    .filter((hit): hit is SearchHitEvidence => Boolean(hit))
    .filter((hit) =>
      !job.excludeDocumentIds?.includes(hit.candidate.documentId) &&
      (!job.pathFilter || matchesPathFilter(hit.candidate.path ?? hit.path, job.pathFilter)) &&
      matchesTagFilter(candidateTags(snapshot, hit.candidate, lookupContext), search.tags)
    );
  const rerankCandidateSet = candidateSetForHits(candidateSet, hits);
  const featurePayloads = engine.featureStore.featuresFor(retrievalQuery, rerankCandidateSet) as readonly CandidateFeaturePayload[];
  const exactBound = job.exactBound;
  const signals = rankSignalsFromFeatures(featurePayloads, exactBound.lambdaExact);
  const rankHits = deterministicRankedHits(
    hits,
    rerankCandidatesWithSignals(query, job.analysis.primaryTerms, minimalRankDocuments(hits), search.fields, signals, {
      lambdas: job.scoringLambdas
    })
  );
  const featureByCandidateId = new Map(featurePayloads.map((feature) => [feature.candidate.candidateId, feature]));
  const finalists = rankHits.map(({ hit, rank }): SearchShardFinalist => {
    const feature = featureByCandidateId.get(hit.candidate.candidateId);
    if (!feature) throw new Error(`missing feature payload for candidate ${hit.candidate.candidateId}`);
    return {
      ...hit,
      documentId: hit.candidate.documentId,
      path: hit.path,
      shardDocRef: hit.candidate.shardDocRef,
      rank,
      feature
    };
  });
  return {
    snapshotId: snapshot.snapshotId,
    partitionIds: sortedPartitionIds(job.snapshot),
    requestedLimit: job.requestedLimit,
    workEstimate: job.workEstimate,
    scoredCount: hits.length,
    finalists,
    ...(job.explain
      ? {
          explain: {
            candidateSet: rerankCandidateSet,
            exactBound: job.exactBound
          }
        }
      : {})
  };
}

function retrieveCandidateSet(input: {
  lexicalRetriever: ReturnType<typeof createPositionalRetriever>;
  lexicalSet: CandidateSet;
  retrievalQuery: RetrievalQuery;
  snapshot: SearchSnapshot;
  retrieval: RetrievalExecutionContext;
}): CandidateSet {
  const sets = [{
    identity: input.lexicalRetriever.retrieverIdentity,
    set: input.lexicalSet
  }];
  const dense = denseCandidateSet(input.snapshot, input.retrievalQuery, input.retrieval);
  if (dense) sets.push({ identity: dense.retrieverIdentity, set: dense });
  const link = linkCandidateSet(input.snapshot, input.retrievalQuery, input.retrieval);
  if (link) sets.push({ identity: link.retrieverIdentity, set: link });
  if (sets.length === 1) return input.lexicalSet;
  return fuseCandidateSets(sets, input.retrievalQuery, {
    limit: input.retrievalQuery.limit,
    k: input.retrieval.rrfK
  });
}

function denseCandidateSet(
  snapshot: SearchSnapshot,
  query: RetrievalQuery,
  retrieval: RetrievalExecutionContext
): CandidateSet | undefined {
  if (!retrieval.denseEmbeddingSet || !retrieval.queryVector) return undefined;
  if (!retrieval.denseSearchResults) return undefined;
  const refs = documentRefIndex(snapshot);
  const records = new Map(retrieval.denseEmbeddingSet.records.map((record) => [record.documentId, record]));
  const candidates: RetrievalCandidate[] = [];
  for (const result of retrieval.denseSearchResults) {
    const record = records.get(result.entryId);
    if (!record) continue;
    const liveHash = retrieval.denseLiveContentHashes?.get(record.documentId);
    if (retrieval.denseLiveContentHashes && liveHash !== record.contentHash) continue;
    const ref = refs.get(record.documentId);
    if (!ref) continue;
    const denseAgreement = denseAgreementFromCosine(result.similarity);
    candidates.push({
      candidateId: record.documentId,
      documentId: record.documentId,
      shardDocRef: ref,
      path: record.path,
      rank: 0,
      retrievalScore: denseAgreement,
      denseAgreement,
      channels: [],
      phraseMatches: [],
      proximityMatches: []
    });
  }
  const ranked = candidates
    .filter((candidate) => !retrieval.excludeDocumentIds?.includes(candidate.documentId))
    .sort((left, right) => right.retrievalScore - left.retrievalScore || (left.path ?? "").localeCompare(right.path ?? ""));
  const retrieverIdentity = {
    id: "dense",
    version: "1",
    parameters: {
      model: retrieval.denseEmbeddingSet.model,
      metric: "cosine"
    }
  };
  return {
    schemaVersion: 1,
    snapshotId: query.snapshotId ?? snapshot.snapshotId,
    retrieverIdentity,
    complete: true,
    candidates: ranked.slice(0, query.limit ?? ranked.length).map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }))
  };
}

function linkCandidateSet(
  snapshot: SearchSnapshot,
  query: RetrievalQuery,
  retrieval: RetrievalExecutionContext
): CandidateSet | undefined {
  if (!retrieval.sourceDocumentId && !retrieval.sourcePath) return undefined;
  const retriever = createLinkAdjacencyRetriever({ snapshot, limit: query.limit });
  return retriever.retrieve({
    ...query,
    sourceDocumentId: retrieval.sourceDocumentId,
    sourcePath: retrieval.sourcePath
  }) as CandidateSet;
}

function documentRefIndex(snapshot: SearchSnapshot): ReadonlyMap<string, RetrievalCandidate["shardDocRef"]> {
  const refs = new Map<string, RetrievalCandidate["shardDocRef"]>();
  for (const segment of snapshot.segments) {
    for (let localDocId = 1; localDocId <= segment.projection.documentCount(); localDocId += 1) {
      const doc = segment.projection.doc(localDocId);
      refs.set(doc.documentId, {
        segmentId: segment.segmentId,
        partitionId: segment.partitionId,
        localDocId: doc.localDocId,
        documentId: doc.documentId
      });
    }
  }
  return refs;
}

function metadataSearch(
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  documents: ReadonlyMap<string, PersistedDocumentRecord>,
  snapshotId: string,
  analyzerIdentity: SearchAnalyzerIdentity,
  excludeDocumentIds: readonly string[] = []
): SearchResult & { snapshotId: string } {
  const excluded = new Set(excludeDocumentIds);
  const matches = [...documents.values()]
    .filter((record) =>
      !excluded.has(record.documentId) &&
      (!pathFilter || matchesPathFilter(record.path, pathFilter)) &&
      matchesTagFilter(record.tags, search.tags)
    )
    .map((record) => ({
      path: record.path,
      title: record.title,
      tags: record.tags,
      snippets: snippetsForDocument(record, emptySearchTokenChannels())
    }))
    .sort(compareTagOnlyMatches)
    .slice(0, search.limit);
  return searchResult(matches, snapshotId, analyzerIdentity, search, matches.length);
}

function sortedPartitionIds(handle: SearchExecutionSnapshotHandle): number[] {
  return [...new Set(handle.segments.map((segment) => segment.partitionId))].sort((left, right) => left - right);
}

function assertSearchShardDeadline(job: SearchShardExecutionJob): void {
  if (Date.now() >= job.deadline) {
    throw Object.assign(new Error(`search shard ${sortedPartitionIds(job.snapshot).join(",")} deadline expired`), { code: "DEADLINE_EXCEEDED" });
  }
}

function hitFromCandidate(
  candidate: RetrievalCandidate,
  documents: Map<string, PersistedDocumentRecord>,
  queryChannels: SearchTokenChannelTerms
): PositionalHit | undefined {
  const record = documents.get(candidate.documentId);
  if (!record) return undefined;
  return {
    document: rankDocumentFromRecord(record),
    score: candidate.retrievalScore,
    queryTerms: [...(candidate.channels[0]?.matchedTerms ?? [])],
    queryChannels,
    matchedChannels: [...new Set(candidate.channels.map((channel) => channel.channel))],
    channelScores: Object.fromEntries(candidate.channels.map((channel) => [channel.channel, channel.score])),
    candidate,
    source: "persisted"
  };
}

function shardHitFromCandidate(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  queryChannels: SearchTokenChannelTerms,
  lookupContext?: SearchExecutionLookupContext
): SearchHitEvidence | undefined {
  const segment = segmentForCandidate(snapshot, candidate, lookupContext);
  const document = segment.projection.doc(candidate.shardDocRef.localDocId);
  return {
    documentId: candidate.documentId,
    path: candidate.path ?? document.path,
    shardDocRef: candidate.shardDocRef,
    score: candidate.retrievalScore,
    queryTerms: [...(candidate.channels[0]?.matchedTerms ?? [])],
    queryChannels,
    matchedChannels: [...new Set(candidate.channels.map((channel) => channel.channel))],
    channelScores: Object.fromEntries(candidate.channels.map((channel) => [channel.channel, channel.score])),
    candidate: {
      ...candidate,
      path: candidate.path ?? document.path
    },
    source: "persisted"
  };
}

function minimalRankDocuments(hits: readonly SearchHitEvidence[]): Array<{ document: RankDocument; score: number; queryChannels: SearchTokenChannelTerms }> {
  return hits.map((hit) => ({
    document: minimalRankDocument(hit.documentId, hit.path),
    score: hit.score,
    queryChannels: hit.queryChannels
  }));
}

function minimalRankDocument(documentId: string, relPath: string): RankDocument {
  const basename = relPath.split(/[\\/]/u).pop()?.replace(/\.[^.]+$/u, "");
  const title = basename ? basename : relPath;
  return {
    id: documentId,
    path: relPath,
    title,
    tags: []
  };
}

function rankDocumentFromRecord(record: PersistedDocumentRecord): RankDocument {
  return {
    id: record.documentId,
    path: record.path,
    title: record.title,
    tags: record.tags
  };
}

function createSearchExecutionLookupContext(snapshot: SearchSnapshot): SearchExecutionLookupContext {
  return {
    segmentByKey: new Map(snapshot.segments.map((segment) => [searchSegmentKey(segment), segment])),
    bm25StatsLookup: createPositionalBm25StatsLookup(snapshot.bm25Stats),
    fieldLengthLookup: createSearchFieldLengthLookup(),
    positionsLookup: createCandidateTermPositionsLookup()
  };
}

function createSnapshotFeatureStore(
  snapshot: SearchSnapshot,
  sharedPostingsLookup?: QueryPostingsLookup,
  lookupContext = createSearchExecutionLookupContext(snapshot)
): FeatureStore {
  return {
    featuresFor: (query, candidateSet) => {
      const allowedFields = query.fields ?? [...SEARCH_PROPERTIES];
      const terms = weightedQueryTerms(query.analysis.channels);
      const context = featureQueryContext(query);
      const postingsLookup = sharedPostingsLookup ?? createQueryPostingsLookup();
      return candidateSet.candidates.map((candidate) => {
        const coverage = projectionCoverage(snapshot, candidate, context, postingsLookup, lookupContext);
        const exactPriority = nullableRankPriority(projectionExactPriority(snapshot, candidate, context, lookupContext));
        const phrasePriority = nullableRankPriority(projectionPhrasePriority(snapshot, candidate, context, lookupContext));
        const payload = {
          candidate: candidateRef(candidate),
          ...(candidate.retrieverSignals ? { retrieverSignals: candidate.retrieverSignals } : {}),
          ...(candidate.denseAgreement === undefined ? {} : { denseAgreement: candidate.denseAgreement }),
          ...(candidate.linkAgreement === undefined ? {} : { linkAgreement: candidate.linkAgreement }),
          ...(candidate.rrfScore === undefined ? {} : { rrfScore: candidate.rrfScore }),
          bm25: bm25Features(snapshot, candidate, allowedFields, postingsLookup, lookupContext),
          phrasePositions: candidate.phraseMatches,
          proximity: candidate.proximityMatches,
          rarity: {
            matchedWeightedTerms: 0,
            totalWeightedTerms: 0,
            score: 0
          },
          coverage: {
            terms: coverage.terms,
            fieldScore: coverage.fieldScore,
            matched: coverageMatches(snapshot, candidate, terms, allowedFields, postingsLookup, lookupContext)
          },
          identity: {
            exactPriority,
            phrasePriority
          },
          tags: candidateTags(snapshot, candidate, lookupContext)
        } satisfies CandidateFeaturePayload;
        assertRetrieverSignalsMaterialized(candidate, payload);
        return payload;
      });
    },
  };
}

function assertRetrieverSignalsMaterialized(candidate: RetrievalCandidate, feature: CandidateFeaturePayload): void {
  assertOptionalNumberEqual(candidate.denseAgreement, feature.denseAgreement, candidate.candidateId, "denseAgreement");
  assertOptionalNumberEqual(candidate.linkAgreement, feature.linkAgreement, candidate.candidateId, "linkAgreement");
  assertOptionalNumberEqual(candidate.rrfScore, feature.rrfScore, candidate.candidateId, "rrfScore");
  const candidateSignals = candidate.retrieverSignals;
  if (!candidateSignals) return;
  if (!feature.retrieverSignals) throw new Error(`retriever signals were dropped for candidate ${candidate.candidateId}`);
  if ((candidateSignals.dense && !feature.retrieverSignals.dense) || (candidateSignals.link && !feature.retrieverSignals.link)) {
    throw new Error(`typed retriever signals were dropped for candidate ${candidate.candidateId}`);
  }
  if (candidateSignals.all.length !== feature.retrieverSignals.all.length) {
    throw new Error(`retriever signal count changed for candidate ${candidate.candidateId}`);
  }
}

function assertOptionalNumberEqual(
  expected: number | undefined,
  actual: number | undefined,
  candidateId: string,
  label: string
): void {
  if (expected === undefined) return;
  if (actual !== expected) throw new Error(`${label} was not materialized for candidate ${candidateId}`);
}

function bm25Features(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  fields: readonly SearchField[],
  postingsLookup: QueryPostingsLookup,
  lookupContext: SearchExecutionLookupContext
): CandidateFeaturePayload["bm25"] {
  const output: CandidateBm25Feature[] = [];
  for (const channelRank of candidate.channels) {
    for (const term of channelRank.matchedTerms) {
      for (const field of fields) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        const frequency = positionsForCandidateTerm(snapshot, candidate, channelRank.channel, term, fieldId, postingsLookup, lookupContext).length;
        if (frequency <= 0) continue;
        const corpus = lookupContext.bm25StatsLookup.corpusStats(channelRank.channel, fieldId);
        const fieldLength = candidateFieldLength(snapshot, candidate, channelRank.channel, fieldId, lookupContext);
        const documentFrequency = lookupContext.bm25StatsLookup.documentFrequency(channelRank.channel, term, fieldId);
        output.push({
          channel: channelRank.channel,
          field,
          fieldId,
          term,
          frequency,
          documentFrequency,
          documentCount: corpus?.documentCount ?? 0,
          fieldLength,
          averageFieldLength: corpus?.averageFieldLength ?? 0,
          score: bm25TermScoreFromStatsLookup(lookupContext.bm25StatsLookup, channelRank.channel, term, fieldId, frequency, fieldLength)
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
  fields: readonly SearchField[],
  postingsLookup: QueryPostingsLookup,
  lookupContext: SearchExecutionLookupContext
): CandidateCoverageFeature["matched"] {
  const matched: Array<CandidateCoverageFeature["matched"][number]> = [];
  for (const term of terms) {
    for (const field of fields) {
      if (field === "body") continue;
      const fieldId = POSITIONAL_FIELD_ID[field];
      if (positionsForCandidateTerm(snapshot, candidate, term.channel, term.term, fieldId, postingsLookup, lookupContext).length > 0) {
        matched.push({ channel: term.channel, field, term: term.term, weight: term.weight });
      }
    }
  }
  return matched;
}

function candidateRef(candidate: RetrievalCandidate): CandidateRef {
  return {
    candidateId: candidate.candidateId,
    documentId: candidate.documentId,
    shardDocRef: candidate.shardDocRef,
    path: candidate.path
  };
}

function segmentForCandidate(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate | CandidateRef,
  lookupContext?: SearchExecutionLookupContext
): SearchSnapshotSegment {
  const ref = candidate.shardDocRef;
  const segment = lookupContext
    ? lookupContext.segmentByKey.get(searchSegmentKey(ref))
    : snapshot.segments.find((entry) => entry.segmentId === ref.segmentId && entry.partitionId === ref.partitionId);
  if (!segment) throw new Error(`unknown search segment ${ref.segmentId}`);
  return segment;
}

function searchSegmentKey(segment: { segmentId: string; partitionId: number }): string {
  return `${segment.partitionId}\u0000${segment.segmentId}`;
}

function positionsForCandidateTerm(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number,
  postingsLookup?: QueryPostingsLookup,
  lookupContext?: SearchExecutionLookupContext
): readonly number[] {
  const segment = segmentForCandidate(snapshot, candidate, lookupContext);
  const localDocId = candidate.shardDocRef.localDocId;
  if (lookupContext) {
    return lookupContext.positionsLookup(segment, localDocId, channel, term, fieldId, postingsLookup);
  }
  const canonicalTerm = `${channel}\u0000${term.normalize("NFC").trim()}`;
  const postings = postingsLookup ? postingsLookup(segment, canonicalTerm) : segment.postings.postingsForTerm(canonicalTerm);
  const posting = postings
    .find((entry) => entry.docId === localDocId && entry.fieldId === fieldId);
  return posting?.positions ?? EMPTY_SEARCH_POSITIONS;
}

function createCandidateTermPositionsLookup(): CandidateTermPositionsLookup {
  const bySegment = new Map<SearchSnapshotSegment, Map<string, CandidateTermPositionsIndex>>();
  return (segment, localDocId, channel, term, fieldId, postingsLookup) => {
    let entries = bySegment.get(segment);
    if (!entries) {
      entries = new Map();
      bySegment.set(segment, entries);
    }
    const normalizedTerm = term.normalize("NFC").trim();
    const canonicalTerm = `${channel}\u0000${normalizedTerm}`;
    let positionsByDocField = entries.get(canonicalTerm);
    if (!positionsByDocField) {
      const postings = postingsLookup ? postingsLookup(segment, canonicalTerm) : segment.postings.postingsForTerm(canonicalTerm);
      positionsByDocField = candidateTermPositionsIndex(postings);
      entries.set(canonicalTerm, positionsByDocField);
    }
    return positionsByDocField.get(candidateTermDocFieldKey(localDocId, fieldId)) ?? EMPTY_SEARCH_POSITIONS;
  };
}

function candidateTermPositionsIndex(postings: readonly { docId: number; fieldId: number; positions: readonly number[] }[]): CandidateTermPositionsIndex {
  const positionsByDocField = new Map<string, readonly number[]>();
  for (const posting of postings) {
    const key = candidateTermDocFieldKey(posting.docId, posting.fieldId);
    if (!positionsByDocField.has(key)) positionsByDocField.set(key, posting.positions);
  }
  return positionsByDocField;
}

function candidateTermDocFieldKey(localDocId: number, fieldId: number): string {
  return `${localDocId}\u0000${fieldId}`;
}

function candidateFieldLength(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  channel: SearchTokenChannel,
  fieldId: number,
  lookupContext?: SearchExecutionLookupContext
): number {
  const segment = segmentForCandidate(snapshot, candidate, lookupContext);
  return lookupContext
    ? lookupContext.fieldLengthLookup(segment, candidate.shardDocRef.localDocId, channel, fieldId)
    : segment.projection.fieldLength(candidate.shardDocRef.localDocId, channel, fieldId);
}

function candidateTags(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate | CandidateRef,
  lookupContext?: SearchExecutionLookupContext
): string[] {
  const segment = segmentForCandidate(snapshot, candidate, lookupContext);
  return segment.projection.tagIds(candidate.shardDocRef.localDocId).map((tagId) => segment.projection.tagForId(tagId));
}

function projectionCoverage(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  context: QueryContext,
  postingsLookup: QueryPostingsLookup,
  lookupContext: SearchExecutionLookupContext
): { terms: number; fieldScore: number } {
  if (context.terms.length === 0 && SEARCH_TOKEN_CHANNELS.every((channel) => context.channels[channel].length === 0)) {
    return { terms: 0, fieldScore: 0 };
  }

  let matchedTerms = 0;
  let fieldScore = 0;
  const surfaceTerms = new Set(context.channels.surface);
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const terms = context.channels[channel];
    if (terms.length === 0) continue;
    const channelWeight = SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
    for (const term of terms) {
      if (isWeakMetadataCoverageTerm(term)) continue;
      if (isMorphMetadataExpansion(channel, term, surfaceTerms)) continue;
      let matched = false;
      for (const field of metadataCoverageFields(context)) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        if (positionsForCandidateTerm(snapshot, candidate, channel, term, fieldId, postingsLookup, lookupContext).length === 0) continue;
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field] * channelWeight;
      }
      if (matched) matchedTerms += channelWeight;
    }
  }

  return { terms: matchedTerms, fieldScore };
}

function projectionExactPriority(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  context: QueryContext,
  lookupContext: SearchExecutionLookupContext
): number {
  const keys = segmentForCandidate(snapshot, candidate, lookupContext).projection.identityKeys(candidate.shardDocRef.localDocId);
  const priorities: number[] = [];
  if (context.allowed.has("title") && keys.title.some((key) => exactIdentityKeyMatches(key, context.phrases))) {
    priorities.push(EXACT_PRIORITY.title);
  }
  if (context.allowed.has("aliases") && keys.aliases.some((key) => exactIdentityKeyMatches(key, context.phrases))) {
    priorities.push(EXACT_PRIORITY.alias);
  }
  if (context.allowed.has("path") && exactIdentityKeyMatches(keys.filenameStem, context.phrases)) {
    priorities.push(EXACT_PRIORITY.filenameStem);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

function projectionPhrasePriority(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  context: QueryContext,
  lookupContext: SearchExecutionLookupContext
): number {
  if (context.phrases.length === 0) return Number.POSITIVE_INFINITY;
  const keys = segmentForCandidate(snapshot, candidate, lookupContext).projection.identityKeys(candidate.shardDocRef.localDocId);
  const priorities: number[] = [];
  if (context.allowed.has("title") && keys.title.some((key) => containsAnyIdentityKeyPhrase(key, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.title);
  }
  if (context.allowed.has("aliases") && keys.aliases.some((key) => containsAnyIdentityKeyPhrase(key, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.alias);
  }
  if (context.allowed.has("path") && containsAnyIdentityKeyPhrase(keys.filenameStem, context.phrases)) {
    priorities.push(PHRASE_PRIORITY.filenameStem);
  }
  if (context.allowed.has("path") && keys.pathSegments.some((key) => containsAnyIdentityKeyPhrase(key, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.pathSegment);
  }
  if (context.allowed.has("headings") && keys.headings.some((key) => containsAnyIdentityKeyPhrase(key, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.heading);
  }
  if (context.allowed.has("body") && candidate.phraseMatches.some((match) => match.field === "body" && match.starts.length > 0)) {
    priorities.push(PHRASE_PRIORITY.body);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

function metadataCoverageFields(context: QueryContext): Array<Exclude<SearchField, "body">> {
  const fields: Array<Exclude<SearchField, "body">> = [];
  for (const field of ["title", "aliases", "tags", "headings", "path"] as const) {
    if (context.allowed.has(field)) fields.push(field);
  }
  return fields;
}

function isWeakMetadataCoverageTerm(term: string): boolean {
  return WEAK_METADATA_COVERAGE_TERM_SET.has(term);
}

function isMorphMetadataExpansion(channel: SearchTokenChannel, term: string, surfaceTerms: ReadonlySet<string>): boolean {
  return channel === "morph" && /[\uac00-\ud7af]/u.test(term) && !surfaceTerms.has(term);
}

function exactIdentityKeyMatches(key: string, phrases: readonly string[]): boolean {
  if (!key) return false;
  const compactKey = compactIdentityPhrase(key);
  return phrases.some((phrase) => key === phrase || compactKey === compactIdentityPhrase(phrase));
}

function containsAnyIdentityKeyPhrase(key: string, phrases: readonly string[]): boolean {
  if (!key) return false;
  const compactKey = compactIdentityPhrase(key);
  return phrases.some((phrase) =>
    isPhraseContainmentCandidate(phrase) &&
    (key.includes(phrase) || compactKey.includes(compactIdentityPhrase(phrase)))
  );
}

function compactIdentityPhrase(value: string): string {
  return value.replace(/\s+/gu, "");
}

function isPhraseContainmentCandidate(phrase: string): boolean {
  return compactIdentityPhrase(phrase).length >= 2;
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

function featureProximityScore(feature: CandidateFeaturePayload): number {
  let score = 0;
  for (const match of feature.proximity) {
    score += match.score;
  }
  return score;
}

function featureLexicalScore(feature: CandidateFeaturePayload): number {
  let score = 0;
  for (const term of canonicalBm25Order(feature.bm25)) {
    score += term.score * SEARCH_TOKEN_CHANNEL_WEIGHT[term.channel] * SEARCH_FIELD_CHANNEL_BOOST[term.channel][term.field];
  }
  return score;
}

// Sole purpose: pin the float-summation order so the lexical score is deterministic
// across shard topologies. Do NOT reuse for output ordering — use compareByteStrings.
function canonicalBm25Order(terms: readonly CandidateBm25Feature[]): CandidateBm25Feature[] {
  return [...terms].sort(compareCanonicalBm25Terms);
}

export function rankSignalsFromFeatures(
  features: readonly CandidateFeaturePayload[],
  exactLambda: number
): Map<string, CandidateRankSignals> {
  const signals = new Map<string, CandidateRankSignals>();
  for (const feature of features) {
    const documentId = feature.candidate.documentId;
    const exactPriority = feature.identity.exactPriority ?? Number.POSITIVE_INFINITY;
    const metadataPhrasePriority = feature.identity.phrasePriority ?? Number.POSITIVE_INFINITY;
    signals.set(documentId, {
      exactPriority,
      phrasePriority: metadataPhrasePriority,
      coverageTerms: feature.coverage.terms,
      coverageFieldScore: feature.coverage.fieldScore,
      lexicalScore: featureLexicalScore(feature),
      identityScore: identityScoreFromExactPriority(exactPriority),
      exactLambda,
      denseAgreement: feature.denseAgreement ?? feature.retrieverSignals?.dense?.normalizedScore ?? 0,
      linkAgreement: feature.linkAgreement ?? feature.retrieverSignals?.link?.normalizedScore ?? 0,
      rrfScore: feature.rrfScore ?? 0,
      rarityScore: 0,
      proximityScore: featureProximityScore(feature),
      bodyScore: 0
    });
  }
  return signals;
}

function deterministicRankedHits<T extends { candidate: RetrievalCandidate }>(
  hits: readonly T[],
  ranked: readonly RankedCandidate[]
): Array<RankedHitEntry<T>> {
  const rankByPath = new Map(ranked.map((rank) => [rank.path, rank]));
  return hits
    .map((hit) => {
      const rank = rankByPath.get(hit.candidate.path ?? "");
      if (!rank) return undefined;
      return { hit, rank };
    })
    .filter((entry): entry is RankedHitEntry<T> => Boolean(entry))
    .sort((left, right) => compareRankedHitEntries(left, right));
}

function candidateSetForHits(candidateSet: CandidateSet, hits: readonly { candidate: RetrievalCandidate }[]): CandidateSet {
  const candidateIds = new Set(hits.map((hit) => hit.candidate.candidateId));
  return {
    ...candidateSet,
    candidates: candidateSet.candidates.filter((candidate) => candidateIds.has(candidate.candidateId))
  };
}

function rawSearchLimit(documentCount: number, search: NormalizedSearchParams): number {
  return search.query
    ? Math.min(documentCount, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : search.path || search.tags
      ? documentCount
      : search.limit;
}

function exhaustiveCandidateLimit(
  documentCount: number,
  search: NormalizedSearchParams,
  _channels: SearchTokenChannelTerms
): number {
  if (search.query) return documentCount;
  return rawSearchLimit(documentCount, search);
}
