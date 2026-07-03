import crypto from "node:crypto";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import { vaultRealpath } from "../../core/path.js";

export type SearchStoreCachePaths = {
  vaultRoot: string;
  vaultStateHash: string;
  lexicalIdentityHash: string;
  storeId: string;
  cacheRootDir: string;
  searchRootDir: string;
  storesDir: string;
  vaultDir: string;
  rootDir: string;
  storeStatePath: string;
  segmentsDir: string;
  snapshotsDir: string;
  retrievalsDir: string;
  linkGraphsDir: string;
  ledgersDir: string;
  activeDir: string;
  tmpDir: string;
};

export function searchStoreCachePaths(
  vaultRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  identity: { lexicalIdentityHash?: string } = {}
): SearchStoreCachePaths {
  const root = vaultRealpath(vaultRoot);
  const vaultStateHash = sha256(root).slice(0, 16);
  const lexicalIdentityHash = safeStoreFileName(identity.lexicalIdentityHash ?? "default-lexical");
  const storeId = `${vaultStateHash}:${lexicalIdentityHash}`;
  const cacheRootDir = optsidianCacheRoot(env);
  const searchRootDir = path.join(cacheRootDir, "search");
  const storesDir = path.join(searchRootDir, "stores");
  const vaultDir = path.join(storesDir, vaultStateHash);
  const rootDir = path.join(vaultDir, lexicalIdentityHash);
  const activeDir = path.join(rootDir, "active");
  return {
    vaultRoot: root,
    vaultStateHash,
    lexicalIdentityHash,
    storeId,
    cacheRootDir,
    searchRootDir,
    storesDir,
    vaultDir,
    rootDir,
    storeStatePath: path.join(rootDir, "store.json"),
    segmentsDir: path.join(rootDir, "segments"),
    snapshotsDir: path.join(rootDir, "snapshots"),
    retrievalsDir: path.join(rootDir, "retrievals"),
    linkGraphsDir: path.join(rootDir, "link-graphs"),
    ledgersDir: path.join(rootDir, "ledgers"),
    activeDir,
    tmpDir: path.join(rootDir, "tmp")
  };
}

export function searchStoreLedgerRootDir(paths: SearchStoreCachePaths, embeddingSpaceId: string): string {
  return path.join(paths.ledgersDir, safeStoreFileName(embeddingSpaceId));
}

export function searchStoreId(paths: SearchStoreCachePaths): string {
  return paths.storeId;
}

export function safeStoreFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
