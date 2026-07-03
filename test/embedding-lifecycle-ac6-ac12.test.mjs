import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DeterministicHashProvider,
  buildEmbeddingSetFromVectors,
  embeddingRecipeFreshnessId,
  embeddingSpaceIdForRecipe,
  vectorGenerationIdForManifest
} from "../src/core/search/dense/index.ts";
import { buildCanonicalSearchSnapshot } from "../src/daemon/search-store/builder.ts";
import {
  effectiveSearchRuntimeProfile,
  lexicalIdentityHashForSearchRuntimeProfile
} from "../src/daemon/runtime-profile.ts";
import {
  DaemonSnapshotStore,
  createWorkerEmbeddingSetBuilder
} from "../src/daemon/search-store/snapshot-store.ts";
import { searchStoreCachePaths } from "../src/daemon/search-store/cache-paths.ts";
import { EmbedScheduler, VectorGenerationManager } from "../src/daemon/embed-scheduler.ts";
import { ProfileManager } from "../src/daemon/profile-manager.ts";
import {
  VectorGenerationPool,
  vectorGenerationDir,
  vectorStoreCachePaths
} from "../src/daemon/vector-store/index.ts";
import { docIdForVaultPath } from "../src/daemon/vector-store/watcher.ts";
import { createMemoryCoralNeedleInstanceFactory } from "./helpers/memory-coral-needle.mjs";
import {
  activeRetrievalFromEdition,
  generationDirForEnvelope
} from "./helpers/edition-ledger.mjs";

const PROFILE_HASH = "embedding-lifecycle-ac6-ac12";

