import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildEmbeddingSetFromVectors,
  deterministicHashEmbeddingRecipeIdentity,
  embeddingRecipeFreshnessId,
  embeddingSpaceIdForRecipe,
  vectorGenerationIdForManifest,
} from '../src/core/search/dense/embedding-set.ts';
import { LocalOnnxProvider } from '../src/core/search/dense/local-onnx.ts';
import { buildCanonicalSearchSnapshot } from '../src/daemon/search-store/builder.ts';
import { executeSearchShardJob } from '../src/daemon/search-execution.ts';
import { DaemonSearchStoreService } from '../src/daemon/search-store/service.ts';
import { createWorkerEmbeddingSetBuilder, DaemonSnapshotStore } from '../src/daemon/search-store/snapshot-store.ts';
import { VectorGenerationPool } from '../src/daemon/vector-store/pool.ts';
import { DeterministicHashProvider } from './helpers/deterministic-embedding.mjs';
import { createMemoryCoralNeedleInstanceFactory } from './helpers/memory-coral-needle.mjs';

const PROFILE_HASH = 'model-encode-scheduler-ac8-profile';

function tempRoot(prefix = 'optsidian-model-encode-scheduler-ac8-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'model-encode-scheduler-ac8-analyzer', version: '1', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function queryAnalysis(raw) {
  const terms = [
    ...raw
      .normalize('NFKC')
      .toLowerCase()
      .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
  ].map((match) => match[0]);
  return {
    raw,
    primaryChannel: 'morph',
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] },
  };
}

function createAnalyzerPool(analyzer) {
  return {
    analyzerIdentity: analyzer.identity,
    async warmup() {},
    async analyzeQuery(rawQuery) {
      return {
        analyzerIdentity: analyzer.identity,
        analysis: queryAnalysis(rawQuery),
      };
    },
    cancel() {},
    async close() {},
    stats() {
      return {};
    },
  };
}

function createEmbeddingPool() {
  const provider = new DeterministicHashProvider();
  const calls = { encode: 0, query: 0, build: 0, buildPayloads: [] };
  async function encodePayload(payload) {
    calls.encode += 1;
    if (payload.inputKind === 'query') calls.query += 1;
    if (payload.maxTokenBudget !== undefined) calls.build += 1;
    const tokenCounts = payload.texts.map(() => 1);
    let consumedCount = payload.texts.length;
    if (payload.maxTokenBudget !== undefined) {
      let tokenTotal = 0;
      consumedCount = 0;
      for (const tokenCount of tokenCounts) {
        if (consumedCount > 0 && tokenTotal + tokenCount > payload.maxTokenBudget) break;
        consumedCount += 1;
        tokenTotal += tokenCount;
        if (tokenTotal >= payload.maxTokenBudget) break;
      }
    }
    const rows = await Promise.all(
      payload.texts.slice(0, consumedCount).map(async (text, index) => ({
        requestIndex: payload.requestIndexes?.[index] ?? index,
        documentId: payload.documentIds?.[index] ?? String(payload.requestIndexes?.[index] ?? index),
        tokenCount: tokenCounts[index],
        vector: await provider.embed(text, { inputKind: payload.inputKind }),
      })),
    );
    if (payload.maxTokenBudget !== undefined) {
      rows.reverse();
      calls.buildPayloads.push({
        textCount: payload.texts.length,
        consumedCount,
        maxTokenBudget: payload.maxTokenBudget,
        requestIndexes: rows.map((row) => row.requestIndex),
        documentIds: rows.map((row) => row.documentId),
        tokenCounts: rows.map((row) => row.tokenCount),
      });
    }
    return {
      provider: provider.identity,
      vectors: rows.map((row) => row.vector),
      ...(payload.maxTokenBudget !== undefined
        ? {
            consumedCount,
            requestIndexes: rows.map((row) => row.requestIndex),
            documentIds: rows.map((row) => row.documentId),
            tokenCounts: rows.map((row) => row.tokenCount),
          }
        : {}),
    };
  }
  return {
    provider,
    calls,
    hasGpuSlot() {
      return true;
    },
    async encode(payload) {
      return encodePayload(payload);
    },
    async encodeGpu(payload) {
      return encodePayload(payload);
    },
    async encodeCpuFallback(payload) {
      return encodePayload(payload);
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return { loaded: calls.encode > 0 };
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { encodeCalls: calls.encode };
    },
  };
}

