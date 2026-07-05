import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EmbedScheduler, VectorGenerationManager } from '../src/daemon/embed-scheduler.ts';
import { ProfileManager } from '../src/daemon/profile-manager.ts';
import { createSearchDaemonIdleIsolationHarnessForTests } from '../src/daemon/server.ts';
import { searchStoreCachePaths } from '../src/daemon/search-store/cache-paths.ts';
import {
  effectiveSearchRuntimeProfile,
  lexicalIdentityHashForSearchRuntimeProfile,
  normalizeSearchRuntimeProfile,
  searchRuntimeProfileHash,
} from '../src/daemon/runtime-profile.ts';
import { vectorStoreCachePaths } from '../src/daemon/vector-store/cache-paths.ts';
import { docIdForVaultPath } from '../src/daemon/vector-store/watcher.ts';
import { activeSnapshotFromEdition } from './helpers/edition-ledger.mjs';

function tempRoot(prefix = 'optsidian-embed-scheduler-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function dirtyMarkForPath(vault, rel) {
  return {
    docId: docIdForVaultPath(rel),
    path: rel,
    contentHash: sha256(fs.readFileSync(path.join(vault, rel))),
  };
}

function searchPathsForRuntime(vault, env, profile = effectiveSearchRuntimeProfile(process.cwd(), env)) {
  return searchStoreCachePaths(vault, env, {
    lexicalIdentityHash: lexicalIdentityHashForSearchRuntimeProfile(profile),
  });
}

function context(id, ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: id,
    requestId: id,
    vault: 'test-vault',
  };
}

function providerPayload(model = 'same-model', dim = 3) {
  return {
    kind: 'deterministic-hash',
    model,
    dim,
  };
}

function createEmbeddingPool(options = {}) {
  const calls = [];
  const documentGates = [];
  async function encodePayload(payload) {
    const call = {
      texts: [...payload.texts],
      inputKind: payload.inputKind ?? 'document',
      provider: payload.provider,
    };
    calls.push(call);
    await options.onEncode?.(call);
    if (call.inputKind === 'document' && options.gateDocuments !== false) {
      const gate = deferred();
      documentGates.push(gate);
      await gate.promise;
    }
    return {
      provider: {
        id: payload.provider.kind,
        model: payload.provider.model ?? 'content-hash-v1',
        dim: payload.provider.dim ?? 3,
        version: '1',
      },
      vectors: payload.texts.map((_text, index) => unitVector(payload.provider.dim ?? 3, index)),
    };
  }
  return {
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
    releaseNextDocument() {
      const gate = documentGates.shift();
      assert.ok(gate, 'expected a gated document encode');
      gate.resolve();
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return { loaded: calls.length > 0 };
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { encodeCalls: calls.length };
    },
  };
}

function createRuntimeEmbeddingPool() {
  const calls = [];
  const documentGates = [];
  let gateDocuments = false;
  let completedDocumentSlices = 0;
  async function encodePayload(payload) {
    const call = {
      texts: [...payload.texts],
      inputKind: payload.inputKind ?? 'document',
      provider: payload.provider,
    };
    calls.push(call);
    if (call.inputKind === 'document' && gateDocuments) {
      const gate = deferred();
      documentGates.push(gate);
      await gate.promise;
    }
    if (call.inputKind === 'document') completedDocumentSlices += 1;
    return {
      provider: {
        id: payload.provider.kind,
        model: payload.provider.model ?? 'content-hash-v1',
        dim: payload.provider.dim ?? 8,
        version: '1',
      },
      vectors: payload.texts.map((_text, index) => unitVector(payload.provider.dim ?? 8, index)),
    };
  }
  return {
    calls,
    setGateDocuments(value) {
      gateDocuments = value;
    },
    get completedDocumentSlices() {
      return completedDocumentSlices;
    },
    pendingDocumentGateCount() {
      return documentGates.length;
    },
    releaseNextDocument() {
      const gate = documentGates.shift();
      assert.ok(gate, 'expected a gated document encode');
      gate.resolve();
    },
    releaseAllDocuments() {
      const count = documentGates.length;
      while (documentGates.length > 0) documentGates.shift().resolve();
      return count;
    },
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
      return { loaded: calls.length > 0 };
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { encodeCalls: calls.length };
    },
  };
}

