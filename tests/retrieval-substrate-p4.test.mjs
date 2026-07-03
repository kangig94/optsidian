import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ModelSessionLifecycle } from '../src/daemon/model-session/lifecycle.ts';
import { executeSearchShardJob } from '../src/daemon/search-execution.ts';
import { buildCanonicalSearchSnapshot } from '../src/daemon/search-store/builder.ts';
import { searchStoreCachePaths } from '../src/daemon/search-store/cache-paths.ts';
import { DaemonSearchStoreService } from '../src/daemon/search-store/service.ts';
import { DaemonSnapshotStore } from '../src/daemon/search-store/snapshot-store.ts';
import { createMemoryCoralNeedleInstanceFactory } from './helpers/memory-coral-needle.mjs';
import {
  createDeterministicEmbeddingSetBuilder,
  DeterministicHashProvider,
} from './helpers/deterministic-embedding.mjs';
import { editionDense } from './helpers/edition-ledger.mjs';
import { vectorStoreCachePaths } from '../src/daemon/vector-store/cache-paths.ts';
import { recoverRetrievalStaging } from '../src/daemon/vector-store/freshness.ts';
import { VectorGenerationPool } from '../src/daemon/vector-store/pool.ts';

const RETRIEVAL_PROFILE_HASH = 'retrieval-p4-profile';

function tempRoot(prefix = 'optsidian-retrieval-p4-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKey(overrides = {}) {
  return {
    profileHash: overrides.profileHash ?? 'profile-a',
    vaultStateHash: overrides.vaultStateHash ?? 'vault-a',
    embeddingSetId: overrides.embeddingSetId ?? 'embedding-a',
  };
}

function makeSpec(specId = 'deterministic-spec', dims = 3) {
  return {
    specId,
    provider: 'deterministic-hash',
    model: 'content-hash-v1',
    dims,
    normalization: 'l2',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeChunk(id, vector, spec = makeSpec()) {
  return {
    id: `${id}:0`,
    entryId: id,
    entryKind: 'note',
    chunkIndex: 0,
    text: `text ${id}`,
    contentHash: `hash-${id}`,
    vector,
    specId: spec.specId,
  };
}

function queryVector(vector) {
  return vector;
}

function createFakeCoralFactory(options = {}) {
  const chunksByGeneration = new Map();
  const instances = [];
  const events = [];
  const searchWaiters = new Map();
  const buildWaiters = new Map();
  const calls = {
    create: [],
    init: [],
    buildIndex: [],
    searchVector: [],
    close: [],
    upsert: [],
  };
  const factory = {
    async create(input) {
      calls.create.push({ ...input });
      const instance = {
        instanceId: `${input.role}:${input.key.vaultStateHash}:${input.generationId}:${calls.create.length}`,
        role: input.role,
        key: input.key,
        generationId: input.generationId,
        dbPath: input.dbPath,
        closed: false,
        async initStore(dbPath) {
          calls.init.push({ generationId: input.generationId, role: input.role, dbPath });
          events.push(['init', input.role, input.generationId]);
        },
        async setActiveSpec(spec) {
          instance.spec = spec;
        },
        async upsertChunks(chunks) {
          calls.upsert.push({
            generationId: input.generationId,
            role: input.role,
            chunks: chunks.map((chunk) => chunk.entryId),
          });
          chunksByGeneration.set(
            input.generationId,
            chunks.map((chunk) => ({ ...chunk, vector: Array.from(chunk.vector) })),
          );
        },
        async buildIndex(engineName = 'auto') {
          calls.buildIndex.push({ generationId: input.generationId, role: input.role, engineName });
          events.push(['build', input.role, input.generationId]);
          const waiter = buildWaiters.get(input.generationId);
          if (waiter) await waiter.promise;
        },
        async searchVector(vector, candidateK) {
          calls.searchVector.push({ generationId: input.generationId, role: input.role, candidateK });
          events.push(['search-start', input.role, input.generationId]);
          const waiter = searchWaiters.get(input.generationId);
          if (waiter) await waiter.promise;
          if (instance.closed) throw new Error(`use-after-close ${input.generationId}`);
          const chunks = chunksByGeneration.get(input.generationId) ?? [];
          const results = chunks
            .map((chunk) => ({
              chunkId: chunk.id,
              entryId: chunk.entryId,
              similarity: dot(Array.from(vector), Array.from(chunk.vector)),
            }))
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, candidateK);
          events.push(['search-end', input.role, input.generationId]);
          return results;
        },
        async close() {
          instance.closed = true;
          calls.close.push({ generationId: input.generationId, role: input.role });
          events.push(['close', input.role, input.generationId]);
        },
        async getStats() {
          return {
            chunkCount: (chunksByGeneration.get(input.generationId) ?? []).length,
            specId: instance.spec?.specId ?? null,
            engineName: 'fake-exact',
            schemaVersion: 1,
          };
        },
      };
      instances.push(instance);
      options.onCreate?.(instance);
      return instance;
    },
  };
  return {
    factory,
    calls,
    events,
    instances,
    chunksByGeneration,
    holdBuild(generationId) {
      const waiter = deferred();
      buildWaiters.set(generationId, waiter);
      return waiter;
    },
    holdSearch(generationId) {
      const waiter = deferred();
      searchWaiters.set(generationId, waiter);
      return waiter;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) sum += left[index] * right[index];
  return sum;
}

async function publishGeneration(pool, paths, spec, generationId, chunks) {
  const built = await pool.buildStagingGeneration({
    paths,
    spec,
    chunks,
    generationId,
  });
  await pool.promoteBuiltGeneration(paths, built.metadata);
  return built;
}

function pinCommittedFreshGeneration(pool, paths, metadata) {
  return pool.pinReadableGeneration({
    paths,
    key: paths.key,
    expectedGenerationId: metadata.generationId,
    expectedManifestHash: metadata.manifestHash,
    expectedDbPath: metadata.dbPath,
    expectedSpec: metadata.spec,
  });
}

function makeVectorPaths(vault, key = makeKey()) {
  return vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash: key.profileHash,
    embeddingSetId: key.embeddingSetId,
    env: { ...process.env, XDG_CACHE_HOME: tempRoot('optsidian-retrieval-p4-cache-') },
  });
}

