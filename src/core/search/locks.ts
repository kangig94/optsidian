import fs from "node:fs";
import path from "node:path";
import { RuntimeError } from "../../errors.js";
import { vaultRealpath } from "../path.js";
import type { SearchAnalyzer } from "./analyzer.js";
import type {
  SearchIndexReconcileStatus,
  SearchReconcileReason
} from "../types.js";
import {
  SEARCH_INDEX_WRITER_LOCK_DIR,
  SEARCH_INDEX_WRITER_LOCK_POLL_MS,
  SEARCH_INDEX_WRITER_LOCK_STALE_MS,
  SEARCH_INDEX_WRITER_LOCK_WAIT_MS,
  SEARCH_RECONCILE_LOCK_DIR,
  SEARCH_RECONCILE_LOCK_STALE_MS
} from "./constants.js";
import type {
  SearchIndexWriterLock,
  SearchReconcileLock,
  SearchReconcileLockOwner
} from "./internal-types.js";

export const SEARCH_RECONCILE_REASONS = [
  "stale-tier",
  "stale-manifest",
  "incompatible",
  "terminal-analyzer-failure",
  "manual"
] as const satisfies readonly SearchReconcileReason[];

let searchReconcileLockStaleMs = SEARCH_RECONCILE_LOCK_STALE_MS;
let searchIndexWriterLockStaleMs = SEARCH_INDEX_WRITER_LOCK_STALE_MS;
let searchIndexWriterLockWaitMs = SEARCH_INDEX_WRITER_LOCK_WAIT_MS;

export function setSearchReconcileLockStaleMsForTests(value: number | undefined): void {
  searchReconcileLockStaleMs = value ?? SEARCH_RECONCILE_LOCK_STALE_MS;
}

export function setSearchIndexWriterLockStaleMsForTests(value: number | undefined): void {
  searchIndexWriterLockStaleMs = value ?? SEARCH_INDEX_WRITER_LOCK_STALE_MS;
}

export function setSearchIndexWriterLockWaitMsForTests(value: number | undefined): void {
  searchIndexWriterLockWaitMs = value ?? SEARCH_INDEX_WRITER_LOCK_WAIT_MS;
}

export function isSearchReconcileReason(value: string): value is SearchReconcileReason {
  return (SEARCH_RECONCILE_REASONS as readonly string[]).includes(value);
}

export function acquireSearchReconcileLock(
  cacheDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: SearchReconcileReason
): SearchReconcileLock | undefined {
  fs.mkdirSync(cacheDir, { recursive: true });
  const lockDir = path.join(cacheDir, SEARCH_RECONCILE_LOCK_DIR);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      writeSearchReconcileLockOwner(lockDir, vaultRoot, analyzer, reason);
      return {
        release() {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (!isPathExistsError(error)) throw error;
      if (attempt === 0 && removeStaleSearchReconcileLock(lockDir)) continue;
      return undefined;
    }
  }
  return undefined;
}

function writeSearchReconcileLockOwner(
  lockDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: SearchReconcileReason
): void {
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    reason,
    vaultRoot: vaultRealpath(vaultRoot),
    analyzer: analyzer.identity
  };
  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
  } catch {
    // The lock itself is the directory; owner metadata is best-effort diagnostics.
  }
}

export function readSearchReconcileStatus(cacheDir: string): SearchIndexReconcileStatus | undefined {
  const lockDir = path.join(cacheDir, SEARCH_RECONCILE_LOCK_DIR);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }

  const owner = readSearchReconcileLockOwner(lockDir);
  return {
    active: true,
    stale: isSearchReconcileLockStale(stat),
    ...(owner?.reason ? { reason: owner.reason } : {}),
    ...(owner?.startedAt ? { startedAt: owner.startedAt } : {}),
    ...(owner?.pid !== undefined ? { pid: owner.pid } : {})
  };
}

function readSearchReconcileLockOwner(lockDir: string): SearchReconcileLockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      ...(typeof parsed.reason === "string" && isSearchReconcileReason(parsed.reason) ? { reason: parsed.reason } : {}),
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) ? { pid: parsed.pid } : {})
    };
  } catch {
    return undefined;
  }
}

export async function withSearchIndexWriterLock<T>(
  cacheDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: string,
  run: () => T | Promise<T>
): Promise<T> {
  const lock = await acquireSearchIndexWriterLock(cacheDir, vaultRoot, analyzer, reason);
  try {
    return await run();
  } finally {
    lock.release();
  }
}

async function acquireSearchIndexWriterLock(
  cacheDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: string
): Promise<SearchIndexWriterLock> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const lockDir = path.join(cacheDir, SEARCH_INDEX_WRITER_LOCK_DIR);
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeSearchIndexWriterLockOwner(lockDir, vaultRoot, analyzer, reason);
      return {
        release() {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (!isPathExistsError(error)) throw error;
      if (removeStaleSearchIndexWriterLock(lockDir)) continue;
      if (Date.now() - startedAt >= searchIndexWriterLockWaitMs) {
        throw new RuntimeError(`Timed out waiting for search index writer lock: ${lockDir}`);
      }
      await sleep(Math.min(SEARCH_INDEX_WRITER_LOCK_POLL_MS, Math.max(1, searchIndexWriterLockWaitMs)));
    }
  }
}

function writeSearchIndexWriterLockOwner(lockDir: string, vaultRoot: string, analyzer: SearchAnalyzer, reason: string): void {
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    reason,
    vaultRoot: vaultRealpath(vaultRoot),
    analyzer: analyzer.identity
  };
  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
  } catch {
    // The lock itself is the directory; owner metadata is best-effort diagnostics.
  }
}

export async function waitForSearchIndexWriterIdle(cacheDir: string): Promise<void> {
  const lockDir = path.join(cacheDir, SEARCH_INDEX_WRITER_LOCK_DIR);
  const startedAt = Date.now();
  while (isSearchIndexWriterLockActive(cacheDir)) {
    if (removeStaleSearchIndexWriterLock(lockDir)) continue;
    if (Date.now() - startedAt >= searchIndexWriterLockWaitMs) {
      throw new RuntimeError(`Timed out waiting for search index writer lock: ${lockDir}`);
    }
    await sleep(Math.min(SEARCH_INDEX_WRITER_LOCK_POLL_MS, Math.max(1, searchIndexWriterLockWaitMs)));
  }
}

export function isSearchIndexWriterLockActive(cacheDir: string): boolean {
  const lockDir = path.join(cacheDir, SEARCH_INDEX_WRITER_LOCK_DIR);
  try {
    fs.statSync(lockDir);
    return true;
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

function removeStaleSearchIndexWriterLock(lockDir: string): boolean {
  if (searchIndexWriterLockStaleMs < 1) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
  if (Date.now() - stat.mtimeMs < searchIndexWriterLockStaleMs) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function removeStaleSearchReconcileLock(lockDir: string): boolean {
  if (searchReconcileLockStaleMs < 1) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
  if (!isSearchReconcileLockStale(stat)) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function isSearchReconcileLockStale(stat: fs.Stats): boolean {
  return searchReconcileLockStaleMs >= 1 && Date.now() - stat.mtimeMs >= searchReconcileLockStaleMs;
}

function isPathExistsError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
