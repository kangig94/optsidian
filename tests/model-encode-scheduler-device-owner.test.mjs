import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EmbedScheduler } from '../src/daemon/embed-scheduler.ts';
import { EmbeddingWorkerPool } from '../src/daemon/pools.ts';
import { DaemonWorkerPool } from '../src/daemon/worker-pool.ts';
import { workerEntryDeviceLoadForTests } from '../src/daemon/worker-entry.ts';
import { createOnnxSessionWithFallback, localOnnxSessionCacheKey } from '../src/core/search/dense/local-onnx.ts';

const EXECUTION_POLICY = { intraOpNumThreads: 1, interOpNumThreads: 1 };

function localProvider(devicePolicy = 'auto') {
  return {
    kind: 'local-onnx',
    model: 'multilingual-e5-small',
    executionPolicy: EXECUTION_POLICY,
    devicePolicy,
  };
}

function context(id, ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: id,
    requestId: id,
    vault: 'device-owner-test-vault',
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

function unitVector(dim, index) {
  const vector = new Array(dim).fill(0);
  vector[index % dim] = 1;
  return vector;
}

function createRecordingEmbedding(options = {}) {
  const calls = [];
  const gpuDocumentGates = [];
  let failGpu = false;
  return {
    calls,
    setFailGpu(value) {
      failGpu = value;
    },
    releaseNextGpuDocument() {
      const gate = gpuDocumentGates.shift();
      assert.ok(gate, 'expected a gated GPU document encode');
      gate.resolve();
    },
    releaseAllGpuDocuments() {
      while (gpuDocumentGates.length > 0) gpuDocumentGates.shift().resolve();
    },
    hasGpuSlot() {
      return true;
    },
    async encodeGpu(payload) {
      const call = {
        device: 'gpu',
        inputKind: payload.inputKind ?? 'document',
        texts: [...payload.texts],
      };
      calls.push(call);
      if (failGpu) {
        throw Object.assign(new Error('CUDA device unavailable'), { code: 'MODEL_DEVICE_UNAVAILABLE' });
      }
      if (options.gateGpuDocuments !== false && call.inputKind === 'document') {
        const gate = deferred();
        gpuDocumentGates.push(gate);
        await gate.promise;
      }
      return encodeResult(payload);
    },
    async encodeCpuFallback(payload) {
      calls.push({
        device: 'cpu',
        inputKind: payload.inputKind ?? 'document',
        texts: [...payload.texts],
      });
      return encodeResult(payload);
    },
    async encode(payload) {
      calls.push({
        device: 'legacy',
        inputKind: payload.inputKind ?? 'document',
        texts: [...payload.texts],
      });
      return encodeResult(payload);
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return { loaded: calls.length > 0 };
    },
    cancel() {},
    async close() {},
    stats() {
      return { calls: calls.length };
    },
  };
}

function encodeResult(payload) {
  const dim = 4;
  return {
    provider: {
      id: 'local-onnx',
      model: payload.provider.model ?? 'multilingual-e5-small',
      dim,
      version: '1',
    },
    vectors: payload.texts.map((_text, index) => unitVector(dim, index)),
  };
}

test('AC1 queued query obtains GPU service before the next bulk unit', async () => {
  const embedding = createRecordingEmbedding();
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = localProvider();
  let completedBulkUnits = 0;
  const rebuild = scheduler.withLaneScope('rebuild', async () => {
    for (let index = 0; index < 3; index += 1) {
      await scheduler.encode(
        { texts: [`bulk-${index}`], inputKind: 'document', provider },
        context(`bulk-${index}`),
        'rebuild',
      );
      completedBulkUnits += 1;
    }
  });

  await waitFor(() => embedding.calls.length === 1);
  assert.deepEqual(
    embedding.calls.map((call) => `${call.device}:${call.inputKind}`),
    ['gpu:document'],
  );

  const query = scheduler.encode(
    { texts: ['interactive query'], inputKind: 'query', provider },
    context('query'),
    'query',
  );
  embedding.releaseNextGpuDocument();
  await query;

  assert.equal(completedBulkUnits, 1);
  assert.equal(embedding.calls[1].device, 'gpu');
  assert.equal(embedding.calls[1].inputKind, 'query');

  await waitFor(() => embedding.calls.length === 3);
  embedding.releaseNextGpuDocument();
  await waitFor(() => embedding.calls.length === 4);
  embedding.releaseNextGpuDocument();
  await rebuild;
  assert.deepEqual(
    embedding.calls.map((call) => `${call.device}:${call.inputKind}`),
    ['gpu:document', 'gpu:query', 'gpu:document', 'gpu:document'],
  );
  await scheduler.close();
});

test('AC1 cancelled and deadlined query waiters do not strand the turnstile', async () => {
  const embedding = createRecordingEmbedding();
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = localProvider();

  const deadlineRebuild = scheduler.withLaneScope('rebuild', async () => {
    for (let index = 0; index < 2; index += 1) {
      await scheduler.encode(
        { texts: [`deadline-bulk-${index}`], inputKind: 'document', provider },
        context(`deadline-bulk-${index}`),
        'rebuild',
      );
    }
  });
  await waitFor(() => embedding.calls.length === 1);
  await assert.rejects(
    scheduler.encode(
      { texts: ['deadline query'], inputKind: 'query', provider },
      context('deadline-query', 20),
      'query',
    ),
    (error) => error?.code === 'DEADLINE_EXCEEDED',
  );
  embedding.releaseNextGpuDocument();
  await waitFor(() => embedding.calls.length === 2);
  assert.equal(embedding.calls[1].inputKind, 'document');
  embedding.releaseNextGpuDocument();
  await deadlineRebuild;

  const cancelRebuild = scheduler.withLaneScope('rebuild', async () => {
    for (let index = 0; index < 2; index += 1) {
      await scheduler.encode(
        { texts: [`cancel-bulk-${index}`], inputKind: 'document', provider },
        context(`cancel-bulk-${index}`),
        'rebuild',
      );
    }
  });
  await waitFor(() => embedding.calls.length === 3);
  const cancelledQuery = scheduler.encode(
    { texts: ['cancelled query'], inputKind: 'query', provider },
    context('cancelled-query'),
    'query',
  );
  scheduler.cancel('cancelled-query');
  await assert.rejects(cancelledQuery, (error) => error?.code === 'CANCELLED');
  embedding.releaseNextGpuDocument();
  await waitFor(() => embedding.calls.length === 4);
  assert.equal(embedding.calls[3].inputKind, 'document');
  embedding.releaseNextGpuDocument();
  await cancelRebuild;
  await scheduler.close();
});

test('AC1 CPU bulk is fallback-only while GPU owner health controls routing', async () => {
  const embedding = createRecordingEmbedding({ gateGpuDocuments: false });
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const provider = localProvider();

  await scheduler.encode(
    { texts: ['healthy bulk'], inputKind: 'document', provider },
    context('healthy-bulk'),
    'rebuild',
  );
  assert.deepEqual(
    embedding.calls.map((call) => `${call.device}:${call.inputKind}`),
    ['gpu:document'],
  );

  embedding.setFailGpu(true);
  await scheduler.encode(
    { texts: ['fallback bulk'], inputKind: 'document', provider },
    context('fallback-bulk'),
    'rebuild',
  );
  assert.deepEqual(
    embedding.calls.map((call) => `${call.device}:${call.inputKind}`),
    ['gpu:document', 'gpu:document', 'cpu:document'],
  );

  await scheduler.encode(
    { texts: ['owner unavailable bulk'], inputKind: 'document', provider },
    context('owner-unavailable-bulk'),
    'rebuild',
  );
  assert.deepEqual(
    embedding.calls.map((call) => `${call.device}:${call.inputKind}`),
    ['gpu:document', 'gpu:document', 'cpu:document', 'cpu:document'],
  );
  await scheduler.close();
});

test('AC2 slot dispatch carries tagged device and ORT receives CUDA deviceId', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-device-owner-slots-'));
  const workerScript = path.join(root, 'slot-worker.cjs');
  fs.writeFileSync(
    workerScript,
    [
      "const { parentPort, workerData } = require('node:worker_threads');",
      "parentPort.on('message', (message) => {",
      '  const memory = process.memoryUsage();',
      '  parentPort.postMessage({',
      '    id: message.id,',
      '    ok: true,',
      '    result: { slotIndex: workerData.slotIndex, slotDevice: workerData.slotDevice, request: message.request },',
      '    memory,',
      '    memoryRss: memory.rss,',
      '  });',
      '});',
    ].join('\n'),
  );
  const pool = new DaemonWorkerPool({
    name: 'device-owner-slot-test',
    kind: 'embedding',
    size: 2,
    workerScript,
    autoWarmup: false,
    slotDevices: [{ kind: 'cuda', deviceId: 7 }, { kind: 'cpu' }],
  });
  try {
    const gpu = await pool.runOnSlotIndex({ type: 'slotEcho' }, context('slot-gpu'), 0);
    const cpu = await pool.runOnSlotIndex({ type: 'slotEcho' }, context('slot-cpu'), 1);
    assert.deepEqual(gpu.slotDevice, { kind: 'cuda', deviceId: 7 });
    assert.equal(gpu.slotIndex, 0);
    assert.deepEqual(cpu.slotDevice, { kind: 'cpu' });
    assert.equal(cpu.slotIndex, 1);
  } finally {
    await pool.close();
  }

  const createOptions = [];
  const ort = mockOrt((options) => createOptions.push(options));
  await createOnnxSessionWithFallback({
    ort,
    modelPath: '/tmp/model.onnx',
    executionProvider: 'cuda',
    cudaDeviceId: 7,
    allowCpuFallback: false,
    platform: 'linux',
  });
  await createOnnxSessionWithFallback({
    ort,
    modelPath: '/tmp/model.onnx',
    executionProvider: 'cpu',
    cudaDeviceId: 7,
    allowCpuFallback: false,
    platform: 'linux',
  });

  assert.deepEqual(createOptions[0].executionProviders, [{ name: 'cuda', deviceId: 7 }]);
  assert.deepEqual(createOptions[1].executionProviders, ['cpu']);
});

