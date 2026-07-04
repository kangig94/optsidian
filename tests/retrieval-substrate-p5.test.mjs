import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { afterEach } from 'node:test';

import { parseArgs } from '../src/cli/args.ts';
import {
  retrievePayloadFromSimilarity,
  similarityRequestFromArgs,
  similarityResultFromRetrieve,
} from '../src/cli/commands/similarity.ts';
import { normalizeSimilarityParams } from '../src/core/similarity.ts';
import {
  DeterministicHashProvider,
  buildEmbeddingSet,
  createDeterministicEmbeddingSetBuilder,
} from './helpers/deterministic-embedding.mjs';
import { corpusSnapshotIdFromManifest } from '../src/core/search/segments/canonical.ts';
import { createSearchDaemonClient } from '../src/daemon/client.ts';
import { SEARCH_DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.ts';
import { createQueryServer } from '../src/daemon/server.ts';
import { connectRpc, createRpcServer } from '../src/daemon/transport.ts';
import { ModelSessionLifecycle } from '../src/daemon/model-session/lifecycle.ts';
import { searchStoreCachePaths } from '../src/daemon/search-store/cache-paths.ts';
import { DaemonSnapshotStore, computeRetrievalSnapshotId } from '../src/daemon/search-store/snapshot-store.ts';
import { DaemonSearchStoreService } from '../src/daemon/search-store/service.ts';
import {
  buildCanonicalSearchSnapshot,
  snapshotIdentityTupleForAnalyzerIdentity,
} from '../src/daemon/search-store/builder.ts';
import { executeSearchShardJob } from '../src/daemon/search-execution.ts';
import { vectorStoreCachePaths } from '../src/daemon/vector-store/cache-paths.ts';
import { VectorGenerationPool } from '../src/daemon/vector-store/pool.ts';
import {
  createOwnerRecord,
  createOwnerRegistry,
  desiredOwnerIdentity,
  socketPathForOwner,
} from '../src/daemon/owner-registry.ts';
import { createMemoryCoralNeedleInstanceFactory } from './helpers/memory-coral-needle.mjs';
import { activeRetrievalFromEdition, editionDense, generationDirForEnvelope } from './helpers/edition-ledger.mjs';

const PROFILE_HASH = 'retrieval-p5-profile';
const REMOVED_STUB_NAME = ['similarity', 'Unavailable', 'Result'].join('');
const REMOVED_VECTOR_SECTION = ['vector', 'Block'].join('');
const openHarnesses = new Set();

afterEach(async () => {
  const harnesses = [...openHarnesses].reverse();
  for (const harness of harnesses) await closeHarness(harness);
});

function tempRoot(prefix = 'optsidian-retrieval-p5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer(identity = { name: 'test-analyzer', version: 'retrieval-substrate-p5', node: 'test' }) {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity,
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
    channels: {
      morph: terms,
      surface: terms,
      ngram: [],
    },
  };
}

function context(ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: `p5-${Math.random().toString(16).slice(2)}`,
    requestId: `p5-${Math.random().toString(16).slice(2)}`,
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
  const calls = { encode: 0 };
  return {
    calls,
    async encode(payload, options) {
      calls.encode += 1;
      if (Date.now() >= options.deadline) {
        throw Object.assign(new Error('deadline exceeded'), { code: 'DEADLINE_EXCEEDED' });
      }
      const provider = new DeterministicHashProvider({
        model: payload.provider.model,
        dim: payload.provider.dim,
      });
      return {
        provider: provider.identity,
        vectors: await Promise.all(payload.texts.map((text) => provider.embed(text))),
      };
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

function createLifecycleEmbeddingPool() {
  const provider = new DeterministicHashProvider();
  const calls = { load: 0, close: 0, encode: 0 };
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 1,
    probeVram: () => ({ freeBytes: 0 }),
    loadSession: async (device) => {
      calls.load += 1;
      return {
        device,
        async encode(texts, options) {
          calls.encode += 1;
          return Promise.all(texts.map((text) => provider.embed(text, { inputKind: options?.inputKind })));
        },
        async close() {
          calls.close += 1;
        },
      };
    },
    idleMs: 60_000,
  });
  return {
    calls,
    async encode(payload, options) {
      const vectors = await lifecycle.encode(payload.texts, {
        deadline: options.deadline,
        origin: payload.inputKind === 'query' ? 'query-text' : 'document-embed',
      });
      return {
        provider: provider.identity,
        vectors,
      };
    },
    async unload() {
      await lifecycle.unload();
      return { unloaded: true };
    },
    async modelStats() {
      return lifecycle.stats();
    },
    async warmup() {},
    cancel() {},
    async close() {
      await lifecycle.unload();
    },
    stats() {
      return { ...calls, lifecycle: lifecycle.stats() };
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

function createFakeVectorFactory(options = {}) {
  const chunksByGeneration = new Map();
  const calls = {
    create: [],
    initStore: [],
    setActiveSpec: [],
    upsertChunks: [],
    buildIndex: [],
    searchVector: [],
    close: [],
  };
  return {
    calls,
    factory: {
      async create(input) {
        calls.create.push({ ...input });
        const instance = {
          instanceId: `${input.role}:${input.generationId}:${calls.create.length}`,
          role: input.role,
          key: input.key,
          generationId: input.generationId,
          dbPath: input.dbPath,
          async initStore(dbPath) {
            calls.initStore.push({ role: input.role, generationId: input.generationId, dbPath });
          },
          async setActiveSpec(spec) {
            calls.setActiveSpec.push({ role: input.role, generationId: input.generationId, specId: spec.specId });
          },
          async upsertChunks(chunks) {
            calls.upsertChunks.push({ role: input.role, generationId: input.generationId, count: chunks.length });
            chunksByGeneration.set(
              input.generationId,
              chunks.map((chunk) => ({
                ...chunk,
                vector: Array.from(chunk.vector),
              })),
            );
          },
          async buildIndex(engineName = 'auto') {
            calls.buildIndex.push({ role: input.role, generationId: input.generationId, engineName });
            await options.onBuildIndex?.({ role: input.role, generationId: input.generationId, dbPath: input.dbPath });
          },
          async searchVector(vector, candidateK) {
            calls.searchVector.push({ role: input.role, generationId: input.generationId, candidateK });
            const query = Array.from(vector);
            return (chunksByGeneration.get(input.generationId) ?? [])
              .map((chunk) => ({
                chunkId: chunk.id,
                entryId: chunk.entryId,
                similarity: dot(query, Array.from(chunk.vector)),
              }))
              .sort((left, right) => right.similarity - left.similarity || left.entryId.localeCompare(right.entryId))
              .slice(0, candidateK);
          },
          async close() {
            calls.close.push({ role: input.role, generationId: input.generationId });
          },
        };
        return instance;
      },
    },
  };
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) sum += left[index] * right[index];
  return sum;
}

function deferred() {
  let settled = false;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (error) => {
      settled = true;
      rej(error);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

function createTrackingMemoryVectorFactory(options = {}) {
  const base = createMemoryCoralNeedleInstanceFactory();
  const calls = {
    create: [],
    initStore: [],
    setActiveSpec: [],
    upsertChunks: [],
    buildIndex: [],
    searchVector: [],
    close: [],
  };
  return {
    calls,
    factory: {
      async create(input) {
        calls.create.push({ ...input });
        const instance = await base.create(input);
        return {
          instanceId: instance.instanceId,
          role: instance.role,
          key: instance.key,
          generationId: instance.generationId,
          dbPath: instance.dbPath,
          async initStore(dbPath) {
            calls.initStore.push({ role: input.role, generationId: input.generationId, dbPath });
            await options.beforeInitStore?.(input, dbPath);
            return instance.initStore(dbPath);
          },
          async setActiveSpec(spec) {
            calls.setActiveSpec.push({ role: input.role, generationId: input.generationId, specId: spec.specId });
            return instance.setActiveSpec(spec);
          },
          async upsertChunks(chunks) {
            calls.upsertChunks.push({ role: input.role, generationId: input.generationId, count: chunks.length });
            return instance.upsertChunks(chunks);
          },
          async buildIndex(engineName = 'auto') {
            calls.buildIndex.push({ role: input.role, generationId: input.generationId, engineName });
            await options.beforeBuildIndex?.(input, engineName);
            return instance.buildIndex(engineName);
          },
          async searchVector(vector, candidateK) {
            calls.searchVector.push({ role: input.role, generationId: input.generationId, candidateK });
            return instance.searchVector(vector, candidateK);
          },
          async close() {
            calls.close.push({ role: input.role, generationId: input.generationId });
            return instance.close();
          },
          getStats() {
            return instance.getStats();
          },
        };
      },
    },
  };
}

function createHarness(options = {}) {
  const root = options.root ?? tempRoot();
  const vault = options.vault ?? path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const env = options.env ?? {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
  const analyzer = testAnalyzer();
  let buildCount = 0;
  const vector = options.vector ?? createFakeVectorFactory(options.vectorFactoryOptions);
  const vectorPool = new VectorGenerationPool({ factory: vector.factory });
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async (input) => {
      buildCount += 1;
      return buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress,
      });
    },
    ...options.snapshotStoreOptions,
  });
  const embedding = options.embedding ?? createEmbeddingPool();
  const service = new DaemonSearchStoreService(
    store,
    createAnalyzerPool(analyzer),
    embedding,
    createSearchExecutionPool(),
    { queryCacheSize: 8, searchSettings: { ngram: false }, vectorPool },
  );
  const harness = {
    root,
    vault,
    env,
    store,
    service,
    embedding,
    vector,
    vectorPool,
    buildCount: () => buildCount,
  };
  openHarnesses.add(harness);
  return harness;
}

async function closeHarness(harness) {
  openHarnesses.delete(harness);
  await Promise.all([harness.store.close(), harness.vectorPool.close(), harness.embedding.close?.()]);
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
      'alpha project semantic neighbor',
      'links back to [[Projects/Alpha]]',
    ].join('\n'),
  );
  writeVaultFile(vault, 'Archive/Gamma.md', '# Gamma\n\nunrelated archive material\n');
}

