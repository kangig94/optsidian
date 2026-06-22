import { getValue, hasFlag, parsePositiveInt, type ParsedArgs } from "../args.js";
import { parseFormat, renderSearch } from "../render.js";
import { searchVault } from "../../core/search.js";
import { pokeSearchIndexDaemonWarmRecent } from "../../core/search-index-daemon.js";
import { UsageError } from "../../errors.js";

export async function runSearch(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const result = await searchVault(vaultRoot, {
    query: searchQuery(args),
    path: getValue(args, "path"),
    tags: parseList(getValue(args, "tag")),
    fields: parseList(getValue(args, "field")),
    limit: parsePositiveInt(getValue(args, "limit"), "limit"),
    debug: hasFlag(args, "debug")
  });
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
  pokeSearchIndexDaemonWarmRecent();
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
