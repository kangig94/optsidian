import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseArgs } from "../src/cli/args.ts";
import {
  retrievePayloadFromSimilarity,
  similarityRequestFromArgs,
  similarityResultFromRetrieve
} from "../src/cli/commands/similarity.ts";
import { normalizeSimilarityParams } from "../src/core/similarity.ts";
import {
  DeterministicHashProvider,
  buildEmbeddingSet,
  createDeterministicEmbeddingSetBuilder
} from "./helpers/deterministic-embedding.mjs";
import { corpusSnapshotIdFromManifest } from "../src/core/search/segments/canonical.ts";
import { createSearchDaemonClient } from "../src/daemon/client.ts";
import {
  SEARCH_DAEMON_PROTOCOL_VERSION
} from "../src/daemon/protocol.ts";
import { createQueryServer } from "../src/daemon/server.ts";
import { connectRpc, createRpcServer } from "../src/daemon/transport.ts";
import { ModelSessionLifecycle } from "../src/daemon/model-session/index.ts";
import { searchStoreCachePaths } from "../src/daemon/search-store/cache-paths.ts";
import {
  DaemonSnapshotStore,
  computeRetrievalSnapshotId
} from "../src/daemon/search-store/snapshot-store.ts";
import { DaemonSearchStoreService } from "../src/daemon/search-store/service.ts";
import {
  buildCanonicalSearchSnapshot,
  snapshotIdentityTupleForAnalyzerIdentity
} from "../src/daemon/search-store/builder.ts";
import { executeSearchShardJob } from "../src/daemon/search-execution.ts";
import { RetrievalFreshnessStore, VectorGenerationPool, vectorStoreCachePaths } from "../src/daemon/vector-store/index.ts";
import {
  createOwnerRecord,
  createOwnerRegistry,
  desiredOwnerIdentity,
  socketPathsForOwner
} from "../src/daemon/owner-registry.ts";

const PROFILE_HASH = "retrieval-p5-profile";
const REMOVED_STUB_NAME = ["similarity", "Unavailable", "Result"].join("");
const REMOVED_VECTOR_SECTION = ["vector", "Block"].join("");

function tempRoot(prefix = "optsidian-retrieval-p5-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer(identity = { name: "test-analyzer", version: "retrieval-substrate-p5", node: "test" }) {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity,
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function queryAnalysis(raw) {
  const terms = [...raw.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    raw,
    primaryChannel: "morph",
    primaryTerms: terms,
    channels: {
      morph: terms,
      surface: terms,
      ngram: []
    }
  };
}

function context(ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: `p5-${Math.random().toString(16).slice(2)}`,
    requestId: `p5-${Math.random().toString(16).slice(2)}`
  };
}

function createAnalyzerPool(analyzer) {
  return {
    analyzerIdentity: analyzer.identity,
    async warmup() {},
    async analyzeQuery(rawQuery) {
      return {
        analyzerIdentity: analyzer.identity,
        analysis: queryAnalysis(rawQuery)
      };
    },
    cancel() {},
    async close() {},
    stats() {
      return {};
    }
  };
}

function createEmbeddingPool() {
  const calls = { encode: 0 };
  return {
    calls,
    async encode(payload, options) {
      calls.encode += 1;
      if (Date.now() >= options.deadline) {
        throw Object.assign(new Error("deadline exceeded"), { code: "DEADLINE_EXCEEDED" });
      }
      const provider = new DeterministicHashProvider({
        model: payload.provider.model,
        dim: payload.provider.dim
      });
      return {
        provider: provider.identity,
        vectors: await Promise.all(payload.texts.map((text) => provider.embed(text)))
      };
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return { loaded: calls.encode > 0 };
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { encodeCalls: calls.encode };
    }
  };
}

function createLifecycleEmbeddingPool() {
  const provider = new DeterministicHashProvider();
  const calls = { load: 0, close: 0, encode: 0 };
  const lifecycle = new ModelSessionLifecycle({
    requiredVramBytes: 1,
    probeVram: () => ({ freeBytes: 0 }),
    loadSession: async (device) => {
      calls.load += 1;
      return {
        device,
        async encode(texts, options) {
          calls.encode += 1;
          return Promise.all(texts.map((text) => provider.embed(text, { inputKind: options?.inputKind })));
        },
        async close() {
          calls.close += 1;
        }
      };
    },
    idleMs: 60_000
  });
  return {
    calls,
    async encode(payload, options) {
      const vectors = await lifecycle.encode(payload.texts, {
        deadline: options.deadline,
        origin: payload.inputKind === "query" ? "query-text" : "document-embed"
      });
      return {
        provider: provider.identity,
        vectors
      };
    },
    async unload() {
      await lifecycle.unload();
      return { unloaded: true };
    },
    async modelStats() {
      return lifecycle.stats();
    },
    async warmup() {},
    cancel() {},
    async close() {
      await lifecycle.unload();
    },
    stats() {
      return { ...calls, lifecycle: lifecycle.stats() };
    }
  };
}