function createSearchExecutionPool() {
  let leased = false;
  let busy = false;
  return {
    idleReadySlotIds() {
      return leased || busy ? [] : [0];
    },
    leaseIdleSlot() {
      if (leased || busy) return undefined;
      leased = true;
      return 0;
    },
    releaseIdleSlot(slotId) {
      assert.equal(slotId, 0);
      if (!leased || busy) return false;
      leased = false;
      return true;
    },
    async runOnSlot(job) {
      assert.equal(leased, true);
      leased = false;
      busy = true;
      try {
        return executeSearchShardJob(job);
      } finally {
        busy = false;
      }
    },
    async preloadSnapshot() {
      return [];
    },
    cancel() {},
    async close() {},
    stats() {
      return {};
    },
  };
}

function context(ms = 30_000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: `ac8-${Math.random().toString(16).slice(2)}`,
    requestId: `ac8-${Math.random().toString(16).slice(2)}`,
  };
}

function createMockLocalOnnxProvider(options = {}) {
  const tokenizerCalls = [];
  const runCalls = [];
  const tokenizer = {
    encode(text) {
      tokenizerCalls.push(text);
      const length = Number(/len:(\d+)/.exec(text)?.[1] ?? 1);
      return {
        ids: Array.from({ length }, (_value, index) => index + 1),
        attention_mask: new Array(length).fill(1),
      };
    },
  };
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const provider = new LocalOnnxProvider({
    model: options.model ?? 'multilingual-e5-small',
    executionProvider: 'cpu',
    ensureArtifact: async () => {},
    tokenizer,
    platform: 'linux',
    ort: {
      Tensor,
      InferenceSession: {
        async create() {
          return {
            inputNames: ['input_ids', 'attention_mask'],
            outputNames: ['last_hidden_state'],
            async run(feeds) {
              const dims = feeds.input_ids?.dims ?? feeds.attention_mask.dims;
              const batch = Number(dims[0]);
              const sequenceLength = Number(dims[1]);
              const dim = provider.identity.dim;
              const inputIds = Array.from(feeds.input_ids.data, (value) => Number(value));
              const attentionMask = Array.from(feeds.attention_mask.data, (value) => Number(value));
              runCalls.push({ dims: [batch, sequenceLength], inputIds, attentionMask });
              const data = new Float32Array(batch * sequenceLength * dim);
              for (let row = 0; row < batch; row += 1) {
                for (let token = 0; token < sequenceLength; token += 1) {
                  const flat = row * sequenceLength + token;
                  const offset = flat * dim;
                  const id = inputIds[flat] ?? 0;
                  if ((attentionMask[flat] ?? 0) > 0) {
                    data[offset] = id;
                    if (dim > 1) data[offset + 1] = id * id;
                  } else {
                    data[offset] = 999;
                    if (dim > 1) data[offset + 1] = 999;
                  }
                }
              }
              return {
                last_hidden_state: {
                  data,
                  dims: [batch, sequenceLength, dim],
                },
              };
            },
            release() {},
          };
        },
      },
    },
  });
  return { provider, tokenizerCalls, runCalls };
}

function expectedVectorForTokenLength(length, dim) {
  const vector = new Array(dim).fill(0);
  vector[0] = (length + 1) / 2;
  if (dim > 1) vector[1] = ((length + 1) * (2 * length + 1)) / 6;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

function assertVectorClose(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `vector[${index}] ${actual[index]} not within ${tolerance} of ${expected[index]}`,
    );
  }
}

