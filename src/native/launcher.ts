import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GUI_ENV_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY"] as const;

type GuiEnvKey = (typeof GUI_ENV_KEYS)[number];
type GuiEnvSnapshot = Partial<Record<GuiEnvKey, string>>;

export type ObsidianProcessReader = {
  listPids(): number[];
  readCmdline(pid: number): string[] | undefined;
  readEnviron(pid: number): NodeJS.ProcessEnv | undefined;
  readParentPid(pid: number): number | undefined;
};

export type RunObsidianOptions = {
  env?: NodeJS.ProcessEnv;
  input?: SpawnSyncOptionsWithStringEncoding["input"];
  stdio?: SpawnSyncOptionsWithStringEncoding["stdio"];
  procReader?: ObsidianProcessReader;
  currentPid?: number;
};

let cachedLinuxGuiEnv: GuiEnvSnapshot | undefined;
let hasCachedLinuxGuiEnv = false;

export function obsidianBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTSIDIAN_OBSIDIAN_BIN || "obsidian";
}

export function clearObsidianLaunchEnvCache(): void {
  cachedLinuxGuiEnv = undefined;
  hasCachedLinuxGuiEnv = false;
}

export function shouldRefreshObsidianLaunch(message: string): boolean {
  return /unable to find obsidian|obsidian is not running|make sure obsidian is running/i.test(message);
}

export function mergeObsidianLaunchEnv(baseEnv: NodeJS.ProcessEnv, recoveredEnv: GuiEnvSnapshot): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of GUI_ENV_KEYS) {
    const value = recoveredEnv[key];
    if (value && !merged[key]) {
      merged[key] = value;
    }
  }
  if (!merged.DBUS_SESSION_BUS_ADDRESS && merged.XDG_RUNTIME_DIR) {
    merged.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(merged.XDG_RUNTIME_DIR, "bus")}`;
  }
  return merged;
}

export function recoverLinuxGuiEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: { procReader?: ObsidianProcessReader; currentPid?: number } = {}
): GuiEnvSnapshot {
  if (hasLocalGuiContext(baseEnv)) {
    return {};
  }

  const reader = options.procReader ?? createProcReader();
  const recovered: GuiEnvSnapshot = {};
  collectParentChainGuiEnv(recovered, baseEnv, reader, options.currentPid ?? process.pid);
  if (!hasLocalGuiContext(mergeObsidianLaunchEnv(baseEnv, recovered))) {
    collectObsidianProcessGuiEnv(recovered, baseEnv, reader, options.currentPid ?? process.pid);
  }
  return finalizeGuiEnvSnapshot(recovered, baseEnv);
}

export function runObsidianSync(args: string[], options: RunObsidianOptions = {}): SpawnSyncReturns<string> {
  const baseEnv = options.env ?? process.env;
  let result = spawnObsidian(args, { ...options, env: buildLaunchEnv(baseEnv, options) });
  if (shouldRetryObsidianRun(result, options.stdio)) {
    clearObsidianLaunchEnvCache();
    result = spawnObsidian(args, { ...options, env: buildLaunchEnv(baseEnv, { ...options, refreshCache: true }) });
  }
  return result;
}

function buildLaunchEnv(baseEnv: NodeJS.ProcessEnv, options: RunObsidianOptions & { refreshCache?: boolean }): NodeJS.ProcessEnv {
  if (process.platform !== "linux") {
    return baseEnv;
  }
  if (!options.refreshCache && hasCachedLinuxGuiEnv) {
    return mergeObsidianLaunchEnv(baseEnv, cachedLinuxGuiEnv ?? {});
  }
  const recovered = recoverLinuxGuiEnv(baseEnv, options);
  cachedLinuxGuiEnv = recovered;
  hasCachedLinuxGuiEnv = true;
  return mergeObsidianLaunchEnv(baseEnv, recovered);
}

function spawnObsidian(args: string[], options: RunObsidianOptions & { env: NodeJS.ProcessEnv }): SpawnSyncReturns<string> {
  return spawnSync(obsidianBin(options.env), args, {
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env
  });
}

function shouldRetryObsidianRun(result: SpawnSyncReturns<string>, stdio: RunObsidianOptions["stdio"]): boolean {
  if (process.platform !== "linux" || stdio === "inherit" || result.error || result.status === 0) {
    return false;
  }
  const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return shouldRefreshObsidianLaunch(message);
}

function hasLocalGuiContext(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.DISPLAY || env.WAYLAND_DISPLAY) && (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR));
}

function collectParentChainGuiEnv(
  recovered: GuiEnvSnapshot,
  baseEnv: NodeJS.ProcessEnv,
  reader: ObsidianProcessReader,
  currentPid: number
): void {
  const seen = new Set<number>();
  let pid = reader.readParentPid(currentPid);
  while (pid && pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    fillMissingGuiEnv(recovered, baseEnv, reader.readEnviron(pid));
    if (hasLocalGuiContext(mergeObsidianLaunchEnv(baseEnv, recovered))) {
      return;
    }
    const next = reader.readParentPid(pid);
    if (!next || next === pid) {
      return;
    }
    pid = next;
  }
}

function collectObsidianProcessGuiEnv(
  recovered: GuiEnvSnapshot,
  baseEnv: NodeJS.ProcessEnv,
  reader: ObsidianProcessReader,
  currentPid: number
): void {
  const candidates = reader
    .listPids()
    .filter((pid) => pid !== currentPid)
    .map((pid) => {
      const argv = reader.readCmdline(pid);
      const env = reader.readEnviron(pid);
      return argv && env && looksLikeObsidianProcess(argv) ? { pid, argv, env } : undefined;
    })
    .filter((candidate): candidate is { pid: number; argv: string[]; env: NodeJS.ProcessEnv } => Boolean(candidate))
    .sort(compareObsidianCandidates);

  for (const candidate of candidates) {
    fillMissingGuiEnv(recovered, baseEnv, candidate.env);
    if (hasLocalGuiContext(mergeObsidianLaunchEnv(baseEnv, recovered))) {
      return;
    }
  }
}

function finalizeGuiEnvSnapshot(recovered: GuiEnvSnapshot, baseEnv: NodeJS.ProcessEnv): GuiEnvSnapshot {
  const finalized = { ...recovered };
  if (!baseEnv.DBUS_SESSION_BUS_ADDRESS && !finalized.DBUS_SESSION_BUS_ADDRESS) {
    const runtimeDir = finalized.XDG_RUNTIME_DIR || baseEnv.XDG_RUNTIME_DIR;
    if (runtimeDir) {
      finalized.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtimeDir, "bus")}`;
    }
  }
  return finalized;
}

