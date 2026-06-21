import { getValue, ParsedArgs, requireValue } from "../args.js";
import { parseFormat, type OutputFormat } from "../render.js";
import {
  configPathResult,
  getConfigValue,
  listConfig,
  setConfigValue,
  unsetConfigValue,
  type ConfigMutationResult,
  type ConfigReadResult
} from "../../core/settings.js";
import { parseDeclaredSearchAnalyzers } from "../../core/search-analyzer.js";
import { UsageError } from "../../errors.js";

const SETTING_KEYS = new Set([
  "search.analyzer",
  "search.extraLangs",
  "search.analyzerIdleMs",
  "search.analyzerRequestTimeoutMs",
  "search.overlayMaxFiles",
  "search.overlayMaxBytes",
  "search.indexWarmIntervalMinutes"
]);

export function runConfig(args: ParsedArgs): void {
  const action = args.positionals[0] ?? "list";
  const format = parseFormat(getValue(args, "format"));
  switch (action) {
    case "list":
      process.stdout.write(renderConfigResult(listConfig(process.cwd()), format));
      return;
    case "path":
      process.stdout.write(renderConfigResult(configPathResult(process.cwd()), format));
      return;
    case "get": {
      const key = settingKeyArg(args, 1);
      process.stdout.write(renderConfigResult(getConfigValue(process.cwd(), key), format));
      return;
    }
    case "set": {
      const { key, value } = settingAssignment(args);
      process.stdout.write(renderConfigResult(setConfigValue(process.cwd(), key, parseSettingValue(key, value)), format));
      return;
    }
    case "unset": {
      const key = settingKeyArg(args, 1);
      process.stdout.write(renderConfigResult(unsetConfigValue(process.cwd(), key), format));
      return;
    }
    default:
      throw new UsageError("config action must be list, path, get, set, or unset");
  }
}

function settingKeyArg(args: ParsedArgs, positionalIndex: number): string {
  const key = args.positionals[positionalIndex] ?? getValue(args, "key");
  if (!key) throw new UsageError("Missing required config key");
  assertKnownSettingKey(key);
  return key;
}

function settingAssignment(args: ParsedArgs): { key: string; value: string } {
  const keyArg = getValue(args, "key");
  if (keyArg !== undefined) {
    assertKnownSettingKey(keyArg);
    return { key: keyArg, value: requireValue(args, "value") };
  }
  const assignments = [...args.values.entries()].filter(([key]) => SETTING_KEYS.has(key));
  if (assignments.length !== 1) {
    throw new UsageError("Use config set <key>=<value> or config set key=<key> value=<value>");
  }
  const [key, value] = assignments[0];
  return { key, value };
}

function parseSettingValue(key: string, value: string): unknown {
  if (key === "search.extraLangs") {
    return parseDeclaredSearchAnalyzers(value);
  }
  return value;
}

function assertKnownSettingKey(key: string): void {
  if (!SETTING_KEYS.has(key)) {
    throw new UsageError(
      "config key must be one of: search.analyzer, search.extraLangs, search.analyzerIdleMs, search.analyzerRequestTimeoutMs, search.overlayMaxFiles, search.overlayMaxBytes, search.indexWarmIntervalMinutes"
    );
  }
}

function renderConfigResult(result: ConfigReadResult | ConfigMutationResult, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(result)}\n`;
  if (result.action === "path") return `${result.path}\n`;
  if (result.action === "list") return `${JSON.stringify(result.value, null, 2)}\n`;
  if (result.action === "get") return `${result.key}: ${formatValue(result.value)}\n`;
  if (result.action === "set") return `Updated ${result.key} in ${result.path}\n`;
  return `Unset ${result.key} in ${result.path}\n`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
