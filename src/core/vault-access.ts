import fs from "node:fs";
import path from "node:path";
import { optsidianCacheRoot } from "./cache-root.js";
import { atomicWriteFile } from "./write-file.js";

export type VaultAccessEntry = {
  realpath: string;
  lastAccessAtMs: number;
  lastAccessAt: string;
};

type VaultAccessFile = {
  schemaVersion: typeof VAULT_ACCESS_SCHEMA_VERSION;
  vaults: VaultAccessEntry[];
};

type VaultAccessOptions = {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
};

const VAULT_ACCESS_SCHEMA_VERSION = 1;
const VAULT_ACCESS_FILE = "vault-access.json";
const VAULT_ACCESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VAULT_ACCESS_MAX_ENTRIES = 200;

export function recordVaultAccess(vaultRoot: string, options: VaultAccessOptions = {}): string | undefined {
  try {
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now();
    const realpath = fs.realpathSync(vaultRoot);
    const statePath = vaultAccessPath(env);
    const existing = readVaultAccessFile(statePath);
    const entries = new Map<string, VaultAccessEntry>();
    for (const entry of recentVaultEntries(existing?.vaults ?? [], nowMs)) {
      entries.set(entry.realpath, entry);
    }
    entries.set(realpath, {
      realpath,
      lastAccessAtMs: nowMs,
      lastAccessAt: new Date(nowMs).toISOString()
    });
    writeVaultAccessFile(statePath, [...entries.values()], nowMs);
    return realpath;
  } catch {
    return undefined;
  }
}

export function recentVaultAccessRoots(options: VaultAccessOptions = {}): string[] {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const state = readVaultAccessFile(vaultAccessPath(env));
  if (!state) return [];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of recentVaultEntries(state.vaults, nowMs)) {
    if (seen.has(entry.realpath)) continue;
    seen.add(entry.realpath);
    try {
      if (fs.statSync(entry.realpath).isDirectory()) roots.push(entry.realpath);
    } catch {
      // Missing vaults are skipped; they will disappear on the next successful access write.
    }
  }
  return roots;
}

export function vaultAccessPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), VAULT_ACCESS_FILE);
}

function recentVaultEntries(entries: readonly VaultAccessEntry[], nowMs: number): VaultAccessEntry[] {
  return entries
    .filter((entry) => nowMs - entry.lastAccessAtMs <= VAULT_ACCESS_MAX_AGE_MS)
    .sort((left, right) => right.lastAccessAtMs - left.lastAccessAtMs || left.realpath.localeCompare(right.realpath))
    .slice(0, VAULT_ACCESS_MAX_ENTRIES);
}

function readVaultAccessFile(filePath: string): VaultAccessFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isVaultAccessFile(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeVaultAccessFile(filePath: string, entries: readonly VaultAccessEntry[], nowMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const vaults = recentVaultEntries(entries, nowMs);
  atomicWriteFile(filePath, `${JSON.stringify({
    schemaVersion: VAULT_ACCESS_SCHEMA_VERSION,
    vaults
  }, null, 2)}\n`);
}

function isVaultAccessFile(value: unknown): value is VaultAccessFile {
  return (
    isRecord(value) &&
    value.schemaVersion === VAULT_ACCESS_SCHEMA_VERSION &&
    Array.isArray(value.vaults) &&
    value.vaults.every(isVaultAccessEntry)
  );
}

function isVaultAccessEntry(value: unknown): value is VaultAccessEntry {
  return (
    isRecord(value) &&
    typeof value.realpath === "string" &&
    value.realpath.length > 0 &&
    typeof value.lastAccessAtMs === "number" &&
    Number.isFinite(value.lastAccessAtMs) &&
    typeof value.lastAccessAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