function tempRoot(prefix = "optsidian-embedding-lifecycle-") {
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

function dirtyMarkForPath(vault, rel) {
  return {
    docId: docIdForVaultPath(rel),
    path: rel,
    contentHash: sha256(fs.readFileSync(path.join(vault, rel)))
  };
}

function searchPathsForRuntime(vault, env, profile = effectiveSearchRuntimeProfile(process.cwd(), env)) {
  return searchStoreCachePaths(vault, env, {
    lexicalIdentityHash: lexicalIdentityHashForSearchRuntimeProfile(profile)
  });
}

function context(id = "embedding-lifecycle") {
  return {
    deadline: Date.now() + 5000,
    cancellationId: `${id}-${Math.random().toString(16).slice(2)}`,
    requestId: `${id}-${Math.random().toString(16).slice(2)}`
  };
}

function testAnalyzer(identity = { name: "test-analyzer", version: "embedding-lifecycle-ac6-ac12", node: "test" }) {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity,
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function baseRecipe() {
  return {
    schemaVersion: 1,
    provider: {
      id: "deterministic-hash",
      model: "content-hash-v1",
      dim: 8,
      version: "1"
    },
    recipeVersion: "deterministic-hash-embedding-recipe-v1",
    projectionVersion: "l2-float64-projection-v1",
    normalization: "l2"
  };
}

function documentInput(document) {
  const snippets = document.snippetCorpus.lines.map((line) => line.text).join("\n");
  const tags = document.tags.length > 0 ? `\n${document.tags.join(" ")}` : "";
  return {
    documentId: document.documentId,
    shardDocRef: {
      segmentId: "",
      partitionId: document.partitionId,
      localDocId: 0,
      documentId: document.documentId
    },
    path: document.path,
    text: `${document.title}\n${document.path}\n${snippets}${tags}`.trim(),
    contentHash: document.contentHash
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

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

async function drainBackgroundGc(store, paths) {
  await new Promise((resolve) => setImmediate(resolve));
  const running = store.runningGcByVault.get(paths.vaultStateHash);
  if (running) await running;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function retrievalEnvelope(paths, retrievalSnapshotId) {
  return readJson(path.join(paths.retrievalsDir, retrievalSnapshotId));
}

function activeRetrieval(paths) {
  const active = activeRetrievalFromEdition(paths);
  return {
    active,
    envelope: retrievalEnvelope(paths, active.retrievalSnapshotId)
  };
}

function createGatedEmbedding(provider, blockedCallNumbers = [1]) {
  const gates = new Map(blockedCallNumbers.map((callNumber) => [callNumber, deferred()]));
  const calls = [];
  return {
    calls,
    release: (callNumber) => gates.get(callNumber)?.resolve(),
    releaseFirst: () => gates.get(1)?.resolve(),
    async encode(payload) {
      const callNumber = calls.length + 1;
      calls.push({
        texts: [...payload.texts],
        inputKind: payload.inputKind ?? "document"
      });
      const gate = gates.get(callNumber);
      if (gate) await gate.promise;
      return {
        provider: provider.identity,
        vectors: await Promise.all(payload.texts.map((text) => provider.embed(text, { inputKind: payload.inputKind })))
      };
    },
    cancel() {},
    stats() {
      return { encodeCalls: calls.length };
    }
  };
}

function createRuntimeGatedEmbedding() {
  const calls = [];
  const documentGates = [];
  let gateDocuments = false;
  return {
    calls,
    setGateDocuments(value) {
      gateDocuments = value;
    },
    pendingDocumentGateCount() {
      return documentGates.length;
    },
    releaseNextDocument() {
      const gate = documentGates.shift();
      assert.ok(gate, "expected a gated document encode");
      gate.resolve();
    },
    releaseAllDocuments() {
      while (documentGates.length > 0) documentGates.shift().resolve();
    },
    async encode(payload) {
      const call = {
        texts: [...payload.texts],
        inputKind: payload.inputKind ?? "document",
        provider: payload.provider
      };
      calls.push(call);
      if (call.inputKind === "document" && gateDocuments) {
        const gate = deferred();
        documentGates.push(gate);
        await gate.promise;
      }
      return {
        provider: {
          id: payload.provider.kind,
          model: payload.provider.model ?? "content-hash-v1",
          dim: payload.provider.dim ?? 8,
          version: "1"
        },
        vectors: payload.texts.map((text, index) => runtimeVector(text, payload.provider.dim ?? 8, index))
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

function runtimeVector(text, dim, offset) {
  const vector = new Array(dim).fill(0);
  vector[(sha256(`${offset}:${text}`).charCodeAt(0) + offset) % dim] = 1;
  return vector;
}

function pathFromDenseText(text) {
  const line = text.split("\n").find((candidate) => candidate.endsWith(".md"));
  assert.ok(line, `expected dense text to include a markdown path: ${text}`);
  return line;
}

function simpleEmbeddingDocument(documentId, text, contentHash = `hash-${documentId}`) {
  return {
    documentId,
    shardDocRef: {
      segmentId: "seg",
      partitionId: 0,
      localDocId: 0,
      documentId
    },
    path: `${documentId}.md`,
    text,
    contentHash
  };
}

function createTestEmbeddingSetBuilder(provider, embedding = createGatedEmbedding(provider, [])) {
  return createWorkerEmbeddingSetBuilder({
    provider,
    providerPayload: {
      kind: "deterministic-hash",
      model: provider.identity.model,
      dim: provider.identity.dim
    },
    embedding,
    batchSize: 1
  });
}

test("AC12 manifest-addressed generation id is deterministic over promoted manifest content", () => {
  const recipe = baseRecipe();
  const embeddingSpaceId = embeddingSpaceIdForRecipe(recipe);
  const recipeFreshnessId = embeddingRecipeFreshnessId(recipe);
  const documents = [
    {
      documentId: "doc-b",
      shardDocRef: { segmentId: "seg", partitionId: 0, localDocId: 2, documentId: "doc-b" },
      path: "B.md",
      text: "beta",
      contentHash: "content-beta"
    },
    {
      documentId: "doc-a",
      shardDocRef: { segmentId: "seg", partitionId: 0, localDocId: 1, documentId: "doc-a" },
      path: "A.md",
      text: "alpha",
      contentHash: "content-alpha"
    }
  ];
  const vectors = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0]
  ];
  const first = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe,
    documents,
    vectors
  });
  const second = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe: structuredClone(recipe),
    documents: structuredClone(documents).reverse(),
    vectors: structuredClone(vectors).reverse()
  });
  const corpusRevision = "corpus-revision-a";
  const firstId = vectorGenerationIdForManifest({
    embeddingSpaceId,
    embeddingRecipeFreshnessId: recipeFreshnessId,
    corpusRevision,
    records: first.records
  });
  const secondId = vectorGenerationIdForManifest({
    embeddingSpaceId,
    embeddingRecipeFreshnessId: recipeFreshnessId,
    corpusRevision,
    records: second.records
  });

  assert.equal(firstId, secondId);
  assert.equal(firstId.startsWith("gen-"), true);
  assert.equal(firstId.startsWith("save-"), false);

  const foldedDocuments = structuredClone(documents);
  foldedDocuments[1].text = "alpha folded";
  foldedDocuments[1].contentHash = "content-alpha-folded";
  const foldedVectors = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0]
  ];
  const folded = buildEmbeddingSetFromVectors({
    provider: recipe.provider,
    recipe,
    documents: foldedDocuments,
    vectors: foldedVectors
  });
  const foldedId = vectorGenerationIdForManifest({
    embeddingSpaceId,
    embeddingRecipeFreshnessId: recipeFreshnessId,
    corpusRevision,
    records: folded.records
  });

  assert.notEqual(foldedId, firstId);
  assert.equal(
    foldedId,
    vectorGenerationIdForManifest({
      embeddingSpaceId,
      embeddingRecipeFreshnessId: recipeFreshnessId,
      corpusRevision,
      records: folded.records
    })
  );
});

test("AC12 identical-content rebuild reuses the active vector generation directory", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  fs.mkdirSync(vault, { recursive: true });
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha semantic target\n");
  writeVaultFile(vault, "Beta.md", "# Beta\n\nbeta semantic target\n");

  const analyzer = testAnalyzer();
  const provider = new DeterministicHashProvider();
  const builder = createTestEmbeddingSetBuilder(provider);
  const baseFactory = createMemoryCoralNeedleInstanceFactory();
  const vectorCreates = [];
  const vectorPool = new VectorGenerationPool({
    factory: {
      async create(input) {
        vectorCreates.push({ ...input });
        return baseFactory.create(input);
      }
    }
  });
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: builder,
    snapshotBuilder: (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      })
  });

  await store.rebuild(vault, context("ac12-reuse-first"));
  const paths = searchStoreCachePaths(vault, env);
  const { active: firstActive, envelope: firstEnvelope } = activeRetrieval(paths);
  const firstVectorPaths = vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash: PROFILE_HASH,
    embeddingSetId: firstEnvelope.embeddingSetId,
    env
  });
  const firstGenerationDir = generationDirForEnvelope(firstVectorPaths, firstEnvelope);
  const sentinel = path.join(firstGenerationDir, "live-reader.sentinel");
  fs.writeFileSync(sentinel, "held\n");

  const readContextResult = await store.pinLexicalReadContext(vault, context("ac12-reuse-pin"));
  assert.equal(readContextResult.status, "ready");
  const readContext = readContextResult.readContext;
  const attached = await store.tryAttachDenseGeneration(readContext, store.currentEmbeddingSpaceId());
  assert.equal(attached.status, "attached");
  const vectorCreateCountBefore = vectorCreates.length;

  await store.rebuild(vault, context("ac12-reuse-second"));

  const { active: secondActive, envelope: secondEnvelope } = activeRetrieval(paths);
  assert.equal(secondEnvelope.vector.generationId, firstEnvelope.vector.generationId);
  assert.equal(fs.existsSync(sentinel), true);
  assert.equal(vectorCreates.length, vectorCreateCountBefore);
  assert.equal(vectorCreates.filter((call) => call.role === "staging" && call.generationId === firstEnvelope.vector.generationId).length, 1);

  const queryVector = firstEnvelope.embeddingSet.records[0].vector;
  const hits = await attached.densePin.vectorLease.searchVector(queryVector, 1);
  assert.equal(hits.length, 1);
  store.releaseReadContext(readContext);
  await vectorPool.close();
});

