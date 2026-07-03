import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCanonicalSearchSnapshot } from "../src/daemon/search-store/builder.ts";
import { searchStoreCachePaths } from "../src/daemon/search-store/cache-paths.ts";
import { createDaemonSnapshotStore } from "../src/daemon/search-store/snapshot-store.ts";
import { createDeterministicEmbeddingSetBuilder } from "./helpers/deterministic-embedding.mjs";
import { currentEdition } from "./helpers/edition-ledger.mjs";

const PARTITION_BITS = 2;
const SEARCH_SETTINGS = { ngram: false };

function testAnalyzer(version = "1") {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity: { name: "test-analyzer", version, node: "test" },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function tempRoot(prefix = "optsidian-search-ac4-ac5-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createVault() {
  const vault = tempRoot();
  for (let index = 0; index < 10; index += 1) {
    writeVaultFile(vault, `Doc-${index}.md`, [
      `# Doc ${index}`,
      "",
      `needle ${index} links to [[Doc-${(index + 1) % 10}]]`,
      "Hangul 가나다 compatibility ①.",
      ""
    ].join("\n"));
  }
  return vault;
}

function createArtifact(root, label) {
  const artifact = path.join(root, `optsidian-${label}`);
  fs.writeFileSync(artifact, `#!/usr/bin/env node\n// ${label}\n`, { mode: 0o755 });
  return artifact;
}

function envFor(cacheRoot, artifactPath) {
  return {
    ...process.env,
    XDG_CACHE_HOME: cacheRoot,
    OPTSIDIAN_SEARCH_DAEMON_BUILD_ARTIFACT_PATH: artifactPath
  };
}

function createStore({ env, analyzer, calls, failIncremental }) {
  return createDaemonSnapshotStore({
    env,
    analyzerIdentity: analyzer.identity,
    partitionBits: PARTITION_BITS,
    searchSettings: SEARCH_SETTINGS,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async (input) => {
      const hasBase = Boolean(input.base);
      calls.push({ hasBase, baseSnapshotId: input.base?.envelope.snapshotId });
      if (hasBase && failIncremental?.()) {
        throw new Error("worker base-consumption failure after selected base segments");
      }
      return buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer,
        partitionBits: input.partitionBits,
        searchSettings: input.searchSettings,
        base: input.base,
        progress: input.progress
      });
    }
  });
}

async function fullSnapshot(vault, analyzer) {
  return buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: PARTITION_BITS,
    searchSettings: SEARCH_SETTINGS
  });
}

function activeEnvelope(paths) {
  const edition = currentEdition(paths);
  return JSON.parse(fs.readFileSync(path.join(paths.snapshotsDir, edition.corpus.snapshotId), "utf8"));
}

function writeActiveEnvelope(paths, envelope) {
  fs.writeFileSync(path.join(paths.snapshotsDir, envelope.snapshotId), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

function fallbackWarnings(envelope) {
  return envelope.diagnostics?.warnings?.filter((warning) => warning.includes("incremental fallback-to-full")) ?? [];
}

function assertFallbackEvidence({ paths, progress, expectedSnapshotId, expectedCorpusSnapshotId, reason }) {
  const envelope = activeEnvelope(paths);
  assert.equal(envelope.snapshotId, expectedSnapshotId);
  assert.equal(envelope.corpusSnapshotId, expectedCorpusSnapshotId);
  assert.ok(fallbackWarnings(envelope).some((warning) => warning.includes(reason)), `${reason}: persisted warning`);
  assert.ok(progress.some((update) => String(update.message ?? "").includes(reason)), `${reason}: progress diagnostic`);
  return envelope;
}

async function setup(analyzer = testAnalyzer()) {
  const cacheRoot = tempRoot("optsidian-search-ac4-ac5-cache-");
  const artifactRoot = tempRoot("optsidian-search-ac4-ac5-artifact-");
  const artifact = createArtifact(artifactRoot, "artifact-a");
  const env = envFor(cacheRoot, artifact);
  const vault = createVault();
  const calls = [];
  const store = createStore({ env, analyzer, calls });
  await store.rebuild(vault);
  const paths = searchStoreCachePaths(vault, env);
  calls.length = 0;
  return { artifactRoot, env, vault, paths, analyzer, store, calls };
}

test("AC4/AC5 production refresh and save pass a real base; rebuild forces base empty", async () => {
  const fixture = await setup();

  writeVaultFile(fixture.vault, "Doc-1.md", "# Doc 1\n\nneedle changed for refresh\n");
  const refreshed = await fixture.store.refresh(fixture.vault);
  assert.equal(refreshed.rebuilt, true);
  assert.equal(fixture.calls.at(-1)?.hasBase, true, "refresh should pass verified active base");

  writeVaultFile(fixture.vault, "Doc-2.md", "# Doc 2\n\nneedle changed for save\n");
  await fixture.store.publishSaveSnapshot(fixture.vault);
  assert.equal(fixture.calls.at(-1)?.hasBase, true, "save should pass verified active base");

  await fixture.store.rebuild(fixture.vault);
  assert.equal(fixture.calls.at(-1)?.hasBase, false, "rebuild must force base empty");
  assert.equal(typeof activeEnvelope(fixture.paths).baseReuseImplementationIdentity, "string");
});

test("AC4 corrupt base segment bytes restart full and preserve full snapshot id", async () => {
  const fixture = await setup();
  const baseEnvelope = activeEnvelope(fixture.paths);
  fs.writeFileSync(path.join(fixture.paths.segmentsDir, baseEnvelope.manifest.partitions[0].segmentHash), "corrupt");
  const expected = await fullSnapshot(fixture.vault, fixture.analyzer);
  const progress = [];

  const snapshotId = await fixture.store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(fixture.calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "base segment"
  });
});

test("AC4 deleted base segment restart full and preserve full snapshot id", async () => {
  const fixture = await setup();
  const baseEnvelope = activeEnvelope(fixture.paths);
  fs.rmSync(path.join(fixture.paths.segmentsDir, baseEnvelope.manifest.partitions[0].segmentHash), { force: true });
  const expected = await fullSnapshot(fixture.vault, fixture.analyzer);
  const progress = [];

  const snapshotId = await fixture.store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(fixture.calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "invalid or absent base envelope"
  });
});

