import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unpack } from 'msgpackr';
import { SEARCH_DAEMON_PROTOCOL_VERSION as CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.ts';
import {
  createDeterministicEmbeddingSetBuilder,
  DeterministicHashProvider,
} from './helpers/deterministic-embedding.mjs';
import { activeRetrievalFromEdition, activeSnapshotFromEdition, currentEdition } from './helpers/edition-ledger.mjs';

const repoRoot = process.cwd();
const AC18_OWNER_FIELDS = ['slot', 'epoch', 'incarnationId', 'binaryVersion', 'pid', 'socketPath', 'startedAt'];

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: {
      name: 'test-analyzer',
      version: '1',
      node: 'test',
    },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text)),
  };
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempRoot(prefix = 'optsidian-search-daemon-contract-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function snapshotStoreOptions(options = {}) {
  return {
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    ...options,
  };
}

function assertPrivateMode(filePath, expectedMode) {
  if (process.platform === 'win32') return;
  assert.equal(fs.statSync(filePath).mode & 0o777, expectedMode, `${filePath} mode`);
}

function ageSearchStore(paths, nowMs, days) {
  const oldMs = nowMs - days * 24 * 60 * 60 * 1000;
  const storeState = JSON.parse(fs.readFileSync(paths.storeStatePath, 'utf8'));
  storeState.lastUsedAtMs = oldMs;
  fs.writeFileSync(paths.storeStatePath, `${JSON.stringify(storeState)}\n`, { mode: 0o600 });
  const oldDate = new Date(oldMs);
  fs.utimesSync(paths.storeStatePath, oldDate, oldDate);
  fs.utimesSync(paths.rootDir, oldDate, oldDate);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function settlePromise(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function emptyBm25Stats() {
  return {
    schemaId: 1,
    corpusStats: [],
    rows: [],
    hash: sha256(canonicalJson({ schemaId: 1, corpusStats: [], rows: [] })),
  };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0,
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3],
    })),
    hash: manifest.bm25GlobalStatsHash,
  };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.from(JSON.stringify(value));
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength,
  };
}

function msgpackPayloadFrame(payload) {
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function connectRawSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readRawRpcFrame(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for RPC frame'));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length);
      cleanup();
      resolve(unpack(payload));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before RPC frame'));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function waitForSocketClose(socket, timeoutMs = 1000) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for socket close'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {};
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function requestRawRpc(socketPath, encodeFrame, request) {
  const socket = await connectRawSocket(socketPath);
  try {
    socket.write(encodeFrame(request));
    return await readRawRpcFrame(socket);
  } finally {
    socket.destroy();
  }
}

function statusRequest(requestId) {
  return {
    protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId,
    method: 'Status',
    deadline: Date.now() + 1000,
    payload: {},
  };
}

function statusResult(owner, overrides = {}) {
  return {
    ok: true,
    ready: true,
    phase: 'ready',
    protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
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

function publishFakeOwner(registry, record, pid = record.pid || process.pid) {
  const current = registry.readOwner();
  const owner = {
    ...record,
    epoch: (current?.epoch ?? 0) + 1,
    pid,
    startedAt: new Date().toISOString(),
  };
  registry.writeOwner(owner);
  return owner;
}

async function assertBadFrameThenAlive({ socketPath, frame, encodeFrame, label }) {
  const socket = await connectRawSocket(socketPath);
  socket.write(frame);
  const response = await readRawRpcFrame(socket);
  assert.equal(response.requestId, 'invalid-frame', label);
  assert.equal(response.ok, false, label);
  assert.equal(response.error.code, 'BAD_REQUEST', label);
  await waitForSocketClose(socket);

  const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest(`alive-${label}`));
  assert.equal(alive.ok, true, `${label}: server should accept a subsequent connection`);
  assert.equal(alive.result.alive, true);
}

function listFiles(root, predicate) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (predicate(filePath)) files.push(filePath);
    }
  };
  visit(root);
  return files;
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  return path
    .normalize(path.join(path.dirname(repoRelative(fromFile)), specifier))
    .split(path.sep)
    .join('/');
}

function importedSearchExecutionSymbols(source) {
  const symbols = [
    'searchVault',
    'searchVaultWithAnalyzer',
    'searchVaultWithLeasedAnalyzer',
    'rebuildSearchIndex',
    'clearSearchIndex',
    'warmSearchIndexes',
    'getSearchIndexStatus',
  ];
  return symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source));
}

function testQueryAnalysis(raw) {
  const terms = [
    ...raw
      .normalize('NFKC')
      .toLowerCase()
      .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
  ].map((match) => match[0]);
  return {
    raw,
    primaryChannel: 'morph',
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] },
  };
}

async function createPinnedSearchFixture(files, options = {}) {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  for (const [rel, content] of Object.entries(files)) writeVaultFile(vault, rel, content);
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer,
      countCap: 4,
      byteCap: 64 * 1024 * 1024,
    }),
  );
  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const snapshot = store.snapshotHandleForPin(pin);
  const defaultQuery = options.query ?? 'needle';
  return {
    analyzer,
    store,
    vault,
    pin,
    snapshot,
    search(overrides = {}) {
      const query = overrides.query ?? defaultQuery;
      return executeSearchJob({
        vault,
        search: normalizeSearchParams({
          query,
          limit: options.limit ?? 10,
          debug: options.debug ?? false,
          ...(overrides.search ?? {}),
        }),
        analysis: overrides.analysis ?? options.analysis ?? testQueryAnalysis(query),
        analyzerIdentity: analyzer.identity,
        snapshot,
        explain: overrides.explain === true,
      });
    },
    release() {
      store.release(pin);
    },
  };
}

function searchIdentityPayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    snippets: match.snippets.map((snippet) => snippet.text),
  }));
}

test('AC2/AC3 transport rejects nil and malformed frames without killing the server', async () => {
  const { createRpcServer } = await import('../src/daemon/transport.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  const server = await createRpcServer({
    socketPath,
    handleRequest: async () => ({ alive: true }),
  });

  try {
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: 'nil-frame',
      frame: msgpackPayloadFrame(Buffer.from([0xc0])),
    });
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: 'malformed-frame',
      frame: msgpackPayloadFrame(Buffer.from([0xc1])),
    });
  } finally {
    await server.close();
  }
});

test('AC3 transport survives an abruptly destroyed client socket mid-request', async () => {
  const { createRpcServer } = await import('../src/daemon/transport.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  let slowRequestSeen = false;
  const server = await createRpcServer({
    socketPath,
    handleRequest: async (request) => {
      if (request.requestId === 'slow-request') {
        slowRequestSeen = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { alive: true };
    },
  });

  try {
    const socket = await connectRawSocket(socketPath);
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      socket.write(encodeFrame(statusRequest('slow-request')), (error) => {
        if (error) reject(error);
        else {
          socket.destroy();
          resolve();
        }
      });
    });
    await waitForSocketClose(socket);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(slowRequestSeen, true);
    const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest('after-destroy'));
    assert.equal(alive.ok, true);
    assert.equal(alive.result.alive, true);
  } finally {
    await server.close();
  }
});

test('AC3 transport client request deadline rejects and closes a hung RPC socket', async () => {
  const { connectRpc, createRpcServer } = await import('../src/daemon/transport.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  let releaseHungRequest;
  const hungRequest = new Promise((resolve) => {
    releaseHungRequest = resolve;
  });
  const closedRequestIds = [];
  const server = await createRpcServer({
    socketPath,
    handleRequest: async (request) => {
      if (request.requestId === 'hung-request') return hungRequest;
      return { alive: true };
    },
    onConnectionClosed(requestIds) {
      closedRequestIds.push(...requestIds);
    },
  });
  let connection;

  try {
    connection = await connectRpc(socketPath);
    await assert.rejects(
      () =>
        connection.request({
          ...statusRequest('hung-request'),
          deadline: Date.now() + 50,
        }),
      (error) => {
        assert.equal(error.code, 'ETIMEDOUT');
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
    await waitFor(() => closedRequestIds.includes('hung-request'));

    const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest('after-client-timeout'));
    assert.equal(alive.ok, true);
    assert.equal(alive.result.alive, true);
  } finally {
    releaseHungRequest?.({ alive: false });
    await connection?.close().catch(() => undefined);
    await server.close();
  }
});

test('AC3 transport converts synchronous handler throws into RPC errors without killing the server', async () => {
  const { createRpcServer } = await import('../src/daemon/transport.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  const server = await createRpcServer({
    socketPath,
    handleRequest: (request) => {
      if (request.requestId === 'sync-throw') {
        throw Object.assign(new Error('search daemon is not ready'), { code: 'SEARCH_DAEMON_NOT_READY' });
      }
      return Promise.resolve({ alive: true });
    },
  });

  try {
    const rejected = await requestRawRpc(socketPath, encodeFrame, statusRequest('sync-throw'));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'SEARCH_DAEMON_NOT_READY');
    assert.match(rejected.error.message, /not ready/);

    const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest('after-sync-throw'));
    assert.equal(alive.ok, true);
    assert.equal(alive.result.alive, true);
  } finally {
    await server.close();
  }
});

test('AC11 transport closes unused idle sockets and incomplete frames without killing the server', async () => {
  const { createRpcServer } = await import('../src/daemon/transport.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  const server = await createRpcServer({
    socketPath,
    socketIdleTimeoutMs: 25,
    handleRequest: async () => ({ alive: true }),
  });

  try {
    const idle = await connectRawSocket(socketPath);
    await waitForSocketClose(idle, 500);
    const aliveAfterIdle = await requestRawRpc(socketPath, encodeFrame, statusRequest('after-idle-close'));
    assert.equal(aliveAfterIdle.ok, true);
    assert.equal(aliveAfterIdle.result.alive, true);

    const partial = await connectRawSocket(socketPath);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(64, 0);
    partial.write(Buffer.concat([header, Buffer.from([0x80])]));
    const response = await readRawRpcFrame(partial, 500);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'BAD_REQUEST');
    assert.match(response.error.message, /timed out/i);
    await waitForSocketClose(partial, 500);

    const aliveAfterPartial = await requestRawRpc(socketPath, encodeFrame, statusRequest('after-partial-close'));
    assert.equal(aliveAfterPartial.ok, true);
    assert.equal(aliveAfterPartial.result.alive, true);
  } finally {
    await server.close();
  }
});

test('AC11 transport rejects oversized declared frames and keeps serving', async () => {
  const { createRpcServer } = await import('../src/daemon/transport.ts');
  const { SEARCH_DAEMON_MAX_FRAME_BYTES, encodeFrame } = await import('../src/daemon/protocol.ts');
  const root = tempRoot();
  const socketPath = path.join(root, 'rpc.sock');
  const server = await createRpcServer({
    socketPath,
    handleRequest: async () => ({ alive: true }),
  });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(SEARCH_DAEMON_MAX_FRAME_BYTES + 1, 0);

  try {
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: 'oversized-frame',
      frame: oversizedHeader,
    });
  } finally {
    await server.close();
  }
});