function vectorHandleKey(paths, generationId) {
  return `${paths.key.vaultStateHash}:${paths.key.embeddingSetId}:${generationId}`;
}

function retrievalContext(ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: `p4-${Math.random().toString(16).slice(2)}`,
    requestId: `p4-${Math.random().toString(16).slice(2)}`,
  };
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
    identity: {
      name: 'test-analyzer',
      version: 'retrieval-substrate-p4',
      node: 'test',
    },
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
  const calls = { encode: 0 };
  return {
    calls,
    async encode(payload) {
      calls.encode += 1;
      return {
        provider: provider.identity,
        vectors: await Promise.all(payload.texts.map((text) => provider.embed(text, { inputKind: payload.inputKind }))),
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

function createRetrievalHarness(options = {}) {
  const root = options.root ?? tempRoot('optsidian-retrieval-p4-ledger-');
  const vault = options.vault ?? path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const env = options.env ?? {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
  const analyzer = testAnalyzer();
  const vectorPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: RETRIEVAL_PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress,
      }),
  });
  const service = new DaemonSearchStoreService(
    store,
    createAnalyzerPool(analyzer),
    createEmbeddingPool(),
    createSearchExecutionPool(),
    { queryCacheSize: 8, searchSettings: { ngram: false }, env },
  );
  return { root, vault, env, store, service, vectorPool };
}

async function closeRetrievalHarness(harness) {
  await harness.store.close();
  await harness.vectorPool.close();
}

function writeRetrievalVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeRetrievalSampleVault(vault) {
  writeRetrievalVaultFile(
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
  writeRetrievalVaultFile(
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
  writeRetrievalVaultFile(vault, 'Archive/Gamma.md', '# Gamma\n\nunrelated archive material\n');
}

async function buildFreshRetrieval(harness) {
  const loaded = await harness.service.loadVault(harness.vault, retrievalContext(), {
    preload: false,
    warmupQueryAnalyzer: false,
  });
  assert.equal(loaded.vaults[0].status, 'ready');
  const retrieval = await harness.store.ensureActiveRetrievalSnapshot(harness.vault, retrievalContext());
  assert.equal(retrieval.status, 'ready');
  harness.store.release(retrieval.pin);
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  assert.equal(editionDense(paths).state, 'fresh');
  return paths;
}

function denseAgreementForPath(result, relPath) {
  return result.results.find((entry) => entry.path === relPath)?.debug?.denseAgreement ?? 0;
}

test('AC7 Test A P4 committed fresh generation serves search while staging buildIndex is held', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'A.md'), 'alpha\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const active = await publishGeneration(pool, paths, spec, 'gen-active', [makeChunk('active', [1, 0, 0], spec)]);

  const heldBuild = fake.holdBuild('gen-staging');
  const staging = pool.buildStagingGeneration({
    paths,
    spec,
    chunks: [makeChunk('staging', [0, 1, 0], spec)],
    generationId: 'gen-staging',
  });

  while (!fake.events.some((event) => event[0] === 'build' && event[2] === 'gen-staging')) {
    await delay(1);
  }
  const result = await pinCommittedFreshGeneration(pool, paths, active.metadata);
  assert.equal(result.status, 'ready');
  assert.equal(result.lease.generationId, 'gen-active');
  const hits = await result.lease.searchVector(queryVector([1, 0, 0]), 1);
  assert.deepEqual(
    hits.map((entry) => entry.entryId),
    ['active'],
  );
  result.lease.release();
  heldBuild.resolve();
  await staging;
  await pool.close();
});

test('AC7 Test B P4 missing committed fresh generation returns index-not-ready without query-side build', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'Missing.md'), 'missing vector\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const result = await pool.pinReadableGeneration({
    paths,
    key: paths.key,
    expectedGenerationId: 'gen-missing',
    expectedSpec: spec,
  });
  assert.deepEqual(result, { status: 'index-not-ready', reason: 'active-generation-unreadable' });
  assert.equal(fake.calls.searchVector.length, 0);
  assert.equal(fake.calls.buildIndex.length, 0);
  await pool.close();
});

test('P4 test-only memory coral double is injected through VectorGenerationPool', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'Memory.md'), 'memory vector\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const pool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  const built = await publishGeneration(pool, paths, spec, 'gen-memory', [
    makeChunk('near', [1, 0, 0], spec),
    makeChunk('far', [0, 1, 0], spec),
  ]);
  const result = await pinCommittedFreshGeneration(pool, paths, built.metadata);
  assert.equal(result.status, 'ready');
  const hits = await result.lease.searchVector([1, 0, 0], 2);
  assert.deepEqual(
    hits.map((entry) => entry.entryId),
    ['near', 'far'],
  );
  result.lease.release();
  await pool.close();
});

test('AC1 post-restart pinReadableGeneration lazy-opens committed on-disk active generation', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'Restart.md'), 'restart vector\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const firstPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  await publishGeneration(firstPool, paths, spec, 'gen-restart', [
    makeChunk('near', [1, 0, 0], spec),
    makeChunk('far', [0, 1, 0], spec),
  ]);
  await firstPool.close();

  const restartedPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  assert.deepEqual(restartedPool.statsForTests().active, {});
  const result = await restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: 'gen-restart',
    expectedSpec: spec,
  });
  assert.equal(result.status, 'ready');
  const hits = await result.lease.searchVector([1, 0, 0], 2);
  assert.deepEqual(
    hits.map((entry) => entry.entryId),
    ['near', 'far'],
  );
  const key = vectorHandleKey(paths, 'gen-restart');
  assert.equal(restartedPool.statsForTests().refCounts[key], 1);
  result.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 0);
  await restartedPool.close();
});

