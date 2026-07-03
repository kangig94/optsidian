import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DeterministicHashProvider } from '../src/core/search/dense/provider.ts';
import { createDenseRetriever } from '../src/core/search/dense/retriever.ts';
import { SEARCH_SCORING_LAMBDAS } from '../src/core/search/constants.ts';
import { fuseCandidateSets, retrieveWithFusion } from '../src/core/search/retrieval/fusion.ts';
import { POSITIONAL_FIELD_ID } from '../src/core/search/retrieval/positional/types.ts';
import { rerankCandidatesWithSignals, rerankScore } from '../src/core/search/ranking/score.ts';
import { rankSignalsFromFeatures } from '../src/daemon/search-execution.ts';
import {
  buildCanonicalSearchSnapshot,
  snapshotIdentityTupleForAnalyzerIdentity,
} from '../src/daemon/search-store/builder.ts';
import { corpusSnapshotIdFromManifest, snapshotIdFromManifest } from '../src/core/search/segments/canonical.ts';

function shardDocRef(documentId, localDocId) {
  return {
    segmentId: 'segment-p2',
    partitionId: 0,
    localDocId,
    documentId,
  };
}

function retrievalCandidate(documentId, path, localDocId, overrides = {}) {
  return {
    candidateId: documentId,
    documentId,
    shardDocRef: shardDocRef(documentId, localDocId),
    path,
    rank: overrides.rank ?? localDocId,
    retrievalScore: overrides.retrievalScore ?? 0,
    channels: [],
    phraseMatches: [],
    proximityMatches: [],
    ...overrides,
  };
}

function featurePayload(candidate, lexicalScore) {
  return {
    candidate: {
      candidateId: candidate.candidateId,
      documentId: candidate.documentId,
      shardDocRef: candidate.shardDocRef,
      path: candidate.path,
    },
    ...(candidate.retrieverSignals ? { retrieverSignals: candidate.retrieverSignals } : {}),
    ...(candidate.denseAgreement === undefined ? {} : { denseAgreement: candidate.denseAgreement }),
    ...(candidate.linkAgreement === undefined ? {} : { linkAgreement: candidate.linkAgreement }),
    ...(candidate.rrfScore === undefined ? {} : { rrfScore: candidate.rrfScore }),
    bm25:
      lexicalScore > 0
        ? [
            {
              channel: 'morph',
              field: 'body',
              fieldId: POSITIONAL_FIELD_ID.body,
              term: 'literal',
              frequency: 1,
              documentFrequency: 1,
              documentCount: 2,
              fieldLength: 1,
              averageFieldLength: 1,
              score: lexicalScore,
            },
          ]
        : [],
    phrasePositions: [],
    proximity: [],
    rarity: {
      matchedWeightedTerms: 0,
      totalWeightedTerms: 0,
      score: 0,
    },
    coverage: {
      terms: 0,
      fieldScore: 0,
      matched: [],
    },
    identity: {
      exactPriority: null,
      phrasePriority: null,
    },
    tags: [],
  };
}

function queryAnalysis(raw) {
  const terms = raw.split(/\s+/u).filter(Boolean);
  return {
    raw,
    primaryChannel: 'morph',
    primaryTerms: terms,
    channels: {
      morph: terms,
      surface: terms,
      ngram: [],
    },
  };
}

