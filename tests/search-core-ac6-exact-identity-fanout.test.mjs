import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

function tempRoot(prefix = 'optsidian-search-ac6-identity-') {
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

function snapshotHandle(built, pinToken) {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
}

// Builds a corpus where:
//   - several documents carry a distinctive single-token frontmatter title that a
//     single-term query matches EXACTLY (exact title identity -> identityScore > 0), and
//   - BM25 single-term bounds vary sharply across shards (one document concentrates a
//     rare term in a short title field), so a per-shard recompute of the exact-dominance
//     bound diverges from the corpus-wide bound.
async function buildIdentitySnapshot(partitionBits = 4) {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, 'src/daemon/search-store/builder.ts'));
  const vault = tempRoot();
  const titles = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  for (let index = 0; index < 80; index += 1) {
    const title = titles[index % titles.length];
    // One document gets an extreme single-term concentration in a short title field, which
    // dominates the corpus-wide single-term BM25 bound while being absent from other shards.
    const skewed = index === 7 ? `title: ${'needle '.repeat(8)}${title}` : `title: ${title}`;
    writeVaultFile(
      vault,
      `folder-${index % 8}/Doc ${String(index).padStart(4, '0')}.md`,
      [
        '---',
        skewed,
        'tags: [ac6, group-' + (index % 4) + ']',
        '---',
        `# Heading ${index}`,
        '',
        Array.from(
          { length: 6 + (index % 5) },
          (_, repeat) => `common needle fanout shard partition scoring doc-${index} repeat-${repeat}`,
        ).join('\n'),
      ].join('\n'),
    );
  }
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits });
  assert.ok(built.segments.length >= 2, 'AC6 identity fixture must span at least two partitions');
  return { analyzer, built, vault };
}

function normalizeScorePayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    score: match.debug?.rerankScore,
    identityScore: match.debug?.identityScore,
  }));
}

const BATCH_ORDER_VARIANTS = [
  {
    name: 'plan-order',
    order: (tasks) => [...tasks],
  },
  {
    name: 'reverse-pending',
    order: (tasks) => [...tasks].reverse(),
  },
];

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

async function createExecutionPools(workers) {
  const { createDaemonPools } = await import(path.join(repoRoot, 'src/daemon/pools.ts'));
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_ANALYZER: 'intl',
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(workers),
  };
  const pools = await createDaemonPools(env, {});
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

function dispatchSignature(jobs) {
  return jobs.map(({ job }) => job.snapshot.segments.map((segment) => segment.partitionId));
}

function expectedInitialDispatchSignature(tasks, leaseCount) {
  const pending = [...tasks];
  const groups = [];
  for (let leasesRemaining = leaseCount; leasesRemaining > 0 && pending.length > 0; leasesRemaining -= 1) {
    const batchSize = Math.max(1, Math.ceil(pending.length / Math.max(1, leasesRemaining)));
    const batch = pending.splice(0, batchSize);
    groups.push(batch.flatMap((task) => task.snapshot.segments.map((segment) => segment.partitionId)));
  }
  return groups;
}

function assertExhaustiveDispatchedEveryPlanUnit(plan, jobs, label) {
  assert.deepEqual(
    dispatchedPartitionIds(jobs),
    planPartitionIds(plan),
    `${label}: exhaustive scheduling must dispatch every planned shard unit`,
  );
}

test('AC6 exact dominance bound computation reuses cached snapshot state by snapshotId', async () => {
  const { exactDominanceBoundForSearchHandle, searchExecutionCacheStats } = await import(
    path.join(repoRoot, 'src/daemon/search-execution.ts')
  );
  const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
  const { built } = await buildIdentitySnapshot(4);
  const search = normalizeSearchParams({ query: 'alpha', limit: 10 });
  const analysis = testQueryAnalysis('alpha');
  const snapshot = snapshotHandle(built, 'pin-bound-cache');
  const before = searchExecutionCacheStats();

  const first = exactDominanceBoundForSearchHandle({ search, snapshot, analysis });
  const middle = searchExecutionCacheStats();
  const second = exactDominanceBoundForSearchHandle({ search, snapshot, analysis });
  const after = searchExecutionCacheStats();

  assert.deepEqual(second, first);
  assert.equal(after.hits, middle.hits + 1);
  assert.equal(after.misses + after.hits, before.misses + before.hits + 2);
  assert.ok(after.snapshotIds.includes(snapshot.snapshotId));
});

