import fs from "node:fs";
import { getValue, hasFlag, ParsedArgs, readValueOrFile } from "../args.js";
import { applyVaultPatch } from "../../core/apply-patch.js";
import { UsageError } from "../../errors.js";
import { renderMutation } from "../render.js";

export function runApplyPatch(args: ParsedArgs, vaultRoot: string): void {
  const result = applyVaultPatch(vaultRoot, {
    patch: readPatch(args),
    dryRun: hasFlag(args, "dry-run")
  });
  process.stdout.write(renderMutation(result));
}

function readPatch(args: ParsedArgs): string {
  const patchValue = getValue(args, "patch");
  if (patchValue !== undefined) {
    return readValueOrFile(patchValue);
  }
  if (!process.stdin.isTTY) {
    const input = fs.readFileSync(0, "utf8");
    if (input.trim()) return input;
  }
  throw new UsageError("Missing patch input. Pass patch=<text>, patch=@<file>, or pipe patch text on stdin.");
}