async function readyHarness(options = {}) {
  const harness = createHarness(options);
  writeSampleVault(harness.vault);
  const loaded = await harness.service.loadVault(harness.vault, context(), {
    preload: false,
    warmupQueryAnalyzer: false,
  });
  assert.equal(loaded.vaults[0].status, 'ready');
  assert.equal(harness.buildCount(), 1);
  return harness;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function eventually(assertion, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

function activeRetrieval(paths) {
  return activeRetrievalFromEdition(paths);
}

function resultPath(result, relPath) {
  return result.results.find((entry) => entry.path === relPath);
}

function denseAgreementForPath(result, relPath) {
  return resultPath(result, relPath)?.debug?.denseAgreement ?? 0;
}

function stripRetrieveDense(result) {
  const { dense: _dense, ...rest } = result;
  return JSON.parse(JSON.stringify(rest));
}

async function ensureActiveRetrieval(harness) {
  const ready = await harness.store.ensureActiveRetrievalSnapshot(harness.vault, context());
  assert.equal(ready.status, 'ready');
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const active = activeRetrieval(paths);
  const envelope = retrievalEnvelope(paths, active.retrievalSnapshotId);
  harness.store.release(ready.pin);
  return { paths, active, envelope };
}

function retrievalEnvelope(paths, retrievalSnapshotId) {
  return readJson(path.join(paths.retrievalsDir, retrievalSnapshotId));
}

function retrievalVectorPaths(harness, embeddingSetId) {
  return vectorStoreCachePaths({
    vaultRoot: harness.vault,
    profileHash: PROFILE_HASH,
    embeddingSetId,
    env: harness.env,
  });
}

function snapshotSearchArtifactPaths(paths, envelope) {
  return [
    path.join(paths.snapshotsDir, envelope.snapshotId),
    path.join(paths.linkGraphsDir, envelope.linkGraphId),
    ...envelope.manifest.partitions.map((partition) => path.join(paths.segmentsDir, partition.segmentHash)),
  ];
}

function assertPathsExist(paths, message) {
  for (const filePath of paths) {
    assert.equal(fs.existsSync(filePath), true, `${message}: ${path.basename(filePath)}`);
  }
}

function assertSearchArtifactReservationsReleased(store) {
  assert.equal(store.inFlightSearchArtifactRoots.size, 0);
}

function queryRequest(method, payload = {}) {
  return {
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId: `p5-${method}-${Math.random().toString(16).slice(2)}`,
    method,
    deadline: Date.now() + 5000,
    payload,
  };
}

test('AC5 single Retrieve powers search and similarity sugar', async () => {
  const harness = await readyHarness();
  const similarityRequest = normalizeSimilarityParams(
    similarityRequestFromArgs(
      parseArgs(['similarity', 'mode=left', 'left=Projects/Alpha.md', 'top-k=3', 'format=json']),
    ),
  );
  const similarityRetrieve = await harness.service.retrieve(
    {
      vault: harness.vault,
      ...retrievePayloadFromSimilarity(similarityRequest),
      debug: true,
    },
    context(),
  );
  const similarity = similarityResultFromRetrieve(similarityRetrieve, similarityRequest);

  assert.equal(similarity.available, true);
  assert.equal(similarity.status, 'ready');
  assert.equal(similarity.origin, 'note');
  assert.ok(similarity.results.length > 0);
  assert.equal(
    similarity.results.some((result) => result.path === 'Projects/Alpha.md'),
    false,
  );
  assert.equal(typeof similarity.results[0].score, 'number');

  const searchRetrieve = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      limit: 3,
      debug: true,
    },
    context(),
  );
  assert.equal(searchRetrieve.available, true);
  assert.equal(searchRetrieve.status, 'ready');
  assert.equal(searchRetrieve.origin, 'text');
  assert.equal(searchRetrieve.dense.state, 'fresh');
  assert.equal(searchRetrieve.dense.pendingCount, 0);
  assert.equal(typeof searchRetrieve.dense.generationAgeMs, 'number');
  assert.ok(searchRetrieve.results.length > 0);
  assert.equal(searchRetrieve.results.length, searchRetrieve.matches.length);
  assert.equal(typeof searchRetrieve.results[0].path, 'string');
  assert.equal(typeof searchRetrieve.results[0].score, 'number');

  const noteRetrieve = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'note',
      sourcePath: 'Projects/Alpha.md',
      topK: 5,
    },
    context(),
  );
  assert.equal(noteRetrieve.available, true);
  assert.equal(noteRetrieve.status, 'ready');
  assert.equal(
    noteRetrieve.results.some((result) => result.path === 'Projects/Alpha.md'),
    false,
  );
});

test('public Retrieve dense path uses the active built vector generation', async () => {
  const harness = await readyHarness();
  const { envelope } = await ensureActiveRetrieval(harness);
  assert.ok(
    harness.vector.calls.buildIndex.some(
      (call) => call.role === 'staging' && call.generationId === envelope.vector.generationId,
    ),
  );
  assert.ok(
    harness.vector.calls.buildIndex.some(
      (call) => call.role === 'query' && call.generationId === envelope.vector.generationId,
    ),
  );

  const beforeSearchCalls = harness.vector.calls.searchVector.length;
  const result = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project',
      limit: 2,
      debug: true,
    },
    context(),
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.dense.state, 'fresh');
  assert.equal(result.dense.pendingCount, 0);
  assert.ok(harness.vector.calls.searchVector.length > beforeSearchCalls);
  const call = harness.vector.calls.searchVector.at(-1);
  assert.equal(call.role, 'query');
  assert.equal(call.generationId, envelope.vector.generationId);
  assert.ok(result.results.some((entry) => (entry.debug?.denseAgreement ?? 0) > 0));
});

