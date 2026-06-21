import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../errors.js";

export type SearchSettings = {
  analyzer?: "intl" | "intl-daemon";
  extraLangs?: string[];
  analyzerIdleMs?: number;
  analyzerRequestTimeoutMs?: number;
  overlayMaxFiles?: number;
  overlayMaxBytes?: number;
  indexWarmIntervalMinutes?: number;
  indexWarmAccessMaxAgeDays?: number;
  indexWarmConcurrency?: number;
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

export function readOptsidianSettings(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): OptsidianSettings {
  return mergeSettings(readGlobalSettings(cwd, env), readLocalOverrideSettings(cwd));
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
    if (value.search.analyzerIdleMs !== undefined) {
      settings.search.analyzerIdleMs = normalizePositiveInteger(value.search.analyzerIdleMs, "search.analyzerIdleMs");
    }
    if (value.search.analyzerRequestTimeoutMs !== undefined) {
      settings.search.analyzerRequestTimeoutMs = normalizePositiveInteger(
        value.search.analyzerRequestTimeoutMs,
        "search.analyzerRequestTimeoutMs"
      );
    }
    if (value.search.overlayMaxFiles !== undefined) {
      settings.search.overlayMaxFiles = normalizeNonNegativeInteger(value.search.overlayMaxFiles, "search.overlayMaxFiles");
    }
    if (value.search.overlayMaxBytes !== undefined) {
      settings.search.overlayMaxBytes = normalizeNonNegativeInteger(value.search.overlayMaxBytes, "search.overlayMaxBytes");
    }
    if (value.search.indexWarmIntervalMinutes !== undefined) {
      settings.search.indexWarmIntervalMinutes = normalizeNonNegativeInteger(
        value.search.indexWarmIntervalMinutes,
        "search.indexWarmIntervalMinutes"
      );
    }
    if (value.search.indexWarmAccessMaxAgeDays !== undefined) {
      settings.search.indexWarmAccessMaxAgeDays = normalizePositiveInteger(
        value.search.indexWarmAccessMaxAgeDays,
        "search.indexWarmAccessMaxAgeDays"
      );
    }
    if (value.search.indexWarmConcurrency !== undefined) {
      settings.search.indexWarmConcurrency = normalizePositiveInteger(
        value.search.indexWarmConcurrency,
        "search.indexWarmConcurrency"
      );
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
    case "search.analyzerIdleMs":
      return settings.search?.analyzerIdleMs;
    case "search.analyzerRequestTimeoutMs":
      return settings.search?.analyzerRequestTimeoutMs;
    case "search.overlayMaxFiles":
      return settings.search?.overlayMaxFiles;
    case "search.overlayMaxBytes":
      return settings.search?.overlayMaxBytes;
    case "search.indexWarmIntervalMinutes":
      return settings.search?.indexWarmIntervalMinutes;
    case "search.indexWarmAccessMaxAgeDays":
      return settings.search?.indexWarmAccessMaxAgeDays;
    case "search.indexWarmConcurrency":
      return settings.search?.indexWarmConcurrency;
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
    case "search.analyzerIdleMs":
      settings.search.analyzerIdleMs = normalizePositiveInteger(value, key);
      return;
    case "search.analyzerRequestTimeoutMs":
      settings.search.analyzerRequestTimeoutMs = normalizePositiveInteger(value, key);
      return;
    case "search.overlayMaxFiles":
      settings.search.overlayMaxFiles = normalizeNonNegativeInteger(value, key);
      return;
    case "search.overlayMaxBytes":
      settings.search.overlayMaxBytes = normalizeNonNegativeInteger(value, key);
      return;
    case "search.indexWarmIntervalMinutes":
      settings.search.indexWarmIntervalMinutes = normalizeNonNegativeInteger(value, key);
      return;
    case "search.indexWarmAccessMaxAgeDays":
      settings.search.indexWarmAccessMaxAgeDays = normalizePositiveInteger(value, key);
      return;
    case "search.indexWarmConcurrency":
      settings.search.indexWarmConcurrency = normalizePositiveInteger(value, key);
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
    case "search.analyzerIdleMs":
      if (settings.search) delete settings.search.analyzerIdleMs;
      return;
    case "search.analyzerRequestTimeoutMs":
      if (settings.search) delete settings.search.analyzerRequestTimeoutMs;
      return;
    case "search.overlayMaxFiles":
      if (settings.search) delete settings.search.overlayMaxFiles;
      return;
    case "search.overlayMaxBytes":
      if (settings.search) delete settings.search.overlayMaxBytes;
      return;
    case "search.indexWarmIntervalMinutes":
      if (settings.search) delete settings.search.indexWarmIntervalMinutes;
      return;
    case "search.indexWarmAccessMaxAgeDays":
      if (settings.search) delete settings.search.indexWarmAccessMaxAgeDays;
      return;
    case "search.indexWarmConcurrency":
      if (settings.search) delete settings.search.indexWarmConcurrency;
      return;
    default:
      throw new UsageError(knownSettingMessage());
  }
}

function normalizeAnalyzer(value: unknown): "intl" | "intl-daemon" {
  if (typeof value !== "string") throw new UsageError("search.analyzer must be intl or intl-daemon");
  const normalized = value.trim().toLowerCase();
  if (normalized === "intl" || normalized === "intl-daemon") return normalized;
  if (normalized === "daemon-intl") return "intl-daemon";
  throw new UsageError("search.analyzer must be intl or intl-daemon");
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
  return "setting key must be one of: search.analyzer, search.extraLangs, search.analyzerIdleMs, search.analyzerRequestTimeoutMs, search.overlayMaxFiles, search.overlayMaxBytes, search.indexWarmIntervalMinutes, search.indexWarmAccessMaxAgeDays, search.indexWarmConcurrency";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
