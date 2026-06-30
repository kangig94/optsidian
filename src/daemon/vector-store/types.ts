import type { EmbeddingSetId } from "../../core/search/contracts.js";

export type VectorStoreKey = {
  profileHash: string;
  vaultStateHash: string;
  embeddingSetId: EmbeddingSetId;
};

export type VectorStoreRole = "query" | "staging";

export type CoralEmbeddingSpec = {
  specId: string;
  provider: string;
  model: string;
  dims: number;
  normalization: string;
  createdAt: string;
};

export type CoralChunkRecord = {
  id: string;
  entryId: string;
  entryKind: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  vector: readonly number[] | Float32Array;
  specId: string;
};

export type CoralSearchResult = {
  chunkId: string;
  entryId: string;
  similarity: number;
};

export type CoralStoreStats = {
  chunkCount: number;
  specId: string | null;
  engineName: string;
  addonVersion?: string;
  napiVersion?: number;
  schemaVersion?: number;
};

export interface CoralNeedleBinding {
  initStore(dbPath: string): void | Promise<void>;
  setActiveSpec(spec: CoralEmbeddingSpec): void | Promise<void>;
  upsertChunks(chunks: readonly CoralChunkRecord[]): void | Promise<void>;
  buildIndex(engineName?: "auto" | string): void | Promise<void>;
  searchVector(queryVector: readonly number[] | Float32Array, candidateK: number): CoralSearchResult[] | Promise<CoralSearchResult[]>;
  close(): void | Promise<void>;
  getStats?(): CoralStoreStats | Promise<CoralStoreStats>;
}

export interface CoralNeedleInstance extends CoralNeedleBinding {
  readonly instanceId: string;
  readonly role: VectorStoreRole;
  readonly key: VectorStoreKey;
  readonly generationId: string;
  readonly dbPath: string;
}

export type CoralNeedleInstanceFactory = {
  create(input: {
    role: VectorStoreRole;
    key: VectorStoreKey;
    generationId: string;
    dbPath: string;
  }): Promise<CoralNeedleInstance>;
};

export type VectorGenerationMetadata = {
  schemaVersion: 1;
  key: VectorStoreKey;
  generationId: string;
  dbPath: string;
  spec: CoralEmbeddingSpec;
  chunkCount: number;
  builtEngine: "auto" | string;
  createdAt: string;
  embeddingSetId: EmbeddingSetId;
};

export type VectorSearchReadyResult = {
  status: "ready";
  generationId: string;
  results: CoralSearchResult[];
};

export type VectorSearchNotReadyResult = {
  status: "index-not-ready";
  reason: "no-active-built-spec" | "active-generation-mismatched";
};

export type VectorSearchResult = VectorSearchReadyResult | VectorSearchNotReadyResult;

export function vectorStoreKeyString(key: VectorStoreKey): string {
  return `${key.profileHash}:${key.vaultStateHash}:${key.embeddingSetId}`;
}