test('AC1 service Retrieve lazy-opens a committed dense generation after restart with single-flight concurrency', async () => {
  const firstVector = createTrackingMemoryVectorFactory();
  const first = await readyHarness({ vector: firstVector });
  const { envelope } = await ensureActiveRetrieval(first);
  await closeHarness(first);

  const lazyOpenEntered = deferred();
  const releaseLazyOpen = deferred();
  let gateUsed = false;
  const restartedVector = createTrackingMemoryVectorFactory({
    async beforeInitStore(input) {
      if (input.role !== 'query' || input.generationId !== envelope.vector.generationId || gateUsed) return;
      gateUsed = true;
      lazyOpenEntered.resolve();
      await releaseLazyOpen.promise;
    },
  });
  const restarted = createHarness({
    root: first.root,
    vault: first.vault,
    env: first.env,
    vector: restartedVector,
  });
  const restartedVectorPaths = retrievalVectorPaths(restarted, envelope.embeddingSetId);
  const payload = {
    vault: restarted.vault,
    origin: 'text',
    text: 'alpha project semantic',
    query: 'alpha project semantic',
    retrieval: 'hybrid',
    limit: 5,
    debug: true,
  };

  try {
    const firstRetrieve = restarted.service.retrieve(payload, context());
    await lazyOpenEntered.promise;
    const secondRetrieve = restarted.service.retrieve(payload, context());
    const thirdRetrieve = restarted.service.retrieve(payload, context());
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(restarted.vectorPool.statsForTests().lazyOpens, [
      [
        restartedVectorPaths.key.vaultStateHash,
        restartedVectorPaths.key.embeddingSetId,
        envelope.vector.generationId,
        envelope.vector.manifestHash,
      ].join(':'),
    ]);
    assert.equal(
      restartedVector.calls.create.filter(
        (call) => call.role === 'query' && call.generationId === envelope.vector.generationId,
      ).length,
      1,
    );

    releaseLazyOpen.resolve();
    const results = await Promise.all([firstRetrieve, secondRetrieve, thirdRetrieve]);
    for (const result of results) {
      assert.equal(result.status, 'ready');
      assert.equal(result.available, true);
      assert.equal(result.dense.state, 'fresh');
      assert.equal(result.dense.pendingCount, 0);
      assert.equal(typeof result.dense.generationAgeMs, 'number');
      assert.match(result.retrievalSnapshotId, /^[a-f0-9]{64}$/);
      assert.ok(result.results.length > 0);
      assert.ok(result.results.some((entry) => (entry.debug?.denseAgreement ?? 0) > 0));
    }
    assert.equal(
      restartedVector.calls.initStore.filter(
        (call) => call.role === 'query' && call.generationId === envelope.vector.generationId,
      ).length,
      1,
    );
  } finally {
    if (!releaseLazyOpen.settled) releaseLazyOpen.resolve();
    await closeHarness(restarted);
  }
});

test('AC2 service Retrieve falls back lexically when committed dense metadata is corrupt', async () => {
  const harness = await readyHarness();
  const { envelope } = await ensureActiveRetrieval(harness);
  const vectorPaths = retrievalVectorPaths(harness, envelope.embeddingSetId);
  fs.writeFileSync(
    path.join(generationDirForEnvelope(vectorPaths, envelope), 'generation.json'),
    '{ corrupt generation metadata\n',
  );
  const encodeBefore = harness.embedding.calls.encode;
  const denseSearchBefore = harness.vector.calls.searchVector.length;

  const result = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      retrieval: 'vector',
      limit: 3,
      debug: true,
    },
    context(),
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.available, true);
  assert.ok(result.results.length > 0);
  assert.equal(result.dense.state, 'cold');
  assert.equal(result.dense.pendingCount, 3);
  assert.equal(result.dense.generationAgeMs, null);
  assert.equal(result.retrievalSnapshotId, undefined);
  assert.equal(harness.embedding.calls.encode, encodeBefore);
  assert.equal(harness.vector.calls.searchVector.length, denseSearchBefore);
  assert.equal(
    result.results.every((entry) => (entry.debug?.denseAgreement ?? 0) === 0),
    true,
  );
});

test('AC3 cold-start failed dense head is unreadable and Retrieve stays lexical-only', async () => {
  const cause = 'cold-start dense generation failed';
  const baseBuilder = createDeterministicEmbeddingSetBuilder();
  const failingBuilder = {
    ...baseBuilder,
    build: async () => {
      throw new Error(cause);
    },
  };
  const harness = createHarness({
    snapshotStoreOptions: { embeddingSetBuilder: failingBuilder },
  });
  writeSampleVault(harness.vault);
  const loaded = await harness.service.loadVault(harness.vault, context(), {
    preload: false,
    warmupQueryAnalyzer: false,
  });
  assert.equal(loaded.vaults[0].status, 'ready');
  assert.equal(harness.buildCount(), 1);

  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const denseHead = editionDense(paths);
  assert.equal(denseHead.state, 'failed');
  assert.equal(denseHead.cause, cause);
  assert.throws(() => activeRetrievalFromEdition(paths), /no fresh dense edition/);

  const readContextResult = await harness.store.pinLexicalReadContext(harness.vault, context());
  assert.equal(readContextResult.status, 'ready');
  assertSearchArtifactReservationsReleased(harness.store);
  try {
    const attached = await harness.store.tryAttachDenseGeneration(
      readContextResult.readContext,
      harness.store.currentEmbeddingSpaceId(),
    );
    assert.equal(attached.status, 'unreadable');
    assert.equal(attached.reason, cause);
    assert.equal(attached.signal.state, 'cold');
    assert.equal(attached.signal.pendingCount, 3);
    assert.equal(attached.signal.generationAgeMs, null);
  } finally {
    harness.store.releaseReadContext(readContextResult.readContext);
  }

  const encodeBefore = harness.embedding.calls.encode;
  const denseSearchBefore = harness.vector.calls.searchVector.length;
  const result = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 5,
      debug: true,
    },
    context(),
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.available, true);
  assert.ok(result.results.length > 0);
  assert.equal(result.dense.state, 'cold');
  assert.equal(result.dense.pendingCount, 3);
  assert.equal(result.dense.generationAgeMs, null);
  assert.notEqual(result.dense.state, 'fresh');
  assert.equal(result.retrievalSnapshotId, undefined);
  assert.equal(harness.embedding.calls.encode, encodeBefore);
  assert.equal(harness.vector.calls.searchVector.length, denseSearchBefore);
  assert.equal(
    result.results.every((entry) => (entry.debug?.denseAgreement ?? 0) === 0),
    true,
  );
});