test('AC1 concurrent post-restart pinReadableGeneration lazy-open is single-flighted', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'Concurrent.md'), 'concurrent vector\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const firstPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  await publishGeneration(firstPool, paths, spec, 'gen-concurrent', [makeChunk('near', [1, 0, 0], spec)]);
  await firstPool.close();

  const base = createMemoryCoralNeedleInstanceFactory();
  const gate = deferred();
  let queryCreates = 0;
  const restartedPool = new VectorGenerationPool({
    factory: {
      async create(input) {
        if (input.role === 'query') {
          queryCreates += 1;
          await gate.promise;
        }
        return base.create(input);
      },
    },
  });
  const first = restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: 'gen-concurrent',
    expectedSpec: spec,
  });
  const second = restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: 'gen-concurrent',
    expectedSpec: spec,
  });
  await delay(10);
  assert.equal(queryCreates, 1);
  assert.deepEqual(restartedPool.statsForTests().active, {});
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 'ready');
  assert.equal(secondResult.status, 'ready');
  assert.equal(queryCreates, 1);
  const key = vectorHandleKey(paths, 'gen-concurrent');
  assert.equal(restartedPool.statsForTests().refCounts[key], 2);
  firstResult.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 1);
  secondResult.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 0);
  await restartedPool.close();
});

test('AC7 Test C P4 multi-vault queries use distinct active query instances without eviction or re-init', async () => {
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  fs.writeFileSync(path.join(vaultA, 'A.md'), 'a\n');
  fs.writeFileSync(path.join(vaultB, 'B.md'), 'b\n');
  const pathsA = makeVectorPaths(vaultA, makeKey({ vaultStateHash: 'vault-a', embeddingSetId: 'embedding-a' }));
  const pathsB = makeVectorPaths(vaultB, makeKey({ vaultStateHash: 'vault-b', embeddingSetId: 'embedding-b' }));

  const builtA = await publishGeneration(pool, pathsA, spec, 'gen-a', [makeChunk('A', [1, 0, 0], spec)]);
  const builtB = await publishGeneration(pool, pathsB, spec, 'gen-b', [makeChunk('B', [0, 1, 0], spec)]);

  const [resultA, resultB] = await Promise.all([
    pinCommittedFreshGeneration(pool, pathsA, builtA.metadata),
    pinCommittedFreshGeneration(pool, pathsB, builtB.metadata),
  ]);
  assert.equal(resultA.status, 'ready');
  assert.equal(resultB.status, 'ready');
  const [hitsA, hitsB] = await Promise.all([
    resultA.lease.searchVector([1, 0, 0], 1),
    resultB.lease.searchVector([0, 1, 0], 1),
  ]);
  assert.deepEqual(
    hitsA.map((entry) => entry.entryId),
    ['A'],
  );
  assert.deepEqual(
    hitsB.map((entry) => entry.entryId),
    ['B'],
  );
  resultA.lease.release();
  resultB.lease.release();
  assert.equal(fake.calls.init.filter((call) => call.generationId === 'gen-a' && call.role === 'query').length, 1);
  assert.equal(fake.calls.init.filter((call) => call.generationId === 'gen-b' && call.role === 'query').length, 1);
  assert.equal(fake.calls.close.filter((call) => call.generationId === 'gen-a' && call.role === 'query').length, 0);
  assert.equal(fake.calls.close.filter((call) => call.generationId === 'gen-b' && call.role === 'query').length, 0);
  await pool.close();
});

