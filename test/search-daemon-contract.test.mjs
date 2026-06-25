import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unpack } from "msgpackr";

const repoRoot = process.cwd();
const AC17_PUBLICATION_STEPS = [
  "tmpSegmentWrite",
  "fsyncSegmentFile",
  "fsyncSegmentDir",
  "hashVerify",
  "manifestTempWrite",
  "fsyncManifestFile",
  "durableRenameManifest",
  "fsyncSnapshotsDir",
  "activePointerTempWrite",
  "fsyncActivePointerFile",
  "durableRenameActivePointer",
  "fsyncActiveDir",
  "recoveryScan",
  "markSweepGc"
];

const AC18_OWNER_FIELDS = [
  "pid",
  "uid",
  "runtimeHash",
  "binaryVersion",
  "protocolVersion",
  "nonce",
  "socketPath",
  "startedAt"
];


function testAnalyzer() {
  const tokenize = (text) => [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity: {
      name: "test-analyzer",
      version: "1",
      node: "test"
    },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text))
  };
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempRoot(prefix = "optsidian-search-daemon-contract-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function futureImport(relativePath) {
  return import(path.join(repoRoot, relativePath));
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.from(JSON.stringify(value));
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength
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
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readRawRpcFrame(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for RPC frame"));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
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
      reject(new Error("socket closed before RPC frame"));
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForSocketClose(socket, timeoutMs = 1000) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for socket close"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = () => {};
    socket.once("close", onClose);
    socket.once("error", onError);
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
    protocolVersion: 1,
    requestId,
    method: "Status",
    deadline: Date.now() + 1000,
    payload: { nonce: "test" }
  };
}

async function assertBadFrameThenAlive({ socketPath, frame, encodeFrame, label }) {
  const socket = await connectRawSocket(socketPath);
  socket.write(frame);
  const response = await readRawRpcFrame(socket);
  assert.equal(response.requestId, "invalid-frame", label);
  assert.equal(response.ok, false, label);
  assert.equal(response.error.code, "BAD_REQUEST", label);
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
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  return path.normalize(path.join(path.dirname(repoRelative(fromFile)), specifier)).split(path.sep).join("/");
}

function importedSearchExecutionSymbols(source) {
  const symbols = [
    "searchVault",
    "searchVaultWithAnalyzer",
    "searchVaultWithLeasedAnalyzer",
    "rebuildSearchIndex",
    "clearSearchIndex",
    "warmSearchIndexes",
    "getSearchIndexStatus"
  ];
  return symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(source));
}

function testQueryAnalysis(raw) {
  const terms = [...raw.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    raw,
    primaryChannel: "morph",
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] }
  };
}

async function createPinnedSearchFixture(files, options = {}) {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  for (const [rel, content] of Object.entries(files)) writeVaultFile(vault, rel, content);
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer,
    countCap: 4,
    byteCap: 64 * 1024 * 1024
  });
  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const snapshot = store.snapshotHandleForPin(pin);
  const defaultQuery = options.query ?? "needle";
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
          ...(overrides.search ?? {})
        }),
        analysis: overrides.analysis ?? options.analysis ?? testQueryAnalysis(query),
        analyzerIdentity: analyzer.identity,
        snapshot,
        explain: overrides.explain === true
      });
    },
    release() {
      store.release(pin);
    }
  };
}

function searchIdentityPayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    snippets: match.snippets.map((snippet) => snippet.text)
  }));
}

test("AC2/AC3 transport rejects nil and malformed frames without killing the server", async () => {
  const { createRpcServer } = await futureImport("src/daemon/transport.ts");
  const { encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const root = tempRoot();
  const socketPath = path.join(root, "rpc.sock");
  const server = await createRpcServer({
    socketPath,
    handleRequest: async () => ({ alive: true })
  });

  try {
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: "nil-frame",
      frame: msgpackPayloadFrame(Buffer.from([0xc0]))
    });
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: "malformed-frame",
      frame: msgpackPayloadFrame(Buffer.from([0xc1]))
    });
  } finally {
    await server.close();
  }
});

test("AC3 transport survives an abruptly destroyed client socket mid-request", async () => {
  const { createRpcServer } = await futureImport("src/daemon/transport.ts");
  const { encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const root = tempRoot();
  const socketPath = path.join(root, "rpc.sock");
  let slowRequestSeen = false;
  const server = await createRpcServer({
    socketPath,
    handleRequest: async (request) => {
      if (request.requestId === "slow-request") {
        slowRequestSeen = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { alive: true };
    }
  });

  try {
    const socket = await connectRawSocket(socketPath);
    socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      socket.write(encodeFrame(statusRequest("slow-request")), (error) => {
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
    const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest("after-destroy"));
    assert.equal(alive.ok, true);
    assert.equal(alive.result.alive, true);
  } finally {
    await server.close();
  }
});

test("AC3 transport converts synchronous handler throws into RPC errors without killing the server", async () => {
  const { createRpcServer } = await futureImport("src/daemon/transport.ts");
  const { encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const root = tempRoot();
  const socketPath = path.join(root, "rpc.sock");
  const server = await createRpcServer({
    socketPath,
    handleRequest: (request) => {
      if (request.requestId === "sync-throw") {
        throw Object.assign(new Error("search daemon is not ready"), { code: "SEARCH_DAEMON_NOT_READY" });
      }
      return Promise.resolve({ alive: true });
    }
  });

  try {
    const rejected = await requestRawRpc(socketPath, encodeFrame, statusRequest("sync-throw"));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "SEARCH_DAEMON_NOT_READY");
    assert.match(rejected.error.message, /not ready/);

    const alive = await requestRawRpc(socketPath, encodeFrame, statusRequest("after-sync-throw"));
    assert.equal(alive.ok, true);
    assert.equal(alive.result.alive, true);
  } finally {
    await server.close();
  }
});

test("AC11 transport closes unused idle sockets and incomplete frames without killing the server", async () => {
  const { createRpcServer } = await futureImport("src/daemon/transport.ts");
  const { encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const root = tempRoot();
  const socketPath = path.join(root, "rpc.sock");
  const server = await createRpcServer({
    socketPath,
    socketIdleTimeoutMs: 25,
    handleRequest: async () => ({ alive: true })
  });

  try {
    const idle = await connectRawSocket(socketPath);
    await waitForSocketClose(idle, 500);
    const aliveAfterIdle = await requestRawRpc(socketPath, encodeFrame, statusRequest("after-idle-close"));
    assert.equal(aliveAfterIdle.ok, true);
    assert.equal(aliveAfterIdle.result.alive, true);

    const partial = await connectRawSocket(socketPath);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(64, 0);
    partial.write(Buffer.concat([header, Buffer.from([0x80])]));
    const response = await readRawRpcFrame(partial, 500);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "BAD_REQUEST");
    assert.match(response.error.message, /timed out/i);
    await waitForSocketClose(partial, 500);

    const aliveAfterPartial = await requestRawRpc(socketPath, encodeFrame, statusRequest("after-partial-close"));
    assert.equal(aliveAfterPartial.ok, true);
    assert.equal(aliveAfterPartial.result.alive, true);
  } finally {
    await server.close();
  }
});

test("AC11 transport rejects oversized declared frames and keeps serving", async () => {
  const { createRpcServer } = await futureImport("src/daemon/transport.ts");
  const { SEARCH_DAEMON_MAX_FRAME_BYTES, encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const root = tempRoot();
  const socketPath = path.join(root, "rpc.sock");
  const server = await createRpcServer({
    socketPath,
    handleRequest: async () => ({ alive: true })
  });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(SEARCH_DAEMON_MAX_FRAME_BYTES + 1, 0);

  try {
    await assertBadFrameThenAlive({
      socketPath,
      encodeFrame,
      label: "oversized-frame",
      frame: oversizedHeader
    });
  } finally {
    await server.close();
  }
});

test("AC5 worker pool warmup failures reject instead of hanging or degrading", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const root = tempRoot();
  const workerScript = path.join(root, "warmup-fails.mjs");
  fs.writeFileSync(workerScript, `
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
`);
  const pool = new DaemonWorkerPool({
    name: "ac5-warmup-fail-fast",
    kind: "analyzer",
    size: 1,
    workerScript,
    env: { ...process.env }
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("warmup did not settle")), 6000);
  });
  const started = Date.now();

  try {
    await assert.rejects(
      () => Promise.race([pool.warmup(), timeout]),
      (error) => {
        assert.equal(error.code, "WARMUP_FAILED");
        assert.match(error.message, /x/);
        return true;
      }
    );
    assert.ok(Date.now() - started < 6000);
  } finally {
    await pool.close();
  }
});

test("worker pool can serve jobs after the first worker is ready", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const root = tempRoot();
  const workerScript = path.join(root, "partial-ready.mjs");
  const firstMarker = path.join(root, "first-worker.marker");
  const jobLog = path.join(root, "jobs.log");
  fs.writeFileSync(jobLog, "");
  fs.writeFileSync(workerScript, `
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
    else setTimeout(reply, 1500);
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
`);
  const pool = new DaemonWorkerPool({
    name: "partial-ready",
    kind: "search",
    size: 2,
    workerScript,
    env: { ...process.env }
  });
  try {
    const started = Date.now();
    const warmed = await pool.warmup(1);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(warmed, [{ workerIndex: 0 }]);
    assert.equal(pool.stats().ready, 1);

    const result = await pool.run({ type: "search" }, {
      deadline: Date.now() + 1000,
      cancellationId: "partial-ready"
    });
    assert.deepEqual(result, { workerIndex: 0 });
    assert.equal(fs.readFileSync(jobLog, "utf8").trim(), "0");

    await pool.warmup();
    assert.equal(pool.stats().ready, 2);
  } finally {
    await pool.close();
  }
});

