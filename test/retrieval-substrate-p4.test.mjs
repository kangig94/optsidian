import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ModelSessionLifecycle } from "../src/daemon/model-session/index.ts";
import { createMemoryCoralNeedleInstanceFactory } from "./helpers/memory-coral-needle.mjs";
import {
  RetrievalFreshnessStore,
  VectorGenerationPool,
  recoverRetrievalStaging,
  vectorStoreCachePaths
} from "../src/daemon/vector-store/index.ts";

function tempRoot(prefix = "optsidian-retrieval-p4-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKey(overrides = {}) {
  return {
    profileHash: overrides.profileHash ?? "profile-a",
    vaultStateHash: overrides.vaultStateHash ?? "vault-a",
    embeddingSetId: overrides.embeddingSetId ?? "embedding-a"
  };
}

function makeSpec(specId = "deterministic-spec", dims = 3) {
  return {
    specId,
    provider: "deterministic-hash",
    model: "content-hash-v1",
    dims,
    normalization: "l2",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeChunk(id, vector, spec = makeSpec()) {
  return {
    id: `${id}:0`,
    entryId: id,
    entryKind: "note",
    chunkIndex: 0,
    text: `text ${id}`,
    contentHash: `hash-${id}`,
    vector,
    specId: spec.specId
  };
}

function queryVector(vector) {
  return vector;
}

function createFakeCoralFactory(options = {}) {
  const chunksByGeneration = new Map();
  const instances = [];
  const events = [];
  const searchWaiters = new Map();
  const buildWaiters = new Map();
  const calls = {
    create: [],
    init: [],
    buildIndex: [],
    searchVector: [],
    close: [],
    upsert: []
  };
  const factory = {
    async create(input) {
      calls.create.push({ ...input });
      const instance = {
        instanceId: `${input.role}:${input.key.vaultStateHash}:${input.generationId}:${calls.create.length}`,
        role: input.role,
        key: input.key,
        generationId: input.generationId,
        dbPath: input.dbPath,
        closed: false,
        async initStore(dbPath) {
          calls.init.push({ generationId: input.generationId, role: input.role, dbPath });
          events.push(["init", input.role, input.generationId]);
        },
        async setActiveSpec(spec) {
          instance.spec = spec;
        },
        async upsertChunks(chunks) {
          calls.upsert.push({ generationId: input.generationId, role: input.role, chunks: chunks.map((chunk) => chunk.entryId) });
          chunksByGeneration.set(input.generationId, chunks.map((chunk) => ({ ...chunk, vector: Array.from(chunk.vector) })));
        },
        async buildIndex(engineName = "auto") {
          calls.buildIndex.push({ generationId: input.generationId, role: input.role, engineName });
          events.push(["build", input.role, input.generationId]);
          const waiter = buildWaiters.get(input.generationId);
          if (waiter) await waiter.promise;
        },
        async searchVector(vector, candidateK) {
          calls.searchVector.push({ generationId: input.generationId, role: input.role, candidateK });
          events.push(["search-start", input.role, input.generationId]);
          const waiter = searchWaiters.get(input.generationId);
          if (waiter) await waiter.promise;
          if (instance.closed) throw new Error(`use-after-close ${input.generationId}`);
          const chunks = chunksByGeneration.get(input.generationId) ?? [];
          const results = chunks
            .map((chunk) => ({
              chunkId: chunk.id,
              entryId: chunk.entryId,
              similarity: dot(Array.from(vector), Array.from(chunk.vector))
            }))
            .sort((left, right) => right.similarity - left.similarity)
            .slice(0, candidateK);
          events.push(["search-end", input.role, input.generationId]);
          return results;
        },
        async close() {
          instance.closed = true;
          calls.close.push({ generationId: input.generationId, role: input.role });
          events.push(["close", input.role, input.generationId]);
        },
        async getStats() {
          return {
            chunkCount: (chunksByGeneration.get(input.generationId) ?? []).length,
            specId: instance.spec?.specId ?? null,
            engineName: "fake-exact",
            schemaVersion: 1
          };
        }
      };
      instances.push(instance);
      options.onCreate?.(instance);
      return instance;
    }
  };
  return {
    factory,
    calls,
    events,
    instances,
    chunksByGeneration,
    holdBuild(generationId) {
      const waiter = deferred();
      buildWaiters.set(generationId, waiter);
      return waiter;
    },
    holdSearch(generationId) {
      const waiter = deferred();
      searchWaiters.set(generationId, waiter);
      return waiter;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) sum += left[index] * right[index];
  return sum;
}

async function publishGeneration(pool, paths, spec, generationId, chunks) {
  const built = await pool.buildStagingGeneration({
    paths,
    spec,
    chunks,
    generationId
  });
  await pool.promoteBuiltGeneration(paths, built.metadata);
  return built;
}

function makeVectorPaths(vault, key = makeKey()) {
  return vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash: key.profileHash,
    embeddingSetId: key.embeddingSetId,
    env: { ...process.env, XDG_CACHE_HOME: tempRoot("optsidian-retrieval-p4-cache-") }
  });
}

test("AC7 Test A P4 active built vector spec serves search while staging buildIndex is held", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "A.md"), "alpha\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  await publishGeneration(pool, paths, spec, "gen-active", [makeChunk("active", [1, 0, 0], spec)]);

  const heldBuild = fake.holdBuild("gen-staging");
  const staging = pool.buildStagingGeneration({
    paths,
    spec,
    chunks: [makeChunk("staging", [0, 1, 0], spec)],
    generationId: "gen-staging"
  });

  while (!fake.events.some((event) => event[0] === "build" && event[2] === "gen-staging")) {
    await delay(1);
  }
  const result = await pool.searchActiveBuiltIndex({
    key: paths.key,
    queryVector: queryVector([1, 0, 0]),
    candidateK: 1
  });
  assert.equal(result.status, "ready");
  assert.equal(result.generationId, "gen-active");
  assert.deepEqual(result.results.map((entry) => entry.entryId), ["active"]);
  heldBuild.resolve();
  await staging;
  await pool.close();
});

