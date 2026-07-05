import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEmbeddingSetFromVectors,
  embeddingRecipeFreshnessId,
  embeddingSpaceIdForRecipe,
  vectorGenerationIdForManifest,
} from '../src/core/search/dense/embedding-set.ts';
import { localOnnxModelDescriptor } from '../src/core/search/dense/artifacts.ts';
import { LocalOnnxProvider } from '../src/core/search/dense/local-onnx.ts';
import { ANALYZER_VERSION } from '../src/core/search/constants.ts';
import { corpusSnapshotIdFromManifest } from '../src/core/search/segments/canonical.ts';
import { INDEX_BUILD_VERSION, snapshotIdentityTupleForAnalyzerIdentity } from '../src/daemon/search-store/builder.ts';
import { denseUsabilityForRecordsForTests } from '../src/daemon/search-store/snapshot-store.ts';
import { SNAPSHOT_PERSISTENCE_SCHEMA } from '../src/daemon/search-store/types.ts';
import { computeRetrievalSnapshotId } from '../src/daemon/search-store/snapshot-store.ts';
import { vectorGenerationDir, vectorStoreCachePaths } from '../src/daemon/vector-store/cache-paths.ts';
import { loadVectorGenerationMetadata } from '../src/daemon/vector-store/pool.ts';
import { admissionPolicy, residentModelKey } from '../src/daemon/model-session/provider-key.ts';

const PINNED_INDEX_BUILD_VERSION = 'daemon-positional-build-v7';
const PINNED_ANALYZER_VERSION = 'router-intl-kiwi-link-render-v2';
const PINNED_BASE_RECIPE_IDENTITY = {
  embeddingSpaceId: '5de614075de7796edb91d5a86f1053f9ea5b0bd4b9ef76f76106e2cc1a0441b7',
  embeddingRecipeFreshnessId: 'a5d8f664c29e10c4ebf640fdb5bc2860f3ddaf17fba8533c49e1627df2482dcd',
  embeddingSetId: '427b2b3ba62a7c819cf7b2193815f7da39c2d5bca14c3143fb979379c790ec54',
  vectorGenerationId: 'gen-be15fdd4b221d9f2d69c9c3524eefcfc07c3b8539a435a9e748aa0847d19f53b',
  vectorProjectionHashes: [
    ['doc-a', '776e9c22222cfe2aa1bb5863146ddbdf7503dace0bb5182d2f563d3e5a806be2'],
    ['doc-b', 'e98fcfe2decca53fe27d5aea224a4065d281ea0e52b82faae44389c30e3b9bfe'],
  ],
};
const PINNED_LOCAL_ONNX_IDENTITIES = {
  bgeM3: {
    embeddingSpaceId: '6db38ad9543e46576fc05a18835f332fbd1f0e45d68cffbf0d640366a70f02ce',
    embeddingRecipeFreshnessId: '0ed4d3687caf99c0ed544f73418d0fa073c036589167d8bbf0b7b2682835b27c',
    requiredVramBytes: 4_294_967_296,
  },
  e5Small: {
    embeddingSpaceId: '6c09360735f2574167630bc35057ae4085d2b992219ecfb41648f906c6af8d89',
    embeddingRecipeFreshnessId: 'c57b46d9b252e4f800aecef9295c3df8d08db66f8a0f1dcd30bd49021d0d2f24',
    requiredVramBytes: 1_073_741_824,
  },
};

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

function representativeEmbeddingFixture(recipe = baseRecipe()) {
  return {
    documents: [
      {
        documentId: 'doc-b',
        shardDocRef: { segmentId: 'seg-b', partitionId: 1, localDocId: 2, documentId: 'doc-b' },
        path: 'B.md',
        text: 'bravo',
        contentHash: 'content-b',
      },
      {
        documentId: 'doc-a',
        shardDocRef: { segmentId: 'seg-a', partitionId: 0, localDocId: 1, documentId: 'doc-a' },
        path: 'A.md',
        text: 'alpha',
        contentHash: 'content-a',
      },
    ],
    vectors: [
      [0.25, -0.5, 1, ...Array.from({ length: recipe.provider.dim - 3 }, () => 0)],
      [1 / 3, Math.PI, -2, ...Array.from({ length: recipe.provider.dim - 3 }, () => 0)],
    ],
  };
}

test('AC8 INDEX_BUILD_VERSION and ANALYZER_VERSION are byte-pinned for embedding identity', () => {
  assert.equal(INDEX_BUILD_VERSION, PINNED_INDEX_BUILD_VERSION);
  assert.equal(ANALYZER_VERSION, PINNED_ANALYZER_VERSION);
});

