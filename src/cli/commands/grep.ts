import { getValue, hasFlag, parsePositiveInt, ParsedArgs, requireValue } from "../args.js";
import { grepVault } from "../../core/grep.js";
import { parseFormat, renderGrep } from "../render.js";

export function runGrep(args: ParsedArgs, vaultRoot: string): void {
  const context = parsePositiveInt(getValue(args, "context"), "context") ?? 0;
  const limit = parsePositiveInt(getValue(args, "limit"), "limit") ?? 50;
  const result = grepVault(vaultRoot, {
    query: requireValue(args, "query"),
    path: getValue(args, "path"),
    context,
    limit,
    includeHidden: hasFlag(args, "include-hidden"),
    all: hasFlag(args, "all"),
    caseSensitive: hasFlag(args, "case"),
    regex: hasFlag(args, "regex")
  });
  process.stdout.write(renderGrep(result, parseFormat(getValue(args, "format"))));
}