test(
  'AC6 scheduler pipeline is byte-identical to monolithic for exact-identity queries across batch orders',
  { timeout: 240_000 },
  async () => {
    const { executeSearchJob } = await import(path.join(repoRoot, 'src/daemon/search-execution.ts'));
    const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
    const { analyzer, built, vault } = await buildIdentitySnapshot(4);

    // Each query exactly equals a document title, so the matched documents earn an exact
    // title identity (identityScore > 0) and their rank.score includes exactLambda * identityScore.
    const queryCases = [
      { query: 'alpha', limit: 12 },
      { query: 'delta', limit: 10 },
      { query: 'hotel', limit: 8 },
    ];
    const workerCounts = [1, 2, 4];
    const baselines = new Map();
    const explainReplayChecked = new Set();
    const exhaustiveDispatchSignatures = new Map();

    for (const queryCase of queryCases) {
      const search = normalizeSearchParams({ ...queryCase, debug: true });
      const baseline = executeSearchJob({
        vault,
        search,
        analysis: testQueryAnalysis(queryCase.query),
        analyzerIdentity: analyzer.identity,
        snapshot: snapshotHandle(built, 'pin-monolithic'),
      });
      const baselinePayload = normalizeScorePayload(baseline);
      assert.ok(baselinePayload.length > 0, `baseline should return matches for ${queryCase.query}`);
      assert.ok(
        baselinePayload.some((entry) => (entry.identityScore ?? 0) > 0),
        `query=${queryCase.query} must produce at least one exact-identity match (identityScore > 0)`,
      );
      baselines.set(queryCase.query, JSON.stringify(baselinePayload));
    }

    for (const workers of workerCounts) {
      for (const ordering of BATCH_ORDER_VARIANTS) {
        const pools = await createExecutionPools(workers);
        try {
          for (const queryCase of queryCases) {
            const search = normalizeSearchParams({ ...queryCase, debug: true });
            const explain = workers === 2 && queryCase.query === 'alpha';
            const label = `query=${queryCase.query} workers=${workers} batchOrder=${ordering.name}`;
            const { jobs, plan, result } = await executeScheduledSearch(
              {
                vault,
                search,
                analysis: testQueryAnalysis(queryCase.query),
                analyzerIdentity: analyzer.identity,
                snapshot: snapshotHandle(built, `pin-${workers}-${ordering.name}-${queryCase.query}`),
                deadline: Date.now() + 120_000,
                cancellationId: `ac6-identity-${workers}-${ordering.name}-${crypto.randomUUID()}`,
                explain,
                pool: pools.searchExecution,
              },
              ordering,
            );
            assertExhaustiveDispatchedEveryPlanUnit(plan, jobs, label);
            exhaustiveDispatchSignatures.set(
              `${workers}:${queryCase.query}:${ordering.name}`,
              JSON.stringify(dispatchSignature(jobs)),
            );
            assert.equal(JSON.stringify(normalizeScorePayload(result)), baselines.get(queryCase.query), label);
            if (explain) {
              assert.ok(result.explainTrace, 'scheduler explain should include a trace');
              const tracePath = path.join(tempRoot('optsidian-ac6-explain-'), 'trace.json');
              fs.writeFileSync(tracePath, `${JSON.stringify(result.explainTrace, null, 2)}\n`);
              const replay = spawnSync(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  path.join(repoRoot, 'scripts/search-eval.mjs'),
                  '--offline-explain-trace',
                  tracePath,
                  '--format=json',
                ],
                { cwd: repoRoot, encoding: 'utf8' },
              );
              assert.equal(
                replay.status,
                0,
                `offline replay failed\nstdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`,
              );
              const replayed = JSON.parse(replay.stdout);
              assert.equal(replayed.outputHash, result.explainTrace.expectedOutputHash);
              explainReplayChecked.add(ordering.name);
            }
          }
        } finally {
          await pools.close();
        }
      }
    }

    assert.deepEqual(
      [...explainReplayChecked].sort(),
      BATCH_ORDER_VARIANTS.map((variant) => variant.name).sort(),
      'offline explain replay should run once per batch ordering for alpha at workers=2',
    );
    assert.equal(
      queryCases.some((queryCase) =>
        workerCounts.some(
          (workers) =>
            exhaustiveDispatchSignatures.get(`${workers}:${queryCase.query}:plan-order`) !==
            exhaustiveDispatchSignatures.get(`${workers}:${queryCase.query}:reverse-pending`),
        ),
      ),
      true,
      'at least one exhaustive run should vary dispatch signatures across batch-order seams',
    );
    console.log(
      `AC6 exact-identity byte-identity: workers=${workerCounts.join('/')} batchOrders=${BATCH_ORDER_VARIANTS.map((variant) => variant.name).join('/')} queries=${queryCases.length}`,
    );
  },
);

