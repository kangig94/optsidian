import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import type { CopyParams, MutationResult } from "./types.js";

export function copyVaultPath(vaultRoot: string, params: CopyParams): MutationResult {
  const source = resolveVaultPath(vaultRoot, params.from, { mustExist: true });
  const dest = resolveVaultPath(vaultRoot, params.to);
  const sourceStat = fs.statSync(source.abs);
  const destExists = fs.existsSync(dest.abs);
  if (destExists && !params.overwrite) {
    throw new UsageError(`Refusing to overwrite existing path: ${dest.rel}`);
  }
  if (sourceStat.isDirectory() && !params.recursive) {
    throw new UsageError("copy requires recursive for directories");
  }
  if (sourceStat.isDirectory()) {
    const rel = path.relative(source.abs, dest.abs);
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new UsageError("copy cannot copy a directory into itself");
    }
  }
  if (!params.dryRun) {
    fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
    fs.cpSync(source.abs, dest.abs, { recursive: sourceStat.isDirectory(), force: Boolean(params.overwrite), errorOnExist: !params.overwrite });
  }
  return {
    ok: true,
    command: "copy",
    dryRun: Boolean(params.dryRun),
    changes: [{ code: destExists ? "M" : "A", path: dest.rel, from: source.rel }]
  };
}
