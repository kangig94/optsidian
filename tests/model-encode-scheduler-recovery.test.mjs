import assert from 'node:assert/strict';
import test from 'node:test';

import { GPU_EMBEDDING_DEVICE_RETRY_TTL_MS, GpuEmbeddingDevice } from '../src/daemon/embed-scheduler.ts';

const EXECUTION_POLICY = { intraOpNumThreads: 1, interOpNumThreads: 1 };

function localProvider(devicePolicy = 'auto') {
  return {
    kind: 'local-onnx',
    model: 'multilingual-e5-small',
    executionPolicy: EXECUTION_POLICY,
    devicePolicy,
  };
}

function context(now, id, ms = 10_000) {
  return {
    deadline: now() + ms,
    cancellationId: id,
    requestId: id,
    vault: 'model-encode-scheduler-recovery-test-vault',
  };
}

function payload(text, inputKind, devicePolicy = 'auto') {
  return {
    texts: [text],
    inputKind,
    provider: localProvider(devicePolicy),
  };
}

function createClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

function createRecordingEmbedding() {
  const calls = [];
  let failGpu = false;
  const gpuSessionId = 'shared-gpu-session';
  return {
    calls,
    setFailGpu(value) {
      failGpu = value;
    },
    hasGpuSlot() {
      return true;
    },
    async encodeGpu(input) {
      calls.push({
        path: 'gpu',
        sessionId: gpuSessionId,
        inputKind: input.inputKind ?? 'document',
        texts: [...input.texts],
      });
      if (failGpu) {
        throw Object.assign(new Error('CUDA device unavailable'), { code: 'MODEL_DEVICE_UNAVAILABLE' });
      }
      return encodeResult(input);
    },
    async encodeCpuFallback(input) {
      calls.push({
        path: 'cpu',
        sessionId: 'cpu-fallback-session',
        inputKind: input.inputKind ?? 'document',
        texts: [...input.texts],
      });
      return encodeResult(input);
    },
    async encode(input) {
      calls.push({
        path: 'legacy',
        sessionId: 'legacy-session',
        inputKind: input.inputKind ?? 'document',
        texts: [...input.texts],
      });
      return encodeResult(input);
    },
    cancel() {},
    stats() {
      return { calls: calls.length };
    },
  };
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
  };
}

test('AC4 reserved query seam defaults to shared and accepts explicit shared mode', () => {
  const clock = createClock();
  const defaultOwner = new GpuEmbeddingDevice({
    embedding: createRecordingEmbedding(),
    now: clock.now,
  });
  const explicitOwner = new GpuEmbeddingDevice({
    embedding: createRecordingEmbedding(),
    now: clock.now,
    queryMode: 'shared',
  });

  assert.equal(defaultOwner.stats().queryMode, 'shared');
  assert.equal(explicitOwner.stats().queryMode, 'shared');
});

test('AC4 shared query mode serves query and bulk on one GPU path', async () => {
  const clock = createClock();
  const embedding = createRecordingEmbedding();
  const owner = new GpuEmbeddingDevice({
    embedding,
    now: clock.now,
    queryMode: 'shared',
  });

  await owner.encodeQuery(payload('interactive query', 'query'), context(clock.now, 'shared-query'));
  await owner.encodeBulk('rebuild', payload('bulk document', 'document'), context(clock.now, 'shared-bulk'));

  assert.deepEqual(
    embedding.calls.map((call) => `${call.path}:${call.inputKind}`),
    ['gpu:query', 'gpu:document'],
  );
  assert.deepEqual([...new Set(embedding.calls.map((call) => call.sessionId))], ['shared-gpu-session']);
});

test('AC4 auto policy uses CPU fallback during the GPU retry TTL window', async () => {
  const clock = createClock();
  const embedding = createRecordingEmbedding();
  const owner = new GpuEmbeddingDevice({ embedding, now: clock.now });

  embedding.setFailGpu(true);
  await owner.encodeBulk('rebuild', payload('failed bulk', 'document'), context(clock.now, 'failed-bulk'));
  await Promise.resolve();

  assert.deepEqual(
    embedding.calls.map((call) => `${call.path}:${call.inputKind}`),
    ['gpu:document', 'cpu:document'],
  );
  assert.deepEqual(owner.stats(), {
    runningLane: undefined,
    lanes: { query: 0, save: 0, refresh: 0, rebuild: 0 },
    activeLaneCounts: { query: 0, save: 0, refresh: 0, rebuild: 0 },
    gpuAvailable: false,
    queryMode: 'shared',
    gpuRetryAtMs: 1_000 + GPU_EMBEDDING_DEVICE_RETRY_TTL_MS,
    retryAfterMs: GPU_EMBEDDING_DEVICE_RETRY_TTL_MS,
    bulk: {
      devices: [
        { kind: 'gpu', deviceId: 'gpu', busy: false, docsPerSec: 0 },
        { kind: 'cpu', deviceId: 'cpu', executionProvider: 'cpu', busy: false, docsPerSec: 1000 },
      ],
      queueDepth: 0,
      inFlight: 0,
      queuedDocs: 0,
    },
  });

  await owner.encodeQuery(payload('fallback query', 'query'), context(clock.now, 'fallback-query'));

  assert.deepEqual(
    embedding.calls.map((call) => `${call.path}:${call.inputKind}`),
    ['gpu:document', 'cpu:document', 'cpu:query'],
  );
});

test('AC4 auto policy retries GPU on demand after retry TTL and clears the latch on success', async () => {
  const clock = createClock();
  const embedding = createRecordingEmbedding();
  const owner = new GpuEmbeddingDevice({ embedding, now: clock.now });

  embedding.setFailGpu(true);
  await owner.encodeQuery(payload('initial query', 'query'), context(clock.now, 'initial-query'));
  clock.advance(GPU_EMBEDDING_DEVICE_RETRY_TTL_MS - 1);
  await owner.encodeQuery(payload('ttl-window query', 'query'), context(clock.now, 'ttl-window-query'));

  embedding.setFailGpu(false);
  clock.advance(1);
  await owner.encodeQuery(payload('recovered query', 'query'), context(clock.now, 'recovered-query'));
  await owner.encodeQuery(payload('subsequent query', 'query'), context(clock.now, 'subsequent-query'));

  assert.deepEqual(
    embedding.calls.map((call) => `${call.path}:${call.inputKind}`),
    ['gpu:query', 'cpu:query', 'cpu:query', 'gpu:query', 'gpu:query'],
  );
  assert.equal(owner.stats().gpuAvailable, true);
  assert.equal(owner.stats().gpuRetryAtMs, undefined);
  assert.equal(owner.stats().retryAfterMs, undefined);
});

test('AC4 gpu policy never falls back to CPU on GPU device failure', async () => {
  const clock = createClock();
  const embedding = createRecordingEmbedding();
  const owner = new GpuEmbeddingDevice({ embedding, now: clock.now });

  embedding.setFailGpu(true);
  await assert.rejects(
    owner.encodeQuery(payload('forced gpu query', 'query', 'gpu'), context(clock.now, 'forced-gpu-query')),
    (error) => error?.code === 'MODEL_DEVICE_UNAVAILABLE',
  );

  assert.deepEqual(
    embedding.calls.map((call) => `${call.path}:${call.inputKind}`),
    ['gpu:query'],
  );
});