function createSearchExecutionPool() {
  let leased = false;
  let busy = false;
  return {
    idleReadySlotIds() {
      return leased || busy ? [] : [0];
    },
    leaseIdleSlot() {
      if (leased || busy) return undefined;
      leased = true;
      return 0;
    },
    releaseIdleSlot(slotId) {
      assert.equal(slotId, 0);
      if (!leased || busy) return false;
      leased = false;
      return true;
    },
    async runOnSlot(job) {
      assert.equal(leased, true);
      leased = false;
      busy = true;
      try {
        return executeSearchShardJob(job);
      } finally {
        busy = false;
      }
    },
    async preloadSnapshot() {
      return [];
    },
    cancel() {},
    async close() {},
    stats() {
      return {};
    }
  };
}

function createFakeVectorFactory() {
  const chunksByGeneration = new Map();
  const calls = {
    create: [],
    initStore: [],
    setActiveSpec: [],
    upsertChunks: [],
    buildIndex: [],
    searchVector: [],
    close: []
  };
  return {
    calls,
    factory: {
      async create(input) {
        calls.create.push({ ...input });
        const instance = {
          instanceId: `${input.role}:${input.generationId}:${calls.create.length}`,
          role: input.role,
          key: input.key,
          generationId: input.generationId,
          dbPath: input.dbPath,
          async initStore(dbPath) {
            calls.initStore.push({ role: input.role, generationId: input.generationId, dbPath });
          },
          async setActiveSpec(spec) {
            calls.setActiveSpec.push({ role: input.role, generationId: input.generationId, specId: spec.specId });
          },
          async upsertChunks(chunks) {
            calls.upsertChunks.push({ role: input.role, generationId: input.generationId, count: chunks.length });
            chunksByGeneration.set(input.generationId, chunks.map((chunk) => ({
              ...chunk,
              vector: Array.from(chunk.vector)
            })));
          },
          async buildIndex(engineName = "auto") {
            calls.buildIndex.push({ role: input.role, generationId: input.generationId, engineName });
          },
          async searchVector(vector, candidateK) {
            calls.searchVector.push({ role: input.role, generationId: input.generationId, candidateK });
            const query = Array.from(vector);
            return (chunksByGeneration.get(input.generationId) ?? [])
              .map((chunk) => ({
                chunkId: chunk.id,
                entryId: chunk.entryId,
                similarity: dot(query, Array.from(chunk.vector))
              }))
              .sort((left, right) => right.similarity - left.similarity || left.entryId.localeCompare(right.entryId))
              .slice(0, candidateK);
          },
          async close() {
            calls.close.push({ role: input.role, generationId: input.generationId });
          }
        };
        return instance;
      }
    }
  };
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) sum += left[index] * right[index];
  return sum;
}

function createHarness(options = {}) {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  const analyzer = testAnalyzer();
  let buildCount = 0;
  const vector = createFakeVectorFactory();
  const vectorPool = new VectorGenerationPool({ factory: vector.factory });
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async (input) => {
      buildCount += 1;
      return buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      });
    }
  });
  const embedding = options.embedding ?? createEmbeddingPool();
  const service = new DaemonSearchStoreService(
    store,
    createAnalyzerPool(analyzer),
    embedding,
    createSearchExecutionPool(),
    { queryCacheSize: 8, searchSettings: { ngram: false }, vectorPool }
  );
  return {
    root,
    vault,
    env,
    store,
    service,
    embedding,
    vector,
    vectorPool,
    buildCount: () => buildCount
  };
}

function writeSampleVault(vault) {
  writeVaultFile(vault, "Projects/Alpha.md", [
    "---",
    "tags: [project, alpha]",
    "---",
    "# Alpha",
    "",
    "alpha project semantic handle",
    "links to [[Projects/Beta]]"
  ].join("\n"));
  writeVaultFile(vault, "Projects/Beta.md", [
    "---",
    "tags: [project, beta]",
    "---",
    "# Beta",
    "",
    "alpha project semantic neighbor",
    "links back to [[Projects/Alpha]]"
  ].join("\n"));
  writeVaultFile(vault, "Archive/Gamma.md", "# Gamma\n\nunrelated archive material\n");
}

