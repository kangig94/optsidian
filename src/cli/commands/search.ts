import { getValue, hasFlag, parsePositiveInt, ParsedArgs, requireValue } from "../args.js";
import { searchVault } from "../../core/search.js";
import { parseFormat, renderSearch } from "../render.js";

export function runSearch(args: ParsedArgs, vaultRoot: string, defaultContext = 0): void {
  const context = parsePositiveInt(getValue(args, "context"), "context") ?? defaultContext;
  const limit = parsePositiveInt(getValue(args, "limit"), "limit") ?? 50;
  const result = searchVault(vaultRoot, {
    query: requireValue(args, "query"),
    path: getValue(args, "path"),
    context,
    limit,
    includeHidden: hasFlag(args, "include-hidden"),
    all: hasFlag(args, "all"),
    caseSensitive: hasFlag(args, "case"),
    regex: hasFlag(args, "regex")
  });
  process.stdout.write(renderSearch(result, parseFormat(getValue(args, "format"))));
}
