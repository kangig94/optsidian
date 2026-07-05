import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ANALYZER_VERSION } from '../src/core/search/constants.ts';
import {
  effectiveSearchRuntimeProfile,
  lexicalIdentityHashForSearchRuntimeProfile,
} from '../src/daemon/runtime-profile.ts';
import { INDEX_BUILD_VERSION } from '../src/daemon/search-store/builder.ts';
import { createDeterministicEmbeddingSetBuilder } from './helpers/deterministic-embedding.mjs';
import { activeSnapshotFromEdition } from './helpers/edition-ledger.mjs';

const PRE_CHANGE_SCHEMA_DIGEST = '298ed77e0d89ac164671c8104225d1f292e955d75ed27423de49d169e185afac';
const SEARCH_SETTINGS = { ngram: false };
const PINNED_INDEX_BUILD_VERSION = 'daemon-positional-build-v7';
const PINNED_ANALYZER_VERSION = 'router-intl-kiwi-link-render-v2';
const PINNED_LEXICAL_RUNTIME_PROFILE_IDENTITY = '59d91c009445dc5875fec48efe347ddbe04498a38397a258dd618fca75b43d62';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tempRoot(prefix = 'optsidian-search-ac5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'test-analyzer', version: '1', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function persistJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function runtimeProfileFixture() {
  return effectiveSearchRuntimeProfile(
    process.cwd(),
    {
      OPTSIDIAN_SEARCH_ANALYZER: 'intl',
      OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
      OPTSIDIAN_SEARCH_NGRAM: '0',
      OPTSIDIAN_SEARCH_PARTITION_BITS: '4',
      OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: 'local-onnx',
      OPTSIDIAN_SEARCH_EMBEDDING_MODEL: 'bge-m3',
      OPTSIDIAN_SEARCH_MODEL_DEVICE: 'auto',
      OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
      OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
      OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
      OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH: '16',
      OPTSIDIAN_SEARCH_INDEX_MICROBATCH: '128',
      OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE: '1024',
      OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT: '2',
      OPTSIDIAN_SEARCH_EXECUTION_CACHE_SNAPSHOTS: '2',
      OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: String(6 * 60 * 60 * 1000),
    },
    {},
  );
}

function profileVariant(profile, change) {
  const variant = structuredClone(profile);
  change(variant);
  return variant;
}

test('AC8 INDEX_BUILD_VERSION and ANALYZER_VERSION are byte-pinned for AC5 identity', () => {
  assert.equal(INDEX_BUILD_VERSION, PINNED_INDEX_BUILD_VERSION);
  assert.equal(ANALYZER_VERSION, PINNED_ANALYZER_VERSION);
});

test('AC8 runtime device policy and scheduling state stay out of lexical index identity', () => {
  const base = runtimeProfileFixture();
  const baseIdentity = lexicalIdentityHashForSearchRuntimeProfile(base);
  assert.equal(baseIdentity, PINNED_LEXICAL_RUNTIME_PROFILE_IDENTITY);

  const variants = {
    devicePolicyCpu: profileVariant(base, (profile) => {
      profile.embedding.devicePolicy = 'cpu';
    }),
    devicePolicyGpu: profileVariant(base, (profile) => {
      profile.embedding.devicePolicy = 'gpu';
    }),
    batchingAndWorkerScheduling: profileVariant(base, (profile) => {
      profile.workers.query = 3;
      profile.workers.index = 5;
      profile.workers.searchExecution = 7;
      profile.workers.analyzerMicrobatch = 2;
      profile.workers.indexMicrobatch = 17;
    }),
    runtimeCacheAndMemoryState: profileVariant(base, (profile) => {
      profile.cache.queryAnalysisEntries = 7;
      profile.cache.snapshotRetention = 9;
      profile.cache.executionSnapshots = 11;
      profile.memory.snapshotCountCap = 13;
      profile.memory.snapshotByteCap = 1_048_576;
      profile.memory.workerHeapGuardMb = 512;
      profile.memory.workerRssGuardMb = 768;
      profile.memory.workerRssGuardStrikes = 4;
    }),
    daemonRuntimeState: profileVariant(base, (profile) => {
      profile.daemon.idleMs = 1234;
    }),
  };

  for (const [label, variant] of Object.entries(variants)) {
    assert.equal(lexicalIdentityHashForSearchRuntimeProfile(variant), baseIdentity, label);
  }
});

