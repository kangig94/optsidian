import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import { decodeUtf8, lineNumbered, splitText } from "./text.js";
import type { ReadParams, ReadResult } from "./types.js";
import { assertLineRange, assertOptionalNonNegativeInteger, assertOptionalPositiveInteger } from "./validation.js";

export const DEFAULT_READ_MAX_CHARS = 20_000;

export function readVaultFile(vaultRoot: string, params: ReadParams): ReadResult {
  validateReadParams(params);
  const target = resolveVaultPath(vaultRoot, params.path, { mustExist: true });
  const text = decodeUtf8(fs.readFileSync(target.abs), target.rel);
  const { lines } = splitText(text);

  let start = 1;
  let end = lines.length;
  const selectors = [params.lines !== undefined, params.head !== undefined, params.tail !== undefined, params.around !== undefined].filter(Boolean).length;
  if (selectors > 1) {
    throw new UsageError("Use only one of lines=, head=, tail=, or around=");
  }

  if (params.lines) {
    start = params.lines.start;
    end = Math.min(params.lines.end, lines.length);
  } else if (params.head !== undefined) {
    start = 1;
    end = Math.min(params.head, lines.length);
  } else if (params.tail !== undefined) {
    start = Math.max(1, lines.length - params.tail + 1);
    end = lines.length;
  } else if (params.around !== undefined) {
    const index = lines.findIndex((line) => line.includes(params.around ?? ""));
    if (index === -1) {
      throw new UsageError(`No line contains: ${params.around}`);
    }
    const context = params.context ?? 3;
    start = Math.max(1, index + 1 - context);
    end = Math.min(lines.length, index + 1 + context);
  }

  if (params.lines && start > lines.length) {
    throw new UsageError(`Start line ${start} is beyond end of file (${lines.length})`);
  }
  if (start > lines.length && lines.length > 0) {
    throw new UsageError(`Start line ${start} is beyond end of file (${lines.length})`);
  }

  const selected = lines.slice(start - 1, end);
  const numbered = lineNumbered(selected, start);
  const maxChars = params.maxChars ?? DEFAULT_READ_MAX_CHARS;
  const truncated = numbered.length > maxChars;
  const numberedText = truncated ? `${numbered.slice(0, maxChars)}\n... truncated ...` : numbered;
  const content = selected.join("\n");

  return {
    ok: true,
    command: "read",
    path: target.rel,
    range: { start, end, total: lines.length },
    truncated,
    content: content.length > maxChars ? `${content.slice(0, maxChars)}\n... truncated ...` : content,
    numberedText
  };
}

function validateReadParams(params: ReadParams): void {
  if (params.lines) assertLineRange(params.lines, "lines");
  assertOptionalPositiveInteger(params.head, "head");
  assertOptionalPositiveInteger(params.tail, "tail");
  assertOptionalNonNegativeInteger(params.context, "context");
  assertOptionalPositiveInteger(params.maxChars, "maxChars");
}
