import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralNeedleBinding,
  CoralSearchResult,
  CoralStoreStats
} from "./types.js";

type NativeCoralNeedleBinding = {
  initStore(dbPath: string): void;
  closeStore(): void;
  setActiveSpec(spec: CoralEmbeddingSpec): void;
  upsertChunks(chunks: readonly CoralChunkRecord[]): void;
  buildIndex(engineName?: string): void;
  searchVector(queryVector: readonly number[] | Float32Array, candidateK: number): CoralSearchResult[];
  getStats?(): CoralStoreStats;
};

export type CoralNeedleBindingLoadStatus =
  | { loaded: true; path: string }
  | { loaded: false; attempted: readonly string[]; error: string };

let cachedBinding: CoralNeedleBinding | undefined;
let cachedStatus: CoralNeedleBindingLoadStatus | undefined;

export function loadCoralNeedleBinding(): CoralNeedleBinding {
  if (cachedBinding) return cachedBinding;
  const require = createRequire(import.meta.url);
  const attempted: string[] = [];
  let lastError: unknown;
  for (const candidate of coralNeedleCandidates()) {
    attempted.push(candidate);
    try {
      if (!fs.existsSync(candidate)) continue;
      const native = require(candidate) as NativeCoralNeedleBinding;
      cachedBinding = adaptNativeBinding(native);
      cachedStatus = { loaded: true, path: candidate };
      return cachedBinding;
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : lastError === undefined ? "coral-needle binary was not found" : String(lastError);
  cachedStatus = { loaded: false, attempted, error: message };
  throw Object.assign(new Error(`coral-needle native binding is not available: ${message}`), {
    code: "CORAL_NEEDLE_UNAVAILABLE",
    attempted
  });
}

export function coralNeedleBindingLoadStatus(): CoralNeedleBindingLoadStatus {
  if (cachedStatus) return cachedStatus;
  try {
    loadCoralNeedleBinding();
  } catch {}
  return cachedStatus ?? {
    loaded: false,
    attempted: coralNeedleCandidates(),
    error: "coral-needle binary was not found"
  };
}

function adaptNativeBinding(native: NativeCoralNeedleBinding): CoralNeedleBinding {
  return {
    initStore: (dbPath) => native.initStore(dbPath),
    setActiveSpec: (spec) => native.setActiveSpec(spec),
    upsertChunks: (chunks) => native.upsertChunks(chunks),
    buildIndex: (engineName = "auto") => native.buildIndex(engineName),
    searchVector: (queryVector, candidateK) => native.searchVector(queryVector, candidateK),
    close: () => native.closeStore(),
    ...(native.getStats ? { getStats: () => native.getStats?.() as CoralStoreStats } : {})
  };
}

function coralNeedleCandidates(): string[] {
  const root = path.resolve(process.cwd(), "..", "coral-needle");
  return [
    path.join(root, "build", "coral-needle.node"),
    path.join(root, "build", "Release", "coral-needle.node"),
    path.join(root, "dist", "coral-needle.node")
  ];
}