test("worker pool can defer warmup until first job", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const root = tempRoot();
  const workerScript = path.join(root, "lazy-warmup.mjs");
  const logPath = path.join(root, "events.log");
  fs.writeFileSync(logPath, "");
  fs.writeFileSync(workerScript, `
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
`);
  const pool = new DaemonWorkerPool({
    name: "lazy-warmup",
    kind: "analyzer",
    size: 1,
    workerScript,
    autoWarmup: false,
    env: { ...process.env }
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.readFileSync(logPath, "utf8"), "");
    assert.equal(pool.stats().ready, 0);
    assert.equal(pool.stats().slots[0].warmupStarted, false);

    await pool.run({ type: "analyzeQuery" }, {
      deadline: Date.now() + 1000,
      cancellationId: "lazy-warmup"
    });
    assert.equal(fs.readFileSync(logPath, "utf8"), "warmup\njob\n");
    assert.equal(pool.stats().ready, 1);
  } finally {
    await pool.close();
  }
});

test("daemon pools defer latency analyzer warmup until query analysis", async () => {
  const { createDaemonPools } = await futureImport("src/daemon/pools.ts");
  const pools = await createDaemonPools({
    ...process.env,
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: "1"
  }, {});
  try {
    const stats = await pools.stats({
      deadline: Date.now() + 1000,
      cancellationId: "lazy-latency-stats"
    });
    assert.equal(stats.latencyAnalyzer.ready, 0);
    assert.equal(stats.searchExecution.ready, 1);
  } finally {
    await pools.close();
  }
});

