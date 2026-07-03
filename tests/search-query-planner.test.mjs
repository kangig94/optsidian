import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeSearchParams } from '../src/core/search/params.ts';
import { POSITIONAL_FIELD_ID } from '../src/core/search/retrieval/positional/index.ts';
import { CANONICAL_BM25_STATS_SCHEMA_ID, encodeCanonicalSegment } from '../src/core/search/segments/canonical.ts';
import { SearchQueryPlanner } from '../src/daemon/search-store/query-planner.ts';

const repoRoot = process.cwd();
const textEncoder = new TextEncoder();

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer, byteOffset: 0, byteLength: bytes.byteLength };
}

function hexId(value) {
  return value.toString(16).padStart(64, '0');
}

function canonicalPostingTerm(channel, term) {
  return `${channel}\u0000${term.normalize('NFC').trim()}`;
}

function plannerSegment(index, partitionId) {
  const title = POSITIONAL_FIELD_ID.title;
  const bytes = encodeCanonicalSegment({
    postings: [
      {
        term: canonicalPostingTerm('morph', 'needle'),
        fieldId: title,
        docId: 1,
        positions: [0],
      },
    ],
    documents: [
      {
        documentId: hexId(index + 1),
        path: `Planner/Doc ${index + 1}.md`,
        contentHash: hexId(index + 101),
      },
    ],
    fieldTexts: [{ docId: 1, fieldId: title, text: 'needle' }],
    bm25: [
      {
        channel: 'morph',
        fieldId: title,
        documentCount: 1,
        totalFieldLength: 1,
        documentLengths: [{ docId: 1, length: 1 }],
        documentFrequencies: [{ term: 'needle', frequency: 1 }],
      },
    ],
  });
  return {
    segmentId: `segment-${partitionId}`,
    partitionId,
    bytes: sharedHandle(bytes),
  };
}

function plannerInput(segmentCount = 4) {
  const title = POSITIONAL_FIELD_ID.title;
  const partitionOrder = [3, 1, 4, 2].slice(0, segmentCount);
  const search = normalizeSearchParams({ query: 'needle', fields: ['title'], limit: 8 });
  return {
    vault: '/tmp/planner-vault',
    search,
    analysis: {
      raw: 'needle',
      primaryChannel: 'morph',
      primaryTerms: ['needle'],
      channels: { morph: ['needle'], surface: [], ngram: [] },
    },
    analyzerIdentity: { name: 'planner-test', version: '1', node: 'test' },
    snapshot: {
      snapshotId: 'snapshot-planner',
      pinToken: 'pin-planner',
      bm25Stats: {
        schemaId: CANONICAL_BM25_STATS_SCHEMA_ID,
        corpusStats: [
          {
            channel: 'morph',
            fieldId: title,
            documentCount: segmentCount,
            totalFieldLength: segmentCount,
            averageFieldLength: 1,
          },
        ],
        rows: [{ channel: 'morph', fieldId: title, term: 'needle', documentFrequency: segmentCount }],
        hash: 'planner-test',
      },
      documents: sharedHandle(textEncoder.encode('[]')),
      segments: partitionOrder.map((partitionId, index) => plannerSegment(index, partitionId)),
    },
    deadline: Date.now() + 30_000,
    cancellationId: 'cancel-planner',
  };
}

function summarizePlan(plan) {
  return {
    snapshotId: plan.snapshotId,
    requestedLimit: plan.requestedLimit,
    estimatedWork: plan.estimatedWork,
    exactBound: plan.exactBound,
    mergeKey: plan.mergeKey,
    tasks: plan.tasks.map((task) => ({
      requestedLimit: task.requestedLimit,
      workEstimate: task.workEstimate,
      channels: [...task.channels],
      mergeKey: task.mergeKey,
      snapshotId: task.snapshot.snapshotId,
      segments: task.snapshot.segments.map((segment) => ({
        partitionId: segment.partitionId,
        segmentId: segment.segmentId,
      })),
    })),
  };
}

test('SearchQueryPlanner imports no pool or worker module and performs no dispatch', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/daemon/search-store/query-planner.ts'), 'utf8');
  const importedModules = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

  assert.equal(
    importedModules.some((specifier) => /(?:^|\/)(?:pools|worker-pool)\.js$/u.test(specifier)),
    false,
  );
  assert.equal(/\bawait\b/u.test(source), false);
  assert.equal(/\bdispatch\w*\b/iu.test(source), false);
});

test('SearchQueryPlanner emits deterministic granular full-channel segment tasks without the old two-group cap', () => {
  const planner = new SearchQueryPlanner();
  const input = plannerInput(4);

  const first = summarizePlan(planner.plan(input));
  const second = summarizePlan(planner.plan(input));
  const reversed = summarizePlan(
    planner.plan({
      ...input,
      snapshot: {
        ...input.snapshot,
        segments: [...input.snapshot.segments].reverse(),
      },
    }),
  );

  assert.deepEqual(second, first);
  assert.deepEqual(reversed, first);
  assert.equal(first.snapshotId, 'snapshot-planner');
  assert.equal(first.requestedLimit, 8);
  assert.equal(first.estimatedWork, 4);
  assert.equal(first.tasks.length, 4);
  assert.deepEqual(
    first.tasks.map((task) => task.segments),
    [
      [{ partitionId: 1, segmentId: 'segment-1' }],
      [{ partitionId: 2, segmentId: 'segment-2' }],
      [{ partitionId: 3, segmentId: 'segment-3' }],
      [{ partitionId: 4, segmentId: 'segment-4' }],
    ],
  );
  assert.deepEqual(
    first.tasks.map((task) => task.workEstimate),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    first.tasks.map((task) => task.channels),
    [
      ['morph', 'surface', 'ngram'],
      ['morph', 'surface', 'ngram'],
      ['morph', 'surface', 'ngram'],
      ['morph', 'surface', 'ngram'],
    ],
  );
});

test('SearchQueryPlanner skips exact-bound work for non-explain zero-work plans', () => {
  const planner = new SearchQueryPlanner();
  const absentInput = {
    ...plannerInput(4),
    analysis: {
      raw: 'absent',
      primaryChannel: 'morph',
      primaryTerms: ['absent'],
      channels: { morph: ['absent'], surface: [], ngram: [] },
    },
  };

  const plan = planner.plan(absentInput);
  const explainPlan = planner.plan({ ...absentInput, explain: true });

  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.exactBound, undefined);
  assert.equal(explainPlan.tasks.length, 0);
  assert.ok(explainPlan.exactBound);
});
