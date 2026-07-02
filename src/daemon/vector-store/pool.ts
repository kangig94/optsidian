import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../core/private-path.js";
import type { EmbeddingRecipeFreshnessId, EmbeddingSpaceId } from "../../core/search/dense/index.js";
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
import type { SearchIndexProgressUpdate } from "../protocol.js";

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
  generationId: string;
  embeddingSpaceId?: EmbeddingSpaceId;
  embeddingRecipeFreshnessId?: EmbeddingRecipeFreshnessId;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type BuiltVectorGeneration = {
  metadata: VectorGenerationMetadata;
  dbPath: string;
  reused?: boolean;
};

export type ReadableVectorGenerationLease = {
  readonly key: VectorStoreKey;
  readonly generationId: string;
  readonly dbPath: string;
  readonly spec: CoralEmbeddingSpec;
  searchVector(queryVector: readonly number[] | Float32Array, candidateK: number): Promise<CoralSearchResult[]>;
  release(): void;
};

type PinReadableGenerationNotReadyReason =
  | "no-active-built-spec"
  | "active-generation-mismatched"
  | "active-generation-unreadable";

export type PinReadableGenerationResult =
  | { status: "ready"; lease: ReadableVectorGenerationLease }
  | { status: "index-not-ready"; reason: PinReadableGenerationNotReadyReason };

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
  private readonly lazyOpenByGeneration = new Map<string, Promise<GenerationHandle>>();
  private closed = false;

  constructor(options: VectorGenerationPoolOptions = {}) {
    this.factory = options.factory ?? createCoralNeedleProcessInstanceFactory();
    this.catalog = options.catalog ?? new VectorCacheCatalog();
    this.renameActive = options.durableRenameActivePointer ?? durableRename;
    this.now = options.now ?? Date.now;
  }

  async buildStagingGeneration(input: BuildVectorGenerationInput): Promise<BuiltVectorGeneration> {
    this.assertOpen();
    const generationId = input.generationId;
    const manifestHash = vectorGenerationManifestHash(input);
    const finalDir = vectorGenerationDir(input.paths, manifestHash);
    const finalDbPath = vectorGenerationDbPath(input.paths, manifestHash);
    const existing = await this.inspectExistingGeneration(input, manifestHash);
    if (existing.status === "reusable") {
      input.progress?.({
        phase: "vector-indexing",
        total: input.chunks.length + 2,
        completed: input.chunks.length + 2,
        current: generationId,
        message: "reused"
      });
      return { metadata: existing.metadata, dbPath: existing.metadata.dbPath, reused: true };
    }
    if (existing.status === "blocked") throw new Error(`vector generation ${generationId} already exists with conflicting manifest content: ${existing.reason}`);
    const stagingToken = `${generationId}.${process.pid}.${this.now()}.${Math.random().toString(16).slice(2)}`;
    const stagingDir = vectorStagingDir(input.paths, stagingToken);
    const stagingDbPath = vectorStagingDbPath(input.paths, stagingToken);
    const progressTotal = input.chunks.length + 2;
    input.progress?.({
      phase: "vector-indexing",
      total: progressTotal,
      completed: 0,
      current: generationId
    });
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
      input.progress?.({
        phase: "vector-indexing",
        total: progressTotal,
        completed: input.chunks.length,
        current: generationId,
        message: `${input.chunks.length} chunks`
      });
      await instance.buildIndex(input.engineName ?? "auto");
      input.progress?.({
        phase: "vector-indexing",
        total: progressTotal,
        completed: input.chunks.length + 1,
        current: generationId,
        message: "built"
      });
      ensurePrivateDirSync(input.paths.generationsDir, "Optsidian vector generations directory");
      const metadata: VectorGenerationMetadata = {
        schemaVersion: 1,
        key: input.paths.key,
        generationId,
        dbPath: finalDbPath,
        spec: input.spec,
        chunkCount: input.chunks.length,
        builtEngine: input.engineName ?? "auto",
        createdAt: new Date(this.now()).toISOString(),
        embeddingSetId: input.paths.key.embeddingSetId,
        ...(input.embeddingSpaceId ? { embeddingSpaceId: input.embeddingSpaceId } : {}),
        ...(input.embeddingRecipeFreshnessId ? { embeddingRecipeFreshnessId: input.embeddingRecipeFreshnessId } : {}),
        manifestHash
      };
      await this.publishBuiltGenerationDirectory(input, stagingDir, finalDir);
      await storeVectorGenerationMetadata(input.paths, metadata);
      input.progress?.({
        phase: "vector-indexing",
        total: progressTotal,
        completed: progressTotal,
        current: generationId,
        message: "stored"
      });
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
    const active = this.activeByKey.get(vectorStoreKeyString(paths.key));
    if (active && !active.draining && !active.closeStarted && generationHandleMatchesMetadata(active, metadata)) {
      this.recordPromotedGeneration(paths, metadata);
      return;
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
      const current = this.activeByKey.get(vectorStoreKeyString(paths.key));
      if (current && !current.draining && !current.closeStarted && generationHandleMatchesMetadata(current, metadata)) {
        promoted = true;
        await Promise.resolve(instance.close()).catch(() => undefined);
        this.recordPromotedGeneration(paths, metadata);
        return;
      }
      this.flipActive(paths.key, next);
      this.recordPromotedGeneration(paths, metadata);
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

  async pinReadableGeneration(input: {
    paths: VectorStoreCachePaths;
    key?: VectorStoreKey;
    expectedGenerationId: string;
    expectedManifestHash?: string;
    expectedDbPath?: string;
    expectedSpec: CoralEmbeddingSpec;
  }): Promise<PinReadableGenerationResult> {
    this.assertOpen();
    const key = input.key ?? input.paths.key;
    if (!vectorStoreKeysEqual(key, input.paths.key)) {
      return { status: "index-not-ready", reason: "active-generation-mismatched" };
    }
    const activePin = this.acquireActive(key);
    if (activePin) {
      if (
        activePin.handle.generationId !== input.expectedGenerationId ||
        !embeddingSpecEqual(activePin.handle.spec, input.expectedSpec)
      ) {
        this.release(activePin);
        return { status: "index-not-ready", reason: "active-generation-mismatched" };
      }
      return { status: "ready", lease: this.leaseFromPin(activePin) };
    }

    try {
      const handle = await this.lazyOpenGeneration({
        paths: input.paths,
        key,
        expectedGenerationId: input.expectedGenerationId,
        expectedManifestHash: input.expectedManifestHash,
        expectedDbPath: input.expectedDbPath,
        expectedSpec: input.expectedSpec
      });
      const pin = this.acquireHandle(handle);
      return { status: "ready", lease: this.leaseFromPin(pin) };
    } catch (error) {
      const reason = error && typeof error === "object" && "reason" in error
        ? (error as { reason?: unknown }).reason
        : undefined;
      if (
        reason === "no-active-built-spec" ||
        reason === "active-generation-mismatched" ||
        reason === "active-generation-unreadable"
      ) {
        return { status: "index-not-ready", reason };
      }
      return { status: "index-not-ready", reason: "active-generation-unreadable" };
    }
  }

  statsForTests(): {
    active: Record<string, string>;
    refCounts: Record<string, number>;
    draining: string[];
    lazyOpens: string[];
  } {
    const refCounts: Record<string, number> = {};
    for (const [key, generation] of this.generations) refCounts[key] = generation.refCount;
    return {
      active: Object.fromEntries([...this.activeByKey.entries()].map(([key, generation]) => [key, generation.generationId])),
      refCounts,
      draining: [...this.generations.values()].filter((generation) => generation.draining).map((generation) => generation.generationId),
      lazyOpens: [...this.lazyOpenByGeneration.keys()]
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
    return this.acquireHandle(handle);
  }

  private acquireHandle(handle: GenerationHandle): VectorPin {
    handle.refCount += 1;
    const token = `${handle.generationId}:${handle.refCount}:${this.now()}:${Math.random().toString(16).slice(2)}`;
    handle.pinTokens.add(token);
    return { handle, token };
  }

  private leaseFromPin(pin: VectorPin): ReadableVectorGenerationLease {
    let released = false;
    return {
      key: pin.handle.key,
      generationId: pin.handle.generationId,
      dbPath: pin.handle.dbPath,
      spec: pin.handle.spec,
      searchVector: (queryVector, candidateK) => Promise.resolve(pin.handle.instance.searchVector(queryVector, candidateK)),
      release: () => {
        if (released) return;
        released = true;
        this.release(pin);
      }
    };
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
    if (old && old !== next && old.generationId === next.generationId) {
      throw new Error(`refusing to replace active vector handle with same generation id: ${next.generationId}`);
    }
    this.generations.set(generationMapKey(key, next.generationId), next);
    this.activeByKey.set(keyString, next);
    // Retiring a superseded generation is best-effort: its subprocess may already be dead, and a
    // rejected close must never escape as an unhandled rejection (which would exit the daemon).
    if (old && old !== next) void this.retire(old).catch(() => undefined);
  }

  private async lazyOpenGeneration(input: {
    paths: VectorStoreCachePaths;
    key: VectorStoreKey;
    expectedGenerationId: string;
    expectedManifestHash?: string;
    expectedDbPath?: string;
    expectedSpec: CoralEmbeddingSpec;
  }): Promise<GenerationHandle> {
    const mapKey = generationMapKey(input.key, `${input.expectedGenerationId}:${input.expectedManifestHash ?? ""}`);
    const existing = this.lazyOpenByGeneration.get(mapKey);
    if (existing) return existing;
    const open = this.openGeneration(input);
    this.lazyOpenByGeneration.set(mapKey, open);
    try {
      return await open;
    } finally {
      if (this.lazyOpenByGeneration.get(mapKey) === open) this.lazyOpenByGeneration.delete(mapKey);
    }
  }

  private async openGeneration(input: {
    paths: VectorStoreCachePaths;
    key: VectorStoreKey;
    expectedGenerationId: string;
    expectedManifestHash?: string;
    expectedDbPath?: string;
    expectedSpec: CoralEmbeddingSpec;
  }): Promise<GenerationHandle> {
    const ready = this.activeByKey.get(vectorStoreKeyString(input.key));
    if (ready && !ready.draining && !ready.closeStarted) {
      if (
        ready.generationId !== input.expectedGenerationId ||
        (input.expectedDbPath !== undefined && ready.dbPath !== input.expectedDbPath) ||
        !embeddingSpecEqual(ready.spec, input.expectedSpec)
      ) {
        throw notReady("active-generation-mismatched");
      }
      return ready;
    }

    const metadata = input.expectedManifestHash
      ? loadVectorGenerationMetadataByManifest(input.paths, input.expectedManifestHash)
      : loadVectorGenerationMetadata(input.paths, input.expectedGenerationId);
    if (!metadata) throw notReady("active-generation-unreadable");
    if (
      metadata.generationId !== input.expectedGenerationId ||
      metadata.embeddingSetId !== input.key.embeddingSetId ||
      (input.expectedDbPath !== undefined && metadata.dbPath !== input.expectedDbPath) ||
      metadata.spec.specId !== input.expectedSpec.specId ||
      !embeddingSpecEqual(metadata.spec, input.expectedSpec) ||
      !vectorStoreKeysEqual(metadata.key, input.key)
    ) {
      throw notReady("active-generation-mismatched");
    }
    if (!fs.existsSync(metadata.dbPath)) throw notReady("active-generation-unreadable");

    const instance = await this.factory.create({
      role: "query",
      key: input.key,
      generationId: metadata.generationId,
      dbPath: metadata.dbPath
    });
    let installed = false;
    try {
      await instance.initStore(metadata.dbPath);
      await instance.setActiveSpec(metadata.spec);
      await instance.buildIndex(metadata.builtEngine);
      const next: GenerationHandle = {
        key: input.key,
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
      const current = this.activeByKey.get(vectorStoreKeyString(input.key));
      if (current && !current.draining && !current.closeStarted) {
        if (
          current.generationId !== input.expectedGenerationId ||
          (input.expectedDbPath !== undefined && current.dbPath !== input.expectedDbPath) ||
          !embeddingSpecEqual(current.spec, input.expectedSpec)
        ) {
          throw notReady("active-generation-mismatched");
        }
        installed = true;
        await Promise.resolve(instance.close()).catch(() => undefined);
        return current;
      }
      this.generations.set(generationMapKey(input.key, next.generationId), next);
      this.activeByKey.set(vectorStoreKeyString(input.key), next);
      installed = true;
      return next;
    } finally {
      if (!installed) await Promise.resolve(instance.close()).catch(() => undefined);
    }
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
      const mapKey = generationMapKey(handle.key, handle.generationId);
      try {
        await handle.instance.close();
      } finally {
        // Drop the handle even if close() rejects, so a failed teardown cannot leave a dead
        // generation stranded in the pool forever (and re-rejected on every later close()).
        if (this.generations.get(mapKey) === handle) this.generations.delete(mapKey);
      }
    })();
    return handle.closePromise;
  }

  private async inspectExistingGeneration(
    input: BuildVectorGenerationInput,
    manifestHash: string
  ): Promise<
    | { status: "absent" }
    | { status: "reusable"; metadata: VectorGenerationMetadata }
    | { status: "blocked"; reason: string }
  > {
    const finalDir = vectorGenerationDir(input.paths, manifestHash);
    if (!fs.existsSync(finalDir)) return { status: "absent" };
    const metadata = loadVectorGenerationMetadataByManifest(input.paths, manifestHash);
    if (
      metadata &&
      fs.existsSync(metadata.dbPath) &&
      vectorGenerationMetadataMatchesInput(metadata, input, manifestHash)
    ) {
      return { status: "reusable", metadata };
    }
    if (this.generationIsInUse(input.paths, input.generationId)) {
      return { status: "blocked", reason: "generation-in-use" };
    }
    return { status: "blocked", reason: "manifest-directory-conflict" };
  }

  private generationIsInUse(paths: VectorStoreCachePaths, generationId: string): boolean {
    const mapKey = generationMapKey(paths.key, generationId);
    if (this.lazyOpenByGeneration.has(mapKey)) return true;
    const active = this.activeByKey.get(vectorStoreKeyString(paths.key));
    if (active?.generationId === generationId) return true;
    const handle = this.generations.get(mapKey);
    return Boolean(handle && (!handle.closeStarted || handle.refCount > 0 || handle.pinTokens.size > 0));
  }

  private async publishBuiltGenerationDirectory(
    input: BuildVectorGenerationInput,
    stagingDir: string,
    finalDir: string
  ): Promise<void> {
    if (!fs.existsSync(finalDir)) {
      await durableRename(stagingDir, finalDir);
      fsyncDirSync(input.paths.generationsDir);
      return;
    }
    throw new Error(`vector generation manifest directory appeared before publish: ${finalDir}`);
  }

  private recordPromotedGeneration(paths: VectorStoreCachePaths, metadata: VectorGenerationMetadata): void {
    this.catalog.recordBuilt(paths, {
      generationId: metadata.generationId,
      chunkCount: metadata.chunkCount,
      nowMs: this.now()
    });
  }

  private assertOpen(): void {
    if (this.closed) throw Object.assign(new Error("vector generation pool is closed"), { code: "INTERNAL" });
  }
}

export async function storeVectorGenerationMetadata(
  paths: VectorStoreCachePaths,
  metadata: VectorGenerationMetadata
): Promise<void> {
  const generationDir = vectorGenerationDir(paths, metadata.manifestHash ?? metadata.generationId);
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
  const direct = loadVectorGenerationMetadataFromDir(paths, vectorGenerationDir(paths, generationId), generationId);
  if (direct) return direct;
  for (const entry of safeReadDir(paths.generationsDir)) {
    const metadata = loadVectorGenerationMetadataFromDir(paths, path.join(paths.generationsDir, entry), generationId);
    if (metadata) return metadata;
  }
  return undefined;
}

export function loadVectorGenerationMetadataByManifest(
  paths: VectorStoreCachePaths,
  manifestHash: string
): VectorGenerationMetadata | undefined {
  return loadVectorGenerationMetadataFromDir(paths, vectorGenerationDir(paths, manifestHash));
}

function loadVectorGenerationMetadataFromDir(
  paths: VectorStoreCachePaths,
  generationDir: string,
  generationId?: string
): VectorGenerationMetadata | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(generationDir, "generation.json"), "utf8")) as unknown;
    if (!isVectorGenerationMetadata(parsed)) return undefined;
    if (generationId !== undefined && parsed.generationId !== generationId) return undefined;
    if (parsed.embeddingSetId !== paths.key.embeddingSetId) return undefined;
    if (!vectorStoreKeysEqual(parsed.key, paths.key)) return undefined;
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

