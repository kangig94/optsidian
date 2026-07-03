import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Attempt,
  AttemptCancelledError,
  AttemptSupersededError,
  isCurrentWriterToken,
} from '../src/core/lifecycle/conditional-commit.ts';
import { createProcessToken } from '../src/core/lifecycle/process-token.ts';
import { KiwiAnalyzerManager, KiwiAnalyzerTerminalLoadError } from '../src/core/kiwi/manager.ts';
import { ModelSessionLifecycle } from '../src/daemon/model-session/lifecycle.ts';

test('ConditionalCommit writer fence accepts only the current writer token', async () => {
  const processToken = createProcessToken();
  const writerA = { epoch: 1, incarnationId: 'incarnation-a', claimId: 'claim-a', processToken };
  const writerB = { epoch: 1, incarnationId: 'incarnation-b', claimId: 'claim-b', processToken };
  let current = writerA;
  const provider = {
    currentWriterToken() {
      return current;
    },
  };
  const fakeCommit = async (writerToken) => {
    if (!(await isCurrentWriterToken(provider, writerToken))) {
      return { ok: false, reason: 'not-current' };
    }
    return { ok: true, value: 'committed' };
  };

  assert.equal(await isCurrentWriterToken(provider, writerA), true);
  assert.deepEqual(await fakeCommit(writerA), { ok: true, value: 'committed' });

  current = writerB;
  assert.equal(await isCurrentWriterToken(provider, writerA), false);
  assert.deepEqual(await fakeCommit(writerA), { ok: false, reason: 'not-current' });
  assert.deepEqual(await fakeCommit(writerB), { ok: true, value: 'committed' });
});

test('Attempt aborts only when the last waiter leaves', async () => {
  const owner = { current: undefined };
  let producerSignal;
  const attempt = Attempt.start(owner, (signal) => {
    producerSignal = signal;
    return new Promise(() => undefined);
  });
  const waiterA = attempt.join();
  const waiterB = attempt.join();

  assert.equal(attempt.waiterCount, 2);
  assert.equal(producerSignal.aborted, false);

  assert.equal(waiterA.leave(), true);
  await assert.rejects(waiterA.promise, (error) => error instanceof AttemptCancelledError);
  assert.equal(attempt.waiterCount, 1);
  assert.equal(producerSignal.aborted, false);

  assert.equal(waiterB.leave(), true);
  await assert.rejects(waiterB.promise, (error) => error instanceof AttemptCancelledError);
  assert.equal(attempt.waiterCount, 0);
  assert.equal(producerSignal.aborted, true);
});

test('cancelled and superseded attempts close produced values and never install', async () => {
  const owner = { current: undefined };
  const installed = [];
  const closed = [];

  const cancelledValue = deferred();
  const cancelled = Attempt.start(owner, () => cancelledValue.promise, {
    install(value) {
      installed.push(value.id);
    },
    close(value) {
      closed.push(value.id);
    },
  });
  const cancelledWaiter = cancelled.join();
  cancelledWaiter.leave();
  await assert.rejects(cancelledWaiter.promise, (error) => error instanceof AttemptCancelledError);
  cancelledValue.resolve({ id: 'cancelled' });
  await flushMicrotasks();
  assert.equal(cancelled.isInstalled, false);

  const staleValue = deferred();
  const stale = Attempt.start(owner, () => staleValue.promise, {
    install(value) {
      installed.push(value.id);
    },
    close(value) {
      closed.push(value.id);
    },
  });
  const staleWaiter = stale.join();

  const currentValue = deferred();
  const current = Attempt.start(owner, () => currentValue.promise, {
    install(value) {
      installed.push(value.id);
    },
    close(value) {
      closed.push(value.id);
    },
  });
  const currentWaiter = current.join();

  staleValue.resolve({ id: 'stale' });
  await assert.rejects(staleWaiter.promise, (error) => error instanceof AttemptSupersededError);
  currentValue.resolve({ id: 'current' });
  assert.deepEqual(await currentWaiter.promise, { id: 'current' });

  assert.deepEqual(installed, ['current']);
  assert.deepEqual(closed.sort(), ['cancelled', 'stale']);
  assert.equal(stale.isInstalled, false);
  assert.equal(current.isInstalled, true);
});

test('AC10 ModelSessionLifecycle closes a cancelled load and cannot resurrect it', async () => {
  const firstGate = deferred();
  const sessions = [];
  const terminated = [];
  let loadCalls = 0;
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 0,
    probeVram: () => ({ freeBytes: 0 }),
    loadSession: async (device) => {
      loadCalls += 1;
      const session = fakeModelSession(device, `session-${loadCalls}`);
      sessions.push(session);
      if (loadCalls === 1) await firstGate.promise;
      return session;
    },
    terminateLoad: (device, reason) => terminated.push([device, reason]),
    idleMs: 1000,
  });
  const controller = new AbortController();
  const first = lifecycle.encode(['first'], {
    deadline: Date.now() + 1000,
    origin: 'query-text',
    signal: controller.signal,
  });
  await waitFor(() => loadCalls === 1);
  controller.abort();
  await assert.rejects(first, /aborted/);

  const second = await lifecycle.encode(['second'], {
    deadline: Date.now() + 1000,
    origin: 'query-text',
  });
  assert.deepEqual(second, [[6, 2]]);
  assert.equal(lifecycle.stats().loaded, true);

  firstGate.resolve();
  await flushMicrotasks();
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions[1].closed, false);
  assert.deepEqual(terminated, [['cpu', 'abort']]);
  await lifecycle.unload();
});

