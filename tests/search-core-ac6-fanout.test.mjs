import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

const BATCH_ORDER_VARIANTS = [
  { name: 'plan-order', order: (tasks) => [...tasks] },
  { name: 'reverse-pending', order: (tasks) => [...tasks].reverse() },
];

function tempRoot(prefix = 'optsidian-search-ac6-') {
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
    identity: {
      name: 'test-analyzer',
      version: '1',
      node: 'test',
    },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text)),
  };
}

function testQueryAnalysis(raw) {
  const terms = [
    ...raw
      .normalize('NFKC')
      .toLowerCase()
      .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
  ].map((match) => match[0]);
  return {
    raw,
    primaryChannel: 'morph',
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] },
  };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0,
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3],
    })),
    hash: manifest.bm25GlobalStatsHash,
  };
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength,
  };
}

function snapshotHandle(built, pinToken = 'pin-ac6') {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    linkGraph: {
      schemaVersion: 1,
      linkGraphId: built.linkGraphId,
      corpusSnapshotId: built.corpusSnapshotId,
      resolverVersion: 'test-link-resolver',
      edges: built.linkEdges,
      backlinks: built.linkEdges,
    },
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
}

async function buildSyntheticSnapshot(documentCount, partitionBits = 4) {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, 'src/daemon/search-store/builder.ts'));
  const vault = tempRoot();
  for (let index = 0; index < documentCount; index += 1) {
    const group = `group-${index % 4}`;
    const topic = index % 2 === 0 ? 'alpha' : 'beta';
    writeVaultFile(
      vault,
      `folder-${index % 8}/Doc ${String(index).padStart(4, '0')}.md`,
      [
        '---',
        `tags: [ac6, ${group}]`,
        '---',
        `# Target ${index} ${topic}`,
        '',
        Array.from(
          { length: 10 },
          (_, repeat) =>
            `common needle fanout ${topic} shard partition scoring doc-${index} repeat-${repeat} exact-${index}`,
        ).join('\n'),
      ].join('\n'),
    );
  }
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits });
  assert.ok(built.segments.length >= 2, 'AC6 fixture must span at least two partitions');
  return { analyzer, built, vault };
}

function normalizeScorePayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    score: match.debug?.rerankScore,
  }));
}

class RecordingSearchExecutionPool {
  constructor(inner) {
    this.inner = inner;
    this.jobs = [];
  }

  idleReadySlotIds() {
    return this.inner.idleReadySlotIds();
  }

  leaseIdleSlot() {
    return this.inner.leaseIdleSlot();
  }

  releaseIdleSlot(slotId) {
    return this.inner.releaseIdleSlot(slotId);
  }

  runOnSlot(job, options, slotId) {
    this.jobs.push({ job, options, slotId });
    return this.inner.runOnSlot(job, options, slotId);
  }

  cancel(cancellationId) {
    this.inner.cancel(cancellationId);
  }
}

class ControlledLeasePool {
  constructor(slotIds, onRun) {
    this.slots = new Map(slotIds.map((slotId) => [slotId, { busy: false, leased: false }]));
    this.onRun = onRun;
    this.active = new Map();
    this.leaseCalls = [];
    this.releaseCalls = [];
    this.runCalls = [];
    this.cancelCalls = [];
  }

  idleReadySlotIds() {
    return [...this.slots].filter(([, slot]) => !slot.busy && !slot.leased).map(([slotId]) => slotId);
  }

  leaseIdleSlot() {
    const slotId = this.idleReadySlotIds()[0];
    if (slotId === undefined) return undefined;
    this.slots.get(slotId).leased = true;
    this.leaseCalls.push(slotId);
    return slotId;
  }

  releaseIdleSlot(slotId) {
    this.releaseCalls.push(slotId);
    const slot = this.slots.get(slotId);
    if (!slot || !slot.leased || slot.busy) return false;
    slot.leased = false;
    return true;
  }

  runOnSlot(job, options, slotId) {
    const slot = this.slots.get(slotId);
    if (!slot?.leased || slot.busy) throw new Error(`slot ${slotId} was not leased`);
    slot.leased = false;
    slot.busy = true;
    this.runCalls.push({ job, options, slotId });
    const promise = this.onRun?.(job, options, slotId, this);
    if (promise)
      return promise.finally(() => {
        if (this.slots.has(slotId)) this.slots.get(slotId).busy = false;
        this.active.delete(slotId);
      });
    return new Promise((resolve, reject) => {
      this.active.set(slotId, { job, options, resolve, reject });
    }).finally(() => {
      if (this.slots.has(slotId)) this.slots.get(slotId).busy = false;
      this.active.delete(slotId);
    });
  }