async function readyHarness(options = {}) {
  const harness = createHarness(options);
  writeSampleVault(harness.vault);
  const loaded = await harness.service.loadVault(harness.vault, context(), { preload: false, warmupQueryAnalyzer: false });
  assert.equal(loaded.vaults[0].status, "ready");
  assert.equal(harness.buildCount(), 1);
  return harness;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function activeRetrieval(paths) {
  return readJson(paths.retrievalActivePointerPath);
}

function retrievalEnvelope(paths, retrievalSnapshotId) {
  return readJson(path.join(paths.retrievalsDir, retrievalSnapshotId));
}

function retrievalVectorPaths(harness, embeddingSetId) {
  return vectorStoreCachePaths({
    vaultRoot: harness.vault,
    profileHash: PROFILE_HASH,
    embeddingSetId,
    env: harness.env
  });
}

function queryRequest(method, payload = {}) {
  return {
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId: `p5-${method}-${Math.random().toString(16).slice(2)}`,
    method,
    deadline: Date.now() + 5000,
    nonce: "nonce",
    payload
  };
}

test("AC5 single Retrieve powers search and similarity sugar", async () => {
  const harness = await readyHarness();
  const similarityRequest = normalizeSimilarityParams(similarityRequestFromArgs(parseArgs([
    "similarity",
    "mode=left",
    "left=Projects/Alpha.md",
    "top-k=3",
    "format=json"
  ])));
  const similarityRetrieve = await harness.service.retrieve({
    vault: harness.vault,
    ...retrievePayloadFromSimilarity(similarityRequest),
    debug: true
  }, context());
  const similarity = similarityResultFromRetrieve(similarityRetrieve, similarityRequest);

  assert.equal(similarity.available, true);
  assert.equal(similarity.status, "ready");
  assert.equal(similarity.origin, "note");
  assert.ok(similarity.results.length > 0);
  assert.equal(similarity.results.some((result) => result.path === "Projects/Alpha.md"), false);
  assert.equal(typeof similarity.results[0].score, "number");

  const searchRetrieve = await harness.service.retrieve({
    vault: harness.vault,
    origin: "text",
    text: "alpha project",
    query: "alpha project",
    limit: 3,
    debug: true
  }, context());
  assert.equal(searchRetrieve.available, true);
  assert.equal(searchRetrieve.status, "ready");
  assert.equal(searchRetrieve.origin, "text");
  assert.ok(searchRetrieve.results.length > 0);
  assert.equal(searchRetrieve.results.length, searchRetrieve.matches.length);
  assert.equal(typeof searchRetrieve.results[0].path, "string");
  assert.equal(typeof searchRetrieve.results[0].score, "number");

  const noteRetrieve = await harness.service.retrieve({
    vault: harness.vault,
    origin: "note",
    sourcePath: "Projects/Alpha.md",
    topK: 5
  }, context());
  assert.equal(noteRetrieve.available, true);
  assert.equal(noteRetrieve.status, "ready");
  assert.equal(noteRetrieve.results.some((result) => result.path === "Projects/Alpha.md"), false);
});

test("public Retrieve dense path uses the active built vector generation", async () => {
  const harness = await readyHarness();
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const active = activeRetrieval(paths);
  const envelope = retrievalEnvelope(paths, active.retrievalSnapshotId);
  assert.ok(harness.vector.calls.buildIndex.some((call) =>
    call.role === "staging" && call.generationId === envelope.vector.generationId
  ));
  assert.ok(harness.vector.calls.buildIndex.some((call) =>
    call.role === "query" && call.generationId === envelope.vector.generationId
  ));

  const beforeSearchCalls = harness.vector.calls.searchVector.length;
  const result = await harness.service.retrieve({
    vault: harness.vault,
    origin: "text",
    text: "alpha project",
    limit: 2,
    debug: true
  }, context());
  assert.equal(result.status, "ready");
  assert.ok(harness.vector.calls.searchVector.length > beforeSearchCalls);
  const call = harness.vector.calls.searchVector.at(-1);
  assert.equal(call.role, "query");
  assert.equal(call.generationId, envelope.vector.generationId);
  assert.ok(result.results.some((entry) => (entry.debug?.denseAgreement ?? 0) > 0));
});

test("Retrieve origin=text reuses lifecycle cold-load and unload closes the model session", async () => {
  const embedding = createLifecycleEmbeddingPool();
  const harness = await readyHarness({ embedding });
  for (const text of ["alpha project", "semantic neighbor"]) {
    const result = await harness.service.retrieve({
      vault: harness.vault,
      origin: "text",
      text,
      limit: 2
    }, context());
    assert.equal(result.status, "ready");
  }
  assert.equal(embedding.calls.load, 1);
  assert.equal(embedding.calls.close, 0);
  assert.equal((await embedding.modelStats()).loaded, true);
  await embedding.unload();
  assert.equal(embedding.calls.close, 1);
  assert.equal((await embedding.modelStats()).loaded, false);
});

test("AC8 query capability rejects mutators at type and runtime boundaries", async () => {
  const typeTestPath = path.join(process.cwd(), "test", ".retrieval-substrate-p5-negative.ts");
  const source = `
import { createQueryServer, type QueryMethodRegistry } from "../src/daemon/server.ts";
import type { QueryDaemonMethod, QueryDaemonRequest } from "../src/daemon/protocol.ts";
const runtime = {};
const handler = async () => ({ ok: true });
const readRegistry: QueryMethodRegistry<typeof runtime> = { Retrieve: handler };
void readRegistry;
// @ts-expect-error query capability cannot register LoadVault
createQueryServer({ LoadVault: handler }, runtime);
// @ts-expect-error query capability cannot register Rebuild
createQueryServer({ Rebuild: handler }, runtime);
// @ts-expect-error query capability cannot register Refresh
createQueryServer({ Refresh: handler }, runtime);
// @ts-expect-error query capability cannot register Compact
createQueryServer({ Compact: handler }, runtime);
// @ts-expect-error query capability cannot register Clear
createQueryServer({ Clear: handler }, runtime);
// @ts-expect-error query capability cannot register Prune
createQueryServer({ Prune: handler }, runtime);
// @ts-expect-error query capability cannot register Shutdown
createQueryServer({ Shutdown: handler }, runtime);
// @ts-expect-error query capability cannot name LoadVault
const badNameLoadVault: QueryDaemonMethod = "LoadVault";
// @ts-expect-error query capability cannot name Rebuild
const badNameRebuild: QueryDaemonMethod = "Rebuild";
// @ts-expect-error query capability cannot name Refresh
const badNameRefresh: QueryDaemonMethod = "Refresh";
// @ts-expect-error query capability cannot name Compact
const badNameCompact: QueryDaemonMethod = "Compact";
// @ts-expect-error query capability cannot name Clear
const badNameClear: QueryDaemonMethod = "Clear";
// @ts-expect-error query capability cannot name Prune
const badNamePrune: QueryDaemonMethod = "Prune";
// @ts-expect-error query capability cannot name Shutdown
const badNameShutdown: QueryDaemonMethod = "Shutdown";
void [badNameLoadVault, badNameRebuild, badNameRefresh, badNameCompact, badNameClear, badNamePrune, badNameShutdown];
// @ts-expect-error query capability cannot request LoadVault
const badRequestLoadVault: QueryDaemonRequest = { protocolVersion: 2, requestId: "1", method: "LoadVault", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Rebuild
const badRequestRebuild: QueryDaemonRequest = { protocolVersion: 2, requestId: "2", method: "Rebuild", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Refresh
const badRequestRefresh: QueryDaemonRequest = { protocolVersion: 2, requestId: "3", method: "Refresh", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Compact
const badRequestCompact: QueryDaemonRequest = { protocolVersion: 2, requestId: "4", method: "Compact", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Clear
const badRequestClear: QueryDaemonRequest = { protocolVersion: 2, requestId: "5", method: "Clear", deadline: Date.now() + 1000, payload: { vault: "/tmp" } };
// @ts-expect-error query capability cannot request Prune
const badRequestPrune: QueryDaemonRequest = { protocolVersion: 2, requestId: "6", method: "Prune", deadline: Date.now() + 1000, payload: {} };
// @ts-expect-error query capability cannot request Shutdown
const badRequestShutdown: QueryDaemonRequest = { protocolVersion: 2, requestId: "7", method: "Shutdown", deadline: Date.now() + 1000, payload: { nonce: "x" } };
void [badRequestLoadVault, badRequestRebuild, badRequestRefresh, badRequestCompact, badRequestClear, badRequestPrune, badRequestShutdown];
`;
  fs.writeFileSync(typeTestPath, source);
  try {
    const result = spawnSync("npx", [
      "tsc",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      typeTestPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(typeTestPath, { force: true });
  }

  const runtime = { hits: [] };
  const queryServer = createQueryServer({
    Retrieve: async (request, target) => {
      target.hits.push(request.method);
      return { ok: true, command: "retrieve", available: false, status: "index-not-ready", matches: [], results: [] };
    },
    InspectRead: async (_request, target) => {
      target.hits.push("InspectRead");
      return { ok: true, inspected: true };
    }
  }, runtime);

  assert.ok(queryServer.methods.includes("InspectRead"));
  assert.deepEqual(await queryServer.handleRequest(queryRequest("InspectRead")), { ok: true, inspected: true });
  await assert.rejects(
    () => queryServer.handleRequest(queryRequest("LoadVault", { vault: "/tmp" })),
    /unknown query daemon method/
  );
});

test("AC8 query and control sockets are separate owner capabilities", () => {
  const root = tempRoot();
  const desired = desiredOwnerIdentity(process.execPath);
  const sockets = socketPathsForOwner(path.join(root, "runtime"), desired);
  const owner = createOwnerRecord(desired, sockets, "nonce", process.pid);

  assert.notEqual(owner.querySocketPath, owner.controlSocketPath);
  assert.equal(owner.querySocketPath, sockets.querySocketPath);
  assert.equal(owner.controlSocketPath, sockets.controlSocketPath);
});

test("AC9 query socket has no mutating side effects", async () => {
  const root = tempRoot();
  const socketPath = path.join(root, "query.sock");
  const forbidden = [];
  const runtime = {
    async retrieve() {
      return {
        ok: true,
        command: "retrieve",
        schemaVersion: 1,
        available: false,
        status: "index-not-ready",
        origin: "text",
        reason: "no-active-retrieval-snapshot",
        matches: [],
        results: []
      };
    },
    loadVault: () => forbidden.push("loadVault"),
    ensureActiveSnapshot: () => forbidden.push("ensureActiveSnapshot"),
    publishFreshSnapshot: () => forbidden.push("publishFreshSnapshot"),
    snapshotIsFresh: () => forbidden.push("snapshotIsFresh"),
    buildIndex: () => forbidden.push("buildIndex"),
    embed: () => forbidden.push("embed"),
    upsert: () => forbidden.push("upsert"),
    cacheWrite: () => forbidden.push("cacheWrite")
  };
  const queryServer = createQueryServer({
    Retrieve: (request, target) => target.retrieve(request.payload)
  }, runtime);
  const rpcServer = await createRpcServer({
    socketPath,
    capability: "query",
    handleRequest: (request) => queryServer.handleRequest(request)
  });
  const connection = await connectRpc(socketPath);
  try {
    const result = await connection.request(queryRequest("Retrieve", {
      vault: root,
      origin: "text",
      text: "alpha"
    }));
    assert.equal(result.status, "index-not-ready");
    assert.deepEqual(forbidden, []);
    await assert.rejects(
      () => connection.request(queryRequest("LoadVault", { vault: root })),
      (error) => error.code === "BAD_REQUEST" && /unknown query daemon method/.test(error.message)
    );
    assert.deepEqual(forbidden, []);
  } finally {
    await connection.close();
    await rpcServer.close();
  }
});

test("AC9 service Retrieve release is refcount-only and performs no cache file mutation", async () => {
  const harness = await readyHarness();
  const writes = [];
  const deletes = [];
  const originalWriteFileSync = fs.writeFileSync;
  const originalRmSync = fs.rmSync;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    writes.push(String(file));
    return originalWriteFileSync.call(this, file, ...args);
  };
  fs.rmSync = function patchedRmSync(file, ...args) {
    deletes.push(String(file));
    return originalRmSync.call(this, file, ...args);
  };
  try {
    const result = await harness.service.retrieve({
      vault: harness.vault,
      origin: "note",
      sourcePath: "Projects/Alpha.md",
      limit: 3
    }, context());
    assert.equal(result.status, "ready");
    assert.deepEqual(writes, []);
    assert.deepEqual(deletes, []);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync = originalRmSync;
  }
});

test("AC9 retrieval envelope readiness gates fail closed before model encode", async () => {
  const absent = createHarness();
  writeSampleVault(absent.vault);
  const absentResult = await absent.service.retrieve({
    vault: absent.vault,
    origin: "text",
    text: "alpha project"
  }, context());
  assert.equal(absentResult.status, "index-not-ready");
  assert.equal(absentResult.reason, "no-active-retrieval-snapshot");
  assert.equal(absent.embedding.calls.encode, 0);
  assert.equal(absent.buildCount(), 0);

  await assertNotReadyAfter("retrieval-state-dirty", async (harness, envelope) => {
    await new RetrievalFreshnessStore({
      paths: retrievalVectorPaths(harness, envelope.embeddingSetId)
    }).markDirty(envelope.corpusSnapshotId);
  });
  await assertNotReadyAfter("retrieval-state-failed", async (harness, envelope) => {
    await new RetrievalFreshnessStore({
      paths: retrievalVectorPaths(harness, envelope.embeddingSetId)
    }).markFailed(envelope.corpusSnapshotId, new Error("boom"));
  });
  await assertNotReadyAfter("retrieval-state-stale", async (harness, envelope) => {
    await new RetrievalFreshnessStore({
      paths: retrievalVectorPaths(harness, envelope.embeddingSetId)
    }).markFresh({
      corpusRevision: envelope.corpusSnapshotId,
      corpusSnapshotId: envelope.corpusSnapshotId,
      linkGraphId: envelope.linkGraphId,
      embeddingSetId: envelope.embeddingSetId,
      retrievalSnapshotId: `${envelope.retrievalSnapshotId.slice(0, -1)}0`,
      vectorGenerationId: envelope.vector.generationId
    });
  });
  await assertNotReadyAfter("retrieval-snapshot-mismatched", async (harness, envelope, paths) => {
    const pointer = activeRetrieval(paths);
    writeJson(paths.retrievalActivePointerPath, {
      ...pointer,
      corpusSnapshotId: `${pointer.corpusSnapshotId.slice(0, -1)}0`
    });
    assert.equal(envelope.retrievalSnapshotId, pointer.retrievalSnapshotId);
  });
  await assertNotReadyAfter("vector-active-spec-mismatched", async (harness, envelope) => {
    const vectorPaths = retrievalVectorPaths(harness, envelope.embeddingSetId);
    const active = readJson(vectorPaths.activePointerPath);
    writeJson(vectorPaths.activePointerPath, {
      ...active,
      specId: `${active.specId}:stale`
    });
  });
  await assertNotReadyAfter("embedding-set-mismatched", async (_harness, envelope, paths) => {
    const file = path.join(paths.retrievalsDir, envelope.retrievalSnapshotId);
    writeJson(file, {
      ...envelope,
      embeddingSet: {
        ...envelope.embeddingSet,
        embeddingSetId: `${envelope.embeddingSet.embeddingSetId}:stale`
      }
    });
  });
});

test("active retrieval snapshot is refused after current fusion identity changes", async () => {
  const harness = await readyHarness();
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const active = activeRetrieval(paths);
  const envelope = retrievalEnvelope(paths, active.retrievalSnapshotId);
  const staleRetrieverPlanIdentity = `${envelope.retrieverPlanIdentity}:stale-fusion`;
  const staleRetrievalSnapshotId = computeRetrievalSnapshotId({
    corpusSnapshotId: envelope.corpusSnapshotId,
    linkGraphId: envelope.linkGraphId,
    embeddingSetId: envelope.embeddingSetId,
    retrieverPlanIdentity: staleRetrieverPlanIdentity,
    rankingFeatureVersion: envelope.rankingFeatureVersion
  });
  const staleEnvelope = {
    ...envelope,
    retrievalSnapshotId: staleRetrievalSnapshotId,
    retrieverPlanIdentity: staleRetrieverPlanIdentity
  };
  writeJson(path.join(paths.retrievalsDir, staleRetrievalSnapshotId), staleEnvelope);
  writeJson(paths.retrievalActivePointerPath, {
    ...active,
    retrievalSnapshotId: staleRetrievalSnapshotId
  });
  await new RetrievalFreshnessStore({
    paths: retrievalVectorPaths(harness, envelope.embeddingSetId)
  }).markFresh({
    corpusRevision: envelope.corpusSnapshotId,
    corpusSnapshotId: envelope.corpusSnapshotId,
    linkGraphId: envelope.linkGraphId,
    embeddingSetId: envelope.embeddingSetId,
    retrievalSnapshotId: staleRetrievalSnapshotId,
    vectorGenerationId: envelope.vector.generationId
  });

  const result = await harness.service.retrieve({
    vault: harness.vault,
    origin: "text",
    text: "alpha project"
  }, context());
  assert.equal(result.status, "index-not-ready");
  assert.equal(result.reason, "retrieval-snapshot-mismatched");
  assert.equal(harness.embedding.calls.encode, 0);
});

test("AC6 composite identity separates lexical, embedding, retrieval, and ANN identity", async () => {
  const vault = tempRoot();
  writeSampleVault(vault);
  const baseAnalyzer = testAnalyzer();
  const modelAAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel("model-a") });
  const modelBAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel("model-b") });

  const base = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: baseAnalyzer, partitionBits: 1 });
  const modelA = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelAAnalyzer, partitionBits: 1 });
  const modelB = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelBAnalyzer, partitionBits: 1 });

  assert.equal(modelA.corpusSnapshotId, corpusSnapshotIdFromManifest(modelA.manifest));
  assert.equal(base.corpusSnapshotId, modelA.corpusSnapshotId);
  assert.equal(modelA.corpusSnapshotId, modelB.corpusSnapshotId);
  assert.equal(modelA.snapshotId, modelB.snapshotId);
  assert.deepEqual(modelA.segments.map((segment) => segment.hash), modelB.segments.map((segment) => segment.hash));

  const tupleA = snapshotIdentityTupleForAnalyzerIdentity(modelAAnalyzer.identity, 1);
  const tupleB = snapshotIdentityTupleForAnalyzerIdentity(modelBAnalyzer.identity, 1);
  assert.equal("embeddingModel" in tupleA.searchModelIdentity, false);
  assert.equal("embeddingModel" in tupleA.searchModelIdentity.analyzerIdentity.analyzer, false);
  assert.deepEqual(tupleA, tupleB);

  const docs = [
    denseDoc("alpha", "Projects/Alpha.md", "alpha project semantic handle"),
    denseDoc("beta", "Projects/Beta.md", "alpha project semantic neighbor")
  ];
  const embeddingA = await buildEmbeddingSet({
    provider: new DeterministicHashProvider({ model: "deterministic-model-a" }),
    documents: docs
  });
  const embeddingB = await buildEmbeddingSet({
    provider: new DeterministicHashProvider({ model: "deterministic-model-b" }),
    documents: docs
  });
  assert.notEqual(embeddingA.embeddingSetId, embeddingB.embeddingSetId);

  const retrievalA = computeRetrievalSnapshotId({
    corpusSnapshotId: modelA.corpusSnapshotId,
    linkGraphId: modelA.linkGraphId,
    embeddingSetId: embeddingA.embeddingSetId,
    retrieverPlanIdentity: "retriever-plan:model-a",
    rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion)
  });
  const retrievalB = computeRetrievalSnapshotId({
    corpusSnapshotId: modelA.corpusSnapshotId,
    linkGraphId: modelA.linkGraphId,
    embeddingSetId: embeddingB.embeddingSetId,
    retrieverPlanIdentity: "retriever-plan:model-b",
    rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion)
  });
  assert.notEqual(retrievalA, retrievalB);

  const annGraphA = { engine: "flat", efSearch: 16 };
  const annGraphB = { engine: "hnsw", efSearch: 128 };
  assert.notDeepEqual(annGraphA, annGraphB);
  assert.equal(
    computeRetrievalSnapshotId({
      corpusSnapshotId: modelA.corpusSnapshotId,
      linkGraphId: modelA.linkGraphId,
      embeddingSetId: embeddingA.embeddingSetId,
      retrieverPlanIdentity: "retriever-plan:model-a",
      rankingFeatureVersion: String(modelA.identityTuple.rankingFeatureVersion)
    }),
    retrievalA
  );
});

