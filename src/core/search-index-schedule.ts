import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../errors.js";
import { atomicWriteFile } from "./write-file.js";
import { readOptsidianSettings, type OptsidianSettings } from "./settings.js";
import { pokeSearchIndexDaemonWarmOnce, type SearchIndexDaemonWarmTarget } from "./search-index-daemon.js";

type IndexWarmScheduleFile = {
  schemaVersion: typeof INDEX_WARM_SCHEDULE_SCHEMA_VERSION;
  lastAttemptAtMs: number;
  lastAttemptAt: string;
};

type MaybeWarmOptions = {
  vaultPath?: string;
  cliBin?: string;
  env?: NodeJS.ProcessEnv;
  settings?: OptsidianSettings;
  nowMs?: number;
  poke?: (target: SearchIndexDaemonWarmTarget, env: NodeJS.ProcessEnv) => void;
};

export type IndexWarmDecision =
  | { triggered: true; statePath: string; target: SearchIndexDaemonWarmTarget }
  | { triggered: false; statePath: string; reason: "disabled" | "throttled" };

const INDEX_WARM_SCHEDULE_SCHEMA_VERSION = 1;
const INDEX_WARM_SCHEDULE_FILE = "index-warm-schedule.json";
const INDEX_WARM_INTERVAL_MINUTES_ENV = "OPTSIDIAN_INDEX_WARM_INTERVAL_MINUTES";
const DEFAULT_INDEX_WARM_INTERVAL_MINUTES = 30;
const MS_PER_MINUTE = 60 * 1000;

export function maybePokeSearchIndexDaemonWarmForMcp(options: MaybeWarmOptions = {}): IndexWarmDecision {
  const env = options.env ?? process.env;
  const statePath = indexWarmSchedulePath(env);
  if (indexWarmDisabled(env)) return { triggered: false, statePath, reason: "disabled" };

  const nowMs = options.nowMs ?? Date.now();
  const settings = options.settings ?? readOptsidianSettings(process.cwd(), env);
  const warmIntervalMs = indexWarmIntervalMinutes(env, settings) * MS_PER_MINUTE;
  const previous = readIndexWarmSchedule(statePath);
  if (warmIntervalMs > 0 && previous && nowMs - previous.lastAttemptAtMs < warmIntervalMs) {
    return { triggered: false, statePath, reason: "throttled" };
  }

  writeIndexWarmSchedule(statePath, nowMs);
  const warmEnv = options.cliBin && !env.OPTSIDIAN_INDEX_DAEMON_BIN
    ? { ...env, OPTSIDIAN_INDEX_DAEMON_BIN: options.cliBin }
    : env;
  const target: SearchIndexDaemonWarmTarget = options.vaultPath
    ? { kind: "vault", vaultRoot: options.vaultPath }
    : { kind: "discovered" };
  (options.poke ?? pokeSearchIndexDaemonWarmOnce)(target, warmEnv);
  return { triggered: true, statePath, target };
}

export function indexWarmSchedulePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), INDEX_WARM_SCHEDULE_FILE);
}

function optsidianCacheRoot(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(base, "optsidian");
}

function indexWarmIntervalMinutes(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return parseNonNegativeInteger(
    env[INDEX_WARM_INTERVAL_MINUTES_ENV],
    settings.search?.indexWarmIntervalMinutes ?? DEFAULT_INDEX_WARM_INTERVAL_MINUTES,
    INDEX_WARM_INTERVAL_MINUTES_ENV
  );
}

function readIndexWarmSchedule(filePath: string): IndexWarmScheduleFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isIndexWarmScheduleFile(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeIndexWarmSchedule(filePath: string, nowMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, `${JSON.stringify({
    schemaVersion: INDEX_WARM_SCHEDULE_SCHEMA_VERSION,
    lastAttemptAtMs: nowMs,
    lastAttemptAt: new Date(nowMs).toISOString()
  }, null, 2)}\n`);
}

function isIndexWarmScheduleFile(value: unknown): value is IndexWarmScheduleFile {
  return (
    isRecord(value) &&
    value.schemaVersion === INDEX_WARM_SCHEDULE_SCHEMA_VERSION &&
    typeof value.lastAttemptAtMs === "number" &&
    Number.isFinite(value.lastAttemptAtMs) &&
    typeof value.lastAttemptAt === "string"
  );
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${name} must be a non-negative integer`);
  return parsed;
}

function indexWarmDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPTSIDIAN_INDEX_DAEMON?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