test('AC4 dense usability applies space gate and per-doc content hash mask in hybrid and vector paths', async () => {
  const harness = await readyHarness();
  const { paths, envelope } = await ensureActiveRetrieval(harness);
  const vectorBuildsBefore = harness.vector.calls.buildIndex.length;

  writeVaultFile(
    harness.vault,
    'Projects/Alpha.md',
    ['---', 'tags: [project, alpha]', '---', '# Alpha', '', 'alpha project semantic handle edited'].join('\n'),
  );
  writeVaultFile(harness.vault, 'Projects/Delta.md', '# Delta\n\nalpha project semantic delta\n');

  const hybrid = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 10,
      debug: true,
    },
    context(),
  );
  assert.equal(hybrid.status, 'ready');
  // A lexical-only edit leaves the head edition dense-unavailable, but the reader attaches the last
  // fresh generation and masks per-doc: Alpha (edited) and the new Delta lack usable dense, while
  // Beta/Gamma (unchanged) stay dense-enriched. The signal is therefore "stale", not "cold".
  assert.equal(hybrid.dense.state, 'stale');
  assert.equal(hybrid.dense.pendingCount, 2);
  assert.equal(typeof hybrid.dense.generationAgeMs, 'number');
  assert.ok(resultPath(hybrid, 'Projects/Alpha.md'));
  assert.ok(resultPath(hybrid, 'Projects/Beta.md'));
  assert.ok(resultPath(hybrid, 'Projects/Delta.md'));
  assert.equal(denseAgreementForPath(hybrid, 'Projects/Alpha.md'), 0);
  assert.ok(denseAgreementForPath(hybrid, 'Projects/Beta.md') > 0);
  assert.equal(denseAgreementForPath(hybrid, 'Projects/Delta.md'), 0);
  assert.equal(editionDense(paths).state, 'unavailable');
  assert.equal(harness.vector.calls.buildIndex.length, vectorBuildsBefore);

  const vector = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      retrieval: 'vector',
      limit: 10,
      debug: true,
    },
    context(),
  );
  assert.equal(vector.status, 'ready');
  assert.equal(vector.dense.state, 'stale');
  assert.equal(vector.dense.pendingCount, 2);
  // Vector-only surfaces the usable-dense doc (unchanged Beta) with a positive agreement; masked
  // docs (edited Alpha, new Delta) carry no dense agreement (absent from vector hits or unmasked → 0).
  assert.ok(denseAgreementForPath(vector, 'Projects/Beta.md') > 0);
  assert.equal(denseAgreementForPath(vector, 'Projects/Alpha.md'), 0);
  assert.equal(denseAgreementForPath(vector, 'Projects/Delta.md'), 0);

  writeVaultFile(
    harness.vault,
    'Projects/Beta.md',
    ['---', 'tags: [project, beta]', '---', '# Beta', '', 'alpha project semantic neighbor edited'].join('\n'),
  );
  const allMaskedVector = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      retrieval: 'vector',
      path: 'Projects',
      limit: 10,
      debug: true,
    },
    context(),
  );
  assert.equal(allMaskedVector.status, 'ready');
  assert.equal(allMaskedVector.available, true);
  // Alpha+Beta edited and Delta new → every Projects doc is masked; Gamma (Archive, unchanged) keeps
  // usable dense corpus-wide, so the signal is "stale" with pendingCount 3 (Alpha, Beta, Delta).
  assert.equal(allMaskedVector.dense.state, 'stale');
  assert.equal(allMaskedVector.dense.pendingCount, 3);
  assert.ok(resultPath(allMaskedVector, 'Projects/Alpha.md'));
  assert.ok(resultPath(allMaskedVector, 'Projects/Beta.md'));
  assert.ok(resultPath(allMaskedVector, 'Projects/Delta.md'));
  assert.equal(
    allMaskedVector.results.every((entry) => (entry.debug?.denseAgreement ?? 0) === 0),
    true,
  );

  const vectorPaths = retrievalVectorPaths(harness, envelope.embeddingSetId);
  const mismatchedSpace = 'space-mismatch-test';
  const retrievalFile = path.join(paths.retrievalsDir, envelope.retrievalSnapshotId);
  writeJson(retrievalFile, {
    ...readJson(retrievalFile),
    embeddingSpaceId: mismatchedSpace,
  });
  const generationFile = path.join(generationDirForEnvelope(vectorPaths, envelope), 'generation.json');
  writeJson(generationFile, {
    ...readJson(generationFile),
    embeddingSpaceId: mismatchedSpace,
  });
  const encodeBeforeMismatch = harness.embedding.calls.encode;

  const hybridMismatch = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 10,
      debug: true,
    },
    context(),
  );
  assert.equal(hybridMismatch.status, 'ready');
  assert.equal(hybridMismatch.dense.state, 'cold');
  assert.equal(hybridMismatch.dense.pendingCount, 4);
  assert.equal(hybridMismatch.dense.generationAgeMs, null);
  assert.ok(hybridMismatch.results.length > 0);
  assert.equal(
    hybridMismatch.results.every((entry) => (entry.debug?.denseAgreement ?? 0) === 0),
    true,
  );

  const vectorMismatch = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      retrieval: 'vector',
      limit: 10,
      debug: true,
    },
    context(),
  );
  assert.equal(vectorMismatch.status, 'ready');
  assert.equal(vectorMismatch.dense.state, 'cold');
  assert.equal(vectorMismatch.dense.pendingCount, 4);
  assert.ok(resultPath(vectorMismatch, 'Projects/Alpha.md'));
  assert.ok(resultPath(vectorMismatch, 'Projects/Beta.md'));
  assert.ok(resultPath(vectorMismatch, 'Projects/Delta.md'));
  assert.equal(
    vectorMismatch.results.every((entry) => (entry.debug?.denseAgreement ?? 0) === 0),
    true,
  );
  assert.equal(harness.embedding.calls.encode, encodeBeforeMismatch);
  assert.equal(vectorMismatch.retrievalSnapshotId, undefined);
});

test('Retrieve origin=note uses the stored vector without loading the model', async () => {
  const harness = await readyHarness();
  await ensureActiveRetrieval(harness);
  assert.equal(harness.embedding.calls.encode, 0);
  const result = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'note',
      sourcePath: 'Projects/Alpha.md',
      limit: 2,
      debug: true,
    },
    context(),
  );
  assert.equal(result.status, 'ready');
  assert.equal(harness.embedding.calls.encode, 0);
  assert.ok(harness.vector.calls.searchVector.length > 0);
  assert.equal(
    result.results.some((entry) => entry.path === 'Projects/Alpha.md'),
    false,
  );
});

test('AC8 dense freshness signal is public and never affects scored ranking', async () => {
  const harness = await readyHarness();
  await ensureActiveRetrieval(harness);

  const fresh = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 5,
      debug: true,
    },
    context(),
  );
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.dense.state, 'fresh');
  assert.equal(fresh.dense.pendingCount, 0);
  assert.equal(typeof fresh.dense.generationAgeMs, 'number');

  const originalAttach = harness.store.tryAttachDenseGeneration.bind(harness.store);
  harness.store.tryAttachDenseGeneration = async (readContext, desiredEmbeddingSpace) => {
    const attached = await originalAttach(readContext, desiredEmbeddingSpace);
    readContext.denseSignal = {
      state: 'rebuilding',
      pendingCount: 999,
      generationAgeMs: null,
    };
    return { ...attached, signal: readContext.denseSignal };
  };
  const signalPerturbed = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 5,
      debug: true,
    },
    context(),
  );
  assert.equal(signalPerturbed.status, 'ready');
  assert.equal(signalPerturbed.dense.state, 'rebuilding');
  assert.deepEqual(stripRetrieveDense(signalPerturbed), stripRetrieveDense(fresh));
  harness.store.tryAttachDenseGeneration = originalAttach;

  const cold = createHarness();
  writeSampleVault(cold.vault);
  const coldResult = await cold.service.retrieve(
    {
      vault: cold.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      limit: 3,
    },
    context(),
  );
  assert.equal(coldResult.status, 'ready');
  assert.equal(coldResult.dense.state, 'cold');
  assert.equal(coldResult.dense.pendingCount, 3);
  assert.equal(coldResult.dense.generationAgeMs, null);

  const building = await readyHarness();
  await ensureActiveRetrieval(building);
  writeVaultFile(
    building.vault,
    'Projects/Alpha.md',
    ['---', 'tags: [project, alpha]', '---', '# Alpha', '', 'alpha project semantic handle edited while building'].join(
      '\n',
    ),
  );
  const rebuildingResult = await building.service.retrieve(
    {
      vault: building.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 5,
      debug: true,
    },
    context(),
  );
  assert.equal(rebuildingResult.status, 'ready');
  // Editing Alpha leaves the head edition dense-unavailable; the reader attaches the last fresh
  // generation and masks only Alpha, so the signal is "stale" with one pending doc.
  assert.equal(rebuildingResult.dense.state, 'stale');
  assert.equal(rebuildingResult.dense.pendingCount, 1);
  assert.notEqual(rebuildingResult.dense.state, 'fresh');

  const failed = await readyHarness();
  await ensureActiveRetrieval(failed);
  writeVaultFile(failed.vault, 'Projects/Delta.md', '# Delta\n\nalpha project failed pending source\n');
  const failedResult = await failed.service.retrieve(
    {
      vault: failed.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      limit: 5,
      debug: true,
    },
    context(),
  );
  assert.equal(failedResult.status, 'ready');
  // The new Delta has no dense record; the reader still attaches the last fresh generation for the
  // unchanged docs, so the signal is "stale" with one pending doc.
  assert.equal(failedResult.dense.state, 'stale');
  assert.equal(failedResult.dense.pendingCount, 1);
  assert.notEqual(failedResult.dense.state, 'fresh');
});

test('Retrieve origin=pair uses stored note vectors and does not encode raw-text sides', async () => {
  const harness = await readyHarness();
  await ensureActiveRetrieval(harness);
  assert.equal(harness.embedding.calls.encode, 0);
  const notePair = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'pair',
      left: { path: 'Projects/Alpha.md' },
      right: { path: 'Projects/Beta.md' },
      topK: 2,
    },
    context(),
  );
  assert.equal(notePair.status, 'ready');
  assert.equal(harness.embedding.calls.encode, 0);

  await assert.rejects(
    () =>
      harness.service.retrieve(
        {
          vault: harness.vault,
          origin: 'pair',
          left: { text: 'raw alpha text' },
          right: { path: 'Projects/Beta.md' },
          topK: 1,
        },
        context(),
      ),
    (error) => error.code === 'BAD_REQUEST' && /origin=pair accepts note-path sides only/.test(error.message),
  );
  assert.equal(harness.embedding.calls.encode, 0);
});