function testAnalyzer(identity = { name: 'test-analyzer', version: 'retrieval-substrate-p2', node: 'test' }) {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity,
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function tempRoot(prefix = 'optsidian-retrieval-p2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function embeddingModel(id, dim = 3) {
  return {
    id,
    sha256: id.padEnd(64, '0').slice(0, 64),
    opset: 'onnx-opset-test',
    quantization: 'none',
    dim,
    pooling: 'mean',
  };
}

function candidateSet(identity, candidates) {
  return {
    identity,
    set: {
      schemaVersion: 1,
      snapshotId: 'snapshot-fusion',
      retrieverIdentity: identity,
      complete: true,
      candidates,
    },
  };
}

test('AC3 P2 fusion handles zero weights duplicate merge preference and tie breaking', () => {
  const lexicalIdentity = { id: 'positional-lexical', version: '1', parameters: {} };
  const denseIdentity = { id: 'dense', version: '1', parameters: { model: 'fake', metric: 'cosine' } };
  const lexicalDuplicate = retrievalCandidate('dup', 'b-lexical.md', 1, {
    retrievalScore: 8,
    channels: [{ channel: 'morph', matchedTerms: ['needle'], score: 8 }],
  });
  const denseDuplicate = retrievalCandidate('dup', 'z-dense.md', 1, {
    retrievalScore: 1,
    denseAgreement: 1,
  });
  const alpha = retrievalCandidate('alpha', 'a-alpha.md', 2, { retrievalScore: 1, denseAgreement: 1 });
  const beta = retrievalCandidate('beta', 'b-beta.md', 3, { retrievalScore: 1, denseAgreement: 1 });

  const fused = fuseCandidateSets(
    [candidateSet(lexicalIdentity, [lexicalDuplicate]), candidateSet(denseIdentity, [denseDuplicate, beta, alpha])],
    {
      rawQuery: 'needle',
      analysis: queryAnalysis('needle'),
      limit: 10,
      snapshotId: 'snapshot-fusion',
    },
    {
      weights: { dense: 0 },
      limit: 10,
    },
  );

  const duplicate = fused.candidates.find((candidate) => candidate.candidateId === 'dup');
  assert.ok(duplicate);
  assert.equal(duplicate.path, 'b-lexical.md');
  assert.equal(duplicate.channels.length, 1);
  assert.equal(duplicate.denseAgreement, 1);
  assert.deepEqual(
    fused.candidates.filter((candidate) => candidate.candidateId !== 'dup').map((candidate) => candidate.path),
    ['a-alpha.md', 'b-beta.md'],
  );
  assert.equal(fused.candidates.find((candidate) => candidate.candidateId === 'alpha')?.rrfScore, 0);
  assert.equal(fused.candidates.find((candidate) => candidate.candidateId === 'beta')?.rrfScore, 0);
});

test('AC3 P2 deterministic dense retriever propagates denseAgreement through fusion features and rerankScore', async () => {
  assert.ok(SEARCH_SCORING_LAMBDAS.dense > 0);
  assert.ok(SEARCH_SCORING_LAMBDAS.link > 0);

  const queryText = 'semantic handle';
  const nearText = 'near latent concept';
  const farText = 'literal but opposite';
  const provider = new DeterministicHashProvider({
    model: 'deterministic-semantic-v1',
    fixtures: new Map([
      [queryText, [1, 0, 0]],
      [nearText, [1, 0, 0]],
      [farText, [-1, 0, 0]],
    ]),
  });

  const nearDoc = { id: 'doc-near', path: 'Near.md', text: nearText, localDocId: 1 };
  const farDoc = { id: 'doc-far', path: 'Far.md', text: farText, localDocId: 2 };
  const denseRetriever = createDenseRetriever({
    provider,
    embeddingSet: {
      embeddingSetId: 'embedding-set-p2',
      model: provider.identity.model,
      coveredDocumentIds: new Set([nearDoc.id, farDoc.id]),
      records: [
        {
          documentId: nearDoc.id,
          shardDocRef: shardDocRef(nearDoc.id, nearDoc.localDocId),
          path: nearDoc.path,
          text: nearDoc.text,
          vector: await provider.embed(nearDoc.text),
        },
        {
          documentId: farDoc.id,
          shardDocRef: shardDocRef(farDoc.id, farDoc.localDocId),
          path: farDoc.path,
          text: farDoc.text,
          vector: await provider.embed(farDoc.text),
        },
      ],
    },
  });
  const gatedDenseRetriever = createDenseRetriever({ provider });
  const query = {
    rawQuery: queryText,
    analysis: queryAnalysis(queryText),
    snapshotId: 'snapshot-p2',
    limit: 2,
  };

  const gatedDenseSet = await gatedDenseRetriever.retrieve(query);
  assert.equal(gatedDenseSet.candidates.length, 0);

  const denseSet = await denseRetriever.retrieve(query);
  assert.equal(denseSet.retrieverIdentity.id, 'dense');
  assert.deepEqual(denseSet.retrieverIdentity.parameters, { model: 'deterministic-semantic-v1', metric: 'cosine' });
  assert.deepEqual(
    denseSet.candidates.map((candidate) => candidate.path),
    ['Near.md', 'Far.md'],
  );

  const lexicalRetriever = {
    retrieverIdentity: {
      id: 'positional-lexical',
      version: 'test',
      parameters: { fixture: 'far-doc-only' },
    },
    retrieve: () => ({
      schemaVersion: 1,
      snapshotId: 'snapshot-p2',
      retrieverIdentity: lexicalRetriever.retrieverIdentity,
      complete: true,
      candidates: [retrievalCandidate(farDoc.id, farDoc.path, farDoc.localDocId, { rank: 1, retrievalScore: 0.05 })],
    }),
  };

  const fused = await retrieveWithFusion([lexicalRetriever, denseRetriever], query, { limit: 2 });
  assert.equal(typeof fused.retrieverPlanIdentity, 'string');
  assert.equal(fused.retrieverPlanIdentity.length, 64);
  assert.deepEqual(
    fused.candidates.map((candidate) => candidate.path),
    ['Far.md', 'Near.md'],
  );

  const nearCandidate = fused.candidates.find((candidate) => candidate.documentId === nearDoc.id);
  const farCandidate = fused.candidates.find((candidate) => candidate.documentId === farDoc.id);
  assert.ok(nearCandidate);
  assert.ok(farCandidate);
  assert.equal(nearCandidate.retrieverSignals?.dense?.rank, 1);
  assert.equal(nearCandidate.denseAgreement, 1);
  assert.ok((nearCandidate.rrfScore ?? 0) > 0);

  const features = [featurePayload(nearCandidate, 0), featurePayload(farCandidate, 0.05)];
  const signals = rankSignalsFromFeatures(features, 0);
  const nearSignal = signals.get(nearDoc.id);
  assert.ok(nearSignal);
  assert.equal(nearSignal.denseAgreement, 1);
  assert.ok(nearSignal.rrfScore > 0);

  const ranked = rerankCandidatesWithSignals(
    queryText,
    [],
    [
      {
        document: { id: nearDoc.id, path: nearDoc.path, title: 'Near', tags: [] },
        score: nearCandidate.retrievalScore,
      },
      { document: { id: farDoc.id, path: farDoc.path, title: 'Far', tags: [] }, score: farCandidate.retrievalScore },
    ],
    undefined,
    signals,
  );
  assert.equal(ranked[0].path, 'Near.md');
  assert.ok(ranked[0].denseAgreement > 0);
  assert.equal(ranked[0].score, rerankScore(ranked[0]));
  assert.ok(rerankScore({ ...ranked[0], denseAgreement: 0 }) < ranked[0].score);
});

test('AC6 P2 corpusSnapshotId is stable across embedding-model identity changes', async () => {
  const vault = tempRoot();
  writeVaultFile(vault, 'Alpha.md', '# Alpha\n\nalpha body\n');
  writeVaultFile(vault, 'Beta.md', '# Beta\n\nbeta body\n');

  const baseAnalyzer = testAnalyzer();
  const modelAAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel('model-a') });
  const modelBAnalyzer = testAnalyzer({ ...baseAnalyzer.identity, embeddingModel: embeddingModel('model-b') });

  const base = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: baseAnalyzer, partitionBits: 1 });
  const modelA = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelAAnalyzer, partitionBits: 1 });
  const modelB = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: modelBAnalyzer, partitionBits: 1 });

  assert.equal(base.corpusSnapshotId, corpusSnapshotIdFromManifest(base.manifest));
  assert.equal(modelA.corpusSnapshotId, corpusSnapshotIdFromManifest(modelA.manifest));
  assert.equal(modelB.corpusSnapshotId, corpusSnapshotIdFromManifest(modelB.manifest));
  assert.equal(base.corpusSnapshotId, modelA.corpusSnapshotId);
  assert.equal(modelA.corpusSnapshotId, modelB.corpusSnapshotId);
  assert.deepEqual(
    modelA.segments.map((segment) => segment.hash),
    modelB.segments.map((segment) => segment.hash),
  );

  assert.equal(snapshotIdFromManifest(modelA.manifest), snapshotIdFromManifest(modelB.manifest));

  const rankingChangedManifest = JSON.parse(JSON.stringify(modelA.manifest));
  rankingChangedManifest.identityTuple.rankingFeatureVersion = 'f'.repeat(64);
  rankingChangedManifest.identityTuple.searchModelIdentity.scoringModel.weights.lambdas.dense = 999;
  rankingChangedManifest.identityTuple.searchModelIdentity.scoringModel.weights.lambdas.link = 999;
  rankingChangedManifest.identityTuple.searchModelIdentity.scoringModel.retrieverIdentity = {
    id: 'dense',
    version: 'changed',
    parameters: { model: 'changed', metric: 'cosine' },
  };
  rankingChangedManifest.identityTuple.searchModelIdentity.embeddingModel = embeddingModel('model-c');
  rankingChangedManifest.identityTuple.searchModelIdentity.analyzerIdentity.analyzer.embeddingModel =
    embeddingModel('model-c');
  rankingChangedManifest.identityTuple.analyzerIdentity.analyzer.embeddingModel = embeddingModel('model-c');
  assert.equal(corpusSnapshotIdFromManifest(rankingChangedManifest), modelA.corpusSnapshotId);

  const tupleA = snapshotIdentityTupleForAnalyzerIdentity(modelAAnalyzer.identity, 1);
  const tupleB = snapshotIdentityTupleForAnalyzerIdentity(modelBAnalyzer.identity, 1);
  assert.equal('embeddingModel' in tupleA.searchModelIdentity, false);
  assert.equal('embeddingModel' in tupleB.searchModelIdentity, false);
  assert.deepEqual(tupleA, tupleB);
});
