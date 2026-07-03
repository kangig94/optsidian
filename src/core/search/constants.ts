import type { SearchTokenChannel } from './analysis/index.js';
import { SEARCH_BOOST, SEARCH_FIELD_CHANNEL_BOOST } from './schema.js';

// Single tokenizer-identity lever. Bump on any change to script routing, the Intl
// latin baseline, or the Kiwi POS filter. Kept distinct from INDEX_BUILD_VERSION
// because the analyzer identity is also the query-analysis cache key. Lives here (a
// side-effect-free constants module) so the daemon's runtime-profile can fold it into
// the lexical store-dir identity without importing the heavy analyzer/Kiwi graph.
export const ANALYZER_VERSION = 'router-intl-kiwi-link-render-v2';

export const CANDIDATE_LIMIT_MIN = 50;
export const CANDIDATE_LIMIT_MULTIPLIER = 10;
export const RANK_FINAL_SORT_POLICY = 'unified-score-path-v1';
export type SearchScoringLambdas = {
  phrase: number;
  exact: number;
  dense: number;
  link: number;
};

export const SEARCH_SCORING_LAMBDAS: SearchScoringLambdas = {
  phrase: 0.06,
  exact: 0,
  dense: 0.25,
  link: 0.2,
};
export const DEFAULT_RRF_K = 60;
export const EXACT_DOMINANCE_EPSILON = 1e-9;
export const MAX_SEARCH_QUERY_TERMS_PER_CHANNEL = 2048;
export const SEARCH_BM25_K1 = 1.2;
export const SEARCH_BM25_B = 0.75;
export const SEARCH_BM25_D = 0.5;
export const SEARCH_TOKEN_CHANNEL_WEIGHT: Record<SearchTokenChannel, number> = {
  morph: 1,
  surface: 0.65,
  ngram: 0.3,
};
export const SEARCH_FUZZY_WEIGHT_MULTIPLIER = 0.2;
export const RANK_BUCKET = {
  exact: 0,
  phrase: 1,
  coverage: 2,
  base: 3,
} as const;
export const COVERAGE_BUCKET_MIN_TERMS = 1;
export const EXACT_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2,
} as const;
export const PHRASE_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2,
  heading: 3,
  pathSegment: 4,
  body: 5,
} as const;

export type CoverageField = 'title' | 'aliases' | 'tags' | 'headings' | 'path';

export const COVERAGE_FIELD_WEIGHT: Record<CoverageField, number> = {
  title: 5,
  aliases: 4,
  tags: 3,
  headings: 2,
  path: 1,
};

export const WEAK_METADATA_COVERAGE_TERMS = [
  'a',
  'am',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'doe',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'having',
  'in',
  'is',
  'it',
  'its',
  'may',
  'might',
  'must',
  'of',
  'on',
  'or',
  'our',
  'shall',
  'should',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'these',
  'they',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'will',
  'with',
  'would',
] as const;

export const RANKING_CONSTANTS = {
  RANK_FINAL_SORT_POLICY,
  SEARCH_SCORING_LAMBDAS,
  EXACT_DOMINANCE_EPSILON,
  MAX_SEARCH_QUERY_TERMS_PER_CHANNEL,
  SEARCH_TOKEN_CHANNEL_WEIGHT,
  COVERAGE_FIELD_WEIGHT,
  WEAK_METADATA_COVERAGE_TERMS,
  EXACT_PRIORITY,
  PHRASE_PRIORITY,
  SEARCH_BOOST,
  SEARCH_FIELD_CHANNEL_BOOST,
  SEARCH_BM25_K1,
  SEARCH_BM25_B,
  SEARCH_BM25_D,
  SEARCH_FUZZY_WEIGHT_MULTIPLIER,
  CANDIDATE_LIMIT_MIN,
  CANDIDATE_LIMIT_MULTIPLIER,
  DEFAULT_RRF_K,
} as const;
