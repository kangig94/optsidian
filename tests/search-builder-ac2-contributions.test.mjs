import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contributionsFromSegment, foldSegment, reduceBuildSegment } from '../src/daemon/search-store/builder.ts';
import { canonicalValueBytes, decodeCanonicalSegment } from '../src/core/search/segments/index.ts';
import { SEARCH_PROPERTIES } from '../src/core/search/schema.ts';
import { SEARCH_TOKEN_CHANNELS } from '../src/core/search/analysis/index.ts';
import { POSITIONAL_FIELD_ID } from '../src/core/search/retrieval/positional/index.ts';

const textEncoder = new TextEncoder();

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function utf8(value) {
  return textEncoder.encode(value.normalize('NFC'));
}

function docRecord(relPath, content, suffix = '') {
  const normalizedPath = relPath.normalize('NFC');
  return {
    documentId: sha256(utf8(normalizedPath)),
    path: normalizedPath,
    contentHash: sha256(utf8(content)),
    parsedFieldHashes: Object.fromEntries(
      SEARCH_PROPERTIES.map((field) => [field, sha256(utf8(`${field}:${normalizedPath}:${content}:${suffix}`))]),
    ),
    snippetLineSpanHash: sha256(utf8(`lines:${normalizedPath}:${content}:${suffix}`)),
    deleted: false,
  };
}

function fieldLengths(overrides = {}) {
  return SEARCH_TOKEN_CHANNELS.flatMap((channel) =>
    SEARCH_PROPERTIES.map((field) => ({
      channel,
      fieldId: POSITIONAL_FIELD_ID[field],
      length: overrides[`${channel}\u0000${field}`] ?? 0,
    })),
  );
}

function fieldTexts(values) {
  return ['title', 'aliases', 'tags', 'headings', 'path'].map((field) => ({
    fieldId: POSITIONAL_FIELD_ID[field],
    text: values[field] ?? '',
  }));
}

function contribution(relPath, content, values, postings, lengths, suffix = '') {
  const document = docRecord(relPath, content, suffix);
  return {
    documentId: document.documentId,
    document,
    postings,
    fieldLengths: fieldLengths(lengths),
    fieldTexts: fieldTexts({ ...values, path: relPath }),
  };
}

