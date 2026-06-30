import fs from "node:fs";
import path from "node:path";
import type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralNeedleInstance,
  CoralNeedleInstanceFactory,
  CoralSearchResult,
  CoralStoreStats,
  VectorStoreKey,
  VectorStoreRole
} from "./types.js";

type PersistedMemoryStore = {
  schemaVersion: 1;
  spec: CoralEmbeddingSpec | null;
  engineName: string;
  chunks: CoralChunkRecord[];
};

export function createMemoryCoralNeedleInstanceFactory(): CoralNeedleInstanceFactory {
  return {
    async create(input) {
      return new MemoryCoralNeedleInstance(input);
    }
  };
}

class MemoryCoralNeedleInstance implements CoralNeedleInstance {
  readonly instanceId: string;
  readonly role: VectorStoreRole;
  readonly key: VectorStoreKey;
  readonly generationId: string;
  readonly dbPath: string;

  private store: PersistedMemoryStore = emptyStore();
  private closed = false;

  constructor(input: { role: VectorStoreRole; key: VectorStoreKey; generationId: string; dbPath: string }) {
    this.role = input.role;
    this.key = input.key;
    this.generationId = input.generationId;
    this.dbPath = input.dbPath;
    this.instanceId = `memory:${input.role}:${input.key.profileHash}:${input.key.vaultStateHash}:${input.key.embeddingSetId}:${input.generationId}`;
  }

  initStore(dbPath: string): void {
    this.assertOpen();
    if (dbPath !== this.dbPath) throw new Error(`memory vector instance dbPath mismatch: ${dbPath}`);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.store = readStore(this.dbPath);
    this.persist();
  }

  setActiveSpec(spec: CoralEmbeddingSpec): void {
    this.assertOpen();
    this.store = { ...this.store, spec };
    this.persist();
  }

  upsertChunks(chunks: readonly CoralChunkRecord[]): void {
    this.assertOpen();
    const byId = new Map(this.store.chunks.map((chunk) => [chunk.id, chunk]));
    for (const chunk of chunks) byId.set(chunk.id, normalizeChunk(chunk));
    this.store = { ...this.store, chunks: [...byId.values()].sort(compareChunks) };
    this.persist();
  }

  buildIndex(engineName: "auto" | string = "auto"): void {
    this.assertOpen();
    this.store = { ...this.store, engineName };
    this.persist();
  }

  searchVector(queryVector: readonly number[] | Float32Array, candidateK: number): CoralSearchResult[] {
    this.assertOpen();
    const limit = Math.max(0, Math.trunc(candidateK));
    if (limit <= 0) return [];
    const query = Array.from(queryVector);
    return this.store.chunks
      .map((chunk) => ({
        chunkId: chunk.id,
        entryId: chunk.entryId,
        similarity: cosine(query, Array.from(chunk.vector))
      }))
      .sort((left, right) => right.similarity - left.similarity || left.entryId.localeCompare(right.entryId) || left.chunkId.localeCompare(right.chunkId))
      .slice(0, limit);
  }

  close(): void {
    if (this.closed) return;
    this.persist();
    this.closed = true;
  }

  getStats(): CoralStoreStats {
    return {
      chunkCount: this.store.chunks.length,
      specId: this.store.spec?.specId ?? null,
      engineName: this.store.engineName,
      schemaVersion: this.store.schemaVersion
    };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.dbPath, `${JSON.stringify(this.store)}\n`, { mode: 0o600 });
  }

  private assertOpen(): void {
    if (this.closed) throw Object.assign(new Error("memory vector instance is closed"), { code: "INTERNAL" });
  }
}

function emptyStore(): PersistedMemoryStore {
  return {
    schemaVersion: 1,
    spec: null,
    engineName: "auto",
    chunks: []
  };
}

function readStore(dbPath: string): PersistedMemoryStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.chunks)) return emptyStore();
    return {
      schemaVersion: 1,
      spec: isRecord(parsed.spec) ? parsed.spec as CoralEmbeddingSpec : null,
      engineName: typeof parsed.engineName === "string" ? parsed.engineName : "auto",
      chunks: parsed.chunks.map((chunk) => normalizeChunk(chunk as CoralChunkRecord)).sort(compareChunks)
    };
  } catch {
    return emptyStore();
  }
}

function normalizeChunk(chunk: CoralChunkRecord): CoralChunkRecord {
  return {
    ...chunk,
    vector: Array.from(chunk.vector)
  };
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = finite(left[index]);
    const r = finite(right[index]);
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function compareChunks(left: CoralChunkRecord, right: CoralChunkRecord): number {
  return left.entryId.localeCompare(right.entryId) || left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
