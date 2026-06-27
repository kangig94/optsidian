import type { SearchDocument } from "../markdown.js";
import type { SearchField, SearchMatch } from "../../types.js";
import {
  COVERAGE_BUCKET_MIN_TERMS,
  EXACT_DOMINANCE_EPSILON,
  MAX_SEARCH_QUERY_TERMS_PER_CHANNEL,
  RANK_BUCKET,
  SEARCH_SCORING_LAMBDAS,
  SEARCH_TOKEN_CHANNEL_WEIGHT
} from "../constants.js";
import type { QueryContext, RankedCandidate } from "../internal-types.js";
import { SEARCH_FIELD_CHANNEL_BOOST, SEARCH_PROPERTIES } from "../schema.js";
import {
  emptySearchTokenChannels,
  SEARCH_TOKEN_CHANNELS,
  uniqueSearchTerms,
  type SearchTokenChannel,
  type SearchTokenChannelTerms
} from "../analysis/index.js";
import { metadataCoverage } from "./coverage.js";
import { bestExactPriority, bestPhrasePriority, identityPhraseCandidates, identityScoreFromExactPriority } from "./identity.js";

export { identityScoreFromExactPriority } from "./identity.js";

export type CandidateRankSignals = {
  exactPriority?: number;
  phrasePriority?: number;
  coverageTerms?: number;
  coverageFieldScore?: number;
  lexicalScore?: number;
  identityScore?: number;
  exactLambda?: number;
  denseAgreement?: number;
  rarityScore: number;
  proximityScore: number;
  bodyScore: number;
};

export const EMPTY_RANK_SIGNALS: CandidateRankSignals = {
  lexicalScore: 0,
  identityScore: 0,
  exactLambda: SEARCH_SCORING_LAMBDAS.exact,
  denseAgreement: 0,
  rarityScore: 0,
  proximityScore: 0,
  bodyScore: 0
};

export type ExactDominanceBound = {
  lexicalBound: number;
  proximityBound: number;
  lambdaExact: number;
};

export type ExactDominanceBoundInput = {
  channelTermCounts: Partial<Record<SearchTokenChannel, number>>;
  fields: readonly SearchField[];
  bm25SingleTermBounds: ReadonlyMap<string, number>;
  lambdaPhrase?: number;
  epsilon?: number;
};

export function bm25BoundKey(channel: SearchTokenChannel, field: SearchField): string {
  return `${channel}\u0000${field}`;
}

// Canonical summation order for the lexical BM25 score: pins the float-addition
// order so the score is deterministic regardless of how terms were collected
// (e.g. across shard topologies). Intended for summation order only, NOT output
// ordering.
export function compareCanonicalBm25Terms(
  left: { channel: SearchTokenChannel; fieldId: number; term: string },
  right: { channel: SearchTokenChannel; fieldId: number; term: string }
): number {
  return (
    SEARCH_TOKEN_CHANNELS.indexOf(left.channel) - SEARCH_TOKEN_CHANNELS.indexOf(right.channel) ||
    left.fieldId - right.fieldId ||
    left.term.localeCompare(right.term)
  );
}

export function rerankCandidates(
  query: string,
  queryTerms: string[],
  hits: Array<{ document: SearchDocument; score: number; queryChannels?: SearchTokenChannelTerms }>,
  fields?: SearchField[]
): RankedCandidate[] {
  const context = queryContext(query, queryTerms, firstQueryChannels(hits), fields);
  return rerankCandidatesWithContext(query, hits, context);
}

export function rerankCandidatesWithSignals(
  query: string,
  queryTerms: string[],
  hits: Array<{ document: SearchDocument; score: number; queryChannels?: SearchTokenChannelTerms }>,
  fields: SearchField[] | undefined,
  signals: Map<string, CandidateRankSignals>
): RankedCandidate[] {
  const context = queryContext(query, queryTerms, firstQueryChannels(hits), fields);
  return rerankCandidatesWithContext(query, hits, context, signals);
}

function rerankCandidatesWithContext(
  _query: string,
  hits: Array<{ document: SearchDocument; score: number; queryChannels?: SearchTokenChannelTerms }>,
  context: QueryContext,
  signalOverride?: Map<string, CandidateRankSignals>
): RankedCandidate[] {
  const signals = signalOverride ?? new Map<string, CandidateRankSignals>();
  const candidates = hits.map((hit, index) =>
    rankedCandidate(hit.document, index + 1, hit.score, context, signals.get(hit.document.path) ?? EMPTY_RANK_SIGNALS)
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate)
    }))
    .sort(compareRankedMatches);
}

export function isRankedCandidate(match: { path: string }): match is RankedCandidate {
  return "baseRank" in match && "bucket" in match;
}

export function rankBucketName(bucket: number): NonNullable<SearchMatch["debug"]>["bucket"] {
  if (bucket === RANK_BUCKET.exact) return "exact";
  if (bucket === RANK_BUCKET.phrase) return "phrase";
  if (bucket === RANK_BUCKET.coverage) return "coverage";
  return "base";
}

export function nullableRankPriority(priority: number): number | null {
  return Number.isFinite(priority) ? priority : null;
}

