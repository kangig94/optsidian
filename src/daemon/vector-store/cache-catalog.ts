import fs from "node:fs";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import {
  ensureExistingPrivateFileSync,
  ensurePrivateDirSync,
  writePrivateFileAtomicSync
} from "../../core/private-path.js";
import type { VectorStoreCachePaths } from "./cache-paths.js";

export const VECTOR_CACHE_CATALOG_SCHEMA_VERSION = 1;

export type VectorCacheRecord = {
  schemaVersion: typeof VECTOR_CACHE_CATALOG_SCHEMA_VERSION;
  storeId: string;
  kind: "vector-store";
  profileHash: string;
  vaultStateHash: string;
  embeddingSetId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  activeGenerationId?: string;
  chunkCount?: number;
  state: "active" | "cold" | "pruning" | "corrupt";
};

export type VectorCacheCatalogFile = {
  schemaVersion: typeof VECTOR_CACHE_CATALOG_SCHEMA_VERSION;
  updatedAtMs: number;
  records: VectorCacheRecord[];
};

export type VectorCacheCatalogOptions = {
  env?: NodeJS.ProcessEnv;
};

export class VectorCacheCatalog {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: VectorCacheCatalogOptions = {}) {
    this.env = options.env ?? process.env;
  }

  touchUsed(paths: VectorStoreCachePaths, options: { nowMs?: number; activeGenerationId?: string } = {}): void {
    const nowMs = options.nowMs ?? Date.now();
    const existing = this.readRecordForPaths(paths);
    this.upsert(paths, {
      ...baseRecord(paths, existing, nowMs),
      lastUsedAtMs: nowMs,
      ...(options.activeGenerationId ? { activeGenerationId: options.activeGenerationId } : {}),
      state: "active"
    });
  }

  recordBuilt(paths: VectorStoreCachePaths, options: {
    generationId: string;
    chunkCount?: number;
    nowMs?: number;
  }): void {
    const nowMs = options.nowMs ?? Date.now();
    const existing = this.readRecordForPaths(paths);
    this.upsert(paths, {
      ...baseRecord(paths, existing, nowMs),
      lastUsedAtMs: nowMs,
      activeGenerationId: options.generationId,
      ...(options.chunkCount === undefined ? {} : { chunkCount: options.chunkCount }),
      state: "active"
    });
  }

  recordCleared(paths: VectorStoreCachePaths, nowMs = Date.now()): void {
    const existing = this.readRecordForPaths(paths);
    const { activeGenerationId: _activeGenerationId, chunkCount: _chunkCount, ...record } = {
      ...baseRecord(paths, existing, nowMs),
      lastUsedAtMs: nowMs,
      state: "cold" as const
    };
    this.upsert(paths, record);
  }

  removeStoreIds(storeIds: readonly string[]): void {
    if (storeIds.length === 0) return;
    const removed = new Set(storeIds);
    const catalog = this.readCatalog();
    const records = catalog.records.filter((record) => !removed.has(record.storeId));
    if (records.length === catalog.records.length) return;
    this.writeCatalog({
      schemaVersion: VECTOR_CACHE_CATALOG_SCHEMA_VERSION,
      updatedAtMs: Date.now(),
      records
    });
  }

  readCatalog(): VectorCacheCatalogFile {
    this.ensureCatalogDirs();
    const catalogPath = this.catalogPath();
    try {
      ensureExistingPrivateFileSync(catalogPath, "Optsidian vector cache catalog");
      const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as unknown;
      if (!isCatalog(parsed)) return emptyCatalog();
      return {
        ...parsed,
        records: dedupeRecords(parsed.records.filter(isRecord))
      };
    } catch (error) {
      if (isNoEntryError(error) || isJsonParseError(error)) return emptyCatalog();
      throw error;
    }
  }

  private upsert(paths: VectorStoreCachePaths, record: VectorCacheRecord): void {
    this.ensureStoreDirs(paths);
    const normalized = normalizeRecord(record);
    writePrivateFileAtomicSync(paths.storeStatePath, `${JSON.stringify(normalized)}\n`, "Optsidian vector cache store metadata");

    const catalog = this.readCatalog();
    const records = new Map(catalog.records.map((candidate) => [candidate.storeId, candidate]));
    records.set(normalized.storeId, normalized);
    this.writeCatalog({
      schemaVersion: VECTOR_CACHE_CATALOG_SCHEMA_VERSION,
      updatedAtMs: Date.now(),
      records: [...records.values()].sort((left, right) => left.storeId.localeCompare(right.storeId))
    });
  }

  private readRecordForPaths(paths: VectorStoreCachePaths): VectorCacheRecord | undefined {
    return this.readStoreRecord(paths.rootDir, vectorStoreId(paths)) ??
      this.readCatalog().records.find((record) => record.storeId === vectorStoreId(paths));
  }

  private readStoreRecord(rootDir: string, storeId: string): VectorCacheRecord | undefined {
    const storePath = path.join(rootDir, "store.json");
    try {
      ensureExistingPrivateFileSync(storePath, "Optsidian vector cache store metadata");
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.storeId !== storeId || parsed.kind !== "vector-store") return undefined;
      return parsed as VectorCacheRecord;
    } catch (error) {
      if (isNoEntryError(error) || isJsonParseError(error)) return undefined;
      throw error;
    }
  }

  private writeCatalog(catalog: VectorCacheCatalogFile): void {
    this.ensureCatalogDirs();
    writePrivateFileAtomicSync(this.catalogPath(), `${JSON.stringify(catalog)}\n`, "Optsidian vector cache catalog");
  }

  private ensureCatalogDirs(): void {
    ensurePrivateDirSync(this.cacheRootDir(), "Optsidian cache directory");
    ensurePrivateDirSync(this.vectorsRootDir(), "Optsidian vector cache directory");
    ensurePrivateDirSync(this.storesRootDir(), "Optsidian vector cache stores directory");
  }

  private ensureStoreDirs(paths: VectorStoreCachePaths): void {
    this.ensureCatalogDirs();
    ensurePrivateDirSync(paths.rootDir, "Optsidian vector cache store directory");
  }

  private cacheRootDir(): string {
    return optsidianCacheRoot(this.env);
  }

  private vectorsRootDir(): string {
    return path.join(this.cacheRootDir(), "vectors");
  }

  private storesRootDir(): string {
    return path.join(this.vectorsRootDir(), "stores");
  }

  private catalogPath(): string {
    return path.join(this.vectorsRootDir(), "catalog.json");
  }
}