test('AC3 batched masked mean-pool ignores padded positions for variable-length rows', async () => {
  const { provider, runCalls } = createMockLocalOnnxProvider();
  try {
    const single = await provider.embed('len:2', { inputKind: 'document' });
    const batch = await provider.encodeBatch(['len:2', 'len:5'], { inputKind: 'document' });
    assert.equal(batch.length, 2);
    assertVectorClose(batch[0], single);
    assertVectorClose(batch[0], expectedVectorForTokenLength(2, provider.identity.dim));
    assertVectorClose(batch[1], expectedVectorForTokenLength(5, provider.identity.dim));
    assert.deepEqual(
      runCalls.map((call) => call.dims),
      [
        [1, 2],
        [2, 5],
      ],
    );
    assert.deepEqual(runCalls[1].attentionMask.slice(0, 5), [1, 1, 0, 0, 0]);
  } finally {
    await provider.close();
  }
});

test('AC3 bounded owner batch returns request indexes, document ids, token counts, and vectors in row order', async () => {
  const { provider, tokenizerCalls, runCalls } = createMockLocalOnnxProvider();
  try {
    const result = await provider.encodeTokenBudgetBatch(['len:3', 'len:1', 'len:2'], {
      inputKind: 'document',
      maxTokenBudget: 6,
      requestIndexes: [2, 0, 1],
      documentIds: ['doc-c', 'doc-a', 'doc-b'],
    });
    assert.equal(result.consumedCount, 3);
    assert.deepEqual(result.requestIndexes, [2, 0, 1]);
    assert.deepEqual(result.documentIds, ['doc-c', 'doc-a', 'doc-b']);
    assert.deepEqual(result.tokenCounts, [3, 1, 2]);
    assert.equal(tokenizerCalls.length, result.consumedCount);
    assert.deepEqual(
      runCalls.map((call) => call.dims),
      [[3, 3]],
    );

    const vectorsByRequestIndex = new Map(
      result.requestIndexes.map((requestIndex, rowIndex) => [requestIndex, result.vectors[rowIndex]]),
    );
    assertVectorClose(vectorsByRequestIndex.get(0), expectedVectorForTokenLength(1, provider.identity.dim));
    assertVectorClose(vectorsByRequestIndex.get(1), expectedVectorForTokenLength(2, provider.identity.dim));
    assertVectorClose(vectorsByRequestIndex.get(2), expectedVectorForTokenLength(3, provider.identity.dim));
  } finally {
    await provider.close();
  }
});

test('AC3 one truncated 8192-token document is one bounded unit and is not merged', async () => {
  const { provider, tokenizerCalls, runCalls } = createMockLocalOnnxProvider({ model: 'bge-m3' });
  try {
    const result = await provider.encodeTokenBudgetBatch(['len:9000', 'len:1'], {
      inputKind: 'document',
      maxTokenBudget: 8192,
      requestIndexes: [0, 1],
      documentIds: ['doc-huge', 'doc-small'],
    });
    assert.equal(result.consumedCount, 1);
    assert.deepEqual(result.requestIndexes, [0]);
    assert.deepEqual(result.documentIds, ['doc-huge']);
    assert.deepEqual(result.tokenCounts, [8192]);
    assert.equal(tokenizerCalls.length, 1);
    assert.deepEqual(
      runCalls.map((call) => call.dims),
      [[1, 8192]],
    );
  } finally {
    await provider.close();
  }
});

function createHarness() {
  const root = tempRoot();
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
  const analyzer = testAnalyzer();
  const vectorPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  const embedding = createEmbeddingPool();
  const searchExecution = createSearchExecutionPool();
  const providerPayload = {
    kind: 'deterministic-hash',
    model: embedding.provider.identity.model,
    dim: embedding.provider.identity.dim,
  };
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: createWorkerEmbeddingSetBuilder({
      provider: embedding.provider,
      providerPayload,
      embedding,
      batchSize: 32,
      maxTokenBudget: 2,
    }),
    snapshotBuilder: async (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress,
      }),
  });
  const service = new DaemonSearchStoreService(store, createAnalyzerPool(analyzer), embedding, searchExecution, {
    queryCacheSize: 8,
    searchSettings: { ngram: false },
    env,
  });
  return {
    root,
    vault,
    store,
    service,
    embedding,
    vectorPool,
    async close() {
      await store.close();
      await embedding.close();
      await searchExecution.close();
      await vectorPool.close();
    },
  };
}

