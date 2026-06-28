import type { SearchField, SearchMatch } from "../../types.js";
import {
  COVERAGE_BUCKET_MIN_TERMS,
  EXACT_DOMINANCE_EPSILON,
  MAX_SEARCH_QUERY_TERMS_PER_CHANNEL,
  RANK_BUCKET,
  SEARCH_SCORING_LAMBDAS,
  SEARCH_TOKEN_CHANNEL_WEIGHT
} from "../constants.js";
import type { RankedCandidate } from "../internal-types.js";
import { SEARCH_FIELD_CHANNEL_BOOST } from "../schema.js";
import {
  SEARCH_TOKEN_CHANNELS,
  type SearchTokenChannel,
} from "../analysis/index.js";
import { identityScoreFromExactPriority } from "./identity.js";

export { identityScoreFromExactPriority } from "./identity.js";

export type RankDocument = {
  id: string;
  path: string;
  title: string;
  tags: string[];
};

export type CandidateRankSignals = {
  exactPriority: number;
  phrasePriority: number;
  coverageTerms: number;
  coverageFieldScore: number;
  lexicalScore: number;
  identityScore: number;
  exactLambda: number;
  denseAgreement: number;
  rarityScore: number;
  proximityScore: number;
  bodyScore: number;
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

export function rerankCandidatesWithSignals(
  _query: string,
  _queryTerms: string[],
  hits: Array<{ document: RankDocument; score: number }>,
  _fields: SearchField[] | undefined,
  signals: Map<string, CandidateRankSignals>
): RankedCandidate[] {
  return rerankCandidates(hits, signals);
}

function rerankCandidates(
  hits: Array<{ document: RankDocument; score: number }>,
  signals: Map<string, CandidateRankSignals>
): RankedCandidate[] {
  const candidates = hits.map((hit, index) => {
    const signal = requiredRankSignals(hit.document, signals);
    return rankedCandidate(hit.document, index + 1, signal);
  });

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate)
    }))
    .sort(compareRankedMatches);
}

const FINITE_RANK_SIGNAL_KEYS = [
  "coverageTerms",
  "coverageFieldScore",
  "lexicalScore",
  "identityScore",
  "exactLambda",
  "denseAgreement",
  "rarityScore",
  "proximityScore",
  "bodyScore"
] as const satisfies readonly (keyof CandidateRankSignals)[];

function requiredRankSignals(doc: RankDocument, signals: ReadonlyMap<string, CandidateRankSignals>): CandidateRankSignals {
  const signal = signals.get(doc.id);
  if (!signal) throw new Error(`missing rank signals for document ${doc.id} (${doc.path})`);
  if (!isRankPriority(signal.exactPriority)) throw new Error(`incomplete rank signals for document ${doc.id}: exactPriority`);
  if (!isRankPriority(signal.phrasePriority)) throw new Error(`incomplete rank signals for document ${doc.id}: phrasePriority`);
  for (const key of FINITE_RANK_SIGNAL_KEYS) {
    if (typeof signal[key] !== "number" || !Number.isFinite(signal[key])) {
      throw new Error(`incomplete rank signals for document ${doc.id}: ${key}`);
    }
  }
  return signal;
}

function isRankPriority(value: unknown): value is number {
  return typeof value === "number" && (Number.isFinite(value) || value === Number.POSITIVE_INFINITY);
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

function rankedCandidate(
  doc: RankDocument,
  baseRank: number,
  signals: CandidateRankSignals
): RankedCandidate {
  const exactPriority = signals.exactPriority;
  const phrasePriority = signals.phrasePriority;
  const coverage = {
    terms: signals.coverageTerms,
    fieldScore: signals.coverageFieldScore
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
    lexicalScore: finiteNumber(signals.lexicalScore),
    identityScore: finiteNumber(signals.identityScore),
    exactLambda: finiteNumber(signals.exactLambda),
    denseAgreement: finiteNumber(signals.denseAgreement),
    rarityScore: finiteNumber(signals.rarityScore),
    proximityScore: finiteNumber(signals.proximityScore),
    bodyScore: finiteNumber(signals.bodyScore)
  };
}

function compareRankedMatches(left: RankedCandidate, right: RankedCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
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
