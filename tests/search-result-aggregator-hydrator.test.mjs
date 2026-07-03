import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeSearchParams } from '../src/core/search/params.ts';
import { POSITIONAL_RETRIEVER_IDENTITY } from '../src/core/search/retrieval/positional/retriever.ts';
import { finalistsInBaseRankOrder, sortedSearchShardFinalists } from '../src/daemon/search-store/finalist-order.ts';
import { ResultAggregator } from '../src/daemon/search-store/result-aggregator.ts';
import { ResultHydrator } from '../src/daemon/search-store/result-hydrator.ts';
import {
  documentsByPath,
  documentsFromHandle,
  explainTrace,
  matchDebug,
  searchResult,
  snippetsForDocument,
} from '../src/daemon/search-store/result-shaping.ts';

const repoRoot = process.cwd();
const textEncoder = new TextEncoder();
const analysis = {
  raw: 'needle',
  primaryChannel: 'morph',
  primaryTerms: ['needle'],
  channels: { morph: ['needle'], surface: [], ngram: [] },
};
const analyzerIdentity = { name: 'aggregator-test', version: '1', node: 'test' };
const exactBound = { lexicalBound: 12, proximityBound: 3, lambdaExact: 0 };

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer, byteOffset: 0, byteLength: bytes.byteLength };
}

function snippetCorpus(documentId, segmentId, text) {
  const snippetId = `${documentId}-line-2`;
  return {
    bodyStartLine: 1,
    lines: [
      {
        line: 2,
        text,
        snippetId,
        segmentId,
        documentId,
        byteStart: 0,
        byteEnd: text.length,
        channels: { morph: ['needle'], surface: [], ngram: [] },
      },
    ],
    fallback: { kind: 'line', snippetId },
  };
}

function documentRecord(id, pathName, title, segmentId) {
  return {
    documentId: id,
    path: pathName,
    contentHash: `${id}-hash`,
    partitionId: Number(segmentId.replace('segment-', '')),
    title,
    tags: ['ac4'],
    snippetCorpus: snippetCorpus(id, segmentId, `${title} needle body`),
  };
}

function snapshotHandle(documents) {
  return {
    snapshotId: 'snapshot-ac4-aggregator',
    pinToken: 'pin-ac4',
    bm25Stats: { schemaId: 'test', corpusStats: [], rows: [], hash: 'ac4' },
    documents: sharedHandle(textEncoder.encode(JSON.stringify(documents))),
    segments: [],
  };
}

function finalist({ id, documentId, pathName, title, segmentId, partitionId, localDocId, score, baseRank }) {
  const shardDocRef = { segmentId, partitionId, localDocId, documentId };
  const candidate = {
    candidateId: id,
    documentId,
    shardDocRef,
    path: pathName,
    rank: baseRank,
    retrievalScore: score / 10,
    channels: [
      {
        channel: 'morph',
        rank: baseRank,
        score,
        weightedScore: score,
        matchedTerms: ['needle'],
        fieldScores: [],
      },
    ],
    phraseMatches: [],
    proximityMatches: [],
  };
  const rank = {
    path: pathName,
    title,
    tags: ['ac4'],
    bucket: 3,
    score,
    baseRank,
    exactPriority: 0,
    phrasePriority: 0,
    coverageTerms: 1,
    coverageFieldScore: 1,
    lexicalScore: score,
    identityScore: 0,
    exactLambda: 0,
    denseAgreement: 0,
    rarityScore: 0,
    proximityScore: 0,
    bodyScore: score,
  };
  return {
    source: 'persisted',
    score: candidate.retrievalScore,
    queryTerms: ['needle'],
    queryChannels: analysis.channels,
    matchedChannels: ['morph'],
    channelScores: { morph: score },
    candidate,
    documentId,
    path: pathName,
    shardDocRef,
    rank,
    feature: {
      candidate: { candidateId: id, documentId, shardDocRef, path: pathName },
      bm25: [],
      phrasePositions: [],
      proximity: [],
      rarity: { matchedWeightedTerms: 1, totalWeightedTerms: 1, score: 1 },
      coverage: { terms: 1, fieldScore: 1, matched: [] },
      identity: { exactPriority: null, phrasePriority: null },
      tags: ['ac4'],
    },
  };
}

function shardResult(partitionId, finalists, scoredCount = finalists.length) {
  return {
    snapshotId: 'snapshot-ac4-aggregator',
    partitionIds: [partitionId],
    requestedLimit: 2,
    workEstimate: scoredCount,
    scoredCount,
    finalists,
  };
}