test('AC5 worker pool warmup failures reject instead of hanging or degrading', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'warmup-fails.mjs');
  fs.writeFileSync(
    workerScript,
    `
import { parentPort } from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message?.id !== 0) return;
  parentPort.postMessage({
    id: 0,
    ok: false,
    error: { code: "WARMUP_FAILED", message: "x" },
    memoryRss: process.memoryUsage().rss
  });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'ac5-warmup-fail-fast',
    kind: 'analyzer',
    size: 1,
    workerScript,
    env: { ...process.env },
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('warmup did not settle')), 6000);
    timeoutId.unref?.();
  });
  const started = Date.now();

  try {
    await assert.rejects(
      () => Promise.race([pool.warmup(), timeout]),
      (error) => {
        assert.equal(error.code, 'WARMUP_FAILED');
        assert.match(error.message, /x/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 6000);
  } finally {
    clearTimeout(timeoutId);
    await pool.close();
  }
});

test('worker pool can serve jobs after the first worker is ready', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'partial-ready.mjs');
  const firstMarker = path.join(root, 'first-worker.marker');
  const jobLog = path.join(root, 'jobs.log');
  fs.writeFileSync(jobLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const firstMarker = ${JSON.stringify(firstMarker)};
const jobLog = ${JSON.stringify(jobLog)};
let index = 1;
try {
  fs.writeFileSync(firstMarker, "1", { flag: "wx" });
  index = 0;
} catch {
  index = 1;
}

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    const reply = () => parentPort.postMessage({
      id: 0,
      ok: true,
      result: { workerIndex: index },
      memoryRss: process.memoryUsage().rss
    });
    if (index === 0) reply();
    else setTimeout(reply, 100);
    return;
  }
  fs.appendFileSync(jobLog, String(index) + "\\n");
  parentPort.postMessage({
    id: message.id,
    ok: true,
    result: { workerIndex: index },
    memoryRss: process.memoryUsage().rss
  });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'partial-ready',
    kind: 'search',
    size: 2,
    workerScript,
    env: { ...process.env },
  });
  try {
    const started = Date.now();
    const warmed = await pool.warmup(1);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(warmed, [{ workerIndex: 0 }]);
    assert.equal(pool.stats().ready, 1);

    const result = await pool.run(
      { type: 'search' },
      {
        deadline: Date.now() + 1000,
        cancellationId: 'partial-ready',
      },
    );
    assert.deepEqual(result, { workerIndex: 0 });
    assert.equal(fs.readFileSync(jobLog, 'utf8').trim(), '0');

    await pool.warmup();
    assert.equal(pool.stats().ready, 2);
  } finally {
    await pool.close();
  }
});

test('worker pool can defer warmup until first job', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'lazy-warmup.mjs');
  const logPath = path.join(root, 'events.log');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const logPath = ${JSON.stringify(logPath)};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    fs.appendFileSync(logPath, "warmup\\n");
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  fs.appendFileSync(logPath, "job\\n");
  parentPort.postMessage({ id: message.id, ok: true, result: { ok: true }, memoryRss: process.memoryUsage().rss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'lazy-warmup',
    kind: 'analyzer',
    size: 1,
    workerScript,
    autoWarmup: false,
    env: { ...process.env },
  });
  try {
    assert.equal(fs.readFileSync(logPath, 'utf8'), '');
    assert.equal(pool.stats().ready, 0);
    assert.equal(pool.stats().slots[0].warmupStarted, false);

    await pool.run(
      { type: 'analyzeQuery' },
      {
        deadline: Date.now() + 1000,
        cancellationId: 'lazy-warmup',
      },
    );
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'warmup\njob\n');
    assert.equal(pool.stats().ready, 1);
  } finally {
    await pool.close();
  }
});

test('worker pool retargets a targeted retry after the assigned worker crashes', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'targeted-retry-crash-once.mjs');
  const crashMarker = path.join(root, 'crashed.marker');
  const jobLog = path.join(root, 'jobs.log');
  fs.writeFileSync(jobLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const crashMarker = ${JSON.stringify(crashMarker)};
const jobLog = ${JSON.stringify(jobLog)};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  if (!fs.existsSync(crashMarker)) {
    fs.writeFileSync(crashMarker, "crashed");
    process.exit(1);
  }
  fs.appendFileSync(jobLog, "retried\\n");
  parentPort.postMessage({ id: message.id, ok: true, result: { retried: true }, memoryRss: process.memoryUsage().rss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'targeted-retry',
    kind: 'search',
    size: 1,
    workerScript,
    maxCrashRetries: 1,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    const [originalSlotId] = pool.readySlotIds();
    const result = await pool.runOnSlot(
      { type: 'search' },
      {
        deadline: Date.now() + 10_000,
        cancellationId: 'targeted-retry',
      },
      originalSlotId,
    );

    assert.deepEqual(result, { retried: true });
    assert.equal(fs.readFileSync(crashMarker, 'utf8'), 'crashed');
    assert.equal(fs.readFileSync(jobLog, 'utf8'), 'retried\n');
    assert.notEqual(pool.readySlotIds()[0], originalSlotId);
  } finally {
    await pool.close();
  }
});

test('worker pool routes targeted jobs FIFO without requestId rotation', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'targeted-request-fairness.mjs');
  const releasePath = path.join(root, 'release.marker');
  const jobLog = path.join(root, 'jobs.log');
  fs.writeFileSync(jobLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const releasePath = ${JSON.stringify(releasePath)};
const jobLog = ${JSON.stringify(jobLog)};

function finish(id, result) {
  parentPort.postMessage({ id, ok: true, result, memoryRss: process.memoryUsage().rss });
}

function waitForRelease(id) {
  if (fs.existsSync(releasePath)) {
    finish(id, { label: "block" });
    return;
  }
  setTimeout(() => waitForRelease(id), 5);
}

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  const label = message.request?.payload?.label;
  fs.appendFileSync(jobLog, label + "\\n");
  if (label === "block") {
    waitForRelease(message.id);
    return;
  }
  finish(message.id, { label });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'targeted-request-fairness',
    kind: 'search',
    size: 1,
    workerScript,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    const [slotId] = pool.readySlotIds();
    const deadline = Date.now() + 10_000;
    const blocker = pool.runOnSlot(
      { type: 'search', payload: { label: 'block' } },
      {
        deadline,
        cancellationId: 'block',
        requestId: 'block',
        vault: 'vault-a',
      },
      slotId,
    );
    await waitFor(() => fs.readFileSync(jobLog, 'utf8').includes('block\n'));

    const a1 = pool.runOnSlot(
      { type: 'search', payload: { label: 'a1' } },
      {
        deadline,
        cancellationId: 'request-a',
        requestId: 'request-a',
        vault: 'vault-a',
      },
      slotId,
    );
    const a2 = pool.runOnSlot(
      { type: 'search', payload: { label: 'a2' } },
      {
        deadline,
        cancellationId: 'request-a',
        requestId: 'request-a',
        vault: 'vault-a',
      },
      slotId,
    );
    const b1 = pool.runOnSlot(
      { type: 'search', payload: { label: 'b1' } },
      {
        deadline,
        cancellationId: 'request-b',
        requestId: 'request-b',
        vault: 'vault-a',
      },
      slotId,
    );

    fs.writeFileSync(releasePath, 'go');
    await Promise.all([blocker, a1, a2, b1]);
    assert.equal(fs.readFileSync(jobLog, 'utf8'), 'block\na1\na2\nb1\n');
  } finally {
    fs.writeFileSync(releasePath, 'go');
    await pool.close();
  }
});

test('worker pool leases idle-ready slots atomically before drain', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'idle-ready-lease.mjs');
  const jobLog = path.join(root, 'jobs.log');
  fs.writeFileSync(jobLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const jobLog = ${JSON.stringify(jobLog)};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  const label = message.request?.payload?.label;
  fs.appendFileSync(jobLog, label + "\\n");
  parentPort.postMessage({ id: message.id, ok: true, result: { label }, memoryRss: process.memoryUsage().rss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'idle-ready-lease',
    kind: 'search',
    size: 1,
    workerScript,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    const leasedSlotId = pool.leaseIdleSlot();
    assert.notEqual(leasedSlotId, undefined);
    assert.deepEqual(pool.idleReadySlotIds(), []);
    assert.equal(pool.leaseIdleSlot(), undefined);

    const deadline = Date.now() + 10_000;
    const generic = pool.run(
      { type: 'search', payload: { label: 'generic' } },
      {
        deadline,
        cancellationId: 'generic',
      },
    );
    const leased = pool.runOnSlot(
      { type: 'search', payload: { label: 'leased' } },
      {
        deadline,
        cancellationId: 'leased',
      },
      leasedSlotId,
    );

    assert.deepEqual(await Promise.all([leased, generic]), [{ label: 'leased' }, { label: 'generic' }]);
    assert.equal(fs.readFileSync(jobLog, 'utf8'), 'leased\ngeneric\n');
    assert.deepEqual(pool.idleReadySlotIds(), [leasedSlotId]);
  } finally {
    await pool.close();
  }
});

test('worker pool stats expose the in-flight job type and vault', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'busy-job.mjs');
  const releasePath = path.join(root, 'release');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";
const releasePath = ${JSON.stringify(releasePath)};
parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  const timer = setInterval(() => {
    if (fs.existsSync(releasePath)) {
      clearInterval(timer);
      parentPort.postMessage({ id: message.id, ok: true, result: {}, memoryRss: process.memoryUsage().rss });
    }
  }, 5);
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'busy-job',
    kind: 'search',
    size: 1,
    workerScript,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    const job = pool.run(
      { type: 'modelEncode', payload: {} },
      { deadline: Date.now() + 10_000, cancellationId: 'busy', vault: '/vault-x' },
    );
    await waitFor(() => pool.stats().slots.some((slot) => slot.busy), 5000);
    const busy = pool.stats().slots.find((slot) => slot.busy);
    assert.deepEqual(busy.job, { type: 'modelEncode', vault: '/vault-x' });
    fs.writeFileSync(releasePath, '');
    await job;
    await waitFor(() => pool.stats().slots.find((slot) => slot.id === busy.id).job === undefined, 5000);
  } finally {
    await pool.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker pool close rejects an in-flight job promptly', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'close-busy-job.mjs');
  const startedPath = path.join(root, 'started');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const startedPath = ${JSON.stringify(startedPath)};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  fs.writeFileSync(startedPath, "started");
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'close-busy-job',
    kind: 'search',
    size: 1,
    workerScript,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    const startedAt = Date.now();
    const job = pool.run(
      { type: 'search', payload: { block: true } },
      { deadline: Date.now() + 60_000, cancellationId: 'close-busy-job' },
    );
    const jobSettlement = settlePromise(job);
    await waitFor(() => fs.existsSync(startedPath) && pool.stats().slots.some((slot) => slot.busy), 5000);

    const close = pool.close();
    const result = await withTimeout(jobSettlement, 1_000, 'in-flight worker job close rejection');
    await withTimeout(close, 1_000, 'worker pool close');

    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'CANCELLED');
    assert.match(result.reason.message, /pool is closing/);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await pool.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildConcurrency projects pools, lanes, and caches with an honest single RSS', async () => {
  const { buildConcurrency, searchExecutionCacheSummary } = await import('../src/daemon/server.ts');
  const pool = (name, over = {}) => ({
    name,
    kind: 'search',
    workers: 1,
    queued: 0,
    active: 0,
    ready: 1,
    processMemory: { rss: 123456, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    slots: [],
    ...over,
  });
  const profiles = {
    p1: {
      profileHash: 'p1',
      profile: {},
      activeRequests: 1,
      pools: {
        latencyAnalyzer: pool('latencyAnalyzer'),
        throughputAnalyzer: pool('throughputAnalyzer'),
        embedding: pool('embedding', {
          active: 1,
          slots: [{ id: 0, ready: true, busy: true, job: { type: 'modelEncode', vault: '/v' } }],
        }),
        vector: pool('vector'),
        searchExecution: pool('searchExecution', {
          cache: [
            { entries: 2, limit: 10, hits: 3, misses: 1, evictions: 0, preloads: 1, snapshotIds: ['a'] },
            { entries: 1, limit: 10, hits: 4, misses: 2, evictions: 1, preloads: 0, snapshotIds: ['b'] },
          ],
        }),
      },
      searchStore: {
        queryAnalysisCache: { entries: 5, maxEntries: 100, hits: 7, misses: 3, evictions: 1 },
        rankingTuningHash: 'h',
      },
      embedScheduler: {
        runningLane: 'rebuild',
        lanes: { query: 0, save: 1, refresh: 0, rebuild: 2 },
        activeLaneScopes: { query: 0, save: 0, refresh: 0, rebuild: 1 },
        querySingleFlights: 0,
      },
      vaults: [],
    },
  };
  const c = buildConcurrency(profiles);
  assert.equal(c.processRssBytes, 123456);
  assert.equal(c.pools.length, 5);
  assert.deepEqual(c.pools.find((p) => p.pool === 'embedding').slots[0].job, { type: 'modelEncode', vault: '/v' });
  assert.equal(c.embedLanes.length, 1);
  assert.equal(c.embedLanes[0].runningLane, 'rebuild');
  assert.deepEqual(c.embedLanes[0].lanes, { query: 0, save: 1, refresh: 0, rebuild: 2 });
  assert.deepEqual(c.caches[0].queryAnalysis, { entries: 5, hits: 7, misses: 3, evictions: 1 });
  // summed across the two per-slot search-execution cache entries
  assert.deepEqual(c.caches[0].searchExecution, { entries: 3, hits: 7, misses: 3, evictions: 1, preloads: 1 });

  assert.equal(searchExecutionCacheSummary({ error: 'boom' }), undefined);
  assert.equal(searchExecutionCacheSummary([]), undefined);
  assert.deepEqual(buildConcurrency({}), { pools: [], embedLanes: [], caches: [] });
});

test('AC3 worker pool source has no targeted requestId rotation', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/daemon/worker-pool.ts'), 'utf8');
  assert.doesNotMatch(source, /\blastTargetRequestGroupBySlot\b/);
  assert.doesNotMatch(source, /\brequestGroupKey\b/);
  assert.doesNotMatch(source, /requestId\s*\?\?/);
});

test('daemon pools defer latency analyzer warmup until query analysis', async () => {
  const { createDaemonPools } = await import('../src/daemon/pools.ts');
  const pools = await createDaemonPools(
    {
      ...process.env,
      OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
      OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
      OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    },
    {},
  );
  try {
    const stats = await pools.stats({
      deadline: Date.now() + 1000,
      cancellationId: 'lazy-latency-stats',
    });
    assert.equal(stats.latencyAnalyzer.ready, 0);
    assert.equal(stats.searchExecution.ready, 1);
  } finally {
    await pools.close();
  }
});

test('daemon pools treat OPTSIDIAN_SEARCH_WORKERS as search execution workers only', async () => {
  const { createDaemonPools } = await import('../src/daemon/pools.ts');
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_WORKERS: '2',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: undefined,
    OPTSIDIAN_SEARCH_INDEX_WORKERS: undefined,
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: undefined,
  };
  const pools = await createDaemonPools(env, {});
  try {
    const stats = await pools.stats({
      deadline: Date.now() + 1000,
      cancellationId: 'single-worker-env-stats',
    });
    assert.equal(stats.latencyAnalyzer.workers, 1);
    assert.equal(stats.throughputAnalyzer.workers, 1);
    assert.equal(stats.searchExecution.workers, 2);
  } finally {
    await pools.close();
  }
});

test('default search execution worker count is one per four logical CPUs capped at four', async () => {
  const { defaultSearchExecutionWorkerCount } = await import('../src/daemon/worker-pool.ts');

  assert.equal(defaultSearchExecutionWorkerCount(1), 1);
  assert.equal(defaultSearchExecutionWorkerCount(4), 1);
  assert.equal(defaultSearchExecutionWorkerCount(8), 2);
  assert.equal(defaultSearchExecutionWorkerCount(15), 3);
  assert.equal(defaultSearchExecutionWorkerCount(16), 4);
  assert.equal(defaultSearchExecutionWorkerCount(32), 4);
});

test('daemon pools use search.executionWorkers setting when worker env is unset', async () => {
  const { createDaemonPools } = await import('../src/daemon/pools.ts');
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_WORKERS: undefined,
    OPTSIDIAN_SEARCH_QUERY_WORKERS: undefined,
    OPTSIDIAN_SEARCH_INDEX_WORKERS: undefined,
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: undefined,
  };
  const pools = await createDaemonPools(env, { search: { executionWorkers: 3 } });
  try {
    const stats = await pools.stats({
      deadline: Date.now() + 1000,
      cancellationId: 'settings-execution-workers-stats',
    });
    assert.equal(stats.latencyAnalyzer.workers, 1);
    assert.equal(stats.throughputAnalyzer.workers, 1);
    assert.equal(stats.searchExecution.workers, 3);
  } finally {
    await pools.close();
  }
});

test('worker pool memory restart guard ignores shared/native memory when heap is below limit', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'memory-guard.mjs');
  const warmupLog = path.join(root, 'warmups.log');
  fs.writeFileSync(warmupLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const warmupLog = ${JSON.stringify(warmupLog)};
const memory = {
  rss: 1024 * 1024 * 1024,
  heapTotal: 2,
  heapUsed: 1,
  external: 1024 * 1024 * 1024,
  arrayBuffers: 1024 * 1024 * 1024
};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    fs.appendFileSync(warmupLog, "warmup\\n");
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memory, memoryRss: memory.rss });
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, result: { ok: true }, memory, memoryRss: memory.rss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'memory-guard',
    kind: 'search',
    size: 1,
    workerScript,
    memoryLimitBytes: 10,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    await pool.run(
      { type: 'search' },
      {
        deadline: Date.now() + 1000,
        cancellationId: 'memory-guard',
      },
    );
    const warmups = fs.readFileSync(warmupLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(warmups.length, 1);
    const stats = pool.stats();
    assert.equal(stats.restarts, 0);
    assert.equal(stats.slots[0].lastMemory.heapUsed, 1);
  } finally {
    await pool.close();
  }
});

test('worker pool heap guard ignores legacy memoryRss-only replies', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'legacy-memory-rss-only.mjs');
  const warmupLog = path.join(root, 'warmups.log');
  fs.writeFileSync(warmupLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const warmupLog = ${JSON.stringify(warmupLog)};
const memoryRss = 1024 * 1024 * 1024;

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    fs.appendFileSync(warmupLog, "warmup\\n");
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss });
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, result: { ok: true }, memoryRss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'legacy-memory-rss-only',
    kind: 'search',
    size: 1,
    workerScript,
    memoryLimitBytes: 10,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    await pool.run(
      { type: 'search' },
      {
        deadline: Date.now() + 1000,
        cancellationId: 'legacy-memory-rss-only',
      },
    );
    const warmups = fs.readFileSync(warmupLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(warmups.length, 1);
    const stats = pool.stats();
    assert.equal(stats.restarts, 0);
    assert.equal(stats.slots[0].lastMemory.rss, 1024 * 1024 * 1024);
    assert.equal(stats.slots[0].lastMemory.heapUsed, undefined);
  } finally {
    await pool.close();
  }
});

test('worker pool optional rss guard restarts only after configured strikes', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'rss-guard.mjs');
  const warmupLog = path.join(root, 'warmups.log');
  fs.writeFileSync(warmupLog, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const warmupLog = ${JSON.stringify(warmupLog)};
const memory = { rss: 1000, heapTotal: 2, heapUsed: 1, external: 0, arrayBuffers: 0 };

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    fs.appendFileSync(warmupLog, "warmup\\n");
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memory, memoryRss: memory.rss });
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, result: { ok: true }, memory, memoryRss: memory.rss });
});
`,
  );
  const pool = new DaemonWorkerPool({
    name: 'rss-guard',
    kind: 'search',
    size: 1,
    workerScript,
    heapGuardBytes: 10,
    rssGuardBytes: 10,
    rssGuardStrikes: 1,
    env: { ...process.env },
  });
  try {
    await pool.warmup();
    await pool.run(
      { type: 'search' },
      {
        deadline: Date.now() + 1000,
        cancellationId: 'rss-guard',
      },
    );
    await waitFor(
      () =>
        pool.stats().lastRestartReason === 'rss guard exceeded (1000 > 10)' &&
        fs.readFileSync(warmupLog, 'utf8').trim().split('\n').filter(Boolean).length >= 2,
      // A worker restart + re-warmup is slow; give it headroom so a CPU-saturated full-suite run
      // (parallel test files) does not spuriously time this poll out.
      5000,
    );
    const warmups = fs.readFileSync(warmupLog, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(warmups.length >= 2);
    assert.equal(pool.stats().lastRestartReason, 'rss guard exceeded (1000 > 10)');
  } finally {
    await pool.close();
  }
});

test('search store loadVault preloads the active snapshot into search workers', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const calls = [];
  const pin = { snapshotId: 'snap-a', pinToken: 'pin-a' };
  const fakeStore = {
    loadVault: async () => ({
      ok: true,
      command: 'index',
      action: 'warm',
      vaults: [{ vaultRoot: vault, status: 'ready' }],
      snapshotId: 'snap-a',
    }),
    pin: async (inputVault, snapshotId) => {
      calls.push(['pin', inputVault, snapshotId]);
      return pin;
    },
    snapshotHandleForPin: (inputPin) => {
      calls.push(['handle', inputPin.pinToken]);
      return {
        snapshotId: 'snap-a',
        pinToken: inputPin.pinToken,
        bm25Stats: emptyBm25Stats(),
        documents: sharedHandle(Buffer.from('[]')),
        segments: [],
      };
    },
    release: (inputPin) => calls.push(['release', inputPin.pinToken]),
  };
  const fakeSearchExecution = {
    preloadSnapshot: async (snapshot, options, preloadOptions) => {
      calls.push(['preload', snapshot.snapshotId, options.vault, preloadOptions]);
      return [
        {
          snapshotId: snapshot.snapshotId,
          cacheHit: false,
          cache: {
            entries: 1,
            limit: 2,
            hits: 0,
            misses: 1,
            evictions: 0,
            preloads: 1,
            snapshotIds: [snapshot.snapshotId],
          },
        },
      ];
    },
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, {}, fakeSearchExecution, { queryCacheSize: 1 });

  const result = await service.loadVault(
    vault,
    {
      deadline: Date.now() + 1000,
      cancellationId: 'preload',
      requestId: 'preload',
    },
    {
      preload: { minimumWorkers: 1, backgroundRemaining: true },
    },
  );

  assert.equal(result.snapshotId, 'snap-a');
  assert.deepEqual(calls, [
    ['pin', vault, 'snap-a'],
    ['handle', 'pin-a'],
    ['preload', 'snap-a', vault, { minimumWorkers: 1, backgroundRemaining: true }],
    ['release', 'pin-a'],
  ]);
});

test('search store loadVault warms exact-bound cache for the query planner', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const { exactDominanceBoundForSearchHandle } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const { CanonicalSegmentPostingsReader } =
    await import('../src/core/search/retrieval/positional/segment-postings-reader.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'PlannerWarm.md', '# Planner Warm\n\nplannerwarmunique target plannerwarmunique\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-planner-warm',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  const pin = { snapshotId: snapshot.snapshotId, pinToken: snapshot.pinToken };
  const fakeStore = {
    loadVault: async () => ({
      ok: true,
      command: 'index',
      action: 'warm',
      vaults: [{ vaultRoot: vault, status: 'ready' }],
      snapshotId: snapshot.snapshotId,
    }),
    pin: async () => pin,
    snapshotHandleForPin: () => snapshot,
    release: () => {},
  };
  const fakeSearchExecution = {
    preloadSnapshot: async () => [
      {
        snapshotId: snapshot.snapshotId,
        cacheHit: false,
        cache: {
          entries: 1,
          limit: 2,
          hits: 0,
          misses: 1,
          evictions: 0,
          preloads: 1,
          snapshotIds: [snapshot.snapshotId],
        },
      },
    ],
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, {}, fakeSearchExecution, { queryCacheSize: 1 });

  await service.loadVault(vault, {
    deadline: Date.now() + 10_000,
    cancellationId: 'planner-bound-warm',
    requestId: 'planner-bound-warm',
  });

  let calls = 0;
  const originalPostingsForTerm = CanonicalSegmentPostingsReader.prototype.postingsForTerm;
  CanonicalSegmentPostingsReader.prototype.postingsForTerm = function patchedPostingsForTerm(term) {
    if (term.includes('plannerwarmunique')) calls += 1;
    return originalPostingsForTerm.call(this, term);
  };
  try {
    exactDominanceBoundForSearchHandle({
      search: normalizeSearchParams({ query: 'plannerwarmunique', limit: 10 }),
      snapshot,
      analysis: testQueryAnalysis('plannerwarmunique'),
    });
    assert.equal(calls, 0);
  } finally {
    CanonicalSegmentPostingsReader.prototype.postingsForTerm = originalPostingsForTerm;
  }
});