test("worker pool memory restart guard ignores shared/native memory when heap is below limit", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const root = tempRoot();
  const workerScript = path.join(root, "memory-guard.mjs");
  const warmupLog = path.join(root, "warmups.log");
  fs.writeFileSync(warmupLog, "");
  fs.writeFileSync(workerScript, `
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
`);
  const pool = new DaemonWorkerPool({
    name: "memory-guard",
    kind: "search",
    size: 1,
    workerScript,
    memoryLimitBytes: 10,
    env: { ...process.env }
  });
  try {
    await pool.warmup();
    await pool.run({ type: "search" }, {
      deadline: Date.now() + 1000,
      cancellationId: "memory-guard"
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const warmups = fs.readFileSync(warmupLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(warmups.length, 1);
    const stats = pool.stats();
    assert.equal(stats.restarts, 0);
    assert.equal(stats.slots[0].lastMemory.heapUsed, 1);
  } finally {
    await pool.close();
  }
});

test("worker pool optional rss guard restarts only after configured strikes", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const root = tempRoot();
  const workerScript = path.join(root, "rss-guard.mjs");
  const warmupLog = path.join(root, "warmups.log");
  fs.writeFileSync(warmupLog, "");
  fs.writeFileSync(workerScript, `
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
`);
  const pool = new DaemonWorkerPool({
    name: "rss-guard",
    kind: "search",
    size: 1,
    workerScript,
    heapGuardBytes: 10,
    rssGuardBytes: 10,
    rssGuardStrikes: 1,
    env: { ...process.env }
  });
  try {
    await pool.warmup();
    await pool.run({ type: "search" }, {
      deadline: Date.now() + 1000,
      cancellationId: "rss-guard"
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const warmups = fs.readFileSync(warmupLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(warmups.length >= 2);
    assert.equal(pool.stats().lastRestartReason, "rss guard exceeded (1000 > 10)");
  } finally {
    await pool.close();
  }
});

test("search store loadVault preloads the active snapshot into search workers", async () => {
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const vault = tempRoot();
  const calls = [];
  const pin = { snapshotId: "snap-a", pinToken: "pin-a" };
  const fakeStore = {
    loadVault: async () => ({ ok: true, command: "index", action: "warm", vaults: [{ vaultRoot: vault, status: "ready" }], snapshotId: "snap-a" }),
    pin: async (inputVault, snapshotId) => {
      calls.push(["pin", inputVault, snapshotId]);
      return pin;
    },
    snapshotHandleForPin: (inputPin) => {
      calls.push(["handle", inputPin.pinToken]);
      return { snapshotId: "snap-a", pinToken: inputPin.pinToken, documents: sharedHandle(Buffer.from("[]")), segments: [] };
    },
    release: (inputPin) => calls.push(["release", inputPin.pinToken])
  };
  const fakeSearchExecution = {
    preloadSnapshot: async (snapshot, options, preloadOptions) => {
      calls.push(["preload", snapshot.snapshotId, options.vault, preloadOptions]);
      return [{ snapshotId: snapshot.snapshotId, cacheHit: false, cache: { entries: 1, limit: 2, hits: 0, misses: 1, evictions: 0, preloads: 1, snapshotIds: [snapshot.snapshotId] } }];
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, fakeSearchExecution, { queryCacheSize: 1 });

  const result = await service.loadVault(vault, {
    deadline: Date.now() + 1000,
    cancellationId: "preload",
    requestId: "preload"
  }, {
    preload: { minimumWorkers: 1, backgroundRemaining: true }
  });

  assert.equal(result.snapshotId, "snap-a");
  assert.deepEqual(calls, [
    ["pin", vault, "snap-a"],
    ["handle", "pin-a"],
    ["preload", "snap-a", vault, { minimumWorkers: 1, backgroundRemaining: true }],
    ["release", "pin-a"]
  ]);
});

test("search store loadVault can skip search worker preload", async () => {
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const vault = tempRoot();
  const calls = [];
  const fakeStore = {
    loadVault: async () => ({ ok: true, command: "index", action: "warm", vaults: [{ vaultRoot: vault, status: "ready" }], snapshotId: "snap-a" }),
    pin: async () => {
      calls.push("pin");
      return { snapshotId: "snap-a", pinToken: "pin-a" };
    },
    snapshotHandleForPin: () => {
      calls.push("handle");
      return { snapshotId: "snap-a", pinToken: "pin-a", documents: sharedHandle(Buffer.from("[]")), segments: [] };
    },
    release: () => calls.push("release")
  };
  const fakeSearchExecution = {
    preloadSnapshot: async () => {
      throw new Error("preload should be skipped");
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, {}, fakeSearchExecution, { queryCacheSize: 1 });

  const result = await service.loadVault(vault, {
    deadline: Date.now() + 1000,
    cancellationId: "preload-skip",
    requestId: "preload-skip"
  }, {
    preload: false
  });

  assert.equal(result.snapshotId, "snap-a");
  assert.deepEqual(calls, []);
});

test("search store loadVault can warm the query analyzer alongside preload", async () => {
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const vault = tempRoot();
  const calls = [];
  const pin = { snapshotId: "snap-a", pinToken: "pin-a" };
  const fakeStore = {
    loadVault: async () => ({ ok: true, command: "index", action: "warm", vaults: [{ vaultRoot: vault, status: "ready" }], snapshotId: "snap-a" }),
    pin: async () => pin,
    snapshotHandleForPin: () => ({ snapshotId: "snap-a", pinToken: "pin-a", documents: sharedHandle(Buffer.from("[]")), segments: [] }),
    release: () => {}
  };
  const fakeAnalyzer = {
    warmup: async (minimumReady) => {
      calls.push(["analyzer", minimumReady]);
    }
  };
  const fakeSearchExecution = {
    preloadSnapshot: async (snapshot, options, preloadOptions) => {
      calls.push(["preload", snapshot.snapshotId, options.vault, preloadOptions]);
      return [{ snapshotId: snapshot.snapshotId, cacheHit: false, cache: { entries: 1, limit: 2, hits: 0, misses: 1, evictions: 0, preloads: 1, snapshotIds: [snapshot.snapshotId] } }];
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, fakeSearchExecution, { queryCacheSize: 1 });

  await service.loadVault(vault, {
    deadline: Date.now() + 1000,
    cancellationId: "preload-query-warmup",
    requestId: "preload-query-warmup"
  }, {
    preload: { minimumWorkers: 1 },
    warmupQueryAnalyzer: true
  });

  assert.deepEqual(calls.sort(), [
    ["analyzer", 1],
    ["preload", "snap-a", vault, { minimumWorkers: 1 }]
  ].sort());
});

test("search store service analyzes non-Hangul queries inline without warming Kiwi", async () => {
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const vault = tempRoot();
  const analyzerIdentity = {
    name: "router",
    version: "test",
    runtime: "node-intl",
    node: "test",
    icu: "test",
    model: "kiwi-nlp:test",
    declaredAnalyzers: ["ko"],
    activeAnalyzers: ["ko"]
  };
  const fakeStore = {
    pin: async () => ({ snapshotId: "snap-a", pinToken: "pin-a" }),
    snapshotHandleForPin: () => ({ snapshotId: "snap-a", pinToken: "pin-a", documents: sharedHandle(Buffer.from("[]")), segments: [] }),
    release: () => {},
    searchAnalyzerIdentity: () => analyzerIdentity
  };
  let analyzerCalls = 0;
  const fakeAnalyzer = {
    analyzeQuery: async () => {
      analyzerCalls += 1;
      throw new Error("Kiwi analyzer should not be used for non-Hangul query");
    }
  };
  let capturedJob;
  const fakeSearchExecution = {
    search: async (job) => {
      capturedJob = job;
      return { ok: true, command: "search", matches: [], snapshotId: job.snapshot.snapshotId };
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, fakeSearchExecution, { queryCacheSize: 4 });

  await service.search(
    { vault, query: "scifact evidence running studies", limit: 1 },
    { deadline: Date.now() + 1000, cancellationId: "inline-query", requestId: "inline-query" }
  );

  assert.equal(analyzerCalls, 0);
  assert.equal(capturedJob.analyzerIdentity.name, "router");
  assert.deepEqual(capturedJob.analyzerIdentity.declaredAnalyzers, ["ko"]);
  assert.deepEqual(capturedJob.analyzerIdentity.activeAnalyzers, []);
  assert.equal(capturedJob.analyzerIdentity.model, undefined);
  assert.equal(capturedJob.analysis.raw, "scifact evidence running studies");
  assert.ok(capturedJob.analysis.primaryTerms.includes("scifact"));
});

test("search store service keeps Hangul query analysis on the analyzer worker", async () => {
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const vault = tempRoot();
  const analyzerIdentity = {
    name: "router",
    version: "test",
    runtime: "node-intl",
    node: "test",
    icu: "test",
    model: "kiwi-nlp:test",
    declaredAnalyzers: ["ko"],
    activeAnalyzers: ["ko"]
  };
  const fakeStore = {
    pin: async () => ({ snapshotId: "snap-a", pinToken: "pin-a" }),
    snapshotHandleForPin: () => ({ snapshotId: "snap-a", pinToken: "pin-a", documents: sharedHandle(Buffer.from("[]")), segments: [] }),
    release: () => {},
    searchAnalyzerIdentity: () => analyzerIdentity
  };
  let analyzerCalls = 0;
  const fakeAnalyzer = {
    analyzeQuery: async (raw) => {
      analyzerCalls += 1;
      return {
        analyzerIdentity,
        analysis: {
          raw,
          primaryChannel: "morph",
          primaryTerms: ["한국어"],
          channels: { morph: ["한국어"], surface: ["한국어"], ngram: [] }
        }
      };
    }
  };
  let capturedJob;
  const fakeSearchExecution = {
    search: async (job) => {
      capturedJob = job;
      return { ok: true, command: "search", matches: [], snapshotId: job.snapshot.snapshotId };
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, fakeSearchExecution, { queryCacheSize: 4 });

  await service.search(
    { vault, query: "한국어 검색", limit: 1 },
    { deadline: Date.now() + 1000, cancellationId: "hangul-query", requestId: "hangul-query" }
  );

  assert.equal(analyzerCalls, 1);
  assert.deepEqual(capturedJob.analyzerIdentity.activeAnalyzers, ["ko"]);
  assert.deepEqual(capturedJob.analysis.primaryTerms, ["한국어"]);
});

test("search store service rejects excessive analyzed query terms per channel", async () => {
  const { UsageError } = await futureImport("src/errors.ts");
  const { DaemonSearchStoreService } = await futureImport("src/daemon/search-store/service.ts");
  const released = [];
  const fakeStore = {
    pin: async () => ({ snapshotId: "snap-a", pinToken: "pin-a" }),
    snapshotHandleForPin: () => ({ snapshotId: "snap-a" }),
    release: (pin) => {
      released.push(pin.pinToken);
    }
  };
  const tooManyTerms = Array.from({ length: 2049 }, (_, index) => `term-${index}`);
  const fakeAnalyzer = {
    analyzerIdentity: { name: "test-analyzer", version: "1", node: "test" },
    analyzeQuery: async (raw) => ({
      analyzerIdentity: { name: "test-analyzer", version: "1", node: "test" },
      analysis: {
        raw,
        primaryChannel: "morph",
        primaryTerms: tooManyTerms,
        channels: { morph: tooManyTerms, surface: [], ngram: [] }
      }
    })
  };
  const fakeSearchExecution = {
    preloadSnapshot: async () => [],
    search: async () => {
      throw new Error("search execution should not run after analysis cap failure");
    }
  };
  const service = new DaemonSearchStoreService(fakeStore, fakeAnalyzer, fakeSearchExecution, { queryCacheSize: 1 });

  await assert.rejects(
    () => service.search(
      { vault: tempRoot(), query: "needle", limit: 1 },
      { deadline: Date.now() + 1000, cancellationId: "ac-service-cap", requestId: "ac-service-cap" }
    ),
    (error) => {
      assert.equal(error instanceof UsageError, true);
      assert.match(error.message, /too many morph terms \(2049; max 2048\)/);
      return true;
    }
  );
  assert.deepEqual(released, ["pin-a"]);
});

test("AC3 daemon rejects malformed deadlines and payload shapes without dying", async () => {
  const { createSearchDaemonClient } = await futureImport("src/daemon/client.ts");
  const { createOwnerRegistry } = await futureImport("src/daemon/owner-registry.ts");
  const { encodeFrame } = await futureImport("src/daemon/protocol.ts");
  const runtimeDir = tempRoot();
  const env = { ...process.env, OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir };
  const registry = createOwnerRegistry({ runtimeDir, env });
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    env,
    readyTimeoutMs: 5000
  });

  await client.status();
  const owner = registry.readOwner();
  assert.ok(owner);

  try {
    const malformed = [
      {
        label: "deadline-string",
        request: { protocolVersion: 1, requestId: "deadline-string", method: "Status", deadline: "nope", payload: {} }
      },
      {
        label: "deadline-infinity",
        request: { protocolVersion: 1, requestId: "deadline-infinity", method: "Status", deadline: Infinity, payload: {} }
      },
      {
        label: "payload-null",
        request: { protocolVersion: 1, requestId: "payload-null", method: "Status", deadline: Date.now() + 1000, payload: null }
      },
      {
        label: "payload-array",
        request: { protocolVersion: 1, requestId: "payload-array", method: "Status", deadline: Date.now() + 1000, payload: [] }
      },
      {
        label: "search-primitive-payload",
        request: {
          protocolVersion: 1,
          requestId: "search-primitive-payload",
          method: "Search",
          nonce: owner.nonce,
          deadline: Date.now() + 1000,
          payload: 1
        }
      }
    ];

    for (const { label, request } of malformed) {
      const rejected = await requestRawRpc(owner.socketPath, encodeFrame, request);
      assert.equal(rejected.ok, false, label);
      assert.equal(rejected.error.code, "BAD_REQUEST", label);

      const alive = await requestRawRpc(owner.socketPath, encodeFrame, statusRequest(`alive-${label}`));
      assert.equal(alive.ok, true, label);
      assert.equal(alive.result.ready, true, label);
    }
  } finally {
    await client.shutdown({ deadlineMs: 1000 }).catch(() => {});
  }
});

test("AC10 owner registry treats a 20 second control lock age as the stale boundary", async () => {
  const { createOwnerRegistry } = await futureImport("src/daemon/owner-registry.ts");
  const fresh = createOwnerRegistry({ runtimeDir: tempRoot("optsidian-owner-fresh-") });
  fs.mkdirSync(fresh.lockPath, { recursive: true });
  const nineteenSecondsAgo = new Date(Date.now() - 19_000);
  fs.utimesSync(fresh.lockPath, nineteenSecondsAgo, nineteenSecondsAgo);

  await assert.rejects(
    () => fresh.withControlLock(1, async () => "unreachable"),
    (error) => {
      assert.equal(error.code, "SEARCH_DAEMON_UNAVAILABLE");
      return true;
    }
  );
  assert.equal(fs.existsSync(fresh.lockPath), true);

  const stale = createOwnerRegistry({ runtimeDir: tempRoot("optsidian-owner-stale-") });
  fs.mkdirSync(stale.lockPath, { recursive: true });
  const twentyOneSecondsAgo = new Date(Date.now() - 21_000);
  fs.utimesSync(stale.lockPath, twentyOneSecondsAgo, twentyOneSecondsAgo);
  assert.equal(await stale.withControlLock(100, async () => "acquired"), "acquired");
});

test("AC8 snapshot tmp sweep removes only files aged at least five minutes", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { searchStoreCachePaths } = await futureImport("src/daemon/search-store/cache-paths.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  const store = createDaemonSnapshotStore({ env, analyzer: testAnalyzer() });
  await store.loadVault(vault);

  const paths = searchStoreCachePaths(vault, env);
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  const oldTmp = path.join(paths.tmpDir, "old.segment.tmp");
  const youngTmp = path.join(paths.tmpDir, "young.segment.tmp");
  fs.writeFileSync(oldTmp, "old");
  fs.writeFileSync(youngTmp, "young");
  const now = Date.now();
  fs.utimesSync(oldTmp, new Date(now - 6 * 60_000), new Date(now - 6 * 60_000));
  fs.utimesSync(youngTmp, new Date(now - 60_000), new Date(now - 60_000));

  await store.compact(vault);

  assert.equal(fs.existsSync(oldTmp), false);
  assert.equal(fs.existsSync(youngTmp), true);
});

test("AC9 request scheduler caps remembered cancellations and detects post-task cancellation", async () => {
  const { createRequestScheduler } = await futureImport("src/daemon/scheduler.ts");
  const scheduler = createRequestScheduler();
  for (let index = 0; index < 4097; index += 1) scheduler.cancel(`cancel-${index}`);

  assert.equal(
    await scheduler.run({ deadline: Date.now() + 1000, cancellationId: "cancel-0" }, async () => "oldest-evicted"),
    "oldest-evicted"
  );
  await assert.rejects(
    () => scheduler.run({ deadline: Date.now() + 1000, cancellationId: "cancel-4096" }, async () => "newest-kept"),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    }
  );

  const inFlight = createRequestScheduler();
  let releaseTask;
  const running = inFlight.run(
    { deadline: Date.now() + 1000, cancellationId: "cancel-during-task" },
    async () => new Promise((resolve) => {
      releaseTask = resolve;
    })
  );
  inFlight.cancel("cancel-during-task");
  releaseTask("completed");
  await assert.rejects(
    () => running,
    (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    }
  );
});

test("AC7 snapshot GC keeps active snapshot segment files after count-cap eviction", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { searchStoreCachePaths } = await futureImport("src/daemon/search-store/cache-paths.ts");
  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  writeVaultFile(vaultA, "Alpha.md", "# Alpha\n\nproject alpha\n");
  writeVaultFile(vaultB, "Beta.md", "# Beta\n\nproject beta\n");
  const store = createDaemonSnapshotStore({
    env,
    analyzer: testAnalyzer(),
    countCap: 1,
    byteCap: 1024 * 1024
  });

  await store.loadVault(vaultA);
  const pathsA = searchStoreCachePaths(vaultA, env);
  const activeA = JSON.parse(fs.readFileSync(pathsA.activePointerPath, "utf8"));
  const envelopeA = JSON.parse(fs.readFileSync(path.join(pathsA.snapshotsDir, activeA.snapshotId), "utf8"));
  const segmentPathsA = envelopeA.manifest.partitions.map((partition) => path.join(pathsA.segmentsDir, partition.segmentHash));
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

test("AC1 protocol method coverage includes Clear", async () => {
  const { SEARCH_DAEMON_METHODS, SEARCH_DAEMON_PROTOCOL_VERSION } = await futureImport("src/daemon/protocol.ts");
  const serverSource = fs.readFileSync(path.join(repoRoot, "src/daemon/server.ts"), "utf8");
  const dispatchCases = [...serverSource.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

  assert.deepEqual([...SEARCH_DAEMON_METHODS].sort(), [...new Set(dispatchCases)].sort());
  assert.equal(SEARCH_DAEMON_METHODS.includes("Clear"), true);
  assert.equal(Number.isInteger(SEARCH_DAEMON_PROTOCOL_VERSION), true);
  assert.ok(SEARCH_DAEMON_PROTOCOL_VERSION > 0);
});

test("search daemon preloads execution snapshots only for query searches", async () => {
  const {
    searchRequestNeedsExecutionPreload,
    searchRequestNeedsQueryAnalyzerWarmup
  } = await futureImport("src/daemon/server.ts");
  const base = {
    protocolVersion: 1,
    requestId: "preload-policy",
    deadline: Date.now() + 1000,
    nonce: "nonce"
  };

  assert.equal(searchRequestNeedsExecutionPreload({
    ...base,
    method: "Search",
    payload: { vault: tempRoot(), query: "needle", limit: 1 }
  }), true);
  assert.equal(searchRequestNeedsQueryAnalyzerWarmup({
    ...base,
    method: "Search",
    payload: { vault: tempRoot(), query: "needle", limit: 1 }
  }), false);
  assert.equal(searchRequestNeedsQueryAnalyzerWarmup({
    ...base,
    method: "Search",
    payload: { vault: tempRoot(), query: "한국어 검색", limit: 1 }
  }), true);
  assert.equal(searchRequestNeedsExecutionPreload({
    ...base,
    method: "Search",
    payload: { vault: tempRoot(), tags: ["alpha"], limit: 1 }
  }), false);
  assert.equal(searchRequestNeedsExecutionPreload({
    ...base,
    method: "Explain",
    payload: { vault: tempRoot(), query: "needle", limit: 1 }
  }), true);
  assert.equal(searchRequestNeedsExecutionPreload({
    ...base,
    method: "Status",
    payload: {}
  }), false);
});

test("lifecycle deadlines scale with vault markdown count and bytes", async () => {
  const { createSearchDaemonClient } = await futureImport("src/daemon/client.ts");
  const { vaultLifecycleDeadlineMs } = await futureImport("src/daemon/protocol.ts");
  const vault = tempRoot();
  const alpha = "# Alpha\n";
  const beta = `# Beta\n\n${"x".repeat(1024 * 1024)}\n`;
  writeVaultFile(vault, "Alpha.md", alpha);
  writeVaultFile(vault, "nested/Beta.md", beta);
  fs.writeFileSync(path.join(vault, "ignored.txt"), "ignored");

  const requests = [];
  const client = createSearchDaemonClient({
    runtimeDir: tempRoot(),
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    spawnDaemon: async () => ({ pid: 2100 }),
    connect: async () => ({
      request: async (request) => {
        requests.push(request);
        if (request.method === "Status") {
          return { ok: true, ready: true, phase: "ready", nonce: request.nonce, protocolVersion: 1, vaults: [] };
        }
        if (request.method === "LoadVault") {
          return { ok: true, command: "index", action: "warm", vaults: [{ vaultRoot: vault, status: "ready" }], snapshotId: "snap-a" };
        }
        if (request.method === "Search") {
          return { ok: true, command: "search", matches: [], snapshotId: "snap-a" };
        }
        throw new Error(`unexpected method ${request.method}`);
      },
      close: async () => {}
    })
  });

  const before = Date.now();
  await client.loadVault({ vault });
  const loadRequest = requests.find((request) => request.method === "LoadVault");
  assert.ok(loadRequest);
  const expected = vaultLifecycleDeadlineMs(2, Buffer.byteLength(alpha) + Buffer.byteLength(beta));
  assert.ok(loadRequest.deadline >= before + expected - 100);
  assert.ok(loadRequest.deadline <= Date.now() + expected + 1000);

  await client.search({ vault, query: "alpha", limit: 1 });
  const searchRequest = requests.find((request) => request.method === "Search");
  assert.ok(searchRequest);
  assert.ok(searchRequest.deadline >= before + expected - 100);
});

test("snapshot build reports deterministic progress counts", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  writeVaultFile(vault, "Beta.md", "# Beta\n\nproject beta\n");
  const progress = [];

  await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    progress: (update) => progress.push(update)
  });

  assert.equal(progress[0].phase, "scanning");
  const parsing = progress.filter((update) => update.phase === "parsing");
  assert.equal(parsing.at(-1).total, 2);
  assert.equal(parsing.at(-1).completed, 2);
  const segmenting = progress.filter((update) => update.phase === "segmenting");
  assert.ok(segmenting.length > 0);
  assert.equal(segmenting.at(-1).completed, segmenting.at(-1).total);
});

test("snapshot build caps body ngram terms without capping metadata ngrams", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { BODY_NGRAM_SHORT_MAX_TERMS } = await futureImport("src/core/search/analysis/budget.ts");
  const vault = tempRoot();
  const longHangul = Array.from({ length: BODY_NGRAM_SHORT_MAX_TERMS + 100 }, (_, index) =>
    String.fromCodePoint(0xac00 + index)
  ).join("");
  writeVaultFile(vault, "Alpha.md", `# ${longHangul}\n\n${longHangul}\n`);

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1
  });
  const document = built.diagnostics.documents[0].searchDocument;

  assert.equal(document.bodyNgramTokens.split(" ").length, BODY_NGRAM_SHORT_MAX_TERMS);
  assert.ok(document.titleNgramTokens.split(" ").length > BODY_NGRAM_SHORT_MAX_TERMS);
  assert.equal(built.identityTuple.analyzerIdentity.ngram.bodyBudget.bodyNgramMaxTerms.short, BODY_NGRAM_SHORT_MAX_TERMS);
});

test("search execution state cache is scoped by immutable snapshot id, not request pin token", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "---\ntags: [alpha]\n---\n# Alpha\n\nproject alpha\n");
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: "pin-a",
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      bytes: sharedHandle(segment.bytes)
    }))
  };
  const job = {
    vault,
    search: normalizeSearchParams({ tags: ["alpha"], limit: 10 }),
    analyzerIdentity: analyzer.identity,
    snapshot
  };

  const first = executeSearchJob(job);
  assert.deepEqual(first.matches.map((match) => match.path), ["Alpha.md"]);

  const corruptedSameSnapshot = {
    ...snapshot,
    pinToken: "pin-b",
    documents: sharedHandle(Buffer.from("{not-json")),
    segments: []
  };
  const second = executeSearchJob({ ...job, snapshot: corruptedSameSnapshot });
  assert.deepEqual(second.matches.map((match) => match.path), ["Alpha.md"]);
});

