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
import { CANDIDATE_LIMIT_MIN, CANDIDATE_LIMIT_MULTIPLIER, COVERAGE_FIELD_WEIGHT, EXACT_PRIORITY, PHRASE_PRIORITY, SEARCH_TOKEN_CHANNEL_WEIGHT, WEAK_METADATA_COVERAGE_TERMS } from "../core/search/constants.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import {
  bm25CorpusStats,
  bm25DocumentFrequency,
  bm25TermScoreFromGlobalStats,
  createQueryPostingsLookup,
  createSearchEngine,
  createPositionalRetriever,
  POSITIONAL_FIELD_ID,
  type QueryPostingsLookup,
  type SearchSnapshot,
  type SearchSnapshotSegment
} from "../core/search/retrieval/positional/index.js";
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
  documentsByPath,
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
import type { SnapshotEnvelope, PersistedDocumentRecord } from "./search-store/types.js";

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
  explain?: boolean;
};

export type SearchShardExecutionJob = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
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
    return metadataSearch(job.search, job.pathFilter, documents, job.snapshot.snapshotId, job.analyzerIdentity);
  }
  const state = cachedSearchExecutionStateFromHandle(job.snapshot).state;
  const documents = documentsFromHandle(job.snapshot);
  return querySearch(job.search, job.pathFilter, state.snapshot, documents, job.analysis, job.analyzerIdentity, job.explain === true);
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
  explain: boolean
): SearchExecutionResult {
  const query = search.query ?? "";
  if (analysis.primaryTerms.length === 0) return searchResult([], snapshot.snapshotId, analyzerIdentity, search, 0);
  const postingsLookup = createQueryPostingsLookup();
  const engine = createSearchEngine(
    snapshot,
    createPositionalRetriever(snapshot, postingsLookup),
    createSnapshotFeatureStore(snapshot, postingsLookup)
  );
  const retrievalQuery: RetrievalQuery = {
    rawQuery: query,
    analysis,
    fields: search.fields,
    tags: search.tags,
    limit: exhaustiveCandidateLimit(snapshot.documentCount, search, analysis.channels),
    snapshotId: snapshot.snapshotId
  };
  const candidateSet = engine.retrieve(retrievalQuery) as CandidateSet;
  const hits = candidateSet.candidates
    .map((candidate) => hitFromCandidate(candidate, documents, analysis.channels))
    .filter((hit): hit is PositionalHit => Boolean(hit))
    .filter((hit) =>
      (!pathFilter || matchesPathFilter(hit.candidate.path ?? hit.document.path, pathFilter)) &&
      matchesTagFilter(candidateTags(snapshot, hit.candidate), search.tags)
    );
  const rerankCandidateSet = candidateSetForHits(candidateSet, hits);
  const featurePayloads = engine.featureStore.featuresFor(retrievalQuery, rerankCandidateSet) as readonly CandidateFeaturePayload[];
  const exactBound = exactDominanceBoundForSearchSnapshot({ snapshot, analysis, search });
  const signals = rankSignalsFromFeatures(featurePayloads, exactBound.lambdaExact);
  const rankedAll = deterministicRankedHits(
    hits,
    rerankCandidatesWithSignals(query, analysis.primaryTerms, hits, search.fields, signals)
  ).map((entry) => entry.rank);
  const ranked = rankedAll.slice(0, search.limit);
  const hitByPath = new Map(hits.map((hit) => [hit.document.path, hit]));
  const documentsByRelPath = documentsByPath(documents);
  const matches = ranked.map((rank): SearchMatch => {
    const hit = hitByPath.get(rank.path);
    const record = hit ? documents.get(hit.candidate.documentId) : documentsByRelPath.get(rank.path);
    const snippets = record ? snippetsForDocument(record, analysis.channels) : [];
    return {
      path: rank.path,
      title: rank.title,
      tags: rank.tags,
      snippets: record ? snippets : [],
      ...(search.debug && hit
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
}): SearchExecutionResult {
  const documents = input.documents ?? documentsFromHandle(input.snapshot);
  return metadataSearch(input.search, input.pathFilter, documents, input.snapshot.snapshotId, input.analyzerIdentity);
}

function querySearchShard(job: SearchShardExecutionJob, snapshot: SearchSnapshot): SearchShardExecutionResult {
  const search = job.search;
  const query = search.query ?? "";
  const postingsLookup = createQueryPostingsLookup();
  const engine = createSearchEngine(
    snapshot,
    createPositionalRetriever(snapshot, postingsLookup),
    createSnapshotFeatureStore(snapshot, postingsLookup)
  );
  const retrievalQuery: RetrievalQuery = {
    rawQuery: query,
    analysis: job.analysis,
    fields: search.fields,
    tags: search.tags,
    limit: exhaustiveCandidateLimit(snapshot.documentCount, search, job.analysis.channels),
    channels: job.channels,
    snapshotId: snapshot.snapshotId
  };
  const candidateSet = engine.retrieve(retrievalQuery) as CandidateSet;
  assertSearchShardDeadline(job);
  const hits = candidateSet.candidates
    .map((candidate) => shardHitFromCandidate(snapshot, candidate, job.analysis.channels))
    .filter((hit): hit is SearchHitEvidence => Boolean(hit))
    .filter((hit) =>
      (!job.pathFilter || matchesPathFilter(hit.candidate.path ?? hit.path, job.pathFilter)) &&
      matchesTagFilter(candidateTags(snapshot, hit.candidate), search.tags)
    );
  const rerankCandidateSet = candidateSetForHits(candidateSet, hits);
  const featurePayloads = engine.featureStore.featuresFor(retrievalQuery, rerankCandidateSet) as readonly CandidateFeaturePayload[];
  const exactBound = job.exactBound;
  const signals = rankSignalsFromFeatures(featurePayloads, exactBound.lambdaExact);
  const rankHits = deterministicRankedHits(
    hits,
    rerankCandidatesWithSignals(query, job.analysis.primaryTerms, minimalRankDocuments(hits), search.fields, signals)
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

function metadataSearch(
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  documents: ReadonlyMap<string, PersistedDocumentRecord>,
  snapshotId: string,
  analyzerIdentity: SearchAnalyzerIdentity
): SearchResult & { snapshotId: string } {
  const matches = [...documents.values()]
    .filter((record) =>
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
  queryChannels: SearchTokenChannelTerms
): SearchHitEvidence | undefined {
  const segment = segmentForCandidate(snapshot, candidate);
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
  const title = relPath.split(/[\\/]/u).pop()?.replace(/\.[^.]+$/u, "") || relPath;
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

function createSnapshotFeatureStore(snapshot: SearchSnapshot, sharedPostingsLookup?: QueryPostingsLookup): FeatureStore {
  return {
    featuresFor: (query, candidateSet) => {
      const allowedFields = query.fields ?? [...SEARCH_PROPERTIES];
      const terms = weightedQueryTerms(query.analysis.channels);
      const context = featureQueryContext(query);
      const postingsLookup = sharedPostingsLookup ?? createQueryPostingsLookup();
      return candidateSet.candidates.map((candidate) => {
        const coverage = projectionCoverage(snapshot, candidate, context, postingsLookup);
        const exactPriority = nullableRankPriority(projectionExactPriority(snapshot, candidate, context));
        const phrasePriority = nullableRankPriority(projectionPhrasePriority(snapshot, candidate, context));
        return {
          candidate: candidateRef(candidate),
          bm25: bm25Features(snapshot, candidate, allowedFields, postingsLookup),
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
            matched: coverageMatches(snapshot, candidate, terms, allowedFields, postingsLookup)
          },
          identity: {
            exactPriority,
            phrasePriority
          },
          tags: candidateTags(snapshot, candidate)
        } satisfies CandidateFeaturePayload;
      });
    },
  };
}

function bm25Features(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  fields: readonly SearchField[],
  postingsLookup: QueryPostingsLookup
): CandidateFeaturePayload["bm25"] {
  const output: CandidateBm25Feature[] = [];
  for (const channelRank of candidate.channels) {
    for (const term of channelRank.matchedTerms) {
      for (const field of fields) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        const frequency = positionsForCandidateTerm(snapshot, candidate, channelRank.channel, term, fieldId, postingsLookup).length;
        if (frequency <= 0) continue;
        const corpus = bm25CorpusStats(snapshot.bm25Stats, channelRank.channel, fieldId);
        const fieldLength = candidateFieldLength(snapshot, candidate, channelRank.channel, fieldId);
        output.push({
          channel: channelRank.channel,
          field,
          fieldId,
          term,
          frequency,
          documentFrequency: bm25DocumentFrequency(snapshot.bm25Stats, channelRank.channel, term, fieldId),
          documentCount: corpus?.documentCount ?? 0,
          fieldLength,
          averageFieldLength: corpus?.averageFieldLength ?? 0,
          score: bm25TermScoreFromGlobalStats(snapshot.bm25Stats, channelRank.channel, term, fieldId, frequency, fieldLength)
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
  postingsLookup: QueryPostingsLookup
): CandidateCoverageFeature["matched"] {
  const matched: Array<CandidateCoverageFeature["matched"][number]> = [];
  for (const term of terms) {
    for (const field of fields) {
      if (field === "body") continue;
      const fieldId = POSITIONAL_FIELD_ID[field];
      if (positionsForCandidateTerm(snapshot, candidate, term.channel, term.term, fieldId, postingsLookup).length > 0) {
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

function segmentForCandidate(snapshot: SearchSnapshot, candidate: RetrievalCandidate | CandidateRef): SearchSnapshotSegment {
  const ref = candidate.shardDocRef;
  const segment = snapshot.segments.find((entry) => entry.segmentId === ref.segmentId && entry.partitionId === ref.partitionId);
  if (!segment) throw new Error(`unknown search segment ${ref.segmentId}`);
  return segment;
}

function positionsForCandidateTerm(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number,
  postingsLookup?: QueryPostingsLookup
): readonly number[] {
  const segment = segmentForCandidate(snapshot, candidate);
  const localDocId = candidate.shardDocRef.localDocId;
  const canonicalTerm = `${channel}\u0000${term.normalize("NFC").trim()}`;
  const postings = postingsLookup ? postingsLookup(segment, canonicalTerm) : segment.postings.postingsForTerm(canonicalTerm);
  const posting = postings
    .find((entry) => entry.docId === localDocId && entry.fieldId === fieldId);
  return posting?.positions ?? [];
}

function candidateFieldLength(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  channel: SearchTokenChannel,
  fieldId: number
): number {
  return segmentForCandidate(snapshot, candidate).projection.fieldLength(candidate.shardDocRef.localDocId, channel, fieldId);
}

function candidateTags(snapshot: SearchSnapshot, candidate: RetrievalCandidate | CandidateRef): string[] {
  const segment = segmentForCandidate(snapshot, candidate);
  return segment.projection.tagIds(candidate.shardDocRef.localDocId).map((tagId) => segment.projection.tagForId(tagId));
}

function projectionCoverage(
  snapshot: SearchSnapshot,
  candidate: RetrievalCandidate,
  context: QueryContext,
  postingsLookup: QueryPostingsLookup
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
        if (positionsForCandidateTerm(snapshot, candidate, channel, term, fieldId, postingsLookup).length === 0) continue;
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field] * channelWeight;
      }
      if (matched) matchedTerms += channelWeight;
    }
  }

  return { terms: matchedTerms, fieldScore };
}

function projectionExactPriority(snapshot: SearchSnapshot, candidate: RetrievalCandidate, context: QueryContext): number {
  const keys = segmentForCandidate(snapshot, candidate).projection.identityKeys(candidate.shardDocRef.localDocId);
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

function projectionPhrasePriority(snapshot: SearchSnapshot, candidate: RetrievalCandidate, context: QueryContext): number {
  if (context.phrases.length === 0) return Number.POSITIVE_INFINITY;
  const keys = segmentForCandidate(snapshot, candidate).projection.identityKeys(candidate.shardDocRef.localDocId);
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

function rankSignalsFromFeatures(
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
      denseAgreement: 0,
      rarityScore: 0,
      proximityScore: featureProximityScore(feature),
      bodyScore: 0
    });
  }
  return signals;
}

function canonicalPostingTerm(channel: SearchTokenChannel, term: string): string {
  return `${channel}\u0000${term.normalize("NFC").trim()}`;
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

function exhaustiveCandidateLimit(
  documentCount: number,
  search: NormalizedSearchParams,
  _channels: SearchTokenChannelTerms
): number {
  if (search.query) return documentCount;
  return rawSearchLimit(documentCount, search);
}
