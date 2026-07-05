import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EmbedScheduler,
  GPU_EMBEDDING_DEVICE_RETRY_TTL_MS,
  GpuEmbeddingDevice,
} from '../src/daemon/embed-scheduler.ts';
import { createVramProbe, VRAM_PROBE_TTL_MS } from '../src/daemon/model-session/vram-probe.ts';
import { residentModelKey } from '../src/daemon/model-session/provider-key.ts';
import { ProfileManager } from '../src/daemon/profile-manager.ts';
import { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } from '../src/daemon/runtime-profile.ts';
import { createDaemonSnapshotStore } from '../src/daemon/search-store/snapshot-store.ts';
import { buildEmbeddingSet } from '../src/core/search/dense/embedding-set.ts';
import { DeterministicHashProvider } from './helpers/deterministic-embedding.mjs';
import { activeRetrievalFromEdition, currentEdition } from './helpers/edition-ledger.mjs';

const EXECUTION_POLICY = { intraOpNumThreads: 1, interOpNumThreads: 1 };

function tempRoot(prefix = 'optsidian-model-encode-operational-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function localProvider(devicePolicy = 'auto') {
  return {
    kind: 'local-onnx',
    model: 'multilingual-e5-small',
    executionPolicy: EXECUTION_POLICY,
    devicePolicy,
  };
}

function context(id, options = {}) {
  return {
    deadline: Date.now() + (options.ms ?? 10_000),
    cancellationId: id,
    requestId: id,
    vault: options.vault ?? 'operational-vault',
  };
}