  cancel(cancellationId) {
    this.cancelCalls.push(cancellationId);
    for (const [slotId, run] of [...this.active]) {
      if (run.options.cancellationId !== cancellationId) continue;
      run.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
      this.active.delete(slotId);
      if (this.slots.has(slotId)) this.slots.get(slotId).busy = false;
    }
  }

  completeAll() {
    for (const [slotId, run] of [...this.active]) {
      run.resolve({
        snapshotId: run.job.snapshot.snapshotId,
        partitionIds: run.job.snapshot.segments.map((segment) => segment.partitionId),
        requestedLimit: run.job.requestedLimit,
        workEstimate: run.job.workEstimate,
        scoredCount: 0,
        finalists: [],
      });
      this.active.delete(slotId);
      if (this.slots.has(slotId)) this.slots.get(slotId).busy = false;
    }
  }
}

async function createExecutionPools(workers) {
  const { createDaemonPools } = await import(path.join(repoRoot, 'src/daemon/pools.ts'));
  const pools = await createDaemonPools(
    {
      ...process.env,
      OPTSIDIAN_SEARCH_ANALYZER: 'intl',
      OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
      OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
      OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
      OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(workers),
    },
    {},
  );
  await pools.searchExecution.warmup(workers);
  return pools;
}

async function executeScheduledSearch(input, ordering) {
  const { SearchQueryPlanner } = await import(path.join(repoRoot, 'src/daemon/search-store/query-planner.ts'));
  const { SearchQueryScheduler } = await import(path.join(repoRoot, 'src/daemon/search-store/query-scheduler.ts'));
  const { pool: searchExecutionPool, ...schedulerInput } = input;
  const planner = new SearchQueryPlanner();
  const plan = planner.plan(schedulerInput);
  const pool = new RecordingSearchExecutionPool(searchExecutionPool);
  const scheduler = new SearchQueryScheduler(pool, {
    testOrdering: {
      orderPendingTasks: ordering.order,
    },
  });
  const result = await scheduler.execute({ ...schedulerInput, plan });
  return { jobs: pool.jobs, plan, result };
}

function planPartitionIds(plan) {
  return plan.tasks
    .flatMap((task) => task.snapshot.segments.map((segment) => segment.partitionId))
    .sort((left, right) => left - right);
}

function dispatchedPartitionIds(jobs) {
  return jobs
    .flatMap(({ job }) => job.snapshot.segments.map((segment) => segment.partitionId))
    .sort((left, right) => left - right);
}

function finalist({ id, documentId, pathName, segmentId, localDocId, score }) {
  const shardDocRef = { segmentId, partitionId: 1, localDocId, documentId };
  return {
    source: 'persisted',
    score,
    queryTerms: ['needle'],
    queryChannels: { morph: ['needle'], surface: [], ngram: [] },
    matchedChannels: ['morph'],
    channelScores: { morph: score },
    documentId,
    path: pathName,
    shardDocRef,
    candidate: {
      candidateId: id,
      documentId,
      path: pathName,
      shardDocRef,
      retrievalScore: score,
      channels: [],
      phraseMatches: [],
      proximityMatches: [],
    },
    rank: {
      path: pathName,
      title: pathName,
      tags: [],
      bucket: 3,
      score,
      baseRank: 1,
      exactPriority: Number.POSITIVE_INFINITY,
      phrasePriority: Number.POSITIVE_INFINITY,
      coverageTerms: 0,
      coverageFieldScore: 0,
      lexicalScore: score,
      identityScore: 0,
      exactLambda: 0,
      denseAgreement: 0,
      rarityScore: 0,
      proximityScore: 0,
      bodyScore: score,
    },
    feature: { candidate: { candidateId: id, documentId, path: pathName, shardDocRef } },
  };
}

