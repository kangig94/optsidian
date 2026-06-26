import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../errors.js";

export type SearchSettings = {
  analyzer?: "intl" | "kiwi";
  extraLangs?: string[];
  ngram?: boolean;
  queryWorkers?: number;
  indexWorkers?: number;
  snapshotRetentionCount?: number;
  queryCacheSize?: number;
  memoryBudgetCount?: number;
  memoryBudgetBytes?: number;
  daemonIdleMs?: number;
};

export type OptsidianSettings = {
  search?: SearchSettings;
};

export type ConfigReadResult = {
  ok: true;
  command: "config";
  action: "get" | "list" | "path";
  path: string;
  key?: string;
  value: unknown;
};

export type ConfigMutationResult = {
  ok: true;
  command: "config";
  action: "set" | "unset";
  path: string;
  key: string;
  value?: unknown;
  config: OptsidianSettings;
};

const SETTINGS_DIR = ".optsidian";
const SETTINGS_FILE = "settings.json";
const SETTINGS_PATH_ENV = "OPTSIDIAN_SETTINGS_PATH";
const SEARCH_NGRAM_ENV = "OPTSIDIAN_SEARCH_NGRAM";

export function readOptsidianSettings(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): OptsidianSettings {
  return mergeSettings(readGlobalSettings(cwd, env), readLocalOverrideSettings(cwd));
}

export function searchNgramEnabled(env: NodeJS.ProcessEnv = process.env, settings: OptsidianSettings = {}): boolean {
  const raw = env[SEARCH_NGRAM_ENV];
  if (raw !== undefined) return normalizeBoolean(raw, SEARCH_NGRAM_ENV);
  return settings.search?.ngram ?? false;
}

export function getConfigValue(cwd: string, key: string, env: NodeJS.ProcessEnv = process.env): ConfigReadResult {
  const path = resolveSettingsPath(cwd, env);
  const settings = readOptsidianSettings(cwd, env);
  return {
    ok: true,
    command: "config",
    action: "get",
    path,
    key,
    value: getKnownSetting(settings, key)
  };
}

export function listConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigReadResult {
  const path = resolveSettingsPath(cwd, env);
  return {
    ok: true,
    command: "config",
    action: "list",
    path,
    value: readOptsidianSettings(cwd, env)
  };
}

export function configPathResult(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigReadResult {
  const path = resolveSettingsPath(cwd, env);
  return {
    ok: true,
    command: "config",
    action: "path",
    path,
    value: path
  };
}

export function setConfigValue(
  cwd: string,
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env
): ConfigMutationResult {
  const path = resolveSettingsPath(cwd, env);
  const settings = readGlobalSettings(cwd, env);
  setKnownSetting(settings, key, value);
  writeSettingsFile(path, settings);
  return { ok: true, command: "config", action: "set", path, key, value: getKnownSetting(settings, key), config: settings };
}

export function unsetConfigValue(cwd: string, key: string, env: NodeJS.ProcessEnv = process.env): ConfigMutationResult {
  const path = resolveSettingsPath(cwd, env);
  const settings = readGlobalSettings(cwd, env);
  unsetKnownSetting(settings, key);
  pruneEmptyObjects(settings);
  writeSettingsFile(path, settings);
  return { ok: true, command: "config", action: "unset", path, key, config: settings };
}

export function resolveSettingsPath(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SETTINGS_PATH_ENV]?.trim();
  if (override) return path.resolve(cwd, override);
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "optsidian", SETTINGS_FILE);
}

function readGlobalSettings(cwd: string, env: NodeJS.ProcessEnv): OptsidianSettings {
  return readSettingsFile(resolveSettingsPath(cwd, env));
}

function readLocalOverrideSettings(cwd: string): OptsidianSettings {
  const local = findUpLocalSettings(cwd);
  return local ? readSettingsFile(local) : {};
}

