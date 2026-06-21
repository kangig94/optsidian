import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";
import { optsidianCacheRoot } from "./cache-root.js";
import { readOptsidianSettings, type OptsidianSettings } from "./settings.js";
import type { SearchIndexWarmScheduleStatus } from "./types.js";
import { atomicWriteFile } from "./write-file.js";

type IndexWarmScheduleFile = {
  schemaVersion: typeof INDEX_WARM_SCHEDULE_SCHEMA_VERSION;
  lastAttemptAtMs: number;
  lastAttemptAt: string;
};

const INDEX_WARM_SCHEDULE_SCHEMA_VERSION = 1;
const INDEX_WARM_SCHEDULE_FILE = "index-warm-schedule.json";
const INDEX_WARM_INTERVAL_MINUTES_ENV = "OPTSIDIAN_INDEX_WARM_INTERVAL_MINUTES";
const DEFAULT_INDEX_WARM_INTERVAL_MINUTES = 30;
const MS_PER_MINUTE = 60 * 1000;

export function indexWarmSchedulePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), INDEX_WARM_SCHEDULE_FILE);
}

export function indexWarmScheduleStatus(options: { env?: NodeJS.ProcessEnv; settings?: OptsidianSettings; nowMs?: number } = {}): SearchIndexWarmScheduleStatus {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const settings = options.settings ?? readOptsidianSettings(process.cwd(), env);
  const intervalMinutes = indexWarmIntervalMinutes(env, settings);
  const intervalMs = intervalMinutes * MS_PER_MINUTE;
  const statePath = indexWarmSchedulePath(env);
  const previous = readIndexWarmSchedule(statePath);
  const nextAttemptAtMs = previous && intervalMs > 0 ? previous.lastAttemptAtMs + intervalMs : undefined;
  return {
    path: statePath,
    intervalMinutes,
    throttled: nextAttemptAtMs !== undefined && nowMs < nextAttemptAtMs,
    ...(previous ? { lastAttemptAt: previous.lastAttemptAt } : {}),
    ...(nextAttemptAtMs !== undefined ? { nextAttemptAt: new Date(nextAttemptAtMs).toISOString() } : {})
  };
}

export function indexWarmIntervalMinutes(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return parseNonNegativeInteger(
    env[INDEX_WARM_INTERVAL_MINUTES_ENV],
    settings.search?.indexWarmIntervalMinutes ?? DEFAULT_INDEX_WARM_INTERVAL_MINUTES,
    INDEX_WARM_INTERVAL_MINUTES_ENV
  );
}

export function readIndexWarmSchedule(filePath: string): IndexWarmScheduleFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isIndexWarmScheduleFile(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeIndexWarmSchedule(filePath: string, nowMs: number): void {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