test("AC4 identity tuple mismatch restarts full before base reuse", async () => {
  const fixture = await setup(testAnalyzer("1"));
  const analyzer = testAnalyzer("2");
  const calls = [];
  const store = createStore({ env: fixture.env, analyzer, calls });
  const expected = await fullSnapshot(fixture.vault, analyzer);
  const progress = [];

  const snapshotId = await store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "identity tuple mismatch"
  });
});

test("AC4 semantic document-hash mismatch restarts full and preserves full snapshot id", async () => {
  const fixture = await setup();
  const envelope = activeEnvelope(fixture.paths);
  envelope.documents[0] = { ...envelope.documents[0], contentHash: "0".repeat(64) };
  writeActiveEnvelope(fixture.paths, envelope);
  const expected = await fullSnapshot(fixture.vault, fixture.analyzer);
  const progress = [];

  const snapshotId = await fixture.store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(fixture.calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "semantic document manifest hash mismatch"
  });
});

test("AC4 worker base-consumption failure discards selected base segments and restarts full", async () => {
  const cacheRoot = tempRoot("optsidian-search-ac4-worker-cache-");
  const artifactRoot = tempRoot("optsidian-search-ac4-worker-artifact-");
  const env = envFor(cacheRoot, createArtifact(artifactRoot, "worker"));
  const vault = createVault();
  const analyzer = testAnalyzer();
  const calls = [];
  let failIncremental = false;
  const store = createStore({
    env,
    analyzer,
    calls,
    failIncremental: () => failIncremental
  });
  await store.rebuild(vault);
  const paths = searchStoreCachePaths(vault, env);
  calls.length = 0;
  failIncremental = true;
  const expected = await fullSnapshot(vault, analyzer);
  const progress = [];

  const snapshotId = await store.publishSaveSnapshot(vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(calls.map((call) => call.hasBase), [true, false]);
  assertFallbackEvidence({
    paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "worker base-consumption failure"
  });
});

test("AC5 base-reuse identity mismatch falls back before publish", async () => {
  const fixture = await setup();
  const envelope = activeEnvelope(fixture.paths);
  envelope.baseReuseImplementationIdentity = "mismatch";
  writeActiveEnvelope(fixture.paths, envelope);
  const expected = await fullSnapshot(fixture.vault, fixture.analyzer);
  const progress = [];

  const snapshotId = await fixture.store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(fixture.calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "base-reuse implementation identity mismatch"
  });
});

test("AC5 missing base-reuse identity on an old envelope falls back before publish", async () => {
  const fixture = await setup();
  const envelope = activeEnvelope(fixture.paths);
  delete envelope.baseReuseImplementationIdentity;
  writeActiveEnvelope(fixture.paths, envelope);
  const expected = await fullSnapshot(fixture.vault, fixture.analyzer);
  const progress = [];

  const snapshotId = await fixture.store.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.deepEqual(fixture.calls.map((call) => call.hasBase), [false]);
  assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "missing base-reuse implementation identity"
  });
});

test("AC5 simulated daemon binary hash change disables reuse and recomputes same corpus snapshot", async () => {
  const fixture = await setup();
  const analyzer = fixture.analyzer;
  const artifactB = createArtifact(fixture.artifactRoot, "artifact-b");
  const env = envFor(fixture.env.XDG_CACHE_HOME, artifactB);
  const calls = [];
  const restartedStore = createStore({ env, analyzer, calls });
  const before = activeEnvelope(fixture.paths);
  const expected = await fullSnapshot(fixture.vault, analyzer);
  const progress = [];

  const snapshotId = await restartedStore.publishSaveSnapshot(fixture.vault, { progress: (update) => progress.push(update) });

  assert.equal(snapshotId, expected.snapshotId);
  assert.equal(expected.corpusSnapshotId, before.corpusSnapshotId);
  assert.deepEqual(calls.map((call) => call.hasBase), [false]);
  const after = assertFallbackEvidence({
    paths: fixture.paths,
    progress,
    expectedSnapshotId: expected.snapshotId,
    expectedCorpusSnapshotId: expected.corpusSnapshotId,
    reason: "base-reuse implementation identity mismatch"
  });
  assert.notEqual(after.baseReuseImplementationIdentity, before.baseReuseImplementationIdentity);
});
