import { getValue, hasFlag, parseLineRange, parsePositiveInt, ParsedArgs, requireValue } from "../args.js";
import { DEFAULT_READ_MAX_CHARS, readVaultFile } from "../../core/read.js";
import { UsageError } from "../../errors.js";
import { parseFormat, renderRead } from "../render.js";

export function runRead(args: ParsedArgs, vaultRoot: string): void {
  const explicitLines = getValue(args, "lines");
  const head = parsePositiveInt(getValue(args, "head"), "head");
  const tail = parsePositiveInt(getValue(args, "tail"), "tail");
  const around = getValue(args, "around");
  const context = parsePositiveInt(getValue(args, "context"), "context") ?? 3;
  const maxChars = parsePositiveInt(getValue(args, "max-chars"), "max-chars") ?? DEFAULT_READ_MAX_CHARS;
  if (hasFlag(args, "json")) {
    throw new UsageError("Use format=json, not json");
  }
  const result = readVaultFile(vaultRoot, {
    path: requireValue(args, "path"),
    lines: explicitLines ? parseLineRange(explicitLines) : undefined,
    head,
    tail,
    around,
    context,
    maxChars
  });
  process.stdout.write(renderRead(result, parseFormat(getValue(args, "format"))));
}