function writeSampleVault(vault) {
  writeVaultFile(
    vault,
    'Projects/Alpha.md',
    [
      '---',
      'tags: [project, alpha]',
      '---',
      '# Alpha',
      '',
      'alpha project semantic handle',
      'links to [[Projects/Beta]]',
    ].join('\n'),
  );
  writeVaultFile(
    vault,
    'Projects/Beta.md',
    [
      '---',
      'tags: [project, beta]',
      '---',
      '# Beta',
      '',
      'beta project semantic handle',
      'links to [[Projects/Alpha]]',
    ].join('\n'),
  );
  writeVaultFile(
    vault,
    'Notes/Gamma.md',
    ['---', 'tags: [reference, gamma]', '---', '# Gamma', '', 'gamma reference semantic handle'].join('\n'),
  );
}

function stableRetrievePayload(result) {
  return {
    status: result.status,
    available: result.available,
    snapshotId: result.snapshotId,
    retrievalSnapshotId: result.retrievalSnapshotId,
    dense: {
      state: result.dense.state,
      pendingCount: result.dense.pendingCount,
    },
    results: result.results.map((entry) => ({
      path: entry.path,
      title: entry.title,
      score: entry.score,
      denseAgreement: entry.debug?.denseAgreement ?? 0,
      rerankScore: entry.debug?.rerankScore,
    })),
  };
}

test(
  'AC3 batched worker-owned snapshot path is internally consistent and repeated retrieves are stable',
  { timeout: 120_000 },
  async () => {
    const harness = createHarness();
    writeSampleVault(harness.vault);
    try {
      const loaded = await harness.service.loadVault(harness.vault, context(), { preload: false });
      assert.equal(loaded.vaults[0].status, 'ready');
      const retrieval = await harness.store.tryPinActiveRetrievalSnapshot(harness.vault);
      assert.equal(retrieval.status, 'ready');
      harness.store.release(retrieval.pin);

      const payload = {
        vault: harness.vault,
        origin: 'text',
        text: 'alpha project semantic',
        query: 'alpha project semantic',
        retrieval: 'hybrid',
        limit: 5,
        debug: true,
      };
      const results = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await harness.service.retrieve(payload, context());
        assert.equal(result.status, 'ready');
        assert.equal(result.available, true);
        assert.equal(result.dense.state, 'fresh');
        assert.equal(result.dense.pendingCount, 0);
        assert.match(result.retrievalSnapshotId, /^[a-f0-9]{64}$/);
        assert.ok(result.results.length > 0);
        assert.ok(result.results.some((entry) => (entry.debug?.denseAgreement ?? 0) > 0));
        results.push(JSON.stringify(stableRetrievePayload(result)));
      }

      assert.deepEqual(results, new Array(results.length).fill(results[0]));
      assert.equal(harness.embedding.calls.query, results.length);
      assert.equal(harness.embedding.calls.build, 2);
      assert.deepEqual(
        harness.embedding.calls.buildPayloads.map((payload) => payload.requestIndexes),
        [[1, 0], [0]],
      );
      assert.deepEqual(
        harness.embedding.calls.buildPayloads.map((payload) => ({
          consumedCount: payload.consumedCount,
          maxTokenBudget: payload.maxTokenBudget,
          tokenCounts: payload.tokenCounts,
        })),
        [
          { consumedCount: 2, maxTokenBudget: 2, tokenCounts: [1, 1] },
          { consumedCount: 1, maxTokenBudget: 2, tokenCounts: [1] },
        ],
      );
    } finally {
      await harness.close();
    }
  },
);

