import { getValue, parsePositiveInt, ParsedArgs } from "../args.js";
import { parseFormat, renderSearch } from "../render.js";
import { searchVault } from "../../core/search.js";

export async function runSearch(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const result = await searchVault(vaultRoot, {
    query: getValue(args, "query"),
    path: getValue(args, "path"),
    tags: parseList(getValue(args, "tag")),
    fields: parseList(getValue(args, "field")),
    limit: parsePositiveInt(getValue(args, "limit"), "limit")
  });
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [];
}
