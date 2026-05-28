import { runObsidianSync } from "../native/obsidian.js";
import { RuntimeError } from "../errors.js";

export function delegateToObsidian(args: string[]): never {
  const result = runObsidianSync(args, { stdio: "inherit" });
  if (result.error) {
    throw new RuntimeError(`Failed to run obsidian: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}
