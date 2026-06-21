import { readOptsidianSettings, type OptsidianSettings } from "./settings.js";
import {
  indexWarmIntervalMinutes,
  indexWarmSchedulePath,
  readIndexWarmSchedule,
  writeIndexWarmSchedule
} from "./search-index-schedule-state.js";
import { pokeSearchIndexDaemonWarmOnce, type SearchIndexDaemonWarmTarget } from "./search-index-daemon.js";

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
    : { kind: "recent" };
  (options.poke ?? pokeSearchIndexDaemonWarmOnce)(target, warmEnv);
  return { triggered: true, statePath, target };
}

function indexWarmDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPTSIDIAN_INDEX_DAEMON?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

export { indexWarmSchedulePath } from "./search-index-schedule-state.js";