test('AC8 embedding-space, recipe-freshness, projection, and vector-generation ids are byte-pinned', () => {
  const recipe = baseRecipe();
  const embeddingSpaceId = embeddingSpaceIdForRecipe(recipe);
  const embeddingRecipeFreshnessIdValue = embeddingRecipeFreshnessId(recipe);
  const { documents, vectors } = representativeEmbeddingFixture(recipe);
  const embeddingSet = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe,
    documents,
    vectors,
  });

  assert.equal(embeddingSpaceId, PINNED_BASE_RECIPE_IDENTITY.embeddingSpaceId);
  assert.equal(embeddingRecipeFreshnessIdValue, PINNED_BASE_RECIPE_IDENTITY.embeddingRecipeFreshnessId);
  assert.equal(embeddingSet.embeddingSetId, PINNED_BASE_RECIPE_IDENTITY.embeddingSetId);
  assert.deepEqual(
    embeddingSet.records.map((record) => [record.documentId, record.vectorProjectionHash]),
    PINNED_BASE_RECIPE_IDENTITY.vectorProjectionHashes,
  );
  assert.equal(
    vectorGenerationIdForManifest({
      embeddingSpaceId,
      embeddingRecipeFreshnessId: embeddingRecipeFreshnessIdValue,
      corpusRevision: 'corpus-revision-a',
      records: embeddingSet.records,
    }),
    PINNED_BASE_RECIPE_IDENTITY.vectorGenerationId,
  );
});

test('AC8 Local ONNX recipe identity is byte-pinned and excludes runtime device state', () => {
  const bgeAuto = new LocalOnnxProvider({ model: 'bge-m3', executionProvider: 'auto' });
  const bgeCpu = new LocalOnnxProvider({ model: 'bge-m3', executionProvider: 'cpu' });
  const bgeGpu = new LocalOnnxProvider({
    model: 'bge-m3',
    executionProvider: 'cuda',
    allowCpuFallback: false,
    platform: 'linux',
  });
  const e5 = new LocalOnnxProvider({ model: 'multilingual-e5-small' });

  for (const provider of [bgeAuto, bgeCpu, bgeGpu]) {
    assert.equal(provider.recipeIdentity.recipeVersion, 'local-onnx-embedding-recipe-v1');
    assert.equal(provider.recipeIdentity.projectionVersion, 'rendered-text-projection-v1');
    assert.equal(provider.recipeIdentity.renderedTextProjectionVersion, 'rendered-text-projection-v1');
    assert.equal('devicePolicy' in provider.recipeIdentity, false);
    assert.equal('executionProvider' in provider.recipeIdentity, false);
    assert.equal('requiredVramBytes' in provider.recipeIdentity, false);
    assert.equal('scheduler' in provider.recipeIdentity, false);
    assert.equal('runtimeDevice' in provider.recipeIdentity, false);
    assert.equal(
      embeddingSpaceIdForRecipe(provider.recipeIdentity),
      PINNED_LOCAL_ONNX_IDENTITIES.bgeM3.embeddingSpaceId,
    );
    assert.equal(
      embeddingRecipeFreshnessId(provider.recipeIdentity),
      PINNED_LOCAL_ONNX_IDENTITIES.bgeM3.embeddingRecipeFreshnessId,
    );
  }

  assert.equal(
    localOnnxModelDescriptor('bge-m3').requiredVramBytes,
    PINNED_LOCAL_ONNX_IDENTITIES.bgeM3.requiredVramBytes,
  );
  assert.equal(
    localOnnxModelDescriptor('multilingual-e5-small').requiredVramBytes,
    PINNED_LOCAL_ONNX_IDENTITIES.e5Small.requiredVramBytes,
  );
  assert.equal(embeddingSpaceIdForRecipe(e5.recipeIdentity), PINNED_LOCAL_ONNX_IDENTITIES.e5Small.embeddingSpaceId);
  assert.equal(
    embeddingRecipeFreshnessId(e5.recipeIdentity),
    PINNED_LOCAL_ONNX_IDENTITIES.e5Small.embeddingRecipeFreshnessId,
  );
});

test('AC8 requiredVramBytes changes do not enter Local ONNX index identity', () => {
  const descriptor = localOnnxModelDescriptor('bge-m3');
  const originalRequiredVramBytes = descriptor.requiredVramBytes;
  const before = new LocalOnnxProvider({ model: 'bge-m3' }).recipeIdentity;

  try {
    descriptor.requiredVramBytes = originalRequiredVramBytes * 2;
    const after = new LocalOnnxProvider({ model: 'bge-m3' }).recipeIdentity;
    assert.equal(embeddingSpaceIdForRecipe(after), embeddingSpaceIdForRecipe(before));
    assert.equal(embeddingRecipeFreshnessId(after), embeddingRecipeFreshnessId(before));
    assert.equal(JSON.stringify(after), JSON.stringify(before));
  } finally {
    descriptor.requiredVramBytes = originalRequiredVramBytes;
  }
});