test('search store loadVault can skip search worker preload', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const calls = [];
  const fakeStore = {
    loadVault: async () => ({
      ok: true,
      command: 'index',
      action: 'warm',
      vaults: [{ vaultRoot: vault, status: 'ready' }],
      snapshotId: 'snap-a',
    }),
    pin: async () => {
      calls.push('pin');
      return { snapshotId: 'snap-a', pinToken: 'pin-a' };
    },
    snapshotHandleForPin: () => {
      calls.push('handle');
      return {
        snapshotId: 'snap-a',
        pinToken: 'pin-a',
        bm25Stats: emptyBm25Stats(),
        documents: sharedHandle(Buffer.from('[]')),
        segments: [],
      };
    },
    release: () => calls.push('release'),
  };
  const fakeSearchExecution = {
    preloadSnapshot: async () => {
      throw new Error('preload should be skipped');
    },
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, {}, fakeSearchExecution, { queryCacheSize: 1 });

  const result = await service.loadVault(
    vault,
    {
      deadline: Date.now() + 1000,
      cancellationId: 'preload-skip',
      requestId: 'preload-skip',
    },
    {
      preload: false,
    },
  );

  assert.equal(result.snapshotId, 'snap-a');
  assert.deepEqual(calls, []);
});

test('search store loadVault can warm the query analyzer alongside preload', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const calls = [];
  const pin = { snapshotId: 'snap-a', pinToken: 'pin-a' };
  const fakeStore = {
    loadVault: async () => ({
      ok: true,
      command: 'index',
      action: 'warm',
      vaults: [{ vaultRoot: vault, status: 'ready' }],
      snapshotId: 'snap-a',
    }),
    pin: async () => pin,
    snapshotHandleForPin: () => ({
      snapshotId: 'snap-a',
      pinToken: 'pin-a',
      bm25Stats: emptyBm25Stats(),
      documents: sharedHandle(Buffer.from('[]')),
      segments: [],
    }),
    release: () => {},
  };
  const fakeAnalyzer = {
    warmup: async (minimumReady) => {
      calls.push(['analyzer', minimumReady]);
    },
  };
  const fakeSearchExecution = {
    preloadSnapshot: async (snapshot, options, preloadOptions) => {
      calls.push(['preload', snapshot.snapshotId, options.vault, preloadOptions]);
      return [
        {
          snapshotId: snapshot.snapshotId,
          cacheHit: false,
          cache: {
            entries: 1,
            limit: 2,
            hits: 0,
            misses: 1,
            evictions: 0,
            preloads: 1,
            snapshotIds: [snapshot.snapshotId],
          },
        },
      ];
    },
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, {}, fakeSearchExecution, { queryCacheSize: 1 });

  await service.loadVault(
    vault,
    {
      deadline: Date.now() + 1000,
      cancellationId: 'preload-query-warmup',
      requestId: 'preload-query-warmup',
    },
    {
      preload: { minimumWorkers: 1 },
      warmupQueryAnalyzer: true,
    },
  );

  assert.deepEqual(
    calls.sort(),
    [
      ['analyzer', 1],
      ['preload', 'snap-a', vault, { minimumWorkers: 1 }],
    ].sort(),
  );
});

test('index rebuild defers retrieval vector build until lexical snapshot publish', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { createDaemonSnapshotStore, createProviderEmbeddingSetBuilder } =
    await import('../src/daemon/search-store/snapshot-store.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Parallel.md', '# Parallel\n\nalpha project\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const innerEmbedding = createProviderEmbeddingSetBuilder(new DeterministicHashProvider());
  const progress = [];
  let embeddingHasStarted = false;
  let resolveEmbeddingStarted;
  let resolvePublishBlocked;
  let releaseEmbedding;
  let releasePublish;
  const embeddingStarted = new Promise((resolve) => {
    resolveEmbeddingStarted = resolve;
  });
  const publishBlocked = new Promise((resolve) => {
    resolvePublishBlocked = resolve;
  });
  const embeddingReleased = new Promise((resolve) => {
    releaseEmbedding = resolve;
  });
  const publishReleased = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      analyzerIdentity: analyzer.identity,
      partitionBits: 1,
      snapshotBuilder: async () => built,
      embeddingSetBuilder: {
        providerIdentity: innerEmbedding.providerIdentity,
        build: async (input) => {
          embeddingHasStarted = true;
          resolveEmbeddingStarted();
          await embeddingReleased;
          return innerEmbedding.build(input);
        },
      },
      durableRenameLinkGraph: async (from, to) => {
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        if (path.basename(to) === built.linkGraphId) {
          resolvePublishBlocked();
          await publishReleased;
        }
        await fs.promises.rename(from, to);
      },
    }),
  );

  const rebuild = store.rebuild(vault, {
    progress: (update) => progress.push(update),
  });
  await publishBlocked;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(embeddingHasStarted, false, 'dense build must not start while lexical publish is blocked');
  releasePublish();
  await embeddingStarted;
  releaseEmbedding();
  const result = await rebuild;
  assert.equal(result.snapshotId, built.snapshotId);
  assert.ok(
    progress.some((update) => update.phase === 'publishing'),
    'publishing progress must be reported',
  );
  const embedding = progress.filter((update) => update.phase === 'embedding');
  assert.ok(embedding.length > 0, 'embedding progress must be reported');
  assert.equal(embedding.at(-1).completed, embedding.at(-1).total);
  const vectorIndexing = progress.filter((update) => update.phase === 'vector-indexing');
  assert.ok(vectorIndexing.length > 0, 'vector-indexing progress must be reported');
  assert.equal(vectorIndexing.at(-1).completed, vectorIndexing.at(-1).total);
});

test('search store service metadata path uses loaded documents for a pinned snapshot', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const analyzer = testAnalyzer();
  const pin = { snapshotId: 'snap-a', pinToken: 'pin-a' };
  const calls = [];
  const document = {
    documentId: 'doc-a',
    path: 'Alpha.md',
    contentHash: 'a'.repeat(64),
    partitionId: 1,
    title: 'Alpha Loaded',
    tags: ['alpha'],
    snippetCorpus: {
      bodyStartLine: 1,
      lines: [
        {
          line: 2,
          text: 'Loaded document body',
          snippetId: 'snippet-a',
          segmentId: 'segment-a',
          documentId: 'doc-a',
          byteStart: 0,
          byteEnd: 20,
          channels: { morph: ['loaded'], surface: [], ngram: [] },
        },
      ],
      fallback: { kind: 'line', snippetId: 'snippet-a' },
    },
  };
  const documents = new Map([[document.documentId, document]]);
  const fakeStore = {
    pin: async (inputVault, snapshotId) => {
      calls.push(['pin', inputVault, snapshotId]);
      return pin;
    },
    snapshotHandleForPin: (inputPin) => {
      calls.push(['handle', inputPin.pinToken]);
      return {
        snapshotId: 'snap-a',
        pinToken: inputPin.pinToken,
        bm25Stats: emptyBm25Stats(),
        documents: sharedHandle(Buffer.from('{not-json')),
        segments: [],
      };
    },
    documentsForPin: (inputPin) => {
      calls.push(['documents', inputPin.pinToken]);
      return documents;
    },
    release: (inputPin) => calls.push(['release', inputPin.pinToken]),
    searchAnalyzerIdentity: () => analyzer.identity,
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, {}, {}, { queryCacheSize: 1 });

  const result = await service.search(
    {
      vault,
      tags: ['alpha'],
      limit: 1,
    },
    {
      deadline: Date.now() + 1000,
      cancellationId: 'loaded-documents',
      requestId: 'loaded-documents',
    },
  );

  assert.equal(result.snapshotId, 'snap-a');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'Alpha.md');
  assert.equal(result.matches[0].title, 'Alpha Loaded');
  assert.equal(result.matches[0].snippets[0].text, 'Loaded document body');
  assert.deepEqual(calls, [
    ['pin', vault, undefined],
    ['handle', 'pin-a'],
    ['documents', 'pin-a'],
    ['release', 'pin-a'],
  ]);
});

test('search store service analyzes non-Hangul queries inline without warming Kiwi', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const analyzerIdentity = {
    name: 'router',
    version: 'test',
    runtime: 'node-intl',
    node: 'test',
    icu: 'test',
    model: 'kiwi-nlp:test',
    declaredAnalyzers: ['ko'],
    activeAnalyzers: ['ko'],
  };
  const fakeStore = {
    pin: async () => ({ snapshotId: 'snap-a', pinToken: 'pin-a' }),
    snapshotHandleForPin: () => ({
      snapshotId: 'snap-a',
      pinToken: 'pin-a',
      bm25Stats: emptyBm25Stats(),
      documents: sharedHandle(Buffer.from('[]')),
      segments: [],
    }),
    release: () => {},
    searchAnalyzerIdentity: () => analyzerIdentity,
  };
  let analyzerCalls = 0;
  const fakeAnalyzer = {
    analyzeQuery: async () => {
      analyzerCalls += 1;
      throw new Error('Kiwi analyzer should not be used for non-Hangul query');
    },
  };
  const fakeSearchExecution = {};
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, {}, fakeSearchExecution, { queryCacheSize: 4 });

  const result = await service.search(
    { vault, query: 'scifact evidence running studies', limit: 1, debug: true },
    { deadline: Date.now() + 1000, cancellationId: 'inline-query', requestId: 'inline-query' },
  );

  assert.equal(analyzerCalls, 0);
  assert.equal(result.debug.analyzer.name, 'router');
  assert.deepEqual(result.debug.analyzer.declaredAnalyzers, ['ko']);
  assert.deepEqual(result.debug.analyzer.activeAnalyzers, []);
  assert.equal(result.debug.analyzer.model, undefined);
  assert.equal(result.debug.query.raw, 'scifact evidence running studies');
  assert.ok(result.debug.query.terms.includes('scifact'));
});

test('search store service keeps Hangul query analysis on the analyzer worker', async () => {
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const vault = tempRoot();
  const analyzerIdentity = {
    name: 'router',
    version: 'test',
    runtime: 'node-intl',
    node: 'test',
    icu: 'test',
    model: 'kiwi-nlp:test',
    declaredAnalyzers: ['ko'],
    activeAnalyzers: ['ko'],
  };
  const fakeStore = {
    pin: async () => ({ snapshotId: 'snap-a', pinToken: 'pin-a' }),
    snapshotHandleForPin: () => ({
      snapshotId: 'snap-a',
      pinToken: 'pin-a',
      bm25Stats: emptyBm25Stats(),
      documents: sharedHandle(Buffer.from('[]')),
      segments: [],
    }),
    release: () => {},
    searchAnalyzerIdentity: () => analyzerIdentity,
  };
  let analyzerCalls = 0;
  const fakeAnalyzer = {
    analyzeQuery: async (raw) => {
      analyzerCalls += 1;
      return {
        analyzerIdentity,
        analysis: {
          raw,
          primaryChannel: 'morph',
          primaryTerms: ['한국어'],
          channels: { morph: ['한국어'], surface: ['한국어'], ngram: [] },
        },
      };
    },
  };
  const fakeSearchExecution = {};
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, {}, fakeSearchExecution, { queryCacheSize: 4 });

  const result = await service.search(
    { vault, query: '한국어 검색', limit: 1, debug: true },
    { deadline: Date.now() + 1000, cancellationId: 'hangul-query', requestId: 'hangul-query' },
  );

  assert.equal(analyzerCalls, 1);
  assert.deepEqual(result.debug.analyzer.activeAnalyzers, ['ko']);
  assert.deepEqual(result.debug.query.terms, ['한국어']);
});

test('search store service rejects excessive analyzed query terms per channel', async () => {
  const { UsageError } = await import('../src/errors.ts');
  const { DaemonSearchStoreService } = await import('../src/daemon/search-store/service.ts');
  const released = [];
  const fakeStore = {
    pin: async () => ({ snapshotId: 'snap-a', pinToken: 'pin-a' }),
    snapshotHandleForPin: () => ({
      snapshotId: 'snap-a',
      pinToken: 'pin-a',
      bm25Stats: emptyBm25Stats(),
      documents: sharedHandle(Buffer.from('[]')),
      segments: [],
    }),
    release: (pin) => {
      released.push(pin.pinToken);
    },
  };
  const tooManyTerms = Array.from({ length: 2049 }, (_, index) => `term-${index}`);
  const fakeAnalyzer = {
    analyzerIdentity: { name: 'test-analyzer', version: '1', node: 'test' },
    analyzeQuery: async (raw) => ({
      analyzerIdentity: { name: 'test-analyzer', version: '1', node: 'test' },
      analysis: {
        raw,
        primaryChannel: 'morph',
        primaryTerms: tooManyTerms,
        channels: { morph: tooManyTerms, surface: [], ngram: [] },
      },
    }),
  };
  const fakeSearchExecution = {
    preloadSnapshot: async () => [],
    search: async () => {
      throw new Error('search execution should not run after analysis cap failure');
    },
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, {}, fakeSearchExecution, { queryCacheSize: 1 });

  await assert.rejects(
    () =>
      service.search(
        { vault: tempRoot(), query: 'needle', limit: 1 },
        { deadline: Date.now() + 1000, cancellationId: 'ac-service-cap', requestId: 'ac-service-cap' },
      ),
    (error) => {
      assert.equal(error instanceof UsageError, true);
      assert.match(error.message, /too many morph terms \(2049; max 2048\)/);
      return true;
    },
  );
  assert.deepEqual(released, ['pin-a']);
});

test('AC3 daemon rejects malformed deadlines and payload shapes without dying', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const runtimeDir = tempRoot();
  const env = { ...process.env, OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    env,
    readyTimeoutMs: 5000,
  });

  const status = await client.status();
  const owner = status.owner;
  assert.ok(owner);

  try {
    const malformed = [
      {
        label: 'deadline-string',
        request: {
          protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
          requestId: 'deadline-string',
          method: 'Status',
          deadline: 'nope',
          payload: {},
        },
      },
      {
        label: 'deadline-infinity',
        request: {
          protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
          requestId: 'deadline-infinity',
          method: 'Status',
          deadline: Infinity,
          payload: {},
        },
      },
      {
        label: 'payload-null',
        request: {
          protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
          requestId: 'payload-null',
          method: 'Status',
          deadline: Date.now() + 1000,
          payload: null,
        },
      },
      {
        label: 'payload-array',
        request: {
          protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
          requestId: 'payload-array',
          method: 'Status',
          deadline: Date.now() + 1000,
          payload: [],
        },
      },
      {
        label: 'retrieve-primitive-payload',
        request: {
          protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
          requestId: 'retrieve-primitive-payload',
          method: 'Retrieve',
          incarnation: owner.incarnationId,
          deadline: Date.now() + 1000,
          payload: 1,
        },
      },
    ];

    for (const { label, request } of malformed) {
      const rejected = await requestRawRpc(owner.socketPath, encodeFrame, request);
      assert.equal(rejected.ok, false, label);
      assert.equal(rejected.error.code, 'BAD_REQUEST', label);

      const alive = await requestRawRpc(owner.socketPath, encodeFrame, statusRequest(`alive-${label}`));
      assert.equal(alive.ok, true, label);
      assert.equal(alive.result.ready, true, label);
    }
  } finally {
    await client.shutdown({ deadlineMs: 1000 }).catch(() => {});
  }
});

