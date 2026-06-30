import { UsageError } from "../../errors.js";
import type { SearchCoverageBudget, SearchCoverageMode, SearchField, SearchParams, SearchRetrievalMode } from "../types.js";
import { assertOptionalPositiveInteger } from "../validation.js";
import type { NormalizedSearchParams, PathFilter } from "./internal-types.js";
import { SEARCH_PROPERTIES } from "./schema.js";

export const MAX_SEARCH_QUERY_LENGTH = 4096;

export function normalizeSearchParams(params: SearchParams): NormalizedSearchParams {
  assertOptionalPositiveInteger(params.limit, "limit");
  const retrieval = normalizeSearchRetrieval(params.retrieval);
  const coverage = normalizeSearchCoverage(params.coverage);
  const budget = normalizeSearchBudget(params.budget);
  if (budget && coverage !== "bounded") {
    throw new UsageError("search budget requires coverage=bounded");
  }
  if (params.query !== undefined && params.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new UsageError(`query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer`);
  }
  const query = params.query?.trim();
  if (params.query !== undefined && !query) {
    throw new UsageError("query must not be empty");
  }
  const tags = normalizeTagFilters(params.tags);
  const fields = normalizeSearchFields(params.fields);
  if (fields && !query) {
    throw new UsageError("field=<field> requires query=<text>");
  }
  if (retrieval === "vector") {
    if (!query) throw new UsageError("retrieval=vector requires query=<text>");
    if (fields) throw new UsageError("field=<field> is not supported with retrieval=vector");
  }
  if (!query && !tags) {
    throw new UsageError("search requires query=<text> or tag=<tag>");
  }
  return {
    query: query || undefined,
    path: params.path,
    tags,
    fields,
    limit: params.limit ?? 10,
    debug: params.debug === true,
    retrieval,
    coverage,
    ...(budget ? { budget } : {})
  };
}

export function matchesPathFilter(relPath: string, filter: PathFilter): boolean {
  if (!filter.rel) return true;
  if (!filter.directory) return relPath === filter.rel;
  return relPath === filter.rel || relPath.startsWith(`${filter.rel}/`);
}

export function matchesTagFilter(docTags: string[], tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  const available = new Set(docTags.map((tag) => normalizeText(tag)));
  return tags.every((tag) => available.has(normalizeText(tag)));
}

function normalizeTagFilters(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  const normalized = [...new Set(tags.map((tag) => tag.replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new UsageError("tag must include at least one non-empty tag");
  }
  return normalized;
}

function normalizeSearchFields(fields: string[] | undefined): SearchField[] | undefined {
  if (fields === undefined) return undefined;
  const normalized = [...new Set(fields.map((field) => field.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new UsageError(`field must include at least one of: ${SEARCH_PROPERTIES.join(", ")}`);
  }
  for (const field of normalized) {
    if (!SEARCH_PROPERTIES.includes(field as SearchField)) {
      throw new UsageError(`field must be one of: ${SEARCH_PROPERTIES.join(", ")}`);
    }
  }
  return normalized as SearchField[];
}

function normalizeSearchRetrieval(retrieval: SearchParams["retrieval"]): SearchRetrievalMode {
  if (retrieval === undefined) return "lexical";
  if (retrieval !== "lexical" && retrieval !== "vector" && retrieval !== "hybrid") {
    throw new UsageError("retrieval must be lexical, vector, or hybrid");
  }
  return retrieval;
}

function normalizeSearchCoverage(coverage: SearchParams["coverage"]): SearchCoverageMode {
  if (coverage === undefined) return "full";
  if (coverage !== "full" && coverage !== "bounded") {
    throw new UsageError("coverage must be full or bounded");
  }
  return coverage;
}

function normalizeSearchBudget(budget: SearchParams["budget"]): SearchCoverageBudget | undefined {
  if (budget === undefined) return undefined;
  assertOptionalPositiveInteger(budget.work, "budget.work");
  assertOptionalPositiveInteger(budget.shards, "budget.shards");
  assertOptionalPositiveInteger(budget.timeMs, "budget.timeMs");
  const normalized: SearchCoverageBudget = {
    ...(budget.work !== undefined ? { work: budget.work } : {}),
    ...(budget.shards !== undefined ? { shards: budget.shards } : {}),
    ...(budget.timeMs !== undefined ? { timeMs: budget.timeMs } : {})
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}
