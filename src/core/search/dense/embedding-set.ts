import crypto from 'node:crypto';
import type { EmbeddingSetId, ShardDocRef } from '../contracts.js';
import { canonicalValueBytes } from '../segments/canonical.js';
import {
  normalizeEmbeddingVector,
  type EmbeddingProvider,
  type EmbeddingProviderIdentity,
  type EmbeddingVector,
} from './provider.js';

const DETERMINISTIC_HASH_EMBEDDING_RECIPE_VERSION = 'deterministic-hash-embedding-recipe-v1';
const EMBEDDING_VECTOR_PROJECTION_VERSION = 'l2-float64-projection-v1';
const EMBEDDING_SPACE_ID_VERSION = 'embedding-space-v1';
const EMBEDDING_RECIPE_FRESHNESS_ID_VERSION = 'embedding-recipe-freshness-v1';
const VECTOR_GENERATION_MANIFEST_ID_VERSION = 'vector-generation-manifest-v1';

export type EmbeddingSpaceId = string & { readonly __brand: 'EmbeddingSpaceId' };
export type EmbeddingRecipeFreshnessId = string & { readonly __brand: 'EmbeddingRecipeFreshnessId' };

export type EmbeddingRecipeIdentity = {
  schemaVersion: 1;
  provider: EmbeddingProviderIdentity;
  recipeVersion: string;
  projectionVersion: string;
  normalization: 'l2';
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
  fieldSelection?: readonly string[];
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
      version: provider.version,
    },
    recipeVersion: DETERMINISTIC_HASH_EMBEDDING_RECIPE_VERSION,
    projectionVersion: EMBEDDING_VECTOR_PROJECTION_VERSION,
    normalization: 'l2',
  };
}

export async function buildEmbeddingSet(input: {
  provider: EmbeddingProvider;
  documents: readonly EmbeddingSetDocumentInput[];
}): Promise<BuiltEmbeddingSet> {
  const recipe = embeddingRecipeIdentityForProvider(input.provider);
  const vectors = await Promise.all(
    input.documents.map(async (document) =>
      normalizeEmbeddingVector(
        await input.provider.embed(document.text, { inputKind: 'document' }),
        input.provider.identity.dim,
      ),
    ),
  );
  return buildEmbeddingSetFromVectors({
    provider: input.provider.identity,
    recipe,
    documents: input.documents,
    vectors,
  });
}

export function buildEmbeddingSetFromVectors(input: {
  provider: EmbeddingProviderIdentity;
  recipe: EmbeddingRecipeIdentity;
  documents: readonly EmbeddingSetDocumentInput[];
  vectors: readonly EmbeddingVector[];
}): BuiltEmbeddingSet {
  if (input.documents.length !== input.vectors.length) {
    throw new Error(
      `embedding set vector count ${input.vectors.length} does not match document count ${input.documents.length}`,
    );
  }
  const records = input.documents.map((document, index) => {
    const rawVector = input.vectors[index];
    if (!rawVector) throw new Error(`embedding vector is missing for document ${document.documentId}`);
    const vector = normalizeEmbeddingVector(rawVector, input.provider.dim);
    return {
      ...document,
      vector,
      vectorProjectionHash: vectorProjectionHash(vector),
    };
  });
  const sorted = sortEmbeddingSetRecords(records);
  const embeddingSetId = computeEmbeddingSetId({
    recipe: input.recipe,
    records: sorted,
  });
  return {
    schemaVersion: 1,
    embeddingSetId,
    recipe: input.recipe,
    model: input.provider.model,
    dim: input.provider.dim,
    records: sorted,
    coveredDocumentIds: new Set(sorted.map((record) => record.documentId)),
  };
}

export function embeddingRecipeIdentityForProvider(provider: EmbeddingProvider): EmbeddingRecipeIdentity {
  const custom = (provider as EmbeddingProvider & { recipeIdentity?: EmbeddingRecipeIdentity }).recipeIdentity;
  return custom ?? deterministicHashEmbeddingRecipeIdentity(provider.identity);
}