test('AC7 Test D P4 generation swap drains in-flight readers before closing old query process', async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, 'A.md'), 'alpha\n');
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const old = await publishGeneration(pool, paths, spec, 'gen-n', [makeChunk('old', [1, 0, 0], spec)]);

  const heldSearch = fake.holdSearch('gen-n');
  const oldPin = await pinCommittedFreshGeneration(pool, paths, old.metadata);
  assert.equal(oldPin.status, 'ready');
  const inFlight = oldPin.lease.searchVector([1, 0, 0], 1);
  while (!fake.events.some((event) => event[0] === 'search-start' && event[2] === 'gen-n')) {
    await delay(1);
  }

  const next = await pool.buildStagingGeneration({
    paths,
    spec,
    chunks: [makeChunk('new', [0, 1, 0], spec)],
    generationId: 'gen-n1',
  });
  await pool.promoteBuiltGeneration(paths, next.metadata);
  assert.equal(
    fake.calls.close.some((call) => call.generationId === 'gen-n' && call.role === 'query'),
    false,
  );

  heldSearch.resolve();
  const hits = await inFlight;
  assert.equal(oldPin.lease.generationId, 'gen-n');
  assert.deepEqual(
    hits.map((entry) => entry.entryId),
    ['old'],
  );
  oldPin.lease.release();

  await waitFor(() => fake.calls.close.some((call) => call.generationId === 'gen-n' && call.role === 'query'));
  assert.equal(pool.statsForTests().refCounts[vectorHandleKey(paths, 'gen-n')], undefined);
  await pool.close();
});

test('AC10 P4 model session lifecycle handles device pick idle unload promotion OOM single-flight deadline and abort', async () => {
  const required = 100;

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 150 }),
      loadSession: async (device) => {
        calls.push(device);
        return fakeSession(device);
      },
      idleMs: 1000,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' });
    assert.deepEqual(calls, ['gpu']);
    await lifecycle.unload();
  }

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 149 }),
      loadSession: async (device) => {
        calls.push(device);
        return fakeSession(device);
      },
      idleMs: 1000,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'document-embed' });
    assert.deepEqual(calls, ['cpu']);
    await lifecycle.unload();
  }

  {
    const sessions = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        const session = fakeSession(device);
        sessions.push(session);
        return session;
      },
      idleMs: 10,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' });
    assert.equal(lifecycle.stats().loaded, true);
    await delay(30);
    assert.equal(lifecycle.stats().loaded, false);
    assert.equal(sessions[0].closed, true);
  }

  {
    const calls = [];
    const sessions = [];
    const probes = [{ freeBytes: 0 }, { freeBytes: 200 }];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => probes.shift() ?? { freeBytes: 200 },
      loadSession: async (device) => {
        calls.push(device);
        const session = fakeSession(device);
        sessions.push(session);
        return session;
      },
      idleMs: 1000,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'document-embed' });
    assert.deepEqual(calls, ['cpu']);
    assert.equal(sessions[0].closed, false);
    assert.equal(lifecycle.stats().device, 'cpu');
    await lifecycle.unload();
  }

  {
    const calls = [];
    const sessions = [];
    const probes = [{ freeBytes: 0 }, { freeBytes: 200 }];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => probes.shift() ?? { freeBytes: 200 },
      loadSession: async (device) => {
        calls.push(device);
        const session = fakeSession(device);
        sessions.push(session);
        return session;
      },
      idleMs: 1000,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' });
    assert.deepEqual(calls, ['cpu', 'gpu']);
    assert.equal(sessions[0].closed, true);
    assert.equal(lifecycle.stats().device, 'gpu');
    await lifecycle.unload();
  }

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async (device) => {
        calls.push(device);
        if (device === 'gpu') throw new Error('CUDA out of memory');
        return fakeSession(device);
      },
      idleMs: 1000,
    });
    await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' });
    assert.deepEqual(calls, ['gpu', 'cpu']);
    assert.equal(lifecycle.stats().device, 'cpu');
    await lifecycle.unload();
  }

  {
    let loadCalls = 0;
    const gate = deferred();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        loadCalls += 1;
        await gate.promise;
        return fakeSession(device);
      },
      idleMs: 1000,
    });
    const requests = Array.from({ length: 8 }, () =>
      lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' }),
    );
    await delay(5);
    assert.equal(loadCalls, 1);
    gate.resolve();
    await Promise.all(requests);
    assert.equal(loadCalls, 1);
    await lifecycle.unload();
  }

  {
    const terminated = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async () => new Promise(() => {}),
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000,
    });
    await assert.rejects(
      lifecycle.encode(['q'], { deadline: Date.now() + 20, origin: 'query-text' }),
      /deadline exceeded/,
    );
    assert.deepEqual(terminated, [['gpu', 'deadline']]);
    assert.equal(lifecycle.stats().loaded, false);
  }

  {
    const terminated = [];
    const controller = new AbortController();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async () => new Promise(() => {}),
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000,
    });
    const request = lifecycle.encode(['q'], {
      deadline: Date.now() + 1000,
      origin: 'document-embed',
      signal: controller.signal,
    });
    await delay(5);
    controller.abort();
    await assert.rejects(request, /aborted/);
    assert.deepEqual(terminated, [['gpu', 'abort']]);
    assert.deepEqual(lifecycle.stats(), { loaded: false });
  }

  {
    let loadCalls = 0;
    const terminated = [];
    const gate = deferred();
    const secondary = new AbortController();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        loadCalls += 1;
        await gate.promise;
        return fakeSession(device);
      },
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000,
    });
    const primaryRequest = lifecycle.encode(['primary'], { deadline: Date.now() + 1000, origin: 'query-text' });
    const secondaryRequest = lifecycle.encode(['secondary'], {
      deadline: Date.now() + 1000,
      origin: 'query-text',
      signal: secondary.signal,
    });
    await delay(5);
    secondary.abort();
    await assert.rejects(secondaryRequest, /aborted/);
    assert.equal(loadCalls, 1);
    assert.deepEqual(terminated, []);
    gate.resolve();
    await primaryRequest;
    assert.equal(lifecycle.stats().loaded, true);
    await lifecycle.unload();
  }
});