test("AC7 Test B P4 no active built vector spec returns index-not-ready without query-side build", async () => {
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const result = await pool.searchActiveBuiltIndex({
    key: makeKey(),
    queryVector: [1, 0, 0],
    candidateK: 1
  });
  assert.deepEqual(result, { status: "index-not-ready", reason: "no-active-built-spec" });
  assert.equal(fake.calls.searchVector.length, 0);
  assert.equal(fake.calls.buildIndex.length, 0);
  await pool.close();
});

test("P4 test-only memory coral double is injected through VectorGenerationPool", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "Memory.md"), "memory vector\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const pool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  await publishGeneration(pool, paths, spec, "gen-memory", [
    makeChunk("near", [1, 0, 0], spec),
    makeChunk("far", [0, 1, 0], spec)
  ]);
  const result = await pool.searchActiveBuiltIndex({
    key: paths.key,
    queryVector: [1, 0, 0],
    candidateK: 2
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.results.map((entry) => entry.entryId), ["near", "far"]);
  await pool.close();
});

test("AC1 post-restart pinReadableGeneration lazy-opens committed on-disk active generation", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "Restart.md"), "restart vector\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const firstPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  await publishGeneration(firstPool, paths, spec, "gen-restart", [
    makeChunk("near", [1, 0, 0], spec),
    makeChunk("far", [0, 1, 0], spec)
  ]);
  await firstPool.close();

  const restartedPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  assert.deepEqual(restartedPool.statsForTests().active, {});
  const result = await restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: "gen-restart",
    expectedSpec: spec
  });
  assert.equal(result.status, "ready");
  const hits = await result.lease.searchVector([1, 0, 0], 2);
  assert.deepEqual(hits.map((entry) => entry.entryId), ["near", "far"]);
  const key = `${paths.key.profileHash}:${paths.key.vaultStateHash}:${paths.key.embeddingSetId}:gen-restart`;
  assert.equal(restartedPool.statsForTests().refCounts[key], 1);
  result.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 0);
  await restartedPool.close();
});