test("metadata-only search does not hydrate positional segments", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "MetadataOnly.md", "---\ntags: [metadata-only]\n---\n# Metadata Only\n\nmetadata-only sentinel unique\n");
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: "pin-a",
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: [{ segmentId: "broken", bytes: sharedHandle(Buffer.from("not-a-canonical-segment")) }]
  };

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ tags: ["metadata-only"], limit: 10 }),
    analyzerIdentity: analyzer.identity,
    snapshot
  });

  assert.deepEqual(result.matches.map((match) => match.path), ["MetadataOnly.md"]);
});

test("search execution preload materializes snapshot cache before search", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { preloadSearchExecutionSnapshot, searchExecutionCacheStats } = await futureImport("src/daemon/search-execution.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: "pin-a",
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      bytes: sharedHandle(segment.bytes)
    }))
  };
  const warmed = preloadSearchExecutionSnapshot(snapshot);
  assert.equal(warmed.snapshotId, built.snapshotId);
  assert.equal(searchExecutionCacheStats().snapshotIds.includes(built.snapshotId), true);

  const second = preloadSearchExecutionSnapshot({
    ...snapshot,
    pinToken: "pin-b",
    documents: sharedHandle(Buffer.from("{not-json")),
    segments: []
  });
  assert.equal(second.cacheHit, true);
});