test("AC6 watcher save folds queued docs in place and embedded docs into the next save generation", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  for (let index = 0; index < 70; index += 1) {
    writeVaultFile(vault, `Note-${String(index).padStart(2, "0")}.md`, `# Note ${index}\n\nbaseline body ${index}\n`);
  }
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: "deterministic-hash",
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: "1"
  };
  const embedding = createRuntimeGatedEmbedding();
  const vectorManager = new VectorGenerationManager({
    factory: createMemoryCoralNeedleInstanceFactory()
  });
  const scheduler = new EmbedScheduler({
    embedding,
    ownsEmbedding: false,
    vectorManager,
    ownsVectorManager: true
  });
  let watcherOptions;
  const manager = new ProfileManager(env, scheduler, {
    saveMutationDeadlineMs: 10_000,
    startSaveWatcher(options) {
      watcherOptions = options;
      return {
        close() {},
        unref() {}
      };
    }
  });

  try {
    const lease = await manager.acquire({});
    try {
      await lease.runtime.searchStore.loadVault(vault, context("ac6-runtime-load"), {
        preload: false,
        warmupQueryAnalyzer: false
      });
      const paths = searchPathsForRuntime(vault, env, lease.runtime.profile);
      const initialRetrieval = activeRetrieval(paths);
      const initialCallCount = embedding.calls.length;
      embedding.setGateDocuments(true);
      lease.runtime.startSaveWatcherForVault(vault);
      assert.equal(typeof watcherOptions?.onDirtyMarks, "function");

      writeVaultFile(vault, "Note-00.md", "# Note 0\n\nfirst save starts the build\n");
      await watcherOptions.onDirtyMarks([dirtyMarkForPath(vault, "Note-00.md")]);
      await waitFor(() => embedding.calls.length >= initialCallCount + 1);
      assert.equal(embedding.calls[initialCallCount].texts.length, 32);

      embedding.releaseNextDocument();
      await waitFor(() => embedding.calls.length >= initialCallCount + 2);
      const firstBatchPaths = embedding.calls[initialCallCount].texts.map(pathFromDenseText);
      const secondBatchPaths = embedding.calls[initialCallCount + 1].texts.map(pathFromDenseText);
      const activeBatchPaths = new Set([...firstBatchPaths, ...secondBatchPaths]);
      const allPaths = Array.from({ length: 70 }, (_value, index) => `Note-${String(index).padStart(2, "0")}.md`);
      const embeddedPath = firstBatchPaths[0];
      const queuedPath = allPaths.find((candidate) => !activeBatchPaths.has(candidate));
      assert.ok(embeddedPath);
      assert.ok(queuedPath);

      const embeddedNextMarker = "embedded doc folded to next generation";
      const queuedFoldedMarker = "queued doc folded in place";
      writeVaultFile(vault, embeddedPath, `# Embedded\n\n${embeddedNextMarker}\n`);
      writeVaultFile(vault, queuedPath, `# Queued\n\n${queuedFoldedMarker}\n`);
      await watcherOptions.onDirtyMarks([
        dirtyMarkForPath(vault, embeddedPath),
        dirtyMarkForPath(vault, queuedPath)
      ]);
      const canonicalVault = fs.realpathSync(vault);
      await lease.runtime.savePublications.get(canonicalVault).foldChain;

      embedding.releaseNextDocument();
      await waitFor(() => embedding.calls.length >= initialCallCount + 3);
      const queuedFoldedEncodeTexts = embedding.calls
        .slice(initialCallCount, initialCallCount + 3)
        .flatMap((call) => call.texts)
        .filter((text) => text.includes(queuedPath));
      assert.equal(queuedFoldedEncodeTexts.length, 1);
      assert.equal(queuedFoldedEncodeTexts[0].includes(queuedFoldedMarker), true);

      embedding.releaseNextDocument();
      await waitFor(() => embedding.calls.length >= initialCallCount + 4);
      const firstSaveRetrieval = activeRetrieval(paths);
      assert.notEqual(firstSaveRetrieval.active.retrievalSnapshotId, initialRetrieval.active.retrievalSnapshotId);
      const firstSaveEmbedded = firstSaveRetrieval.envelope.embeddingSet.records.find((record) => record.path === embeddedPath);
      const firstSaveQueued = firstSaveRetrieval.envelope.embeddingSet.records.find((record) => record.path === queuedPath);
      assert.ok(firstSaveEmbedded);
      assert.ok(firstSaveQueued);
      assert.equal(firstSaveEmbedded.text.includes(embeddedNextMarker), false);
      assert.equal(firstSaveQueued.text.includes(queuedFoldedMarker), true);

      while (embedding.calls.length < initialCallCount + 6 || embedding.pendingDocumentGateCount() > 0) {
        if (embedding.pendingDocumentGateCount() === 0 && embedding.calls.length >= initialCallCount + 6) break;
        if (embedding.pendingDocumentGateCount() === 0) {
          await waitFor(() => embedding.pendingDocumentGateCount() > 0 || embedding.calls.length >= initialCallCount + 6);
        }
        embedding.releaseAllDocuments();
      }
      await waitFor(() => activeRetrieval(paths).active.retrievalSnapshotId !== firstSaveRetrieval.active.retrievalSnapshotId);
      const finalRetrieval = activeRetrieval(paths);
      const finalEmbedded = finalRetrieval.envelope.embeddingSet.records.find((record) => record.path === embeddedPath);
      const finalQueued = finalRetrieval.envelope.embeddingSet.records.find((record) => record.path === queuedPath);
      assert.ok(finalEmbedded);
      assert.ok(finalQueued);
      assert.equal(finalEmbedded.text.includes(embeddedNextMarker), true);
      assert.equal(finalQueued.text.includes(queuedFoldedMarker), true);
    } finally {
      lease.release();
    }
  } finally {
    embedding.releaseAllDocuments();
    await manager.close();
    await scheduler.close();
  }
});

