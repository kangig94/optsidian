import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { vaultRealpath } from "../path.js";
import {
  SEARCH_ANALYSIS_CACHE_FILE,
  SEARCH_COMMIT_FILE,
  SEARCH_INDEX_FILE,
  SEARCH_INDEX_WRITER_LOCK_DIR,
  SEARCH_MANIFEST_FILE,
  SEARCH_RECONCILE_LOCK_DIR,
  SEARCH_RECONCILE_STATUS_FILE
} from "./constants.js";
import type { CachePaths } from "./internal-types.js";

export function cachePaths(vaultRoot: string, analyzerKey = "intl"): CachePaths {
  const root = vaultRealpath(vaultRoot);
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheDir = path.join(base, "optsidian", hash);
  const safeAnalyzerKey = analyzerKey.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "intl";
  const indexDir = path.join(cacheDir, "indexes", safeAnalyzerKey);
  return {
    cacheDir,
    indexDir,
    indexPath: path.join(indexDir, SEARCH_INDEX_FILE),
    manifestPath: path.join(indexDir, SEARCH_MANIFEST_FILE),
    commitPath: path.join(indexDir, SEARCH_COMMIT_FILE),
    analysisPath: path.join(indexDir, SEARCH_ANALYSIS_CACHE_FILE)
  };
}

export function searchReconcileLockPath(vaultRoot: string): string {
  return path.join(cachePaths(vaultRoot).cacheDir, SEARCH_RECONCILE_LOCK_DIR);
}

export function searchIndexWriterLockPath(vaultRoot: string): string {
  return path.join(cachePaths(vaultRoot).cacheDir, SEARCH_INDEX_WRITER_LOCK_DIR);
}

export function searchReconcileStatusPath(vaultRoot: string): string {
  return path.join(cachePaths(vaultRoot).cacheDir, SEARCH_RECONCILE_STATUS_FILE);
}