test("AC1 shared search-daemon client starts daemon, waits ready, and has no direct fallback", async () => {
  const { createSearchDaemonClient } = await futureImport("src/daemon/client.ts");
  const runtimeDir = tempRoot();
  const calls = [];
  const spawns = [];
  const responses = [
    { method: "Status", result: { ready: false, phase: "starting" } },
    { method: "Status", result: { ready: true, nonce: "nonce-a", protocolVersion: 1 } },
    { method: "Search", result: { ok: true, snapshotId: "snap-a", matches: [{ path: "Alpha.md", snippets: [] }] } }
  ];

  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    spawnDaemon: async (record) => {
      spawns.push(record);
      return { pid: 1001 };
    },
    connect: async () => ({
      request: async (request) => {
        calls.push(request);
        const next = responses.shift();
        assert.equal(request.method, next.method);
        if (next.method === "Status" && next.result.ready) next.result.nonce = spawns[0].nonce;
        if (next.method === "Search") assert.equal(request.nonce, spawns[0].nonce);
        return next.result;
      },
      close: async () => {}
    })
  });

  const result = await client.search({ vault: runtimeDir, query: "alpha", limit: 5, deadlineMs: 1000 });

  assert.equal(spawns.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["Status", "Status", "Search"]);
  assert.equal(result.snapshotId, "snap-a");
  assert.deepEqual(result.matches.map((match) => match.path), ["Alpha.md"]);

  const failing = createSearchDaemonClient({
    runtimeDir: tempRoot(),
    binaryPath: "/missing/optsidian",
    spawnDaemon: async () => {
      throw new Error("spawn denied");
    },
    connect: async () => {
      throw new Error("socket unavailable");
    }
  });
  await assert.rejects(
    () => failing.search({ vault: runtimeDir, query: "alpha", limit: 1, deadlineMs: 10 }),
    (error) => {
      assert.equal(error.code, "SEARCH_DAEMON_UNAVAILABLE");
      assert.match(error.message, /search daemon/i);
      assert.match(error.message, /ready|start/i);
      assert.doesNotMatch(error.message, /fallback/i);
      return true;
    }
  );
});

test("daemon readiness nonce auth is deterministic in-process", async () => {
  const { createSearchDaemonClient } = await futureImport("src/daemon/client.ts");
  const runtimeDir = tempRoot();
  const seen = [];
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    spawnDaemon: async () => ({ pid: 2002 }),
    connect: async () => ({
      request: async (request) => {
        seen.push(request);
        if (request.method === "Status") {
          return { ok: true, ready: true, phase: "ready", nonce: request.nonce, protocolVersion: 1, owner: { nonce: request.nonce } };
        }
        assert.equal(request.method, "Search");
        assert.equal(typeof request.nonce, "string");
        return { ok: true, command: "search", snapshotId: "snap-a", matches: [] };
      },
      close: async () => {}
    })
  });

  await client.search({ vault: runtimeDir, query: "alpha", limit: 1 });
  assert.deepEqual(seen.map((request) => request.method), ["Status", "Search"]);
  assert.equal(seen[0].nonce, seen[1].nonce);

  const mismatched = createSearchDaemonClient({
    runtimeDir: tempRoot(),
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    spawnDaemon: async () => ({ pid: 2003 }),
    connect: async () => ({
      request: async () => ({ ok: true, ready: true, phase: "ready", nonce: "wrong-owner-nonce", protocolVersion: 1 }),
      close: async () => {}
    })
  });
  await assert.rejects(
    () => mismatched.status({ deadlineMs: 100 }),
    (error) => {
      assert.equal(error.code, "SEARCH_DAEMON_AUTH_FAILED");
      return true;
    }
  );
});

test("daemon readiness handshake authenticates owner nonce over RPC integration", async () => {
  const { createSearchDaemonClient } = await futureImport("src/daemon/client.ts");
  const runtimeDir = tempRoot();
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: "",
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: "1",
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: "1000"
  };
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, "dist", "optsidian"),
    readyTimeoutMs: 30000,
    env
  });

  try {
    const status = await client.status({ deadlineMs: 5000 });

    assert.equal(status.ok, true);
    assert.equal(status.ready, true);
    assert.equal(status.protocolVersion, 1);
    assert.equal(status.owner.nonce, status.nonce);
    assert.equal(status.owner.socketPath.endsWith(".sock"), true);
  } finally {
    await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
  }
});