export function compareTagOnlyMatches(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

function queryContext(
  query: string,
  queryTerms: string[],
  queryChannels?: SearchTokenChannelTerms,
  fields?: SearchField[]
): QueryContext {
  const phrases = uniquePhrases([
    ...identityPhraseCandidates(query),
    ...identityPhraseCandidates(queryTerms.join(" "))
  ]);
  return {
    phrase: phrases[0] ?? "",
    phrases,
    terms: queryTerms,
    channels: normalizedQueryChannels(queryTerms, queryChannels),
    allowed: new Set(searchFields(fields))
  };
}

function rankedCandidate(
  doc: SearchDocument,
  baseRank: number,
  baseScore: number,
  context: QueryContext,
  signals: CandidateRankSignals
): RankedCandidate {
  const exactPriority = signals.exactPriority ?? bestExactPriority(doc, context);
  const phrasePriority = signals.phrasePriority ?? bestPhrasePriority(doc, context);
  const coverage = {
    terms: signals.coverageTerms ?? metadataCoverage(doc, context).terms,
    fieldScore: signals.coverageFieldScore ?? metadataCoverage(doc, context).fieldScore
  };
  return {
    path: doc.path,
    title: doc.title,
    tags: doc.tags,
    bucket: rankBucket(exactPriority, phrasePriority, coverage.terms),
    score: 0,
    baseRank,
    exactPriority,
    phrasePriority,
    coverageTerms: coverage.terms,
    coverageFieldScore: coverage.fieldScore,
    lexicalScore: finiteNumber(signals.lexicalScore ?? baseScore),
    identityScore: finiteNumber(signals.identityScore ?? identityScoreFromExactPriority(exactPriority)),
    exactLambda: finiteNumber(signals.exactLambda ?? SEARCH_SCORING_LAMBDAS.exact),
    denseAgreement: finiteNumber(signals.denseAgreement ?? 0),
    rarityScore: finiteNumber(signals.rarityScore ?? 0),
    proximityScore: finiteNumber(signals.proximityScore ?? 0),
    bodyScore: finiteNumber(signals.bodyScore ?? 0)
  };
}

function compareRankedMatches(left: RankedCandidate, right: RankedCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
}

function searchFields(fields: SearchField[] | undefined): SearchField[] {
  return fields ?? [...SEARCH_PROPERTIES];
}

function uniquePhrases(phrases: readonly string[]): string[] {
  return [...new Set(phrases.filter(Boolean))];
}

function firstQueryChannels(
  hits: Array<{ queryChannels?: SearchTokenChannelTerms }>
): SearchTokenChannelTerms | undefined {
  return hits.find((hit) => hit.queryChannels)?.queryChannels;
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

function rankBucket(exactPriority: number, phrasePriority: number, coverageTerms: number): number {
  if (Number.isFinite(exactPriority)) return RANK_BUCKET.exact;
  if (Number.isFinite(phrasePriority)) return RANK_BUCKET.phrase;
  if (coverageTerms >= COVERAGE_BUCKET_MIN_TERMS) return RANK_BUCKET.coverage;
  return RANK_BUCKET.base;
}

export function rerankScore(candidate: Pick<RankedCandidate, "lexicalScore" | "proximityScore" | "identityScore" | "exactLambda" | "denseAgreement">): number {
  return finiteNumber(candidate.lexicalScore) +
    SEARCH_SCORING_LAMBDAS.phrase * finiteNumber(candidate.proximityScore) +
    finiteNumber(candidate.exactLambda) * finiteNumber(candidate.identityScore) +
    SEARCH_SCORING_LAMBDAS.dense * finiteNumber(candidate.denseAgreement);
}

export function exactDominanceLambda(input: ExactDominanceBoundInput): ExactDominanceBound {
  const lambdaPhrase = input.lambdaPhrase ?? SEARCH_SCORING_LAMBDAS.phrase;
  const epsilon = input.epsilon ?? EXACT_DOMINANCE_EPSILON;
  let lexicalBound = 0;
  let searchedChannels = 0;

  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const termCount = Math.min(input.channelTermCounts[channel] ?? 0, MAX_SEARCH_QUERY_TERMS_PER_CHANNEL);
    if (termCount <= 0) continue;
    searchedChannels += 1;
    let channelFieldBound = 0;
    for (const field of input.fields) {
      const key = bm25BoundKey(channel, field);
      if (!input.bm25SingleTermBounds.has(key)) throw new Error(`missing BM25 bound for ${channel}/${field}`);
      const bm25Bound = input.bm25SingleTermBounds.get(key) ?? 0;
      assertFiniteNonNegative(bm25Bound, `BM25 bound for ${channel}/${field}`);
      channelFieldBound += Math.abs(SEARCH_TOKEN_CHANNEL_WEIGHT[channel] * SEARCH_FIELD_CHANNEL_BOOST[channel][field]) * bm25Bound;
    }
    lexicalBound += termCount * channelFieldBound;
  }

  const proximityBound = searchedChannels * input.fields.length;
  const dominanceBound = lexicalBound + Math.abs(lambdaPhrase) * proximityBound;
  const lambdaExact = dominanceBound + epsilon;
  assertFiniteNonNegative(lambdaExact, "lambdaExact");
  return { lexicalBound, proximityBound, lambdaExact };
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
