import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSearchShardJob } from "../src/daemon/search-execution.ts";
import { EmbedScheduler } from "../src/daemon/embed-scheduler.ts";
import { ProfileManager } from "../src/daemon/profile-manager.ts";
import { buildCanonicalSearchSnapshot } from "../src/daemon/search-store/builder.ts";
import { searchStoreCachePaths } from "../src/daemon/search-store/cache-paths.ts";
import { durableRename } from "../src/daemon/search-store/publication.ts";
import {
  DaemonSnapshotStore,
  createWorkerEmbeddingSetBuilder
} from "../src/daemon/search-store/snapshot-store.ts";
import { DaemonSearchStoreService } from "../src/daemon/search-store/service.ts";
import { VectorGenerationPool } from "../src/daemon/vector-store/index.ts";
import {
  VaultChangeProducer,
  docIdForVaultPath
} from "../src/daemon/vector-store/watcher.ts";
import { createMemoryCoralNeedleInstanceFactory } from "./helpers/memory-coral-needle.mjs";
import {
  activeRetrievalFromEdition,
  activeSnapshotFromEdition
} from "./helpers/edition-ledger.mjs";

const PROFILE_HASH = "embedding-lifecycle-ac11";
const MARKER = "newneedle-ac11";

function tempRoot(prefix = "optsidian-embedding-lifecycle-ac11-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function context(id = "ac11", ms = 5000) {
  return {
    deadline: Date.now() + ms,
    cancellationId: `${id}-${Math.random().toString(16).slice(2)}`,
    requestId: `${id}-${Math.random().toString(16).slice(2)}`
  };
}

