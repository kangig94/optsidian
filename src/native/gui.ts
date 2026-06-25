import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RuntimeError } from "../errors.js";
import { findObsidianAppLaunch, mergeObsidianLaunchEnv, recoverLinuxGuiEnv } from "./launcher.js";
import { resolveObsidianVaultRoot, resolveVaultPathInput } from "./obsidian.js";

export type OpenObsidianGuiResult = {
  ok: true;
  command: "open-gui";
  target: string;
  launcher: string;
  wait: boolean;
  vaultPath?: string;
  readyVaultPath?: string;
};

export type OpenObsidianGuiOptions = {
  vaultPath?: string;
  wait?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const WAIT_INTERVAL_MS = 250;
const FAST_WAIT_INTERVAL_MS = 50;
const FAST_WAIT_WINDOW_MS = 1_000;

export async function openObsidianGui(options: OpenObsidianGuiOptions = {}): Promise<OpenObsidianGuiResult> {
  const env = buildGuiLaunchEnv(options.env ?? process.env);
  const vaultPath = options.vaultPath ? resolveVaultPathInput(options.vaultPath) : undefined;
  const target = obsidianOpenUrl(vaultPath);
  const launcher = launchObsidianGui(target, env);
  const result: OpenObsidianGuiResult = {
    ok: true,
    command: "open-gui",
    target,
    launcher,
    wait: Boolean(options.wait),
    ...(vaultPath ? { vaultPath } : {})
  };

  if (options.wait) {
    result.readyVaultPath = await waitForNativeVaultReady({
      env,
      expectedVaultPath: vaultPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    });
  }

  return result;
}

export function obsidianOpenUrl(vaultPath?: string): string {
  if (!vaultPath) {
    return "obsidian://open";
  }
  return `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
}

function buildGuiLaunchEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "linux") {
    return baseEnv;
  }
  return mergeObsidianLaunchEnv(baseEnv, recoverLinuxGuiEnv(baseEnv));
}

function launchObsidianGui(target: string, env: NodeJS.ProcessEnv): string {
  const installed = findObsidianAppLaunch(env);
  if (installed) {
    if (installed.kind === "darwin-bundle") {
      launchDetached("open", ["-a", installed.appBundle, target], env);
      return `open -a ${installed.appBundle}`;
    }
    launchDetached(installed.binary, [target], env);
    return installed.binary;
  }

  if (process.platform === "darwin") {
    launchDetached("open", [target], env);
    return "open";
  }

  if (process.platform === "win32") {
    launchDetached("cmd", ["/c", "start", "", target], env);
    return "cmd";
  }

  const xdgOpen = findExecutable("xdg-open", env);
  if (xdgOpen) {
    launchDetached(xdgOpen, [target], env);
    return xdgOpen;
  }

  const gio = findExecutable("gio", env);
  if (gio) {
    launchDetached(gio, ["open", target], env);
    return gio;
  }

  throw new RuntimeError("Could not find a GUI opener. Install Obsidian to a standard location, install xdg-open/gio, or set OPTSIDIAN_OBSIDIAN_APP_BIN=/path/to/obsidian.");
}

function launchDetached(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  if ((path.isAbsolute(command) || command.includes(path.sep)) && !fs.existsSync(command)) {
    throw new RuntimeError(`Obsidian app binary does not exist: ${command}`);
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env
  });
  child.on("error", () => {});
  child.unref();
}

async function waitForNativeVaultReady(options: {
  env: NodeJS.ProcessEnv;
  expectedVaultPath?: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  const startedAt = Date.now();
  const expected = options.expectedVaultPath ? realpathForCompare(options.expectedVaultPath) : undefined;
  let lastReason = "native vault resolution has not succeeded yet";

  while (Date.now() <= deadline) {
    try {
      const activeVault = resolveObsidianVaultRoot({ env: options.env });
      if (!expected || realpathForCompare(activeVault) === expected) {
        return activeVault;
      }
      lastReason = `native vault is ${activeVault}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await sleep(Date.now() - startedAt < FAST_WAIT_WINDOW_MS ? FAST_WAIT_INTERVAL_MS : WAIT_INTERVAL_MS);
  }

  throw new RuntimeError(`Timed out waiting for Obsidian GUI native vault resolution. Last status: ${lastReason}`);
}

function realpathForCompare(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
