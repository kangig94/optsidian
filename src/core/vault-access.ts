import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";
import { optsidianCacheRoot } from "./cache-root.js";
import { isPrivatePathError, writePrivateFileAtomicSync } from "./private-path.js";
import type { SearchIndexWarmAccessStatus } from "./types.js";

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
const VAULT_ACCESS_MAX_AGE_DAYS_ENV = "OPTSIDIAN_SEARCH_VAULT_ACCESS_MAX_AGE_DAYS";
const DEFAULT_VAULT_ACCESS_MAX_AGE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VAULT_ACCESS_MAX_ENTRIES = 200;

export function recordVaultAccess(vaultRoot: string, options: VaultAccessOptions = {}): string | undefined {
  try {
    const env = options.env ?? process.env;
    const nowMs = options.nowMs ?? Date.now();
    const maxAgeMs = vaultAccessMaxAgeMs(env);
    const realpath = fs.realpathSync(vaultRoot);
    const statePath = vaultAccessPath(env);
    const existing = readVaultAccessFile(statePath);
    const entries = new Map<string, VaultAccessEntry>();
    for (const entry of recentVaultEntries(existing?.vaults ?? [], nowMs, maxAgeMs)) {
      entries.set(entry.realpath, entry);
    }
    entries.set(realpath, {
      realpath,
      lastAccessAtMs: nowMs,
      lastAccessAt: new Date(nowMs).toISOString()
    });
    writeVaultAccessFile(statePath, [...entries.values()], nowMs, maxAgeMs);
    return realpath;
  } catch (error) {
    if (isPrivatePathError(error)) throw error;
    return undefined;
  }
}

export function recentVaultAccessRoots(options: VaultAccessOptions = {}): string[] {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = vaultAccessMaxAgeMs(env);
  const state = readVaultAccessFile(vaultAccessPath(env));
  if (!state) return [];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of recentVaultEntries(state.vaults, nowMs, maxAgeMs)) {
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

export function vaultAccessStatus(vaultRoot: string, options: VaultAccessOptions = {}): SearchIndexWarmAccessStatus {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeDays = vaultAccessMaxAgeDays(env);
  const maxAgeMs = maxAgeDaysToMs(maxAgeDays);
  const statePath = vaultAccessPath(env);
  const realpath = fs.realpathSync(vaultRoot);
  const state = readVaultAccessFile(statePath);
  const entry = state?.vaults.find((candidate) => candidate.realpath === realpath);
  if (!entry) {
    return {
      path: statePath,
      recent: false,
      maxAgeDays
    };
  }

  const ageMs = nowMs - entry.lastAccessAtMs;
  const expiresAtMs = entry.lastAccessAtMs + maxAgeMs;
  return {
    path: statePath,
    recent: ageMs <= maxAgeMs,
    maxAgeDays,
    lastAccessAt: entry.lastAccessAt,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

export function vaultAccessPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), VAULT_ACCESS_FILE);
}

function recentVaultEntries(entries: readonly VaultAccessEntry[], nowMs: number, maxAgeMs: number): VaultAccessEntry[] {
  return entries
    .filter((entry) => nowMs - entry.lastAccessAtMs <= maxAgeMs)
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

function writeVaultAccessFile(filePath: string, entries: readonly VaultAccessEntry[], nowMs: number, maxAgeMs: number): void {
  const vaults = recentVaultEntries(entries, nowMs, maxAgeMs);
  writePrivateFileAtomicSync(filePath, `${JSON.stringify({
    schemaVersion: VAULT_ACCESS_SCHEMA_VERSION,
    vaults
  }, null, 2)}\n`, "Optsidian vault access file");
}

function vaultAccessMaxAgeDays(env: NodeJS.ProcessEnv): number {
  return parsePositiveInteger(
    env[VAULT_ACCESS_MAX_AGE_DAYS_ENV],
    DEFAULT_VAULT_ACCESS_MAX_AGE_DAYS,
    VAULT_ACCESS_MAX_AGE_DAYS_ENV
  );
}

function vaultAccessMaxAgeMs(env: NodeJS.ProcessEnv): number {
  return maxAgeDaysToMs(vaultAccessMaxAgeDays(env));
}

function maxAgeDaysToMs(days: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, days * MS_PER_DAY);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`${name} must be a positive integer`);
  return parsed;
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