test('AC1 stale incarnations reject work while status handshakes and client retry resync stay live', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRecord, createOwnerRegistry, desiredOwnerIdentity, socketPathForOwner } =
    await import('../src/daemon/owner-registry.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const runtimeDir = tempRoot();
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(runtimeDir, 'cache'),
    XDG_CONFIG_HOME: path.join(runtimeDir, 'config'),
    OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
  };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    env,
    readyTimeoutMs: 30000,
  });

  try {
    const status = await client.status({ deadlineMs: 5000 });
    const owner = status.owner;
    assert.ok(owner);
    const wrongIncarnation = `${owner.incarnationId}-stale`;

    const staleSearch = await requestRawRpc(owner.socketPath, encodeFrame, {
      protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
      requestId: 'stale-search',
      method: 'Search',
      incarnation: wrongIncarnation,
      deadline: Date.now() + 1000,
      payload: { vault: tempRoot('optsidian-stale-incarnation-vault-'), query: 'alpha', limit: 1 },
    });
    assert.equal(staleSearch.ok, false);
    assert.equal(staleSearch.error.code, 'STALE_INCARNATION');
    assert.match(staleSearch.error.message, /incarnation is stale/);

    const staleStatus = await requestRawRpc(owner.socketPath, encodeFrame, {
      ...statusRequest('stale-status'),
      incarnation: wrongIncarnation,
    });
    assert.equal(staleStatus.ok, true);
    assert.equal(staleStatus.result.ready, true);
    assert.equal(staleStatus.result.incarnationId, owner.incarnationId);

    const absentWaitReady = await requestRawRpc(owner.socketPath, encodeFrame, {
      protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
      requestId: 'absent-wait-ready',
      method: 'WaitReady',
      deadline: Date.now() + 1000,
      payload: {},
    });
    assert.equal(absentWaitReady.ok, true);
    assert.equal(absentWaitReady.result.ready, true);
    assert.equal(absentWaitReady.result.incarnationId, owner.incarnationId);

    const staleWaitReady = await requestRawRpc(owner.socketPath, encodeFrame, {
      protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
      requestId: 'stale-wait-ready',
      method: 'WaitReady',
      incarnation: wrongIncarnation,
      deadline: Date.now() + 1000,
      payload: {},
    });
    assert.equal(staleWaitReady.ok, true);
    assert.equal(staleWaitReady.result.ready, true);
    assert.equal(staleWaitReady.result.incarnationId, owner.incarnationId);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }

  const retryRuntimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const desired = desiredOwnerIdentity(binaryPath);
  const retryRegistry = createOwnerRegistry({ runtimeDir: retryRuntimeDir, desired });
  const socketPath = socketPathForOwner(retryRuntimeDir, desired);
  const staleOwner = createOwnerRecord(desired, socketPath, 1, 'incarnation-stale', process.pid);
  const liveOwner = createOwnerRecord(desired, socketPath, 2, 'incarnation-live', process.pid);
  retryRegistry.writeOwner(staleOwner);
  const seen = [];
  let searchAttempts = 0;
  const retryClient = createSearchDaemonClient({
    registry: retryRegistry,
    binaryPath,
    spawnDaemon: async () => {
      throw new Error('retry fixture should reuse the published owner');
    },
    connect: async (record) => ({
      request: async (request) => {
        seen.push({ record, request });
        if (request.method === 'Status') return statusResult(record);
        assert.equal(request.method, 'Search');
        searchAttempts += 1;
        if (searchAttempts === 1) {
          assert.equal(request.incarnation, 'incarnation-stale');
          retryRegistry.writeOwner(liveOwner);
          throw Object.assign(new Error('search daemon incarnation is stale'), { code: 'STALE_INCARNATION' });
        }
        assert.equal(record.incarnationId, 'incarnation-live');
        assert.equal(request.incarnation, 'incarnation-live');
        return {
          ok: true,
          command: 'search',
          schemaVersion: 1,
          available: true,
          status: 'ready',
          snapshotId: 'snap-live',
          matches: [{ path: 'Live.md', snippets: [] }],
          results: [{ path: 'Live.md', score: 1, snippets: [] }],
        };
      },
      close: async () => {},
    }),
  });

  const result = await retryClient.search({ vault: retryRuntimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 });
  assert.equal(result.snapshotId, 'snap-live');
  assert.deepEqual(
    seen.map(({ request }) => request.method),
    ['Status', 'Search', 'Status', 'Search'],
  );
  assert.deepEqual(
    seen.filter(({ request }) => request.method === 'Search').map(({ request }) => request.incarnation),
    ['incarnation-stale', 'incarnation-live'],
  );
});

test('AC10 owner registry has no client-side control lock or time-stale reclaim path', async () => {
  const { createOwnerRegistry } = await import('../src/daemon/owner-registry.ts');
  const desired = {
    uid: process.getuid?.() ?? 0,
    runtimeHash: 'runtime-lock',
    binaryVersion: 'binary-lock',
    protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
  };
  const registry = createOwnerRegistry({ runtimeDir: tempRoot('optsidian-owner-v4-'), desired });
  assert.equal('lockPath' in registry, false);
  assert.equal('withControlLock' in registry, false);
});

test('AC8 snapshot tmp sweep removes only files aged at least five minutes', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const store = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));
  await store.loadVault(vault);

  const paths = searchStoreCachePaths(vault, env);
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  const oldTmp = path.join(paths.tmpDir, 'old.segment.tmp');
  const youngTmp = path.join(paths.tmpDir, 'young.segment.tmp');
  fs.writeFileSync(oldTmp, 'old');
  fs.writeFileSync(youngTmp, 'young');
  const now = Date.now();
  fs.utimesSync(oldTmp, new Date(now - 6 * 60_000), new Date(now - 6 * 60_000));
  fs.utimesSync(youngTmp, new Date(now - 60_000), new Date(now - 60_000));

  await store.compact(vault);

  await waitFor(() => !fs.existsSync(oldTmp));
  assert.equal(fs.existsSync(youngTmp), true);
});

test('search store persists cache directories and snapshot files privately', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Private.md', '# Private\n\ncache permissions\n');
  const store = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));

  await store.loadVault(vault);

  const paths = searchStoreCachePaths(vault, env);
  assertPrivateMode(path.join(cacheRoot, 'optsidian'), 0o700);
  assertPrivateMode(paths.searchRootDir, 0o700);
  assertPrivateMode(paths.storesDir, 0o700);
  assertPrivateMode(paths.rootDir, 0o700);
  assertPrivateMode(paths.storeStatePath, 0o600);
  assertPrivateMode(paths.segmentsDir, 0o700);
  assertPrivateMode(paths.snapshotsDir, 0o700);
  assertPrivateMode(paths.ledgersDir, 0o700);
  assertPrivateMode(paths.tmpDir, 0o700);

  const storeState = JSON.parse(fs.readFileSync(paths.storeStatePath, 'utf8'));
  assert.equal(storeState.schemaVersion, 1);
  assert.equal(storeState.storeId, paths.storeId);
  assert.equal(storeState.kind, 'search-store');
  assert.equal(typeof storeState.lastUsedAtMs, 'number');
  assert.equal(typeof storeState.lastIndexedAtMs, 'number');

  const edition = currentEdition(paths);
  const active = activeSnapshotFromEdition(paths);
  assertPrivateMode(
    path.join(paths.ledgersDir, edition.identity.embeddingSpaceId, 'publications', String(edition.editionSeq)),
    0o600,
  );
  const manifestPath = path.join(paths.snapshotsDir, active.snapshotId);
  const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertPrivateMode(manifestPath, 0o600);
  for (const partition of envelope.manifest.partitions) {
    assertPrivateMode(path.join(paths.segmentsDir, partition.segmentHash), 0o600);
  }
});

test('search cache catalog prunes stores by last-used time and skips loaded stores', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const oldVault = tempRoot();
  const loadedVault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(oldVault, 'Old.md', '# Old\n\nold cache\n');
  writeVaultFile(loadedVault, 'Loaded.md', '# Loaded\n\nloaded cache\n');
  const store = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));

  await store.loadVault(oldVault);
  await store.loadVault(loadedVault);
  const loadedPin = await store.pin(loadedVault);
  const nowMs = Date.now();
  const oldPaths = searchStoreCachePaths(oldVault, env);
  const loadedPaths = searchStoreCachePaths(loadedVault, env);
  ageSearchStore(oldPaths, nowMs, 45);
  ageSearchStore(loadedPaths, nowMs, 45);

  const dryRun = await store.prune({ unusedDays: 30, dryRun: true, nowMs });
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(
    dryRun.removedStores.map((entry) => entry.storeId),
    [oldPaths.storeId],
  );
  assert.equal(
    dryRun.skippedStores.some((entry) => entry.storeId === loadedPaths.storeId && entry.reason === 'protected'),
    true,
  );
  assert.equal(fs.existsSync(oldPaths.rootDir), true);

  const pruned = await store.prune({ unusedDays: 30, nowMs });
  assert.equal(pruned.dryRun, false);
  assert.deepEqual(
    pruned.removedStores.map((entry) => entry.storeId),
    [oldPaths.storeId],
  );
  assert.equal(fs.existsSync(oldPaths.rootDir), false);
  assert.equal(fs.existsSync(loadedPaths.rootDir), true);
  store.release(loadedPin);
});

test('search cache prune skips stores with a lifecycle mutation in progress', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Busy.md', '# Busy\n\ncache is rebuilding\n');
  let blockBuild = false;
  let buildStarted;
  let releaseBuild;
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env,
      analyzerIdentity: testAnalyzer().identity,
      snapshotBuilder: async (input) => {
        if (blockBuild) {
          buildStarted();
          await new Promise((resolve) => {
            releaseBuild = resolve;
          });
        }
        return buildCanonicalSearchSnapshot({
          ...input,
          analyzer: testAnalyzer(),
        });
      },
    }),
  );

  await store.loadVault(vault);
  const paths = searchStoreCachePaths(vault, env);
  const nowMs = Date.now();
  ageSearchStore(paths, nowMs, 45);
  blockBuild = true;
  const buildStartedPromise = new Promise((resolve) => {
    buildStarted = resolve;
  });
  const rebuild = store.rebuild(vault);
  await buildStartedPromise;

  const dryRun = await store.prune({ unusedDays: 30, dryRun: true, nowMs });
  assert.deepEqual(dryRun.removedStores, []);
  assert.equal(
    dryRun.skippedStores.some((entry) => entry.storeId === paths.storeId && entry.reason === 'protected'),
    true,
  );
  assert.equal(fs.existsSync(paths.rootDir), true);

  releaseBuild();
  await rebuild;
});

test('search cache prune falls back to mtimes when metadata JSON is corrupt', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Corrupt.md', '# Corrupt\n\nmetadata fallback\n');
  const store = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));

  await store.loadVault(vault);
  const paths = searchStoreCachePaths(vault, env);
  const nowMs = Date.now();
  const oldMs = nowMs - 45 * 24 * 60 * 60 * 1000;
  const oldDate = new Date(oldMs);
  fs.writeFileSync(paths.storeStatePath, '{', { mode: 0o600 });
  fs.writeFileSync(path.join(paths.searchRootDir, 'catalog.json'), '{', { mode: 0o600 });
  fs.utimesSync(paths.rootDir, oldDate, oldDate);

  const pruned = await store.prune({ unusedDays: 30, nowMs });
  assert.deepEqual(
    pruned.removedStores.map((entry) => entry.storeId),
    [paths.storeId],
  );
  assert.equal(fs.existsSync(paths.rootDir), false);
});

test('AC4 snapshot envelope stores runtime documents outside diagnostics', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const store = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));

  const first = await store.loadVault(vault);
  assert.equal(first.vaults[0].status, 'ready');

  const paths = searchStoreCachePaths(vault, env);
  const active = activeSnapshotFromEdition(paths);
  const manifestPath = path.join(paths.snapshotsDir, active.snapshotId);
  const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(Array.isArray(envelope.documents), true);
  assert.equal(envelope.documents.length, 1);
  assert.equal('documents' in envelope.diagnostics, false);
  assert.equal(envelope.diagnostics.analyzer.name, 'test-analyzer');

  const originalContentHash = envelope.documents[0].contentHash;
  envelope.documents[0].contentHash = '0'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(envelope)}\n`);

  const second = await store.loadVault(vault);
  assert.equal(second.vaults[0].status, 'ready');
  const repairedEnvelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(repairedEnvelope.documents[0].contentHash, originalContentHash);
  assert.equal('documents' in repairedEnvelope.diagnostics, false);
});

test('AC9 request scheduler caps remembered cancellations and detects post-task cancellation', async () => {
  const { createRequestScheduler } = await import('../src/daemon/scheduler.ts');
  const scheduler = createRequestScheduler();
  for (let index = 0; index < 4097; index += 1) scheduler.cancel(`cancel-${index}`);

  assert.equal(
    await scheduler.run({ deadline: Date.now() + 1000, cancellationId: 'cancel-0' }, async () => 'oldest-evicted'),
    'oldest-evicted',
  );
  await assert.rejects(
    () => scheduler.run({ deadline: Date.now() + 1000, cancellationId: 'cancel-4096' }, async () => 'newest-kept'),
    (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    },
  );

  const inFlight = createRequestScheduler();
  let releaseTask;
  const running = inFlight.run(
    { deadline: Date.now() + 1000, cancellationId: 'cancel-during-task' },
    async () =>
      new Promise((resolve) => {
        releaseTask = resolve;
      }),
  );
  inFlight.cancel('cancel-during-task');
  releaseTask('completed');
  await assert.rejects(
    () => running,
    (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    },
  );
});

test('AC7 snapshot GC keeps active snapshot segment files after count-cap eviction', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  writeVaultFile(vaultA, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  writeVaultFile(vaultB, 'Beta.md', '# Beta\n\nproject beta\n');
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env,
      analyzer: testAnalyzer(),
      countCap: 1,
      byteCap: 1024 * 1024,
    }),
  );

  await store.loadVault(vaultA);
  const pathsA = searchStoreCachePaths(vaultA, env);
  const activeA = activeSnapshotFromEdition(pathsA);
  const envelopeA = JSON.parse(fs.readFileSync(path.join(pathsA.snapshotsDir, activeA.snapshotId), 'utf8'));
  const segmentPathsA = envelopeA.manifest.partitions.map((partition) =>
    path.join(pathsA.segmentsDir, partition.segmentHash),
  );
  assert.ok(segmentPathsA.length > 0);
  for (const segmentPath of segmentPathsA) assert.equal(fs.existsSync(segmentPath), true);

  const pinA = await store.pin(vaultA);
  store.release(pinA);
  await store.loadVault(vaultB);
  const pinB = await store.pin(vaultB);
  store.release(pinB);

  for (const segmentPath of segmentPathsA) {
    assert.equal(fs.existsSync(segmentPath), true, `active segment was collected: ${segmentPath}`);
  }
});

// TODO: AC4 shutdown/removeOwner failure and AC12 owner cleanup on warmup failure
// require daemon construction hooks that are not exposed to tests without editing src/.

test('AC1 protocol method coverage is split by query and control capability', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRecord, createOwnerRegistry, desiredOwnerIdentity, socketPathForOwner } =
    await import('../src/daemon/owner-registry.ts');
  const { CONTROL_DAEMON_METHODS, QUERY_DAEMON_METHODS, SEARCH_DAEMON_PROTOCOL_VERSION } =
    await import('../src/daemon/protocol.ts');

  assert.deepEqual([...QUERY_DAEMON_METHODS].sort(), ['Retrieve', 'Search', 'Status', 'WaitReady']);
  assert.deepEqual([...CONTROL_DAEMON_METHODS].sort(), [
    'Clear',
    'Compact',
    'LoadVault',
    'Prune',
    'Rebuild',
    'Refresh',
    'Shutdown',
    'Status',
    'WaitReady',
  ]);
  for (const mutating of ['LoadVault', 'Rebuild', 'Refresh', 'Compact', 'Clear', 'Prune', 'Shutdown']) {
    assert.equal(QUERY_DAEMON_METHODS.includes(mutating), false);
    assert.equal(CONTROL_DAEMON_METHODS.includes(mutating), true);
  }
  assert.equal(Number.isInteger(SEARCH_DAEMON_PROTOCOL_VERSION), true);
  assert.equal(SEARCH_DAEMON_PROTOCOL_VERSION, 4);

  const runtimeDir = tempRoot();
  const desired = desiredOwnerIdentity(process.execPath);
  assert.equal(desired.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
  const socketPath = socketPathForOwner(runtimeDir, desired);
  assert.match(socketPath, /optsidian-search-daemon-v4-/);
  assert.doesNotMatch(socketPath, /optsidian-search-daemon-query-/);
  assert.doesNotMatch(socketPath, /optsidian-search-daemon-control-/);

  const registry = createOwnerRegistry({ runtimeDir, desired });
  const owner = createOwnerRecord(desired, socketPath, 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const requests = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath: process.execPath,
    connect: (record, capability) => ({
      async request(request) {
        requests.push({ record, capability, request });
        return statusResult(record);
      },
      async close() {},
    }),
  });
  await client.status({ deadlineMs: 100 });
  assert.equal(requests.length > 0, true);
  assert.equal(requests[0].record.slot.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
  assert.equal(requests[0].request.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
});

test('lifecycle deadlines scale with vault markdown count and bytes', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRegistry, desiredOwnerIdentity } = await import('../src/daemon/owner-registry.ts');
  const { SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS, vaultLifecycleDeadlineMs } =
    await import('../src/daemon/protocol.ts');
  const vault = tempRoot();
  const alpha = '# Alpha\n';
  const beta = `# Beta\n\n${'x'.repeat(1024 * 1024)}\n`;
  writeVaultFile(vault, 'Alpha.md', alpha);
  writeVaultFile(vault, 'nested/Beta.md', beta);
  fs.writeFileSync(path.join(vault, 'ignored.txt'), 'ignored');

  const requests = [];
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const registry = createOwnerRegistry({ runtimeDir, desired: desiredOwnerIdentity(binaryPath) });
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    spawnDaemon: async (record) => {
      publishFakeOwner(registry, record, 2100);
      return { pid: 2100 };
    },
    connect: async (record) => ({
      request: async (request) => {
        requests.push(request);
        if (request.method === 'Status') {
          return statusResult(record);
        }
        if (request.method === 'LoadVault') {
          return {
            ok: true,
            command: 'index',
            action: 'warm',
            vaults: [{ vaultRoot: vault, status: 'ready' }],
            snapshotId: 'snap-a',
          };
        }
        if (request.method === 'Search') {
          return {
            ok: true,
            command: 'search',
            schemaVersion: 1,
            available: true,
            status: 'ready',
            origin: 'text',
            matches: [],
            results: [],
            snapshotId: 'snap-a',
          };
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      close: async () => {},
    }),
  });

  const before = Date.now();
  await client.loadVault({ vault });
  const loadRequest = requests.find((request) => request.method === 'LoadVault');
  assert.ok(loadRequest);
  const expected = vaultLifecycleDeadlineMs(2, Buffer.byteLength(alpha) + Buffer.byteLength(beta));
  assert.ok(loadRequest.deadline >= before + expected - 100);
  assert.ok(loadRequest.deadline <= Date.now() + expected + 1000);

  await client.search({ vault, query: 'alpha', limit: 1 });
  const searchRequest = requests.find((request) => request.method === 'Search');
  assert.ok(searchRequest);
  assert.ok(searchRequest.deadline >= Date.now() + SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS - 1000);
});

