import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../errors.js";
import { vaultRealpath } from "../path.js";
import {
  analyzerIdentityKey,
  type SearchAnalyzer
} from "./analyzer.js";
import type {
  SearchIndexReconcileRunStatus,
  SearchIndexReconcileSnapshot,
  SearchReconcileReason
} from "../types.js";
import { atomicWriteFile } from "../write-file.js";
import {
  SEARCH_RECONCILE_COMMAND,
  SEARCH_RECONCILE_ERROR_MAX_LENGTH,
  SEARCH_RECONCILE_STATUS_FILE,
  SEARCH_RECONCILE_STATUS_SCHEMA_VERSION
} from "./constants.js";
import {
  SEARCH_RECONCILE_REASONS,
  isSearchReconcileReason
} from "./locks.js";
import type {
  ActiveSearchReconcile,
  SearchReconcileChildSpawner,
  SearchReconcileStatusFile
} from "./internal-types.js";

const activeSearchReconciles = new Map<string, ActiveSearchReconcile>();
let spawnSearchReconcileChild: SearchReconcileChildSpawner = spawnDetachedSearchReconcileChild;

export function requestSearchReconcile(vaultRoot: string, analyzer: SearchAnalyzer, reason: SearchReconcileReason): void {
  const bin = process.argv[1];
  if (!bin) return;

  const root = vaultRealpath(vaultRoot);
  const key = `${root}\0${analyzerIdentityKey(analyzer.identity)}`;
  const active = activeSearchReconciles.get(key);
  if (active) {
    active.reasons.add(reason);
    return;
  }

  const request: ActiveSearchReconcile = { reasons: new Set([reason]) };
  activeSearchReconciles.set(key, request);

  try {
    const child = spawnSearchReconcileChild(bin, [SEARCH_RECONCILE_COMMAND, root, `reason=${reason}`], process.env);
    const clear = () => {
      if (activeSearchReconciles.get(key) === request) activeSearchReconciles.delete(key);
    };
    child.once("error", clear);
    child.once("exit", clear);
    child.once("close", clear);
    child.unref();
  } catch {
    activeSearchReconciles.delete(key);
  }
}

export function searchReconcileCommand(): string {
  return SEARCH_RECONCILE_COMMAND;
}

export function parseSearchReconcileReason(raw: string | undefined): SearchReconcileReason {
  if (raw === undefined || raw.trim() === "") return "manual";
  const value = raw.startsWith("reason=") ? raw.slice("reason=".length) : raw;
  if (isSearchReconcileReason(value)) return value;
  throw new UsageError(`search reconcile reason must be one of: ${SEARCH_RECONCILE_REASONS.join(", ")}`);
}

export function setSearchReconcileChildSpawnerForTests(spawner: SearchReconcileChildSpawner | undefined): void {
  spawnSearchReconcileChild = spawner ?? spawnDetachedSearchReconcileChild;
  activeSearchReconciles.clear();
}

function spawnDetachedSearchReconcileChild(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: "ignore",
    env
  });
}

export function readSearchReconcileSnapshot(cacheDir: string): SearchIndexReconcileSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, SEARCH_RECONCILE_STATUS_FILE), "utf8")) as unknown;
    if (!isSearchReconcileStatusFile(parsed)) return undefined;
    const snapshot: SearchIndexReconcileSnapshot = {
      ...(parsed.lastRun ? { lastRun: parsed.lastRun } : {}),
      ...(parsed.lastSuccess ? { lastSuccess: parsed.lastSuccess } : {}),
      ...(parsed.lastFailure ? { lastFailure: parsed.lastFailure } : {})
    };
    return Object.keys(snapshot).length > 0 ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

export function writeSearchReconcileSnapshot(cacheDir: string, run: SearchIndexReconcileRunStatus): void {
  const previous = readSearchReconcileSnapshot(cacheDir);
  const next: SearchReconcileStatusFile = {
    schemaVersion: SEARCH_RECONCILE_STATUS_SCHEMA_VERSION,
    lastRun: run,
    ...(run.state === "success" ? { lastSuccess: run } : previous?.lastSuccess ? { lastSuccess: previous.lastSuccess } : {}),
    ...(run.state === "failure" ? { lastFailure: run } : previous?.lastFailure ? { lastFailure: previous.lastFailure } : {})
  };
  try {
    atomicWriteFile(path.join(cacheDir, SEARCH_RECONCILE_STATUS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Status is diagnostic-only; never fail the reconcile because the sidecar failed to update.
  }
}

function isSearchReconcileStatusFile(value: unknown): value is SearchReconcileStatusFile {
  return (
    isRecord(value) &&
    value.schemaVersion === SEARCH_RECONCILE_STATUS_SCHEMA_VERSION &&
    isOptionalSearchReconcileRunStatus(value.lastRun) &&
    isOptionalSearchReconcileRunStatus(value.lastSuccess) &&
    isOptionalSearchReconcileRunStatus(value.lastFailure)
  );
}

function isOptionalSearchReconcileRunStatus(value: unknown): value is SearchIndexReconcileRunStatus | undefined {
  return value === undefined || isSearchReconcileRunStatus(value);
}

function isSearchReconcileRunStatus(value: unknown): value is SearchIndexReconcileRunStatus {
  return (
    isRecord(value) &&
    (value.state === "running" || value.state === "success" || value.state === "failure") &&
    typeof value.reason === "string" &&
    isSearchReconcileReason(value.reason) &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.durationMs === undefined || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0)) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function truncateSearchReconcileError(message: string): string {
  return message.length <= SEARCH_RECONCILE_ERROR_MAX_LENGTH
    ? message
    : `${message.slice(0, SEARCH_RECONCILE_ERROR_MAX_LENGTH - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
