import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../core/private-path.js";
import { durableRename, fsyncDirSync, fsyncFileSync, type DurableRename } from "../search-store/publication.js";
import {
  vectorGenerationDbPath,
  vectorGenerationDir,
  vectorStagingDbPath,
  vectorStagingDir,
  type VectorStoreCachePaths
} from "./cache-paths.js";
import { VectorCacheCatalog } from "./cache-catalog.js";
import { createCoralNeedleProcessInstanceFactory } from "./process-instance.js";
import type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralNeedleInstance,
  CoralNeedleInstanceFactory,
  CoralSearchResult,
  VectorGenerationMetadata,
  VectorSearchResult,
  VectorStoreKey
} from "./types.js";
import { vectorStoreKeyString } from "./types.js";

export type VectorGenerationPoolOptions = {
  factory?: CoralNeedleInstanceFactory;
  catalog?: VectorCacheCatalog;
  durableRenameActivePointer?: DurableRename;
  now?: () => number;
};

export type BuildVectorGenerationInput = {
  paths: VectorStoreCachePaths;
  spec: CoralEmbeddingSpec;
  chunks: readonly CoralChunkRecord[];
  engineName?: "auto" | string;
  generationId?: string;
};

export type BuiltVectorGeneration = {
  metadata: VectorGenerationMetadata;
  dbPath: string;
};

type GenerationHandle = {
  key: VectorStoreKey;
  generationId: string;
  dbPath: string;
  spec: CoralEmbeddingSpec;
  instance: CoralNeedleInstance;
  refCount: number;
  pinTokens: Set<string>;
  draining: boolean;
  closeStarted: boolean;
  closePromise?: Promise<void>;
  drainResolvers: Array<() => void>;
};

type VectorPin = {
  handle: GenerationHandle;
  token: string;
};

export class VectorGenerationPool {
  private readonly factory: CoralNeedleInstanceFactory;
  private readonly catalog: VectorCacheCatalog;
  private readonly renameActive: DurableRename;
  private readonly now: () => number;
  private readonly activeByKey = new Map<string, GenerationHandle>();
  private readonly generations = new Map<string, GenerationHandle>();
  private closed = false;

  constructor(options: VectorGenerationPoolOptions = {}) {
    this.factory = options.factory ?? createCoralNeedleProcessInstanceFactory();
    this.catalog = options.catalog ?? new VectorCacheCatalog();
    this.renameActive = options.durableRenameActivePointer ?? durableRename;
    this.now = options.now ?? Date.now;
  }