test("AC1 post-restart lazy-open GC pin protects the opening vector generation", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  fs.mkdirSync(vault, { recursive: true });
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha before lazy open\n");

  const analyzer = testAnalyzer();
  const provider = new DeterministicHashProvider();
  const firstPool = new VectorGenerationPool({
    factory: createMemoryCoralNeedleInstanceFactory()
  });
  const firstStore = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    retentionCount: 1,
    profileHash: PROFILE_HASH,
    vectorPool: firstPool,
    embeddingSetBuilder: createTestEmbeddingSetBuilder(provider),
    snapshotBuilder: (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      })
  });
  await firstStore.rebuild(vault, context("ac1-gc-first"));
  const paths = searchStoreCachePaths(vault, env);
  await drainBackgroundGc(firstStore, paths);
  const { active: oldActive, envelope: oldEnvelope } = activeRetrieval(paths);
  const oldVectorPaths = vectorStoreCachePaths({
    vaultRoot: vault,
    profileHash: PROFILE_HASH,
    embeddingSetId: oldEnvelope.embeddingSetId,
    env
  });
  const oldGenerationDir = generationDirForEnvelope(oldVectorPaths, oldEnvelope);
  await firstPool.close();

  const lazyOpenEntered = deferred();
  const releaseLazyOpen = deferred();
  const baseFactory = createMemoryCoralNeedleInstanceFactory();
  const restartedPool = new VectorGenerationPool({
    factory: {
      async create(input) {
        if (input.role === "query" && input.generationId === oldEnvelope.vector.generationId) {
          lazyOpenEntered.resolve();
          await releaseLazyOpen.promise;
        }
        return baseFactory.create(input);
      }
    }
  });
  const restartedStore = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    retentionCount: 1,
    profileHash: PROFILE_HASH,
    vectorPool: restartedPool,
    embeddingSetBuilder: createTestEmbeddingSetBuilder(provider),
    snapshotBuilder: (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      })
  });
  const readContextResult = await restartedStore.pinLexicalReadContext(vault, context("ac1-gc-pin"));
  assert.equal(readContextResult.status, "ready");
  const readContext = readContextResult.readContext;
  const attach = restartedStore.tryAttachDenseGeneration(readContext, restartedStore.currentEmbeddingSpaceId());
  await lazyOpenEntered.promise;

  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha after active generation flip\n");
  await restartedStore.rebuild(vault, context("ac1-gc-flip"));
  const { envelope: newEnvelope } = activeRetrieval(paths);
  assert.notEqual(newEnvelope.vector.generationId, oldEnvelope.vector.generationId);
  fs.rmSync(path.join(paths.retrievalsDir, oldActive.retrievalSnapshotId), { force: true });

  await restartedStore.runBackgroundGc(paths);
  assert.equal(fs.existsSync(oldGenerationDir), true);

  releaseLazyOpen.resolve();
  await attach;
  restartedStore.releaseReadContext(readContext);
  await restartedStore.runBackgroundGc(paths);
  assert.equal(fs.existsSync(oldGenerationDir), false);
  await restartedPool.close();
});