test('AC9 note, pair, and global origins require stored vectors without model encode', async () => {
  const harness = await readyHarness();
  await ensureActiveRetrieval(harness);
  assert.equal(harness.embedding.calls.encode, 0);

  writeVaultFile(harness.vault, 'Projects/Delta.md', '# Delta\n\nalpha project unembedded source\n');
  const noteMissing = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'note',
      sourcePath: 'Projects/Delta.md',
      limit: 2,
    },
    context(),
  );
  // The new Delta has no stored vector, so its own note origin is genuinely source-vector-missing.
  // The signal is "stale" (Alpha/Beta/Gamma keep usable dense; only Delta pends), not "cold".
  assert.equal(noteMissing.status, 'index-not-ready');
  assert.equal(noteMissing.available, false);
  assert.equal(noteMissing.reason, 'source-vector-missing');
  assert.equal(noteMissing.dense.state, 'stale');
  assert.equal(noteMissing.dense.pendingCount, 1);
  assert.equal(harness.embedding.calls.encode, 0);

  // Alpha is UNCHANGED, so its stored vector remains usable across the Delta edit: a global lookup
  // sourced from it succeeds via per-doc masking (the pre-fix regression returned index-not-ready).
  const globalStored = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'global',
      sourcePath: 'Projects/Alpha.md',
      limit: 2,
      debug: true,
    },
    context(),
  );
  assert.equal(globalStored.status, 'ready');
  assert.equal(globalStored.dense.state, 'stale');
  assert.equal(globalStored.dense.pendingCount, 1);
  assert.equal(harness.embedding.calls.encode, 0);
  assert.ok(harness.vector.calls.searchVector.length > 0);

  const globalMissing = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'global',
      limit: 2,
    },
    context(),
  );
  assert.equal(globalMissing.status, 'index-not-ready');
  assert.equal(globalMissing.reason, 'source-vector-missing');
  assert.equal(globalMissing.dense.state, 'stale');
  assert.equal(globalMissing.dense.pendingCount, 1);
  assert.equal(harness.embedding.calls.encode, 0);
});

test('Retrieve origin=text reuses lifecycle cold-load and unload closes the model session', async () => {
  const embedding = createLifecycleEmbeddingPool();
  const harness = await readyHarness({ embedding });
  for (const text of ['alpha project', 'semantic neighbor']) {
    const result = await harness.service.retrieve(
      {
        vault: harness.vault,
        origin: 'text',
        text,
        limit: 2,
      },
      context(),
    );
    assert.equal(result.status, 'ready');
  }
  assert.equal(embedding.calls.load, 1);
  assert.equal(embedding.calls.close, 0);
  assert.equal((await embedding.modelStats()).loaded, true);
  await embedding.unload();
  assert.equal(embedding.calls.close, 1);
  assert.equal((await embedding.modelStats()).loaded, false);
});

test('AC8 query capability rejects mutators at type and runtime boundaries', async () => {
  const typeTestPath = path.join(process.cwd(), 'tests', '.retrieval-substrate-p5-negative.ts');
  const source = `
import { createQueryServer, type QueryMethodRegistry } from "../src/daemon/server.ts";
import { SEARCH_DAEMON_PROTOCOL_VERSION, type QueryDaemonMethod, type QueryDaemonRequest } from "../src/daemon/protocol.ts";
const runtime = {};
const handler = async () => ({ ok: true });
const readRegistry: QueryMethodRegistry<typeof runtime> = { Retrieve: handler };
void readRegistry;
// @ts-expect-error query capability cannot register LoadVault
createQueryServer({ LoadVault: handler }, runtime);
// @ts-expect-error query capability cannot register Rebuild
createQueryServer({ Rebuild: handler }, runtime);
// @ts-expect-error query capability cannot register Refresh
createQueryServer({ Refresh: handler }, runtime);
// @ts-expect-error query capability cannot register Compact
createQueryServer({ Compact: handler }, runtime);
// @ts-expect-error query capability cannot register Clear
createQueryServer({ Clear: handler }, runtime);
// @ts-expect-error query capability cannot register Prune
createQueryServer({ Prune: handler }, runtime);
// @ts-expect-error query capability cannot register Shutdown
createQueryServer({ Shutdown: handler }, runtime);
// @ts-expect-error query capability cannot name LoadVault
const badNameLoadVault: QueryDaemonMethod = "LoadVault";
// @ts-expect-error query capability cannot name Rebuild
const badNameRebuild: QueryDaemonMethod = "Rebuild";
// @ts-expect-error query capability cannot name Refresh
const badNameRefresh: QueryDaemonMethod = "Refresh";
// @ts-expect-error query capability cannot name Compact
const badNameCompact: QueryDaemonMethod = "Compact";
// @ts-expect-error query capability cannot name Clear
const badNameClear: QueryDaemonMethod = "Clear";
// @ts-expect-error query capability cannot name Prune
const badNamePrune: QueryDaemonMethod = "Prune";
// @ts-expect-error query capability cannot name Shutdown
const badNameShutdown: QueryDaemonMethod = "Shutdown";
void [badNameLoadVault, badNameRebuild, badNameRefresh, badNameCompact, badNameClear, badNamePrune, badNameShutdown];
// @ts-expect-error query capability cannot request LoadVault
const badRequestLoadVault: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "1", method: "LoadVault", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Rebuild
const badRequestRebuild: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "2", method: "Rebuild", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Refresh
const badRequestRefresh: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "3", method: "Refresh", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Compact
const badRequestCompact: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "4", method: "Compact", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Clear
const badRequestClear: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "5", method: "Clear", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Prune
const badRequestPrune: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "6", method: "Prune", deadline: Date.now() + 1000, payload: {} };
// @ts-expect-error query capability cannot request Shutdown
const badRequestShutdown: QueryDaemonRequest = { protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION, requestId: "7", method: "Shutdown", deadline: Date.now() + 1000, payload: {} };
void [badRequestLoadVault, badRequestRebuild, badRequestRefresh, badRequestCompact, badRequestClear, badRequestPrune, badRequestShutdown];
`;
  fs.writeFileSync(typeTestPath, source);
  try {
    const result = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--skipLibCheck',
        '--allowImportingTsExtensions',
        typeTestPath,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(typeTestPath, { force: true });
  }

  const runtime = { hits: [] };
  const queryServer = createQueryServer(
    {
      Retrieve: async (request, target) => {
        target.hits.push(request.method);
        return { ok: true, command: 'retrieve', available: false, status: 'index-not-ready', matches: [], results: [] };
      },
      InspectRead: async (_request, target) => {
        target.hits.push('InspectRead');
        return { ok: true, inspected: true };
      },
    },
    runtime,
  );

  assert.ok(queryServer.methods.includes('InspectRead'));
  assert.deepEqual(await queryServer.handleRequest(queryRequest('InspectRead')), { ok: true, inspected: true });
  await assert.rejects(
    () => queryServer.handleRequest(queryRequest('LoadVault', { vault: '/tmp' })),
    /unknown query daemon method/,
  );
});

test('AC8 daemon ownership is a single socket with method-layer capabilities', () => {
  const root = tempRoot();
  const desired = desiredOwnerIdentity(process.execPath);
  const socketPath = socketPathForOwner(path.join(root, 'runtime'), desired);
  const owner = createOwnerRecord(desired, socketPath, 1, 'incarnation', process.pid);

  assert.equal(owner.socketPath, socketPath);
  assert.equal('querySocketPath' in owner, false);
  assert.equal('controlSocketPath' in owner, false);
});