function testAnalyzer(identity = { name: "test-analyzer", version: "embedding-lifecycle-ac11", node: "test" }) {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity,
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function createAnalyzerPool(analyzer) {
  return {
    analyzerIdentity: analyzer.identity,
    async warmup() {},
    async analyzeQuery(rawQuery) {
      const terms = await analyzer.tokenize(rawQuery);
      return {
        analyzerIdentity: analyzer.identity,
        analysis: {
          raw: rawQuery,
          primaryChannel: "morph",
          primaryTerms: terms,
          channels: {
            morph: terms,
            surface: terms,
            ngram: []
          }
        }
      };
    },
    cancel() {},
    async close() {},
    stats() {
      return {};
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

function createMarkerEmbeddingPool(provider) {
  const calls = [];
  return {
    calls,
    async encode(payload) {
      calls.push({
        inputKind: payload.inputKind ?? "document",
        texts: [...payload.texts]
      });
      return {
        provider: provider.identity,
        vectors: payload.texts.map((text) => markerVector(text))
      };
    },
    async unload() {
      return { unloaded: true };
    },
    async modelStats() {
      return { loaded: calls.length > 0 };
    },
    async warmup() {},
    cancel() {},
    async close() {},
    stats() {
      return { encodeCalls: calls.length };
    }
  };
}

function markerVector(text) {
  return text.includes(MARKER) ? [1, 0] : [0, 1];
}

function fakeWatchFactory() {
  const listeners = new Map();
  return {
    listeners,
    watchDirectory(dir, listener) {
      listeners.set(dir, listener);
      return {
        close() {},
        unref() {}
      };
    }
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function activeSnapshot(paths) {
  const active = activeSnapshotFromEdition(paths);
  return {
    active,
    envelope: readJson(path.join(paths.snapshotsDir, active.snapshotId))
  };
}

function activeRetrieval(paths) {
  const active = activeRetrievalFromEdition(paths);
  return {
    active,
    envelope: readJson(path.join(paths.retrievalsDir, active.retrievalSnapshotId))
  };
}

function manifestSegments(envelope) {
  return new Map(envelope.manifest.partitions.map((partition) => [partition.partitionId, partition.segmentHash]));
}

function resultPath(result, relPath) {
  return result.results.find((entry) => entry.path === relPath);
}

function denseAgreementForPath(result, relPath) {
  return resultPath(result, relPath)?.debug?.denseAgreement ?? 0;
}

function writePartitionedVault(vault) {
  for (let index = 0; index < 12; index += 1) {
    const name = `Note-${String(index).padStart(2, "0")}.md`;
    writeVaultFile(vault, name, `# Note ${index}\n\nstable baseline body ${index}\n`);
  }
}

function pickChangedDocument(envelope) {
  const partitionCounts = new Map();
  for (const document of envelope.documents) {
    partitionCounts.set(document.partitionId, (partitionCounts.get(document.partitionId) ?? 0) + 1);
  }
  const candidate = envelope.documents.find((document) =>
    partitionCounts.size > 1 && (partitionCounts.get(document.partitionId) ?? 0) < envelope.documents.length
  );
  assert.ok(candidate, "expected at least one document outside an unchanged partition");
  return candidate;
}

async function createHarness() {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  const analyzer = testAnalyzer();
  const provider = {
    identity: {
      id: "deterministic-hash",
      model: "ac11-marker-model",
      dim: 2,
      version: "1"
    }
  };
  const embedding = createMarkerEmbeddingPool(provider);
  const scheduler = new EmbedScheduler({ embedding, ownsEmbedding: false });
  const vectorPool = new VectorGenerationPool({
    factory: createMemoryCoralNeedleInstanceFactory()
  });
  const segmentRenames = [];
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 2,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: createWorkerEmbeddingSetBuilder({
      provider,
      providerPayload: {
        kind: "deterministic-hash",
        model: provider.identity.model,
        dim: provider.identity.dim
      },
      embedding: scheduler
    }),
    snapshotBuilder: async (input) => buildCanonicalSearchSnapshot({
      vaultRoot: input.vaultRoot,
      analyzer,
      partitionBits: input.partitionBits,
      searchSettings: input.searchSettings,
      progress: input.progress
    }),
    durableRenameSegment: async (tmp, target) => {
      segmentRenames.push(path.basename(target));
      await durableRename(tmp, target);
    }
  });
  const service = new DaemonSearchStoreService(
    store,
    createAnalyzerPool(analyzer),
    scheduler,
    createSearchExecutionPool(),
    { queryCacheSize: 8, searchSettings: { ngram: false }, vectorPool }
  );
  return {
    root,
    vault,
    env,
    store,
    service,
    scheduler,
    vectorPool,
    segmentRenames,
    async close() {
      await scheduler.close();
      await vectorPool.close();
    }
  };
}

test("AC11 watcher save debounce publishes a coherent lexical revision and dense generation without Refresh/Rebuild", async () => {
  const harness = await createHarness();
  writePartitionedVault(harness.vault);
  const fakeWatch = fakeWatchFactory();
  const dirtyBatches = [];
  const scheduledSaveJobs = [];
  const producer = new VaultChangeProducer({
    vaultRoot: harness.vault,
    debounceMs: 20,
    watchDirectory: fakeWatch.watchDirectory,
    onDirtyMarks(marks) {
      dirtyBatches.push([...marks]);
      const runContext = context("ac11-save", 5000);
      const job = harness.scheduler.run("save", () => harness.service.publishSaveSnapshot(harness.vault, runContext), {
        deadline: runContext.deadline,
        cancellationId: runContext.cancellationId,
        requestId: runContext.requestId,
        vault: harness.vault
      });
      scheduledSaveJobs.push(job);
      void job.catch(() => undefined);
    }
  });

  try {
    const loaded = await harness.service.loadVault(harness.vault, context("ac11-load"), {
      preload: false,
      warmupQueryAnalyzer: false
    });
    assert.equal(loaded.vaults[0].status, "ready");
    const paths = searchStoreCachePaths(harness.vault, harness.env);
    const initialSnapshot = activeSnapshot(paths);
    const initialRetrieval = activeRetrieval(paths);
    const changedDocument = pickChangedDocument(initialSnapshot.envelope);
    const newDocumentPath = "Saved-New.md";
    const initialSegments = manifestSegments(initialSnapshot.envelope);
    const initialSegmentBytes = new Map([...initialSegments.values()].map((hash) => [
      hash,
      fs.readFileSync(path.join(paths.segmentsDir, hash))
    ]));
    harness.segmentRenames.length = 0;

    writeVaultFile(harness.vault, changedDocument.path, `# Saved\n\n${MARKER} changed save content\n`);
    writeVaultFile(harness.vault, newDocumentPath, `# Saved New\n\n${MARKER} new save content\n`);
    const rootListener = fakeWatch.listeners.get(fs.realpathSync(harness.vault));
    assert.equal(typeof rootListener, "function");
    rootListener("change", changedDocument.path);
    rootListener("rename", newDocumentPath);

    await waitFor(() => dirtyBatches.length === 1);
    const changedBytes = fs.readFileSync(path.join(harness.vault, changedDocument.path));
    const newBytes = fs.readFileSync(path.join(harness.vault, newDocumentPath));
    assert.equal(dirtyBatches[0].length, 2);
    assert.deepEqual(
      new Map(dirtyBatches[0].map((mark) => [mark.path, mark])),
      new Map([
        [changedDocument.path, {
          docId: docIdForVaultPath(changedDocument.path),
          path: changedDocument.path,
          contentHash: sha256(changedBytes)
        }],
        [newDocumentPath, {
          docId: docIdForVaultPath(newDocumentPath),
          path: newDocumentPath,
          contentHash: sha256(newBytes)
        }]
      ])
    );
    await Promise.all(scheduledSaveJobs);

    const finalSnapshot = activeSnapshot(paths);
    const finalRetrieval = activeRetrieval(paths);
    assert.notEqual(finalSnapshot.active.snapshotId, initialSnapshot.active.snapshotId);
    assert.notEqual(finalSnapshot.envelope.corpusSnapshotId, initialSnapshot.envelope.corpusSnapshotId);
    assert.notEqual(finalRetrieval.active.retrievalSnapshotId, initialRetrieval.active.retrievalSnapshotId);
    assert.equal(finalRetrieval.envelope.snapshotId, finalSnapshot.active.snapshotId);
    assert.equal(finalRetrieval.envelope.corpusSnapshotId, finalSnapshot.envelope.corpusSnapshotId);
    assert.equal(finalRetrieval.envelope.freshness.corpusRevision, finalSnapshot.envelope.corpusSnapshotId);
    const newDocument = finalSnapshot.envelope.documents.find((document) => document.path === newDocumentPath);
    assert.ok(newDocument);

    const finalSegments = manifestSegments(finalSnapshot.envelope);
    const affectedPartitions = new Set([changedDocument.partitionId, newDocument.partitionId]);
    assert.notEqual(finalSegments.get(changedDocument.partitionId), initialSegments.get(changedDocument.partitionId));
    const unchangedPartitions = [...initialSegments.keys()].filter((partitionId) => !affectedPartitions.has(partitionId));
    assert.equal(unchangedPartitions.length > 0, true);
    for (const partitionId of unchangedPartitions) {
      const hash = initialSegments.get(partitionId);
      assert.equal(finalSegments.get(partitionId), hash);
      assert.deepEqual(fs.readFileSync(path.join(paths.segmentsDir, hash)), initialSegmentBytes.get(hash));
      assert.equal(harness.segmentRenames.includes(hash), false);
    }
    const rewrittenSegmentHashes = new Set(harness.segmentRenames);
    const expectedRewrittenSegmentHashes = new Set();
    for (const partitionId of affectedPartitions) {
      const finalHash = finalSegments.get(partitionId);
      if (finalHash && finalHash !== initialSegments.get(partitionId)) expectedRewrittenSegmentHashes.add(finalHash);
    }
    assert.deepEqual(rewrittenSegmentHashes, expectedRewrittenSegmentHashes);

    const vectorResult = await harness.service.retrieve({
      vault: harness.vault,
      origin: "text",
      text: MARKER,
      query: MARKER,
      retrieval: "vector",
      limit: 3,
      debug: true
    }, context("ac11-vector"));
    assert.equal(vectorResult.status, "ready");
    assert.equal(vectorResult.retrievalSnapshotId, finalRetrieval.active.retrievalSnapshotId);
    assert.equal(vectorResult.dense.state, "fresh");
    assert.equal(vectorResult.dense.pendingCount, 0);
    assert.equal(resultPath(vectorResult, changedDocument.path)?.path, changedDocument.path);
    assert.equal(resultPath(vectorResult, newDocumentPath)?.path, newDocumentPath);
    assert.ok(denseAgreementForPath(vectorResult, changedDocument.path) > 0);
    assert.ok(denseAgreementForPath(vectorResult, newDocumentPath) > 0);
  } finally {
    producer.close();
    await harness.close();
  }
});

test("AC11 profile-vault watcher lifecycle starts once and stops on unload/close", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: "deterministic-hash",
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: "1"
  };
  const started = [];
  const closed = [];
  const manager = new ProfileManager(env, undefined, {
    startSaveWatcher(options) {
      started.push(options);
      return {
        close() {
          closed.push(options.vaultRoot);
        }
      };
    }
  });

  try {
    const lease = await manager.acquire({});
    try {
      lease.runtime.startSaveWatcherForVault(vault);
      lease.runtime.startSaveWatcherForVault(vault);
      assert.equal(started.length, 1);
      assert.equal(started[0].vaultRoot, fs.realpathSync(vault));
      lease.runtime.stopSaveWatcherForVault(vault);
      assert.deepEqual(closed, [fs.realpathSync(vault)]);
      lease.runtime.startSaveWatcherForVault(vault);
      assert.equal(started.length, 2);
    } finally {
      lease.release();
    }
  } finally {
    await manager.close();
  }
  assert.deepEqual(closed, [fs.realpathSync(vault), fs.realpathSync(vault)]);
});