test('AC6 shard finalist equal-score tie-break follows path, segment, then local doc id', async () => {
  const { sortedSearchShardFinalists } = await import(path.join(repoRoot, 'src/daemon/search-store/finalist-order.ts'));
  const sorted = sortedSearchShardFinalists([
    finalist({
      id: 'candidate-b',
      documentId: 'doc-b',
      pathName: 'same.md',
      segmentId: 'segment-b',
      localDocId: 1,
      score: 10,
    }),
    finalist({
      id: 'candidate-a2',
      documentId: 'doc-a2',
      pathName: 'same.md',
      segmentId: 'segment-a',
      localDocId: 2,
      score: 10,
    }),
    finalist({
      id: 'candidate-c',
      documentId: 'doc-c',
      pathName: 'z.md',
      segmentId: 'segment-a',
      localDocId: 1,
      score: 10,
    }),
    finalist({
      id: 'candidate-a1',
      documentId: 'doc-a1',
      pathName: 'same.md',
      segmentId: 'segment-a',
      localDocId: 1,
      score: 10,
    }),
    finalist({
      id: 'candidate-path',
      documentId: 'doc-path',
      pathName: 'a.md',
      segmentId: 'segment-z',
      localDocId: 9,
      score: 10,
    }),
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.candidate.candidateId),
    ['candidate-path', 'candidate-a1', 'candidate-a2', 'candidate-b', 'candidate-c'],
  );
});

test('AC6 sharded fanout preserves link adjacency candidates', async () => {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, 'src/daemon/search-store/builder.ts'));
  const { executeSearchShardJob } = await import(path.join(repoRoot, 'src/daemon/search-execution.ts'));
  const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
  const { SearchQueryPlanner } = await import(path.join(repoRoot, 'src/daemon/search-store/query-planner.ts'));
  const { SearchQueryScheduler } = await import(path.join(repoRoot, 'src/daemon/search-store/query-scheduler.ts'));
  const vault = tempRoot();
  writeVaultFile(vault, 'Source.md', '# Source\n\nsourceonly [[Target]]\n');
  writeVaultFile(vault, 'Target.md', '# Target\n\nlinked-only content without the query term\n');
  for (let index = 0; index < 10; index += 1) {
    writeVaultFile(vault, `Filler-${index}.md`, `# Filler ${index}\n\nbackground content ${index}\n`);
  }
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 4 });
  assert.ok(built.segments.length >= 2);
  const source = built.documents.find((document) => document.path === 'Source.md');
  const target = built.documents.find((document) => document.path === 'Target.md');
  assert.ok(source);
  assert.ok(target);
  assert.ok(
    built.linkEdges.some(
      (edge) => edge.sourceDocumentId === source.documentId && edge.targetDocumentId === target.documentId,
    ),
  );

  const search = normalizeSearchParams({ query: 'sourceonly', limit: 5, debug: true });
  const input = {
    vault,
    search,
    analysis: testQueryAnalysis(search.query),
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built, 'pin-link-fanout'),
    sourceDocumentId: source.documentId,
    sourcePath: source.path,
    excludeDocumentIds: [source.documentId],
    deadline: Date.now() + 10_000,
    cancellationId: `ac6-link-${crypto.randomUUID()}`,
  };
  const planner = new SearchQueryPlanner();
  const plan = planner.plan(input);
  assert.equal(plan.tasks.length, built.segments.length);
  const pool = new ControlledLeasePool([1, 2], async (job) => executeSearchShardJob(job));
  const result = await new SearchQueryScheduler(pool).execute({ ...input, plan });
  assert.equal(
    pool.runCalls.every((call) => call.job.snapshot.linkGraph),
    true,
  );
  const linked = result.matches.find((match) => match.path === 'Target.md');
  assert.ok(linked, 'linked target should survive sharded fanout');
  assert.ok((linked.debug?.linkAgreement ?? 0) > 0);
});

test(
  'AC6 scheduler grouping invariance matches the monolithic oracle for non-identity queries',
  { timeout: 240_000 },
  async () => {
    const { executeSearchJob } = await import(path.join(repoRoot, 'src/daemon/search-execution.ts'));
    const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
    const { analyzer, built, vault } = await buildSyntheticSnapshot(48, 4);
    const queryCases = [
      { query: 'needle common', limit: 10 },
      { query: 'target 17', fields: ['title', 'body'], limit: 8 },
    ];
    const baselines = new Map();

    for (const queryCase of queryCases) {
      const search = normalizeSearchParams({ ...queryCase, debug: true });
      const baseline = executeSearchJob({
        vault,
        search,
        analysis: testQueryAnalysis(queryCase.query),
        analyzerIdentity: analyzer.identity,
        snapshot: snapshotHandle(built, 'pin-monolithic'),
      });
      assert.ok(baseline.matches.length > 0, `baseline should return matches for ${queryCase.query}`);
      baselines.set(queryCase.query, JSON.stringify(normalizeScorePayload(baseline)));
    }

    for (const ordering of BATCH_ORDER_VARIANTS) {
      const pools = await createExecutionPools(2);
      try {
        for (const queryCase of queryCases) {
          const search = normalizeSearchParams({ ...queryCase, debug: true });
          const { jobs, plan, result } = await executeScheduledSearch(
            {
              vault,
              search,
              analysis: testQueryAnalysis(queryCase.query),
              analyzerIdentity: analyzer.identity,
              snapshot: snapshotHandle(built, `pin-${ordering.name}-${queryCase.query}`),
              deadline: Date.now() + 120_000,
              cancellationId: `ac6-grouping-${ordering.name}-${crypto.randomUUID()}`,
              pool: pools.searchExecution,
            },
            ordering,
          );
          assert.deepEqual(dispatchedPartitionIds(jobs), planPartitionIds(plan));
          assert.equal(
            JSON.stringify(normalizeScorePayload(result)),
            baselines.get(queryCase.query),
            `query=${queryCase.query} batchOrder=${ordering.name}`,
          );
        }
      } finally {
        await pools.close();
      }
    }
  },
);