test("AC1 concurrent post-restart pinReadableGeneration lazy-open is single-flighted", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "Concurrent.md"), "concurrent vector\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const firstPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  await publishGeneration(firstPool, paths, spec, "gen-concurrent", [
    makeChunk("near", [1, 0, 0], spec)
  ]);
  await firstPool.close();

  const base = createMemoryCoralNeedleInstanceFactory();
  const gate = deferred();
  let queryCreates = 0;
  const restartedPool = new VectorGenerationPool({
    factory: {
      async create(input) {
        if (input.role === "query") {
          queryCreates += 1;
          await gate.promise;
        }
        return base.create(input);
      }
    }
  });
  const first = restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: "gen-concurrent",
    expectedSpec: spec
  });
  const second = restartedPool.pinReadableGeneration({
    paths,
    expectedGenerationId: "gen-concurrent",
    expectedSpec: spec
  });
  await delay(10);
  assert.equal(queryCreates, 1);
  assert.deepEqual(restartedPool.statsForTests().active, {});
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "ready");
  assert.equal(secondResult.status, "ready");
  assert.equal(queryCreates, 1);
  const key = `${paths.key.profileHash}:${paths.key.vaultStateHash}:${paths.key.embeddingSetId}:gen-concurrent`;
  assert.equal(restartedPool.statsForTests().refCounts[key], 2);
  firstResult.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 1);
  secondResult.lease.release();
  assert.equal(restartedPool.statsForTests().refCounts[key], 0);
  await restartedPool.close();
});

test("AC7 Test C P4 multi-vault queries use distinct active query instances without eviction or re-init", async () => {
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const vaultA = tempRoot();
  const vaultB = tempRoot();
  fs.writeFileSync(path.join(vaultA, "A.md"), "a\n");
  fs.writeFileSync(path.join(vaultB, "B.md"), "b\n");
  const pathsA = makeVectorPaths(vaultA, makeKey({ vaultStateHash: "vault-a", embeddingSetId: "embedding-a" }));
  const pathsB = makeVectorPaths(vaultB, makeKey({ vaultStateHash: "vault-b", embeddingSetId: "embedding-b" }));

  await publishGeneration(pool, pathsA, spec, "gen-a", [makeChunk("A", [1, 0, 0], spec)]);
  await publishGeneration(pool, pathsB, spec, "gen-b", [makeChunk("B", [0, 1, 0], spec)]);

  const [resultA, resultB] = await Promise.all([
    pool.searchActiveBuiltIndex({ key: pathsA.key, queryVector: [1, 0, 0], candidateK: 1 }),
    pool.searchActiveBuiltIndex({ key: pathsB.key, queryVector: [0, 1, 0], candidateK: 1 })
  ]);
  assert.equal(resultA.status, "ready");
  assert.equal(resultB.status, "ready");
  assert.deepEqual(resultA.results.map((entry) => entry.entryId), ["A"]);
  assert.deepEqual(resultB.results.map((entry) => entry.entryId), ["B"]);
  assert.equal(fake.calls.init.filter((call) => call.generationId === "gen-a" && call.role === "query").length, 1);
  assert.equal(fake.calls.init.filter((call) => call.generationId === "gen-b" && call.role === "query").length, 1);
  assert.equal(fake.calls.close.filter((call) => call.generationId === "gen-a" && call.role === "query").length, 0);
  assert.equal(fake.calls.close.filter((call) => call.generationId === "gen-b" && call.role === "query").length, 0);
  await pool.close();
});

test("AC7 Test D P4 generation swap drains in-flight readers before closing old query process", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "A.md"), "alpha\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  await publishGeneration(pool, paths, spec, "gen-n", [makeChunk("old", [1, 0, 0], spec)]);

  const heldSearch = fake.holdSearch("gen-n");
  const inFlight = pool.searchActiveBuiltIndex({
    key: paths.key,
    queryVector: [1, 0, 0],
    candidateK: 1
  });
  while (!fake.events.some((event) => event[0] === "search-start" && event[2] === "gen-n")) {
    await delay(1);
  }

  const next = await pool.buildStagingGeneration({
    paths,
    spec,
    chunks: [makeChunk("new", [0, 1, 0], spec)],
    generationId: "gen-n1"
  });
  await pool.promoteBuiltGeneration(paths, next.metadata);
  assert.equal(fake.calls.close.some((call) => call.generationId === "gen-n" && call.role === "query"), false);

  heldSearch.resolve();
  const result = await inFlight;
  assert.equal(result.status, "ready");
  assert.equal(result.generationId, "gen-n");
  assert.deepEqual(result.results.map((entry) => entry.entryId), ["old"]);

  await waitFor(() => fake.calls.close.some((call) => call.generationId === "gen-n" && call.role === "query"));
  assert.equal(pool.statsForTests().refCounts[`${paths.key.profileHash}:${paths.key.vaultStateHash}:${paths.key.embeddingSetId}:gen-n`], undefined);
  await pool.close();
});

