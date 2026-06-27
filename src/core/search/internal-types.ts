import type { SearchField } from "../types.js";
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
};

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