test('worker-entry device-load path maps embedding slot devices to resolved load policy', () => {
  const provider = localProvider();
  assert.deepEqual(workerEntryDeviceLoadForTests(provider, { kind: 'cpu' }), {
    policy: { mode: 'cpu' },
    executionProvider: 'cpu',
  });
  assert.deepEqual(workerEntryDeviceLoadForTests(provider, { kind: 'cuda', deviceId: 7 }), {
    policy: { mode: 'gpu' },
    executionProvider: 'cuda',
    deviceId: 7,
  });
  assert.deepEqual(workerEntryDeviceLoadForTests(provider, { kind: 'coreml' }), {
    policy: { mode: 'gpu' },
    executionProvider: 'coreml',
  });
});

test('EmbeddingWorkerPool modelStats targets the CPU fallback slot while fallback is serving', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-device-owner-stats-slot-'));
  const workerScript = path.join(root, 'stats-slot-worker.cjs');
  fs.writeFileSync(
    workerScript,
    [
      "const { parentPort, workerData } = require('node:worker_threads');",
      'let loaded = false;',
      "const executionProvider = workerData.slotDevice.kind === 'cuda' ? 'cuda' : workerData.slotDevice.kind;",
      "const device = workerData.slotDevice.kind === 'cpu' ? 'cpu' : 'gpu';",
      "parentPort.on('message', (message) => {",
      '  const memory = process.memoryUsage();',
      "  if (message.request.type === 'warmup') {",
      '    parentPort.postMessage({ id: message.id, ok: true, result: { ready: true }, memory, memoryRss: memory.rss });',
      '    return;',
      '  }',
      "  if (message.request.type === 'modelEncode') {",
      '    loaded = true;',
      '    parentPort.postMessage({',
      '      id: message.id,',
      '      ok: true,',
      "      result: { provider: { id: 'local-onnx', model: 'multilingual-e5-small', dim: 2, version: '1' }, vectors: [[1, 0]] },",
      '      memory,',
      '      memoryRss: memory.rss,',
      '    });',
      '    return;',
      '  }',
      "  if (message.request.type === 'modelStats') {",
      '    parentPort.postMessage({',
      '      id: message.id,',
      '      ok: true,',
      '      result: { loaded, device, executionProvider, slotIndex: workerData.slotIndex },',
      '      memory,',
      '      memoryRss: memory.rss,',
      '    });',
      '  }',
      '});',
    ].join('\n'),
  );
  const workerPool = new DaemonWorkerPool({
    name: 'device-owner-stats-slot-test',
    kind: 'embedding',
    size: 2,
    workerScript,
    autoWarmup: false,
    slotDevices: [{ kind: 'cuda', deviceId: 0 }, { kind: 'cpu' }],
  });
  const embedding = new EmbeddingWorkerPool(workerPool, {
    gpuSlotIndex: 0,
    cpuFallbackSlotIndex: 1,
    slotCount: 2,
  });
  try {
    await embedding.encodeCpuFallback(
      { texts: ['fallback'], inputKind: 'document', provider: localProvider() },
      context('stats-slot-encode'),
    );
    const stats = await embedding.modelStats(context('stats-slot-status'));
    assert.equal(stats.loaded, true);
    assert.equal(stats.device, 'cpu');
    assert.equal(stats.executionProvider, 'cpu');
    assert.equal(stats.slotIndex, 1);
  } finally {
    await embedding.close();
  }
});

test('AC2 two CUDA device ids do not share a local ONNX session cache key', () => {
  const base = {
    modelPath: '/tmp/model.onnx',
    executionProvider: 'cuda',
    allowCpuFallback: false,
    executionPolicy: EXECUTION_POLICY,
  };
  assert.notEqual(
    localOnnxSessionCacheKey({ ...base, cudaDeviceId: 0 }),
    localOnnxSessionCacheKey({ ...base, cudaDeviceId: 1 }),
  );
  assert.equal(
    localOnnxSessionCacheKey({ ...base, executionProvider: 'cpu', cudaDeviceId: 0 }),
    localOnnxSessionCacheKey({ ...base, executionProvider: 'cpu', cudaDeviceId: 1 }),
  );
});

function mockOrt(onCreate) {
  return {
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: {
      async create(_modelPath, options) {
        onCreate(options);
        return {
          inputNames: ['input_ids', 'attention_mask'],
          outputNames: ['last_hidden_state'],
          async run() {
            return {
              last_hidden_state: {
                data: new Float32Array([1, 0, 0, 0]),
                dims: [1, 1, 4],
              },
            };
          },
          release() {},
        };
      },
    },
  };
}
