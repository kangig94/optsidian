import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('packaged vector-store process entry starts and replies over IPC', { timeout: 10_000 }, async () => {
  const script = path.join(process.cwd(), 'dist', 'daemon', 'vector-store', 'process-entry.js');
  if (!fs.existsSync(script)) {
    assert.fail('dist vector-store process entry is missing; run npm run build before tests');
  }
  const child = fork(script, [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for vector process reply')), 5000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`vector process exited before reply: ${code ?? signal ?? 'unknown'}`));
      });
      child.send({ id: 1, type: 'getStats', payload: {} });
    });
    assert.equal(reply.id, 1);
    if (reply.ok) {
      assert.equal(typeof reply.result, 'object');
    } else {
      assert.match(reply.error.message, /coral-needle|native|Cannot find|not found/i);
    }
  } finally {
    child.kill();
  }
});
