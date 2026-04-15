import { getValue, hasFlag, ParsedArgs, requireValue } from "../args.js";
import { mkdirVaultPath } from "../../core/mkdir.js";
import { renderMutation } from "../render.js";

export function runMkdir(args: ParsedArgs, vaultRoot: string): void {
  const result = mkdirVaultPath(vaultRoot, {
    path: requireValue(args, "path"),
    parents: getValue(args, "parents") !== "false",
    dryRun: hasFlag(args, "dry-run")
  });
  process.stdout.write(renderMutation(result));
}