test("AC1 a thrown lazy-open releases the retained dense GC pin (B5)", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  fs.mkdirSync(vault, { recursive: true });
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha before throwing lazy open\n");

  const analyzer = testAnalyzer();
  const provider = new DeterministicHashProvider();
  const firstPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  const firstStore = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    retentionCount: 1,
    profileHash: PROFILE_HASH,
    vectorPool: firstPool,
    embeddingSetBuilder: createTestEmbeddingSetBuilder(provider),
    snapshotBuilder: (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      })
  });
  await firstStore.rebuild(vault, context("b5-first"));
  const paths = searchStoreCachePaths(vault, env);
  await drainBackgroundGc(firstStore, paths);
  await firstPool.close();

  const restartedPool = new VectorGenerationPool({ factory: createMemoryCoralNeedleInstanceFactory() });
  const restartedStore = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    retentionCount: 1,
    profileHash: PROFILE_HASH,
    vectorPool: restartedPool,
    embeddingSetBuilder: createTestEmbeddingSetBuilder(provider),
    snapshotBuilder: (input) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      })
  });
  const readContextResult = await restartedStore.pinLexicalReadContext(vault, context("b5-pin"));
  assert.equal(readContextResult.status, "ready");
  const readContext = readContextResult.readContext;
  assert.equal(restartedStore.densePinnedGenerationCountForTests(), 0);

  // Simulate a close race: pinReadableGeneration throws (as via assertOpen) AFTER the store has
  // retained the dense GC pin. Candidate resolution is disk-based, so the retain point is reached.
  restartedPool.pinReadableGeneration = async () => {
    throw new Error("simulated close race in pinReadableGeneration");
  };
  await assert.rejects(
    () => restartedStore.tryAttachDenseGeneration(readContext, restartedStore.currentEmbeddingSpaceId()),
    /simulated close race in pinReadableGeneration/
  );

  // B5: the thrown lazy-open must not leak the retained vector GC pin.
  assert.equal(restartedStore.densePinnedGenerationCountForTests(), 0);
  restartedStore.releaseReadContext(readContext);
  await restartedPool.close();
});