test('AC11 P4 stronger equivalent: edition ledger replay reports stale after restart and fresh after refresh', async () => {
  const harness = createRetrievalHarness();
  writeRetrievalSampleVault(harness.vault);
  const paths = await buildFreshRetrieval(harness);

  const fresh = await harness.service.retrieve(
    {
      vault: harness.vault,
      origin: 'text',
      text: 'alpha project semantic',
      query: 'alpha project semantic',
      limit: 5,
      debug: true,
    },
    retrievalContext(),
  );
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.dense.state, 'fresh');
  assert.equal(fresh.dense.pendingCount, 0);

  const freshDense = editionDense(paths);
  const vectorPaths = vectorStoreCachePaths({
    vaultRoot: harness.vault,
    profileHash: RETRIEVAL_PROFILE_HASH,
    embeddingSetId: freshDense.embeddingSetId,
    env: harness.env,
  });
  fs.mkdirSync(vectorPaths.stagingDir, { recursive: true });
  fs.mkdirSync(vectorPaths.tmpDir, { recursive: true });
  fs.writeFileSync(path.join(vectorPaths.stagingDir, 'orphan'), 'x');
  fs.writeFileSync(path.join(vectorPaths.tmpDir, 'orphan.tmp'), 'x');
  recoverRetrievalStaging({ vectorPaths });
  assert.deepEqual(fs.readdirSync(vectorPaths.stagingDir), []);
  assert.deepEqual(fs.readdirSync(vectorPaths.tmpDir), []);

  await closeRetrievalHarness(harness);
  writeRetrievalVaultFile(
    harness.vault,
    'Projects/Alpha.md',
    ['---', 'tags: [project, alpha]', '---', '# Alpha', '', 'alpha project semantic handle edited after restart'].join(
      '\n',
    ),
  );

  const restarted = createRetrievalHarness({
    root: harness.root,
    vault: harness.vault,
    env: harness.env,
  });
  try {
    const stale = await restarted.service.retrieve(
      {
        vault: restarted.vault,
        origin: 'text',
        text: 'alpha project semantic',
        query: 'alpha project semantic',
        limit: 5,
        debug: true,
      },
      retrievalContext(),
    );
    assert.equal(stale.status, 'ready');
    assert.equal(stale.dense.state, 'stale');
    assert.equal(stale.dense.pendingCount, 1);
    assert.notEqual(stale.dense.state, 'fresh');
    assert.equal(editionDense(searchStoreCachePaths(restarted.vault, restarted.env)).state, 'unavailable');
    assert.equal(denseAgreementForPath(stale, 'Projects/Alpha.md'), 0);

    const refreshed = await restarted.service.refresh(restarted.vault, retrievalContext());
    assert.equal(refreshed.ok, true);
    assert.equal(editionDense(searchStoreCachePaths(restarted.vault, restarted.env)).state, 'fresh');
    const freshAgain = await restarted.service.retrieve(
      {
        vault: restarted.vault,
        origin: 'text',
        text: 'alpha project semantic',
        query: 'alpha project semantic',
        limit: 5,
        debug: true,
      },
      retrievalContext(),
    );
    assert.equal(freshAgain.status, 'ready');
    assert.equal(freshAgain.dense.state, 'fresh');
    assert.equal(freshAgain.dense.pendingCount, 0);
  } finally {
    await closeRetrievalHarness(restarted);
  }
});

