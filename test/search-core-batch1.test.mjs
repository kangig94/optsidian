import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  canonicalSegmentHash,
  decodeCanonicalSegment,
  encodeCanonicalSegment,
  encodeFloat64Canonical
} from "../src/core/search/segments/canonical.ts";
import {
  bm25TermScore,
  computeFieldBm25Stats,
  fieldChannelBm25Boost,
  tokenChannelFusionWeight
} from "../src/core/search/retrieval/positional/bm25.ts";
import {
  buildPositionalPostings,
  findPhraseMatches,
  positionsForTerm
} from "../src/core/search/retrieval/positional/postings.ts";
import {
  findProximityMatches,
  minimumTermWindow,
  proximityScore
} from "../src/core/search/retrieval/positional/proximity.ts";
import { POSITIONAL_FIELD_ID } from "../src/core/search/retrieval/positional/types.ts";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("canonical segment codec round-trips to byte-identical canonical bytes", () => {
  const logicalSegment = {
    postings: [
      { term: "beta", fieldId: 0, docId: 2, positions: [3, 1] },
      { term: "alpha", fieldId: 1, docId: 1, positions: [0, 4] },
      { term: "beta", fieldId: 0, docId: 2, positions: [5] }
    ],
    documents: [
      {
        documentId: "b".repeat(64),
        path: "Folder/../Beta.md",
        contentHash: "2".repeat(64),
        parsedFieldHashes: { body: "3".repeat(64), title: "4".repeat(64) },
        snippetLineSpanHash: "5".repeat(64)
      },
      {
        documentId: "a".repeat(64),
        path: "Alpha.md",
        contentHash: "1".repeat(64),
        parsedFieldHashes: { title: "6".repeat(64) }
      }
    ],
    fieldTexts: [
      { docId: 2, fieldId: 0, text: "Beta" },
      { docId: 1, fieldId: 0, text: "Alpha" }
    ]
  };

  const bytes = encodeCanonicalSegment(logicalSegment);
  const decoded = decodeCanonicalSegment(bytes);
  const reencoded = encodeCanonicalSegment(decoded);

  assert.deepEqual(Buffer.from(reencoded), Buffer.from(bytes));
  assert.deepEqual(decoded.postings.map((posting) => [posting.term, posting.fieldId, posting.docId, posting.positions]), [
    ["alpha", 1, 1, [0, 4]],
    ["beta", 0, 2, [1, 3, 5]]
  ]);
  assert.equal(decoded.fieldTexts?.some((fieldText) => fieldText.fieldId === POSITIONAL_FIELD_ID.body), false);
});

test("canonical segment content hash is deterministic for identical logical content", () => {
  const left = {
    postings: [
      { term: "gamma", fieldId: 3, docId: 2, positions: [8] },
      { term: "alpha", fieldId: 0, docId: 1, positions: [0, 2] }
    ],
    fieldTexts: [{ docId: 1, fieldId: 0, text: "Alpha" }]
  };
  const right = {
    fieldTexts: [{ docId: 1, fieldId: 0, text: "Alpha" }],
    postings: [
      { term: "alpha", fieldId: 0, docId: 1, positions: [2, 0] },
      { term: "gamma", fieldId: 3, docId: 2, positions: [8] }
    ]
  };
  const changed = {
    ...right,
    postings: [
      { term: "alpha", fieldId: 0, docId: 1, positions: [2, 0] },
      { term: "gamma", fieldId: 3, docId: 2, positions: [9] }
    ]
  };

  const leftBytes = encodeCanonicalSegment(left);
  const rightBytes = encodeCanonicalSegment(right);
  assert.deepEqual(Buffer.from(leftBytes), Buffer.from(rightBytes));
  assert.equal(canonicalSegmentHash(left), canonicalSegmentHash(right));
  assert.equal(canonicalSegmentHash(leftBytes), sha256(leftBytes));
  assert.notEqual(canonicalSegmentHash(right), canonicalSegmentHash(changed));
  assert.deepEqual(Buffer.from(encodeFloat64Canonical(-0)), Buffer.from(encodeFloat64Canonical(0)));
  assert.throws(() => encodeFloat64Canonical(Number.NaN), /finite/);
});