test("AC1 import boundary forbids direct search/index execution outside daemon and pure tests", () => {
  const scannedRoots = ["src", "scripts"].map((root) => path.join(repoRoot, root));
  const files = scannedRoots.flatMap((root) =>
    listFiles(root, (filePath) => /\.(?:ts|mts|mjs|js)$/.test(filePath))
  );
  const violations = [];

  for (const file of files) {
    const rel = repoRelative(file);
    if (rel.startsWith("src/daemon/") || rel.startsWith("src/core/search/")) continue;

    const source = fs.readFileSync(file, "utf8");
    const importedSymbols = importedSearchExecutionSymbols(source);
    if (importedSymbols.length === 0) continue;

    for (const match of source.matchAll(/\b(?:import|export)\s+([^;]+?)\s+from\s+["']([^"']+)["']/g)) {
      const resolved = resolveSpecifier(file, match[2]);
      if (/src\/core\/search\/index\.(?:js|ts)$/.test(resolved)) {
        violations.push(`${rel}: direct ${importedSymbols.join(", ")} import from ${match[2]}`);
      }
    }
    for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (/src\/core\/search\/index\.(?:js|ts)$/.test(resolved)) {
        violations.push(`${rel}: dynamic direct ${importedSymbols.join(", ")} import from ${match[1]}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("AC9 canonical segment bytes and snapshot id are history-independent", async () => {
  const { buildCanonicalSnapshotForTests } = await futureImport("src/core/search/segments/canonical.ts");
  const { canonicalValueBytes } = await futureImport("src/core/search/segments/index.ts");
  const { RANKING_CONSTANTS } = await futureImport("src/core/search/constants.ts");
  const { BODY_INDEX_BUDGET_IDENTITY } = await futureImport("src/core/search/analysis/budget.ts");
  const identityTuple = {
    buildVersion: "positional-build-v1",
    fieldSetVersion: "field-set-v1",
    partitionBits: 4,
    analyzerIdentity: { name: "router", channels: ["morph", "surface", "ngram"], ngram: { min: 2, max: 3, bodyBudget: BODY_INDEX_BUDGET_IDENTITY } },
    searchSettingsHash: sha256("index-affecting-settings-only"),
    rankingFeatureVersion: sha256(canonicalValueBytes(RANKING_CONSTANTS)),
    retrieverIdentity: null
  };
  const documents = [
    { path: "Alpha.md", content: "# Alpha\n\nproject alpha\n" },
    { path: "Folder/Beta.md", content: "# Beta\n\nproject beta\n" }
  ];

  const rebuilt = await buildCanonicalSnapshotForTests({ identityTuple, documents, history: [{ type: "rebuild" }] });
  const rebuiltAgain = await buildCanonicalSnapshotForTests({ identityTuple, documents, history: [{ type: "rebuild" }] });
  const refreshedCompacted = await buildCanonicalSnapshotForTests({
    identityTuple,
    documents,
    history: [
      { type: "refresh", paths: ["Alpha.md"] },
      { type: "refresh", paths: ["Folder/Beta.md"] },
      { type: "compact" }
    ]
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
    rebuilt.segments.map((segment) => Buffer.from(segment.bytes).toString("hex")),
    rebuiltAgain.segments.map((segment) => Buffer.from(segment.bytes).toString("hex"))
  );
  assert.deepEqual(
    rebuilt.segments.map((segment) => Buffer.from(segment.bytes).toString("hex")),
    refreshedCompacted.segments.map((segment) => Buffer.from(segment.bytes).toString("hex"))
  );
});

test("golden ranking identity is derived from canonical RANKING_CONSTANTS bytes", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { canonicalValueBytes } = await futureImport("src/core/search/segments/index.ts");
  const { RANKING_CONSTANTS } = await futureImport("src/core/search/constants.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nNeedle project alpha\n");

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer()
  });
  const expected = sha256(canonicalValueBytes(RANKING_CONSTANTS));

  assert.equal(built.identityTuple.rankingFeatureVersion, expected);
  assert.equal(built.manifest.identityTuple.rankingFeatureVersion, expected);
});

test("snapshot identity carries the production INDEX_BUILD_VERSION lever", async () => {
  const { buildCanonicalSearchSnapshot, INDEX_BUILD_VERSION } = await futureImport("src/daemon/search-store/builder.ts");
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nNeedle project alpha\n");

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer()
  });

  assert.equal(built.identityTuple.buildVersion, INDEX_BUILD_VERSION);
  assert.equal(built.manifest.identityTuple.buildVersion, INDEX_BUILD_VERSION);
});

test("AC7 rebuild during an in-flight search keeps the pinned snapshot stable", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer: testAnalyzer(),
    countCap: 4,
    byteCap: 1024 * 1024
  });

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const pinnedSnapshotId = pin.snapshotId;
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha changed\n");
  const rebuilt = await store.rebuild(vault);

  assert.notEqual(rebuilt.snapshotId, pinnedSnapshotId);
  assert.equal(pin.snapshotId, pinnedSnapshotId);
  assert.equal(store.snapshotHandleForPin(pin).snapshotId, pinnedSnapshotId);
  store.release(pin);
});

test("AC8 daemon restart reloads latest valid persisted snapshot with identity preserved", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");

  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const firstStore = createDaemonSnapshotStore({ env, analyzer: testAnalyzer() });
  const first = await firstStore.loadVault(vault);
  const firstSnapshotId = first.snapshotId;
  assert.match(firstSnapshotId, /^[a-f0-9]{64}$/);

  const restartedStore = createDaemonSnapshotStore({ env, analyzer: testAnalyzer() });
  const restarted = await restartedStore.loadVault(vault);
  assert.equal(restarted.snapshotId, firstSnapshotId);
});

test("AC11 cross-vault count budget evicts cold snapshots and reloads on demand", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const cacheRoot = tempRoot();
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  writeVaultFile(vaultA, "Alpha.md", "# Alpha\n\nproject alpha\n");
  writeVaultFile(vaultB, "Beta.md", "# Beta\n\nproject beta\n");
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer: testAnalyzer(),
    countCap: 1,
    byteCap: 1024 * 1024
  });

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

test("AC4 snippets resolve from the pinned snapshot without rereading vault files or tokenizing lines", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nfirst line\nNeedle channel target\n");
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer,
    countCap: 4,
    byteCap: 1024 * 1024
  });

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const payload = store.snapshotHandleForPin(pin);
  const payloadDocuments = JSON.parse(new TextDecoder().decode(new Uint8Array(
    payload.documents.buffer,
    payload.documents.byteOffset,
    payload.documents.byteLength
  )));
  const snippetLines = payloadDocuments.flatMap((document) => document.snippetLines);
  assert.ok(snippetLines.some((line) => line.segmentId && line.snippetId && line.byteEnd >= line.byteStart));
  assert.ok(snippetLines.some((line) => line.channels.morph.includes("needle")));
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nSHOULD NOT BE READ\n");

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(file, ...rest) {
    if (String(file).startsWith(vault)) throw new Error("AC4 violation: query-time vault read");
    return originalReadFileSync.call(this, file, ...rest);
  };
  try {
    const result = executeSearchJob({
      vault,
      search: normalizeSearchParams({ query: "needle", limit: 3, debug: true }),
      analysis: {
        raw: "needle",
        primaryChannel: "morph",
        primaryTerms: ["needle"],
        channels: { morph: ["needle"], surface: ["needle"], ngram: [] }
      },
      analyzerIdentity: analyzer.identity,
      snapshot: payload
    });
    assert.equal(result.snapshotId, pin.snapshotId);
    assert.equal(result.matches[0]?.path, "Alpha.md");
    assert.deepEqual(result.matches[0].snippets.map((snippet) => snippet.text), ["Needle channel target"]);
  } finally {
    fs.readFileSync = originalReadFileSync;
    store.release(pin);
  }
});

test("AC5 concurrent identical searches on one pinned snapshot return identical paths and snippets", async () => {
  const fixture = await createPinnedSearchFixture({
    "Alpha.md": "# Alpha\n\nNeedle channel target\n",
    "Beta.md": "# Beta\n\nNeedle channel target beta\n",
    "Gamma.md": "# Gamma\n\nOther content\n"
  }, { query: "needle", limit: 5 });

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

test("AC6 concurrent scoring order equals sequential scoring order on one pinned snapshot", async () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `Doc-${index}.md`,
    `# Doc ${index}\n\nNeedle project ${index % 2 === 0 ? "alpha" : "beta"} needle ${index}\n`
  ]));
  const fixture = await createPinnedSearchFixture(files, { query: "needle project", limit: 8 });

  try {
    const sequential = Array.from({ length: 6 }, () => fixture.search().matches.map((match) => match.path));
    for (const order of sequential.slice(1)) assert.deepEqual(order, sequential[0]);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
      Promise.resolve().then(() => fixture.search().matches.map((match) => match.path))
    ));
    for (const order of concurrent) assert.deepEqual(order, sequential[0]);
  } finally {
    fixture.release();
  }
});

