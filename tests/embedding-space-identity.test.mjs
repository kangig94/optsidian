import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEmbeddingSetFromVectors,
  embeddingRecipeFreshnessId,
  embeddingSpaceIdForRecipe,
} from '../src/core/search/dense/embedding-set.ts';
import { SNAPSHOT_PERSISTENCE_SCHEMA } from '../src/daemon/search-store/types.ts';
import { computeRetrievalSnapshotId } from '../src/daemon/search-store/snapshot-store.ts';
import { vectorGenerationDir, vectorStoreCachePaths } from '../src/daemon/vector-store/cache-paths.ts';
import { loadVectorGenerationMetadata } from '../src/daemon/vector-store/pool.ts';

function tempRoot(prefix = 'optsidian-embedding-space-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseRecipe() {
  return {
    schemaVersion: 1,
    provider: {
      id: 'local-onnx',
      model: 'bge-m3',
      dim: 1024,
      version: '1',
    },
    recipeVersion: 'local-onnx-recipe-v1',
    projectionVersion: 'l2-float64-projection-v1',
    normalization: 'l2',
    modelArtifact: {
      modelId: 'BAAI/bge-m3',
      revision: 'revision-a',
      sha256: 'model-artifact-a',
      files: [
        { path: 'onnx/model.onnx_data', sha256: 'data-a', sizeBytes: 2 },
        { path: 'onnx/model.onnx', sha256: 'model-a', sizeBytes: 1 },
      ],
    },
    tokenizer: {
      sha256: 'tokenizer-a',
      runtime: { name: '@huggingface/tokenizers', version: '0.1.3' },
      files: [
        { path: 'onnx/tokenizer_config.json', sha256: 'config-a', sizeBytes: 1 },
        { path: 'onnx/tokenizer.json', sha256: 'tokenizer-json-a', sizeBytes: 2 },
      ],
    },
    onnx: {
      graphSha256: 'graph-a',
      opset: 11,
      runtime: { name: 'onnxruntime-node', version: '1.27.0' },
    },
    quantization: 'none',
    dtype: 'float32',
    dim: 1024,
    pooling: 'mean',
    maxTokens: 8192,
    chunking: {
      strategy: 'truncate',
      maxTokens: 8192,
      overlapTokens: 0,
    },
    fieldSelection: ['title', 'path', 'body', 'tags'],
    inputTemplate: {
      default: '{text}',
      query: '{text}',
      document: '{text}',
    },
    renderedTextProjectionVersion: 'rendered-text-projection-v1',
  };
}

function clone(value) {
  return structuredClone(value);
}

function variant(change) {
  const recipe = baseRecipe();
  change(recipe);
  return recipe;
}

test('AC3 identical comparable config has deterministic equal embedding space id', () => {
  const recipe = baseRecipe();
  const original = JSON.stringify(recipe);
  const spaceId = embeddingSpaceIdForRecipe(recipe);
  const freshnessId = embeddingRecipeFreshnessId(recipe);

  assert.equal(embeddingSpaceIdForRecipe(clone(recipe)), spaceId);
  assert.equal(embeddingRecipeFreshnessId(clone(recipe)), freshnessId);
  assert.equal(JSON.stringify(recipe), original);
  assert.equal('embeddingSpaceId' in recipe, false);
  assert.equal('embeddingRecipeFreshnessId' in recipe, false);
});

test('AC3 comparable encoder-space changes produce different embedding space ids', () => {
  const base = baseRecipe();
  const baseSpaceId = embeddingSpaceIdForRecipe(base);
  const cases = {
    dim: variant((recipe) => {
      recipe.provider.dim = 384;
      recipe.dim = 384;
    }),
    normalization: variant((recipe) => {
      recipe.normalization = 'unit';
    }),
    pooling: variant((recipe) => {
      recipe.pooling = 'cls';
    }),
    providerKind: variant((recipe) => {
      recipe.provider.id = 'remote-api';
    }),
    tokenizer: variant((recipe) => {
      recipe.tokenizer.sha256 = 'tokenizer-b';
    }),
    queryTemplate: variant((recipe) => {
      recipe.inputTemplate.query = 'query: {text}';
    }),
  };

  for (const [label, recipe] of Object.entries(cases)) {
    assert.notEqual(embeddingSpaceIdForRecipe(recipe), baseSpaceId, `${label} must change embeddingSpaceId`);
  }
});

