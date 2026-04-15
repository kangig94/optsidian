import { hasFlag, ParsedArgs, requireValue } from "../args.js";
import { copyVaultPath } from "../../core/copy.js";
import { renderMutation } from "../render.js";

export function runCopy(args: ParsedArgs, vaultRoot: string): void {
  const result = copyVaultPath(vaultRoot, {
    from: requireValue(args, "from"),
    to: requireValue(args, "to"),
    recursive: hasFlag(args, "recursive"),
    overwrite: hasFlag(args, "overwrite"),
    dryRun: hasFlag(args, "dry-run")
  });
  process.stdout.write(renderMutation(result));
}