test('AC5 resident model key and admission policy stay out of embedding-space identity', () => {
  const executionPolicy = { intraOpNumThreads: 3, interOpNumThreads: 1 };
  const autoPayload = {
    kind: 'local-onnx',
    model: 'bge-m3',
    executionPolicy,
    devicePolicy: 'auto',
  };
  const gpuPayload = {
    ...autoPayload,
    devicePolicy: 'gpu',
    executionProvider: 'cuda',
  };
  const cpuPayload = {
    ...autoPayload,
    devicePolicy: 'cpu',
    executionProvider: 'cpu',
  };
  const provider = new LocalOnnxProvider({ model: 'bge-m3', executionProvider: 'auto', executionPolicy });

  assert.equal(residentModelKey(autoPayload), residentModelKey(gpuPayload));
  assert.equal(residentModelKey(autoPayload), residentModelKey(cpuPayload));
  assert.equal(admissionPolicy(autoPayload), 'auto');
  assert.equal(admissionPolicy(gpuPayload), 'gpu');
  assert.equal(admissionPolicy(cpuPayload), 'cpu');
  assert.equal(embeddingSpaceIdForRecipe(provider.recipeIdentity), PINNED_LOCAL_ONNX_IDENTITIES.bgeM3.embeddingSpaceId);
  assert.equal(
    embeddingRecipeFreshnessId(provider.recipeIdentity),
    PINNED_LOCAL_ONNX_IDENTITIES.bgeM3.embeddingRecipeFreshnessId,
  );
  assert.equal('residentModelKey' in provider.recipeIdentity, false);
  assert.equal('admissionPolicy' in provider.recipeIdentity, false);
  assert.equal('devicePolicy' in provider.recipeIdentity, false);
  assert.equal('executionProvider' in provider.recipeIdentity, false);
});

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

test('AC9 no-variance branch keeps ONNX execution policy out of default recipe identity', () => {
  const policyA = { intraOpNumThreads: 1, interOpNumThreads: 1 };
  const policyB = { intraOpNumThreads: 4, interOpNumThreads: 1 };
  const providerA = new LocalOnnxProvider({ executionPolicy: policyA });
  const providerB = new LocalOnnxProvider({ executionPolicy: policyB });

  assert.equal(providerA.recipeIdentity.executionPolicy, undefined);
  assert.equal(providerB.recipeIdentity.executionPolicy, undefined);
  assert.equal(
    embeddingSpaceIdForRecipe(providerA.recipeIdentity),
    embeddingSpaceIdForRecipe(providerB.recipeIdentity),
  );
});

test('AC9 variance branch policy fold changes embeddingSpaceId and disables dense carry-forward', () => {
  const base = baseRecipe();
  const preCapRecipe = clone(base);
  const cappedRecipe = clone(base);
  cappedRecipe.executionPolicy = { intraOpNumThreads: 3, interOpNumThreads: 1 };

  const preCapSpace = embeddingSpaceIdForRecipe(preCapRecipe);
  const cappedSpace = embeddingSpaceIdForRecipe(cappedRecipe);
  assert.notEqual(cappedSpace, preCapSpace);

  const liveDocuments = new Map([
    ['doc-a', { documentId: 'doc-a', contentHash: 'content-a' }],
    ['doc-b', { documentId: 'doc-b', contentHash: 'content-b' }],
  ]);
  const records = new Map([
    ['doc-a', { contentHash: 'content-a' }],
    ['doc-b', { contentHash: 'content-b' }],
  ]);
  const usability = denseUsabilityForRecordsForTests(liveDocuments, records, preCapSpace === cappedSpace);
  assert.equal(usability.spaceMatch, false);
  assert.deepEqual([...usability.usableDocumentIds], []);
  assert.deepEqual([...usability.pendingDocumentIds].sort(), ['doc-a', 'doc-b']);
});

test('lexical corpusSnapshotId changes when INDEX_BUILD_VERSION changes', () => {
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity({
    name: 'test-analyzer',
    version: '1',
    node: 'test',
  });
  const manifest = {
    identityTuple,
    liveDocumentManifestHash: 'live-documents',
    tombstoneHash: 'tombstones',
    bm25StatsSchemaId: 1,
    corpusStats: [],
    bm25GlobalStatsRows: [],
    bm25GlobalStatsHash: 'bm25',
    partitions: [],
  };
  const bumped = {
    ...manifest,
    identityTuple: {
      ...identityTuple,
      buildVersion: `${identityTuple.buildVersion}+next`,
    },
  };

  assert.notEqual(corpusSnapshotIdFromManifest(bumped), corpusSnapshotIdFromManifest(manifest));
});