export function embeddingSpaceIdForRecipe(recipe: EmbeddingRecipeIdentity): EmbeddingSpaceId {
  return sha256(
    canonicalValueBytes({
      schemaVersion: 1,
      identityVersion: EMBEDDING_SPACE_ID_VERSION,
      providerKind: recipe.provider.id,
      providerModel: recipe.provider.model,
      providerDim: recipe.provider.dim,
      providerVersion: recipe.provider.version,
      modelArtifact: recipe.modelArtifact
        ? {
            modelId: recipe.modelArtifact.modelId,
            revision: recipe.modelArtifact.revision,
            sha256: recipe.modelArtifact.sha256,
            files: sortedArtifactFiles(recipe.modelArtifact.files),
          }
        : null,
      dim: recipe.dim ?? recipe.provider.dim,
      normalization: recipe.normalization,
      pooling: recipe.pooling ?? null,
      tokenizer: recipe.tokenizer
        ? {
            sha256: recipe.tokenizer.sha256,
            runtime: recipe.tokenizer.runtime,
            files: sortedArtifactFiles(recipe.tokenizer.files),
          }
        : null,
      onnx: recipe.onnx ?? null,
      quantization: recipe.quantization ?? null,
      dtype: recipe.dtype ?? null,
      maxTokens: recipe.maxTokens ?? null,
      inputTemplate: recipe.inputTemplate
        ? {
            default: recipe.inputTemplate.default,
            query: recipe.inputTemplate.query,
          }
        : null,
    }),
  ) as EmbeddingSpaceId;
}

export function embeddingRecipeFreshnessId(recipe: EmbeddingRecipeIdentity): EmbeddingRecipeFreshnessId {
  return sha256(
    canonicalValueBytes({
      schemaVersion: 1,
      identityVersion: EMBEDDING_RECIPE_FRESHNESS_ID_VERSION,
      recipe,
    }),
  ) as EmbeddingRecipeFreshnessId;
}

function computeEmbeddingSetId(input: {
  recipe: EmbeddingRecipeIdentity;
  records: readonly Pick<
    EmbeddingSetRecord,
    'documentId' | 'path' | 'contentHash' | 'vector' | 'vectorProjectionHash'
  >[];
}): EmbeddingSetId {
  return sha256(
    canonicalValueBytes({
      schemaVersion: 1,
      recipe: input.recipe,
      documents: sortEmbeddingSetRecords(input.records).map((record) => ({
        documentId: record.documentId,
        path: record.path ?? null,
        contentHash: record.contentHash,
        vectorProjectionHash: record.vectorProjectionHash,
        vectorProjection: projectVector(record.vector),
      })),
    }),
  );
}

export function vectorGenerationIdForManifest(input: {
  embeddingSpaceId: EmbeddingSpaceId;
  embeddingRecipeFreshnessId: EmbeddingRecipeFreshnessId;
  corpusRevision: string;
  records: readonly Pick<EmbeddingSetRecord, 'documentId' | 'contentHash' | 'vectorProjectionHash'>[];
}): string {
  return `gen-${sha256(
    canonicalValueBytes({
      schemaVersion: 1,
      identityVersion: VECTOR_GENERATION_MANIFEST_ID_VERSION,
      embeddingSpaceId: input.embeddingSpaceId,
      embeddingRecipeFreshnessId: input.embeddingRecipeFreshnessId,
      corpusRevision: input.corpusRevision,
      documents: [...input.records]
        .sort(
          (left, right) =>
            left.documentId.localeCompare(right.documentId) ||
            left.contentHash.localeCompare(right.contentHash) ||
            left.vectorProjectionHash.localeCompare(right.vectorProjectionHash),
        )
        .map((record) => ({
          documentId: record.documentId,
          contentHash: record.contentHash,
          vectorProjectionHash: record.vectorProjectionHash,
        })),
    }),
  )}`;
}

function vectorProjectionHash(vector: EmbeddingVector): string {
  return sha256(
    canonicalValueBytes({
      projectionVersion: EMBEDDING_VECTOR_PROJECTION_VERSION,
      vector: projectVector(vector),
    }),
  );
}

function sortEmbeddingSetRecords<T extends Pick<EmbeddingSetRecord, 'documentId' | 'path'>>(
  records: readonly T[],
): T[] {
  return [...records].sort((left, right) => {
    const leftPath = left.path ?? '';
    const rightPath = right.path ?? '';
    return left.documentId.localeCompare(right.documentId) || leftPath.localeCompare(rightPath);
  });
}

function projectVector(vector: EmbeddingVector): number[] {
  return normalizeEmbeddingVector(vector).map((value) => Number(value.toPrecision(12)));
}

function sortedArtifactFiles(
  files: readonly { path: string; sha256: string; sizeBytes: number }[],
): { path: string; sha256: string; sizeBytes: number }[] {
  return [...files].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.sha256.localeCompare(right.sha256) ||
      left.sizeBytes - right.sizeBytes,
  );
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
