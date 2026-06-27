import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCanonicalSegment,
  encodeCanonicalSegment
} from "../src/core/search/segments/canonical.ts";
import { ProjectionReader } from "../src/core/search/retrieval/positional/segment-projection-reader.ts";
import { POSITIONAL_FIELD_ID } from "../src/core/search/retrieval/positional/types.ts";

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
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.path, text: "Projects/Alpha Project.md" },
      { docId: 1, fieldId: POSITIONAL_FIELD_ID.body, text: "alpha body" }
    ],
    bm25: [{
      channel: "morph",
      fieldId: POSITIONAL_FIELD_ID.title,
      documentCount: 1,
      totalFieldLength: 2,
      documentLengths: [{ docId: 1, length: 2 }],
      documentFrequencies: [{ term: "alpha", frequency: 1 }]
    }]
  });

  const decoded = decodeCanonicalSegment(bytes);
  assert.equal(decoded.documents?.length, 1);

  const projection = new ProjectionReader(bytes);
  assert.equal(projection.documentCount(), 1);
  assert.deepEqual(projection.doc(1), {
    localDocId: 1,
    documentId: "a".repeat(64),
    path: "Projects/Alpha Project.md"
  });
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
});