function fillMissingGuiEnv(recovered: GuiEnvSnapshot, baseEnv: NodeJS.ProcessEnv, sourceEnv: NodeJS.ProcessEnv | undefined): void {
  if (!sourceEnv) {
    return;
  }
  for (const key of GUI_ENV_KEYS) {
    const value = sourceEnv[key];
    if (!baseEnv[key] && !recovered[key] && value) {
      recovered[key] = value;
    }
  }
}

function compareObsidianCandidates(
  left: { pid: number; argv: string[]; env: NodeJS.ProcessEnv },
  right: { pid: number; argv: string[]; env: NodeJS.ProcessEnv }
): number {
  const mainDelta = Number(isObsidianMainProcess(right.argv)) - Number(isObsidianMainProcess(left.argv));
  if (mainDelta !== 0) {
    return mainDelta;
  }
  const envDelta = guiEnvScore(right.env) - guiEnvScore(left.env);
  if (envDelta !== 0) {
    return envDelta;
  }
  return left.pid - right.pid;
}

function guiEnvScore(env: NodeJS.ProcessEnv): number {
  return GUI_ENV_KEYS.reduce((score, key) => score + Number(Boolean(env[key])), 0);
}

function isObsidianMainProcess(argv: string[]): boolean {
  return !argv.some((arg) => arg.startsWith("--type="));
}

function looksLikeObsidianProcess(argv: string[]): boolean {
  let hasObsidianToken = false;
  for (const arg of argv) {
    const token = normalizeProcessToken(arg);
    if (!token) {
      continue;
    }
    if (token === "optsidian" || token.startsWith("optsidian-") || token.startsWith("optsidian_")) {
      return false;
    }
    if (token === "obsidian" || token.startsWith("obsidian-") || token.startsWith("obsidian_")) {
      hasObsidianToken = true;
    }
  }
  return hasObsidianToken;
}

function normalizeProcessToken(token: string): string {
  return path.basename(token).replace(/\.(cjs|mjs|js|exe)$/i, "").toLowerCase();
}

function createProcReader(root = "/proc"): ObsidianProcessReader {
  return {
    listPids(): number[] {
      try {
        return fs
          .readdirSync(root)
          .map((entry) => Number(entry))
          .filter((entry) => Number.isInteger(entry) && entry > 0);
      } catch {
        return [];
      }
    },
    readCmdline(pid: number): string[] | undefined {
      try {
        return fs
          .readFileSync(path.join(root, String(pid), "cmdline"), "utf8")
          .split("\0")
          .filter(Boolean);
      } catch {
        return undefined;
      }
    },
    readEnviron(pid: number): NodeJS.ProcessEnv | undefined {
      try {
        return parseEnvPairs(fs.readFileSync(path.join(root, String(pid), "environ"), "utf8"));
      } catch {
        return undefined;
      }
    },
    readParentPid(pid: number): number | undefined {
      try {
        const status = fs.readFileSync(path.join(root, String(pid), "status"), "utf8");
        const match = /^PPid:\s+(\d+)$/m.exec(status);
        return match ? Number(match[1]) : undefined;
      } catch {
        return undefined;
      }
    }
  };
}

function parseEnvPairs(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const pair of raw.split("\0")) {
    if (!pair) {
      continue;
    }
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}
