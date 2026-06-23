import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
  "settingsSchemaVersion",
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

function assertOkSpawn(result, label) {
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
        analysis: testQueryAnalysis(query),
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

test("AC1 protocol method coverage includes Clear", async () => {
  const { SEARCH_DAEMON_METHODS, SEARCH_DAEMON_PROTOCOL_VERSION } = await futureImport("src/daemon/protocol.ts");
  const serverSource = fs.readFileSync(path.join(repoRoot, "src/daemon/server.ts"), "utf8");
  const dispatchCases = [...serverSource.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

  assert.deepEqual([...SEARCH_DAEMON_METHODS].sort(), [...new Set(dispatchCases)].sort());
  assert.equal(SEARCH_DAEMON_METHODS.includes("Clear"), true);
  assert.equal(Number.isInteger(SEARCH_DAEMON_PROTOCOL_VERSION), true);
  assert.ok(SEARCH_DAEMON_PROTOCOL_VERSION > 0);
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
          return { ok: true, ready: true, phase: "ready", nonce: request.nonce, protocolVersion: 1, settingsSchemaVersion: 1, owner: { nonce: request.nonce } };
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
  const identityTuple = {
    schemaVersion: 1,
    fieldSetVersion: "field-set-v1",
    partitionVersion: 1,
    partitionBits: 4,
    analyzerIdentity: { name: "router", channels: ["morph", "surface", "ngram"], ngram: { min: 2, max: 3 } },
    searchSettingsHash: sha256("index-affecting-settings-only"),
    indexBuilderVersion: "positional-v1",
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

test("AC10 Explain trace emitted by search execution replays offline and validates mutations deterministically", async () => {
  const dir = tempRoot();
  const fixture = await createPinnedSearchFixture({
    "Alpha Project.md": "# Alpha Project\n\nalpha project target\n",
    "Beta Project.md": "# Beta Project\n\nalpha project beta body\n",
    "Gamma.md": "# Gamma\n\nunrelated\n"
  }, { query: "alpha project", limit: 5, debug: true });
  let trace;
  try {
    const explained = fixture.search({ explain: true });
    assert.equal(explained.ok, true);
    assert.ok(explained.explainTrace);
    assert.ok(explained.explainTrace.inputs.candidateSet.candidates.length > 0);
    assert.deepEqual(explained.explainTrace.inputs.queryAnalysis, testQueryAnalysis("alpha project"));
    trace = explained.explainTrace;
  } finally {
    fixture.release();
  }

  const tracePath = path.join(dir, "trace.json");
  fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  const replayArgs = [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/search-eval.mjs"),
    "--offline-explain-trace",
    tracePath,
    "--format=json"
  ];
  const replay = spawnSync(process.execPath, replayArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPTSIDIAN_SEARCH_DAEMON_SOCKET: path.join(dir, "missing.sock"),
      OPTSIDIAN_VAULT_PATH: path.join(dir, "missing-vault")
    }
  });

  assertOkSpawn(replay, "offline explain replay");
  const replayAgain = spawnSync(process.execPath, replayArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPTSIDIAN_SEARCH_DAEMON_SOCKET: path.join(dir, "missing.sock"),
      OPTSIDIAN_VAULT_PATH: path.join(dir, "missing-vault")
    }
  });
  assertOkSpawn(replayAgain, "offline explain replay repeat");
  assert.equal(replayAgain.stdout, replay.stdout);
  const replayed = JSON.parse(replay.stdout);
  assert.equal(replayed.outputHash, trace.expectedOutputHash);

  const mutations = [
    ["rankingAlgorithmId", "different-ranker"],
    ["rankingConfig", { ...trace.rankingConfig, rrfK: trace.rankingConfig.rrfK + 1 }],
    ["inputs", { ...trace.inputs, candidateSet: { ...trace.inputs.candidateSet, candidates: [] } }],
    ["expectedOutputHash", "0".repeat(64)]
  ];
  for (const [key, value] of mutations) {
    const mutatedPath = path.join(dir, `trace-${key}.json`);
    fs.writeFileSync(mutatedPath, `${JSON.stringify({ ...trace, [key]: value }, null, 2)}\n`);
    const mutated = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts/search-eval.mjs"),
      "--offline-explain-trace",
      mutatedPath,
      "--format=json"
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(mutated.status, 0, `${key} mutation must fail validation`);
    assert.match(mutated.stderr || mutated.stdout, /trace validation|output hash|ranking algorithm|ranking config|candidate/i);
  }
});

test("AC16 SLO fixture is opt-in documentation", async () => {
  const fixtureResult = spawnSync(process.execPath, [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/search-eval.mjs"),
    "--print-search-daemon-slo-fixture"
  ], { cwd: repoRoot, encoding: "utf8" });
  assertOkSpawn(fixtureResult, "SLO fixture");
  const fixture = JSON.parse(fixtureResult.stdout);
  assert.equal(fixture.name, "Mixed200 warm pinned snapshot");
  assert.equal(fixture.gate, "opt-in benchmark outside npm test");
  assert.deepEqual(fixture.targets, [
    { concurrency: 1, p50MsMax: 300, p95MsMax: 600 },
    { concurrency: 4, p95MsMax: 900, provisional: true },
    { concurrency: 8, p95MsMax: 1500, provisional: true },
    { concurrency: 16, p95MsMax: 2500, provisional: true }
  ]);

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
    protocolVersion: 1,
    settingsSchemaVersion: 1
  };
  const scenarios = [
    "protocol-mismatch",
    "binary-mismatch",
    "settings-mismatch",
    "stale-pid-lock",
    "orphaned-socket"
  ];

  for (const scenario of scenarios) {
    const registry = createOwnerRegistryForTests({ scenario, desired });
    const result = await convergeOnCompatibleDaemonForTests(registry, desired);
    assert.equal(result.owner.binaryVersion, desired.binaryVersion, scenario);
    assert.equal(result.owner.protocolVersion, desired.protocolVersion, scenario);
    assert.equal(result.owner.settingsSchemaVersion, desired.settingsSchemaVersion, scenario);
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
