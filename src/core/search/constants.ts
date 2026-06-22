import type { SearchTokenChannel } from "./analysis/index.js";

export const SEARCH_IDENTITY_SCHEMA_VERSION = 3;
export const SEARCH_ANALYSIS_CACHE_SCHEMA_VERSION = 4;
export const SEARCH_INDEX_FILE = "search.orama";
export const SEARCH_MANIFEST_FILE = "manifest.json";
export const SEARCH_COMMIT_FILE = "commit.json";
export const SEARCH_ANALYSIS_CACHE_FILE = "analysis-cache.json";
export const SEARCH_RECONCILE_COMMAND = "__search-reconcile";
export const SEARCH_RECONCILE_LOCK_DIR = "reconcile.lock";
export const SEARCH_RECONCILE_STATUS_FILE = "reconcile-status.json";
export const SEARCH_INDEX_WRITER_LOCK_DIR = "index-writer.lock";
export const SEARCH_INDEX_STALE_TIER_WARNING = "fts_index_stale_tier";
export const SEARCH_INDEX_STALE_MANIFEST_WARNING = "fts_index_stale_manifest";
export const SEARCH_INDEX_BUILDING_WARNING = "fts_index_building";
export const SEARCH_RECONCILE_LOCK_STALE_MS = 30 * 60 * 1000;
export const SEARCH_RECONCILE_STATUS_SCHEMA_VERSION = 1;
export const SEARCH_RECONCILE_ERROR_MAX_LENGTH = 2048;
export const SEARCH_INDEX_WRITER_LOCK_STALE_MS = 30 * 60 * 1000;
export const SEARCH_INDEX_WRITER_LOCK_WAIT_MS = 60 * 1000;
export const SEARCH_INDEX_WRITER_LOCK_POLL_MS = 50;
export const SEARCH_OVERLAY_MAX_FILES_ENV = "OPTSIDIAN_SEARCH_OVERLAY_MAX_FILES";
export const SEARCH_OVERLAY_MAX_BYTES_ENV = "OPTSIDIAN_SEARCH_OVERLAY_MAX_BYTES";
export const SEARCH_ANALYZER_LOAD_TIMEOUT_ENV = "OPTSIDIAN_ANALYZER_LOAD_TIMEOUT_MS";
export const SEARCH_OVERLAY_MAX_FILES_DEFAULT = 20;
export const SEARCH_OVERLAY_MAX_BYTES_DEFAULT = 2 * 1024 * 1024;
export const SEARCH_ANALYZER_LOAD_TIMEOUT_MS_DEFAULT = 5000;

export const CANDIDATE_LIMIT_MIN = 50;
export const CANDIDATE_LIMIT_MULTIPLIER = 10;
export const RRF_K = 10;
export const RRF_WEIGHTS = {
  identity: 4,
  phrase: 3,
  coverage: 2,
  base: 1
} as const;
export const RANK_SIGNAL_WEIGHTS = {
  rarity: 0.04,
  proximity: 0.06
} as const;
export const SEARCH_TOKEN_CHANNEL_WEIGHT: Record<SearchTokenChannel, number> = {
  morph: 1,
  surface: 0.65,
  ngram: 0.3
};
export const SEARCH_FUZZY_WEIGHT_MULTIPLIER = 0.2;
export const RANK_BUCKET = {
  exact: 0,
  phrase: 1,
  coverage: 2,
  base: 3
} as const;
export const EXACT_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2
} as const;
export const PHRASE_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2,
  heading: 3,
  pathSegment: 4
} as const;

export type CoverageField = "title" | "aliases" | "tags" | "headings" | "path";

export const COVERAGE_FIELD_WEIGHT: Record<CoverageField, number> = {
  title: 5,
  aliases: 4,
  tags: 3,
  headings: 2,
  path: 1
};