function unitVector(dim, hotIndex) {
  const vector = new Array(dim).fill(0);
  vector[hotIndex % dim] = 1;
  return vector;
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

test('AC5 live encodes route query before save before refresh before rebuild', async () => {
  const embedding = createEmbeddingPool();
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = providerPayload();
  const active = scheduler.encode(
    { texts: ['active-rebuild'], inputKind: 'document', provider },
    context('active-rebuild'),
    'rebuild',
  );
  await waitFor(() => embedding.calls.length === 1);
  const queued = [
    scheduler.encode(
      { texts: ['queued-rebuild'], inputKind: 'document', provider },
      context('queued-rebuild'),
      'rebuild',
    ),
    scheduler.encode(
      { texts: ['queued-refresh'], inputKind: 'document', provider },
      context('queued-refresh'),
      'refresh',
    ),
    scheduler.encode({ texts: ['queued-save'], inputKind: 'document', provider }, context('queued-save'), 'save'),
    scheduler.encode({ texts: ['queued-query'], inputKind: 'query', provider }, context('queued-query'), 'query'),
  ];
  embedding.releaseNextDocument();
  await active;
  await waitFor(() => embedding.calls.length === 3);
  assert.deepEqual(
    embedding.calls.map((call) => call.texts[0]),
    ['active-rebuild', 'queued-query', 'queued-save'],
  );
  embedding.releaseNextDocument();
  await waitFor(() => embedding.calls.length === 4);
  embedding.releaseNextDocument();
  await waitFor(() => embedding.calls.length === 5);
  embedding.releaseNextDocument();
  await Promise.all(queued);
  assert.deepEqual(
    embedding.calls.map((call) => call.texts[0]),
    ['active-rebuild', 'queued-query', 'queued-save', 'queued-refresh', 'queued-rebuild'],
  );
  await scheduler.close();
});

test('AC5 origin=text query encode completes after at most one rebuild slice', async () => {
  const embedding = createEmbeddingPool();
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = providerPayload();
  let completedDocumentSlices = 0;

  const rebuild = scheduler.withLaneScope('rebuild', async () => {
    for (let slice = 0; slice < 3; slice += 1) {
      await scheduler.encode(
        {
          texts: Array.from({ length: 32 }, (_value, index) => `doc-${slice}-${index}`),
          inputKind: 'document',
          provider,
        },
        context(`rebuild-${slice}`),
        'rebuild',
      );
      completedDocumentSlices += 1;
    }
  });

  await waitFor(() => embedding.calls.length === 1);
  assert.equal(embedding.calls[0].texts.length, 32);

  const query = scheduler.encode(
    {
      texts: ['interactive query'],
      inputKind: 'query',
      provider,
    },
    context('query'),
    'query',
  );

  embedding.releaseNextDocument();
  await query;
  assert.equal(completedDocumentSlices, 1);
  assert.equal(embedding.calls[1].inputKind, 'query');

  await waitFor(() => embedding.calls.length === 3);
  embedding.releaseNextDocument();
  await waitFor(() => embedding.calls.length === 4);
  embedding.releaseNextDocument();
  await rebuild;
  assert.deepEqual(
    embedding.calls.map((call) => call.inputKind),
    ['document', 'query', 'document', 'document'],
  );
  await scheduler.close();
});

test('save and refresh lane document encodes suppress CPU promotion even without an active rebuild', async () => {
  const embedding = createEmbeddingPool({ gateDocuments: false });
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = providerPayload();
  await scheduler.encode({ texts: ['saved'], inputKind: 'document', provider }, context('save-1'), 'save');
  await scheduler.encode({ texts: ['refreshed'], inputKind: 'document', provider }, context('refresh-1'), 'refresh');
  assert.deepEqual(
    embedding.calls.map((call) => call.inputKind),
    ['document', 'document'],
  );
  await scheduler.close();
});

test('AC5 watcher-driven save lets query encode run after one save slice', async () => {
  const root = tempRoot();
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  for (let index = 0; index < 70; index += 1) {
    writeVaultFile(vault, `Note-${String(index).padStart(2, '0')}.md`, `# Note ${index}\n\nbaseline body ${index}\n`);
  }
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: 'deterministic-hash',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
  };
  const embedding = createRuntimeEmbeddingPool();
  const vectorFactory = createFakeCoralFactory();
  const vectorManager = new VectorGenerationManager({ factory: vectorFactory.factory });
  const scheduler = new EmbedScheduler({
    embedding,
    ownsEmbedding: false,
    vectorManager,
    ownsVectorManager: true,
  });
  let watcherOptions;
  const manager = new ProfileManager(env, scheduler, {
    saveMutationDeadlineMs: 10_000,
    startSaveWatcher(options) {
      watcherOptions = options;
      return {
        close() {},
        unref() {},
      };
    },
  });

  try {
    const lease = await manager.acquire({});
    try {
      await lease.runtime.searchStore.loadVault(vault, context('runtime-save-load', 10_000), {
        preload: false,
        warmupQueryAnalyzer: false,
      });
      const paths = searchPathsForRuntime(vault, env, lease.runtime.profile);
      const initialSnapshotId = activeSnapshotFromEdition(paths).snapshotId;
      const initialCallCount = embedding.calls.length;
      const initialCompletedSlices = embedding.completedDocumentSlices;
      embedding.setGateDocuments(true);

      lease.runtime.startSaveWatcherForVault(vault);
      assert.equal(typeof watcherOptions?.onDirtyMarks, 'function');
      writeVaultFile(vault, 'Note-00.md', '# Note 0\n\nsaved fairness marker\n');
      await watcherOptions.onDirtyMarks([dirtyMarkForPath(vault, 'Note-00.md')]);
      await waitFor(() => embedding.calls.length > initialCallCount);
      const firstSaveCallIndex = initialCallCount;
      assert.equal(embedding.calls[firstSaveCallIndex].inputKind, 'document');
      assert.equal(embedding.calls[firstSaveCallIndex].texts.length, 32);

      const query = scheduler.encode(
        {
          texts: ['interactive save fairness query'],
          inputKind: 'query',
          provider: providerPayload('content-hash-v1', 8),
        },
        context('runtime-save-query'),
        'query',
      );
      embedding.releaseNextDocument();
      await query;

      const queryCallIndex = embedding.calls.findIndex(
        (call, index) => index > firstSaveCallIndex && call.inputKind === 'query',
      );
      assert.equal(queryCallIndex, firstSaveCallIndex + 1);
      assert.equal(embedding.completedDocumentSlices, initialCompletedSlices + 1);

      const targetCompletedSlices = initialCompletedSlices + Math.ceil(70 / 32);
      while (embedding.completedDocumentSlices < targetCompletedSlices) {
        if (embedding.pendingDocumentGateCount() === 0) {
          await waitFor(
            () =>
              embedding.pendingDocumentGateCount() > 0 || embedding.completedDocumentSlices >= targetCompletedSlices,
          );
        }
        embedding.releaseAllDocuments();
      }
      await waitFor(() => activeSnapshotFromEdition(paths).snapshotId !== initialSnapshotId, 5000);
    } finally {
      lease.release();
    }
  } finally {
    embedding.releaseAllDocuments();
    await manager.close();
    await scheduler.close();
  }
});

