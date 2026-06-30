import { getValue, hasFlag, parsePositiveInt, type ParsedArgs } from "../args.js";
import { parseFormat, renderSearch } from "../render.js";
import { createSearchDaemonClient } from "../../daemon/client.js";
import { UsageError } from "../../errors.js";
import type { SearchRequestPayload } from "../../daemon/protocol.js";
import type { SearchCoverageBudget, SearchCoverageMode, SearchRetrievalMode } from "../../core/types.js";

const SEARCH_FIELDS = ["title", "aliases", "tags", "headings", "path", "body"] as const;

export async function runSearch(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const result = await createSearchDaemonClient().search(searchRequestFromArgs(args, vaultRoot));
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
}

export function searchRequestFromArgs(args: ParsedArgs, vaultRoot: string): SearchRequestPayload {
  const query = searchQuery(args);
  const tags = parseList(getValue(args, "tag"));
  const fields = parseList(getValue(args, "field"));
  const budget = parseSearchBudget(args);
  const coverage = parseSearchCoverage(args, budget !== undefined);
  const retrieval = parseSearchRetrieval(args);
  validateSearchRequest(query, tags, fields, retrieval);
  return {
    vault: vaultRoot,
    query: query?.trim() || undefined,
    path: getValue(args, "path"),
    tags,
    fields,
    limit: parsePositiveInt(getValue(args, "limit"), "limit"),
    debug: hasFlag(args, "debug"),
    ...(retrieval ? { retrieval } : {}),
    ...(coverage ? { coverage } : {}),
    ...(budget ? { budget } : {})
  };
}

function searchQuery(args: ParsedArgs): string | undefined {
  const explicitQuery = getValue(args, "query");
  if (explicitQuery !== undefined) {
    if (args.positionals.length > 0) {
      throw new UsageError("Use either positional search terms or query=<text>, not both");
    }
    return explicitQuery;
  }
  if (args.positionals.length === 0) return undefined;
  return args.positionals.join(" ");
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [];
}

function parseSearchRetrieval(args: ParsedArgs): SearchRetrievalMode | undefined {
  const raw = getValue(args, "retrieval")?.trim().toLowerCase();
  if (raw !== undefined && raw !== "lexical" && raw !== "vector" && raw !== "hybrid") {
    throw new UsageError("retrieval must be lexical, vector, or hybrid");
  }
  return raw as SearchRetrievalMode | undefined;
}

function parseSearchCoverage(args: ParsedArgs, hasBudget: boolean): SearchCoverageMode | undefined {
  const raw = getValue(args, "coverage")?.trim().toLowerCase();
  if (raw !== undefined && raw !== "full" && raw !== "bounded") {
    throw new UsageError("coverage must be full or bounded");
  }
  const explicit = raw as SearchCoverageMode | undefined;
  if (explicit === "full" && hasBudget) {
    throw new UsageError("search budgets require coverage=bounded");
  }
  if (explicit) return explicit;
  return hasBudget ? "bounded" : undefined;
}

function parseSearchBudget(args: ParsedArgs): SearchCoverageBudget | undefined {
  const budget: SearchCoverageBudget = {
    ...(getValue(args, "budget-work") !== undefined
      ? { work: parsePositiveInt(getValue(args, "budget-work"), "budget-work") }
      : {}),
    ...(getValue(args, "budget-shards") !== undefined
      ? { shards: parsePositiveInt(getValue(args, "budget-shards"), "budget-shards") }
      : {}),
    ...(getValue(args, "budget-time-ms") !== undefined
      ? { timeMs: parsePositiveInt(getValue(args, "budget-time-ms"), "budget-time-ms") }
      : {})
  };
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function validateSearchRequest(
  query: string | undefined,
  tags: string[] | undefined,
  fields: string[] | undefined,
  retrieval: SearchRetrievalMode | undefined
): void {
  const trimmedQuery = query?.trim();
  if (query !== undefined && !trimmedQuery) {
    throw new UsageError("query must not be empty");
  }
  if (tags !== undefined && tags.length === 0) {
    throw new UsageError("tag must include at least one non-empty tag");
  }
  if (fields !== undefined && fields.length === 0) {
    throw new UsageError(`field must include at least one of: ${SEARCH_FIELDS.join(", ")}`);
  }
  if (fields) {
    for (const field of fields) {
      if (!SEARCH_FIELDS.includes(field.trim().toLowerCase() as (typeof SEARCH_FIELDS)[number])) {
        throw new UsageError(`field must be one of: ${SEARCH_FIELDS.join(", ")}`);
      }
    }
  }
  if (fields && !trimmedQuery) {
    throw new UsageError("field=<field> requires query=<text>");
  }
  if (retrieval === "vector") {
    if (!trimmedQuery) throw new UsageError("retrieval=vector requires query=<text>");
    if (fields) throw new UsageError("field=<field> is not supported with retrieval=vector");
  }
  if (!trimmedQuery && tags === undefined) {
    throw new UsageError("search requires query=<text> or tag=<tag>");
  }
}