test('daemon client sends prune as a global cache request', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRegistry, desiredOwnerIdentity } = await import('../src/daemon/owner-registry.ts');
  const requests = [];
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const registry = createOwnerRegistry({ runtimeDir, desired: desiredOwnerIdentity(binaryPath) });
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    spawnDaemon: async (record) => {
      publishFakeOwner(registry, record, 2200);
      return { pid: 2200 };
    },
    connect: async (record) => ({
      request: async (request) => {
        requests.push(request);
        if (request.method === 'Status') {
          return statusResult(record);
        }
        if (request.method === 'Prune') {
          return {
            ok: true,
            command: 'index',
            action: 'prune',
            dryRun: true,
            unusedDays: 30,
            cutoffAt: '2026-01-01T00:00:00.000Z',
            removedStores: [],
            skippedStores: [],
            removedBytes: 0,
          };
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      close: async () => {},
    }),
  });

  const result = await client.prune({ unusedDays: 30, dryRun: true });
  assert.equal(result.action, 'prune');
  const pruneRequest = requests.find((request) => request.method === 'Prune');
  assert.ok(pruneRequest);
  assert.deepEqual(pruneRequest.payload, { unusedDays: 30, dryRun: true });
});

test('snapshot build reports deterministic progress counts', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  writeVaultFile(vault, 'Beta.md', '# Beta\n\nproject beta\n');
  const progress = [];

  await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    progress: (update) => progress.push(update),
  });

  assert.equal(progress[0].phase, 'scanning');
  const scanning = progress.filter((update) => update.phase === 'scanning');
  assert.equal(scanning.at(-1).total, 2);
  assert.equal(scanning.at(-1).completed, 2);
  const parsing = progress.filter((update) => update.phase === 'parsing');
  assert.equal(parsing.at(-1).total, 2);
  assert.equal(parsing.at(-1).completed, 2);
  const segmenting = progress.filter((update) => update.phase === 'segmenting');
  assert.ok(segmenting.length > 0);
  assert.equal(segmenting.at(-1).completed, segmenting.at(-1).total);
});

test('snapshot build caps body ngram terms without capping metadata ngrams', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { BODY_NGRAM_SHORT_MAX_TERMS } = await import('../src/core/search/analysis/budget.ts');
  const { decodeCanonicalSegment } = await import('../src/core/search/segments/canonical.ts');
  const { POSITIONAL_FIELD_ID } = await import('../src/core/search/retrieval/positional/types.ts');
  const vault = tempRoot();
  const longHangul = Array.from({ length: BODY_NGRAM_SHORT_MAX_TERMS + 100 }, (_, index) =>
    String.fromCodePoint(0xac00 + index),
  ).join('');
  writeVaultFile(vault, 'Alpha.md', `# ${longHangul}\n\n${longHangul}\n`);

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    searchSettings: { ngram: true },
    partitionBits: 1,
  });
  const decoded = decodeCanonicalSegment(built.segments[0].bytes);
  const ngramFieldLength = (field) =>
    decoded.bm25.find((entry) => entry.channel === 'ngram' && entry.fieldId === POSITIONAL_FIELD_ID[field])
      ?.documentLengths[0]?.length ?? 0;

  assert.equal(ngramFieldLength('body'), BODY_NGRAM_SHORT_MAX_TERMS);
  assert.ok(ngramFieldLength('title') > BODY_NGRAM_SHORT_MAX_TERMS);
  assert.equal(built.identityTuple.analyzerIdentity.ngram.enabled, true);
  assert.equal(
    built.identityTuple.analyzerIdentity.ngram.bodyBudget.bodyNgramMaxTerms.short,
    BODY_NGRAM_SHORT_MAX_TERMS,
  );
});

test('snapshot build disables ngram tokens and identity by default', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { decodeCanonicalSegment } = await import('../src/core/search/segments/canonical.ts');
  const { POSITIONAL_FIELD_ID } = await import('../src/core/search/retrieval/positional/types.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# 한국어검색\n\n한국어검색 본문\n');

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
  });
  const decoded = decodeCanonicalSegment(built.segments[0].bytes);
  const ngramFieldLength = (field) =>
    decoded.bm25.find((entry) => entry.channel === 'ngram' && entry.fieldId === POSITIONAL_FIELD_ID[field])
      ?.documentLengths[0]?.length ?? 0;

  assert.equal(ngramFieldLength('title'), 0);
  assert.equal(ngramFieldLength('body'), 0);
  assert.equal(built.identityTuple.analyzerIdentity.ngram.enabled, false);
});

test('search execution state cache is scoped by immutable snapshot id, not request pin token', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '---\ntags: [alpha]\n---\n# Alpha\n\nproject alpha\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-a',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  const job = {
    vault,
    search: normalizeSearchParams({ query: 'alpha', limit: 10 }),
    analysis: testQueryAnalysis('alpha'),
    analyzerIdentity: analyzer.identity,
    snapshot,
  };

  const first = executeSearchJob(job);
  assert.deepEqual(
    first.matches.map((match) => match.path),
    ['Alpha.md'],
  );

  const corruptedSameSnapshot = {
    ...snapshot,
    pinToken: 'pin-b',
    segments: [{ segmentId: 'broken', partitionId: 0, bytes: sharedHandle(Buffer.from('not-a-canonical-segment')) }],
  };
  const second = executeSearchJob({ ...job, snapshot: corruptedSameSnapshot });
  assert.deepEqual(
    second.matches.map((match) => match.path),
    ['Alpha.md'],
  );
});

test('query execution shares postings cache between retrieval and feature scoring', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { exactDominanceBoundForSearchHandle, executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const { CanonicalSegmentPostingsReader } =
    await import('../src/core/search/retrieval/positional/segment-postings-reader.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'CacheProbe.md', '# Cache Probe Unique\n\ncacheprobeunique target cacheprobeunique\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-postings-cache',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  const search = normalizeSearchParams({ query: 'cacheprobeunique', limit: 10 });
  const analysis = testQueryAnalysis('cacheprobeunique');
  // Warm the snapshot-wide exact-bound cache so this probe isolates query-local retrieval and feature postings reads.
  exactDominanceBoundForSearchHandle({ search, snapshot, analysis });
  const calls = new Map();
  const originalPostingsForTerm = CanonicalSegmentPostingsReader.prototype.postingsForTerm;
  CanonicalSegmentPostingsReader.prototype.postingsForTerm = function patchedPostingsForTerm(term) {
    calls.set(term, (calls.get(term) ?? 0) + 1);
    return originalPostingsForTerm.call(this, term);
  };
  try {
    const result = executeSearchJob({
      vault,
      search,
      analysis,
      analyzerIdentity: analyzer.identity,
      snapshot,
    });

    assert.deepEqual(
      result.matches.map((match) => match.path),
      ['CacheProbe.md'],
    );
    assert.equal(calls.get('morph\u0000cacheprobeunique'), snapshot.segments.length);
    assert.equal(calls.get('surface\u0000cacheprobeunique'), snapshot.segments.length);
  } finally {
    CanonicalSegmentPostingsReader.prototype.postingsForTerm = originalPostingsForTerm;
  }
});

test('metadata-only search does not hydrate positional segments', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const vault = tempRoot();
  writeVaultFile(
    vault,
    'MetadataOnly.md',
    '---\ntags: [metadata-only]\n---\n# Metadata Only\n\nmetadata-only sentinel unique\n',
  );
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-a',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: [{ segmentId: 'broken', partitionId: 0, bytes: sharedHandle(Buffer.from('not-a-canonical-segment')) }],
  };

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ tags: ['metadata-only'], limit: 10 }),
    analyzerIdentity: analyzer.identity,
    snapshot,
  });

  assert.deepEqual(
    result.matches.map((match) => match.path),
    ['MetadataOnly.md'],
  );
});

test('search execution preload materializes snapshot cache before search', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { preloadSearchExecutionSnapshot, searchExecutionCacheStats } =
    await import('../src/daemon/search-execution.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-a',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  const warmed = preloadSearchExecutionSnapshot(snapshot);
  assert.equal(warmed.snapshotId, built.snapshotId);
  assert.equal(searchExecutionCacheStats().snapshotIds.includes(built.snapshotId), true);

  const second = preloadSearchExecutionSnapshot({
    ...snapshot,
    pinToken: 'pin-b',
    documents: sharedHandle(Buffer.from('{not-json')),
    segments: [],
  });
  assert.equal(second.cacheHit, true);
});

test('search execution preload warms exact-bound cache', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { exactDominanceBoundForSearchHandle, preloadSearchExecutionSnapshot } =
    await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const { CanonicalSegmentPostingsReader } =
    await import('../src/core/search/retrieval/positional/segment-postings-reader.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'BoundWarm.md', '# Bound Warm\n\npreloadboundunique target preloadboundunique\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-bound-warm',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  preloadSearchExecutionSnapshot(snapshot);

  let calls = 0;
  const originalPostingsForTerm = CanonicalSegmentPostingsReader.prototype.postingsForTerm;
  CanonicalSegmentPostingsReader.prototype.postingsForTerm = function patchedPostingsForTerm(term) {
    if (term.includes('preloadboundunique')) calls += 1;
    return originalPostingsForTerm.call(this, term);
  };
  try {
    exactDominanceBoundForSearchHandle({
      search: normalizeSearchParams({ query: 'preloadboundunique', limit: 10 }),
      snapshot,
      analysis: testQueryAnalysis('preloadboundunique'),
    });
    assert.equal(calls, 0);
  } finally {
    CanonicalSegmentPostingsReader.prototype.postingsForTerm = originalPostingsForTerm;
  }
});

test('search shard execution reuses preloaded segment readers', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { executeSearchShardJob, preloadSearchExecutionSnapshot } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nalpha target\n');
  writeVaultFile(vault, 'Beta.md', '# Beta\n\nalpha target beta\n');
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: 'pin-preloaded-shard',
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
  preloadSearchExecutionSnapshot(snapshot);

  const analysis = testQueryAnalysis('alpha');
  const search = normalizeSearchParams({ query: 'alpha', limit: 10 });
  const exactBound = { lexicalBound: 0, proximityBound: 0, lambdaExact: 0 };
  const corruptShardSnapshot = {
    ...snapshot,
    documents: sharedHandle(Buffer.from('[]')),
    segments: snapshot.segments.map((segment) => ({
      ...segment,
      bytes: sharedHandle(Buffer.from('not-a-canonical-segment')),
    })),
  };

  const result = executeSearchShardJob({
    vault,
    search,
    analysis,
    analyzerIdentity: analyzer.identity,
    snapshot: corruptShardSnapshot,
    exactBound,
    requestedLimit: search.limit,
    workEstimate: 1,
    deadline: Date.now() + 10_000,
    cancellationId: 'preloaded-shard-reader',
  });

  assert.equal(result.snapshotId, built.snapshotId);
  assert.ok(result.finalists.length > 0);
});

test('AC1 shared search-daemon client starts daemon, waits ready, and has no direct fallback', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRegistry, desiredOwnerIdentity } = await import('../src/daemon/owner-registry.ts');
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const registry = createOwnerRegistry({ runtimeDir, desired: desiredOwnerIdentity(binaryPath) });
  const calls = [];
  const spawns = [];
  const responses = [
    { method: 'Status', result: { ready: false, phase: 'starting' } },
    { method: 'WaitReady', result: { ready: true, phase: 'ready' } },
    {
      method: 'Search',
      result: {
        ok: true,
        command: 'search',
        schemaVersion: 1,
        available: true,
        status: 'ready',
        snapshotId: 'snap-a',
        matches: [{ path: 'Alpha.md', snippets: [] }],
        results: [{ path: 'Alpha.md', score: 1, snippets: [] }],
      },
    },
  ];

  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    spawnDaemon: async (record) => {
      spawns.push(publishFakeOwner(registry, record, 1001));
      return { pid: 1001 };
    },
    connect: async (record) => ({
      request: async (request) => {
        calls.push(request);
        const next = responses.shift();
        assert.equal(request.method, next.method);
        if (next.method === 'Search') assert.equal(request.incarnation, spawns[0].incarnationId);
        return request.method === 'Status' || request.method === 'WaitReady'
          ? statusResult(record, next.result)
          : next.result;
      },
      close: async () => {},
    }),
  });

  const result = await client.search({ vault: runtimeDir, query: 'alpha', limit: 5, deadlineMs: 1000 });

  assert.equal(spawns.length, 1);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['Status', 'WaitReady', 'Search'],
  );
  assert.equal(result.snapshotId, 'snap-a');
  assert.deepEqual(
    result.matches.map((match) => match.path),
    ['Alpha.md'],
  );

  const failing = createSearchDaemonClient({
    runtimeDir: tempRoot(),
    binaryPath: '/missing/optsidian',
    spawnDaemon: async () => {
      throw new Error('spawn denied');
    },
    connect: async () => {
      throw new Error('socket unavailable');
    },
  });
  await assert.rejects(
    () => failing.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 10 }),
    (error) => {
      assert.equal(error.code, 'SEARCH_DAEMON_UNAVAILABLE');
      assert.match(error.message, /search daemon/i);
      assert.match(error.message, /ready|start/i);
      assert.doesNotMatch(error.message, /fallback/i);
      return true;
    },
  );
});

test('daemon client sends incarnation on work requests and omits nonce from v4', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRegistry, desiredOwnerIdentity } = await import('../src/daemon/owner-registry.ts');
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const registry = createOwnerRegistry({ runtimeDir, desired: desiredOwnerIdentity(binaryPath) });
  const seen = [];
  const published = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    spawnDaemon: async (record) => {
      published.push(publishFakeOwner(registry, record, 2002));
      return { pid: 2002 };
    },
    connect: async (record) => ({
      request: async (request) => {
        seen.push(request);
        if (request.method === 'Status') {
          return statusResult(record);
        }
        assert.equal(request.method, 'Search');
        assert.equal(request.incarnation, published[0].incarnationId);
        assert.equal('nonce' in request, false);
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
      close: async () => {},
    }),
  });

  await client.search({ vault: runtimeDir, query: 'alpha', limit: 1 });
  assert.deepEqual(
    seen.map((request) => request.method),
    ['Status', 'Search'],
  );
  assert.equal('incarnation' in seen[0], false);
  assert.equal(seen[1].incarnation, published[0].incarnationId);
});

test('daemon client sends runtime profile per request even when owner is reused', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { createOwnerRegistry, desiredOwnerIdentity } = await import('../src/daemon/owner-registry.ts');
  const { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } = await import('../src/daemon/runtime-profile.ts');
  const runtimeDir = tempRoot();
  const configHome = tempRoot('optsidian-profile-config-');
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const spawns = [];
  const searchRequests = [];
  const baseEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
  };
  const registry = createOwnerRegistry({ runtimeDir, desired: desiredOwnerIdentity(binaryPath) });
  const connect = async (record) => ({
    request: async (request) => {
      if (request.method === 'Status') {
        return statusResult(record);
      }
      assert.equal(request.method, 'Search');
      searchRequests.push(request);
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
    close: async () => {},
  });
  const noKiwi = createSearchDaemonClient({
    registry,
    binaryPath,
    env: { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: '' },
    spawnDaemon: async (record) => {
      spawns.push(publishFakeOwner(registry, record, 3001));
      return { pid: 3001 };
    },
    connect,
  });
  const kiwi = createSearchDaemonClient({
    registry,
    binaryPath,
    env: { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: 'ko' },
    spawnDaemon: async (record) => {
      spawns.push(record);
      return { pid: 3002 };
    },
    connect,
  });

  await noKiwi.search({ vault: runtimeDir, query: 'alpha', limit: 1 });
  await kiwi.search({ vault: runtimeDir, query: '한국어', limit: 1 });

  assert.equal(spawns.length, 1);
  assert.equal(searchRequests.length, 2);
  assert.deepEqual(searchRequests[0].payload.profile.analyzer.extraLangs, []);
  assert.deepEqual(searchRequests[1].payload.profile.analyzer.extraLangs, ['ko']);
  assert.equal(searchRequests[0].payload.profile.index.ngram, false);
  assert.equal(searchRequests[1].payload.profile.index.ngram, false);
  const noProfile = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: '' });
  const kiwiProfile = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: 'ko' });
  assert.notEqual(searchRuntimeProfileHash(noProfile), searchRuntimeProfileHash(kiwiProfile));
  assert.notEqual(
    searchRuntimeProfileHash(searchRequests[0].payload.profile),
    searchRuntimeProfileHash(searchRequests[1].payload.profile),
  );
});

test('profile manager keeps idle runtimes resident after request release', async () => {
  const { ProfileManager } = await import('../src/daemon/profile-manager.ts');
  const { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } = await import('../src/daemon/runtime-profile.ts');
  const configHome = tempRoot('optsidian-profile-idle-config-');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '30',
  };
  const profile = effectiveSearchRuntimeProfile(repoRoot, env);
  const profileHash = searchRuntimeProfileHash(profile);
  const manager = new ProfileManager(env);

  try {
    await manager.withRuntimeFor({ profile }, async (runtime) => {
      assert.equal(runtime.profileHash, profileHash);
      assert.equal(runtime.profile.daemon.idleMs, 30);
    });
    const active = await manager.status({ deadline: Date.now() + 1000, cancellationId: 'profile-status-active' });
    assert.ok(active[profileHash]);
    assert.equal(active[profileHash].activeRequests, 0);
    // AC11 removed daemon/profile idle unload; zero-footprint-at-rest applies
    // to the model session, not the resident daemon runtime.
    assert.equal(active[profileHash].idleDeadline, undefined);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const idle = await manager.status({ deadline: Date.now() + 1000, cancellationId: 'profile-status-idle' });
    assert.ok(idle[profileHash]);
    assert.equal(idle[profileHash].activeRequests, 0);
    assert.equal(idle[profileHash].idleDeadline, undefined);
  } finally {
    await manager.close();
  }
});

