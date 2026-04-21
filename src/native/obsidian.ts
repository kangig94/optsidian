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

export function listObsidianCommands(env: NodeJS.ProcessEnv = process.env): string[] {
  const result = captureObsidian(["help"], env);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new RuntimeError(details || "Failed to list Obsidian commands");
  }

  const commands: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^ {2}([a-z0-9][a-z0-9:_-]*)\s{2,}\S/.exec(line);
    if (!match) continue;
    commands.push(match[1]);
  }
  return commands;
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
    return resolveVaultPathInput(options.fallbackPath);
  }
}

export function resolveVaultPathInput(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new RuntimeError(`Vault path does not exist: ${input}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new RuntimeError(`Vault path is not a directory: ${input}`);
  }
  return fs.realpathSync(resolved);
}
