import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import { simpleDiff } from "./text.js";
import { atomicWriteFile } from "./write-file.js";
import type { MutationResult, WriteParams } from "./types.js";

export function writeVaultFile(vaultRoot: string, params: WriteParams): MutationResult {
  const target = resolveVaultPath(vaultRoot, params.path);
  const exists = fs.existsSync(target.abs);
  if (exists && !fs.statSync(target.abs).isFile()) {
    throw new UsageError(`Refusing to write non-file path: ${target.rel}`);
  }
  if (exists && !params.overwrite) {
    throw new UsageError(`Refusing to overwrite existing file: ${target.rel}`);
  }
  const before = exists ? fs.readFileSync(target.abs, "utf8") : "";
  const diff = simpleDiff(target.rel, before, params.content);
  if (!params.dryRun) {
    atomicWriteFile(target.abs, params.content);
  }
  return {
    ok: true,
    command: "write",
    dryRun: Boolean(params.dryRun),
    changes: [{ code: exists ? "M" : "A", path: target.rel, before, after: params.content, diff }]
  };
}
