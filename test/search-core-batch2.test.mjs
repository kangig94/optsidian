import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCanonicalSearchSnapshot } from "../src/daemon/search-store/builder.ts";
import {
  decodeCanonicalSegment,
  encodeCanonicalSegment
} from "../src/core/search/segments/canonical.ts";
import { createPositionalRetriever } from "../src/core/search/retrieval/positional/index.ts";
import { ProjectionReader } from "../src/core/search/retrieval/positional/segment-projection-reader.ts";
import { POSITIONAL_FIELD_ID } from "../src/core/search/retrieval/positional/types.ts";

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
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

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-search-ac3-"));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("AC3 docProjection reader exposes shard-local identity, tags, lengths, and offsets", () => {
  const bytes = encodeCanonicalSegment({
    postings: [],
    documents: [
      {
        documentId: "a".repeat(64),
        path: "Projects/Alpha Project.md",
        contentHash: "1".repeat(64),
        parsedFieldHashes: { title: "2".repeat(64) }
      }
    ],
    fieldTexts: [
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.title, text: "Alpha Project" },
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.aliases, text: "Project Alpha\nAP" },
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.tags, text: "Focus\nSearch" },
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.headings, text: "Implementation Notes" },
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.path, text: "Projects/Alpha Project.md" }
    ],
    bm25: [
      {
        channel: "morph",
        fieldId: POSITIONAL_FIELD_ID.title,
        documentCount: 1,
        totalFieldLength: 2,
        documentLengths: [{ docId: 1, length: 2 }],
        documentFrequencies: [{ term: "alpha", frequency: 1 }]
      },
      {
        channel: "morph",
        fieldId: POSITIONAL_FIELD_ID.body,
        documentCount: 1,
        totalFieldLength: 2,
        documentLengths: [{ docId: 1, length: 2 }],
        documentFrequencies: [{ term: "body", frequency: 1 }]
      }
    ]
  });

  const decoded = decodeCanonicalSegment(bytes);
  assert.equal(decoded.documents?.length, 1);
  assert.equal(decoded.fieldTexts?.some((entry) => entry.fieldId === POSITIONAL_FIELD_ID.body), false);

  const projection = new ProjectionReader(bytes);
  const trustedProjection = new ProjectionReader(bytes, { validate: false });
  assert.equal(projection.documentCount(), 1);
  assert.equal(trustedProjection.documentCount(), 1);
  assert.deepEqual(projection.doc(1), {
    localDocId: 1,
    documentId: "a".repeat(64),
    path: "Projects/Alpha Project.md"
  });
  assert.deepEqual(trustedProjection.doc(1), projection.doc(1));
  assert.deepEqual(projection.identityKeys(1).title, ["alpha project"]);
  assert.ok(projection.identityKeys(1).aliases.includes("project alpha"));
  assert.equal(projection.identityKeys(1).filenameStem, "alpha project");

  const focusTag = projection.tagIdForTag("focus");
  assert.equal(typeof focusTag, "number");
  assert.ok(projection.tagIds(1).includes(focusTag));
  assert.equal(projection.tagForId(focusTag), "focus");

  assert.equal(projection.fieldLength(1, "morph", POSITIONAL_FIELD_ID.title), 2);
  const offsets = projection.offsets(1, "morph", POSITIONAL_FIELD_ID.title);
  assert.equal(offsets.length, 1);
  assert.ok(offsets[0].fieldTextByteLength > 0);

  assert.equal(projection.fieldLength(1, "morph", POSITIONAL_FIELD_ID.body), 2);
  const bodyOffsets = projection.offsets(1, "morph", POSITIONAL_FIELD_ID.body);
  assert.equal(bodyOffsets.length, 1);
  assert.equal(bodyOffsets[0].fieldTextOffset, 0);
  assert.equal(bodyOffsets[0].fieldTextByteLength, 0);
});

test("AC3 canonical segment rejects body field text rows", () => {
  assert.throws(
    () => encodeCanonicalSegment({
      postings: [],
      fieldTexts: [{ docId: 1, fieldId: POSITIONAL_FIELD_ID.body, text: "alpha body" }]
    }),
    /body field text/
  );
});

