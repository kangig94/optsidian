import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSearchDaemonClient } from '../src/daemon/client.ts';
import {
  createOwnerRecord,
  createOwnerRegistry,
  desiredOwnerIdentity,
  socketPathForOwner,
} from '../src/daemon/owner-registry.ts';
import { SEARCH_DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.ts';
import { connectRpc } from '../src/daemon/transport.ts';

const repoRoot = process.cwd();

test('AC6 kill and respawn mid client session resyncs to the successor', async () => {
  const runtimeDir = tempRoot();
  const env = daemonEnv(runtimeDir);
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });

  let finalStatus;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    process.kill(first.pid, 'SIGTERM');
    await waitForDead(first.pid);

    finalStatus = await client.status({ deadlineMs: 30000 });
    assert.equal(finalStatus.ready, true);
    assert.equal(finalStatus.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
    assert.notEqual(finalStatus.incarnationId, first.incarnationId);
    assert.equal(finalStatus.epoch > first.epoch, true, 'successor epoch must advance');

    const connection = await connectRpc(finalStatus.socketPath);
    try {
      await assert.rejects(
        () =>
          connection.request({
            protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION - 1,
            requestId: 'protocol-mismatch',
            method: 'Status',
            deadline: Date.now() + 1000,
            payload: {},
          }),
        (error) => {
          assert.equal(error.code, 'BAD_REQUEST');
          assert.match(error.message, /protocol version mismatch/);
          return true;
        },
      );
    } finally {
      await connection.close();
    }
  } finally {
    if (finalStatus) {
      await createSearchDaemonClient({ runtimeDir, binaryPath: path.join(repoRoot, 'dist', 'optsidian'), env })
        .shutdown({ deadlineMs: 5000 })
        .catch(() => {});
    }
  }
});

test('AC6 semantic errors fail fast and are not retried', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const owner = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const requests = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    connect(record) {
      return {
        async request(request) {
          requests.push(request);
          if (request.method === 'Status') return statusResult(record);
          throw Object.assign(new Error('malformed request'), { code: 'BAD_REQUEST' });
        },
        async close() {},
      };
    },
  });

  await assert.rejects(
    () => client.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'BAD_REQUEST');
      return true;
    },
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ['Status', 'Search'],
  );
});

test('AC6 WaitReady long-poll replaces readiness busy polling', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const owner = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const calls = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    connect(record) {
      return {
        async request(request) {
          calls.push(request.method);
          if (request.method === 'Status') return statusResult(record, { ready: false, phase: 'starting' });
          if (request.method === 'WaitReady') return statusResult(record, { ready: true, phase: 'ready' });
          return {
            ok: true,
            command: 'search',
            schemaVersion: 1,
            available: true,
            status: 'ready',
            snapshotId: 'snap-a',
            matches: [],
            results: [],
          };
        },
        async close() {},
      };
    },
  });

  await client.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 });
  assert.deepEqual(calls, ['Status', 'WaitReady', 'Search']);
});

function statusResult(owner, overrides = {}) {
  return {
    ok: true,
    ready: true,
    phase: 'ready',
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    binaryVersion: owner.binaryVersion,
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    pid: owner.pid,
    socketPath: owner.socketPath,
    startedAt: owner.startedAt,
    owner,
    metrics: { requests: 0, failures: 0, activeRequests: 0, startedAt: owner.startedAt },
    pools: {},
    searchStore: {},
    profiles: {},
    vaults: [],
    ...overrides,
  };
}

async function waitForDead(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
  process.kill(pid, 'SIGKILL');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonEnv(runtimeDir) {
  return {
    ...process.env,
    OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '60000',
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-daemon-handoff-'));
}
