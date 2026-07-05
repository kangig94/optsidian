import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VRAM_PROBE_TTL_MS,
  createVramProbe,
  parseNvidiaSmiFreeMemoryBytes,
} from '../src/daemon/model-session/vram-probe.ts';

const MIB_BYTES = 1024 * 1024;

test('nvidia-smi free-memory output parses MiB to bytes using the minimum GPU value', () => {
  assert.equal(parseNvidiaSmiFreeMemoryBytes('1024\n512\n2048\n'), 512 * MIB_BYTES);
  assert.equal(parseNvidiaSmiFreeMemoryBytes(' 256 \r\n 128 \r\n'), 128 * MIB_BYTES);
  assert.equal(parseNvidiaSmiFreeMemoryBytes(Buffer.from('64\n')), 64 * MIB_BYTES);
  assert.equal(parseNvidiaSmiFreeMemoryBytes(''), 0);
  assert.equal(parseNvidiaSmiFreeMemoryBytes('1024\nnot-a-number\n'), 0);
});

test('platform branches use nvidia-smi on linux, os freemem on darwin, and zero elsewhere', () => {
  const linuxCalls = [];
  const linuxProbe = createVramProbe({
    platform: 'linux',
    now: () => 0,
    exec(command, args) {
      linuxCalls.push({ command, args: [...args] });
      return '384\n768\n';
    },
    freeMemoryBytes: () => 999,
  });
  assert.deepEqual(linuxProbe(), { freeBytes: 384 * MIB_BYTES });
  assert.deepEqual(linuxCalls, [
    {
      command: 'nvidia-smi',
      args: ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
    },
  ]);

  let darwinExecCalls = 0;
  const darwinProbe = createVramProbe({
    platform: 'darwin',
    now: () => 0,
    exec() {
      darwinExecCalls += 1;
      return '1';
    },
    freeMemoryBytes: () => 123_456,
  });
  assert.deepEqual(darwinProbe(), { freeBytes: 123_456 });
  assert.equal(darwinExecCalls, 0);

  let otherExecCalls = 0;
  const otherProbe = createVramProbe({
    platform: 'win32',
    now: () => 0,
    exec() {
      otherExecCalls += 1;
      return '1';
    },
    freeMemoryBytes: () => 123_456,
  });
  assert.deepEqual(otherProbe(), { freeBytes: 0 });
  assert.equal(otherExecCalls, 0);
});

test('linux probe returns zero when nvidia-smi execution or parsing fails', () => {
  const throwingProbe = createVramProbe({
    platform: 'linux',
    now: () => 0,
    exec() {
      throw new Error('missing nvidia-smi');
    },
  });
  assert.deepEqual(throwingProbe(), { freeBytes: 0 });

  const invalidOutputProbe = createVramProbe({
    platform: 'linux',
    now: () => 0,
    exec: () => 'unparseable',
  });
  assert.deepEqual(invalidOutputProbe(), { freeBytes: 0 });
});

test('probe result is cached until the 60 second TTL expires', () => {
  let nowMs = 1_000;
  const outputs = ['100\n', '200\n', '300\n'];
  let execCalls = 0;
  const probe = createVramProbe({
    platform: 'linux',
    now: () => nowMs,
    exec() {
      const output = outputs[execCalls];
      execCalls += 1;
      return output;
    },
  });

  assert.deepEqual(probe(), { freeBytes: 100 * MIB_BYTES });
  assert.equal(execCalls, 1);

  nowMs += VRAM_PROBE_TTL_MS - 1;
  assert.deepEqual(probe(), { freeBytes: 100 * MIB_BYTES });
  assert.equal(execCalls, 1);

  nowMs += 1;
  assert.deepEqual(probe(), { freeBytes: 200 * MIB_BYTES });
  assert.equal(execCalls, 2);

  nowMs += VRAM_PROBE_TTL_MS;
  assert.deepEqual(probe(), { freeBytes: 300 * MIB_BYTES });
  assert.equal(execCalls, 3);
});