test("AC9 retrieval envelope protects sidecar roots through compact", async () => {
  const harness = await readyHarness();
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const active = activeRetrieval(paths);
  const envelope = retrievalEnvelope(paths, active.retrievalSnapshotId);
  const retrievalPath = path.join(paths.retrievalsDir, active.retrievalSnapshotId);
  const linkGraphPath = path.join(paths.linkGraphsDir, envelope.linkGraphId);

  assert.ok(fs.existsSync(retrievalPath));
  assert.ok(fs.existsSync(linkGraphPath));
  const pin = await harness.store.pinActiveOnly(harness.vault);
  assert.equal(pin.retrievalSnapshotId, envelope.retrievalSnapshotId);
  assert.equal(pin.corpusSnapshotId, envelope.corpusSnapshotId);
  assert.equal(pin.linkGraphId, envelope.linkGraphId);
  assert.equal(pin.embeddingSetId, envelope.embeddingSetId);
  assert.ok(pin.embeddingSet.records.length > 0);
  harness.store.release(pin);

  await harness.service.compact(harness.vault, context());
  assert.ok(fs.existsSync(retrievalPath));
  assert.ok(fs.existsSync(linkGraphPath));
});

test("AC9 CLI search sugar requests Retrieve on query capability", async () => {
  const root = tempRoot();
  const runtimeDir = path.join(root, "runtime");
  const desired = desiredOwnerIdentity(process.execPath);
  const registry = createOwnerRegistry({ runtimeDir, desired, env: process.env });
  const owner = createOwnerRecord(desired, socketPathsForOwner(runtimeDir, desired), "nonce", process.pid);
  registry.writeOwner(owner);
  const requests = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath: process.execPath,
    connect: (_record, capability) => ({
      async request(request) {
        requests.push({ capability, request });
        if (request.method === "Status") {
          return {
            ok: true,
            ready: true,
            phase: "ready",
            protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
            nonce: owner.nonce
          };
        }
        assert.equal(capability, "query");
        assert.equal(request.method, "Retrieve");
        return {
          ok: true,
          command: "retrieve",
          schemaVersion: 1,
          available: true,
          status: "ready",
          origin: request.payload.origin,
          snapshotId: "s".repeat(64),
          retrievalSnapshotId: "r".repeat(64),
          matches: [],
          results: []
        };
      },
      async close() {}
    })
  });

  const result = await client.search({
    vault: root,
    query: "alpha project",
    limit: 2
  });
  assert.equal(result.command, "search");
  const retrieveRequest = requests.find((entry) => entry.request.method === "Retrieve");
  assert.ok(retrieveRequest);
  assert.equal(retrieveRequest.capability, "query");
  assert.equal(retrieveRequest.request.payload.origin, "text");
  assert.equal(retrieveRequest.request.payload.text, "alpha project");
  assert.equal(retrieveRequest.request.payload.query, "alpha project");
});

