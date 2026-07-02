import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";

export type SafePath = {
  abs: string;
  rel: string;
};

export type HardenedVaultFileRead = {
  safe: SafePath;
  bytes: Buffer;
  stat: fs.Stats;
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

export function readVaultFileHardened(vaultRoot: string, input: string): HardenedVaultFileRead {
  const resolved = resolveVaultPath(vaultRoot, input, { mustExist: true });
  const rootReal = vaultRealpath(vaultRoot);
  const rel = relativePathUnderVault(vaultRoot, rootReal, resolved.abs, input);
  const abs = path.join(rootReal, rel);
  const safe = { abs, rel: rel.split(path.sep).join("/") };
  const parentReal = fs.realpathSync(path.dirname(abs));
  if (!isUnder(rootReal, parentReal)) {
    throw new UsageError(`Path parent resolves outside the vault: ${input}`);
  }
  assertNoSymlinkComponents(rootReal, abs, input);
  const before = fs.lstatSync(abs);
  if (before.isSymbolicLink()) {
    throw new UsageError(`Path contains a symbolic link: ${input}`);
  }
  if (!before.isFile()) {
    throw new UsageError(`Path is not a file: ${input}`);
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, hardenedReadFlags());
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new UsageError(`Path is not a file: ${input}`);
    }
    if (!sameFileIdentity(before, opened)) {
      throw new UsageError(`Path changed while opening: ${input}`);
    }
    assertOpenFileStillUnderVault(rootReal, abs, opened, input);
    assertNoSymlinkComponents(rootReal, abs, input);
    const bytes = fs.readFileSync(fd);
    return { safe, bytes, stat: opened };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

function hardenedReadFlags(): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  return fs.constants.O_RDONLY | noFollow;
}

function relativePathUnderVault(vaultRoot: string, rootReal: string, abs: string, input: string): string {
  const rootAbs = path.resolve(vaultRoot);
  const candidate = path.resolve(abs);
  let rel: string;
  if (isUnder(rootReal, candidate)) {
    rel = path.relative(rootReal, candidate);
  } else if (isUnder(rootAbs, candidate)) {
    rel = path.relative(rootAbs, candidate);
  } else {
    throw new UsageError(`Path is outside the vault: ${input}`);
  }
  if (!rel || rel === ".") {
    throw new UsageError(`Path is not a file: ${input}`);
  }
  if (rel.split(path.sep).some((part) => part === "..")) {
    throw new UsageError(`Path is outside the vault: ${input}`);
  }
  return rel;
}

function assertNoSymlinkComponents(rootReal: string, abs: string, input: string): void {
  const rel = path.relative(rootReal, path.resolve(abs));
  if (!rel || rel === ".") return;
  if (rel.split(path.sep).some((part) => part === "..")) {
    throw new UsageError(`Path is outside the vault: ${input}`);
  }
  let current = rootReal;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new UsageError(`Path contains a symbolic link: ${input}`);
    }
  }
}

function assertOpenFileStillUnderVault(rootReal: string, abs: string, opened: fs.Stats, input: string): void {
  const real = fs.realpathSync(abs);
  if (!isUnder(rootReal, real)) {
    throw new UsageError(`Path resolves outside the vault: ${input}`);
  }
  const current = fs.statSync(real);
  if (!sameFileIdentity(current, opened)) {
    throw new UsageError(`Path changed while opening: ${input}`);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
