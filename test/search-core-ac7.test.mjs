import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const textEncoder = new TextEncoder();

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function testAnalyzer(identity = { name: "test-analyzer", version: "1", node: "test" }) {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity,
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function tempRoot(prefix = "optsidian-search-ac7-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sharedHandle(bytes) {
  const shared = new SharedArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(shared);
  view.set(bytes);
  return {
    buffer: shared,
    byteOffset: 0,
    byteLength: bytes.byteLength
  };
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

function snapshotHandleForBuiltSnapshot(built, pinToken = "pin-ac7") {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(textEncoder.encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes)
    }))
  };
}

function queryAnalysis(raw) {
  const terms = raw.split(/\s+/u).filter(Boolean);
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

test("AC7 lambda_dense is a bitwise no-op with no embedding model", async () => {
  const { rerankScore } = await import(path.join(repoRoot, "src/core/search/ranking/score.ts"));
  const { SEARCH_SCORING_LAMBDAS } = await import(path.join(repoRoot, "src/core/search/constants.ts"));
  assert.equal(SEARCH_SCORING_LAMBDAS.dense, 0);

  const base = {
    lexicalScore: 12.25,
    proximityScore: 3,
    identityScore: 2,
    exactLambda: 5
  };
  const withDenseZero = rerankScore({ ...base, denseAgreement: 0 });
  const denseTermRemoved = rerankScore(base);
  const withDenseNaN = rerankScore({ ...base, denseAgreement: Number.NaN });
  const withDenseUndefined = rerankScore({ ...base, denseAgreement: undefined });

  assert.equal(Object.is(withDenseZero, denseTermRemoved), true);
  assert.equal(Object.is(withDenseNaN, denseTermRemoved), true);
  assert.equal(Object.is(withDenseUndefined, denseTermRemoved), true);
});

test("AC7 no-model identity keeps lexical results stable and stub embedding identity changes snapshot id", async () => {
  const { buildCanonicalSearchSnapshot, snapshotIdentityTupleForAnalyzerIdentity } = await import(
    path.join(repoRoot, "src/daemon/search-store/builder.ts")
  );
  const {
    CANONICAL_SEGMENT_SECTION,
    CANONICAL_VECTOR_BLOCK_SCHEMA_ID,
    buildCanonicalSnapshotForTests,
    canonicalSegmentSectionBytes,
    canonicalValueBytes,
    decodeCanonicalSegment
  } = await import(path.join(repoRoot, "src/core/search/segments/canonical.ts"));
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));

  const vault = tempRoot();
  writeVaultFile(vault, "Alpha Project.md", "# Alpha Project\n\nalpha project target\n");
  writeVaultFile(vault, "Beta Project.md", "# Beta Project\n\nalpha project target beta beta\n");
  writeVaultFile(vault, "Gamma.md", "# Gamma\n\nunrelated\n");
  const analyzer = testAnalyzer();

  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
  const rebuilt = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
  assert.equal(built.snapshotId, rebuilt.snapshotId);
  assert.equal(built.identityTuple.searchModelIdentity.embeddingModel, null);
  assert.equal(built.identityTuple.searchModelIdentity.scoringModel.retrieverIdentity.id, "positional-lexical");
  assert.equal(built.identityTuple.searchModelIdentity.scoringModel.retrieverIdentity.version, "3");
  assert.equal(built.identityTuple.searchModelIdentity.scoringModel.weights.lambdas.dense, 0);

  for (const segment of built.segments) {
    const vectorBytes = canonicalSegmentSectionBytes(segment.bytes, CANONICAL_SEGMENT_SECTION.vectorBlock);
    assert.ok(vectorBytes, "canonical segment must carry the reserved vectorBlock section");
    assert.deepEqual(decodeCanonicalSegment(segment.bytes).vectorBlock, {
      schemaId: CANONICAL_VECTOR_BLOCK_SCHEMA_ID,
      embeddingModel: null,
      vectorCount: 0
    });
  }

  const search = normalizeSearchParams({ query: "alpha project", limit: 3, debug: true });
  const firstResult = executeSearchJob({
    vault,
    search,
    analysis: queryAnalysis("alpha project"),
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandleForBuiltSnapshot(built, "pin-ac7-first")
  });
  const secondResult = executeSearchJob({
    vault,
    search,
    analysis: queryAnalysis("alpha project"),
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandleForBuiltSnapshot(rebuilt, "pin-ac7-second")
  });
  assert.deepEqual(firstResult.matches.map((match) => match.path), ["Alpha Project.md", "Beta Project.md"]);
  assert.deepEqual(
    secondResult.matches.map((match) => ({ path: match.path, score: match.debug?.rerankScore })),
    firstResult.matches.map((match) => ({ path: match.path, score: match.debug?.rerankScore }))
  );
  assert.ok(firstResult.matches.every((match) => match.debug?.denseAgreement === 0));

  const noModelTuple = snapshotIdentityTupleForAnalyzerIdentity(analyzer.identity, 1);
  const stubEmbeddingIdentity = {
    id: "stub-bge-m3",
    sha256: "f".repeat(64),
    opset: "onnx-opset-17",
    quantization: "none",
    dim: 1024,
    pooling: "cls"
  };
  const stubTuple = snapshotIdentityTupleForAnalyzerIdentity(
    { ...analyzer.identity, embeddingModel: stubEmbeddingIdentity },
    1
  );
  assert.equal(noModelTuple.searchModelIdentity.embeddingModel, null);
  assert.deepEqual(stubTuple.searchModelIdentity.embeddingModel, stubEmbeddingIdentity);
  assert.notEqual(sha256(canonicalValueBytes(noModelTuple)), sha256(canonicalValueBytes(stubTuple)));

  const documents = [
    { path: "Alpha Project.md", content: "# Alpha Project\n\nalpha project target\n" },
    { path: "Beta Project.md", content: "# Beta Project\n\nalpha project target beta beta\n" }
  ];
  const noModelSnapshot = buildCanonicalSnapshotForTests({ identityTuple: noModelTuple, documents });
  const stubModelSnapshot = buildCanonicalSnapshotForTests({ identityTuple: stubTuple, documents });
  assert.notEqual(noModelSnapshot.snapshotId, stubModelSnapshot.snapshotId);
});