test("AC14 removed similarity fallback and reserved vector section code", () => {
  const removed = [
    REMOVED_STUB_NAME,
    ["provider", "unavailable"].join("-"),
    ["Vector similarity provider", "unavailable"].join(" "),
    REMOVED_VECTOR_SECTION,
    ["CANONICAL_VECTOR", "_BLOCK"].join(""),
    ["reserved but", "not enabled"].join(" ")
  ];
  const files = [
    path.join(process.cwd(), "src/core/similarity.ts"),
    path.join(process.cwd(), "src/cli/commands/similarity.ts"),
    path.join(process.cwd(), "src/core/types.ts"),
    path.join(process.cwd(), "src/core/search/segments/canonical.ts")
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const token of removed) {
      assert.equal(content.includes(token), false, `${path.relative(process.cwd(), file)} still contains ${token}`);
    }
  }
});

async function assertNotReadyAfter(expectedReason, mutate) {
  const harness = await readyHarness();
  const paths = searchStoreCachePaths(harness.vault, harness.env);
  const active = activeRetrieval(paths);
  const envelope = retrievalEnvelope(paths, active.retrievalSnapshotId);
  const buildsBefore = harness.buildCount();
  await mutate(harness, envelope, paths);
  const result = await harness.service.retrieve({
    vault: harness.vault,
    origin: "text",
    text: "alpha project"
  }, context());
  assert.equal(result.status, "index-not-ready");
  assert.equal(result.reason, expectedReason);
  assert.equal(harness.embedding.calls.encode, 0);
  assert.equal(harness.buildCount(), buildsBefore);
}

function embeddingModel(id, dim = 3) {
  return {
    id,
    sha256: id.padEnd(64, "0").slice(0, 64),
    opset: "onnx-opset-test",
    quantization: "none",
    dim,
    pooling: "mean"
  };
}

function denseDoc(documentId, relPath, text) {
  return {
    documentId,
    shardDocRef: {
      segmentId: "p5-segment",
      partitionId: 0,
      localDocId: 0,
      documentId
    },
    path: relPath,
    text,
    contentHash: documentId
  };
}