test('P4 pickDevice defaults to CPU when required VRAM is unconfigured (0) and never probes', async () => {
  let probed = false;
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 0,
    probeVram: () => {
      probed = true;
      return { freeBytes: 1_000_000_000 };
    },
    loadSession: async (device) => fakeSession(device),
    idleMs: 1000,
  });
  await lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' });
  assert.equal(lifecycle.stats().device, 'cpu');
  assert.equal(probed, false, 'probeVram must not be consulted when required VRAM is unconfigured');
  await lifecycle.unload();
});

test('P4 a failed encode still re-arms idle unload so the session is not pinned resident forever', async () => {
  const sessions = [];
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 100,
    probeVram: () => ({ freeBytes: 0 }),
    loadSession: async (device) => {
      const session = fakeSession(device);
      session.encode = async () => {
        throw new Error('encode boom');
      };
      sessions.push(session);
      return session;
    },
    idleMs: 10,
  });
  await assert.rejects(lifecycle.encode(['q'], { deadline: Date.now() + 1000, origin: 'query-text' }), /encode boom/);
  assert.equal(lifecycle.stats().loaded, true, 'session stays loaded immediately after a failed encode');
  await delay(30);
  assert.equal(lifecycle.stats().loaded, false, 'idle unload must fire even though the encode failed');
  assert.equal(sessions[0].closed, true);
});

test('P4 a retired generation whose close() rejects is still dropped from the pool', async () => {
  const vault = tempRoot();
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const closeAttempts = [];
  const fake = createFakeCoralFactory({
    onCreate: (instance) => {
      if (instance.role === 'query' && instance.generationId === 'gen-a') {
        instance.close = async () => {
          instance.closed = true;
          closeAttempts.push(instance.generationId);
          throw new Error('close boom');
        };
      }
    },
  });
  const pool = new VectorGenerationPool({ factory: fake.factory });
  await publishGeneration(pool, paths, spec, 'gen-a', [makeChunk('a', [1, 0, 0], spec)]);
  await publishGeneration(pool, paths, spec, 'gen-b', [makeChunk('b', [0, 1, 0], spec)]);

  const keyPrefix = `${paths.key.vaultStateHash}:${paths.key.embeddingSetId}`;
  await waitFor(() => pool.statsForTests().refCounts[`${keyPrefix}:gen-a`] === undefined);
  assert.ok(closeAttempts.includes('gen-a'), 'gen-a query close was attempted and rejected');
  assert.notEqual(pool.statsForTests().refCounts[`${keyPrefix}:gen-b`], undefined, 'gen-b remains tracked');
  await pool.close();
});

function fakeSession(device) {
  return {
    device,
    closed: false,
    async encode(texts) {
      return texts.map((text) => [text.length, device === 'gpu' ? 1 : 0, 0]);
    },
    async close() {
      this.closed = true;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.equal(predicate(), true);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