test("positional phrase matching requires consecutive positions", () => {
  const body = POSITIONAL_FIELD_ID.body;
  const title = POSITIONAL_FIELD_ID.title;
  const postings = buildPositionalPostings([
    {
      docId: 7,
      fields: [
        { fieldId: body, tokens: ["alpha", "beta", "gamma", "delta", "alpha", "gamma"] },
        { fieldId: title, tokens: ["alpha", "delta"] }
      ]
    },
    {
      docId: 8,
      fields: [{ fieldId: body, tokens: ["alpha", "delta", "beta"] }]
    }
  ]);

  assert.deepEqual(positionsForTerm(postings, "alpha", 7, body), [0, 4]);
  assert.deepEqual(findPhraseMatches(postings, ["alpha", "beta"]), [
    { docId: 7, fieldId: body, starts: [0] }
  ]);
  assert.deepEqual(findPhraseMatches(postings, ["beta", "delta"]), []);
  assert.deepEqual(findPhraseMatches(postings, ["alpha", "delta"], { fieldIds: [title] }), [
    { docId: 7, fieldId: title, starts: [0] }
  ]);
});

test("positional proximity uses the minimum covering window and window-k filtering", () => {
  const body = POSITIONAL_FIELD_ID.body;
  const postings = buildPositionalPostings([
    {
      docId: 7,
      fields: [{ fieldId: body, tokens: ["alpha", "beta", "gamma", "delta", "alpha", "gamma"] }]
    }
  ]);

  assert.deepEqual(minimumTermWindow([[0, 4], [2, 5]]), { lo: 4, hi: 5, width: 2 });
  assert.equal(proximityScore([[1], [3]]), 2 / 3);
  assert.deepEqual(findProximityMatches(postings, ["alpha", "gamma"], { maxWindow: 2 }), [
    { docId: 7, fieldId: body, score: 1, window: { lo: 4, hi: 5, width: 2 } }
  ]);
  assert.deepEqual(findProximityMatches(postings, ["beta", "delta"], { maxWindow: 2 }), []);
  assert.deepEqual(findProximityMatches(postings, ["beta", "delta"], { maxWindow: 3 }), [
    { docId: 7, fieldId: body, score: 2 / 3, window: { lo: 1, hi: 3, width: 3 } }
  ]);
});

test("BM25 computes per-field statistics and keeps channel boost separate from fusion weight", () => {
  const title = POSITIONAL_FIELD_ID.title;
  const stats = computeFieldBm25Stats([
    { docId: 1, fields: [{ field: "title", tokens: ["alpha", "alpha", "beta"] }] },
    { docId: 2, fields: [{ field: "title", tokens: ["beta"] }] }
  ]);
  const titleStats = stats.fields.get(title);

  assert.equal(titleStats.documentCount, 2);
  assert.equal(titleStats.documentLengths.get(1), 3);
  assert.equal(titleStats.documentLengths.get(2), 1);
  assert.equal(titleStats.averageFieldLength, 2);
  assert.equal(titleStats.documentFrequency.get("alpha"), 1);
  assert.equal(titleStats.documentFrequency.get("beta"), 2);

  const expectedIdf = Math.log((2 - 1 + 0.5) / (1 + 0.5) + 1);
  const expectedTf = 2 / 3;
  const expectedScore = (expectedIdf * (0.5 + expectedTf * (1.2 + 1))) /
    (expectedTf + 1.2 * (1 - 0.75 + 0.75 * (3 / 2)));
  assert.ok(Math.abs(bm25TermScore(stats, "alpha", 1, title) - expectedScore) < 1e-12);
  assert.equal(bm25TermScore(stats, "alpha", 2, title), 0);
  assert.equal(fieldChannelBm25Boost("surface", "title"), 6);
  assert.equal(tokenChannelFusionWeight("surface"), 0.65);
});
