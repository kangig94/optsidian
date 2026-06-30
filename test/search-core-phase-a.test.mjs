import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeterministicEmbeddingSetBuilder } from "./helpers/deterministic-embedding.mjs";

const repoRoot = process.cwd();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity: { name: "test-analyzer", version: "1", node: "test" },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function tempRoot(prefix = "optsidian-search-phase-a-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer, byteOffset: 0, byteLength: bytes.byteLength };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      ...entry,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3]
    })),
    hash: manifest.bm25GlobalStatsHash
  };
}

function snapshotHandle(built, pinToken = "pin-phase-a") {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(textEncoder.encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes)
    }))
  };
}

function rankSignal(overrides = {}) {
  return {
    exactPriority: Number.POSITIVE_INFINITY,
    phrasePriority: Number.POSITIVE_INFINITY,
    coverageTerms: 0,
    coverageFieldScore: 0,
    lexicalScore: 0,
    identityScore: 0,
    exactLambda: 0,
    denseAgreement: 0,
    rarityScore: 0,
    proximityScore: 0,
    bodyScore: 0,
    ...overrides
  };
}

function assertNoTokenKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/Tokens$/.test(key), false, `persisted record must not expose token field ${key}`);
    assertNoTokenKeys(child);
  }
}

function bytesFromSharedHandle(handle) {
  return new Uint8Array(handle.buffer, handle.byteOffset, handle.byteLength);
}

function textFromSharedHandle(handle) {
  return textDecoder.decode(bytesFromSharedHandle(handle));
}

function assertNoPersistedRecordForbiddenKeys(serialized, label) {
  assert.doesNotMatch(serialized, /"searchDocument"\s*:/u, `${label} must not contain searchDocument`);
  assert.doesNotMatch(serialized, /"body"\s*:/u, `${label} must not contain a document-level body key`);
  assert.doesNotMatch(serialized, /"[^"]*Tokens"\s*:/u, `${label} must not contain token fields`);
  assert.doesNotMatch(serialized, /\[document\.body\]/u, `${label} must not contain the old [document.body] field-text marker`);
}