test('AC5 schema digest identity changes from the pre-change baseline and stale identity auto-rebuilds', async () => {
  const { SEARCH_DB_SCHEMA, SEARCH_SCHEMA_DIGEST } = await import('../src/core/search/schema.ts');
  const { buildCanonicalSearchSnapshot, snapshotIdentityTupleForAnalyzerIdentity } =
    await import('../src/daemon/search-store/builder.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { canonicalValueBytes, canonicalSnapshotManifestBytes, snapshotIdFromManifest } =
    await import('../src/core/search/segments/canonical.ts');
  const { SNAPSHOT_PERSISTENCE_SCHEMA, SNAPSHOT_PERSISTENCE_SCHEMA_HASH } =
    await import('../src/daemon/search-store/types.ts');

  assert.equal(SEARCH_SCHEMA_DIGEST, sha256(JSON.stringify(SEARCH_DB_SCHEMA)));
  assert.equal(SNAPSHOT_PERSISTENCE_SCHEMA_HASH, sha256(canonicalValueBytes(SNAPSHOT_PERSISTENCE_SCHEMA)));
  assert.notEqual(SEARCH_SCHEMA_DIGEST, PRE_CHANGE_SCHEMA_DIGEST);

  assert.deepEqual(Object.keys(SEARCH_DB_SCHEMA).sort(), [
    'indexedPostings',
    'indexedTokenProperties',
    'persistedDocument',
    'segmentFieldTexts',
    'snippetCorpus',
  ]);
  assert.equal(SEARCH_DB_SCHEMA.persistedDocument.fields.includes('body'), false);
  assert.equal(
    SEARCH_DB_SCHEMA.persistedDocument.fields.some((field) => /Tokens$/.test(field)),
    false,
  );
  assert.ok(SEARCH_DB_SCHEMA.indexedPostings.fields.includes('body'));
  const tokenFields = Object.values(SEARCH_DB_SCHEMA.indexedTokenProperties).flat();
  assert.equal(tokenFields.length, 18);
  assert.ok(tokenFields.includes('bodyTokens'));
  assert.ok(tokenFields.includes('bodySurfaceTokens'));
  assert.ok(tokenFields.includes('bodyNgramTokens'));
  assert.equal(SEARCH_DB_SCHEMA.segmentFieldTexts.fields.includes('body'), false);
  assert.equal(SEARCH_DB_SCHEMA.snippetCorpus.name, 'single-snippet-corpus');
  assert.equal(typeof SEARCH_DB_SCHEMA.snippetCorpus.version, 'number');

  const analyzer = testAnalyzer();
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity(analyzer.identity, 1, SEARCH_SETTINGS);
  assert.equal(identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);
  assert.notEqual(identityTuple.fieldSetVersion, PRE_CHANGE_SCHEMA_DIGEST);

  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
    searchSettings: SEARCH_SETTINGS,
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
    },
  });

  const current = await store.loadVault(vault);
  assert.equal(current.vaults[0].status, 'ready');
  assert.equal(current.snapshotId, built.snapshotId);
  assert.equal(buildCount, 1);

  const paths = searchStoreCachePaths(vault, env);
  const currentEnvelopePath = path.join(paths.snapshotsDir, built.snapshotId);
  const currentEnvelope = JSON.parse(fs.readFileSync(currentEnvelopePath, 'utf8'));
  assert.equal(currentEnvelope.manifest.identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);

  const staleManifest = structuredClone(currentEnvelope.manifest);
  staleManifest.identityTuple = {
    ...staleManifest.identityTuple,
    fieldSetVersion: PRE_CHANGE_SCHEMA_DIGEST,
  };
  const staleSnapshotId = snapshotIdFromManifest(staleManifest);
  const staleCanonicalManifestSha256 = sha256(canonicalSnapshotManifestBytes(staleManifest));
  const staleEnvelope = {
    ...currentEnvelope,
    snapshotId: staleSnapshotId,
    manifest: staleManifest,
    canonicalManifestSha256: staleCanonicalManifestSha256,
  };
  persistJson(currentEnvelopePath, staleEnvelope);

  assert.equal(store.readSnapshotEnvelope(paths, built.snapshotId), undefined);
  assert.equal(store.snapshotIdentityMatches(paths, built.snapshotId), false);

  const repaired = await store.loadVault(vault);
  assert.equal(repaired.vaults[0].status, 'ready');
  assert.equal(repaired.snapshotId, built.snapshotId);
  assert.equal(buildCount, 2);
  const repairedActive = activeSnapshotFromEdition(paths);
  assert.equal(repairedActive.snapshotId, built.snapshotId);
});

test('AC5 snapshot envelope validator rejects old diagnostics.documents shape at the read boundary', async () => {
  const { SEARCH_SCHEMA_DIGEST } = await import('../src/core/search/schema.ts');
  const { createDaemonSnapshotStore } = await import('../src/daemon/search-store/snapshot-store.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { SNAPSHOT_PERSISTENCE_SCHEMA_HASH } = await import('../src/daemon/search-store/types.ts');

  const cacheRoot = tempRoot();
  const vault = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nproject alpha\n');
  const store = createDaemonSnapshotStore({
    env,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: SEARCH_SETTINGS,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
  });

  const loaded = await store.loadVault(vault);
  assert.equal(loaded.vaults[0].status, 'ready');

  const paths = searchStoreCachePaths(vault, env);
  const active = activeSnapshotFromEdition(paths);
  const envelopePath = path.join(paths.snapshotsDir, active.snapshotId);
  const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
  assert.equal(envelope.schemaHash, SNAPSHOT_PERSISTENCE_SCHEMA_HASH);
  assert.equal(envelope.diagnostics.schemaHash, SNAPSHOT_PERSISTENCE_SCHEMA_HASH);
  assert.equal('schemaVersion' in envelope, false);
  assert.equal('schemaVersion' in envelope.diagnostics, false);
  assert.equal(envelope.manifest.identityTuple.fieldSetVersion, SEARCH_SCHEMA_DIGEST);
  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId)?.snapshotId, active.snapshotId);
  for (const partition of envelope.manifest.partitions) {
    assert.equal(fs.existsSync(path.join(paths.segmentsDir, partition.segmentHash)), true);
  }

  const diagnosticsMarkerEnvelope = {
    ...envelope,
    diagnostics: {
      ...envelope.diagnostics,
      documents: envelope.documents,
    },
  };
  assert.equal(Array.isArray(diagnosticsMarkerEnvelope.documents), true);
  assert.equal(Array.isArray(diagnosticsMarkerEnvelope.diagnostics.documents), true);
  persistJson(envelopePath, diagnosticsMarkerEnvelope);
  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId), undefined);

  const oldShapeEnvelope = structuredClone(diagnosticsMarkerEnvelope);
  delete oldShapeEnvelope.documents;
  assert.equal('documents' in oldShapeEnvelope, false);
  assert.equal(Array.isArray(oldShapeEnvelope.diagnostics.documents), true);
  persistJson(envelopePath, oldShapeEnvelope);

  assert.equal(store.readSnapshotEnvelope(paths, active.snapshotId), undefined);
});
