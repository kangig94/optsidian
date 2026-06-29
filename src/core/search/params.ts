import { UsageError } from "../../errors.js";
import type { SearchExecutionBudget, SearchExecutionMode, SearchField, SearchParams } from "../types.js";
import { assertOptionalPositiveInteger } from "../validation.js";
import type { NormalizedSearchParams, PathFilter } from "./internal-types.js";
import { SEARCH_PROPERTIES } from "./schema.js";

export const MAX_SEARCH_QUERY_LENGTH = 4096;

export function normalizeSearchParams(params: SearchParams): NormalizedSearchParams {
  assertOptionalPositiveInteger(params.limit, "limit");
  const mode = normalizeSearchMode(params.mode);
  const budget = normalizeSearchBudget(params.budget);
  if (budget && mode !== "approximate") {
    throw new UsageError("search budget requires mode=approximate");
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
    mode,
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

function normalizeSearchMode(mode: SearchParams["mode"]): SearchExecutionMode {
  if (mode === undefined) return "exhaustive";
  if (mode !== "exhaustive" && mode !== "approximate") {
    throw new UsageError("mode must be exhaustive or approximate");
  }
  return mode;
}

function normalizeSearchBudget(budget: SearchParams["budget"]): SearchExecutionBudget | undefined {
  if (budget === undefined) return undefined;
  assertOptionalPositiveInteger(budget.work, "budget.work");
  assertOptionalPositiveInteger(budget.shards, "budget.shards");
  assertOptionalPositiveInteger(budget.timeMs, "budget.timeMs");
  const normalized: SearchExecutionBudget = {
    ...(budget.work !== undefined ? { work: budget.work } : {}),
    ...(budget.shards !== undefined ? { shards: budget.shards } : {}),
    ...(budget.timeMs !== undefined ? { timeMs: budget.timeMs } : {})
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}