function vectorStoreKeysEqual(left: VectorStoreKey, right: VectorStoreKey): boolean {
  return left.vaultStateHash === right.vaultStateHash &&
    left.embeddingSetId === right.embeddingSetId;
}

function embeddingSpecEqual(left: CoralEmbeddingSpec, right: CoralEmbeddingSpec): boolean {
  return left.specId === right.specId &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.dims === right.dims &&
    left.normalization === right.normalization &&
    left.createdAt === right.createdAt;
}

export function vectorGenerationManifestHash(input: {
  spec: CoralEmbeddingSpec;
  chunks: readonly CoralChunkRecord[];
  engineName?: "auto" | string;
  embeddingSpaceId?: EmbeddingSpaceId;
  embeddingRecipeFreshnessId?: EmbeddingRecipeFreshnessId;
}): string {
  const chunks = input.chunks
    .map((chunk) => ({
      id: chunk.id,
      entryId: chunk.entryId,
      entryKind: chunk.entryKind,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      contentHash: chunk.contentHash,
      specId: chunk.specId,
      vector: Array.from(chunk.vector)
    }))
    .sort((left, right) =>
      left.entryId.localeCompare(right.entryId) ||
      left.chunkIndex - right.chunkIndex ||
      left.id.localeCompare(right.id)
    );
  return crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    spec: {
      specId: input.spec.specId,
      provider: input.spec.provider,
      model: input.spec.model,
      dims: input.spec.dims,
      normalization: input.spec.normalization,
      createdAt: input.spec.createdAt
    },
    builtEngine: input.engineName ?? "auto",
    embeddingSpaceId: input.embeddingSpaceId ?? null,
    embeddingRecipeFreshnessId: input.embeddingRecipeFreshnessId ?? null,
    chunks
  })).digest("hex");
}

