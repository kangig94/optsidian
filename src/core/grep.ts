import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath, vaultRelative, walkFiles } from "./path.js";
import { decodeUtf8, splitText } from "./text.js";
import type { GrepLine, GrepParams, GrepResult } from "./types.js";
import { assertOptionalNonNegativeInteger, assertOptionalPositiveInteger } from "./validation.js";

export function grepVault(vaultRoot: string, params: GrepParams): GrepResult {
  validateGrepParams(params);
  const start = resolveVaultPath(vaultRoot, params.path ?? ".", { mustExist: true });
  const context = params.context ?? 0;
  const limit = params.limit ?? 50;
  const stat = fs.statSync(start.abs);
  const files = stat.isDirectory()
    ? walkFiles(vaultRoot, start.abs, { includeHidden: Boolean(params.includeHidden), all: Boolean(params.all) })
    : [start.abs];
  const matches: GrepResult["matches"] = [];
  const matcher = buildMatcher(params.query, {
    regexMode: Boolean(params.regex),
    caseSensitive: Boolean(params.caseSensitive)
  });

  for (const file of files) {
    if (matches.length >= limit) break;
    let text: string;
    try {
      text = decodeUtf8(fs.readFileSync(file), vaultRelative(vaultRoot, file));
    } catch {
      continue;
    }
    const lines = splitText(text).lines;
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index])) continue;
      matches.push({
        path: vaultRelative(vaultRoot, file),
        line: index + 1,
        text: lines[index],
        contextBefore: contextLines(lines, Math.max(0, index - context), index),
        contextAfter: contextLines(lines, index + 1, Math.min(lines.length, index + 1 + context))
      });
      if (matches.length >= limit) break;
    }
  }

  return { ok: true, command: "grep", query: params.query, matches, count: matches.length };
}

function validateGrepParams(params: GrepParams): void {
  assertOptionalNonNegativeInteger(params.context, "context");
  assertOptionalPositiveInteger(params.limit, "limit");
}

function buildMatcher(query: string, options: { regexMode: boolean; caseSensitive: boolean }): (line: string) => boolean {
  if (options.regexMode) {
    let regex: RegExp;
    try {
      regex = new RegExp(query, options.caseSensitive ? "" : "i");
    } catch (error) {
      throw new UsageError(`Invalid regex: ${(error as Error).message}`);
    }
    return (line) => regex.test(line);
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
}

function contextLines(lines: string[], start: number, end: number): GrepLine[] {
  const result: GrepLine[] = [];
  for (let index = start; index < end; index += 1) {
    result.push({ line: index + 1, text: lines[index] });
  }
  return result;
}
