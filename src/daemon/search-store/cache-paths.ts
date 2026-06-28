import crypto from "node:crypto";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import { vaultRealpath } from "../../core/path.js";

export type SearchStoreCachePaths = {
  vaultRoot: string;
  vaultStateHash: string;
  cacheRootDir: string;
  searchRootDir: string;
  storesDir: string;
  rootDir: string;
  storeStatePath: string;
  segmentsDir: string;
  snapshotsDir: string;
  activeDir: string;
  tmpDir: string;
  activePointerPath: string;
};

export function searchStoreCachePaths(vaultRoot: string, env: NodeJS.ProcessEnv = process.env): SearchStoreCachePaths {
  const root = vaultRealpath(vaultRoot);
  const vaultStateHash = sha256(root).slice(0, 16);
  const cacheRootDir = optsidianCacheRoot(env);
  const searchRootDir = path.join(cacheRootDir, "search");
  const storesDir = path.join(searchRootDir, "stores");
  const rootDir = path.join(storesDir, vaultStateHash);
  const activeDir = path.join(rootDir, "active");
  return {
    vaultRoot: root,
    vaultStateHash,
    cacheRootDir,
    searchRootDir,
    storesDir,
    rootDir,
    storeStatePath: path.join(rootDir, "store.json"),
    segmentsDir: path.join(rootDir, "segments"),
    snapshotsDir: path.join(rootDir, "snapshots"),
    activeDir,
    tmpDir: path.join(rootDir, "tmp"),
    activePointerPath: path.join(activeDir, vaultStateHash)
  };
}

export function safeStoreFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