test('AC6 bounded budget is deterministic and labeled bounded', { timeout: 240_000 }, async () => {
  const { normalizeSearchParams } = await import(path.join(repoRoot, 'src/core/search/params.ts'));
  const { SEARCH_WARNING_BOUNDED } = await import(path.join(repoRoot, 'src/core/search/internal-types.ts'));
  const { analyzer, built, vault } = await buildIdentitySnapshot(4);
  const search = normalizeSearchParams({
    query: 'needle',
    limit: 8,
    debug: true,
    coverage: 'bounded',
    budget: { shards: 4, work: 1_000_000 },
  });
  const analysis = testQueryAnalysis(search.query);
  let expectedBytes;

  for (const ordering of BATCH_ORDER_VARIANTS) {
    const pools = await createExecutionPools(2);
    try {
      const run = async (index) =>
        executeScheduledSearch(
          {
            vault,
            search,
            analysis,
            analyzerIdentity: analyzer.identity,
            snapshot: snapshotHandle(built, `pin-approx-${ordering.name}-${index}`),
            deadline: Date.now() + 120_000,
            cancellationId: `ac6-bounded-${ordering.name}-${index}-${crypto.randomUUID()}`,
            pool: pools.searchExecution,
          },
          ordering,
        );

      const first = await run(1);
      const second = await run(2);
      const firstBytes = JSON.stringify(first.result);
      const secondBytes = JSON.stringify(second.result);
      const expectedBudgetedTasks = ordering.order(first.plan.tasks.slice(0, search.budget.shards));
      const expectedSignature = expectedInitialDispatchSignature(expectedBudgetedTasks, 2);

      assert.deepEqual(first.result.warnings, [SEARCH_WARNING_BOUNDED]);
      assert.equal(
        firstBytes,
        secondBytes,
        `bounded search must be byte-deterministic for batchOrder=${ordering.name}`,
      );
      assert.deepEqual(
        dispatchSignature(first.jobs),
        dispatchSignature(second.jobs),
        `bounded dispatch order must be deterministic for batchOrder=${ordering.name}`,
      );
      assert.deepEqual(
        dispatchSignature(first.jobs),
        expectedSignature,
        `bounded dispatch must follow the ordered deterministic prefix for batchOrder=${ordering.name}`,
      );
      if (expectedBytes === undefined) expectedBytes = firstBytes;
      assert.equal(
        firstBytes,
        expectedBytes,
        `bounded search must be byte-deterministic across batchOrder=${ordering.name}`,
      );
    } finally {
      await pools.close();
    }
  }
});