test('AC10 ModelSessionLifecycle aborts a shared load only after the last waiter leaves', async () => {
  const gate = deferred();
  const terminated = [];
  let producerSignal;
  let loadCalls = 0;
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 0,
    probeVram: () => ({ freeBytes: 0 }),
    loadSession: async (device, options) => {
      loadCalls += 1;
      producerSignal = options.signal;
      await gate.promise;
      return fakeModelSession(device, 'shared');
    },
    terminateLoad: (device, reason) => terminated.push([device, reason]),
    idleMs: 1000,
  });

  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const requestA = lifecycle.encode(['a'], {
    deadline: Date.now() + 1000,
    origin: 'query-text',
    signal: controllerA.signal,
  });
  const requestB = lifecycle.encode(['b'], {
    deadline: Date.now() + 1000,
    origin: 'query-text',
    signal: controllerB.signal,
  });
  await waitFor(() => loadCalls === 1);

  controllerA.abort();
  await assert.rejects(requestA, /aborted/);
  assert.equal(producerSignal.aborted, false);
  assert.deepEqual(terminated, []);

  controllerB.abort();
  await assert.rejects(requestB, /aborted/);
  assert.equal(producerSignal.aborted, true);
  assert.deepEqual(terminated, [['cpu', 'abort']]);

  gate.resolve();
  await flushMicrotasks();
  assert.equal(lifecycle.stats().loaded, false);
});

test('AC10 Kiwi manager closes late analyzers from a load superseded by close', async () => {
  const gate = deferred();
  const disposals = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: installedKiwiModelState,
    inspectWasmArtifact: installedKiwiWasmState,
    loadAnalyzer: async () => {
      await gate.promise;
      return fakeKiwiAnalyzer('late', disposals);
    },
  });

  const lease = manager.withAnalyzerLease(
    { XDG_CACHE_HOME: '/tmp/kiwi-close-during-load' },
    ['ko'],
    { wait: true, installIfMissing: true },
    ({ analyzer }) => analyzer.tokens('text'),
  );
  await flushMicrotasks();
  await manager.close();
  gate.resolve();

  await assert.rejects(lease, (error) => error instanceof AttemptSupersededError);
  assert.deepEqual(disposals, ['late']);
  assert.equal(manager.currentAnalyzer(), null);
});

test('AC11 Kiwi manager throws on failed load and retries instead of serving degraded', async () => {
  let attempts = 0;
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: installedKiwiModelState,
    inspectWasmArtifact: installedKiwiWasmState,
    loadAnalyzer: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated kiwi load failure');
      return fakeKiwiAnalyzer('retry', []);
    },
  });

  try {
    await assert.rejects(
      () =>
        manager.withAnalyzerLease(
          { XDG_CACHE_HOME: '/tmp/kiwi-retry-after-failure' },
          ['ko'],
          { wait: true, installIfMissing: true },
          ({ analyzer }) => analyzer.tokens('first'),
        ),
      KiwiAnalyzerTerminalLoadError,
    );
    assert.equal(manager.status({ XDG_CACHE_HOME: '/tmp/kiwi-retry-after-failure' }).state, 'unloaded');

    const result = await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: '/tmp/kiwi-retry-after-failure' },
      ['ko'],
      { wait: true, installIfMissing: true },
      ({ analyzer, activeAnalyzers }) => ({
        tokens: analyzer.tokens('second'),
        activeAnalyzers,
      }),
    );
    assert.deepEqual(result, {
      tokens: ['retry:second'],
      activeAnalyzers: ['ko'],
    });
    assert.equal(attempts, 2);
  } finally {
    await manager.close();
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeModelSession(device, id) {
  return {
    device,
    closed: false,
    async encode(texts) {
      return texts.map((text) => [text.length, id === 'session-2' ? 2 : 1]);
    },
    async close() {
      this.closed = true;
    },
  };
}

function fakeKiwiAnalyzer(id, disposals) {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: id,
      modelType: 'cong-global',
    },
    tokens: (text) => [`${id}:${text}`],
    dispose: async () => {
      disposals.push(id);
    },
  };
}

function installedKiwiModelState(env) {
  return {
    targetDir: `${env.XDG_CACHE_HOME}/kiwi-model`,
    manifestPath: `${env.XDG_CACHE_HOME}/kiwi-model/manifest.json`,
    installed: true,
    manifest: {
      packageId: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
      sourceUrl: 'test',
      archiveSha256: 'sha',
      archiveSizeBytes: 1,
      files: [],
      installedAt: '2026-06-22T00:00:00.000Z',
    },
    missingFiles: [],
  };
}

function installedKiwiWasmState(env) {
  return {
    targetDir: `${env.XDG_CACHE_HOME}/kiwi-wasm`,
    manifestPath: `${env.XDG_CACHE_HOME}/kiwi-wasm/manifest.json`,
    wasmPath: `${env.XDG_CACHE_HOME}/kiwi-wasm/kiwi-wasm.wasm`,
    installed: true,
    manifest: {
      packageId: 'kiwi-wasm',
      kiwiNlpVersion: '0.23.0',
      sourceUrl: 'test',
      wasmSha256: 'sha',
      wasmSizeBytes: 1,
      file: 'kiwi-wasm.wasm',
      installedAt: '2026-06-22T00:00:00.000Z',
    },
    missingFiles: [],
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