  async buildStagingGeneration(input: BuildVectorGenerationInput): Promise<BuiltVectorGeneration> {
    this.assertOpen();
    const generationId = input.generationId ?? createGenerationId(this.now());
    const stagingDir = vectorStagingDir(input.paths, generationId);
    const stagingDbPath = vectorStagingDbPath(input.paths, generationId);
    ensurePrivateDirSync(stagingDir, "Optsidian vector staging generation directory");
    const instance = await this.factory.create({
      role: "staging",
      key: input.paths.key,
      generationId,
      dbPath: stagingDbPath
    });
    try {
      await instance.initStore(stagingDbPath);
      await instance.setActiveSpec(input.spec);
      if (input.chunks.length > 0) await instance.upsertChunks(input.chunks);
      await instance.buildIndex(input.engineName ?? "auto");
      const finalDir = vectorGenerationDir(input.paths, generationId);
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
      ensurePrivateDirSync(input.paths.generationsDir, "Optsidian vector generations directory");
      await durableRename(stagingDir, finalDir);
      fsyncDirSync(input.paths.generationsDir);
      const metadata: VectorGenerationMetadata = {
        schemaVersion: 1,
        key: input.paths.key,
        generationId,
        dbPath: vectorGenerationDbPath(input.paths, generationId),
        spec: input.spec,
        chunkCount: input.chunks.length,
        builtEngine: input.engineName ?? "auto",
        createdAt: new Date(this.now()).toISOString(),
        embeddingSetId: input.paths.key.embeddingSetId
      };
      await storeVectorGenerationMetadata(input.paths, metadata);
      return { metadata, dbPath: metadata.dbPath };
    } finally {
      await Promise.resolve(instance.close()).catch(() => undefined);
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  async promoteBuiltGeneration(paths: VectorStoreCachePaths, metadata: VectorGenerationMetadata): Promise<void> {
    this.assertOpen();
    if (metadata.embeddingSetId !== paths.key.embeddingSetId) {
      throw new Error(`vector generation embeddingSetId mismatch: ${metadata.embeddingSetId}`);
    }
    const instance = await this.factory.create({
      role: "query",
      key: paths.key,
      generationId: metadata.generationId,
      dbPath: metadata.dbPath
    });
    let promoted = false;
    try {
      await instance.initStore(metadata.dbPath);
      await instance.setActiveSpec(metadata.spec);
      await instance.buildIndex(metadata.builtEngine);
      const next: GenerationHandle = {
        key: paths.key,
        generationId: metadata.generationId,
        dbPath: metadata.dbPath,
        spec: metadata.spec,
        instance,
        refCount: 0,
        pinTokens: new Set(),
        draining: false,
        closeStarted: false,
        drainResolvers: []
      };
      await writeActiveVectorPointer(paths, metadata, this.renameActive);
      this.flipActive(paths.key, next);
      this.catalog.recordBuilt(paths, {
        generationId: metadata.generationId,
        chunkCount: metadata.chunkCount,
        nowMs: this.now()
      });
      promoted = true;
    } finally {
      if (!promoted) await Promise.resolve(instance.close()).catch(() => undefined);
    }
  }

  async searchActiveBuiltIndex(input: {
    key: VectorStoreKey;
    queryVector: readonly number[] | Float32Array;
    candidateK: number;
    expectedGenerationId?: string;
  }): Promise<VectorSearchResult> {
    const pin = this.acquireActive(input.key);
    if (!pin) return { status: "index-not-ready", reason: "no-active-built-spec" };
    try {
      if (input.expectedGenerationId && pin.handle.generationId !== input.expectedGenerationId) {
        return { status: "index-not-ready", reason: "active-generation-mismatched" };
      }
      const results = await pin.handle.instance.searchVector(input.queryVector, input.candidateK);
      return {
        status: "ready",
        generationId: pin.handle.generationId,
        results
      };
    } finally {
      this.release(pin);
    }
  }

  statsForTests(): {
    active: Record<string, string>;
    refCounts: Record<string, number>;
    draining: string[];
  } {
    const refCounts: Record<string, number> = {};
    for (const [key, generation] of this.generations) refCounts[key] = generation.refCount;
    return {
      active: Object.fromEntries([...this.activeByKey.entries()].map(([key, generation]) => [key, generation.generationId])),
      refCounts,
      draining: [...this.generations.values()].filter((generation) => generation.draining).map((generation) => generation.generationId)
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closing = [...this.generations.values()].map((generation) => this.closeWhenDrained(generation));
    this.activeByKey.clear();
    await Promise.all(closing);
  }

  private acquireActive(key: VectorStoreKey): VectorPin | undefined {
    const handle = this.activeByKey.get(vectorStoreKeyString(key));
    if (!handle || handle.draining || handle.closeStarted) return undefined;
    handle.refCount += 1;
    const token = `${handle.generationId}:${handle.refCount}:${this.now()}:${Math.random().toString(16).slice(2)}`;
    handle.pinTokens.add(token);
    return { handle, token };
  }

  private release(pin: VectorPin): void {
    const handle = pin.handle;
    if (!handle.pinTokens.delete(pin.token)) return;
    handle.refCount = Math.max(0, handle.refCount - 1);
    if (handle.draining && handle.refCount === 0) {
      for (const resolve of handle.drainResolvers.splice(0)) resolve();
    }
  }

  private flipActive(key: VectorStoreKey, next: GenerationHandle): void {
    const keyString = vectorStoreKeyString(key);
    const old = this.activeByKey.get(keyString);
    this.generations.set(generationMapKey(key, next.generationId), next);
    this.activeByKey.set(keyString, next);
    if (old && old !== next) void this.retire(old);
  }

  private async retire(handle: GenerationHandle): Promise<void> {
    handle.draining = true;
    const keyString = vectorStoreKeyString(handle.key);
    if (this.activeByKey.get(keyString) === handle) this.activeByKey.delete(keyString);
    await this.closeWhenDrained(handle);
  }

  private async closeWhenDrained(handle: GenerationHandle): Promise<void> {
    if (handle.closePromise) return handle.closePromise;
    handle.closePromise = (async () => {
      handle.draining = true;
      if (handle.refCount > 0) {
        await new Promise<void>((resolve) => handle.drainResolvers.push(resolve));
      }
      if (handle.closeStarted) return;
      handle.closeStarted = true;
      await handle.instance.close();
      this.generations.delete(generationMapKey(handle.key, handle.generationId));
    })();
    return handle.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw Object.assign(new Error("vector generation pool is closed"), { code: "INTERNAL" });
  }
}

export async function storeVectorGenerationMetadata(
  paths: VectorStoreCachePaths,
  metadata: VectorGenerationMetadata
): Promise<void> {
  const generationDir = vectorGenerationDir(paths, metadata.generationId);
  ensurePrivateDirSync(generationDir, "Optsidian vector generation directory");
  const target = path.join(generationDir, "generation.json");
  const tmp = path.join(paths.tmpDir, `${metadata.generationId}.${process.pid}.vector-generation.tmp`);
  ensurePrivateDirSync(paths.tmpDir, "Optsidian vector tmp directory");
  writePrivateFileSync(tmp, `${JSON.stringify(metadata)}\n`, "Optsidian vector generation metadata");
  fsyncFileSync(tmp);
  await durableRename(tmp, target);
  fsyncDirSync(generationDir);
}

export function loadVectorGenerationMetadata(
  paths: VectorStoreCachePaths,
  generationId: string
): VectorGenerationMetadata | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(vectorGenerationDir(paths, generationId), "generation.json"), "utf8")) as unknown;
    if (!isVectorGenerationMetadata(parsed)) return undefined;
    if (parsed.generationId !== generationId || parsed.embeddingSetId !== paths.key.embeddingSetId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeActiveVectorPointer(
  paths: VectorStoreCachePaths,
  metadata: VectorGenerationMetadata,
  renameActive: DurableRename = durableRename
): Promise<void> {
  ensurePrivateDirSync(paths.activeDir, "Optsidian vector active pointer directory");
  ensurePrivateDirSync(paths.tmpDir, "Optsidian vector tmp directory");
  const pointer = {
    schemaVersion: 1,
    generationId: metadata.generationId,
    embeddingSetId: metadata.embeddingSetId,
    specId: metadata.spec.specId,
    dbPath: metadata.dbPath
  };
  const tmp = path.join(paths.tmpDir, `${metadata.generationId}.${process.pid}.vector-active.tmp`);
  writePrivateFileSync(tmp, `${JSON.stringify(pointer)}\n`, "Optsidian vector active pointer");
  fsyncFileSync(tmp);
  await renameActive(tmp, paths.activePointerPath);
  fsyncDirSync(paths.activeDir);
}

export function readActiveVectorPointer(paths: VectorStoreCachePaths): { generationId: string; embeddingSetId: string; specId: string; dbPath: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.activePointerPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return undefined;
    if (typeof parsed.generationId !== "string" || typeof parsed.embeddingSetId !== "string") return undefined;
    if (typeof parsed.specId !== "string" || typeof parsed.dbPath !== "string") return undefined;
    return {
      generationId: parsed.generationId,
      embeddingSetId: parsed.embeddingSetId,
      specId: parsed.specId,
      dbPath: parsed.dbPath
    };
  } catch {
    return undefined;
  }
}

export function sweepVectorStaging(paths: VectorStoreCachePaths): void {
  if (!fs.existsSync(paths.stagingDir)) return;
  for (const entry of fs.readdirSync(paths.stagingDir)) {
    fs.rmSync(path.join(paths.stagingDir, entry), { recursive: true, force: true });
  }
}

function generationMapKey(key: VectorStoreKey, generationId: string): string {
  return `${vectorStoreKeyString(key)}:${generationId}`;
}

function createGenerationId(nowMs: number): string {
  return `gen-${nowMs.toString(36)}-${process.pid.toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function isVectorGenerationMetadata(value: unknown): value is VectorGenerationMetadata {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    isRecord(value.key) &&
    typeof value.generationId === "string" &&
    typeof value.dbPath === "string" &&
    isRecord(value.spec) &&
    typeof value.chunkCount === "number" &&
    typeof value.builtEngine === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.embeddingSetId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