test('AC5 query encode single-flight coalesces identical query work', async () => {
  const gate = deferred();
  const embedding = createEmbeddingPool({
    gateDocuments: false,
    onEncode: async (call) => {
      if (call.inputKind === 'query') await gate.promise;
    },
  });
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = providerPayload();
  const first = scheduler.encode({ texts: ['same query'], inputKind: 'query', provider }, context('query-a'), 'query');
  const second = scheduler.encode({ texts: ['same query'], inputKind: 'query', provider }, context('query-b'), 'query');
  await waitFor(() => embedding.calls.length === 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(embedding.calls.length, 1);
  await scheduler.close();
});

test('AC5 two same-model profiles share one scheduler/model owner and one vector manager with per-key handles', async () => {
  const root = tempRoot();
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: 'deterministic-hash',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
  };
  const embedding = createEmbeddingPool({ gateDocuments: false });
  const vectorFactory = createFakeCoralFactory();
  const vectorManager = new VectorGenerationManager({ factory: vectorFactory.factory });
  const scheduler = new EmbedScheduler({
    embedding,
    ownsEmbedding: false,
    vectorManager,
    ownsVectorManager: true,
  });
  const manager = new ProfileManager(env, scheduler);
  const baseProfile = effectiveSearchRuntimeProfile(process.cwd(), env);
  const profileA = normalizeSearchRuntimeProfile({
    ...baseProfile,
    index: { ngram: false },
  });
  const profileB = normalizeSearchRuntimeProfile({
    ...baseProfile,
    index: { ngram: true },
  });
  const hashA = searchRuntimeProfileHash(profileA);
  const hashB = searchRuntimeProfileHash(profileB);

  try {
    await manager.withRuntimeFor({ profile: profileA }, async (runtime) => {
      assert.equal(runtime.profileHash, hashA);
      assert.equal(runtime.pools.embedding, embedding);
      assert.equal(runtime.vectorPool, vectorManager);
    });
    await manager.withRuntimeFor({ profile: profileB }, async (runtime) => {
      assert.equal(runtime.profileHash, hashB);
      assert.equal(runtime.pools.embedding, embedding);
      assert.equal(runtime.vectorPool, vectorManager);
    });
    assert.notEqual(hashA, hashB);

    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const pathsA = vectorStoreCachePaths({
      vaultRoot: vault,
      profileHash: hashA,
      embeddingSetId: 'embedding-shared',
      env,
    });
    const pathsB = vectorStoreCachePaths({
      vaultRoot: vault,
      profileHash: hashB,
      embeddingSetId: 'embedding-shared',
      env,
    });
    const spec = makeSpec();
    await publishGeneration(vectorManager, pathsA, spec, 'gen-profile-a', [makeChunk('doc-a', [1, 0, 0], spec)]);
    await publishGeneration(vectorManager, pathsB, spec, 'gen-profile-b', [makeChunk('doc-b', [0, 1, 0], spec)]);

    const stats = vectorManager.statsForTests();
    assert.equal(Object.keys(stats.active).length, 1);
    assert.equal(stats.active[`${pathsA.key.vaultStateHash}:embedding-shared`], 'gen-profile-b');
    assert.deepEqual(pathsA.key, pathsB.key);
    assert.equal(vectorFactory.calls.create.filter((call) => call.role === 'query').length, 2);
  } finally {
    await manager.close();
    await scheduler.close();
  }
});