function runAggregatorHydrator(shards, order, search, snapshot) {
  const aggregator = new ResultAggregator({
    exactBound,
    analysis,
  });
  for (const index of order) aggregator.ingest(shards[index]);
  const aggregation = aggregator.finalize();
  const result = new ResultHydrator().hydrate({
    search,
    snapshot,
    analyzerIdentity,
    explain: true,
    aggregation,
  });
  return { aggregation, bytes: JSON.stringify(result), result };
}

function legacyHydrationFixture(input) {
  const documents = documentsFromHandle(input.snapshot);
  const documentsByRelPath = documentsByPath(documents);
  const rankedAll = sortedSearchShardFinalists(input.finalists);
  const ranked = rankedAll.slice(0, input.search.limit);
  const matches = ranked.map((finalist) => {
    const record = documents.get(finalist.documentId) ?? documentsByRelPath.get(finalist.path);
    return {
      path: finalist.rank.path,
      title: record?.title ?? finalist.rank.title,
      tags: record?.tags ?? finalist.rank.tags,
      snippets: record ? snippetsForDocument(record, input.analysis.channels) : [],
      ...(input.search.debug
        ? {
            debug: matchDebug({
              hit: finalist,
              rank: finalist.rank,
              snapshotId: input.snapshot.snapshotId,
              analyzer: input.analyzerIdentity,
            }),
          }
        : {}),
    };
  });
  const result = searchResult(
    matches,
    input.snapshot.snapshotId,
    input.analyzerIdentity,
    input.search,
    input.scoredCount,
    input.analysis.channels,
  );
  if (input.explain) {
    const traceFinalists = finalistsInBaseRankOrder(input.finalists);
    result.explainTrace = explainTrace({
      candidateSet: {
        schemaVersion: 1,
        snapshotId: input.snapshot.snapshotId,
        retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
        complete: true,
        candidates: traceFinalists.map((finalist) => finalist.candidate),
      },
      exactBound: input.exactBound,
      featurePayloads: traceFinalists.map((finalist) => finalist.feature),
      queryAnalysis: input.analysis,
      ranked: rankedAll.map((finalist) => finalist.rank),
    });
  }
  return result;
}

test('ResultAggregator and ResultHydrator are byte-identical across shuffled shard completion', () => {
  const finalists = {
    a: finalist({
      id: 'candidate-a',
      documentId: 'doc-a',
      pathName: 'a.md',
      title: 'Alpha',
      segmentId: 'segment-1',
      partitionId: 1,
      localDocId: 1,
      score: 3,
      baseRank: 3,
    }),
    b: finalist({
      id: 'candidate-b',
      documentId: 'doc-b',
      pathName: 'b.md',
      title: 'Bravo',
      segmentId: 'segment-2',
      partitionId: 2,
      localDocId: 1,
      score: 11,
      baseRank: 1,
    }),
    c: finalist({
      id: 'candidate-c',
      documentId: 'doc-c',
      pathName: 'c.md',
      title: 'Charlie',
      segmentId: 'segment-3',
      partitionId: 3,
      localDocId: 1,
      score: 7,
      baseRank: 2,
    }),
    d: finalist({
      id: 'candidate-d',
      documentId: 'doc-d',
      pathName: 'd.md',
      title: 'Delta',
      segmentId: 'segment-4',
      partitionId: 4,
      localDocId: 1,
      score: 7,
      baseRank: 4,
    }),
  };
  const documents = [
    documentRecord('doc-a', 'a.md', 'Alpha', 'segment-1'),
    documentRecord('doc-b', 'b.md', 'Bravo', 'segment-2'),
    documentRecord('doc-c', 'c.md', 'Charlie', 'segment-3'),
    documentRecord('doc-d', 'd.md', 'Delta', 'segment-4'),
  ];
  const snapshot = snapshotHandle(documents);
  const search = normalizeSearchParams({ query: 'needle', limit: 2, debug: true });
  const shards = [
    shardResult(1, [finalists.a, finalists.c], 5),
    shardResult(2, [finalists.b], 2),
    shardResult(3, [finalists.d], 4),
  ];
  const allFinalists = shards.flatMap((shard) => shard.finalists);
  const legacy = legacyHydrationFixture({
    search,
    snapshot,
    analysis,
    analyzerIdentity,
    finalists: allFinalists,
    scoredCount: shards.reduce((sum, shard) => sum + shard.scoredCount, 0),
    explain: true,
    exactBound,
  });
  const expectedBytes = JSON.stringify(legacy);
  const permutations = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 0, 2],
    [1, 2, 0],
  ];

  for (const order of permutations) {
    const { aggregation, bytes, result } = runAggregatorHydrator(shards, order, search, snapshot);
    assert.equal(bytes, expectedBytes, `completion order ${order.join(',')}`);
    assert.deepEqual(
      aggregation.finalists.map((entry) => entry.candidate.candidateId),
      ['candidate-b', 'candidate-c', 'candidate-d', 'candidate-a'],
    );
    assert.equal(aggregation.scoredCount, 11);
    assert.deepEqual(
      result.explainTrace.inputs.candidateSet.candidates.map((candidate) => candidate.candidateId),
      ['candidate-b', 'candidate-c', 'candidate-a', 'candidate-d'],
    );
    assert.deepEqual(
      result.explainTrace.inputs.featurePayloads.map((feature) => feature.candidate.candidateId),
      ['candidate-b', 'candidate-c', 'candidate-a', 'candidate-d'],
    );
  }
});

