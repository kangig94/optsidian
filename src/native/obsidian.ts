import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RuntimeError } from "../errors.js";

export type ObsidianCapture = {
  stdout: string;
  stderr: string;
  status: number;
};

export function obsidianBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTSIDIAN_OBSIDIAN_BIN || "obsidian";
}

export function captureObsidian(args: string[], env: NodeJS.ProcessEnv = process.env): ObsidianCapture {
  const result = spawnSync(obsidianBin(env), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    env
  });
  if (result.error) {
    throw new RuntimeError(`Failed to run obsidian: ${result.error.message}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1
  };
}

export function resolveObsidianVaultRoot(options: { vault?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const argv = ["vault", "info=path"];
  if (options.vault) argv.push(`vault=${options.vault}`);

  const result = captureObsidian(argv, options.env);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new RuntimeError(details || "Failed to resolve Obsidian vault path");
  }

  const root = result.stdout.trim();
  if (!root) {
    throw new RuntimeError("Obsidian returned an empty vault path");
  }
  return root;
}

export function resolveObsidianVaultRootWithFallback(options: { vault?: string; fallbackPath?: string; env?: NodeJS.ProcessEnv } = {}): string {
  try {
    return resolveObsidianVaultRoot({ vault: options.vault, env: options.env });
  } catch (error) {
    if (!options.fallbackPath) throw error;
    return resolveFallbackVaultPath(options.fallbackPath);
  }
}

function resolveFallbackVaultPath(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new RuntimeError(`Fallback vault path does not exist: ${input}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new RuntimeError(`Fallback vault path is not a directory: ${input}`);
  }
  return fs.realpathSync(resolved);
}
