import fs from "node:fs";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import type { VectorStoreCachePaths } from "./cache-paths.js";
import { sweepVectorStaging } from "./pool.js";

export async function recoverRetrievalStaging(input: {
  vectorPaths: VectorStoreCachePaths;
  lexicalTmpDir?: string;
  linkGraphTmpDir?: string;
}): Promise<void> {
  sweepVectorStaging(input.vectorPaths);
  sweepTmpDir(input.vectorPaths.tmpDir);
  sweepTmpDir(input.lexicalTmpDir);
  sweepTmpDir(input.linkGraphTmpDir);
}

export async function recoverRetrievalStartupState(input: {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
} = {}): Promise<void> {
  const env = input.env ?? process.env;
  const cacheRoot = optsidianCacheRoot(env);
  const vectorStoresRoot = path.join(cacheRoot, "vectors", "stores");
  const searchStoresRoot = path.join(cacheRoot, "search", "stores");
  for (const vaultStateHash of safeReadDir(vectorStoresRoot)) {
    const vaultDir = path.join(vectorStoresRoot, vaultStateHash);
    if (!isDirectory(vaultDir)) continue;
    const candidates = vectorEmbeddingSetCandidates(vaultDir);
    for (const embeddingSetId of candidates) {
      const vectorPaths = vectorPathsFromCacheParts({
        cacheRoot,
        vaultStateHash,
        embeddingSetId
      });
      await recoverRetrievalStaging({ vectorPaths });
    }
  }
  sweepSearchStoreTmpDirs(searchStoresRoot);
}

function sweepTmpDir(dir: string | undefined): void {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function vectorEmbeddingSetCandidates(vaultDir: string): string[] {
  const candidates = new Set<string>();
  for (const entry of safeReadDir(vaultDir)) {
    const candidate = path.join(vaultDir, entry);
    if (isDirectory(candidate)) candidates.add(entry);
  }
  return [...candidates].sort();
}

function sweepSearchStoreTmpDirs(storesDir: string): void {
  for (const vaultStateHash of safeReadDir(storesDir)) {
    const vaultDir = path.join(storesDir, vaultStateHash);
    if (!isDirectory(vaultDir)) continue;
    for (const lexicalIdentityHash of safeReadDir(vaultDir)) {
      const searchStoreDir = path.join(vaultDir, lexicalIdentityHash);
      if (!isDirectory(searchStoreDir)) continue;
      sweepTmpDir(path.join(searchStoreDir, "tmp"));
    }
  }
}

function vectorPathsFromCacheParts(input: {
  cacheRoot: string;
  vaultStateHash: string;
  embeddingSetId: string;
}): VectorStoreCachePaths {
  const vectorsRootDir = path.join(input.cacheRoot, "vectors");
  const storesDir = path.join(vectorsRootDir, "stores");
  const vaultDir = path.join(storesDir, input.vaultStateHash);
  const rootDir = path.join(vaultDir, input.embeddingSetId);
  return {
    vaultRoot: "",
    key: {
      vaultStateHash: input.vaultStateHash,
      embeddingSetId: input.embeddingSetId
    },
    cacheRootDir: input.cacheRoot,
    vectorsRootDir,
    storesDir,
    vaultDir,
    rootDir,
    storeStatePath: path.join(rootDir, "store.json"),
    generationsDir: path.join(rootDir, "generations"),
    stagingDir: path.join(rootDir, "staging"),
    reservationsDir: path.join(rootDir, "reservations"),
    tmpDir: path.join(rootDir, "tmp")
  };
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