function vectorGenerationMetadataMatchesInput(
  metadata: VectorGenerationMetadata,
  input: BuildVectorGenerationInput,
  manifestHash: string
): boolean {
  return vectorStoreKeysEqual(metadata.key, input.paths.key) &&
    metadata.generationId === input.generationId &&
    metadata.embeddingSetId === input.paths.key.embeddingSetId &&
    metadata.dbPath === vectorGenerationDbPath(input.paths, manifestHash) &&
    embeddingSpecEqual(metadata.spec, input.spec) &&
    metadata.chunkCount === input.chunks.length &&
    metadata.builtEngine === (input.engineName ?? "auto") &&
    (metadata.embeddingSpaceId ?? undefined) === (input.embeddingSpaceId ?? undefined) &&
    (metadata.embeddingRecipeFreshnessId ?? undefined) === (input.embeddingRecipeFreshnessId ?? undefined) &&
    metadata.manifestHash === manifestHash;
}

function generationHandleMatchesMetadata(handle: GenerationHandle, metadata: VectorGenerationMetadata): boolean {
  return handle.generationId === metadata.generationId &&
    handle.dbPath === metadata.dbPath &&
    vectorStoreKeysEqual(handle.key, metadata.key) &&
    embeddingSpecEqual(handle.spec, metadata.spec);
}

function activeVectorPointerMatchesMetadata(
  pointer: { generationId: string; embeddingSetId: string; specId: string; dbPath: string } | undefined,
  metadata: VectorGenerationMetadata
): boolean {
  if (!pointer) return false;
  return pointer.generationId === metadata.generationId &&
    pointer.embeddingSetId === metadata.embeddingSetId &&
    pointer.specId === metadata.spec.specId &&
    pointer.dbPath === metadata.dbPath;
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function notReady(reason: PinReadableGenerationNotReadyReason): Error {
  return Object.assign(new Error(`vector generation is not readable: ${reason}`), { reason });
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
    typeof value.embeddingSetId === "string" &&
    (!("embeddingSpaceId" in value) || typeof value.embeddingSpaceId === "string") &&
    (!("embeddingRecipeFreshnessId" in value) || typeof value.embeddingRecipeFreshnessId === "string") &&
    (!("manifestHash" in value) || typeof value.manifestHash === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