test("AC10 P4 model session lifecycle handles device pick idle unload promotion OOM single-flight deadline and abort", async () => {
  const required = 100;

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 150 }),
      loadSession: async (device) => {
        calls.push(device);
        return fakeSession(device);
      },
      idleMs: 1000
    });
    await lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "query-text" });
    assert.deepEqual(calls, ["gpu"]);
    await lifecycle.unload();
  }

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 149 }),
      loadSession: async (device) => {
        calls.push(device);
        return fakeSession(device);
      },
      idleMs: 1000
    });
    await lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "document-embed" });
    assert.deepEqual(calls, ["cpu"]);
    await lifecycle.unload();
  }

  {
    const sessions = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        const session = fakeSession(device);
        sessions.push(session);
        return session;
      },
      idleMs: 10
    });
    await lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "query-text" });
    assert.equal(lifecycle.stats().loaded, true);
    await delay(30);
    assert.equal(lifecycle.stats().loaded, false);
    assert.equal(sessions[0].closed, true);
  }

  {
    const calls = [];
    const sessions = [];
    const probes = [{ freeBytes: 0 }, { freeBytes: 200 }];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => probes.shift() ?? { freeBytes: 200 },
      loadSession: async (device) => {
        calls.push(device);
        const session = fakeSession(device);
        sessions.push(session);
        return session;
      },
      idleMs: 1000
    });
    await lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "document-embed" });
    assert.deepEqual(calls, ["cpu", "gpu"]);
    assert.equal(sessions[0].closed, true);
    assert.equal(lifecycle.stats().device, "gpu");
    await lifecycle.unload();
  }

  {
    const calls = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async (device) => {
        calls.push(device);
        if (device === "gpu") throw new Error("CUDA out of memory");
        return fakeSession(device);
      },
      idleMs: 1000
    });
    await lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "query-text" });
    assert.deepEqual(calls, ["gpu", "cpu"]);
    assert.equal(lifecycle.stats().device, "cpu");
    await lifecycle.unload();
  }

  {
    let loadCalls = 0;
    const gate = deferred();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        loadCalls += 1;
        await gate.promise;
        return fakeSession(device);
      },
      idleMs: 1000
    });
    const requests = Array.from({ length: 8 }, () =>
      lifecycle.encode(["q"], { deadline: Date.now() + 1000, origin: "query-text" })
    );
    await delay(5);
    assert.equal(loadCalls, 1);
    gate.resolve();
    await Promise.all(requests);
    assert.equal(loadCalls, 1);
    await lifecycle.unload();
  }

  {
    const terminated = [];
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async () => new Promise(() => {}),
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000
    });
    await assert.rejects(
      lifecycle.encode(["q"], { deadline: Date.now() + 20, origin: "query-text" }),
      /deadline exceeded/
    );
    assert.deepEqual(terminated, [["gpu", "deadline"]]);
    assert.equal(lifecycle.stats().loaded, false);
  }

  {
    const terminated = [];
    const controller = new AbortController();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 200 }),
      loadSession: async () => new Promise(() => {}),
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000
    });
    const request = lifecycle.encode(["q"], {
      deadline: Date.now() + 1000,
      origin: "document-embed",
      signal: controller.signal
    });
    await delay(5);
    controller.abort();
    await assert.rejects(request, /aborted/);
    assert.deepEqual(terminated, [["gpu", "abort"]]);
    assert.deepEqual(lifecycle.stats(), { loaded: false });
  }

  {
    let loadCalls = 0;
    const terminated = [];
    const gate = deferred();
    const secondary = new AbortController();
    const lifecycle = new ModelSessionLifecycle({
      requiredVramBytes: required,
      probeVram: () => ({ freeBytes: 0 }),
      loadSession: async (device) => {
        loadCalls += 1;
        await gate.promise;
        return fakeSession(device);
      },
      terminateLoad: (device, reason) => terminated.push([device, reason]),
      idleMs: 1000
    });
    const primaryRequest = lifecycle.encode(["primary"], { deadline: Date.now() + 1000, origin: "query-text" });
    const secondaryRequest = lifecycle.encode(["secondary"], {
      deadline: Date.now() + 1000,
      origin: "query-text",
      signal: secondary.signal
    });
    await delay(5);
    secondary.abort();
    await assert.rejects(secondaryRequest, /aborted/);
    assert.equal(loadCalls, 1);
    assert.deepEqual(terminated, []);
    gate.resolve();
    await primaryRequest;
    assert.equal(lifecycle.stats().loaded, true);
    await lifecycle.unload();
  }
});