function fixtureContributions() {
  return [
    [
      1,
      [
        contribution(
          'Alpha.md',
          'Alpha body ㎏',
          {
            title: 'Alpha ㎏',
            aliases: 'First\nA',
            tags: 'shared\nzero',
            headings: 'Intro',
          },
          [
            { term: 'morph\u0000alpha', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
            { term: 'morph\u0000body', fieldId: POSITIONAL_FIELD_ID.body, positions: [0, 2] },
            { term: 'surface\u0000Alpha', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
            { term: 'ngram\u0000al', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
          ],
          {
            'morph\u0000title': 1,
            'morph\u0000body': 3,
            'surface\u0000title': 1,
            'ngram\u0000title': 2,
          },
          'a',
        ),
        contribution(
          'Cafe\u0301/Beta.md',
          'Beta body',
          {
            title: 'Beta',
            aliases: '',
            tags: 'shared',
            headings: 'Café',
          },
          [
            { term: 'morph\u0000beta', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
            { term: 'morph\u0000body', fieldId: POSITIONAL_FIELD_ID.body, positions: [1] },
            { term: 'surface\u0000Beta', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
            { term: 'ngram\u0000be', fieldId: POSITIONAL_FIELD_ID.title, positions: [0] },
          ],
          {
            'morph\u0000title': 1,
            'morph\u0000body': 2,
            'surface\u0000title': 1,
            'ngram\u0000title': 2,
          },
          'b',
        ),
      ],
    ],
    [
      7,
      [
        contribution(
          'Gamma.md',
          '',
          {
            title: '',
            aliases: '',
            tags: '',
            headings: '',
          },
          [
            { term: 'morph\u0000gamma', fieldId: POSITIONAL_FIELD_ID.path, positions: [0] },
            { term: 'surface\u0000Gamma.md', fieldId: POSITIONAL_FIELD_ID.path, positions: [0] },
            { term: 'ngram\u0000ga', fieldId: POSITIONAL_FIELD_ID.path, positions: [0] },
          ],
          {
            'morph\u0000path': 1,
            'surface\u0000path': 1,
            'ngram\u0000path': 2,
          },
          'c',
        ),
      ],
    ],
  ];
}

function canonicalBytes(value) {
  return Buffer.from(canonicalValueBytes(value));
}

function assertCanonicalEqual(actual, expected, label) {
  assert.equal(Buffer.compare(canonicalBytes(actual), canonicalBytes(expected)), 0, label);
}

function postingsFromContributions(contributions) {
  return sortedContributions(contributions)
    .flatMap((contribution, index) =>
      contribution.postings.map((posting) => ({
        term: posting.term,
        fieldId: posting.fieldId,
        docId: index + 1,
        positions: [...posting.positions],
      })),
    )
    .sort(comparePostings);
}

function fieldTextsFromContributions(contributions) {
  return sortedContributions(contributions)
    .flatMap((contribution, index) =>
      contribution.fieldTexts.map((fieldText) => ({
        docId: index + 1,
        fieldId: fieldText.fieldId,
        text: fieldText.text,
      })),
    )
    .sort((left, right) => left.docId - right.docId || left.fieldId - right.fieldId);
}

function documentsFromContributions(contributions) {
  return sortedContributions(contributions).map((contribution) => contribution.document);
}

function fieldLengthsFromContributions(contributions) {
  return sortedContributions(contributions)
    .flatMap((contribution, index) =>
      contribution.fieldLengths.map((fieldLength) => ({
        docId: index + 1,
        channel: fieldLength.channel,
        fieldId: fieldLength.fieldId,
        length: fieldLength.length,
      })),
    )
    .sort(compareFieldLengths);
}

function fieldLengthsFromBm25(segment) {
  return (segment.bm25 ?? [])
    .flatMap((field) =>
      field.documentLengths.map((entry) => ({
        docId: entry.docId,
        channel: field.channel,
        fieldId: field.fieldId,
        length: entry.length,
      })),
    )
    .sort(compareFieldLengths);
}

function sortedContributions(contributions) {
  return [...contributions].sort((left, right) => Buffer.compare(utf8(left.documentId), utf8(right.documentId)));
}

function comparePostings(left, right) {
  return Buffer.compare(utf8(left.term), utf8(right.term)) || left.fieldId - right.fieldId || left.docId - right.docId;
}

function compareFieldLengths(left, right) {
  return (
    left.docId - right.docId || Buffer.compare(utf8(left.channel), utf8(right.channel)) || left.fieldId - right.fieldId
  );
}

function tempRoot(prefix = 'optsidian-search-ac2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('AC2 round-trip lemma reconstructs full contribution member set per partition', async (t) => {
  for (const [partitionId, contributions] of fixtureContributions()) {
    const folded = foldSegment(partitionId, contributions);
    const decoded = decodeCanonicalSegment(folded.bytes);
    const extracted = contributionsFromSegment(decoded);
    const refolded = foldSegment(partitionId, extracted);
    const redecoded = decodeCanonicalSegment(refolded.bytes);

    assert.equal(
      Buffer.compare(Buffer.from(refolded.bytes), Buffer.from(folded.bytes)),
      0,
      `partition ${partitionId}: refolded segment bytes`,
    );

    await t.test(`partition ${partitionId}: postings+positions`, () => {
      assertCanonicalEqual(postingsFromContributions(extracted), decoded.postings, 'extracted postings');
      assertCanonicalEqual(redecoded.postings, decoded.postings, 'refolded postings');
    });

    await t.test(`partition ${partitionId}: fieldLengths from bm25 incl zero`, () => {
      const extractedLengths = fieldLengthsFromContributions(extracted);
      assert.ok(
        extractedLengths.some((entry) => entry.length === 0),
        'zero-length fields must round-trip',
      );
      assertCanonicalEqual(extractedLengths, fieldLengthsFromBm25(decoded), 'extracted fieldLengths');
      assertCanonicalEqual(fieldLengthsFromBm25(redecoded), fieldLengthsFromBm25(decoded), 'refolded fieldLengths');
    });

    await t.test(`partition ${partitionId}: fieldTexts`, () => {
      assertCanonicalEqual(fieldTextsFromContributions(extracted), decoded.fieldTexts ?? [], 'extracted fieldTexts');
      assertCanonicalEqual(redecoded.fieldTexts ?? [], decoded.fieldTexts ?? [], 'refolded fieldTexts');
    });

    await t.test(`partition ${partitionId}: documents`, () => {
      assertCanonicalEqual(documentsFromContributions(extracted), decoded.documents ?? [], 'extracted documents');
      assertCanonicalEqual(redecoded.documents ?? [], decoded.documents ?? [], 'refolded documents');
    });
  }
});

test('AC2 reduceBuildSegment base variant rejects unusable base contributions', () => {
  const [[partitionId, [retained]]] = fixtureContributions();
  const folded = foldSegment(partitionId, [retained]);
  const segmentsDir = tempRoot();
  fs.writeFileSync(path.join(segmentsDir, folded.hash), Buffer.from(folded.bytes));

  const retainedOnly = reduceBuildSegment({
    mode: 'base',
    partitionId,
    freshDocuments: [],
    base: {
      segmentsDir,
      segmentHash: folded.hash,
      retainedDocumentIds: [retained.documentId],
    },
  });
  assert.equal(Buffer.compare(Buffer.from(retainedOnly.bytes), Buffer.from(folded.bytes)), 0);

  fs.writeFileSync(path.join(segmentsDir, folded.hash), Buffer.from('corrupt'));
  assert.throws(
    () =>
      reduceBuildSegment({
        mode: 'base',
        partitionId,
        freshDocuments: [],
        base: {
          segmentsDir,
          segmentHash: folded.hash,
          retainedDocumentIds: [retained.documentId],
        },
      }),
    /hash mismatch/u,
  );

  fs.writeFileSync(path.join(segmentsDir, folded.hash), Buffer.from(folded.bytes));
  assert.throws(
    () =>
      reduceBuildSegment({
        mode: 'base',
        partitionId,
        freshDocuments: [],
        base: {
          segmentsDir,
          segmentHash: folded.hash,
          retainedDocumentIds: ['f'.repeat(64)],
        },
      }),
    /missing retained document/u,
  );
});

test('AC2 reduceBuildSegment rejects mixed full and base payloads', () => {
  const [[partitionId, [retained]]] = fixtureContributions();
  const folded = foldSegment(partitionId, [retained]);
  const segmentsDir = tempRoot();
  fs.writeFileSync(path.join(segmentsDir, folded.hash), Buffer.from(folded.bytes));

  assert.throws(
    () =>
      reduceBuildSegment({
        mode: 'base',
        partitionId,
        documents: [],
        freshDocuments: [],
        base: {
          segmentsDir,
          segmentHash: folded.hash,
          retainedDocumentIds: [retained.documentId],
        },
      }),
    /must not include documents/u,
  );
});