test('AC9 query socket has no mutating side effects', async () => {
  const root = tempRoot();
  const socketPath = path.join(root, 'query.sock');
  const forbidden = [];
  const runtime = {
    async retrieve() {
      return {
        ok: true,
        command: 'retrieve',
        schemaVersion: 1,
        available: false,
        status: 'index-not-ready',
        origin: 'text',
        reason: 'no-active-retrieval-snapshot',
        matches: [],
        results: [],
      };
    },
    loadVault: () => forbidden.push('loadVault'),
    ensureActiveSnapshot: () => forbidden.push('ensureActiveSnapshot'),
    publishFreshSnapshot: () => forbidden.push('publishFreshSnapshot'),
    snapshotIsFresh: () => forbidden.push('snapshotIsFresh'),
    buildIndex: () => forbidden.push('buildIndex'),
    embed: () => forbidden.push('embed'),
    upsert: () => forbidden.push('upsert'),
    cacheWrite: () => forbidden.push('cacheWrite'),
  };
  const queryServer = createQueryServer(
    {
      Retrieve: (request, target) => target.retrieve(request.payload),
    },
    runtime,
  );
  const rpcServer = await createRpcServer({
    socketPath,
    capability: 'query',
    handleRequest: (request) => queryServer.handleRequest(request),
  });
  const connection = await connectRpc(socketPath);
  try {
    const result = await connection.request(
      queryRequest('Retrieve', {
        vault: root,
        origin: 'text',
        text: 'alpha',
      }),
    );
    assert.equal(result.status, 'index-not-ready');
    assert.deepEqual(forbidden, []);
    await assert.rejects(
      () => connection.request(queryRequest('LoadVault', { vault: root })),
      (error) => error.code === 'BAD_REQUEST' && /unknown query daemon method/.test(error.message),
    );
    assert.deepEqual(forbidden, []);
  } finally {
    await connection.close();
    await rpcServer.close();
  }
});

test('AC9 service Retrieve release is refcount-only and performs no cache file mutation', async () => {
  const harness = await readyHarness();
  await ensureActiveRetrieval(harness);
  const writes = [];
  const deletes = [];
  const originalWriteFileSync = fs.writeFileSync;
  const originalRmSync = fs.rmSync;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    writes.push(String(file));
    return originalWriteFileSync.call(this, file, ...args);
  };
  fs.rmSync = function patchedRmSync(file, ...args) {
    deletes.push(String(file));
    return originalRmSync.call(this, file, ...args);
  };
  try {
    const result = await harness.service.retrieve(
      {
        vault: harness.vault,
        origin: 'note',
        sourcePath: 'Projects/Alpha.md',
        limit: 3,
      },
      context(),
    );
    assert.equal(result.status, 'ready');
    assert.deepEqual(writes, []);
    assert.deepEqual(deletes, []);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync = originalRmSync;
  }
});

test('AC1 AC2 Retrieve pins lexical corpus without query-time dense publication or freshness gating', async () => {
  const absent = createHarness();
  writeSampleVault(absent.vault);
  const absentPin = await absent.store.tryPinActiveRetrievalSnapshot(absent.vault);
  assert.deepEqual(absentPin, { status: 'index-not-ready', reason: 'no-active-retrieval-snapshot' });
  assert.equal(absent.embedding.calls.encode, 0);
  assert.equal(absent.buildCount(), 0);

  const absentResult = await absent.service.retrieve(
    {
      vault: absent.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      limit: 3,
    },
    context(),
  );
  assert.equal(absentResult.status, 'ready');
  assert.equal(absentResult.available, true);
  assert.ok(absentResult.results.length > 0);
  assert.equal(absent.embedding.calls.encode, 0);
  assert.equal(absent.buildCount(), 1);
  assert.equal(absentResult.retrievalSnapshotId, undefined);

  const absentVectorResult = await absent.service.retrieve(
    {
      vault: absent.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      retrieval: 'vector',
      limit: 3,
    },
    context(),
  );
  assert.equal(absentVectorResult.status, 'ready');
  assert.equal(absentVectorResult.available, true);
  assert.ok(absentVectorResult.results.length > 0);
  assert.equal(absent.embedding.calls.encode, 0);

  await assertLexicalReadyAfterEditionEdit('edited-corpus-stale');

  await assertNotReadyAfter('retrieval-snapshot-mismatched', async (harness, envelope, paths) => {
    writeJson(path.join(paths.retrievalsDir, envelope.retrievalSnapshotId), {
      ...envelope,
      corpusSnapshotId: `${envelope.corpusSnapshotId.slice(0, -1)}0`,
    });
  });
  await assertNotReadyAfter('vector-active-spec-mismatched', async (harness, envelope) => {
    const paths = searchStoreCachePaths(harness.vault, harness.env);
    writeJson(path.join(paths.retrievalsDir, envelope.retrievalSnapshotId), {
      ...envelope,
      vector: {
        ...envelope.vector,
        specId: `${envelope.vector.specId}:stale`,
      },
    });
  });
  await assertNotReadyAfter('embedding-set-mismatched', async (_harness, envelope, paths) => {
    const file = path.join(paths.retrievalsDir, envelope.retrievalSnapshotId);
    writeJson(file, {
      ...envelope,
      embeddingSet: {
        ...envelope.embeddingSet,
        embeddingSetId: `${envelope.embeddingSet.embeddingSetId}:stale`,
      },
    });
  });
});

test('edition retrieval pin ignores stale retrieval envelope siblings after current fusion identity changes', async () => {
  const harness = await readyHarness();
  const { paths, envelope } = await ensureActiveRetrieval(harness);
  const staleRetrieverPlanIdentity = `${envelope.retrieverPlanIdentity}:stale-fusion`;
  const staleRetrievalSnapshotId = computeRetrievalSnapshotId({
    corpusSnapshotId: envelope.corpusSnapshotId,
    linkGraphId: envelope.linkGraphId,
    embeddingSetId: envelope.embeddingSetId,
    retrieverPlanIdentity: staleRetrieverPlanIdentity,
    rankingFeatureVersion: envelope.rankingFeatureVersion,
  });
  const staleEnvelope = {
    ...envelope,
    retrievalSnapshotId: staleRetrievalSnapshotId,
    retrieverPlanIdentity: staleRetrieverPlanIdentity,
  };
  writeJson(path.join(paths.retrievalsDir, staleRetrievalSnapshotId), staleEnvelope);

  const result = await harness.store.tryPinActiveRetrievalSnapshot(harness.vault);
  assert.equal(result.status, 'ready');
  assert.equal(result.pin.retrievalSnapshotId, envelope.retrievalSnapshotId);
  harness.store.release(result.pin);
  assert.equal(harness.embedding.calls.encode, 0);
});

test('AC6 composite identity separates lexical, embedding, retrieval, and ANN identity', async () => {
  const vault = tempRoot();
  writeSampleVault(vault);
  const baseAnalyzer = testAnalyzer();
  const modelAAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel('model-a') });
  const modelBAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel('model-b') });

  const base = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: baseAnalyzer, partitionBits: 1 });
  const modelA = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelAAnalyzer, partitionBits: 1 });
  const modelB = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelBAnalyzer, partitionBits: 1 });

  assert.equal(modelA.corpusSnapshotId, corpusSnapshotIdFromManifest(modelA.manifest));
  assert.equal(base.corpusSnapshotId, modelA.corpusSnapshotId);
  assert.equal(modelA.corpusSnapshotId, modelB.corpusSnapshotId);
  assert.equal(modelA.snapshotId, modelB.snapshotId);
  assert.deepEqual(
    modelA.segments.map((segment) => segment.hash),
    modelB.segments.map((segment) => segment.hash),
  );

  const tupleA = snapshotIdentityTupleForAnalyzerIdentity(modelAAnalyzer.identity, 1);
  const tupleB = snapshotIdentityTupleForAnalyzerIdentity(modelBAnalyzer.identity, 1);
  assert.equal('embeddingModel' in tupleA.searchModelIdentity, false);
  assert.equal('embeddingModel' in tupleA.searchModelIdentity.analyzerIdentity.analyzer, false);
  assert.deepEqual(tupleA, tupleB);

  const docs = [
    denseDoc('alpha', 'Projects/Alpha.md', 'alpha project semantic handle'),
    denseDoc('beta', 'Projects/Beta.md', 'alpha project semantic neighbor'),
  ];
  const embeddingA = await buildEmbeddingSet({
    provider: new DeterministicHashProvider({ model: 'deterministic-model-a' }),
    documents: docs,
  });
  const embeddingB = await buildEmbeddingSet({
    provider: new DeterministicHashProvider({ model: 'deterministic-model-b' }),
    documents: docs,
  });
  assert.notEqual(embeddingA.embeddingSetId, embeddingB.embeddingSetId);

  const retrievalA = computeRetrievalSnapshotId({
    corpusSnapshotId: modelA.corpusSnapshotId,
    linkGraphId: modelA.linkGraphId,
    embeddingSetId: embeddingA.embeddingSetId,
    retrieverPlanIdentity: 'retriever-plan:model-a',
    rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion),
  });
  const retrievalB = computeRetrievalSnapshotId({
    corpusSnapshotId: modelA.corpusSnapshotId,
    linkGraphId: modelA.linkGraphId,
    embeddingSetId: embeddingB.embeddingSetId,
    retrieverPlanIdentity: 'retriever-plan:model-b',
    rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion),
  });
  assert.notEqual(retrievalA, retrievalB);

  const annGraphA = { engine: 'flat', efSearch: 16 };
  const annGraphB = { engine: 'hnsw', efSearch: 128 };
  assert.notDeepEqual(annGraphA, annGraphB);
  assert.equal(
    computeRetrievalSnapshotId({
      corpusSnapshotId: modelA.corpusSnapshotId,
      linkGraphId: modelA.linkGraphId,
      embeddingSetId: embeddingA.embeddingSetId,
      retrieverPlanIdentity: 'retriever-plan:model-a',
      rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion),
    }),
    retrievalA,
  );
});