test("AC11 P4 freshness persists dirty/building/fresh states across startup recovery", async () => {
  const vault = tempRoot();
  fs.writeFileSync(path.join(vault, "A.md"), "alpha\n");
  fs.writeFileSync(path.join(vault, "B.md"), "beta\n");
  const paths = makeVectorPaths(vault);
  const spec = makeSpec();
  const fake = createFakeCoralFactory();
  const pool = new VectorGenerationPool({ factory: fake.factory });
  const freshness = new RetrievalFreshnessStore({ paths });
  const initialChunks = [
    makeChunk("doc-a", [1, 0, 0], spec),
    makeChunk("doc-b", [0, 1, 0], spec)
  ];
  await publishGeneration(pool, paths, spec, "gen-initial", initialChunks);
  await freshness.markFresh({
    corpusRevision: "rev-1",
    embeddingSetId: paths.key.embeddingSetId,
    vectorGenerationId: "gen-initial"
  });

  await freshness.markDirty("rev-2");
  assert.equal(freshness.read().state, "dirty");
  assert.equal(freshness.isPubliclyServable("rev-2"), false);
  await freshness.markBuilding("rev-2");
  assert.equal(freshness.read().state, "building");
  await freshness.markFresh({
    corpusRevision: "rev-2",
    embeddingSetId: paths.key.embeddingSetId,
    vectorGenerationId: "gen-initial"
  });
  assert.equal(freshness.read().state, "fresh");
  assert.equal(freshness.read().corpusRevision, "rev-2");
  assert.equal(freshness.isPubliclyServable("rev-2"), true);

  await freshness.markDirty("rev-4");
  const restartedDirty = new RetrievalFreshnessStore({ paths });
  assert.equal(restartedDirty.isPubliclyServable("rev-4"), false);
  await restartedDirty.markBuilding("rev-5");
  const restartedBuilding = new RetrievalFreshnessStore({ paths });
  assert.equal(restartedBuilding.isPubliclyServable("rev-5"), false);

  await restartedBuilding.write({
    schemaVersion: 1,
    state: "dirty",
    corpusRevision: "rev-2",
    published: {
      corpusRevision: "rev-2",
      embeddingSetId: paths.key.embeddingSetId,
      vectorGenerationId: "gen-save"
    },
    updatedAt: new Date().toISOString()
  });
  await restartedBuilding.startupReconcile({ onDiskCorpusRevision: "rev-2" });
  assert.equal(restartedBuilding.read().state, "fresh");
  assert.equal(restartedBuilding.isPubliclyServable("rev-2"), true);

  await restartedBuilding.markBuilding("rev-6");
  fs.mkdirSync(paths.stagingDir, { recursive: true });
  fs.writeFileSync(path.join(paths.stagingDir, "orphan"), "x");
  const lexicalTmp = path.join(tempRoot(), "lexical-tmp");
  const linkTmp = path.join(tempRoot(), "link-tmp");
  fs.mkdirSync(lexicalTmp, { recursive: true });
  fs.mkdirSync(linkTmp, { recursive: true });
  fs.writeFileSync(path.join(lexicalTmp, "orphan"), "x");
  fs.writeFileSync(path.join(linkTmp, "orphan"), "x");
  await recoverRetrievalStaging({
    vectorPaths: paths,
    lexicalTmpDir: lexicalTmp,
    linkGraphTmpDir: linkTmp,
    freshness: restartedBuilding
  });
  assert.equal(restartedBuilding.read().state, "dirty");
  assert.deepEqual(fs.readdirSync(paths.stagingDir), []);
  assert.deepEqual(fs.readdirSync(lexicalTmp), []);
  assert.deepEqual(fs.readdirSync(linkTmp), []);
  assert.equal(restartedBuilding.read().published.corpusRevision, "rev-2");
  await pool.close();
});

function fakeSession(device) {
  return {
    device,
    closed: false,
    async encode(texts) {
      return texts.map((text) => [text.length, device === "gpu" ? 1 : 0, 0]);
    },
    async close() {
      this.closed = true;
    }
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.equal(predicate(), true);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