test('profile runtime cancellation reaches query scheduler and worker pools', async () => {
  const { ProfileRuntime } = await import('../src/daemon/profile-manager.ts');
  const calls = [];
  const runtime = Object.create(ProfileRuntime.prototype);
  runtime.searchStore = {
    cancel: (cancellationId) => calls.push(`searchStore:${cancellationId}`),
  };
  runtime.pools = {
    cancel: (cancellationId) => calls.push(`pools:${cancellationId}`),
  };
  runtime.embedScheduler = {
    cancel: (cancellationId) => calls.push(`embedScheduler:${cancellationId}`),
  };

  runtime.cancel('cancel-query');

  assert.deepEqual(calls, ['searchStore:cancel-query', 'pools:cancel-query', 'embedScheduler:cancel-query']);
});

test('profile manager rejects remembered cancellation before runtime acquisition', async () => {
  const { ProfileManager } = await import('../src/daemon/profile-manager.ts');
  const manager = new ProfileManager({
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-precancel-config-'),
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
  });

  try {
    manager.cancel('cancel-before-runtime');
    await assert.rejects(
      manager.withRuntimeFor(
        {},
        async () => {
          throw new Error('cancelled runtime acquisition should not run user work');
        },
        { cancellationId: 'cancel-before-runtime' },
      ),
      (error) => {
        assert.equal(error.code, 'CANCELLED');
        return true;
      },
    );
    assert.deepEqual(
      await manager.status({ deadline: Date.now() + 1000, cancellationId: 'status-after-precancel' }),
      {},
    );
  } finally {
    await manager.close();
  }
});

test('profile manager keeps no-Kiwi and Kiwi runtimes isolated', async () => {
  const { ProfileManager } = await import('../src/daemon/profile-manager.ts');
  const { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } = await import('../src/daemon/runtime-profile.ts');
  const configHome = tempRoot('optsidian-profile-isolation-config-');
  const baseEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
  };
  const noKiwi = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: '' });
  const kiwi = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: 'ko' });
  const noKiwiHash = searchRuntimeProfileHash(noKiwi);
  const kiwiHash = searchRuntimeProfileHash(kiwi);
  const manager = new ProfileManager({ ...baseEnv, OPTSIDIAN_SEARCH_EXTRA_LANGS: '' });

  try {
    await manager.withRuntimeFor({ profile: noKiwi }, async (runtime) => {
      assert.equal(runtime.profileHash, noKiwiHash);
      assert.deepEqual(runtime.profile.analyzer.extraLangs, []);
    });
    await manager.withRuntimeFor({ profile: kiwi }, async (runtime) => {
      assert.equal(runtime.profileHash, kiwiHash);
      assert.deepEqual(runtime.profile.analyzer.extraLangs, ['ko']);
    });
    const status = await manager.status({ deadline: Date.now() + 1000, cancellationId: 'profile-isolation-status' });
    assert.deepEqual(Object.keys(status).sort(), [kiwiHash, noKiwiHash].sort());
    assert.deepEqual(status[noKiwiHash].profile.analyzer.extraLangs, []);
    assert.deepEqual(status[kiwiHash].profile.analyzer.extraLangs, ['ko']);
  } finally {
    await manager.close();
  }
});

test('runtime profile canonicalizes extra language payloads', async () => {
  const { effectiveSearchRuntimeProfile, normalizeSearchRuntimeProfile, searchRuntimeProfileHash } =
    await import('../src/daemon/runtime-profile.ts');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-canonical-config-'),
    OPTSIDIAN_SEARCH_EXTRA_LANGS: 'ko,zh',
  };
  const canonical = effectiveSearchRuntimeProfile(repoRoot, env);
  const messy = normalizeSearchRuntimeProfile({
    ...canonical,
    analyzer: {
      ...canonical.analyzer,
      extraLangs: [' KO ', 'zh', 'ko', ' '],
    },
  });

  assert.deepEqual(messy.analyzer.extraLangs, ['ko', 'zh']);
  assert.equal(searchRuntimeProfileHash(messy), searchRuntimeProfileHash(canonical));
});

test('runtime profile defaults query-analysis cache to 64 and allows disabling it', async () => {
  const { effectiveSearchRuntimeProfile } = await import('../src/daemon/runtime-profile.ts');

  assert.equal(effectiveSearchRuntimeProfile(repoRoot, {}, {}).cache.queryAnalysisEntries, 64);
  assert.equal(
    effectiveSearchRuntimeProfile(repoRoot, { OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE: '0' }, {}).cache.queryAnalysisEntries,
    0,
  );
  assert.equal(
    effectiveSearchRuntimeProfile(repoRoot, {}, { search: { queryCacheSize: 0 } }).cache.queryAnalysisEntries,
    0,
  );
});

test('runtime profile maps single worker setting to search execution only', async () => {
  const { effectiveSearchRuntimeProfile, envForSearchRuntimeProfile } =
    await import('../src/daemon/runtime-profile.ts');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-workers-config-'),
    OPTSIDIAN_SEARCH_WORKERS: '3',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: undefined,
    OPTSIDIAN_SEARCH_INDEX_WORKERS: undefined,
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: undefined,
  };
  const profile = effectiveSearchRuntimeProfile(repoRoot, env);
  assert.equal(profile.workers.query, 1);
  assert.equal(profile.workers.index, 1);
  assert.equal(profile.workers.searchExecution, 3);

  const projected = envForSearchRuntimeProfile(profile, {});
  assert.equal(projected.OPTSIDIAN_SEARCH_WORKERS, '3');
  assert.equal(projected.OPTSIDIAN_SEARCH_EXECUTION_WORKERS, '3');
  assert.equal(projected.OPTSIDIAN_SEARCH_QUERY_WORKERS, '1');
  assert.equal(projected.OPTSIDIAN_SEARCH_INDEX_WORKERS, '1');
});

test('runtime profile uses search.executionWorkers setting below worker env overrides', async () => {
  const { effectiveSearchRuntimeProfile } = await import('../src/daemon/runtime-profile.ts');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-execution-workers-config-'),
    OPTSIDIAN_SEARCH_WORKERS: undefined,
    OPTSIDIAN_SEARCH_QUERY_WORKERS: undefined,
    OPTSIDIAN_SEARCH_INDEX_WORKERS: undefined,
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: undefined,
  };

  assert.equal(
    effectiveSearchRuntimeProfile(repoRoot, env, { search: { executionWorkers: 8 } }).workers.searchExecution,
    8,
  );
  assert.equal(
    effectiveSearchRuntimeProfile(
      repoRoot,
      { ...env, OPTSIDIAN_SEARCH_WORKERS: '6' },
      { search: { executionWorkers: 8 } },
    ).workers.searchExecution,
    6,
  );
  assert.equal(
    effectiveSearchRuntimeProfile(
      repoRoot,
      { ...env, OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '7' },
      { search: { executionWorkers: 8 } },
    ).workers.searchExecution,
    7,
  );
});

test('runtime profile tracks ngram as an index-affecting setting', async () => {
  const { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } = await import('../src/daemon/runtime-profile.ts');
  const baseEnv = {
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-ngram-config-'),
  };
  const disabled = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_NGRAM: 'false' });
  const enabled = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_NGRAM: 'true' });

  assert.equal(disabled.index.ngram, false);
  assert.equal(enabled.index.ngram, true);
  assert.notEqual(searchRuntimeProfileHash(disabled), searchRuntimeProfileHash(enabled));
});

test('runtime profile folds partitionBits into the lexical store identity from one source', async () => {
  const { effectiveSearchRuntimeProfile, lexicalIdentityHashForSearchRuntimeProfile } =
    await import('../src/daemon/runtime-profile.ts');
  const baseEnv = {
    ...process.env,
    XDG_CONFIG_HOME: tempRoot('optsidian-profile-partitionbits-config-'),
  };
  const fourBits = effectiveSearchRuntimeProfile(repoRoot, baseEnv);
  const eightBits = effectiveSearchRuntimeProfile(repoRoot, { ...baseEnv, OPTSIDIAN_SEARCH_PARTITION_BITS: '8' });

  // Production default is unchanged (4), so identity is preserved from the value's standpoint.
  assert.equal(fourBits.index.partitionBits, 4);
  assert.equal(eightBits.index.partitionBits, 8);
  // partitionBits must flow into the store-dir identity hash — a change reroutes the lexical store.
  // This fails if a future edit reintroduces a hardcoded DEFAULT_PARTITION_BITS in the hash.
  assert.notEqual(
    lexicalIdentityHashForSearchRuntimeProfile(fourBits),
    lexicalIdentityHashForSearchRuntimeProfile(eightBits),
  );
});

test('daemon readiness handshake publishes protocol-v4 tenancy status over RPC integration', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const runtimeDir = tempRoot();
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
  };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });

  try {
    const status = await client.status({ deadlineMs: 5000 });

    assert.equal(status.ok, true);
    assert.equal(status.ready, true);
    assert.equal(status.protocolVersion, CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION);
    assert.equal(status.phase, 'ready');
    assert.equal(Number.isInteger(status.epoch), true);
    assert.equal(typeof status.incarnationId, 'string');
    assert.equal(status.owner.incarnationId, status.incarnationId);
    assert.equal(status.owner.socketPath, status.socketPath);
    assert.equal(status.socketPath.endsWith('.sock'), true);
    assert.equal('nonce' in status, false);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }
});

test('daemon Status returns one protocol-v4 shape without nonce', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { encodeFrame } = await import('../src/daemon/protocol.ts');
  const runtimeDir = tempRoot();
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
  };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });

  try {
    const authenticated = await client.status({ deadlineMs: 5000 });
    const response = await requestRawRpc(authenticated.owner.socketPath, encodeFrame, {
      protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
      requestId: 'single-status',
      method: 'Status',
      deadline: Date.now() + 1000,
      payload: {},
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.ok, true);
    assert.equal(response.result.ready, true);
    assert.equal(response.result.phase, 'ready');
    assert.equal(response.result.protocolVersion, CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION);
    assert.equal('nonce' in response.result, false);
    assert.equal(response.result.incarnationId, authenticated.incarnationId);
    assert.equal(response.result.owner.socketPath, authenticated.socketPath);
    assert.equal('metrics' in response.result, true);
    assert.equal('pools' in response.result, true);
    assert.equal('searchStore' in response.result, true);
    assert.equal('profiles' in response.result, true);
    assert.equal('vaults' in response.result, true);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }
});

test('daemon idle shutdown uses configured timeout and next client call auto-boots', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const runtimeDir = tempRoot();
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '50',
  };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });

  const first = await client.status({ deadlineMs: 5000 });
  assert.equal(first.ready, true);
  const firstPid = first.owner.pid;
  await waitFor(() => !pidIsLive(firstPid), 5000);

  const second = await client.status({ deadlineMs: 5000 });
  try {
    assert.equal(second.ready, true);
    assert.equal(pidIsLive(second.owner.pid), true);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }
});

test('daemon boot recovery sweeps orphan vector and search staging tmp', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { effectiveSearchRuntimeProfile, searchRuntimeProfileHash } = await import('../src/daemon/runtime-profile.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { vectorStoreCachePaths } = await import('../src/daemon/vector-store/cache-paths.ts');
  const runtimeDir = tempRoot();
  const cacheRoot = tempRoot('optsidian-boot-recovery-cache-');
  const vault = tempRoot('optsidian-boot-recovery-vault-');
  fs.writeFileSync(path.join(vault, 'Recovery.md'), 'recovery\n');
  const env = {
    ...process.env,
    XDG_CACHE_HOME: cacheRoot,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
  };
  const profileHash = searchRuntimeProfileHash(effectiveSearchRuntimeProfile(repoRoot, env));
  const vectorPaths = vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash,
    embeddingSetId: 'boot-embedding',
    env,
  });
  const searchPaths = searchStoreCachePaths(vault, env);
  fs.mkdirSync(vectorPaths.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(vectorPaths.stagingDir, 'orphan.vector'), 'x');
  fs.mkdirSync(searchPaths.tmpDir, { recursive: true });
  fs.writeFileSync(path.join(searchPaths.tmpDir, 'orphan.lexical'), 'x');
  fs.writeFileSync(path.join(searchPaths.tmpDir, 'orphan.link-graph'), 'x');

  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });
  try {
    const status = await client.status({ deadlineMs: 5000 });
    assert.equal(status.ready, true);
    await waitFor(() => {
      return (
        fs.existsSync(vectorPaths.stagingDir) &&
        fs.readdirSync(vectorPaths.stagingDir).length === 0 &&
        fs.existsSync(searchPaths.tmpDir) &&
        fs.readdirSync(searchPaths.tmpDir).length === 0
      );
    }, 5000);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }
});

test('AC1 import boundary forbids direct search/index execution outside daemon and pure tests', () => {
  const scannedRoots = ['src', 'scripts'].map((root) => path.join(repoRoot, root));
  const files = scannedRoots.flatMap((root) => listFiles(root, (filePath) => /\.(?:ts|mts|mjs|js)$/.test(filePath)));
  const violations = [];

  for (const file of files) {
    const rel = repoRelative(file);
    if (rel.startsWith('src/daemon/') || rel.startsWith('src/core/search/')) continue;

    const source = fs.readFileSync(file, 'utf8');
    const importedSymbols = importedSearchExecutionSymbols(source);
    if (importedSymbols.length === 0) continue;

    for (const match of source.matchAll(/\b(?:import|export)\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)) {
      const resolved = resolveSpecifier(file, match[2]);
      if (/src\/core\/search\/index\.(?:js|ts)$/.test(resolved)) {
        violations.push(`${rel}: direct ${importedSymbols.join(', ')} import from ${match[2]}`);
      }
    }
    for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (/src\/core\/search\/index\.(?:js|ts)$/.test(resolved)) {
        violations.push(`${rel}: dynamic direct ${importedSymbols.join(', ')} import from ${match[1]}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('AC9 canonical segment bytes and snapshot id are history-independent', async () => {
  const { buildCanonicalSnapshotForTests } = await import('../src/core/search/segments/canonical.ts');
  const { canonicalValueBytes } = await import('../src/core/search/segments/canonical.ts');
  const { RANKING_CONSTANTS } = await import('../src/core/search/constants.ts');
  const { BODY_INDEX_BUDGET_IDENTITY } = await import('../src/core/search/analysis/budget.ts');
  const identityTuple = {
    buildVersion: 'positional-build-v1',
    fieldSetVersion: 'field-set-v1',
    partitionBits: 4,
    analyzerIdentity: {
      name: 'router',
      channels: ['morph', 'surface', 'ngram'],
      ngram: { min: 2, max: 3, bodyBudget: BODY_INDEX_BUDGET_IDENTITY },
    },
    searchSettingsHash: sha256('index-affecting-settings-only'),
    rankingFeatureVersion: sha256(canonicalValueBytes(RANKING_CONSTANTS)),
    retrieverIdentity: null,
  };
  const documents = [
    { path: 'Alpha.md', content: '# Alpha\n\nproject alpha\n' },
    { path: 'Folder/Beta.md', content: '# Beta\n\nproject beta\n' },
  ];

  const rebuilt = await buildCanonicalSnapshotForTests({ identityTuple, documents, history: [{ type: 'rebuild' }] });
  const rebuiltAgain = await buildCanonicalSnapshotForTests({
    identityTuple,
    documents,
    history: [{ type: 'rebuild' }],
  });
  const refreshedCompacted = await buildCanonicalSnapshotForTests({
    identityTuple,
    documents,
    history: [
      { type: 'refresh', paths: ['Alpha.md'] },
      { type: 'refresh', paths: ['Folder/Beta.md'] },
      { type: 'compact' },
    ],
  });

  for (const snapshot of [rebuilt, rebuiltAgain, refreshedCompacted]) {
    assert.equal(snapshot.snapshotId, sha256(asBytes(snapshot.canonicalManifestBytes)));
    assert.deepEqual(snapshot.manifest.identityTuple, identityTuple);
    assert.match(snapshot.manifest.liveDocumentManifestHash, /^[a-f0-9]{64}$/);
    assert.match(snapshot.manifest.tombstoneHash, /^[a-f0-9]{64}$/);
    assert.ok(snapshot.manifest.partitions.every((partition) => /^[a-f0-9]{64}$/.test(partition.segmentHash)));
    assert.ok(snapshot.manifest.partitions.every((partition) => Number.isInteger(partition.partitionId)));
  }

  assert.equal(rebuilt.snapshotId, rebuiltAgain.snapshotId);
  assert.equal(rebuilt.snapshotId, refreshedCompacted.snapshotId);
  assert.deepEqual(
    rebuilt.segments.map((segment) => Buffer.from(segment.bytes).toString('hex')),
    rebuiltAgain.segments.map((segment) => Buffer.from(segment.bytes).toString('hex')),
  );
  assert.deepEqual(
    rebuilt.segments.map((segment) => Buffer.from(segment.bytes).toString('hex')),
    refreshedCompacted.segments.map((segment) => Buffer.from(segment.bytes).toString('hex')),
  );
});

test('golden ranking identity is derived from canonical RANKING_CONSTANTS bytes', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { canonicalValueBytes } = await import('../src/core/search/segments/canonical.ts');
  const { RANKING_CONSTANTS } = await import('../src/core/search/constants.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nNeedle project alpha\n');

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
  });
  const expected = sha256(canonicalValueBytes(RANKING_CONSTANTS));

  assert.equal(built.identityTuple.rankingFeatureVersion, expected);
  assert.equal(built.manifest.identityTuple.rankingFeatureVersion, expected);
});

test('snapshot identity carries the production INDEX_BUILD_VERSION lever', async () => {
  const { buildCanonicalSearchSnapshot, INDEX_BUILD_VERSION } = await import('../src/daemon/search-store/builder.ts');
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nNeedle project alpha\n');

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
  });

  assert.equal(built.identityTuple.buildVersion, INDEX_BUILD_VERSION);
  assert.equal(built.manifest.identityTuple.buildVersion, INDEX_BUILD_VERSION);
});

test('AC7 rebuild during an in-flight search keeps the pinned snapshot stable', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer: testAnalyzer(),
      countCap: 4,
      byteCap: 1024 * 1024,
    }),
  );

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const pinnedSnapshotId = pin.snapshotId;
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha changed\n');
  const rebuilt = await store.rebuild(vault);

  assert.notEqual(rebuilt.snapshotId, pinnedSnapshotId);
  assert.equal(pin.snapshotId, pinnedSnapshotId);
  assert.equal(store.snapshotHandleForPin(pin).snapshotId, pinnedSnapshotId);
  store.release(pin);
});

test('AC8 daemon restart reloads latest valid persisted snapshot with identity preserved', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');

  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const firstStore = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));
  const first = await firstStore.loadVault(vault);
  const firstSnapshotId = first.snapshotId;
  assert.match(firstSnapshotId, /^[a-f0-9]{64}$/);

  const restartedStore = createDaemonSnapshotStore(snapshotStoreOptions({ env, analyzer: testAnalyzer() }));
  const restarted = await restartedStore.loadVault(vault);
  assert.equal(restarted.snapshotId, firstSnapshotId);
});

test('AC11 cross-vault count budget evicts cold snapshots and reloads on demand', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  writeVaultFile(vaultA, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  writeVaultFile(vaultB, 'Beta.md', '# Beta\n\nproject beta\n');
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer: testAnalyzer(),
      countCap: 1,
      byteCap: 1024 * 1024,
    }),
  );

  const first = await store.loadVault(vaultA);
  const pinA = await store.pin(vaultA);
  assert.equal(pinA.snapshotId, first.snapshotId);
  store.release(pinA);
  await store.loadVault(vaultB);
  assert.ok(store.statsForTests().loadedSnapshots <= 1);

  const reloadedA = await store.pin(vaultA);
  assert.equal(reloadedA.snapshotId, first.snapshotId);
  assert.ok(store.statsForTests().loadedSnapshots <= 1);
  store.release(reloadedA);
});

test('snapshot pin survives snapshots larger than the byte budget', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Large.md', `# Large\n\n${'needle '.repeat(4096)}\n`);
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer: testAnalyzer(),
      countCap: 4,
      byteCap: 1,
    }),
  );

  const loaded = await store.loadVault(vault);
  const pin = await store.pin(vault);
  try {
    assert.equal(pin.snapshotId, loaded.snapshotId);
    assert.equal(store.snapshotHandleForPin(pin).snapshotId, loaded.snapshotId);
  } finally {
    store.release(pin);
  }
});

