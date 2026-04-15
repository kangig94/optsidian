import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath, SafePath } from "./path.js";
import { simpleDiff } from "./text.js";
import { atomicWriteFile } from "./write-file.js";
import type { ChangeCode, MutationResult, PatchParams } from "./types.js";

type AddHunk = { kind: "add"; path: string; contents: string };
type DeleteHunk = { kind: "delete"; path: string };
type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
};
type UpdateHunk = { kind: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };
type Hunk = AddHunk | DeleteHunk | UpdateHunk;

type Change = {
  code: ChangeCode;
  path: string;
  before?: string;
  after?: string;
  diff?: string;
};

export function applyVaultPatch(vaultRoot: string, params: PatchParams): MutationResult {
  const hunks = parsePatch(params.patch);
  if (hunks.length === 0) throw new UsageError("No files were modified.");

  const changes: Change[] = [];
  const overlay = new Map<string, string | undefined>();

  for (const hunk of hunks) {
    const change = applyHunk(hunk, vaultRoot, Boolean(params.dryRun), overlay);
    changes.push(change);
  }

  return {
    ok: true,
    command: "apply_patch",
    dryRun: Boolean(params.dryRun),
    changes: changes.map((change) => ({
      ...change,
      diff: change.before !== undefined && change.after !== undefined && change.before !== change.after
        ? simpleDiff(change.path, change.before, change.after)
        : change.diff
    }))
  };
}

function parsePatch(input: string): Hunk[] {
  const lines = stripLenientHeredoc(input.trim()).split(/\r?\n/);
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new UsageError("Invalid patch: The first line of the patch must be '*** Begin Patch'");
  }
  if (lines[lines.length - 1]?.trim() !== "*** End Patch") {
    throw new UsageError("Invalid patch: The last line of the patch must be '*** End Patch'");
  }

  const hunks: Hunk[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length);
      let contents = "";
      let count = 0;
      index += 1;
      while (index < lines.length - 1 && lines[index].startsWith("+")) {
        contents += `${lines[index].slice(1)}\n`;
        count += 1;
        index += 1;
      }
      if (count === 0) throw new UsageError(`Invalid patch hunk: Add file hunk for path '${filePath}' is empty`);
      hunks.push({ kind: "add", path: filePath, contents });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      hunks.push({ kind: "delete", path: line.slice("*** Delete File: ".length) });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length);
      index += 1;
      let movePath: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        movePath = lines[index].slice("*** Move to: ".length);
        index += 1;
      }
      const chunks: UpdateChunk[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (!lines[index].trim()) {
          index += 1;
          continue;
        }
        const parsed = parseUpdateChunk(lines, index, chunks.length === 0);
        chunks.push(parsed.chunk);
        index = parsed.nextIndex;
      }
      if (chunks.length === 0) throw new UsageError(`Invalid patch hunk: Update file hunk for path '${filePath}' is empty`);
      hunks.push({ kind: "update", path: filePath, movePath, chunks });
      continue;
    }
    throw new UsageError(`Invalid patch hunk: '${line}' is not a valid hunk header`);
  }
  return hunks;
}

function stripLenientHeredoc(input: string): string {
  const lines = input.split(/\r?\n/);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last?.endsWith("EOF") && lines.length >= 4) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return input;
}

function parseUpdateChunk(lines: string[], start: number, allowMissingContext: boolean): { chunk: UpdateChunk; nextIndex: number } {
  let index = start;
  let context: string | undefined;
  if (lines[index] === "@@") {
    index += 1;
  } else if (lines[index]?.startsWith("@@ ")) {
    context = lines[index].slice(3);
    index += 1;
  } else if (!allowMissingContext) {
    throw new UsageError(`Invalid patch hunk: Expected update hunk to start with @@, got '${lines[index]}'`);
  }

  const chunk: UpdateChunk = { context, oldLines: [], newLines: [], eof: false };
  let consumed = 0;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line === "*** End of File") {
      chunk.eof = true;
      index += 1;
      consumed += 1;
      break;
    }
    if (line.startsWith("*** ") || line === "@@" || line.startsWith("@@ ")) break;
    const prefix = line[0];
    const body = line.slice(1);
    if (prefix === " ") {
      chunk.oldLines.push(body);
      chunk.newLines.push(body);
    } else if (prefix === "-") {
      chunk.oldLines.push(body);
    } else if (prefix === "+") {
      chunk.newLines.push(body);
    } else {
      throw new UsageError(`Invalid patch hunk line: ${line}`);
    }
    index += 1;
    consumed += 1;
  }
  if (consumed === 0) throw new UsageError("Invalid patch hunk: Update hunk does not contain any lines");
  return { chunk, nextIndex: index };
}