test('AC10 background embeds do not keep the daemon idle timer alive', async () => {
  const embedding = createEmbeddingPool({ gateDocuments: false });
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const harness = createSearchDaemonIdleIsolationHarnessForTests({
    idleMs: 30,
    embedScheduler: scheduler,
  });
  let stopped = false;
  const background = (async () => {
    let index = 0;
    while (!stopped) {
      try {
        await scheduler.encode(
          {
            texts: [`background-${index}`],
            inputKind: 'document',
            provider: providerPayload(),
          },
          context(`background-${index}`, 1000),
          'rebuild',
        );
      } catch (error) {
        if (!stopped && error?.code !== 'SEARCH_DAEMON_NOT_READY') throw error;
      }
      index += 1;
      await delay(1);
    }
  })();

  try {
    await Promise.race([
      harness.waitForShutdown(),
      delay(1000).then(() => {
        throw new Error('idle timer did not fire while background embeds were running');
      }),
    ]);
    assert.equal(harness.ownerRemoved(), true);
    assert.ok(embedding.calls.length > 0);
  } finally {
    stopped = true;
    await background;
    await harness.close();
  }
});

test('daemon shutdown relinquishes its socket path before the slow teardown (idle-reboot race)', async () => {
  // Regression: idle shutdown used to unlink the socket files AFTER a slow embedScheduler.close().
  // A client call arriving during that window auto-boots a successor daemon that binds the same
  // socket path; the shutting-down daemon then unlinked the successor's live socket, surfacing as a
  // client `connect ENOENT` that never recovered before the ~30s ready deadline. The fix relinquishes
  // the socket path (close + unlink) and releases the owner slot BEFORE the slow teardown, and never
  // touches the path afterward.
  const root = tempRoot();
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
  const embedding = createEmbeddingPool({ gateDocuments: false });
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const closeEntered = deferred();
  const releaseClose = deferred();
  const realClose = scheduler.close.bind(scheduler);
  scheduler.close = async () => {
    closeEntered.resolve();
    await releaseClose.promise;
    return realClose();
  };

  const harness = createSearchDaemonIdleIsolationHarnessForTests({
    idleMs: 3_600_000, // do not auto-fire; trigger shutdown manually
    env,
    embedScheduler: scheduler,
  });
  // A daemon owns an actual socket file at this path; drain unlinks whatever is present exactly once.
  fs.writeFileSync(harness.socketPath, '');

  const shutdown = harness.close();
  await closeEntered.promise; // shutdown has reached the slow embedScheduler.close()

  // Before the slow close resolves, the socket files must already be gone and the owner released, so a
  // successor booting after removeOwner binds cleanly and its live socket is never deleted by us.
  assert.equal(fs.existsSync(harness.socketPath), false, 'socket unlinked before slow close');
  assert.equal(harness.ownerRemoved(), true, 'owner released before slow close');

  releaseClose.resolve();
  await shutdown;
});

function makeSpec() {
  return {
    specId: 'deterministic-spec',
    provider: 'deterministic-hash',
    model: 'same-model',
    dims: 3,
    normalization: 'l2',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeChunk(id, vector, spec) {
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

async function publishGeneration(pool, paths, spec, generationId, chunks) {
  const built = await pool.buildStagingGeneration({
    paths,
    spec,
    chunks,
    generationId,
  });
  await pool.promoteBuiltGeneration(paths, built.metadata);
}

function createFakeCoralFactory() {
  const chunksByGeneration = new Map();
  const calls = {
    create: [],
    close: [],
  };
  return {
    calls,
    factory: {
      async create(input) {
        calls.create.push({ ...input });
        const instance = {
          async initStore() {},
          async setActiveSpec() {},
          async upsertChunks(chunks) {
            chunksByGeneration.set(input.generationId, chunks);
          },
          async buildIndex() {},
          async searchVector(vector, candidateK) {
            return (chunksByGeneration.get(input.generationId) ?? [])
              .map((chunk) => ({
                chunkId: chunk.id,
                entryId: chunk.entryId,
                similarity: dot(Array.from(vector), Array.from(chunk.vector)),
              }))
              .sort((left, right) => right.similarity - left.similarity)
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
