import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function tempRoot(prefix = 'optsidian-supervise-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

async function withCapturedDaemonProcessErrors(fn) {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function write(chunk, encoding, callback) {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn(writes);
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function assertNoUnhandledRejection(fn) {
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

test('superviseBackground contains sync throws and async rejections while running normal work', async () => {
  const { superviseBackground } = await import('../src/daemon/supervise.ts');

  await withCapturedDaemonProcessErrors(async (writes) => {
    assert.doesNotThrow(() => {
      superviseBackground('sync-unit', () => {
        throw new Error('sync boom');
      });
    });
    assert.match(writes.join(''), /background unit "sync-unit" failed/);
    assert.match(writes.join(''), /sync boom/);

    writes.length = 0;
    await assertNoUnhandledRejection(async () => {
      superviseBackground('async-unit', async () => {
        throw new Error('async boom');
      });
      await waitFor(() => writes.join('').includes('async boom'));
    });
    assert.match(writes.join(''), /background unit "async-unit" failed/);

    writes.length = 0;
    let ran = false;
    superviseBackground('normal-unit', () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(writes.join(''), '');
  });
});

test('worker progress callback throws are logged without aborting the job or pool', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'progress-worker.mjs');
  fs.writeFileSync(
    workerScript,
    `
import { parentPort } from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({
      id: 0,
      ok: true,
      result: { ready: true },
      memoryRss: process.memoryUsage().rss
    });
    return;
  }
  parentPort.postMessage({
    id: message.id,
    progress: { phase: "scanning", completed: 1, total: 1 },
    memoryRss: process.memoryUsage().rss
  });
  parentPort.postMessage({
    id: message.id,
    ok: true,
    result: { done: true, type: message.request?.type ?? "unknown" },
    memoryRss: process.memoryUsage().rss
  });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'progress-supervision',
    kind: 'search',
    size: 1,
    workerScript,
    env: { ...process.env },
  });

  await withCapturedDaemonProcessErrors(async (writes) => {
    try {
      await pool.warmup();
      let progressCount = 0;
      const result = await pool.run(
        { type: 'first' },
        {
          deadline: Date.now() + 5000,
          cancellationId: 'progress-throws',
          onProgress() {
            progressCount += 1;
            throw new Error('progress callback exploded');
          },
        },
      );

      assert.deepEqual(result, { done: true, type: 'first' });
      assert.equal(progressCount, 1);
      await waitFor(() => writes.join('').includes('progress callback exploded'));
      assert.match(writes.join(''), /progress-supervision worker progress callback failed/);

      const second = await pool.run(
        { type: 'second' },
        {
          deadline: Date.now() + 5000,
          cancellationId: 'pool-survives',
        },
      );
      assert.deepEqual(second, { done: true, type: 'second' });
    } finally {
      await pool.close();
    }
  });
});