function payload(text, options = {}) {
  return {
    texts: [text],
    inputKind: options.inputKind ?? 'document',
    provider: localProvider(options.devicePolicy ?? 'auto'),
    profileHash: options.profileHash ?? 'profile-a',
    maxTokenBudget: options.maxTokenBudget ?? 128,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.equal(predicate(), true);
}

function encodeResult(input) {
  return {
    provider: {
      id: 'local-onnx',
      model: input.provider.model ?? 'multilingual-e5-small',
      dim: 2,
      version: '1',
    },
    vectors: input.texts.map((_text, index) => (index === 0 ? [1, 0] : [0, 1])),
    consumedCount: input.texts.length,
  };
}

function createGatedEmbedding() {
  const starts = [];
  const gates = [];
  let cancelCalls = 0;
  return {
    starts,
    get cancelCalls() {
      return cancelCalls;
    },
    releaseNext() {
      const gate = gates.shift();
      assert.ok(gate, 'expected an active gated encode');
      gate.resolve();
    },
    hasGpuSlot() {
      return true;
    },
    async encodeGpu(input, options) {
      starts.push({ path: 'gpu', vault: options.vault, text: input.texts[0], profileHash: input.profileHash });
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return encodeResult(input);
    },
    async encodeCpuFallback(input, options) {
      starts.push({ path: 'cpu', vault: options.vault, text: input.texts[0], profileHash: input.profileHash });
      return encodeResult(input);
    },
    async encode(input) {
      starts.push({ path: 'legacy', text: input.texts[0], profileHash: input.profileHash });
      return encodeResult(input);
    },
    cancel() {
      cancelCalls += 1;
    },
    stats() {
      return { starts: starts.length };
    },
  };
}

test('AC7 fair bulk queue alternates two vault/profile rebuild streams without weakening query priority', async () => {
  const embedding = createGatedEmbedding();
  const owner = new GpuEmbeddingDevice({ embedding, now: Date.now });

  const jobs = [
    owner.encodeBulk('rebuild', payload('a-0'), context('a-0', { vault: 'vault-a' })),
    owner.encodeBulk('rebuild', payload('a-1'), context('a-1', { vault: 'vault-a' })),
    owner.encodeBulk('rebuild', payload('a-2'), context('a-2', { vault: 'vault-a' })),
    owner.encodeBulk('rebuild', payload('b-0'), context('b-0', { vault: 'vault-b' })),
    owner.encodeBulk('rebuild', payload('b-1'), context('b-1', { vault: 'vault-b' })),
    owner.encodeBulk('rebuild', payload('b-2'), context('b-2', { vault: 'vault-b' })),
  ];

  await waitFor(() => embedding.starts.length === 1);
  assert.equal(owner.stats().bulk.queueDepth, 5);

  const query = owner.encodeQuery(payload('query', { inputKind: 'query' }), context('query', { vault: 'vault-a' }));
  embedding.releaseNext();
  await waitFor(() => embedding.starts.length === 2);
  assert.equal(embedding.starts[1].text, 'query');
  embedding.releaseNext();
  await query;

  await waitFor(() => embedding.starts.length === 3);
  while (embedding.starts.length < 7) {
    const expectedStarts = embedding.starts.length + 1;
    embedding.releaseNext();
    await waitFor(() => embedding.starts.length === expectedStarts);
  }
  embedding.releaseNext();
  await Promise.all(jobs);

  const bulkVaults = embedding.starts.filter((start) => start.text !== 'query').map((start) => start.vault);
  assert.deepEqual(bulkVaults, ['vault-a', 'vault-b', 'vault-a', 'vault-b', 'vault-a', 'vault-b']);
});

test('AC7 cancellation storm uses lazy owner tokens and compacts at dequeue', async () => {
  const embedding = createGatedEmbedding();
  const owner = new GpuEmbeddingDevice({ embedding, now: Date.now });
  const active = owner.encodeBulk('rebuild', payload('active'), context('active'));
  await waitFor(() => embedding.starts.length === 1);

  const queued = Array.from({ length: 64 }, (_value, index) => {
    const id = `queued-${index}`;
    return owner.encodeBulk('rebuild', payload(id), context(id));
  });
  await delay(20);
  assert.equal(owner.stats().bulk.queueDepth, 64);

  const originalSplice = Array.prototype.splice;
  let spliceCalls = 0;
  Array.prototype.splice = function patchedSplice(...args) {
    spliceCalls += 1;
    return originalSplice.apply(this, args);
  };
  try {
    for (let index = 0; index < queued.length; index += 1) owner.cancel(`queued-${index}`);
  } finally {
    Array.prototype.splice = originalSplice;
  }
  assert.equal(spliceCalls, 0);
  assert.equal(embedding.cancelCalls, 0, 'queued cancellations must not churn worker slots');

  embedding.releaseNext();
  await active;
  const settled = await Promise.allSettled(queued);
  assert.equal(
    settled.every((result) => result.status === 'rejected' && result.reason?.code === 'CANCELLED'),
    true,
  );
  assert.equal(owner.stats().bulk.queueDepth, 0);
});

test('AC7 CUDA failure falls back to CPU during retry window and retries on later demand', async () => {
  let nowMs = 1_000;
  const calls = [];
  let failGpu = true;
  const owner = new GpuEmbeddingDevice({
    now: () => nowMs,
    embedding: {
      hasGpuSlot: () => true,
      async encodeGpu(input) {
        calls.push(`gpu:${input.inputKind ?? 'document'}:${input.texts[0]}`);
        if (failGpu) throw Object.assign(new Error('CUDA reset'), { code: 'MODEL_DEVICE_UNAVAILABLE' });
        return encodeResult(input);
      },
      async encodeCpuFallback(input) {
        calls.push(`cpu:${input.inputKind ?? 'document'}:${input.texts[0]}`);
        return encodeResult(input);
      },
      async encode(input) {
        calls.push(`legacy:${input.inputKind ?? 'document'}:${input.texts[0]}`);
        return encodeResult(input);
      },
      cancel() {},
      stats() {
        return {};
      },
    },
  });

  await owner.encodeBulk('rebuild', payload('bulk-fails'), context('bulk-fails'));
  assert.deepEqual(calls, ['gpu:document:bulk-fails', 'cpu:document:bulk-fails']);
  assert.equal(owner.stats().gpuAvailable, false);
  assert.equal(owner.stats().retryAfterMs, GPU_EMBEDDING_DEVICE_RETRY_TTL_MS);

  await owner.encodeQuery(payload('query-fallback', { inputKind: 'query' }), context('query-fallback'));
  assert.equal(calls.at(-1), 'cpu:query:query-fallback');

  failGpu = false;
  nowMs += GPU_EMBEDDING_DEVICE_RETRY_TTL_MS;
  await owner.encodeQuery(payload('query-retry', { inputKind: 'query' }), context('query-retry'));
  assert.equal(calls.at(-1), 'gpu:query:query-retry');
  assert.equal(owner.stats().gpuAvailable, true);
});

test('AC6/AC7 profile status returns partial model status when a targeted worker probe wedges', async () => {
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
  const embedding = {
    hasGpuSlot() {
      return true;
    },
    async encode() {
      throw new Error('encode should not run during status');
    },
    async encodeGpu() {
      throw new Error('encode should not run during status');
    },
    async encodeCpuFallback() {
      throw new Error('encode should not run during status');
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return new Promise(() => {});
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { slots: [] };
    },
  };
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const manager = new ProfileManager(env, scheduler);
  const profile = effectiveSearchRuntimeProfile(process.cwd(), env);
  const profileHash = searchRuntimeProfileHash(profile);
  try {
    await manager.withRuntimeFor({ profile }, async () => {});
    const started = Date.now();
    const status = await manager.status({ deadline: Date.now() + 5_000, cancellationId: 'wedged-status' });
    assert.ok(Date.now() - started < 1_000, 'status must not wait for the full request deadline');
    assert.deepEqual(status[profileHash].model.query, {
      device: null,
      executionProvider: null,
      loaded: false,
      mode: 'shared',
      retryAfter: null,
    });
    assert.equal(status[profileHash].model.bulk.queueDepth, 0);
  } finally {
    await manager.close();
    await scheduler.close();
  }
});

test('AC7 restart leaves GPU owner state empty and rebuild republishes only a complete content-addressed generation', async () => {
  const root = tempRoot();
  const cacheRoot = path.join(root, 'cache');
  const vault = path.join(root, 'vault');
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nstable alpha project\n');
  writeVaultFile(vault, 'Beta.md', '# Beta\n\nstable beta project\n');

  let failDense = true;
  const provider = new DeterministicHashProvider();
  const embeddingSetBuilder = {
    providerIdentity: provider.identity,
    async build(input) {
      if (failDense) throw new Error('simulated dense build interruption');
      return buildEmbeddingSet({ provider, documents: input.documents });
    },
  };
  const options = {
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    embeddingSetBuilder,
  };
  const firstStore = createDaemonSnapshotStore(options);
  const firstResult = await firstStore.rebuild(vault, {
    deadline: Date.now() + 10_000,
    cancellationId: 'failed-rebuild',
  });
  const firstPaths = firstStore.paths(vault);
  const failedHead = currentEdition(firstPaths);
  assert.equal(typeof firstResult.snapshotId, 'string');
  assert.equal(failedHead.dense.state, 'failed');
  assert.throws(() => activeRetrievalFromEdition(firstPaths), /no fresh dense edition/);
  await firstStore.close();

  const restartedOwner = new GpuEmbeddingDevice({
    embedding: {
      hasGpuSlot: () => true,
      async encodeGpu(input) {
        return encodeResult(input);
      },
      async encodeCpuFallback(input) {
        return encodeResult(input);
      },
      async encode(input) {
        return encodeResult(input);
      },
      cancel() {},
      stats() {
        return {};
      },
    },
    now: Date.now,
  });
  assert.deepEqual(restartedOwner.stats().lanes, { query: 0, save: 0, refresh: 0, rebuild: 0 });
  assert.equal(restartedOwner.stats().runningLane, undefined);

  failDense = false;
  const secondStore = createDaemonSnapshotStore(options);
  const secondResult = await secondStore.rebuild(vault, {
    deadline: Date.now() + 10_000,
    cancellationId: 'resumed-rebuild',
  });
  const secondPaths = secondStore.paths(vault);
  const fresh = activeRetrievalFromEdition(secondPaths);
  assert.equal(secondResult.snapshotId, firstResult.snapshotId);
  assert.equal(currentEdition(secondPaths).dense.state, 'fresh');
  assert.equal(typeof fresh.vectorGenerationId, 'string');
  await secondStore.close();
});

test('AC7 VRAM probe timeout serves stale cache and parent admission/status stay independent', async () => {
  let nowMs = 1_000;
  let execCalls = 0;
  const probe = createVramProbe({
    platform: 'linux',
    now: () => nowMs,
    timeoutMs: 5,
    exec(_command, _args, options) {
      execCalls += 1;
      if (execCalls === 1) return '512\n';
      options.signal.addEventListener('abort', () => {}, { once: true });
      return new Promise(() => {});
    },
  });
  assert.equal((await probe()).freeBytes, 512 * 1024 * 1024);
  nowMs += VRAM_PROBE_TTL_MS;

  const scheduler = new EmbedScheduler({
    ownsEmbedding: false,
    embedding: {
      hasGpuSlot: () => true,
      async encodeGpu(input) {
        return encodeResult(input);
      },
      async encodeCpuFallback(input) {
        return encodeResult(input);
      },
      async encode(input) {
        return encodeResult(input);
      },
      async modelStats() {
        return { loaded: false };
      },
      async unload() {
        return { unloaded: true };
      },
      cancel() {},
      async close() {},
      stats() {
        return { slots: [] };
      },
    },
  });
  const encode = await scheduler.encode(payload('admission-independent'), context('admission-independent'), 'rebuild');
  const stale = await probe();
  assert.equal(encode.vectors.length, 1);
  assert.equal(stale.freeBytes, 512 * 1024 * 1024);
  assert.equal(stale.fresh, false);
  assert.match(stale.error, /timed out/);
  await scheduler.close();
});

test('AC6 no GPU slot routes through CPU fallback and fleet status reports CPU-only serving', async () => {
  const provider = localProvider('auto');
  const residentKey = residentModelKey(provider);
  const calls = [];
  const embedding = {
    hasGpuSlot: () => false,
    async encodeGpu() {
      throw new Error('GPU path must not run without a GPU slot');
    },
    async encodeCpuFallback(input) {
      calls.push(`cpu:${input.inputKind ?? 'document'}:${input.texts[0]}`);
      return encodeResult(input);
    },
    async encode(input) {
      calls.push(`legacy:${input.inputKind ?? 'document'}:${input.texts[0]}`);
      return encodeResult(input);
    },
    async modelStats() {
      return {
        loaded: true,
        residentModelKey: residentKey,
        device: 'cpu',
        executionProvider: 'cpu',
      };
    },
    async unload() {
      return { unloaded: true };
    },
    cancel() {},
    async close() {},
    stats() {
      return { slots: [{ slotDevice: { kind: 'cpu' }, busy: false }] };
    },
  };
  const scheduler = new EmbedScheduler({
    embedding,
    ownsEmbedding: false,
    onnxExecutionPolicy: EXECUTION_POLICY,
  });
  await scheduler.encode(payload('cpu-only-query', { inputKind: 'query' }), context('cpu-only-query'), 'query');

  const root = tempRoot();
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_EMBEDDING_MODEL: 'multilingual-e5-small',
    OPTSIDIAN_SEARCH_MODEL_DEVICE: 'auto',
  };
  const manager = new ProfileManager(env, scheduler);
  const profile = effectiveSearchRuntimeProfile(process.cwd(), env);
  const profileHash = searchRuntimeProfileHash(profile);
  try {
    await manager.withRuntimeFor({ profile }, async () => {});
    const status = await manager.status({ deadline: Date.now() + 1000, cancellationId: 'cpu-only-status' });
    assert.deepEqual(calls, ['cpu:query:cpu-only-query']);
    assert.deepEqual(status[profileHash].model.query, {
      device: 'cpu',
      executionProvider: 'cpu',
      loaded: true,
      mode: 'shared',
      retryAfter: null,
    });
    assert.deepEqual(status[profileHash].model.bulk.devices, [
      { deviceId: 'cpu', executionProvider: 'cpu', busy: false, docsPerSec: 0 },
    ]);
  } finally {
    await manager.close();
    await scheduler.close();
  }
});

