import crypto from "node:crypto";
import type { EmbeddingSetId, ShardDocRef } from "../contracts.js";
import { canonicalValueBytes } from "../segments/index.js";
import {
  normalizeEmbeddingVector,
  type EmbeddingProvider,
  type EmbeddingProviderIdentity,
  type EmbeddingVector
} from "./provider.js";

export const DETERMINISTIC_HASH_EMBEDDING_RECIPE_VERSION = "deterministic-hash-embedding-recipe-v1";
export const EMBEDDING_VECTOR_PROJECTION_VERSION = "l2-float64-projection-v1";

export type EmbeddingRecipeIdentity = {
  schemaVersion: 1;
  provider: EmbeddingProviderIdentity;
  recipeVersion: string;
  projectionVersion: string;
  normalization: "l2";
  modelArtifact?: {
    modelId: string;
    revision: string;
    sha256: string;
    files: readonly { path: string; sha256: string; sizeBytes: number }[];
  };
  tokenizer?: {
    sha256: string;
    runtime: { name: string; version: string };
    files: readonly { path: string; sha256: string; sizeBytes: number }[];
  };
  onnx?: {
    graphSha256: string;
    opset: number;
    runtime: { name: string; version: string };
  };
  quantization?: string;
  dtype?: string;
  dim?: number;
  pooling?: string;
  maxTokens?: number;
  chunking?: {
    strategy: string;
    maxTokens: number;
    overlapTokens: number;
  };
  inputTemplate?: {
    default: string;
    query: string;
    document: string;
  };
  renderedTextProjectionVersion?: string;
};

export type EmbeddingSetDocumentInput = {
  documentId: string;
  shardDocRef: ShardDocRef;
  path?: string;
  text: string;
  contentHash: string;
};

export type EmbeddingSetRecord = EmbeddingSetDocumentInput & {
  vector: EmbeddingVector;
  vectorProjectionHash: string;
};

export type BuiltEmbeddingSet = {
  schemaVersion: 1;
  embeddingSetId: EmbeddingSetId;
  recipe: EmbeddingRecipeIdentity;
  model: string;
  dim: number;
  records: readonly EmbeddingSetRecord[];
  coveredDocumentIds: ReadonlySet<string>;
};

export function deterministicHashEmbeddingRecipeIdentity(provider: EmbeddingProviderIdentity): EmbeddingRecipeIdentity {
  return {
    schemaVersion: 1,
    provider: {
      id: provider.id,
      model: provider.model,
      dim: provider.dim,
      version: provider.version
    },
    recipeVersion: DETERMINISTIC_HASH_EMBEDDING_RECIPE_VERSION,
    projectionVersion: EMBEDDING_VECTOR_PROJECTION_VERSION,
    normalization: "l2"
  };
}

export async function buildEmbeddingSet(input: {
  provider: EmbeddingProvider;
  documents: readonly EmbeddingSetDocumentInput[];
}): Promise<BuiltEmbeddingSet> {
  const recipe = embeddingRecipeIdentityForProvider(input.provider);
  const vectors = await Promise.all(input.documents.map(async (document) =>
    normalizeEmbeddingVector(
      await input.provider.embed(document.text, { inputKind: "document" }),
      input.provider.identity.dim
    )
  ));
  return buildEmbeddingSetFromVectors({
    provider: input.provider.identity,
    recipe,
    documents: input.documents,
    vectors
  });
}

export function buildEmbeddingSetFromVectors(input: {
  provider: EmbeddingProviderIdentity;
  recipe: EmbeddingRecipeIdentity;
  documents: readonly EmbeddingSetDocumentInput[];
  vectors: readonly EmbeddingVector[];
}): BuiltEmbeddingSet {
  if (input.documents.length !== input.vectors.length) {
    throw new Error(`embedding set vector count ${input.vectors.length} does not match document count ${input.documents.length}`);
  }
  const records = input.documents.map((document, index) => {
    const rawVector = input.vectors[index];
    if (!rawVector) throw new Error(`embedding vector is missing for document ${document.documentId}`);
    const vector = normalizeEmbeddingVector(rawVector, input.provider.dim);
    return {
      ...document,
      vector,
      vectorProjectionHash: vectorProjectionHash(vector)
    };
  });
  const sorted = sortEmbeddingSetRecords(records);
  const embeddingSetId = computeEmbeddingSetId({
    recipe: input.recipe,
    records: sorted
  });
  return {
    schemaVersion: 1,
    embeddingSetId,
    recipe: input.recipe,
    model: input.provider.model,
    dim: input.provider.dim,
    records: sorted,
    coveredDocumentIds: new Set(sorted.map((record) => record.documentId))
  };
}

export function embeddingRecipeIdentityForProvider(provider: EmbeddingProvider): EmbeddingRecipeIdentity {
  const custom = (provider as EmbeddingProvider & { recipeIdentity?: EmbeddingRecipeIdentity }).recipeIdentity;
  return custom ?? deterministicHashEmbeddingRecipeIdentity(provider.identity);
}

export function computeEmbeddingSetId(input: {
  recipe: EmbeddingRecipeIdentity;
  records: readonly Pick<EmbeddingSetRecord, "documentId" | "path" | "contentHash" | "vector" | "vectorProjectionHash">[];
}): EmbeddingSetId {
  return sha256(canonicalValueBytes({
    schemaVersion: 1,
    recipe: input.recipe,
    documents: sortEmbeddingSetRecords(input.records).map((record) => ({
      documentId: record.documentId,
      path: record.path ?? null,
      contentHash: record.contentHash,
      vectorProjectionHash: record.vectorProjectionHash,
      vectorProjection: projectVector(record.vector)
    }))
  }));
}

export function vectorProjectionHash(vector: EmbeddingVector): string {
  return sha256(canonicalValueBytes({
    projectionVersion: EMBEDDING_VECTOR_PROJECTION_VERSION,
    vector: projectVector(vector)
  }));
}

function sortEmbeddingSetRecords<T extends Pick<EmbeddingSetRecord, "documentId" | "path">>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => {
    const leftPath = left.path ?? "";
    const rightPath = right.path ?? "";
    return left.documentId.localeCompare(right.documentId) || leftPath.localeCompare(rightPath);
  });
}

function projectVector(vector: EmbeddingVector): number[] {
  return normalizeEmbeddingVector(vector).map((value) => Number(value.toPrecision(12)));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
