import type { SearchDocument } from "../markdown.js";
import type { SearchField, SearchMatch } from "../../types.js";
import { RANK_BUCKET, RRF_WEIGHTS } from "../constants.js";
import type { QueryContext, RankedCandidate } from "../internal-types.js";
import { SEARCH_PROPERTIES } from "../schema.js";
import { metadataCoverage } from "./coverage.js";
import { bestExactPriority, bestPhrasePriority, normalizeIdentityText } from "./identity.js";
import { rankMap, rrfContribution } from "./rrf.js";

export function rerankCandidates(
  query: string,
  queryTerms: string[],
  hits: Array<{ document: SearchDocument; score: number }>,
  fields?: SearchField[]
): RankedCandidate[] {
  const context = queryContext(query, queryTerms, fields);
  const candidates = hits.map((hit, index) => rankedCandidate(hit.document, index + 1, context));
  const identityRanks = rankMap(candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.exact), compareIdentityRank);
  const phraseRanks = rankMap(
    candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.phrase),
    comparePhraseRank
  );
  const coverageRanks = rankMap(
    candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.phrase || candidate.bucket === RANK_BUCKET.coverage),
    compareCoverageRank
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate, identityRanks, phraseRanks, coverageRanks)
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

function queryContext(query: string, queryTerms: string[], fields?: SearchField[]): QueryContext {
  return {
    phrase: normalizeIdentityText(query),
    terms: queryTerms,
    allowed: new Set(searchFields(fields))
  };
}

function rankedCandidate(doc: SearchDocument, baseRank: number, context: QueryContext): RankedCandidate {
  const exactPriority = bestExactPriority(doc, context);
  const phrasePriority = bestPhrasePriority(doc, context);
  const coverage = metadataCoverage(doc, context);
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
    coverageFieldScore: coverage.fieldScore
  };
}

function compareRankedMatches(left: RankedCandidate, right: RankedCandidate): number {
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
}

function searchFields(fields: SearchField[] | undefined): SearchField[] {
  return fields ?? [...SEARCH_PROPERTIES];
}

function rankBucket(exactPriority: number, phrasePriority: number, coverageTerms: number): number {
  if (Number.isFinite(exactPriority)) return RANK_BUCKET.exact;
  if (Number.isFinite(phrasePriority)) return RANK_BUCKET.phrase;
  if (coverageTerms > 0) return RANK_BUCKET.coverage;
  return RANK_BUCKET.base;
}

function rerankScore(
  candidate: RankedCandidate,
  identityRanks: Map<string, number>,
  phraseRanks: Map<string, number>,
  coverageRanks: Map<string, number>
): number {
  let score = rrfContribution(candidate.baseRank, RRF_WEIGHTS.base);
  if (candidate.bucket === RANK_BUCKET.exact) {
    const rank = identityRanks.get(candidate.path);
    if (rank) score += rrfContribution(rank, RRF_WEIGHTS.identity);
  } else if (candidate.bucket === RANK_BUCKET.phrase) {
    const phraseRank = phraseRanks.get(candidate.path);
    if (phraseRank) score += rrfContribution(phraseRank, RRF_WEIGHTS.phrase);
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, RRF_WEIGHTS.coverage);
  } else if (candidate.bucket === RANK_BUCKET.coverage) {
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, RRF_WEIGHTS.coverage);
  }
  return score;
}

function compareIdentityRank(left: RankedCandidate, right: RankedCandidate): number {
  if (left.exactPriority !== right.exactPriority) return left.exactPriority - right.exactPriority;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function comparePhraseRank(left: RankedCandidate, right: RankedCandidate): number {
  if (left.phrasePriority !== right.phrasePriority) return left.phrasePriority - right.phrasePriority;
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function compareCoverageRank(left: RankedCandidate, right: RankedCandidate): number {
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}