test('AC4 snippets resolve from the pinned snapshot without rereading vault files or tokenizing lines', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nfirst line\nNeedle channel target\n');
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer,
      countCap: 4,
      byteCap: 1024 * 1024,
    }),
  );

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const payload = store.snapshotHandleForPin(pin);
  const payloadDocuments = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(payload.documents.buffer, payload.documents.byteOffset, payload.documents.byteLength),
    ),
  );
  const snippetLines = payloadDocuments.flatMap((document) => document.snippetCorpus.lines);
  assert.ok(snippetLines.some((line) => line.segmentId && line.snippetId && line.byteEnd >= line.byteStart));
  assert.ok(snippetLines.some((line) => line.channels.morph.includes('needle')));
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nSHOULD NOT BE READ\n');

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(file, ...rest) {
    if (String(file).startsWith(vault)) throw new Error('AC4 violation: query-time vault read');
    return originalReadFileSync.call(this, file, ...rest);
  };
  try {
    const result = executeSearchJob({
      vault,
      search: normalizeSearchParams({ query: 'needle', limit: 3, debug: true }),
      analysis: {
        raw: 'needle',
        primaryChannel: 'morph',
        primaryTerms: ['needle'],
        channels: { morph: ['needle'], surface: ['needle'], ngram: [] },
      },
      analyzerIdentity: analyzer.identity,
      snapshot: payload,
    });
    assert.equal(result.snapshotId, pin.snapshotId);
    assert.equal(result.matches[0]?.path, 'Alpha.md');
    assert.deepEqual(
      result.matches[0].snippets.map((snippet) => snippet.text),
      ['Needle channel target'],
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    store.release(pin);
  }
});

test('AC5 concurrent identical searches on one pinned snapshot return identical paths and snippets', async () => {
  const fixture = await createPinnedSearchFixture(
    {
      'Alpha.md': '# Alpha\n\nNeedle channel target\n',
      'Beta.md': '# Beta\n\nNeedle channel target beta\n',
      'Gamma.md': '# Gamma\n\nOther content\n',
    },
    { query: 'needle', limit: 5 },
  );

  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve().then(() => fixture.search())));
    const baseline = searchIdentityPayload(results[0]);
    assert.ok(baseline.length >= 2);
    for (const result of results) {
      assert.deepEqual(searchIdentityPayload(result), baseline);
    }
  } finally {
    fixture.release();
  }
});

test('AC6 concurrent scoring order equals sequential scoring order on one pinned snapshot', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `Doc-${index}.md`,
      `# Doc ${index}\n\nNeedle project ${index % 2 === 0 ? 'alpha' : 'beta'} needle ${index}\n`,
    ]),
  );
  const fixture = await createPinnedSearchFixture(files, { query: 'needle project', limit: 8 });

  try {
    const sequential = Array.from({ length: 6 }, () => fixture.search().matches.map((match) => match.path));
    for (const order of sequential.slice(1)) assert.deepEqual(order, sequential[0]);
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve().then(() => fixture.search().matches.map((match) => match.path)),
      ),
    );
    for (const order of concurrent) assert.deepEqual(order, sequential[0]);
  } finally {
    fixture.release();
  }
});

test('AC12 debug output explains channels, scores, rerank signals, analyzer identity, and snapshot id', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nNeedle project alpha\n');
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer,
      countCap: 4,
      byteCap: 1024 * 1024,
    }),
  );

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  try {
    const result = executeSearchJob({
      vault,
      search: normalizeSearchParams({ query: 'needle', limit: 3, debug: true }),
      analysis: {
        raw: 'needle',
        primaryChannel: 'morph',
        primaryTerms: ['needle'],
        channels: { morph: ['needle'], surface: ['needle'], ngram: [] },
      },
      analyzerIdentity: analyzer.identity,
      snapshot: store.snapshotHandleForPin(pin),
    });
    assert.equal(result.debug.snapshotId, pin.snapshotId);
    assert.equal(result.debug.analyzer.name, analyzer.identity.name);
    assert.deepEqual(result.debug.query.channels.morph, ['needle']);
    const debug = result.matches[0]?.debug;
    assert.ok(debug);
    assert.equal(debug.snapshotId, pin.snapshotId);
    assert.equal(debug.analyzer.name, analyzer.identity.name);
    assert.deepEqual(debug.queryChannels.morph, ['needle']);
    assert.ok(debug.matchedChannels.includes('morph'));
    assert.equal(typeof debug.candidateScore, 'number');
    assert.equal(typeof debug.retrievalScore, 'number');
    assert.equal(typeof debug.rerankScore, 'number');
    assert.equal(typeof debug.rarityScore, 'number');
    assert.equal(typeof debug.proximityScore, 'number');
  } finally {
    store.release(pin);
  }
});

test('AC15 fixed positional corpus preserves expected top-N ranking', async () => {
  const files = {
    'Alpha Calibration.md': '# Alpha Calibration\n\nPrimary exact target for alpha calibration.\n',
    'Ops/Alpha Calibration.md': '# Ops Note\n\nFilename exact target for alpha calibration.\n',
    'Alpha Calibration Guide.md': '# Alpha Calibration Guide\n\nPhrase title target.\n',
    'Calibration Alpha.md': '# Calibration Alpha\n\nReverse order alpha calibration body.\n',
    'Research/Calibration Notes.md': '# Calibration Notes\n\nAlpha calibration appears in the body.\n',
  };
  for (let index = 0; index < 19; index += 1) {
    files[`Distractors/Note-${String(index).padStart(2, '0')}.md`] =
      `# Distractor ${index}\n\nAlpha operations and calibration records are mentioned separately ${index}.\n`;
  }
  const fixture = await createPinnedSearchFixture(files, { query: 'alpha calibration', limit: 10 });

  try {
    const paths = fixture.search().matches.map((match) => match.path);
    assert.deepEqual(paths.slice(0, 3), ['Alpha Calibration.md', 'Ops/Alpha Calibration.md', 'Calibration Alpha.md']);
  } finally {
    fixture.release();
  }
});

test('Hangul ngram retrieval falls back to morph and surface when ngram candidates are empty', async () => {
  const fixture = await createPinnedSearchFixture(
    {
      'Target.md': '# Target\n\n희귀한국어\n',
      'Other.md': '# Other\n\nordinary content\n',
    },
    { query: '희귀한국어', limit: 10 },
  );

  try {
    const result = fixture.search({
      analysis: {
        raw: '희귀한국어',
        primaryChannel: 'morph',
        primaryTerms: ['희귀한국어'],
        channels: {
          morph: ['희귀한국어'],
          surface: ['희귀한국어'],
          ngram: ['없는그램'],
        },
      },
    });

    assert.deepEqual(
      result.matches.map((match) => match.path),
      ['Target.md'],
    );
  } finally {
    fixture.release();
  }
});

test('refresh after mutation makes new files visible and removed files disappear', async () => {
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { executeSearchJob } = await import('../src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await import('../src/core/search/params.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Seed.md', '# Seed\n\nordinary content\n');
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzer,
      countCap: 4,
      byteCap: 16 * 1024 * 1024,
    }),
  );
  const searchPaths = async () => {
    const pin = await store.pin(vault);
    try {
      const result = executeSearchJob({
        vault,
        search: normalizeSearchParams({ query: 'mutationtarget', limit: 5 }),
        analysis: testQueryAnalysis('mutationtarget'),
        analyzerIdentity: analyzer.identity,
        snapshot: store.snapshotHandleForPin(pin),
      });
      return result.matches.map((match) => match.path);
    } finally {
      store.release(pin);
    }
  };

  await store.loadVault(vault);
  assert.deepEqual(await searchPaths(), []);

  writeVaultFile(vault, 'New.md', '# New\n\nmutationtarget appears after refresh\n');
  const progress = [];
  const refreshed = await store.refresh(vault, {
    progress: (update) => progress.push(update),
  });
  assert.equal(refreshed.rebuilt, true);
  assert.ok(
    progress.some(
      (update) =>
        update.phase === 'scanning' && update.total === 1 && update.completed === 0 && update.message === '1 added',
    ),
  );
  assert.deepEqual(await searchPaths(), ['New.md']);

  fs.rmSync(path.join(vault, 'New.md'));
  await store.rebuild(vault);
  assert.deepEqual(await searchPaths(), []);
});

test('refresh skips corpus and retrieval rebuild when active snapshot is fresh', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, 'Stable.md', '# Stable\n\nordinary content\n');
  const analyzer = testAnalyzer();
  const embedding = createDeterministicEmbeddingSetBuilder();
  let corpusBuilds = 0;
  let retrievalBuilds = 0;
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      analyzerIdentity: analyzer.identity,
      partitionBits: 1,
      snapshotBuilder: async (input) => {
        corpusBuilds += 1;
        return buildCanonicalSearchSnapshot({
          vaultRoot: input.vaultRoot,
          analyzer,
          partitionBits: input.partitionBits,
          searchSettings: input.searchSettings,
          progress: input.progress,
        });
      },
      embeddingSetBuilder: {
        providerIdentity: embedding.providerIdentity,
        build: async (input) => {
          retrievalBuilds += 1;
          return embedding.build(input);
        },
      },
    }),
  );

  const rebuilt = await store.rebuild(vault);
  assert.equal(corpusBuilds, 1);
  assert.equal(retrievalBuilds, 1);

  const progress = [];
  const refreshed = await store.refresh(vault, {
    progress: (update) => progress.push(update),
  });
  assert.equal(refreshed.rebuilt, false);
  assert.equal(refreshed.snapshotId, rebuilt.snapshotId);
  assert.equal(corpusBuilds, 1);
  assert.equal(retrievalBuilds, 1);
  assert.ok(
    progress.some(
      (update) =>
        update.phase === 'scanning' &&
        update.total === 0 &&
        update.completed === 0 &&
        update.message === 'already fresh',
    ),
  );
});

test('refresh repairs missing retrieval without rebuilding a fresh corpus snapshot', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const vault = tempRoot();
  writeVaultFile(vault, 'Stable.md', '# Stable\n\nordinary content\n');
  const analyzer = testAnalyzer();
  const embedding = createDeterministicEmbeddingSetBuilder();
  let corpusBuilds = 0;
  let retrievalBuilds = 0;
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env,
      analyzerIdentity: analyzer.identity,
      partitionBits: 1,
      snapshotBuilder: async (input) => {
        corpusBuilds += 1;
        return buildCanonicalSearchSnapshot({
          vaultRoot: input.vaultRoot,
          analyzer,
          partitionBits: input.partitionBits,
          searchSettings: input.searchSettings,
          progress: input.progress,
        });
      },
      embeddingSetBuilder: {
        providerIdentity: embedding.providerIdentity,
        build: async (input) => {
          retrievalBuilds += 1;
          return embedding.build(input);
        },
      },
    }),
  );

  const rebuilt = await store.rebuild(vault);
  const paths = searchStoreCachePaths(vault, env);
  const staleRetrieval = activeRetrievalFromEdition(paths);
  fs.rmSync(path.join(paths.retrievalsDir, staleRetrieval.retrievalSnapshotId), { force: true });

  const progress = [];
  const refreshed = await store.refresh(vault, {
    progress: (update) => progress.push(update),
  });
  assert.equal(refreshed.rebuilt, false);
  assert.equal(refreshed.snapshotId, rebuilt.snapshotId);
  assert.equal(corpusBuilds, 1);
  await waitFor(() => retrievalBuilds === 2);
  assert.equal(retrievalBuilds, 2);
  // Refresh keeps the corpus, so the repaired retrieval is content-addressed to the same id; the
  // decoupled dense repair re-stores its (deleted) envelope file post-commit — wait for that.
  await waitFor(() => fs.existsSync(path.join(paths.retrievalsDir, staleRetrieval.retrievalSnapshotId)));
  const repairedRetrieval = activeRetrievalFromEdition(paths);
  assert.ok(fs.existsSync(path.join(paths.retrievalsDir, repairedRetrieval.retrievalSnapshotId)));
  assert.ok(progress.some((update) => update.phase === 'vector-indexing'));
});

test('refresh surfaces retrieval repair failures without rebuilding a fresh corpus snapshot', async () => {
  const { buildCanonicalSearchSnapshot } = await import('../src/daemon/search-store/builder.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const vault = tempRoot();
  writeVaultFile(vault, 'Stable.md', '# Stable\n\nordinary content\n');
  const analyzer = testAnalyzer();
  const embedding = createDeterministicEmbeddingSetBuilder();
  let corpusBuilds = 0;
  let retrievalBuilds = 0;
  let failRetrieval = false;
  const store = createDaemonSnapshotStore(
    snapshotStoreOptions({
      env,
      analyzerIdentity: analyzer.identity,
      partitionBits: 1,
      snapshotBuilder: async (input) => {
        corpusBuilds += 1;
        return buildCanonicalSearchSnapshot({
          vaultRoot: input.vaultRoot,
          analyzer,
          partitionBits: input.partitionBits,
          searchSettings: input.searchSettings,
          progress: input.progress,
        });
      },
      embeddingSetBuilder: {
        providerIdentity: embedding.providerIdentity,
        build: async (input) => {
          retrievalBuilds += 1;
          if (failRetrieval) throw new Error('embedding unavailable');
          return embedding.build(input);
        },
      },
    }),
  );

  await store.rebuild(vault);
  const paths = searchStoreCachePaths(vault, env);
  const staleRetrieval = activeRetrievalFromEdition(paths);
  fs.rmSync(path.join(paths.retrievalsDir, staleRetrieval.retrievalSnapshotId), { force: true });
  failRetrieval = true;

  const refreshed = await store.refresh(vault);
  assert.equal(refreshed.rebuilt, false);
  assert.equal(corpusBuilds, 1);
  await waitFor(() => currentEdition(paths).dense.state === 'failed');
  assert.equal(retrievalBuilds, 2);
  const dense = currentEdition(paths).dense;
  assert.equal(dense.state, 'failed');
  assert.equal(dense.cause, 'embedding unavailable');
});

test('query-analysis cache key is deterministic and does not become result identity', async () => {
  const { QueryAnalysisCache, queryAnalysisCacheKey } = await import('../src/daemon/query-analysis-cache.ts');
  const { DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES } = await import('../src/daemon/query-analysis-cache-defaults.ts');
  const analyzerIdentity = { name: 'test-analyzer', version: '1', node: 'test' };
  const input = {
    analyzerIdentity,
    rawQuery: 'Needle',
    fields: ['body', 'title'],
    searchSettingsHash: 'settings-a',
  };
  const analysis = {
    raw: 'Needle',
    primaryChannel: 'morph',
    primaryTerms: ['needle'],
    channels: { morph: ['needle'], surface: ['needle'], ngram: ['ne'] },
  };

  assert.equal(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, fields: ['title', 'body'] }));
  assert.notEqual(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, rawQuery: 'Other' }));
  assert.notEqual(
    queryAnalysisCacheKey(input),
    queryAnalysisCacheKey({ ...input, analyzerIdentity: { ...analyzerIdentity, version: '2' } }),
  );
  assert.notEqual(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, searchSettingsHash: 'settings-b' }));
  assert.equal(DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES, 64);
  assert.equal(new QueryAnalysisCache().stats().maxEntries, DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES);
  assert.equal(new QueryAnalysisCache(Number.NaN).stats().maxEntries, 0);

  const cache = new QueryAnalysisCache(2);
  assert.equal(cache.get(input), undefined);
  cache.set(input, analysis);
  const cached = cache.get(input);
  assert.deepEqual(cached, analysis);
  cached.channels.morph.push('mutated');
  assert.deepEqual(cache.get(input), analysis);
});