test("AC3 freshly built segment omits body field text while preserving body index data", async () => {
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha body target\n");

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1
  });
  const decoded = decodeCanonicalSegment(built.segments[0].bytes);
  const bodyFieldId = POSITIONAL_FIELD_ID.body;

  assert.equal(decoded.fieldTexts?.some((entry) => entry.fieldId === bodyFieldId), false);
  assert.ok(decoded.postings.some((posting) => posting.fieldId === bodyFieldId && posting.positions.length > 0));

  const bodyStats = decoded.bm25?.find((entry) => entry.channel === "morph" && entry.fieldId === bodyFieldId);
  assert.ok(bodyStats);
  assert.equal(bodyStats.documentCount, 1);
  assert.ok(bodyStats.totalFieldLength > 0);
  assert.equal(bodyStats.documentLengths.length, 1);
  assert.ok(bodyStats.documentLengths[0].length > 0);

  const projection = new ProjectionReader(built.segments[0].bytes);
  assert.ok(projection.fieldLength(1, "morph", bodyFieldId) > 0);
  const bodyOffsets = projection.offsets(1, "morph", bodyFieldId);
  assert.equal(bodyOffsets.length, 1);
  assert.equal(bodyOffsets[0].fieldTextOffset, 0);
  assert.equal(bodyOffsets[0].fieldTextByteLength, 0);
});

test("positional retriever reuses postings decode only within one retrieve call", () => {
  const calls = new Map();
  const postingsByTerm = new Map([
    ["morph\u0000alpha", [{ term: "morph\u0000alpha", fieldId: POSITIONAL_FIELD_ID.title, docId: 1, positions: [1] }]],
    ["morph\u0000beta", [{ term: "morph\u0000beta", fieldId: POSITIONAL_FIELD_ID.title, docId: 1, positions: [2] }]]
  ]);
  const segment = {
    segmentId: "segment-1",
    partitionId: 1,
    bytes: new Uint8Array(),
    postings: {
      postingsForTerm(term) {
        calls.set(term, (calls.get(term) ?? 0) + 1);
        return postingsByTerm.get(term) ?? [];
      }
    },
    projection: {
      documentCount: () => 1,
      doc: () => ({ localDocId: 1, documentId: "doc-a", path: "Alpha.md" }),
      fieldLength: () => 2
    }
  };
  const snapshot = {
    snapshotId: "snapshot-query-scoped-postings",
    documentCount: 1,
    segments: [segment],
    bm25Stats: {
      schemaId: 1,
      corpusStats: [{ channel: "morph", fieldId: POSITIONAL_FIELD_ID.title, documentCount: 1, totalFieldLength: 2, averageFieldLength: 2 }],
      rows: [
        { channel: "morph", fieldId: POSITIONAL_FIELD_ID.title, term: "alpha", documentFrequency: 1 },
        { channel: "morph", fieldId: POSITIONAL_FIELD_ID.title, term: "beta", documentFrequency: 1 }
      ],
      hash: "bm25"
    }
  };

  const candidateSet = createPositionalRetriever(snapshot).retrieve({
    rawQuery: "alpha beta",
    analysis: {
      raw: "alpha beta",
      primaryChannel: "morph",
      primaryTerms: ["alpha", "beta"],
      channels: { morph: ["alpha", "beta"], surface: [], ngram: [] }
    },
    limit: 10,
    snapshotId: snapshot.snapshotId
  });

  assert.equal(candidateSet.candidates.length, 1);
  assert.equal(calls.get("morph\u0000alpha"), 1);
  assert.equal(calls.get("morph\u0000beta"), 1);

  createPositionalRetriever(snapshot).retrieve({
    rawQuery: "alpha beta",
    analysis: {
      raw: "alpha beta",
      primaryChannel: "morph",
      primaryTerms: ["alpha", "beta"],
      channels: { morph: ["alpha", "beta"], surface: [], ngram: [] }
    },
    limit: 10,
    snapshotId: snapshot.snapshotId
  });
  assert.equal(calls.get("morph\u0000alpha"), 2);
  assert.equal(calls.get("morph\u0000beta"), 2);
});