test('AC9 retrieval envelope protects sidecar roots through compact', async () => {
  const harness = await readyHarness();
  const { paths, active, envelope } = await ensureActiveRetrieval(harness);
  const retrievalPath = path.join(paths.retrievalsDir, active.retrievalSnapshotId);
  const linkGraphPath = path.join(paths.linkGraphsDir, envelope.linkGraphId);

  assert.ok(fs.existsSync(retrievalPath));
  assert.ok(fs.existsSync(linkGraphPath));
  const result = await harness.store.tryPinActiveRetrievalSnapshot(harness.vault);
  assert.equal(result.status, 'ready');
  const { pin } = result;
  assert.equal(pin.retrievalSnapshotId, envelope.retrievalSnapshotId);
  assert.equal(pin.corpusSnapshotId, envelope.corpusSnapshotId);
  assert.equal(pin.linkGraphId, envelope.linkGraphId);
  assert.equal(pin.embeddingSetId, envelope.embeddingSetId);
  assert.ok(pin.embeddingSet.records.length > 0);
  assert.equal(Array.isArray(envelope.embeddingSet.records[0].vector), true);
  assert.equal(Array.isArray(pin.embeddingSet.records[0].vector), true);
  assertSearchArtifactReservationsReleased(harness.store);
  harness.store.release(pin);
  assertSearchArtifactReservationsReleased(harness.store);

  await harness.service.compact(harness.vault, context());
  assert.ok(fs.existsSync(retrievalPath));
  assert.ok(fs.existsSync(linkGraphPath));
});

test('AC9 in-flight pin reservation protects non-head snapshot artifacts and releases roots', async () => {
  const harness = createHarness({ snapshotStoreOptions: { retentionCount: 2 } });
  writeSampleVault(harness.vault);
  const first = await harness.store.loadVault(harness.vault, { ...context(), embeddingLane: 'rebuild' });
  assert.equal(first.vaults[0].status, 'ready');
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const firstSnapshotId = first.snapshotId;
  const firstEnvelope = readJson(path.join(paths.snapshotsDir, firstSnapshotId));

  writeVaultFile(
    harness.vault,
    'Projects/Alpha.md',
    [
      '---',
      'tags: [project, alpha]',
      '---',
      '# Alpha',
      '',
      'alpha project semantic handle changed for pin GC',
      'links to [[Projects/Beta]]',
    ].join('\n'),
  );
  const second = await harness.store.rebuild(harness.vault, context());
  await harness.store.drainPublishers();
  assert.notEqual(second.snapshotId, firstSnapshotId);
  const secondEnvelope = readJson(path.join(paths.snapshotsDir, second.snapshotId));
  harness.store.retentionCount = 1;

  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(paths.snapshotsDir, firstSnapshotId), oldTime, oldTime);
  fs.utimesSync(path.join(paths.snapshotsDir, second.snapshotId), new Date(), new Date());

  const firstArtifacts = snapshotSearchArtifactPaths(paths, firstEnvelope);
  const firstManifestPath = path.join(paths.snapshotsDir, firstSnapshotId);
  const secondSegmentHashes = new Set(secondEnvelope.manifest.partitions.map((partition) => partition.segmentHash));
  const oldOnlySegmentPaths = firstEnvelope.manifest.partitions
    .filter((partition) => !secondSegmentHashes.has(partition.segmentHash))
    .map((partition) => path.join(paths.segmentsDir, partition.segmentHash));
  assert.ok(oldOnlySegmentPaths.length > 0, 'test fixture must create at least one stale-only segment');
  assertPathsExist(firstArtifacts, 'old snapshot artifacts should exist before pin');

  const originalEnsureLoaded = harness.store.ensureLoaded.bind(harness.store);
  let failureGcRan = false;
  harness.store.ensureLoaded = async (candidatePaths, snapshotId, options) => {
    if (snapshotId === firstSnapshotId && !failureGcRan) {
      failureGcRan = true;
      await harness.store.markSweepSearchGc(paths);
      throw new Error('forced pin load failure');
    }
    return originalEnsureLoaded(candidatePaths, snapshotId, options);
  };
  try {
    await assert.rejects(() => harness.store.pin(harness.vault, firstSnapshotId, context()), /forced pin load failure/);
  } finally {
    harness.store.ensureLoaded = originalEnsureLoaded;
  }
  assert.equal(failureGcRan, true);
  assertSearchArtifactReservationsReleased(harness.store);
  assertPathsExist(firstArtifacts, 'failed pin reservation should protect old artifacts during GC');

  let successGcRan = false;
  harness.store.ensureLoaded = async (candidatePaths, snapshotId, options) => {
    if (snapshotId === firstSnapshotId && !successGcRan) {
      successGcRan = true;
      await harness.store.markSweepSearchGc(paths);
      assertPathsExist(firstArtifacts, 'successful pin reservation should protect old artifacts during GC');
    }
    return originalEnsureLoaded(candidatePaths, snapshotId, options);
  };
  let pin;
  try {
    pin = await harness.store.pin(harness.vault, firstSnapshotId, context());
  } finally {
    harness.store.ensureLoaded = originalEnsureLoaded;
  }
  try {
    assert.equal(successGcRan, true);
    assert.equal(pin.snapshotId, firstSnapshotId);
    assertSearchArtifactReservationsReleased(harness.store);
    assertPathsExist(firstArtifacts, 'pinned old snapshot artifacts should survive interleaved GC');
  } finally {
    harness.store.release(pin);
  }

  assertSearchArtifactReservationsReleased(harness.store);
  await harness.store.markSweepSearchGc(paths);
  assert.equal(fs.existsSync(firstManifestPath), false, 'unpinned stale snapshot manifest should be collected');
  for (const segmentPath of oldOnlySegmentPaths) {
    assert.equal(fs.existsSync(segmentPath), false, 'unpinned stale-only segment should be collected');
  }
});

test('AC9 vector GC protects in-flight generations during publish', async () => {
  let sweepRan = false;
  const harness = createHarness({
    vectorFactoryOptions: {
      async onBuildIndex(call) {
        if (call.role !== 'staging' || sweepRan) return;
        sweepRan = true;
        assert.equal(fs.existsSync(path.dirname(call.dbPath)), true);
        harness.store.markSweepGc(searchStoreCachePaths(harness.vault, harness.env));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(fs.existsSync(path.dirname(call.dbPath)), true);
      },
    },
  });
  writeSampleVault(harness.vault);
  const loaded = await harness.service.loadVault(harness.vault, context(), {
    preload: false,
    warmupQueryAnalyzer: false,
  });
  assert.equal(loaded.vaults[0].status, 'ready');
  assert.equal(sweepRan, true);
  const { envelope } = await ensureActiveRetrieval(harness);
  const activeVectorPaths = retrievalVectorPaths(harness, envelope.embeddingSetId);
  assert.equal(fs.existsSync(generationDirForEnvelope(activeVectorPaths, envelope)), true);
});

