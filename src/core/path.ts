import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";

export type SafePath = {
  abs: string;
  rel: string;
};

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isUnder(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForCompare(path.resolve(root));
  const normalizedCandidate = normalizeForCompare(path.resolve(candidate));
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function vaultRealpath(vaultRoot: string): string {
  return fs.realpathSync(vaultRoot);
}

export function vaultRelative(vaultRoot: string, abs: string): string {
  const rel = path.relative(vaultRoot, abs) || ".";
  return rel.split(path.sep).join("/");
}

function nearestExistingParent(abs: string): string {
  let current = path.resolve(abs);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function resolveVaultPath(vaultRoot: string, input: string, options: { mustExist?: boolean; forNew?: boolean } = {}): SafePath {
  if (!input) {
    throw new UsageError("path must not be empty");
  }
  const rootReal = vaultRealpath(vaultRoot);
  const abs = path.resolve(path.isAbsolute(input) ? input : path.join(vaultRoot, input));

  if (!isUnder(vaultRoot, abs) && !isUnder(rootReal, abs)) {
    throw new UsageError(`Path is outside the vault: ${input}`);
  }

  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!isUnder(rootReal, real)) {
      throw new UsageError(`Path resolves outside the vault: ${input}`);
    }
  } else if (options.mustExist) {
    throw new UsageError(`Path does not exist: ${input}`);
  } else {
    const parent = nearestExistingParent(path.dirname(abs));
    const parentReal = fs.realpathSync(parent);
    if (!isUnder(rootReal, parentReal)) {
      throw new UsageError(`Path parent resolves outside the vault: ${input}`);
    }
  }

  return { abs, rel: vaultRelative(vaultRoot, abs) };
}

export function shouldSkipDir(name: string, includeHidden: boolean): boolean {
  if ([".obsidian", ".git", ".trash", "node_modules"].includes(name)) return true;
  return !includeHidden && name.startsWith(".");
}

export function walkFiles(root: string, start: string, options: { includeHidden: boolean; all: boolean }): string[] {
  const output: string[] = [];
  const entries = fs.readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(start, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name, options.includeHidden)) {
        output.push(...walkFiles(root, abs, options));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!options.all && path.extname(entry.name).toLowerCase() !== ".md") continue;
    output.push(abs);
  }
  return output;
}