function applyHunk(hunk: Hunk, vaultRoot: string, dryRun: boolean, overlay: Map<string, string | undefined>): Change {
  if (hunk.kind === "add") {
    const target = resolveVaultPath(vaultRoot, hunk.path);
    const before = readIfExists(target.abs, overlay);
    if (before !== undefined) {
      throw new UsageError(`Refusing to add existing file: ${target.rel}`);
    }
    overlay.set(target.abs, hunk.contents);
    if (!dryRun) atomicWriteFile(target.abs, hunk.contents);
    return { code: "A", path: target.rel, before: "", after: hunk.contents };
  }

  if (hunk.kind === "delete") {
    const target = resolveVaultPath(vaultRoot, hunk.path, { mustExist: true });
    const stat = fs.statSync(target.abs);
    if (stat.isDirectory()) throw new UsageError(`Failed to delete file ${target.rel}: path is a directory`);
    const before = readRequired(target, overlay);
    overlay.set(target.abs, undefined);
    if (!dryRun) fs.unlinkSync(target.abs);
    return { code: "D", path: target.rel, before, after: "" };
  }

  const source = resolveVaultPath(vaultRoot, hunk.path, { mustExist: true });
  const before = readRequired(source, overlay);
  const after = applyChunks(before, source.rel, hunk.chunks);
  if (hunk.movePath) {
    const dest = resolveVaultPath(vaultRoot, hunk.movePath);
    if (dest.abs === source.abs || sameExistingFile(source.abs, dest.abs)) {
      overlay.set(source.abs, after);
      if (!dryRun) atomicWriteFile(source.abs, after);
      return { code: "M", path: source.rel, before, after };
    }
    if (existsAfterOverlay(dest.abs, overlay)) {
      throw new UsageError(`Refusing to move over existing file: ${dest.rel}`);
    }
    overlay.set(dest.abs, after);
    overlay.set(source.abs, undefined);
    if (!dryRun) {
      atomicWriteFile(dest.abs, after);
      fs.unlinkSync(source.abs);
    }
    return { code: "M", path: dest.rel, before, after };
  }

  overlay.set(source.abs, after);
  if (!dryRun) atomicWriteFile(source.abs, after);
  return { code: "M", path: source.rel, before, after };
}

function sameExistingFile(left: string, right: string): boolean {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  return fs.realpathSync(left) === fs.realpathSync(right);
}

function readIfExists(filePath: string, overlay: Map<string, string | undefined>): string | undefined {
  if (overlay.has(filePath)) return overlay.get(filePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
}

function existsAfterOverlay(filePath: string, overlay: Map<string, string | undefined>): boolean {
  if (overlay.has(filePath)) return overlay.get(filePath) !== undefined;
  return fs.existsSync(filePath);
}

function readRequired(target: SafePath, overlay: Map<string, string | undefined>): string {
  const text = readIfExists(target.abs, overlay);
  if (text === undefined) throw new UsageError(`Failed to read file to update ${target.rel}`);
  return text;
}

function applyChunks(text: string, label: string, chunks: UpdateChunk[]): string {
  const original = text.split("\n");
  if (original.at(-1) === "") original.pop();
  const replacements: { start: number; oldLength: number; newLines: string[] }[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = seekSequence(original, [chunk.context], lineIndex, false);
      if (contextIndex === -1) throw new UsageError(`Failed to find context '${chunk.context}' in ${label}`);
      lineIndex = contextIndex + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({ start: original.length, oldLength: 0, newLines: chunk.newLines });
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(original, pattern, lineIndex, chunk.eof);
    if (found === -1 && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seekSequence(original, pattern, lineIndex, chunk.eof);
    }
    if (found === -1) {
      throw new UsageError(`Failed to find expected lines in ${label}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push({ start: found, oldLength: pattern.length, newLines });
    lineIndex = found + pattern.length;
  }

  let lines = [...original];
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    lines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

function seekSequence(lines: string[], pattern: string[], from: number, eof: boolean): number {
  if (pattern.length === 0) return from;
  const max = lines.length - pattern.length;
  for (let index = from; index <= max; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[index + offset] !== pattern[offset]) {
        ok = false;
        break;
      }
    }
    if (ok && (!eof || index + pattern.length === lines.length)) return index;
  }
  return -1;
}
