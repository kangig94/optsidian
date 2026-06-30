import type { SearchCoverageBudget, SearchCoverageMode, SearchField, SearchRetrievalMode } from "../types.js";
import type { SearchTokenChannelTerms } from "./analysis/index.js";

export type PathFilter = {
  rel: string;
  directory: boolean;
};

export type NormalizedSearchParams = {
  query?: string;
  path?: string;
  tags?: string[];
  fields?: SearchField[];
  limit: number;
  debug: boolean;
  retrieval: SearchRetrievalMode;
  coverage: SearchCoverageMode;
  budget?: SearchCoverageBudget;
};

export const SEARCH_WARNING_BOUNDED = "bounded";
export const SEARCH_WARNING_NON_REPRODUCIBLE = "non-reproducible";

export function searchExecutionWarningLabels(search: Pick<NormalizedSearchParams, "coverage" | "budget">): string[] {
  if (search.coverage !== "bounded") return [];
  return [
    SEARCH_WARNING_BOUNDED,
    ...(search.budget?.timeMs !== undefined ? [SEARCH_WARNING_NON_REPRODUCIBLE] : [])
  ];
}

export type RankedCandidate = {
  path: string;
  title: string;
  tags: string[];
  bucket: number;
  score: number;
  baseRank: number;
  exactPriority: number;
  phrasePriority: number;
  coverageTerms: number;
  coverageFieldScore: number;
  lexicalScore: number;
  identityScore: number;
  exactLambda: number;
  denseAgreement: number;
  linkAgreement: number;
  rrfScore: number;
  rarityScore: number;
  proximityScore: number;
  bodyScore: number;
};

export type QueryContext = {
  phrase: string;
  phrases: string[];
  terms: string[];
  channels: SearchTokenChannelTerms;
  allowed: Set<SearchField>;
};
