import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeterministicEmbeddingSetBuilder } from "./helpers/deterministic-embedding.mjs";

const repoRoot = process.cwd();
const PRE_CHANGE_SCHEMA_DIGEST = "298ed77e0d89ac164671c8104225d1f292e955d75ed27423de49d169e185afac";
const SEARCH_SETTINGS = { ngram: false };

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function tempRoot(prefix = "optsidian-search-ac5-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity: { name: "test-analyzer", version: "1", node: "test" },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function persistJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

test("AC5 schema digest identity changes from the pre-change baseline and stale identity auto-rebuilds", async () => {
  const { SEARCH_DB_SCHEMA, SEARCH_SCHEMA_DIGEST } = await import(path.join(repoRoot, "src/core/search/schema.ts"));
  const { buildCanonicalSearchSnapshot, snapshotIdentityTupleForAnalyzerIdentity } = await import(
    path.join(repoRoot, "src/daemon/search-store/builder.ts")
  );
  const { createDaemonSnapshotStore } = await import(path.join(repoRoot, "src/daemon/search-store/snapshot-store.ts"));
  const { searchStoreCachePaths } = await import(path.join(repoRoot, "src/daemon/search-store/cache-paths.ts"));
  const {
    canonicalValueBytes,
    canonicalSnapshotManifestBytes,
    snapshotIdFromManifest
  } = await import(path.join(repoRoot, "src/core/search/segments/canonical.ts"));
  const {
    SNAPSHOT_PERSISTENCE_SCHEMA,
    SNAPSHOT_PERSISTENCE_SCHEMA_HASH
  } = await import(path.join(repoRoot, "src/daemon/search-store/types.ts"));

  assert.equal(SEARCH_SCHEMA_DIGEST, sha256(JSON.stringify(SEARCH_DB_SCHEMA)));
  assert.equal(SNAPSHOT_PERSISTENCE_SCHEMA_HASH, sha256(canonicalValueBytes(SNAPSHOT_PERSISTENCE_SCHEMA)));
  assert.notEqual(SEARCH_SCHEMA_DIGEST, PRE_CHANGE_SCHEMA_DIGEST);

  assert.deepEqual(Object.keys(SEARCH_DB_SCHEMA).sort(), [
    "indexedPostings",
    "indexedTokenProperties",
    "persistedDocument",
    "segmentFieldTexts",
    "snippetCorpus"
  ]);
  assert.equal(SEARCH_DB_SCHEMA.persistedDocument.fields.includes("body"), false);
  assert.equal(SEARCH_DB_SCHEMA.persistedDocument.fields.some((field) => /Tokens$/.test(field)), false);
  assert.ok(SEARCH_DB_SCHEMA.indexedPostings.fields.includes("body"));
  const tokenFields = Object.values(SEARCH_DB_SCHEMA.indexedTokenProperties).flat();
  assert.equal(tokenFields.length, 18);
  assert.ok(tokenFields.includes("bodyTokens"));
  assert.ok(tokenFields.includes("bodySurfaceTokens"));
  assert.ok(tokenFields.includes("bodyNgramTokens"));
  assert.equal(SEARCH_DB_SCHEMA.segmentFieldTexts.fields.includes("body"), false);
  assert.equal(SEARCH_DB_SCHEMA.snippetCorpus.name, "single-snippet-corpus");
  assert.equal(typeof SEARCH_DB_SCHEMA.snippetCorpus.version, "number");

  const analyzer = testAnalyzer();
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity(analyzer.identity, 1, SEARCH_SETTINGS);
  assert.equal(identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);
  assert.notEqual(identityTuple.fieldSetVersion, PRE_CHANGE_SCHEMA_DIGEST);

  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
    searchSettings: SEARCH_SETTINGS
  });
  let buildCount = 0;
  const store = createDaemonSnapshotStore({
    env,
    analyzer,
    partitionBits: 1,
    searchSettings: SEARCH_SETTINGS,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async () => {
      buildCount += 1;
      return built;
    }
  });

  const current = await store.loadVault(vault);
  assert.equal(current.vaults[0].status, "ready");
  assert.equal(current.snapshotId, built.snapshotId);
  assert.equal(buildCount, 1);

  const paths = searchStoreCachePaths(vault, env);
  const currentEnvelopePath = path.join(paths.snapshotsDir, built.snapshotId);
  const currentEnvelope = JSON.parse(fs.readFileSync(currentEnvelopePath, "utf8"));
  assert.equal(currentEnvelope.manifest.identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);

  const staleManifest = structuredClone(currentEnvelope.manifest);
  staleManifest.identityTuple = {
    ...staleManifest.identityTuple,
    fieldSetVersion: PRE_CHANGE_SCHEMA_DIGEST
  };
  const staleSnapshotId = snapshotIdFromManifest(staleManifest);
  const staleCanonicalManifestSha256 = sha256(canonicalSnapshotManifestBytes(staleManifest));
  const staleEnvelope = {
    ...currentEnvelope,
    snapshotId: staleSnapshotId,
    manifest: staleManifest,
    canonicalManifestSha256: staleCanonicalManifestSha256
  };
  persistJson(path.join(paths.snapshotsDir, staleSnapshotId), staleEnvelope);
  persistJson(paths.activePointerPath, {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    snapshotId: staleSnapshotId,
    canonicalManifestSha256: staleCanonicalManifestSha256
  });

  assert.equal(store.readSnapshotEnvelope(paths, staleSnapshotId)?.snapshotId, staleSnapshotId);
  assert.equal(store.snapshotIdentityMatches(paths, staleSnapshotId), false);

  const repaired = await store.loadVault(vault);
  assert.equal(repaired.vaults[0].status, "ready");
  assert.equal(repaired.snapshotId, built.snapshotId);
  assert.equal(buildCount, 2);
  const repairedActive = JSON.parse(fs.readFileSync(paths.activePointerPath, "utf8"));
  assert.equal(repairedActive.snapshotId, built.snapshotId);
});

