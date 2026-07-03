import crypto from 'node:crypto';
import path from 'node:path';
import { optsidianCacheRoot } from '../../core/cache-root.js';
import { vaultRealpath } from '../../core/path.js';
import { safeStoreFileName } from '../search-store/cache-paths.js';
import type { VectorStoreKey } from './types.js';

export type VectorStoreCachePaths = {
  vaultRoot: string;
  key: VectorStoreKey;
  cacheRootDir: string;
  vectorsRootDir: string;
  storesDir: string;
  vaultDir: string;
  rootDir: string;
  storeStatePath: string;
  generationsDir: string;
  stagingDir: string;
  reservationsDir: string;
  tmpDir: string;
};

export function vectorStoreCachePaths(input: {
  vaultRoot: string;
  profileHash?: string;
  embeddingSetId: string;
  env?: NodeJS.ProcessEnv;
}): VectorStoreCachePaths {
  const env = input.env ?? process.env;
  const root = vaultRealpath(input.vaultRoot);
  const vaultStateHash = sha256(root).slice(0, 16);
  const embeddingSetId = safeStoreFileName(input.embeddingSetId);
  const cacheRootDir = optsidianCacheRoot(env);
  const vectorsRootDir = path.join(cacheRootDir, 'vectors');
  const storesDir = path.join(vectorsRootDir, 'stores');
  const vaultDir = path.join(storesDir, vaultStateHash);
  const rootDir = path.join(vaultDir, embeddingSetId);
  const key: VectorStoreKey = { vaultStateHash, embeddingSetId };
  return {
    vaultRoot: root,
    key,
    cacheRootDir,
    vectorsRootDir,
    storesDir,
    vaultDir,
    rootDir,
    storeStatePath: path.join(rootDir, 'store.json'),
    generationsDir: path.join(rootDir, 'generations'),
    stagingDir: path.join(rootDir, 'staging'),
    reservationsDir: path.join(rootDir, 'reservations'),
    tmpDir: path.join(rootDir, 'tmp'),
  };
}

export function vectorGenerationDir(paths: VectorStoreCachePaths, manifestHash: string): string {
  return path.join(paths.generationsDir, safeStoreFileName(manifestHash));
}

export function vectorGenerationDbPath(paths: VectorStoreCachePaths, manifestHash: string): string {
  return path.join(vectorGenerationDir(paths, manifestHash), 'vectors.duckdb');
}

export function vectorStagingDir(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(paths.stagingDir, safeStoreFileName(generationId));
}

export function vectorStagingDbPath(paths: VectorStoreCachePaths, generationId: string): string {
  return path.join(vectorStagingDir(paths, generationId), 'vectors.duckdb');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
