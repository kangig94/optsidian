import { decodeCliEscapes, getValue, hasFlag, parseLineRange, ParsedArgs, readValueOrFile, requireValue } from "../args.js";
import { editVaultFile } from "../../core/edit.js";
import type { EditSelector } from "../../core/types.js";
import { UsageError } from "../../errors.js";
import { renderMutation } from "../render.js";

export function runEdit(args: ParsedArgs, vaultRoot: string): void {
  const replacementRaw = getValue(args, "with");
  if (replacementRaw === undefined) throw new UsageError("Missing required argument: with=<text>|with=@<file>");
  const result = editVaultFile(vaultRoot, {
    path: requireValue(args, "path"),
    selector: parseSelector(args),
    replacement: readValueOrFile(replacementRaw),
    all: hasFlag(args, "all"),
    dryRun: hasFlag(args, "dry-run")
  });
  process.stdout.write(renderMutation(result));
}

function parseSelector(args: ParsedArgs): EditSelector {
  const selectors = ["replace", "regex", "line", "range"].filter((key) => getValue(args, key) !== undefined);
  if (selectors.length !== 1) {
    throw new UsageError("Use exactly one of replace=, regex=, line=, or range=");
  }

  const replace = getValue(args, "replace");
  if (replace !== undefined) return { kind: "replace", value: decodeCliEscapes(replace) };

  const regex = getValue(args, "regex");
  if (regex !== undefined) return { kind: "regex", value: regex };

  const line = getValue(args, "line");
  if (line !== undefined) return { kind: "line", value: parseLineNumber(line) };

  const range = getValue(args, "range");
  if (range !== undefined) return { kind: "range", value: parseLineRange(range) };

  throw new UsageError("No edit selector provided");
}

function parseLineNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError("line must be a positive integer");
  const line = Number(value);
  if (!Number.isSafeInteger(line) || line < 1) throw new UsageError("line must be a positive integer");
  return line;
}