test('AC6 scheduler shard failure cancels active leases and releases the search pin', { timeout: 60_000 }, async () => {
  const { DaemonSearchStoreService } = await import(path.join(repoRoot, 'src/daemon/search-store/service.ts'));
  const { analyzer, built, vault } = await buildSyntheticSnapshot(32, 3);
  const snapshot = snapshotHandle(built, 'pin-life');
  const pin = { snapshotId: snapshot.snapshotId, pinToken: 'pin-life' };
  const released = [];
  const terminalError = Object.assign(new Error('simulated shard failure'), { code: 'INTERNAL' });
  let runCount = 0;
  const fakeStore = {
    pin: async () => pin,
    snapshotHandleForPin: () => snapshot,
    release: (inputPin) => {
      released.push(inputPin.pinToken);
    },
    searchAnalyzerIdentity: () => analyzer.identity,
  };
  const fakeSearchExecution = new ControlledLeasePool([1, 2], (job, options, slotId, pool) => {
    runCount += 1;
    if (runCount === 1) {
      return Promise.resolve().then(() => {
        throw terminalError;
      });
    }
    return new Promise((resolve, reject) => {
      pool.active.set(slotId, { job, options, resolve, reject });
    });
  });
  const service = new DaemonSearchStoreService(
    fakeStore,
    {
      analyzerIdentity: analyzer.identity,
      analyzeQuery: async (raw) => ({
        analyzerIdentity: analyzer.identity,
        analysis: testQueryAnalysis(raw),
      }),
    },
    {},
    fakeSearchExecution,
    { queryCacheSize: 1 },
  );

  await assert.rejects(
    () =>
      service.search(
        { vault, query: 'needle common', limit: 5 },
        { deadline: Date.now() + 10_000, cancellationId: 'ac6-life', requestId: 'ac6-life' },
      ),
    (error) => error === terminalError,
  );

  assert.ok(fakeSearchExecution.runCalls.length >= 2, 'fixture should dispatch concurrent shard jobs');
  assert.deepEqual(fakeSearchExecution.cancelCalls, ['ac6-life']);
  assert.deepEqual(released, ['pin-life']);
});

test('AC6 scheduler skips zero-work plans without leasing search workers', async () => {
  const { SearchQueryPlanner } = await import(path.join(repoRoot, 'src/daemon/search-store/query-planner.ts'));
  const { SearchQueryScheduler } = await import(path.join(repoRoot, 'src/daemon/search-store/query-scheduler.ts'));
  const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
  const { analyzer, built, vault } = await buildSyntheticSnapshot(32, 3);
  const search = normalizeSearchParams({ query: 'definitelyabsentterm', limit: 5 });
  const input = {
    vault,
    search,
    analysis: testQueryAnalysis(search.query),
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built, 'pin-zero-work'),
    deadline: Date.now() + 10_000,
    cancellationId: 'ac6-zero-work',
  };
  const planner = new SearchQueryPlanner();
  const plan = planner.plan(input);
  const pool = new ControlledLeasePool([1, 2], () => {
    throw new Error('zero-work query should not dispatch shards');
  });
  const result = await new SearchQueryScheduler(pool, { exhaustiveWorkCeiling: 100 }).execute({ ...input, plan });

  assert.equal(plan.tasks.length, 0);
  assert.deepEqual(pool.leaseCalls, []);
  assert.deepEqual(pool.runCalls, []);
  assert.deepEqual(result.matches, []);
});
