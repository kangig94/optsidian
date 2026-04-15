import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import { joinText, simpleDiff, splitText } from "./text.js";
import { atomicWriteFile } from "./write-file.js";
import type { EditParams, MutationResult } from "./types.js";
import { assertLineRange, assertPositiveInteger } from "./validation.js";

export function editVaultFile(vaultRoot: string, params: EditParams): MutationResult {
  validateEditParams(params);
  const target = resolveVaultPath(vaultRoot, params.path, { mustExist: true });
  const before = fs.readFileSync(target.abs, "utf8");
  const after = applyEdit(before, params);
  if (before === after) {
    throw new UsageError("Edit produced no changes");
  }
  if (!params.dryRun) {
    atomicWriteFile(target.abs, after);
  }
  return {
    ok: true,
    command: "edit",
    dryRun: Boolean(params.dryRun),
    changes: [{ code: "M", path: target.rel, before, after, diff: simpleDiff(target.rel, before, after) }]
  };
}

function validateEditParams(params: EditParams): void {
  if (params.selector.kind === "line") {
    assertPositiveInteger(params.selector.value, "line");
  } else if (params.selector.kind === "range") {
    assertLineRange(params.selector.value, "range");
  }
}

function applyEdit(before: string, params: EditParams): string {
  switch (params.selector.kind) {
    case "replace": {
      const needle = params.selector.value;
      const count = occurrences(before, needle);
      if (count === 0) throw new UsageError("replace text was not found");
      if (count > 1 && !params.all) throw new UsageError(`replace text matched ${count} times; pass all to replace all`);
      return params.all ? before.split(needle).join(params.replacement) : replaceFirstLiteral(before, needle, params.replacement);
    }
    case "regex": {
      let regex: RegExp;
      try {
        regex = new RegExp(params.selector.value, "g");
      } catch (error) {
        throw new UsageError(`Invalid regex: ${(error as Error).message}`);
      }
      const matches = [...before.matchAll(regex)];
      if (matches.length === 0) throw new UsageError("regex did not match");
      if (matches.length > 1 && !params.all) throw new UsageError(`regex matched ${matches.length} times; pass all to replace all`);
      if (params.all) return before.replace(regex, () => params.replacement);
      const first = matches[0];
      return `${before.slice(0, first.index)}${params.replacement}${before.slice((first.index ?? 0) + first[0].length)}`;
    }
    case "line": {
      const line = params.selector.value;
      if (!Number.isSafeInteger(line) || line < 1) throw new UsageError("line must be a positive integer");
      const parts = splitText(before);
      if (line > parts.lines.length) throw new UsageError(`line ${line} is beyond end of file (${parts.lines.length})`);
      parts.lines[line - 1] = params.replacement;
      return joinText(parts);
    }
    case "range": {
      const range = params.selector.value;
      const parts = splitText(before);
      if (range.end > parts.lines.length) throw new UsageError(`range end ${range.end} is beyond end of file (${parts.lines.length})`);
      parts.lines.splice(range.start - 1, range.end - range.start + 1, ...splitText(params.replacement).lines);
      return joinText(parts);
    }
  }
}

function replaceFirstLiteral(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index === -1) return text;
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

function occurrences(text: string, needle: string): number {
  if (needle === "") throw new UsageError("replace text must not be empty");
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