test("AC6 already embedded work folds to next incremental", async () => {
  const provider = new DeterministicHashProvider();
  const embedding = createGatedEmbedding(provider, [2]);
  const builder = createWorkerEmbeddingSetBuilder({
    provider,
    providerPayload: {
      kind: "deterministic-hash",
      model: provider.identity.model,
      dim: provider.identity.dim
    },
    embedding,
    batchSize: 1
  });
  const docA = simpleEmbeddingDocument("doc-a", "alpha old", "hash-alpha-old");
  const docB = simpleEmbeddingDocument("doc-b", "beta old", "hash-beta-old");

  const build = builder.build({
    vaultRoot: "/tmp/optsidian-ac6-direct",
    documents: [docA, docB],
    embeddingLane: "rebuild",
    ...context("ac6-embedded")
  });
  await waitFor(() => embedding.calls.length === 2);

  const folded = builder.foldQueuedDocument("save", {
    ...docA,
    text: "alpha embedded next",
    contentHash: "hash-alpha-next"
  });
  assert.deepEqual(
    { target: folded.target, lane: folded.lane, reason: folded.reason },
    { target: "next", lane: "save", reason: "embedded" }
  );

  embedding.release(2);
  const embeddingSet = await build;
  const recordA = embeddingSet.records.find((record) => record.documentId === docA.documentId);
  assert.equal(recordA?.contentHash, docA.contentHash);
  assert.equal(recordA?.text, docA.text);

  const nextIncremental = builder.drainNextIncrementalDocuments("save");
  assert.equal(nextIncremental.length, 1);
  assert.equal(nextIncremental[0].documentId, docA.documentId);
  assert.equal(nextIncremental[0].contentHash, "hash-alpha-next");
});