function readSettingsFile(file: string): OptsidianSettings {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return normalizeSettings(parsed);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read settings file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findUpLocalSettings(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, SETTINGS_DIR, SETTINGS_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function mergeSettings(global: OptsidianSettings, local: OptsidianSettings): OptsidianSettings {
  const merged: OptsidianSettings = {};
  if (global.search || local.search) {
    merged.search = {
      ...(global.search ?? {}),
      ...(local.search ?? {})
    };
    pruneEmptyObjects(merged);
  }
  return merged;
}

function normalizeSettings(value: unknown): OptsidianSettings {
  if (!isRecord(value)) throw new UsageError("settings file must contain a JSON object");
  const settings: OptsidianSettings = {};
  if (value.search !== undefined) {
    if (!isRecord(value.search)) throw new UsageError("settings.search must be an object");
    settings.search = {};
    if (value.search.analyzer !== undefined) settings.search.analyzer = normalizeAnalyzer(value.search.analyzer);
    if (value.search.extraLangs !== undefined) settings.search.extraLangs = normalizeStringList(value.search.extraLangs, "search.extraLangs");
    if (value.search.ngram !== undefined) settings.search.ngram = normalizeBoolean(value.search.ngram, "search.ngram");
    if (value.search.queryWorkers !== undefined) {
      settings.search.queryWorkers = normalizePositiveInteger(value.search.queryWorkers, "search.queryWorkers");
    }
    if (value.search.indexWorkers !== undefined) {
      settings.search.indexWorkers = normalizePositiveInteger(value.search.indexWorkers, "search.indexWorkers");
    }
    if (value.search.snapshotRetentionCount !== undefined) {
      settings.search.snapshotRetentionCount = normalizePositiveInteger(value.search.snapshotRetentionCount, "search.snapshotRetentionCount");
    }
    if (value.search.queryCacheSize !== undefined) {
      settings.search.queryCacheSize = normalizeNonNegativeInteger(value.search.queryCacheSize, "search.queryCacheSize");
    }
    if (value.search.memoryBudgetCount !== undefined) {
      settings.search.memoryBudgetCount = normalizePositiveInteger(value.search.memoryBudgetCount, "search.memoryBudgetCount");
    }
    if (value.search.memoryBudgetBytes !== undefined) {
      settings.search.memoryBudgetBytes = normalizePositiveInteger(value.search.memoryBudgetBytes, "search.memoryBudgetBytes");
    }
    if (value.search.daemonIdleMs !== undefined) {
      settings.search.daemonIdleMs = normalizeNonNegativeInteger(value.search.daemonIdleMs, "search.daemonIdleMs");
    }
  }
  return settings;
}

function getKnownSetting(settings: OptsidianSettings, key: string): unknown {
  switch (key) {
    case "search.analyzer":
      return settings.search?.analyzer;
    case "search.extraLangs":
      return settings.search?.extraLangs ?? [];
    case "search.ngram":
      return settings.search?.ngram;
    case "search.queryWorkers":
      return settings.search?.queryWorkers;
    case "search.indexWorkers":
      return settings.search?.indexWorkers;
    case "search.snapshotRetentionCount":
      return settings.search?.snapshotRetentionCount;
    case "search.queryCacheSize":
      return settings.search?.queryCacheSize;
    case "search.memoryBudgetCount":
      return settings.search?.memoryBudgetCount;
    case "search.memoryBudgetBytes":
      return settings.search?.memoryBudgetBytes;
    case "search.daemonIdleMs":
      return settings.search?.daemonIdleMs;
    default:
      throw new UsageError(knownSettingMessage());
  }
}

function setKnownSetting(settings: OptsidianSettings, key: string, value: unknown): void {
  settings.search ??= {};
  switch (key) {
    case "search.analyzer":
      settings.search.analyzer = normalizeAnalyzer(value);
      return;
    case "search.extraLangs":
      settings.search.extraLangs = normalizeStringList(value, key);
      return;
    case "search.ngram":
      settings.search.ngram = normalizeBoolean(value, key);
      return;
    case "search.queryWorkers":
      settings.search.queryWorkers = normalizePositiveInteger(value, key);
      return;
    case "search.indexWorkers":
      settings.search.indexWorkers = normalizePositiveInteger(value, key);
      return;
    case "search.snapshotRetentionCount":
      settings.search.snapshotRetentionCount = normalizePositiveInteger(value, key);
      return;
    case "search.queryCacheSize":
      settings.search.queryCacheSize = normalizeNonNegativeInteger(value, key);
      return;
    case "search.memoryBudgetCount":
      settings.search.memoryBudgetCount = normalizePositiveInteger(value, key);
      return;
    case "search.memoryBudgetBytes":
      settings.search.memoryBudgetBytes = normalizePositiveInteger(value, key);
      return;
    case "search.daemonIdleMs":
      settings.search.daemonIdleMs = normalizeNonNegativeInteger(value, key);
      return;
    default:
      throw new UsageError(knownSettingMessage());
  }
}

function unsetKnownSetting(settings: OptsidianSettings, key: string): void {
  switch (key) {
    case "search.analyzer":
      if (settings.search) delete settings.search.analyzer;
      return;
    case "search.extraLangs":
      if (settings.search) delete settings.search.extraLangs;
      return;
    case "search.ngram":
      if (settings.search) delete settings.search.ngram;
      return;
    case "search.queryWorkers":
      if (settings.search) delete settings.search.queryWorkers;
      return;
    case "search.indexWorkers":
      if (settings.search) delete settings.search.indexWorkers;
      return;
    case "search.snapshotRetentionCount":
      if (settings.search) delete settings.search.snapshotRetentionCount;
      return;
    case "search.queryCacheSize":
      if (settings.search) delete settings.search.queryCacheSize;
      return;
    case "search.memoryBudgetCount":
      if (settings.search) delete settings.search.memoryBudgetCount;
      return;
    case "search.memoryBudgetBytes":
      if (settings.search) delete settings.search.memoryBudgetBytes;
      return;
    case "search.daemonIdleMs":
      if (settings.search) delete settings.search.daemonIdleMs;
      return;
    default:
      throw new UsageError(knownSettingMessage());
  }
}

function normalizeAnalyzer(value: unknown): "intl" | "kiwi" {
  if (typeof value !== "string") throw new UsageError("search.analyzer must be intl or kiwi");
  const normalized = value.trim().toLowerCase();
  if (normalized === "intl" || normalized === "kiwi") return normalized;
  throw new UsageError("search.analyzer must be intl or kiwi");
}

function normalizeStringList(value: unknown, key: string): string[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : undefined;
  if (!raw) throw new UsageError(`${key} must be a comma-separated string or string array`);
  return [...new Set(raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  throw new UsageError(`${key} must be true or false`);
}

function normalizePositiveInteger(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`${key} must be a positive integer`);
  return parsed;
}

function normalizeNonNegativeInteger(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UsageError(`${key} must be a non-negative integer`);
  return parsed;
}

function writeSettingsFile(file: string, settings: OptsidianSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function pruneEmptyObjects(settings: OptsidianSettings): void {
  if (settings.search && Object.keys(settings.search).length === 0) delete settings.search;
}

function knownSettingMessage(): string {
  return "setting key must be one of: search.analyzer, search.extraLangs, search.ngram, search.queryWorkers, search.indexWorkers, search.snapshotRetentionCount, search.queryCacheSize, search.memoryBudgetCount, search.memoryBudgetBytes, search.daemonIdleMs";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