test('AC3 document-only recipe changes keep space id but change freshness id', () => {
  const base = baseRecipe();
  const baseSpaceId = embeddingSpaceIdForRecipe(base);
  const baseFreshnessId = embeddingRecipeFreshnessId(base);
  const cases = {
    chunking: variant((recipe) => {
      recipe.chunking.maxTokens = 2048;
      recipe.chunking.overlapTokens = 128;
    }),
    fieldSelection: variant((recipe) => {
      recipe.fieldSelection = ['title', 'body'];
    }),
    renderedTextProjection: variant((recipe) => {
      recipe.renderedTextProjectionVersion = 'rendered-text-projection-v2';
    }),
    documentInputTemplate: variant((recipe) => {
      recipe.inputTemplate.document = 'passage: {text}';
    }),
  };

  for (const [label, recipe] of Object.entries(cases)) {
    assert.equal(embeddingSpaceIdForRecipe(recipe), baseSpaceId, `${label} must preserve embeddingSpaceId`);
    assert.notEqual(embeddingRecipeFreshnessId(recipe), baseFreshnessId, `${label} must change freshness id`);
  }
});

test('AC3 sibling ids are not folded into embeddingSetId or retrievalSnapshotId inputs', () => {
  const recipe = baseRecipe();
  const embeddingSpaceId = embeddingSpaceIdForRecipe(recipe);
  const recipeFreshnessId = embeddingRecipeFreshnessId(recipe);
  const documents = [
    {
      documentId: 'doc-a',
      shardDocRef: { segmentId: 'seg-a', partitionId: 0, localDocId: 1, documentId: 'doc-a' },
      path: 'A.md',
      text: 'alpha',
      contentHash: 'content-a',
    },
  ];
  const vectors = [[1, 0, 0, ...Array.from({ length: recipe.provider.dim - 3 }, () => 0)]];
  const before = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe,
    documents,
    vectors,
  }).embeddingSetId;

  embeddingSpaceIdForRecipe(recipe);
  embeddingRecipeFreshnessId(recipe);

  const after = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe,
    documents,
    vectors,
  }).embeddingSetId;
  assert.equal(after, before);
  assert.equal('embeddingSpaceId' in recipe, false);
  assert.equal('embeddingRecipeFreshnessId' in recipe, false);

  const retrievalInput = {
    corpusSnapshotId: 'corpus-a',
    linkGraphId: 'link-a',
    embeddingSetId: before,
    retrieverPlanIdentity: 'plan-a',
    rankingFeatureVersion: 'rank-a',
  };
  assert.equal(
    computeRetrievalSnapshotId({ ...retrievalInput, embeddingSpaceId, embeddingRecipeFreshnessId: recipeFreshnessId }),
    computeRetrievalSnapshotId(retrievalInput),
  );
  assert.ok(SNAPSHOT_PERSISTENCE_SCHEMA.retrievalSnapshotEnvelope.includes('embeddingSpaceId'));
  assert.ok(SNAPSHOT_PERSISTENCE_SCHEMA.retrievalSnapshotEnvelope.includes('embeddingRecipeFreshnessId'));
});

test('AC3 legacy vector generation metadata without embeddingSpaceId still loads', () => {
  const vault = tempRoot('optsidian-embedding-space-vault-');
  const cacheRoot = tempRoot('optsidian-embedding-space-cache-');
  const paths = vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash: 'profile-a',
    embeddingSetId: 'embedding-a',
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
  });
  const generationId = 'gen-legacy';
  const generationDir = vectorGenerationDir(paths, generationId);
  fs.mkdirSync(generationDir, { recursive: true });
  const metadata = {
    schemaVersion: 1,
    key: paths.key,
    generationId,
    dbPath: path.join(generationDir, 'vectors.duckdb'),
    spec: {
      specId: 'spec-a',
      provider: 'deterministic-hash',
      model: 'content-hash-v1',
      dims: 8,
      normalization: 'l2',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    chunkCount: 0,
    builtEngine: 'auto',
    createdAt: '2026-01-01T00:00:00.000Z',
    embeddingSetId: paths.key.embeddingSetId,
  };
  fs.writeFileSync(path.join(generationDir, 'generation.json'), `${JSON.stringify(metadata)}\n`);

  const loaded = loadVectorGenerationMetadata(paths, generationId);
  assert.ok(loaded);
  assert.equal(loaded.embeddingSpaceId, undefined);
  assert.equal(loaded.embeddingRecipeFreshnessId, undefined);
});
