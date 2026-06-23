import { getValue, hasFlag, parsePositiveInt, type ParsedArgs } from "../args.js";
import { parseFormat, renderSearch } from "../render.js";
import { createSearchDaemonClient } from "../../daemon/client.js";
import { UsageError } from "../../errors.js";

const SEARCH_FIELDS = ["title", "aliases", "tags", "headings", "path", "body"] as const;

export async function runSearch(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const query = searchQuery(args);
  const tags = parseList(getValue(args, "tag"));
  const fields = parseList(getValue(args, "field"));
  validateSearchRequest(query, tags, fields);
  const result = await createSearchDaemonClient().search({
    vault: vaultRoot,
    query: query?.trim() || undefined,
    path: getValue(args, "path"),
    tags,
    fields,
    limit: parsePositiveInt(getValue(args, "limit"), "limit"),
    debug: hasFlag(args, "debug")
  });
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
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

function validateSearchRequest(query: string | undefined, tags: string[] | undefined, fields: string[] | undefined): void {
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
  if (!trimmedQuery && tags === undefined) {
    throw new UsageError("search requires query=<text> or tag=<tag>");
  }
}