test("AC12 debug output explains channels, scores, rerank signals, snippet source, analyzer identity, and snapshot id", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nNeedle project alpha\n");
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer,
    countCap: 4,
    byteCap: 1024 * 1024
  });

  await store.loadVault(vault);
  const pin = await store.pin(vault);
  try {
    const result = executeSearchJob({
      vault,
      search: normalizeSearchParams({ query: "needle", limit: 3, debug: true }),
      analysis: {
        raw: "needle",
        primaryChannel: "morph",
        primaryTerms: ["needle"],
        channels: { morph: ["needle"], surface: ["needle"], ngram: [] }
      },
      analyzerIdentity: analyzer.identity,
      snapshot: store.snapshotHandleForPin(pin)
    });
    assert.equal(result.debug.snapshotId, pin.snapshotId);
    assert.equal(result.debug.analyzer.name, analyzer.identity.name);
    assert.deepEqual(result.debug.query.channels.morph, ["needle"]);
    const debug = result.matches[0]?.debug;
    assert.ok(debug);
    assert.equal(debug.snapshotId, pin.snapshotId);
    assert.equal(debug.analyzer.name, analyzer.identity.name);
    assert.deepEqual(debug.queryChannels.morph, ["needle"]);
    assert.ok(debug.matchedChannels.includes("morph"));
    assert.equal(typeof debug.candidateScore, "number");
    assert.equal(typeof debug.retrievalScore, "number");
    assert.equal(typeof debug.rerankScore, "number");
    assert.equal(typeof debug.rarityScore, "number");
    assert.equal(typeof debug.proximityScore, "number");
    assert.equal(debug.snippetSource, "snapshot-field-text");
  } finally {
    store.release(pin);
  }
});

test("AC15 fixed positional corpus preserves expected top-N ranking", async () => {
  const files = {
    "Alpha Calibration.md": "# Alpha Calibration\n\nPrimary exact target for alpha calibration.\n",
    "Ops/Alpha Calibration.md": "# Ops Note\n\nFilename exact target for alpha calibration.\n",
    "Alpha Calibration Guide.md": "# Alpha Calibration Guide\n\nPhrase title target.\n",
    "Calibration Alpha.md": "# Calibration Alpha\n\nReverse order alpha calibration body.\n",
    "Research/Calibration Notes.md": "# Calibration Notes\n\nAlpha calibration appears in the body.\n"
  };
  for (let index = 0; index < 19; index += 1) {
    files[`Distractors/Note-${String(index).padStart(2, "0")}.md`] =
      `# Distractor ${index}\n\nAlpha operations and calibration records are mentioned separately ${index}.\n`;
  }
  const fixture = await createPinnedSearchFixture(files, { query: "alpha calibration", limit: 10 });

  try {
    const paths = fixture.search().matches.map((match) => match.path);
    assert.deepEqual(paths.slice(0, 3), [
      "Alpha Calibration.md",
      "Ops/Alpha Calibration.md",
      "Alpha Calibration Guide.md"
    ]);
  } finally {
    fixture.release();
  }
});

test("Hangul ngram retrieval falls back to morph and surface when ngram candidates are empty", async () => {
  const fixture = await createPinnedSearchFixture({
    "Target.md": "# Target\n\n희귀한국어\n",
    "Other.md": "# Other\n\nordinary content\n"
  }, { query: "희귀한국어", limit: 10 });

  try {
    const result = fixture.search({
      analysis: {
        raw: "희귀한국어",
        primaryChannel: "morph",
        primaryTerms: ["희귀한국어"],
        channels: {
          morph: ["희귀한국어"],
          surface: ["희귀한국어"],
          ngram: ["없는그램"]
        }
      }
    });

    assert.deepEqual(result.matches.map((match) => match.path), ["Target.md"]);
  } finally {
    fixture.release();
  }
});

test("refresh after mutation makes new files visible and removed files disappear", async () => {
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Seed.md", "# Seed\n\nordinary content\n");
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer,
    countCap: 4,
    byteCap: 16 * 1024 * 1024
  });
  const searchPaths = async () => {
    const pin = await store.pin(vault);
    try {
      const result = executeSearchJob({
        vault,
        search: normalizeSearchParams({ query: "mutationtarget", limit: 5 }),
        analysis: testQueryAnalysis("mutationtarget"),
        analyzerIdentity: analyzer.identity,
        snapshot: store.snapshotHandleForPin(pin)
      });
      return result.matches.map((match) => match.path);
    } finally {
      store.release(pin);
    }
  };

  await store.loadVault(vault);
  assert.deepEqual(await searchPaths(), []);

  writeVaultFile(vault, "New.md", "# New\n\nmutationtarget appears after refresh\n");
  const refreshed = await store.refresh(vault);
  assert.equal(refreshed.rebuilt, true);
  assert.deepEqual(await searchPaths(), ["New.md"]);

  fs.rmSync(path.join(vault, "New.md"));
  await store.rebuild(vault);
  assert.deepEqual(await searchPaths(), []);
});

test("query-analysis cache key is deterministic and does not become result identity", async () => {
  const { QueryAnalysisCache, queryAnalysisCacheKey } = await futureImport("src/daemon/query-analysis-cache.ts");
  const analyzerIdentity = { name: "test-analyzer", version: "1", node: "test" };
  const input = {
    analyzerIdentity,
    rawQuery: "Needle",
    fields: ["body", "title"],
    searchSettingsHash: "settings-a"
  };
  const analysis = {
    raw: "Needle",
    primaryChannel: "morph",
    primaryTerms: ["needle"],
    channels: { morph: ["needle"], surface: ["needle"], ngram: ["ne"] }
  };

  assert.equal(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, fields: ["title", "body"] }));
  assert.notEqual(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, rawQuery: "Other" }));
  assert.notEqual(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, analyzerIdentity: { ...analyzerIdentity, version: "2" } }));
  assert.notEqual(queryAnalysisCacheKey(input), queryAnalysisCacheKey({ ...input, searchSettingsHash: "settings-b" }));

  const cache = new QueryAnalysisCache(2);
  assert.equal(cache.get(input), undefined);
  cache.set(input, analysis);
  const cached = cache.get(input);
  assert.deepEqual(cached, analysis);
  cached.channels.morph.push("mutated");
  assert.deepEqual(cache.get(input), analysis);
});