test('ResultHydrator can use provided loaded documents without decoding snapshot document bytes', () => {
  const document = documentRecord('doc-a', 'a.md', 'Alpha', 'segment-1');
  const snapshot = {
    ...snapshotHandle([]),
    documents: sharedHandle(textEncoder.encode('{not-json')),
  };
  const search = normalizeSearchParams({ query: 'needle', limit: 1 });
  const result = new ResultHydrator().hydrate({
    search,
    snapshot,
    analyzerIdentity,
    documents: new Map([[document.documentId, document]]),
    aggregation: {
      finalists: [
        finalist({
          id: 'candidate-a',
          documentId: 'doc-a',
          pathName: 'a.md',
          title: 'Alpha',
          segmentId: 'segment-1',
          partitionId: 1,
          localDocId: 1,
          score: 3,
          baseRank: 1,
        }),
      ],
      scoredCount: 1,
      exactBound,
      analysis,
    },
  });

  assert.equal(result.matches[0].title, 'Alpha');
  assert.equal(result.matches[0].snippets[0].text, 'Alpha needle body');
});

test('snippetsForDocument keeps top scored unique body lines', () => {
  const line = (lineNumber, morph, text) => ({
    line: lineNumber,
    text,
    snippetId: `line-${lineNumber}-${text}`,
    segmentId: 'segment-1',
    documentId: 'doc-a',
    byteStart: 0,
    byteEnd: text.length,
    channels: { morph, surface: [], ngram: [] },
  });
  const record = {
    documentId: 'doc-a',
    path: 'a.md',
    contentHash: 'hash-a',
    partitionId: 1,
    title: 'Alpha',
    tags: [],
    snippetCorpus: {
      bodyStartLine: 1,
      lines: [
        line(3, ['needle'], 'line three lower duplicate'),
        line(2, ['needle'], 'line two'),
        line(5, ['needle', 'bonus'], 'line five'),
        line(3, ['needle', 'bonus'], 'line three higher duplicate'),
        line(4, ['bonus'], 'line four'),
        line(6, [], 'line six'),
        line(7, ['needle', 'bonus'], '   '),
      ],
      fallback: { kind: 'line', snippetId: 'line-2-line two' },
    },
  };
  const queryChannels = { morph: ['needle', 'bonus'], surface: [], ngram: [] };

  assert.deepEqual(
    snippetsForDocument(record, queryChannels).map((snippet) => [snippet.line, snippet.text]),
    [
      [3, 'line three higher duplicate'],
      [5, 'line five'],
      [2, 'line two'],
    ],
  );
});

test('AC4 split keeps aggregation separate and delegates finalist ordering to shared helpers', () => {
  const aggregatorSource = fs.readFileSync(path.join(repoRoot, 'src/daemon/search-store/result-aggregator.ts'), 'utf8');
  const hydratorSource = fs.readFileSync(path.join(repoRoot, 'src/daemon/search-store/result-hydrator.ts'), 'utf8');

  assert.doesNotMatch(
    aggregatorSource,
    /documentsFromHandle|snippetsForDocument|matchDebug|explainTrace|SearchMatch|ResultHydrator/,
  );
  assert.doesNotMatch(aggregatorSource, /\bexplain\b/);
  assert.match(hydratorSource, /finalistsInBaseRankOrder/);
  assert.doesNotMatch(hydratorSource, /compareRankedHitEntries|sortedSearchShardFinalists/);
  assert.doesNotMatch(hydratorSource, /\.sort\s*\(/);
});
