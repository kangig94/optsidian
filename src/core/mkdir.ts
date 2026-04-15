import fs from "node:fs";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import type { MkdirParams, MutationResult } from "./types.js";

export function mkdirVaultPath(vaultRoot: string, params: MkdirParams): MutationResult {
  const target = resolveVaultPath(vaultRoot, params.path);
  if (fs.existsSync(target.abs)) {
    if (fs.statSync(target.abs).isDirectory()) {
      return {
        ok: true,
        command: "mkdir",
        dryRun: Boolean(params.dryRun),
        message: `Directory already exists: ${target.rel}`,
        changes: []
      };
    }
    throw new UsageError(`Path exists and is not a directory: ${target.rel}`);
  }
  if (!params.dryRun) {
    fs.mkdirSync(target.abs, { recursive: params.parents !== false });
  }
  return {
    ok: true,
    command: "mkdir",
    dryRun: Boolean(params.dryRun),
    changes: [{ code: "A", path: target.rel }]
  };
}