test("AC19 search-execution pool serves a second search while a heavy search is in-flight", async () => {
  const { DaemonWorkerPool } = await futureImport("src/daemon/worker-pool.ts");
  const { SearchExecutionWorkerPool } = await futureImport("src/daemon/pools.ts");
  const { createDaemonSnapshotStore } = await futureImport("src/daemon/search-store/snapshot-store.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const cacheRoot = tempRoot();
  const vault = tempRoot();
  for (let index = 0; index < 1200; index += 1) {
    writeVaultFile(vault, `Note-${index}.md`, `# Note ${index}\n\nneedle payload ${"payload ".repeat(120)} ${index}\n`);
  }
  writeVaultFile(vault, "Unique.md", "# Unique\n\nuniquetarget isolated result\n");
  const analyzer = testAnalyzer();
  const store = createDaemonSnapshotStore({
    env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
    analyzer,
    countCap: 4,
    byteCap: 16 * 1024 * 1024
  });
  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const pool = new SearchExecutionWorkerPool(new DaemonWorkerPool({
    name: "ac19-search-execution",
    kind: "search",
    size: 2,
    env: { ...process.env }
  }));
  await pool.warmup();
  const payload = store.snapshotHandleForPin(pin);
  try {
    let heavySettled = false;
    const heavy = pool.search({
      vault,
      search: normalizeSearchParams({ query: "needle payload", limit: 1000, debug: true }),
      analysis: testQueryAnalysis("needle payload"),
      analyzerIdentity: analyzer.identity,
      snapshot: payload
    }, {
      deadline: Date.now() + 10000,
      cancellationId: "heavy",
      vault
    }).finally(() => {
      heavySettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await pool.search({
      vault,
      search: normalizeSearchParams({ query: "uniquetarget", limit: 1, debug: false }),
      analysis: testQueryAnalysis("uniquetarget"),
      analyzerIdentity: analyzer.identity,
      snapshot: payload
    }, {
      deadline: Date.now() + 10000,
      cancellationId: "second",
      vault
    });

    assert.equal(heavySettled, false, "heavy search should still be in-flight when the second search returns");
    assert.deepEqual(second.matches.map((match) => match.path), ["Unique.md"]);
    pool.cancel("heavy");
    await assert.rejects(heavy, (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    });
  } finally {
    await pool.close();
    store.release(pin);
  }
});

test("AC3 analyzer-daemon socket client symbols are removed from analyzer construction", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/core/search/analyzer.ts"), "utf8");
  for (const symbol of [
    "requestRunningDaemon",
    "requestDaemonTokenization",
    "createDaemonAnalyzer",
    "createDaemonLeasedAnalyzer",
    "ensureAnalyzerDaemonReady",
    "startAnalyzerDaemonWarmup",
    "spawnAnalyzerDaemonProcess"
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`));
  }
});

test("AC16 deterministic scheduler preserves stable ordering under deadline cancellation and backpressure", async () => {
  const { createDeterministicSearchSchedulerForTests } = await futureImport("src/daemon/scheduler.ts");
  const scheduler = createDeterministicSearchSchedulerForTests({
    activeSnapshotId: "snap-old",
    nextSnapshotId: "snap-new",
    queryResults: [{ path: "Alpha.md", score: 1 }, { path: "Beta.md", score: 0.5 }],
    backgroundQueueDepth: 100
  });

  const baseline = await scheduler.search({ query: "alpha", deadlineMs: 1000, cancellationId: "keep" });
  assert.deepEqual(baseline.matches.map((match) => match.path), ["Alpha.md", "Beta.md"]);
  assert.equal(baseline.snapshotId, "snap-old");

  await scheduler.publishNextSnapshot();
  const expired = await scheduler.search({ query: "alpha", deadlineMs: 0, cancellationId: "deadline" });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "DEADLINE_EXCEEDED");
  assert.equal(expired.partialResults, undefined);
  assert.equal(expired.snapshotId, "snap-old");

  const cancelled = await scheduler.search({ query: "alpha", deadlineMs: 1000, cancellationId: "cancelled", cancelBeforeRun: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "CANCELLED");
  assert.equal(cancelled.partialResults, undefined);
  assert.equal(cancelled.snapshotId, "snap-old");

  const pressure = await scheduler.applyBackpressure();
  assert.deepEqual(pressure.shedQueues, ["throughput-rebuild", "throughput-refresh", "throughput-compact"]);
  assert.equal(pressure.queryWorkShed, false);
});

test("AC16 real request scheduler enforces deadline cancellation and throughput backpressure", async () => {
  const { createRequestScheduler } = await futureImport("src/daemon/scheduler.ts");
  const expired = createRequestScheduler();
  await assert.rejects(
    () => expired.run({ deadline: Date.now() - 1, cancellationId: "past-deadline" }, async () => "unreachable"),
    (error) => {
      assert.equal(error.code, "DEADLINE_EXCEEDED");
      return true;
    }
  );

  const cancelled = createRequestScheduler();
  cancelled.cancel("cancelled-before-run");
  await assert.rejects(
    () => cancelled.run({ deadline: Date.now() + 1000, cancellationId: "cancelled-before-run" }, async () => "unreachable"),
    (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    }
  );

  const inFlight = createRequestScheduler();
  let releaseTask;
  const running = inFlight.run(
    { deadline: Date.now() + 1000, cancellationId: "cancelled-after-run" },
    async () => new Promise((resolve) => {
      releaseTask = resolve;
    })
  );
  inFlight.cancel("cancelled-after-run");
  releaseTask("done");
  await assert.rejects(
    () => running,
    (error) => {
      assert.equal(error.code, "CANCELLED");
      return true;
    }
  );

  const pressure = createRequestScheduler().applyBackpressure({
    backgroundQueueDepth: 42,
    queues: [
      { name: "query-search", kind: "query", depth: 99 },
      { name: "throughput-refresh", kind: "throughput", depth: 4 },
      { name: "throughput-compact", kind: "throughput", depth: 0 },
      { name: "throughput-rebuild", kind: "throughput", depth: 2 }
    ]
  });
  assert.deepEqual(pressure.shedQueues, ["throughput-rebuild", "throughput-refresh"]);
  assert.equal(pressure.queryWorkShed, false);
  assert.equal(pressure.backgroundQueueDepth, 42);
});

test("AC17 publication seam crash-injection preserves last valid snapshot and GC roots", async () => {
  const {
    PUBLICATION_STEPS,
    computeGcRootsForTests,
    createSnapshotPublisherForTests,
    durableRename
  } = await futureImport("src/daemon/search-store/publication.ts");

  assert.deepEqual(PUBLICATION_STEPS, AC17_PUBLICATION_STEPS);
  assert.equal(typeof durableRename, "function");

  const roots = computeGcRootsForTests({
    activePointers: ["snap-active"],
    inFlightPublishManifests: ["snap-publishing"],
    retainedSnapshotManifests: ["snap-retained"],
    inMemoryPins: ["snap-pinned"]
  });
  assert.deepEqual([...roots.snapshotIds].sort(), ["snap-active", "snap-pinned", "snap-publishing", "snap-retained"]);

  for (const failAt of AC17_PUBLICATION_STEPS) {
    const root = tempRoot();
    const publisher = createSnapshotPublisherForTests({ root, failAt });
    await publisher.seedActiveSnapshot({ snapshotId: "snap-old", segmentHashes: ["seg-old"] });
    await assert.rejects(
      () => publisher.publish({ snapshotId: "snap-new", segmentHashes: ["seg-new"], bytes: Buffer.from("new") }),
      new RegExp(failAt)
    );
    const recovered = await publisher.recover();
    assert.equal(recovered.activeSnapshotId, "snap-old", `${failAt} must leave last valid snapshot active`);
    assert.equal(recovered.validSnapshotIds.includes("snap-old"), true);
    assert.equal(recovered.validSnapshotIds.includes("snap-new"), false);
  }
});

test("AC18 owner registry records stable fields and converges stale starts to one compatible daemon", async () => {
  const {
    OWNER_RECORD_FIELDS,
    convergeOnCompatibleDaemonForTests,
    createOwnerRegistryForTests
  } = await futureImport("src/daemon/owner-registry.ts");

  assert.deepEqual(OWNER_RECORD_FIELDS, AC18_OWNER_FIELDS);

  const desired = {
    uid: process.getuid?.() ?? 0,
    runtimeHash: "runtime-a",
    binaryVersion: "binary-content-hash-b",
    protocolVersion: 1
  };
  const scenarios = [
    "protocol-mismatch",
    "binary-mismatch",
    "stale-pid-lock",
    "orphaned-socket"
  ];

  for (const scenario of scenarios) {
    const registry = createOwnerRegistryForTests({ scenario, desired });
    const result = await convergeOnCompatibleDaemonForTests(registry, desired);
    assert.equal(result.owner.binaryVersion, desired.binaryVersion, scenario);
    assert.equal(result.owner.protocolVersion, desired.protocolVersion, scenario);
    assert.equal(registry.compatibleOwners().length, 1, scenario);
  }

  const authFailure = createOwnerRegistryForTests({ scenario: "auth-failure", desired });
  await assert.rejects(
    () => convergeOnCompatibleDaemonForTests(authFailure, desired),
    (error) => {
      assert.equal(error.code, "SEARCH_DAEMON_AUTH_FAILED");
      assert.match(error.message, /auth|nonce|daemon/i);
      return true;
    }
  );

  const coldStartRegistry = createOwnerRegistryForTests({ scenario: "simultaneous-cold-starts", desired });
  const results = await Promise.all(Array.from({ length: 8 }, () => convergeOnCompatibleDaemonForTests(coldStartRegistry, desired)));
  assert.equal(new Set(results.map((result) => result.owner.nonce)).size, 1);
  assert.equal(coldStartRegistry.compatibleOwners().length, 1);
});
