import crypto from "node:crypto";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import { vaultRealpath } from "../../core/path.js";
import { safeStoreFileName } from "../search-store/cache-paths.js";
import type { VectorStoreKey } from "./types.js";

export type VectorStoreCachePaths = {
  vaultRoot: string;
  key: VectorStoreKey;
  cacheRootDir: string;
  vectorsRootDir: string;
  storesDir: string;
  profileDir: string;
  vaultDir: string;
  rootDir: string;
  storeStatePath: string;
  generationsDir: string;
  stagingDir: string;
  activeDir: string;
  tmpDir: string;
  freshnessStatePath: string;
  activePointerPath: string;
};

export function vectorStoreCachePaths(input: {
  vaultRoot: string;
  profileHash: string;
  embeddingSetId: string;
  env?: NodeJS.ProcessEnv;
}): VectorStoreCachePaths {
  const env = input.env ?? process.env;
  const root = vaultRealpath(input.vaultRoot);
  const vaultStateHash = sha256(root).slice(0, 16);
  const profileHash = safeStoreFileName(input.profileHash);
  const embeddingSetId = safeStoreFileName(input.embeddingSetId);
  const cacheRootDir = optsidianCacheRoot(env);
  const vectorsRootDir = path.join(cacheRootDir, "vectors");
  const storesDir = path.join(vectorsRootDir, "stores");
  const profileDir = path.join(storesDir, profileHash);
  const vaultDir = path.join(profileDir, vaultStateHash);
  const rootDir = path.join(vaultDir, embeddingSetId);
  const activeDir = path.join(rootDir, "active");
  const key: VectorStoreKey = { profileHash, vaultStateHash, embeddingSetId };
  return {
    vaultRoot: root,
    key,
    cacheRootDir,
    vectorsRootDir,
    storesDir,
    profileDir,
    vaultDir,
    rootDir,
    storeStatePath: path.join(rootDir, "store.json"),
    generationsDir: path.join(rootDir, "generations"),
    stagingDir: path.join(rootDir, "staging"),
    activeDir,
    tmpDir: path.join(rootDir, "tmp"),
    freshnessStatePath: path.join(vaultDir, "retrieval-freshness.json"),
    activePointerPath: path.join(activeDir, embeddingSetId)
  };
}

export function vectorGenerationDir(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(paths.generationsDir, safeStoreFileName(generationId));
}

export function vectorGenerationDbPath(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(vectorGenerationDir(paths, generationId), "vectors.duckdb");
}

export function vectorStagingDir(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(paths.stagingDir, safeStoreFileName(generationId));
}

export function vectorStagingDbPath(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(vectorStagingDir(paths, generationId), "vectors.duckdb");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