test('AC19 search-execution pool serves a second search while a heavy search is in-flight', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const { SearchExecutionWorkerPool } = await import('../src/daemon/pools.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'search-execution-concurrency.mjs');
  const logPath = path.join(root, 'events.log');
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import { parentPort } from "node:worker_threads";

const logPath = ${JSON.stringify(logPath)};

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { ready: true }, memoryRss: process.memoryUsage().rss });
    return;
  }
  const query = message.request?.payload?.search?.query;
  if (query === "needle payload") {
    fs.appendFileSync(logPath, "heavy\\n");
    setInterval(() => {}, 1000);
    return;
  }
  fs.appendFileSync(logPath, "second\\n");
  parentPort.postMessage({
    id: message.id,
    ok: true,
    result: { ok: true, command: "search", matches: [{ path: "Unique.md" }], snapshotId: "snap-a" },
    memoryRss: process.memoryUsage().rss
  });
});
`,
  );
  const pool = new SearchExecutionWorkerPool(
    new DaemonWorkerPool({
      name: 'ac19-search-execution',
      kind: 'search',
      size: 2,
      workerScript,
      env: { ...process.env },
    }),
  );
  await pool.warmup();
  try {
    let heavySettled = false;
    const heavy = pool
      .search(
        {
          search: { query: 'needle payload' },
        },
        {
          deadline: Date.now() + 5000,
          cancellationId: 'heavy',
        },
      )
      .finally(() => {
        heavySettled = true;
      });
    await waitFor(() => fs.readFileSync(logPath, 'utf8').includes('heavy'));
    const second = await pool.search(
      {
        search: { query: 'uniquetarget' },
      },
      {
        deadline: Date.now() + 5000,
        cancellationId: 'second',
      },
    );

    assert.equal(heavySettled, false, 'heavy search should still be in-flight when the second search returns');
    assert.deepEqual(
      second.matches.map((match) => match.path),
      ['Unique.md'],
    );
    pool.cancel('heavy');
    await assert.rejects(heavy, (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    });
  } finally {
    await pool.close();
  }
});

test('search-execution pool preload and cacheStats still route to targeted slots', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const { SearchExecutionWorkerPool } = await import('../src/daemon/pools.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'targeted-preload-stats.mjs');
  const claimDir = path.join(root, 'claims');
  const logPath = path.join(root, 'events.log');
  fs.mkdirSync(claimDir);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

const claimDir = ${JSON.stringify(claimDir)};
const logPath = ${JSON.stringify(logPath)};
let workerIndex = 0;
while (true) {
  try {
    fs.writeFileSync(path.join(claimDir, String(workerIndex)), "claimed", { flag: "wx" });
    break;
  } catch {
    workerIndex += 1;
  }
}

function cache(snapshotIds) {
  return {
    entries: snapshotIds.length,
    limit: 16,
    hits: 0,
    misses: 0,
    evictions: 0,
    preloads: snapshotIds.length,
    snapshotIds
  };
}

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { workerIndex }, memoryRss: process.memoryUsage().rss });
    return;
  }
  if (message.request?.type === "preloadSnapshot") {
    const snapshotId = message.request.payload?.snapshotId ?? "unknown";
    fs.appendFileSync(logPath, "preload:" + workerIndex + ":" + snapshotId + "\\n");
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: { snapshotId, cacheHit: false, cache: cache(["preload-" + workerIndex]) },
      memoryRss: process.memoryUsage().rss
    });
    return;
  }
  if (message.request?.type === "searchExecutionStats") {
    fs.appendFileSync(logPath, "stats:" + workerIndex + "\\n");
    parentPort.postMessage({
      id: message.id,
      ok: true,
      result: cache(["stats-" + workerIndex]),
      memoryRss: process.memoryUsage().rss
    });
  }
});
`,
  );
  const pool = new SearchExecutionWorkerPool(
    new DaemonWorkerPool({
      name: 'targeted-preload-stats',
      kind: 'search',
      size: 2,
      workerScript,
      env: { ...process.env },
    }),
  );
  try {
    await pool.warmup();
    assert.equal(pool.idleReadySlotIds().length, 2);
    const options = {
      deadline: Date.now() + 10_000,
      cancellationId: 'targeted-preload-stats',
      requestId: 'targeted-preload-stats',
      vault: 'vault-a',
    };

    const preload = await pool.preloadSnapshot({ snapshotId: 'snap-a' }, options, { minimumWorkers: 2 });
    const stats = await pool.cacheStats(options);

    assert.equal(preload.length, 2);
    assert.equal(stats.length, 2);
    assert.deepEqual(
      new Set(preload.map((result) => result.cache.snapshotIds[0])),
      new Set(['preload-0', 'preload-1']),
    );
    assert.deepEqual(new Set(stats.flatMap((result) => result.snapshotIds)), new Set(['stats-0', 'stats-1']));
    assert.deepEqual(
      fs.readFileSync(logPath, 'utf8').trim().split('\n').sort(),
      ['preload:0:snap-a', 'preload:1:snap-a', 'stats:0', 'stats:1'].sort(),
    );
  } finally {
    await pool.close();
  }
});

test('search-execution pool leases idle-ready slots atomically for targeted shard dispatch', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const { SearchExecutionWorkerPool } = await import('../src/daemon/pools.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'idle-ready-lease.mjs');
  const claimDir = path.join(root, 'claims');
  fs.mkdirSync(claimDir);
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

const claimDir = ${JSON.stringify(claimDir)};
let workerIndex = 0;
while (true) {
  try {
    fs.writeFileSync(path.join(claimDir, String(workerIndex)), "claimed", { flag: "wx" });
    break;
  } catch {
    workerIndex += 1;
  }
}

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({ id: 0, ok: true, result: { workerIndex }, memoryRss: process.memoryUsage().rss });
    return;
  }
  parentPort.postMessage({
    id: message.id,
    ok: true,
    result: {
      snapshotId: message.request.payload?.label ?? "snap",
      partitionIds: [workerIndex],
      requestedLimit: 0,
      workEstimate: 0,
      scoredCount: 0,
      finalists: []
    },
    memoryRss: process.memoryUsage().rss
  });
});
`,
  );
  const pool = new SearchExecutionWorkerPool(
    new DaemonWorkerPool({
      name: 'idle-ready-lease',
      kind: 'search',
      size: 3,
      workerScript,
      env: { ...process.env },
    }),
  );
  try {
    await pool.warmup(3);
    assert.equal(pool.idleReadySlotIds().length, 3);
    const firstSlot = pool.leaseIdleSlot();
    const secondSlot = pool.leaseIdleSlot();
    assert.equal(typeof firstSlot, 'number');
    assert.equal(typeof secondSlot, 'number');
    assert.notEqual(secondSlot, firstSlot);
    assert.deepEqual(new Set(pool.idleReadySlotIds()).has(firstSlot), false);
    assert.deepEqual(new Set(pool.idleReadySlotIds()).has(secondSlot), false);

    const options = {
      deadline: Date.now() + 10_000,
      cancellationId: 'lease-dispatch',
      requestId: 'lease-dispatch',
      vault: 'vault-a',
    };
    const first = pool.runOnSlot({ label: 'first' }, options, firstSlot);
    const second = pool.runOnSlot({ label: 'second' }, options, secondSlot);
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.snapshotId).sort(), ['first', 'second']);
    assert.equal(new Set(results.flatMap((result) => result.partitionIds)).size, 2);
    await waitFor(() => pool.idleReadySlotIds().length === 3);
  } finally {
    await pool.close();
  }
});

test('search-execution idle-ready lease excludes busy targeted slots', async () => {
  const { DaemonWorkerPool } = await import('../src/daemon/worker-pool.ts');
  const { SearchExecutionWorkerPool } = await import('../src/daemon/pools.ts');
  const root = tempRoot();
  const workerScript = path.join(root, 'idle-ready-busy-exclusion.mjs');
  const claimDir = path.join(root, 'claims');
  const logPath = path.join(root, 'events.log');
  fs.mkdirSync(claimDir);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(
    workerScript,
    `
import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

const claimDir = ${JSON.stringify(claimDir)};
const logPath = ${JSON.stringify(logPath)};
let workerIndex = 0;
while (true) {
  try {
    fs.writeFileSync(path.join(claimDir, String(workerIndex)), "claimed", { flag: "wx" });
    break;
  } catch {
    workerIndex += 1;
  }
}

function shardResult() {
  return {
    snapshotId: "snap",
    partitionIds: [workerIndex],
    requestedLimit: 0,
    workEstimate: 0,
    scoredCount: 0,
    finalists: []
  };
}

parentPort.on("message", (message) => {
  if (message?.id === 0) {
    parentPort.postMessage({
      id: 0,
      ok: true,
      result: { workerIndex },
      memoryRss: process.memoryUsage().rss
    });
    return;
  }
  fs.appendFileSync(logPath, message.request.payload?.label + ":" + workerIndex + "\\n");
  if (message.request.payload?.label === "hold") {
    setInterval(() => {}, 1000);
    return;
  }
  parentPort.postMessage({ id: message.id, ok: true, result: shardResult(), memoryRss: process.memoryUsage().rss });
});
`,
  );
  const workerPool = new DaemonWorkerPool({
    name: 'idle-ready-busy-exclusion',
    kind: 'search',
    size: 2,
    workerScript,
    env: { ...process.env },
  });
  const pool = new SearchExecutionWorkerPool(workerPool);
  try {
    await pool.warmup(2);
    const firstSlot = pool.leaseIdleSlot();
    assert.equal(typeof firstSlot, 'number');
    const hold = pool.runOnSlot(
      { label: 'hold' },
      {
        deadline: Date.now() + 10_000,
        cancellationId: 'hold',
        requestId: 'hold',
        vault: 'vault-a',
      },
      firstSlot,
    );
    await waitFor(() => fs.readFileSync(logPath, 'utf8').includes('hold:'));

    assert.equal(pool.idleReadySlotIds().includes(firstSlot), false);
    const secondSlot = pool.leaseIdleSlot();
    assert.equal(typeof secondSlot, 'number');
    assert.notEqual(secondSlot, firstSlot);
    const quick = await pool.runOnSlot(
      { label: 'quick' },
      {
        deadline: Date.now() + 10_000,
        cancellationId: 'quick',
        requestId: 'quick',
        vault: 'vault-a',
      },
      secondSlot,
    );

    assert.equal(quick.snapshotId, 'snap');
    assert.deepEqual(new Set(quick.partitionIds).size, 1);
    pool.cancel('hold');
    await assert.rejects(hold, (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    });
  } finally {
    await workerPool.close();
  }
});

test('AC3 analyzer-daemon socket client symbols are removed from analyzer construction', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/core/search/analyzer.ts'), 'utf8');
  for (const symbol of [
    'requestRunningDaemon',
    'requestDaemonTokenization',
    'createDaemonAnalyzer',
    'createDaemonLeasedAnalyzer',
    'ensureAnalyzerDaemonReady',
    'startAnalyzerDaemonWarmup',
    'spawnAnalyzerDaemonProcess',
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`));
  }
});

test('AC16 deterministic scheduler preserves stable ordering under deadline cancellation and backpressure', async () => {
  const { createDeterministicSearchSchedulerForTests } = await import('../src/daemon/scheduler.ts');
  const scheduler = createDeterministicSearchSchedulerForTests({
    activeSnapshotId: 'snap-old',
    nextSnapshotId: 'snap-new',
    queryResults: [
      { path: 'Alpha.md', score: 1 },
      { path: 'Beta.md', score: 0.5 },
    ],
    backgroundQueueDepth: 100,
  });

  const baseline = await scheduler.search({ query: 'alpha', deadlineMs: 1000, cancellationId: 'keep' });
  assert.deepEqual(
    baseline.matches.map((match) => match.path),
    ['Alpha.md', 'Beta.md'],
  );
  assert.equal(baseline.snapshotId, 'snap-old');

  await scheduler.publishNextSnapshot();
  const expired = await scheduler.search({ query: 'alpha', deadlineMs: 0, cancellationId: 'deadline' });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(expired.partialResults, undefined);
  assert.equal(expired.snapshotId, 'snap-old');

  const cancelled = await scheduler.search({
    query: 'alpha',
    deadlineMs: 1000,
    cancellationId: 'cancelled',
    cancelBeforeRun: true,
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'CANCELLED');
  assert.equal(cancelled.partialResults, undefined);
  assert.equal(cancelled.snapshotId, 'snap-old');

  const pressure = await scheduler.applyBackpressure();
  assert.deepEqual(pressure.shedQueues, ['throughput-rebuild', 'throughput-refresh', 'throughput-compact']);
  assert.equal(pressure.queryWorkShed, false);
});

test('AC16 real request scheduler enforces deadline cancellation and throughput backpressure', async () => {
  const { createRequestScheduler } = await import('../src/daemon/scheduler.ts');
  const expired = createRequestScheduler();
  await assert.rejects(
    () => expired.run({ deadline: Date.now() - 1, cancellationId: 'past-deadline' }, async () => 'unreachable'),
    (error) => {
      assert.equal(error.code, 'DEADLINE_EXCEEDED');
      return true;
    },
  );

  const cancelled = createRequestScheduler();
  cancelled.cancel('cancelled-before-run');
  await assert.rejects(
    () =>
      cancelled.run({ deadline: Date.now() + 1000, cancellationId: 'cancelled-before-run' }, async () => 'unreachable'),
    (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    },
  );

  const inFlight = createRequestScheduler();
  let releaseTask;
  const running = inFlight.run(
    { deadline: Date.now() + 1000, cancellationId: 'cancelled-after-run' },
    async () =>
      new Promise((resolve) => {
        releaseTask = resolve;
      }),
  );
  inFlight.cancel('cancelled-after-run');
  releaseTask('done');
  await assert.rejects(
    () => running,
    (error) => {
      assert.equal(error.code, 'CANCELLED');
      return true;
    },
  );

  const pressure = createRequestScheduler().applyBackpressure({
    backgroundQueueDepth: 42,
    queues: [
      { name: 'query-search', kind: 'query', depth: 99 },
      { name: 'throughput-refresh', kind: 'throughput', depth: 4 },
      { name: 'throughput-compact', kind: 'throughput', depth: 0 },
      { name: 'throughput-rebuild', kind: 'throughput', depth: 2 },
    ],
  });
  assert.deepEqual(pressure.shedQueues, ['throughput-rebuild', 'throughput-refresh']);
  assert.equal(pressure.queryWorkShed, false);
  assert.equal(pressure.backgroundQueueDepth, 42);
});

test('AC18 owner registry records stable fields and converges stale starts to one compatible daemon', async () => {
  const {
    OWNER_RECORD_FIELDS,
    convergeOnCompatibleDaemonForTests,
    createOwnerRecord,
    createOwnerRegistry,
    createOwnerRegistryForTests,
    socketPathForOwner,
  } = await import('../src/daemon/owner-registry.ts');

  assert.deepEqual(OWNER_RECORD_FIELDS, AC18_OWNER_FIELDS);

  const desired = {
    uid: process.getuid?.() ?? 0,
    runtimeHash: 'runtime-a',
    binaryVersion: 'binary-content-hash-b',
    protocolVersion: CURRENT_SEARCH_DAEMON_PROTOCOL_VERSION,
  };
  const scopeRuntimeDir = tempRoot('optsidian-owner-scope-');
  const peerDesired = { ...desired, protocolVersion: desired.protocolVersion + 1 };
  const desiredRegistry = createOwnerRegistry({ runtimeDir: scopeRuntimeDir, desired });
  const peerRegistry = createOwnerRegistry({ runtimeDir: scopeRuntimeDir, desired: peerDesired });
  assert.notEqual(desiredRegistry.ownerPath, peerRegistry.ownerPath);
  peerRegistry.writeOwner(createOwnerRecord(peerDesired, path.join(scopeRuntimeDir, 'peer.sock'), 1, 'peer', 999999));
  assert.equal(desiredRegistry.readOwner(), undefined);
  assert.equal(peerRegistry.compatibleOwners(peerDesired).length, 1);
  const unsafeDesired = { ...desired, runtimeHash: '../../escape' };
  const unsafeRegistry = createOwnerRegistry({ runtimeDir: scopeRuntimeDir, desired: unsafeDesired });
  assert.equal(path.dirname(unsafeRegistry.ownerPath), scopeRuntimeDir);
  assert.doesNotMatch(path.basename(unsafeRegistry.ownerPath), /\.\./);
  assert.doesNotMatch(path.basename(socketPathForOwner(scopeRuntimeDir, unsafeDesired)), /\.\./);

  const scenarios = ['binary-mismatch', 'stale-pid-lock', 'orphaned-socket'];

  for (const scenario of scenarios) {
    const registry = createOwnerRegistryForTests({ scenario, desired });
    const result = await convergeOnCompatibleDaemonForTests(registry, desired);
    assert.equal(result.owner.binaryVersion, desired.binaryVersion, scenario);
    assert.equal(result.owner.slot.protocolVersion, desired.protocolVersion, scenario);
    assert.equal(result.replaced, scenario === 'binary-mismatch', scenario);
    assert.equal(registry.compatibleOwners().length, 1, scenario);
  }

  const coldStartRegistry = createOwnerRegistryForTests({ scenario: 'simultaneous-cold-starts', desired });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => convergeOnCompatibleDaemonForTests(coldStartRegistry, desired)),
  );
  assert.equal(new Set(results.map((result) => result.owner.incarnationId)).size, 1);
  assert.equal(coldStartRegistry.compatibleOwners().length, 1);
});