test("AC5 snapshot envelope validator rejects old diagnostics.documents shape at the read boundary", async () => {
  const { SEARCH_SCHEMA_DIGEST } = await import(path.join(repoRoot, "src/core/search/schema.ts"));
  const { createDaemonSnapshotStore } = await import(path.join(repoRoot, "src/daemon/search-store/snapshot-store.ts"));
  const { searchStoreCachePaths } = await import(path.join(repoRoot, "src/daemon/search-store/cache-paths.ts"));
  const { SNAPSHOT_PERSISTENCE_SCHEMA_HASH } = await import(path.join(repoRoot, "src/daemon/search-store/types.ts"));

  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nproject alpha\n");
  const store = createDaemonSnapshotStore({
    env,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: SEARCH_SETTINGS,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder()
  });

  const loaded = await store.loadVault(vault);
  assert.equal(loaded.vaults[0].status, "ready");

  const paths = searchStoreCachePaths(vault, env);
  const active = JSON.parse(fs.readFileSync(paths.activePointerPath, "utf8"));
  const envelopePath = path.join(paths.snapshotsDir, active.snapshotId);
  const envelope = JSON.parse(fs.readFileSync(envelopePath, "utf8"));
  assert.equal(envelope.schemaHash, SNAPSHOT_PERSISTENCE_SCHEMA_HASH);
  assert.equal(envelope.diagnostics.schemaHash, SNAPSHOT_PERSISTENCE_SCHEMA_HASH);
  assert.equal("schemaVersion" in envelope, false);
  assert.equal("schemaVersion" in envelope.diagnostics, false);
  assert.equal(envelope.manifest.identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);
  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId)?.snapshotId, active.snapshotId);
  for (const partition of envelope.manifest.partitions) {
    assert.equal(fs.existsSync(path.join(paths.segmentsDir, partition.segmentHash)), true);
  }

  const diagnosticsMarkerEnvelope = {
    ...envelope,
    diagnostics: {
      ...envelope.diagnostics,
      documents: envelope.documents
    }
  };
  assert.equal(Array.isArray(diagnosticsMarkerEnvelope.documents), true);
  assert.equal(Array.isArray(diagnosticsMarkerEnvelope.diagnostics.documents), true);
  persistJson(envelopePath, diagnosticsMarkerEnvelope);
  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId), undefined);

  const oldShapeEnvelope = structuredClone(diagnosticsMarkerEnvelope);
  delete oldShapeEnvelope.documents;
  assert.equal("documents" in oldShapeEnvelope, false);
  assert.equal(Array.isArray(oldShapeEnvelope.diagnostics.documents), true);
  persistJson(envelopePath, oldShapeEnvelope);

  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId), undefined);
});
