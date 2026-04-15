import { getValue, parsePositiveInt, ParsedArgs, requireValue } from "../args.js";
import { parseFormat, renderSearch } from "../render.js";
import { searchVault } from "../../core/search.js";

export async function runSearch(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const result = await searchVault(vaultRoot, {
    query: requireValue(args, "query"),
    path: getValue(args, "path"),
    limit: parsePositiveInt(getValue(args, "limit"), "limit")
  });
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
}