test("AC6 queued save folds in place while in-flight save folds to next incremental", async () => {
  const root = tempRoot();
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
  writeVaultFile(vault, "01-Alpha.md", "# Alpha\n\nalpha first in flight marker\n");
  writeVaultFile(vault, "02-Beta.md", "# Beta\n\nbeta queued old marker\n");
  writeVaultFile(vault, "03-Gamma.md", "# Gamma\n\ngamma tail marker\n");

  const analyzer = testAnalyzer();
  const provider = new DeterministicHashProvider();
  const embedding = createGatedEmbedding(provider);
  const builder = createWorkerEmbeddingSetBuilder({
    provider,
    providerPayload: {
      kind: "deterministic-hash",
      model: provider.identity.model,
      dim: provider.identity.dim
    },
    embedding,
    batchSize: 1
  });
  let builtForStore;
  const vectorPool = new VectorGenerationPool({
    factory: createMemoryCoralNeedleInstanceFactory()
  });
  const store = new DaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: 1,
    profileHash: PROFILE_HASH,
    vectorPool,
    embeddingSetBuilder: builder,
    snapshotBuilder: async (input) => {
      builtForStore = await buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        progress: input.progress
      });
      return builtForStore;
    }
  });

  const rebuild = store.rebuild(vault, { ...context("ac6"), embeddingLane: "rebuild" });
  await waitFor(() => embedding.calls.length === 1 && builtForStore !== undefined);

  const firstOldDocument = documentInput(builtForStore.documents[0]);
  const queuedOldRecord = builtForStore.documents.find((document) =>
    document.path === "02-Beta.md" && document.documentId !== firstOldDocument.documentId
  ) ?? builtForStore.documents.find((document) => document.documentId !== firstOldDocument.documentId);
  assert.ok(queuedOldRecord);
  const queuedOldDocument = documentInput(queuedOldRecord);
  assert.equal(embedding.calls[0].texts[0], firstOldDocument.text);
  assert.notEqual(queuedOldDocument.text, firstOldDocument.text);

  const inFlightFold = builder.foldQueuedDocument("save", {
    ...firstOldDocument,
    text: `${firstOldDocument.text}\nin-flight next incremental marker`,
    contentHash: "content-in-flight-next"
  });
  assert.deepEqual(
    { target: inFlightFold.target, lane: inFlightFold.lane, reason: inFlightFold.reason },
    { target: "next", lane: "save", reason: "in-flight" }
  );

  const queuedNewMarker = `queued new folded marker for ${queuedOldDocument.path}`;
  const queuedTitle = path.basename(queuedOldDocument.path, ".md").replace(/^\d+-/, "");
  writeVaultFile(vault, queuedOldDocument.path, `# ${queuedTitle}\n\n${queuedNewMarker}\n`);
  const updatedBuilt = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const queuedNewRecord = updatedBuilt.documents.find((document) => document.path === queuedOldDocument.path);
  assert.ok(queuedNewRecord);
  const queuedNewDocument = documentInput(queuedNewRecord);
  const queuedFold = builder.foldQueuedDocument("save", queuedNewDocument);
  assert.deepEqual(
    { target: queuedFold.target, lane: queuedFold.lane, reason: queuedFold.reason },
    { target: "current", lane: "rebuild", reason: "queued" }
  );

  embedding.releaseFirst();
  await rebuild;

  const paths = searchStoreCachePaths(vault, env);
  const { envelope } = activeRetrieval(paths);
  const firstRecord = envelope.embeddingSet.records.find((record) => record.documentId === firstOldDocument.documentId);
  const queuedRecord = envelope.embeddingSet.records.find((record) => record.documentId === queuedNewDocument.documentId);
  assert.ok(firstRecord);
  assert.ok(queuedRecord);
  assert.equal(firstRecord.contentHash, firstOldDocument.contentHash);
  assert.equal(firstRecord.text.includes("in-flight next incremental marker"), false);
  assert.equal(queuedRecord.contentHash, queuedNewDocument.contentHash);
  assert.notEqual(queuedRecord.contentHash, queuedOldDocument.contentHash);
  assert.equal(queuedRecord.text.includes(queuedNewMarker), true);
  assert.equal(queuedRecord.text.includes(queuedOldDocument.text), false);

  const encodedQueuedTexts = embedding.calls.flatMap((call) => call.texts).filter((text) => text.includes(queuedOldDocument.path));
  assert.deepEqual(encodedQueuedTexts, [queuedNewDocument.text]);

  const nextIncremental = builder.drainNextIncrementalDocuments("save");
  assert.equal(nextIncremental.length, 1);
  assert.equal(nextIncremental[0].documentId, firstOldDocument.documentId);
  assert.equal(nextIncremental[0].contentHash, "content-in-flight-next");

  const expectedGenerationId = vectorGenerationIdForManifest({
    embeddingSpaceId: envelope.embeddingSpaceId,
    embeddingRecipeFreshnessId: envelope.embeddingRecipeFreshnessId,
    corpusRevision: envelope.corpusSnapshotId,
    records: envelope.embeddingSet.records
  });
  assert.equal(envelope.vector.generationId, expectedGenerationId);
  assert.equal(envelope.vector.generationId.startsWith("save-"), false);

  await vectorPool.close();
});