function assertNoPlaintextOutsideSnippetText(value, phrases, label, pathParts = []) {
  if (typeof value === "string") {
    const isSnippetText =
      pathParts[pathParts.length - 1] === "text" &&
      pathParts.includes("snippetCorpus") &&
      pathParts.includes("lines");
    if (!isSnippetText) {
      for (const phrase of phrases) {
        assert.equal(value.includes(phrase), false, `${label} leaked ${JSON.stringify(phrase)} at ${pathParts.join(".")}`);
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPlaintextOutsideSnippetText(child, phrases, label, [...pathParts, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoPlaintextOutsideSnippetText(child, phrases, label, [...pathParts, key]);
  }
}

function countSubstring(value, needle) {
  return value.split(needle).length - 1;
}

function snippetTextOccurrenceCount(records, needle) {
  return records.reduce((sum, record) =>
    sum + (record.snippetCorpus?.lines ?? []).reduce(
      (lineSum, line) => lineSum + (typeof line.text === "string" && line.text.includes(needle) ? 1 : 0),
      0
    ),
  0);
}

function assertPersistedRecordsArePrivate(records, serialized, phrases, label) {
  assertNoPersistedRecordForbiddenKeys(serialized, label);
  for (const record of records) {
    assert.equal("searchDocument" in record, false, `${label} must not expose searchDocument`);
    assert.equal("body" in record, false, `${label} must not expose document-level body`);
    assertNoTokenKeys(record);
  }
  assertNoPlaintextOutsideSnippetText(records, phrases, label);
  for (const phrase of phrases) {
    assert.equal(
      countSubstring(serialized, phrase),
      snippetTextOccurrenceCount(records, phrase),
      `${label} may store ${JSON.stringify(phrase)} only in snippetCorpus.lines[].text`
    );
  }
}

test("AC1 persisted document records serialize without SearchDocument body or token fields", async () => {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const { SEARCH_DB_SCHEMA } = await import(path.join(repoRoot, "src/core/search/schema.ts"));
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "---\ntags: [phase-a]\n---\n# Alpha\n\nAlpha body text.\n");

  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: testAnalyzer(), partitionBits: 1 });
  const [record] = JSON.parse(JSON.stringify(built.documents));

  assert.equal("searchDocument" in record, false);
  assert.equal("body" in record, false);
  assert.deepEqual(Object.keys(record).sort(), [
    "contentHash",
    "documentId",
    "partitionId",
    "path",
    "snippetCorpus",
    "tags",
    "title"
  ]);
  assertNoTokenKeys(record);
  assert.equal(typeof record.snippetCorpus.bodyStartLine, "number");
  assert.ok(record.snippetCorpus.lines.some((line) => typeof line.text === "string"));
  assert.equal(record.snippetCorpus.fallback.kind, "line");
  assert.equal(SEARCH_DB_SCHEMA.persistedDocument.fields.includes("body"), false);
  assert.equal(SEARCH_DB_SCHEMA.persistedDocument.fields.some((field) => /Tokens$/.test(field)), false);
  assert.ok(SEARCH_DB_SCHEMA.indexedPostings.fields.includes("body"));
  assert.equal(SEARCH_DB_SCHEMA.segmentFieldTexts.fields.includes("body"), false);
  assert.equal(SEARCH_DB_SCHEMA.snippetCorpus.name, "single-snippet-corpus");
});

test("AC7 persisted worker bytes and decoded segments carry no plaintext body copies", async () => {
  const { createDaemonSnapshotStore } = await import(path.join(repoRoot, "src/daemon/search-store/snapshot-store.ts"));
  const { searchStoreCachePaths } = await import(path.join(repoRoot, "src/daemon/search-store/cache-paths.ts"));
  const { decodeCanonicalSegment } = await import(path.join(repoRoot, "src/core/search/segments/canonical.ts"));
  const { POSITIONAL_FIELD_ID } = await import(path.join(repoRoot, "src/core/search/retrieval/positional/types.ts"));
  const cacheRoot = tempRoot("optsidian-search-phase-a-cache-");
  const vault = tempRoot("optsidian-search-phase-a-vault-");
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const phrases = [
    "private body alpha phrase",
    "private body beta phrase"
  ];
  writeVaultFile(vault, "Privacy.md", [
    "---",
    "tags: [privacy]",
    "---",
    "# Privacy Title",
    "",
    phrases[0],
    phrases[1]
  ].join("\n"));

  const store = createDaemonSnapshotStore({
    env,
    analyzer: testAnalyzer(),
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder()
  });
  await store.loadVault(vault);
  const pin = await store.pin(vault);
  const handle = store.snapshotHandleForPin(pin);
  const workerDocumentJson = textFromSharedHandle(handle.documents);
  const workerDocuments = JSON.parse(workerDocumentJson);
  assert.ok(workerDocuments[0].snippetCorpus.lines.some((line) => phrases.includes(line.text)));
  assertPersistedRecordsArePrivate(workerDocuments, workerDocumentJson, phrases, "worker document bytes");

  const paths = searchStoreCachePaths(vault, env);
  const envelopeJson = fs.readFileSync(path.join(paths.snapshotsDir, pin.snapshotId), "utf8");
  const envelope = JSON.parse(envelopeJson);
  assert.equal("documents" in envelope, true);
  assert.equal("documents" in envelope.diagnostics, false);
  assertPersistedRecordsArePrivate(envelope.documents, JSON.stringify(envelope.documents), phrases, "on-disk envelope documents");

  for (const segment of handle.segments) {
    const decoded = decodeCanonicalSegment(bytesFromSharedHandle(segment.bytes));
    assert.doesNotMatch(
      JSON.stringify(decoded),
      /\[document\.body\]/u,
      "decoded segment must not contain the old [document.body] field-text marker"
    );
    for (const document of decoded.documents ?? []) {
      assert.equal("searchDocument" in document, false, "decoded segment document must not expose searchDocument");
      assert.equal("body" in document, false, "decoded segment document must not expose document-level body");
      assertNoTokenKeys(document);
    }
    assert.equal(decoded.fieldTexts?.some((fieldText) => fieldText.fieldId === POSITIONAL_FIELD_ID.body), false);
    assertNoPlaintextOutsideSnippetText(decoded, phrases, "decoded segment");
    assert.ok(decoded.postings.some((posting) => posting.fieldId === POSITIONAL_FIELD_ID.body));
    const bodyStats = decoded.bm25?.find((stats) => stats.fieldId === POSITIONAL_FIELD_ID.body);
    assert.ok(bodyStats);
    assert.ok(bodyStats.totalFieldLength > 0);
  }
});

test("AC6 reranking requires complete documentId-keyed rank signals", async () => {
  const { rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/score.ts"));
  const document = { id: "doc-alpha", path: "Alpha.md", title: "Alpha", tags: [] };
  const hit = { document, score: 99, queryChannels: { morph: ["alpha"], surface: [], ngram: [] } };
  const complete = rankSignal({ lexicalScore: 7 });

  assert.throws(
    () => rerankCandidatesWithSignals("alpha", ["alpha"], [hit], undefined, new Map()),
    /missing rank signals/
  );
  assert.throws(
    () => rerankCandidatesWithSignals("alpha", ["alpha"], [hit], undefined, new Map([["Alpha.md", complete]])),
    /missing rank signals/
  );
  assert.throws(
    () => rerankCandidatesWithSignals("alpha", ["alpha"], [hit], undefined, new Map([["doc-alpha", { ...complete, lexicalScore: undefined }]])),
    /lexicalScore/
  );

  const ranked = rerankCandidatesWithSignals("alpha", ["alpha"], [hit], undefined, new Map([["doc-alpha", complete]]));
  assert.equal(ranked[0].path, "Alpha.md");
  assert.equal(ranked[0].score, 7);
});

test("AC6 metadata-only tag search reads trimmed persisted title and tags", async () => {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "---\ntitle: Alpha Title\ntags: [phase-a, keep]\n---\n# Alpha\n\nalpha body\n");
  writeVaultFile(vault, "Beta.md", "---\ntitle: Beta Title\ntags: [skip]\n---\n# Beta\n\nbeta body\n");
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ tags: ["phase-a"], limit: 10 }),
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built)
  });

  assert.deepEqual(result.matches.map((match) => ({
    path: match.path,
    title: match.title,
    tags: match.tags
  })), [
    { path: "Alpha.md", title: "Alpha Title", tags: ["phase-a", "keep"] }
  ]);
});

test("AC6 body phrase matches keep phrase priority without persisted full body text", async () => {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const vault = tempRoot();
  const phrase = "alpha beta gamma";
  writeVaultFile(vault, "StrongBody.md", `# Strong\n\n${phrase}\n`);
  writeVaultFile(vault, "WeakTitle.md", "# Alpha\n\nno exact phrase here\n");
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: phrase, limit: 10, debug: true }),
    analysis: {
      raw: phrase,
      primaryChannel: "morph",
      primaryTerms: ["alpha", "beta", "gamma"],
      channels: {
        morph: ["alpha", "beta", "gamma"],
        surface: ["alpha", "beta", "gamma"],
        ngram: []
      }
    },
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built)
  });

  const strongBody = result.matches.find((match) => match.path === "StrongBody.md");
  assert.ok(strongBody);
  assert.equal(strongBody.debug?.bucket, "phrase");
  assert.equal(strongBody.debug?.phrasePriority, 5);
});