export function vectorStoreId(paths: VectorStoreCachePaths): string {
  return `${paths.key.profileHash}:${paths.key.vaultStateHash}:${paths.key.embeddingSetId}`;
}

function baseRecord(paths: VectorStoreCachePaths, existing: VectorCacheRecord | undefined, nowMs: number): VectorCacheRecord {
  return {
    schemaVersion: VECTOR_CACHE_CATALOG_SCHEMA_VERSION,
    storeId: vectorStoreId(paths),
    kind: "vector-store",
    profileHash: paths.key.profileHash,
    vaultStateHash: paths.key.vaultStateHash,
    embeddingSetId: paths.key.embeddingSetId,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    lastUsedAtMs: existing?.lastUsedAtMs ?? nowMs,
    ...(existing?.activeGenerationId === undefined ? {} : { activeGenerationId: existing.activeGenerationId }),
    ...(existing?.chunkCount === undefined ? {} : { chunkCount: existing.chunkCount }),
    state: existing?.state ?? "active"
  };
}

function normalizeRecord(record: VectorCacheRecord): VectorCacheRecord {
  return {
    ...record,
    schemaVersion: VECTOR_CACHE_CATALOG_SCHEMA_VERSION,
    kind: "vector-store"
  };
}

function emptyCatalog(): VectorCacheCatalogFile {
  return {
    schemaVersion: VECTOR_CACHE_CATALOG_SCHEMA_VERSION,
    updatedAtMs: 0,
    records: []
  };
}

function dedupeRecords(records: readonly VectorCacheRecord[]): VectorCacheRecord[] {
  const deduped = new Map<string, VectorCacheRecord>();
  for (const record of records) deduped.set(record.storeId, normalizeRecord(record));
  return [...deduped.values()].sort((left, right) => left.storeId.localeCompare(right.storeId));
}

function isCatalog(value: unknown): value is VectorCacheCatalogFile {
  return isRecord(value) &&
    value.schemaVersion === VECTOR_CACHE_CATALOG_SCHEMA_VERSION &&
    Array.isArray(value.records) &&
    value.records.every(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