test('AC6 fallback status exposes retryAfter and CPU query lane while GPU owner is unavailable', async () => {
  const nowMs = 20_000;
  const provider = localProvider('auto');
  const residentKey = residentModelKey(provider);
  const embedding = {
    hasGpuSlot: () => true,
    async encodeGpu() {
      throw Object.assign(new Error('CUDA OOM'), { code: 'MODEL_DEVICE_UNAVAILABLE' });
    },
    async encodeCpuFallback(input) {
      return encodeResult(input);
    },
    async encode(input) {
      return encodeResult(input);
    },
    async modelStats() {
      return {
        loaded: true,
        residentModelKey: residentKey,
        device: 'cpu',
        executionProvider: 'cpu',
      };
    },
    async unload() {
      return { unloaded: true };
    },
    cancel() {},
    async close() {},
    stats() {
      return {
        slots: [
          { slotDevice: { kind: 'cuda', deviceId: 0 }, busy: false },
          { slotDevice: { kind: 'cpu' }, busy: false },
        ],
      };
    },
  };
  const scheduler = new EmbedScheduler({
    embedding,
    ownsEmbedding: false,
    now: () => nowMs,
    onnxExecutionPolicy: EXECUTION_POLICY,
  });
  await scheduler.encode(payload('trigger-fallback'), {
    deadline: nowMs + 10_000,
    cancellationId: 'trigger-fallback',
    requestId: 'trigger-fallback',
    vault: 'fallback-vault',
  });

  const root = tempRoot();
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_EMBEDDING_MODEL: 'multilingual-e5-small',
    OPTSIDIAN_SEARCH_MODEL_DEVICE: 'auto',
  };
  const manager = new ProfileManager(env, scheduler);
  const profile = effectiveSearchRuntimeProfile(process.cwd(), env);
  const profileHash = searchRuntimeProfileHash(profile);
  try {
    await manager.withRuntimeFor({ profile }, async () => {});
    const status = await manager.status({ deadline: Date.now() + 1000, cancellationId: 'fallback-status' });
    assert.deepEqual(status[profileHash].model.query, {
      device: 'cpu',
      executionProvider: 'cpu',
      loaded: true,
      mode: 'shared',
      retryAfter: GPU_EMBEDDING_DEVICE_RETRY_TTL_MS,
    });
    assert.deepEqual(
      status[profileHash].model.bulk.devices.map((device) => ({
        deviceId: device.deviceId,
        executionProvider: device.executionProvider,
      })),
      [
        { deviceId: 'cpu', executionProvider: 'cpu' },
        { deviceId: 'cuda:0', executionProvider: 'cuda' },
      ],
    );
  } finally {
    await manager.close();
    await scheduler.close();
  }
});