test('AC9 retrieval GC roots the edition-named retrieval envelope', async () => {
  const harness = createHarness();
  writeSampleVault(harness.vault);
  const loaded = await harness.service.loadVault(harness.vault, context(), {
    preload: false,
    warmupQueryAnalyzer: false,
  });
  assert.equal(loaded.vaults[0].status, 'ready');
  const { paths, active } = await ensureActiveRetrieval(harness);
  const retrievalEnvelopePath = path.join(paths.retrievalsDir, active.retrievalSnapshotId);
  const orphanPath = path.join(paths.retrievalsDir, 'orphan-retrieval');
  fs.writeFileSync(orphanPath, '{}\n');

  await harness.service.compact(harness.vault, context());

  assert.equal(fs.existsSync(retrievalEnvelopePath), true);
  await eventually(() => {
    assert.equal(fs.existsSync(orphanPath), false, 'orphan retrieval envelope must be collected');
  });
});

test('AC9 vector GC keeps rooted generations and removes stale vector stores', async () => {
  const harness = await readyHarness();
  const { envelope } = await ensureActiveRetrieval(harness);
  const activeVectorPaths = retrievalVectorPaths(harness, envelope.embeddingSetId);
  const activeGenerationDir = generationDirForEnvelope(activeVectorPaths, envelope);
  assert.equal(fs.existsSync(activeGenerationDir), true);

  const staleGenerationDir = path.join(activeVectorPaths.generationsDir, 'gen-stale');
  fs.mkdirSync(staleGenerationDir, { recursive: true });
  fs.writeFileSync(path.join(staleGenerationDir, 'vectors.duckdb'), 'stale');
  assert.equal(fs.existsSync(staleGenerationDir), true);

  const orphanVectorPaths = retrievalVectorPaths(harness, 'orphan-embedding-set');
  const orphanGenerationDir = path.join(orphanVectorPaths.generationsDir, 'gen-orphan');
  fs.mkdirSync(orphanGenerationDir, { recursive: true });
  fs.writeFileSync(path.join(orphanGenerationDir, 'vectors.duckdb'), 'orphan');
  assert.equal(fs.existsSync(orphanGenerationDir), true);

  await harness.service.compact(harness.vault, context());

  assert.equal(fs.existsSync(activeGenerationDir), true);
  await eventually(() => {
    assert.equal(fs.existsSync(staleGenerationDir), false);
    assert.equal(fs.existsSync(orphanVectorPaths.rootDir), false);
  });
});

test('AC9 hybrid search requests Retrieve on query capability', async () => {
  const root = tempRoot();
  const runtimeDir = path.join(root, 'runtime');
  const desired = desiredOwnerIdentity(process.execPath);
  const registry = createOwnerRegistry({ runtimeDir, desired, env: process.env });
  const owner = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const requests = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath: process.execPath,
    connect: (record) => ({
      async request(request) {
        requests.push({ request });
        if (request.method === 'Heartbeat') {
          return {
            owner: record,
            phase: 'ready',
            protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
            incarnationId: record.incarnationId,
            pulseSeq: 1,
            progressSeq: 0,
            updatedAt: record.startedAt,
          };
        }
        if (request.method === 'Status') {
          return {
            ok: true,
            ready: true,
            phase: 'ready',
            protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
            binaryVersion: record.binaryVersion,
            epoch: record.epoch,
            incarnationId: record.incarnationId,
            pid: record.pid,
            socketPath: record.socketPath,
            startedAt: record.startedAt,
            owner: record,
            metrics: { requests: 0, failures: 0, activeRequests: 0, startedAt: record.startedAt },
            pools: {},
            searchStore: {},
            profiles: {},
            vaults: [],
          };
        }
        assert.equal(request.method, 'Retrieve');
        assert.equal(request.incarnation, owner.incarnationId);
        return {
          ok: true,
          command: 'retrieve',
          schemaVersion: 1,
          available: true,
          status: 'ready',
          origin: request.payload.origin,
          snapshotId: 's'.repeat(64),
          retrievalSnapshotId: 'r'.repeat(64),
          matches: [],
          results: [],
        };
      },
      async close() {},
    }),
  });

  const result = await client.search({
    vault: root,
    query: 'alpha project',
    retrieval: 'hybrid',
    limit: 2,
  });
  assert.equal(result.command, 'search');
  const retrieveRequest = requests.find((entry) => entry.request.method === 'Retrieve');
  assert.ok(retrieveRequest);
  assert.equal(retrieveRequest.request.payload.origin, 'text');
  assert.equal(retrieveRequest.request.payload.text, 'alpha project');
  assert.equal(retrieveRequest.request.payload.query, 'alpha project');
});

test('AC14 removed similarity fallback and reserved vector section code', () => {
  const removed = [
    REMOVED_STUB_NAME,
    ['provider', 'unavailable'].join('-'),
    ['Vector similarity provider', 'unavailable'].join(' '),
    REMOVED_VECTOR_SECTION,
    ['CANONICAL_VECTOR', '_BLOCK'].join(''),
    ['reserved but', 'not enabled'].join(' '),
  ];
  const files = [
    path.join(process.cwd(), 'src/core/similarity.ts'),
    path.join(process.cwd(), 'src/cli/commands/similarity.ts'),
    path.join(process.cwd(), 'src/core/types.ts'),
    path.join(process.cwd(), 'src/core/search/segments/canonical.ts'),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const token of removed) {
      assert.equal(content.includes(token), false, `${path.relative(process.cwd(), file)} still contains ${token}`);
    }
  }
});

async function assertNotReadyAfter(expectedReason, mutate) {
  const harness = await readyHarness();
  const { paths, envelope } = await ensureActiveRetrieval(harness);
  const buildsBefore = harness.buildCount();
  await mutate(harness, envelope, paths);
  const result = await harness.store.tryPinActiveRetrievalSnapshot(harness.vault);
  assert.equal(result.status, 'index-not-ready');
  assert.equal(result.reason, expectedReason);
  assert.equal(harness.embedding.calls.encode, 0);
  assert.equal(harness.buildCount(), buildsBefore);
}

async function assertLexicalReadyAfterEditionEdit(label) {
  const harness = await readyHarness();
  const { paths, active } = await ensureActiveRetrieval(harness);
  const buildsBefore = harness.buildCount();
  const encodeBefore = harness.embedding.calls.encode;
  const vectorBuildBefore = harness.vector.calls.buildIndex.length;
  writeVaultFile(
    harness.vault,
    'Projects/Alpha.md',
    [
      '---',
      'tags: [project, alpha]',
      '---',
      '# Alpha',
      '',
      'alpha project semantic handle edited through edition state',
    ].join('\n'),
  );

  const result = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project',
      query: 'alpha project',
      retrieval: 'lexical',
      limit: 3,
      debug: true,
    },
    context(),
  );
  assert.equal(result.status, 'ready', label);
  assert.equal(result.available, true, label);
  assert.equal(result.dense.state, 'stale', label);
  assert.equal(result.dense.pendingCount, 1, label);
  assert.ok(result.results.length > 0, label);
  assert.equal(editionDense(paths).state, 'unavailable', label);
  assert.deepEqual(activeRetrieval(paths), active, label);
  assert.equal(harness.buildCount(), buildsBefore + 1, label);
  assert.equal(harness.vector.calls.buildIndex.length, vectorBuildBefore, label);
  assert.equal(harness.embedding.calls.encode, encodeBefore, label);
}

function embeddingModel(id, dim = 3) {
  return {
    id,
    sha256: id.padEnd(64, '0').slice(0, 64),
    opset: 'onnx-opset-test',
    quantization: 'none',
    dim,
    pooling: 'mean',
  };
}

function denseDoc(documentId, relPath, text) {
  return {
    documentId,
    shardDocRef: {
      segmentId: 'p5-segment',
      partitionId: 0,
      localDocId: 0,
      documentId,
    },
    path: relPath,
    text,
    contentHash: documentId,
  };
}
