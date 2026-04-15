import { spawnSync } from "node:child_process";
import { obsidianBin } from "../native/obsidian.js";
import { RuntimeError } from "../errors.js";

export function delegateToObsidian(args: string[]): never {
  const result = spawnSync(obsidianBin(), args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) {
    throw new RuntimeError(`Failed to run obsidian: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}