function schedulerFixtureDocuments() {
  return [
    {
      documentId: 'doc-a',
      shardDocRef: { segmentId: 'seg-a', partitionId: 0, localDocId: 1, documentId: 'doc-a' },
      path: 'A.md',
      text: 'alpha',
      contentHash: 'content-a',
    },
    {
      documentId: 'doc-b',
      shardDocRef: { segmentId: 'seg-b', partitionId: 0, localDocId: 2, documentId: 'doc-b' },
      path: 'B.md',
      text: 'bravo',
      contentHash: 'content-b',
    },
    {
      documentId: 'doc-c',
      shardDocRef: { segmentId: 'seg-c', partitionId: 1, localDocId: 1, documentId: 'doc-c' },
      path: 'C.md',
      text: 'charlie',
      contentHash: 'content-c',
    },
  ];
}

function scatterCompletionVectors(documents, completions) {
  const vectors = new Array(documents.length);
  for (const completion of completions) {
    for (const row of completion.rows) {
      assert.equal(documents[row.requestIndex].documentId, row.documentId, completion.lane);
      assert.equal(vectors[row.requestIndex], undefined, `${row.documentId} completed twice`);
      vectors[row.requestIndex] = row.vector;
    }
  }
  assert.equal(
    vectors.every((vector) => Array.isArray(vector)),
    true,
  );
  return vectors;
}

test('AC8 out-of-order CPU/GPU encode completion preserves document id/vector attachment', () => {
  const provider = {
    id: 'deterministic-hash',
    model: 'scheduler-attachment-fixture',
    dim: 4,
    version: '1',
  };
  const recipe = deterministicHashEmbeddingRecipeIdentity(provider);
  const documents = schedulerFixtureDocuments();
  const rawVectorsByDocumentId = new Map([
    ['doc-a', [1, 0, 0, 0]],
    ['doc-b', [0, 1, 0, 0]],
    ['doc-c', [0, 0, 1, 0]],
  ]);
  const baselineVectors = documents.map((document) => rawVectorsByDocumentId.get(document.documentId));
  const baseline = buildEmbeddingSetFromVectors({ provider, recipe, documents, vectors: baselineVectors });
  const baselineProjectionHashes = new Map(
    baseline.records.map((record) => [record.documentId, record.vectorProjectionHash]),
  );
  const baselineGenerationId = vectorGenerationIdForManifest({
    embeddingSpaceId: embeddingSpaceIdForRecipe(recipe),
    embeddingRecipeFreshnessId: embeddingRecipeFreshnessId(recipe),
    corpusRevision: 'corpus-revision-ac8',
    records: baseline.records,
  });

  const completionOrders = [
    [
      { lane: 'gpu', rows: [{ requestIndex: 2, documentId: 'doc-c', vector: rawVectorsByDocumentId.get('doc-c') }] },
      { lane: 'cpu', rows: [{ requestIndex: 0, documentId: 'doc-a', vector: rawVectorsByDocumentId.get('doc-a') }] },
      { lane: 'gpu', rows: [{ requestIndex: 1, documentId: 'doc-b', vector: rawVectorsByDocumentId.get('doc-b') }] },
    ],
    [
      { lane: 'cpu', rows: [{ requestIndex: 1, documentId: 'doc-b', vector: rawVectorsByDocumentId.get('doc-b') }] },
      {
        lane: 'gpu',
        rows: [
          { requestIndex: 2, documentId: 'doc-c', vector: rawVectorsByDocumentId.get('doc-c') },
          { requestIndex: 0, documentId: 'doc-a', vector: rawVectorsByDocumentId.get('doc-a') },
        ],
      },
    ],
  ];

  for (const completions of completionOrders) {
    const vectors = scatterCompletionVectors(documents, completions);
    const built = buildEmbeddingSetFromVectors({ provider, recipe, documents, vectors });
    assert.equal(built.embeddingSetId, baseline.embeddingSetId);
    for (const record of built.records) {
      assert.equal(record.vectorProjectionHash, baselineProjectionHashes.get(record.documentId));
    }
    assert.equal(
      vectorGenerationIdForManifest({
        embeddingSpaceId: embeddingSpaceIdForRecipe(recipe),
        embeddingRecipeFreshnessId: embeddingRecipeFreshnessId(recipe),
        corpusRevision: 'corpus-revision-ac8',
        records: built.records,
      }),
      baselineGenerationId,
    );
  }
});
