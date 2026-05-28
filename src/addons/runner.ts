import { spawnSync } from "node:child_process";
import { RuntimeError } from "../errors.js";
import type { ParsedArgs } from "../cli/args.js";
import { findInstalledAddon } from "./registry.js";

export function runInstalledAddon(args: ParsedArgs): never {
  const addon = findInstalledAddon(args.command);
  if (!addon) {
    throw new RuntimeError(`Addon is not installed: ${args.command ?? ""}`);
  }

  const result = spawnSync(process.execPath, [addon.cliPath, ...args.raw], {
    stdio: "inherit",
    env: {
      ...process.env,
      OPTSIDIAN_ADDON_ID: addon.id,
      OPTSIDIAN_ADDON_ROOT: addon.root,
      OPTSIDIAN_BIN: process.argv[1]
    }
  });
  if (result.error) {
    throw new RuntimeError(`Failed to run addon ${addon.id}: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}
