import type { SearchExecutionBudget, SearchExecutionMode, SearchField } from "../types.js";
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
  mode: SearchExecutionMode;
  budget?: SearchExecutionBudget;
};

export const SEARCH_WARNING_APPROXIMATE = "approximate";
export const SEARCH_WARNING_NON_REPRODUCIBLE = "non-reproducible";

export function searchExecutionWarningLabels(search: Pick<NormalizedSearchParams, "mode" | "budget">): string[] {
  if (search.mode !== "approximate") return [];
  return [
    SEARCH_WARNING_APPROXIMATE,
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
