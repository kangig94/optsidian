import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
import { connectRpc, probeSocketPath } from '../src/daemon/transport.ts';

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

test('a superseded daemon self-drains at equal epoch and cleans only its own socket', async () => {
  const runtimeDir = tempRoot();
  const env = { ...daemonEnv(runtimeDir), OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS: '20' };
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const client = createSearchDaemonClient({ runtimeDir, binaryPath, readyTimeoutMs: 30000, env });
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  let victimPid;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    victimPid = first.pid;
    const victimSocket = first.socketPath;
    assert.equal(fs.existsSync(victimSocket), true);

    // A different incarnation claims the slot at the SAME epoch on its OWN unique socket path —
    // the equal-epoch cold-start tie the total-order (`>=`) step-down must reap. A newer successor
    // never binds the victim's path (unique paths), so its socket is a distinct file.
    const successorSocket = socketPathForOwner(runtimeDir, desired, 'succ0nonce');
    assert.notEqual(successorSocket, victimSocket);
    registry.writeOwner(createOwnerRecord(desired, successorSocket, first.epoch, 'successor-incarnation', 999999));

    const exited = await waitForExit(victimPid, 4000);
    assert.equal(exited, true, 'superseded daemon should self-drain and exit');

    // It cleans up its OWN unique socket on the way out, and never touches the successor's record.
    assert.equal(fs.existsSync(victimSocket), false, 'stepped-down daemon should unlink its own socket');
    assert.equal(registry.readOwner()?.incarnationId, 'successor-incarnation');
  } finally {
    if (victimPid !== undefined) {
      try {
        process.kill(victimPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('failed deterministic socket start does not unlink a live incumbent socket or owner', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const socketPath = socketPathForOwner(runtimeDir, desired);
  const owner = createOwnerRecord(desired, socketPath, 1, 'incumbent-incarnation', process.pid);
  const incumbent = net.createServer();
  let child;
  registry.writeOwner(owner);

  try {
    await listen(incumbent, socketPath);
    assert.equal(await probeSocketPath(socketPath), 'listening');

    child = spawn(binaryPath, ['__search-daemon'], {
      env: {
        ...daemonEnv(runtimeDir),
        OPTSIDIAN_SEARCH_DAEMON_BINARY: binaryPath,
        OPTSIDIAN_SEARCH_DAEMON_SOCKET: socketPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exit = await waitForChildExit(child, 5000);

    assert.notEqual(exit.code, 0, exit.stderr);
    assert.equal(await probeSocketPath(socketPath), 'listening');
    assert.equal(fs.existsSync(socketPath), true);
    assert.deepEqual(registry.readOwner(), owner);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closeServer(incumbent).catch(() => {});
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a sole owner never self-drains across many ownership poll cycles', async () => {
  const runtimeDir = tempRoot();
  const env = { ...daemonEnv(runtimeDir), OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS: '20' };
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const client = createSearchDaemonClient({ runtimeDir, binaryPath, readyTimeoutMs: 30000, env });
  let pid;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    pid = first.pid;

    // Leave the owner file untouched across ~40 poll cycles; a healthy sole owner must not step down.
    await delay(800);

    assert.equal(await waitForExit(pid, 10), false, 'sole owner must stay alive');
    const after = await client.status({ deadlineMs: 30000 });
    assert.equal(after.ready, true);
    assert.equal(after.incarnationId, first.incarnationId);
    assert.equal(after.pid, first.pid);
  } finally {
    await createSearchDaemonClient({ runtimeDir, binaryPath, env })
      .shutdown({ deadlineMs: 5000 })
      .catch(() => {});
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('socketPathForOwner yields a unique path per incarnation nonce', () => {
  const desired = desiredOwnerIdentity(path.join(repoRoot, 'dist', 'optsidian'));
  const runtimeDir = tempRoot();
  try {
    const a = socketPathForOwner(runtimeDir, desired, 'aaaaaaaa');
    const b = socketPathForOwner(runtimeDir, desired, 'bbbbbbbb');
    const base = socketPathForOwner(runtimeDir, desired);
    assert.notEqual(a, b);
    assert.notEqual(a, base);
    assert.notEqual(b, base);
    assert.match(a, /-aaaaaaaa\.sock$/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
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

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`daemon did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal, stderr: stderr.join('') });
    };
    const onStderr = (chunk) => {
      stderr.push(String(chunk));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    }

    child.once('error', onError);
    child.once('exit', onExit);
    child.stderr?.on('data', onStderr);
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
