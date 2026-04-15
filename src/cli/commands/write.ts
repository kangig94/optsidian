import { getValue, hasFlag, ParsedArgs, readValueOrFile, requireValue } from "../args.js";
import { writeVaultFile } from "../../core/write.js";
import { UsageError } from "../../errors.js";
import { renderMutation } from "../render.js";

export function runWrite(args: ParsedArgs, vaultRoot: string): void {
  const rawContent = getValue(args, "content");
  if (rawContent === undefined) throw new UsageError("Missing required argument: content=<text>|content=@<file>");
  const result = writeVaultFile(vaultRoot, {
    path: requireValue(args, "path"),
    content: readValueOrFile(rawContent),
    overwrite: hasFlag(args, "overwrite"),
    dryRun: hasFlag(args, "dry-run")
  });
  process.stdout.write(renderMutation(result));
}
