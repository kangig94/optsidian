import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

const repoRoot = process.cwd();

function tempRoot(prefix = "optsidian-search-ac6-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testAnalyzer() {
  const tokenize = (text) => [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
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

function testQueryAnalysis(raw) {
  const terms = [...raw.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    raw,
    primaryChannel: "morph",
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] }
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
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

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength
  };
}

function snapshotHandle(built, pinToken = "pin-ac6") {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes)
    }))
  };
}

async function buildSyntheticSnapshot(documentCount, partitionBits = 4) {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const vault = tempRoot();
  for (let index = 0; index < documentCount; index += 1) {
    const group = `group-${index % 4}`;
    const topic = index % 2 === 0 ? "alpha" : "beta";
    writeVaultFile(
      vault,
      `folder-${index % 8}/Doc ${String(index).padStart(4, "0")}.md`,
      [
        "---",
        `tags: [ac6, ${group}]`,
        "---",
        `# Target ${index} ${topic}`,
        "",
        Array.from({ length: 12 }, (_, repeat) =>
          `common needle fanout ${topic} shard partition scoring doc-${index} repeat-${repeat} exact-${index}`
        ).join("\n")
      ].join("\n")
    );
  }
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits
  });
  assert.ok(built.segments.length >= 2, "AC6 fixture must span at least two partitions");
  return { analyzer, built, vault };
}

function normalizeScorePayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    score: match.debug?.rerankScore
  }));
}

async function createFanoutPool(workers, assignment) {
  const { createDaemonPools } = await import(path.join(repoRoot, "src/daemon/pools.ts"));
  const env = {
    ...process.env,
    OPTSIDIAN_SEARCH_ANALYZER: "intl",
    OPTSIDIAN_SEARCH_EXTRA_LANGS: "",
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(workers),
    OPTSIDIAN_SEARCH_FANOUT_ASSIGNMENT: assignment
  };
  return createDaemonPools(env, {});
}

test("AC6 shard finalist equal-score tie-break follows path order", async () => {
  const { sortedSearchShardFinalists } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const finalist = ({ path: relPath, documentId, identityScore = 0 }) => ({
    documentId,
    path: relPath,
    shardDocRef: { segmentId: "segment", localDocId: 0 },
    score: 1,
    queryTerms: ["needle"],
    queryChannels: { morph: ["needle"], surface: [], ngram: [] },
    matchedChannels: ["morph"],
    channelScores: { morph: 1 },
    source: "persisted",
    candidate: {
      candidateId: documentId,
      documentId,
      path: relPath,
      shardDocRef: { segmentId: "segment", localDocId: 0 },
      retrievalScore: 1,
      channels: [],
      phraseMatches: [],
      proximityMatches: []
    },
    rank: {
      path: relPath,
      title: relPath,
      tags: [],
      bucket: 3,
      score: 10,
      baseRank: 1,
      exactPriority: Number.POSITIVE_INFINITY,
      phrasePriority: Number.POSITIVE_INFINITY,
      coverageTerms: 0,
      coverageFieldScore: 0,
      lexicalScore: 10,
      identityScore,
      exactLambda: 0,
      denseAgreement: 0,
      rarityScore: 0,
      proximityScore: 0,
      bodyScore: 0
    },
    feature: { candidate: { candidateId: documentId, documentId, path: relPath, shardDocRef: { segmentId: "segment", localDocId: 0 } } }
  });

  const sorted = sortedSearchShardFinalists([
    finalist({ path: "b.md", documentId: "0000", identityScore: 1 }),
    finalist({ path: "a.md", documentId: "ffff" })
  ]);

  assert.deepEqual(sorted.map((entry) => entry.path), ["a.md", "b.md"]);
});

test("AC6 fan-out results are byte-identical to monolithic across worker counts and partition assignments", { timeout: 240_000 }, async () => {
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { QueryCoordinator } = await import(path.join(repoRoot, "src/daemon/search-store/query-coordinator.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const { analyzer, built, vault } = await buildSyntheticSnapshot(64, 4);
  const queryCases = [
    { query: "needle common", limit: 12 },
    { query: "target 17", fields: ["title", "body"], limit: 8 },
    { query: "needle beta", tags: ["group-1"], limit: 10 }
  ];
  const workerCounts = [1, 2, 4];
  const assignments = ["identity", "reverse"];
  const baselines = new Map();

  for (const queryCase of queryCases) {
    const search = normalizeSearchParams({ ...queryCase, debug: true });
    const baseline = executeSearchJob({
      vault,
      search,
      analysis: testQueryAnalysis(queryCase.query),
      analyzerIdentity: analyzer.identity,
      snapshot: snapshotHandle(built, "pin-monolithic")
    });
    const baselinePayload = normalizeScorePayload(baseline);
    assert.ok(baselinePayload.length > 0, `baseline should return matches for ${queryCase.query}`);
    baselines.set(queryCase.query, baselinePayload);
  }

  for (const workers of workerCounts) {
    for (const assignment of assignments) {
      const pools = await createFanoutPool(workers, assignment);
      try {
        const coordinator = new QueryCoordinator(pools.searchExecution);
        for (const [queryIndex, queryCase] of queryCases.entries()) {
          const search = normalizeSearchParams({ ...queryCase, debug: true });
          const result = await coordinator.execute({
            vault,
            search,
            analysis: testQueryAnalysis(queryCase.query),
            analyzerIdentity: analyzer.identity,
            snapshot: snapshotHandle(built, `pin-${workers}-${assignment}-${queryCase.query}`),
            deadline: Date.now() + 120_000,
            cancellationId: `ac6-topology-${workers}-${assignment}-${queryIndex}`
          });
        assert.deepEqual(
          normalizeScorePayload(result),
          baselines.get(queryCase.query),
          `query=${queryCase.query} workers=${workers} assignment=${assignment}`
        );
      }
      } finally {
        await pools.close();
      }
    }
  }

  console.log(`AC6 topology byte-identity: workers=${workerCounts.join("/")} assignments=${assignments.join("/")} queries=${queryCases.length}`);
});

test("AC6 shard failure cancels siblings, waits all settled, fails whole query, and releases the pin", { timeout: 60_000 }, async () => {
  const { DaemonSearchStoreService } = await import(path.join(repoRoot, "src/daemon/search-store/service.ts"));
  const { analyzer, built, vault } = await buildSyntheticSnapshot(32, 3);
  const snapshot = snapshotHandle(built, "pin-life");
  const pin = { snapshotId: snapshot.snapshotId, pinToken: "pin-life" };
  const released = [];
  const cancelled = [];
  let siblingSettled = false;
  let dispatchedJobs = 0;
  const terminalError = Object.assign(new Error("simulated shard failure"), { code: "INTERNAL" });
  const fakeStore = {
    pin: async () => pin,
    snapshotHandleForPin: () => snapshot,
    release: (inputPin) => {
      released.push(inputPin.pinToken);
    },
    searchAnalyzerIdentity: () => analyzer.identity
  };
  const fakeSearchExecution = {
    dispatchSearchShards: async (jobs) => {
      dispatchedJobs = jobs.length;
      return jobs.map((job, index) => ({
        job,
        slotId: index + 1,
        promise: index === 0
          ? Promise.resolve().then(() => {
              throw terminalError;
            })
          : new Promise((resolve) => {
              setTimeout(() => {
                siblingSettled = true;
                resolve({
                  snapshotId: job.snapshot.snapshotId,
                  partitionIds: job.snapshot.segments.map((segment) => segment.partitionId),
                  requestedLimit: job.requestedLimit,
                  workEstimate: job.workEstimate,
                  scoredCount: 0,
                  finalists: []
                });
              }, 25);
            })
      }));
    },
    cancel: (cancellationId) => {
      cancelled.push(cancellationId);
    }
  };
  const service = new DaemonSearchStoreService(
    fakeStore,
    {
      analyzerIdentity: analyzer.identity,
      analyzeQuery: async (raw) => ({
        analyzerIdentity: analyzer.identity,
        analysis: testQueryAnalysis(raw)
      })
    },
    fakeSearchExecution,
    { queryCacheSize: 1 }
  );

  await assert.rejects(
    () => service.search(
      { vault, query: "needle common", limit: 5 },
      { deadline: Date.now() + 10_000, cancellationId: "ac6-life", requestId: "ac6-life" }
    ),
    (error) => error === terminalError
  );

  assert.ok(dispatchedJobs >= 2, "fixture should dispatch sibling shard jobs");
  assert.deepEqual(cancelled, ["ac6-life"]);
  assert.equal(siblingSettled, true, "coordinator must wait for every shard to settle before returning");
  assert.deepEqual(released, ["pin-life"]);
});

test("AC6 single-query fan-out latency report", { timeout: 240_000 }, async () => {
  const { QueryCoordinator } = await import(path.join(repoRoot, "src/daemon/search-store/query-coordinator.ts"));
  const { createDaemonPools } = await import(path.join(repoRoot, "src/daemon/pools.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const documentCount = 160;
  const { analyzer, built, vault } = await buildSyntheticSnapshot(documentCount, 4);
  const search = normalizeSearchParams({ query: "common needle fanout alpha", limit: 20, debug: true });
  const analysis = testQueryAnalysis(search.query);
  const repetitions = 5;
  const baseline = normalizeScorePayload(executeSearchJob({
    vault,
    search,
    analysis,
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built, "pin-latency-monolithic")
  }));
  assert.ok(baseline.length > 0, "latency baseline should return matches");

  async function measure(workers) {
    const pools = await createDaemonPools({
      ...process.env,
      OPTSIDIAN_SEARCH_ANALYZER: "intl",
      OPTSIDIAN_SEARCH_EXTRA_LANGS: "",
      OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
      OPTSIDIAN_SEARCH_INDEX_WORKERS: "1",
      OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(workers),
      OPTSIDIAN_SEARCH_FANOUT_ASSIGNMENT: "identity"
    }, {});
    try {
      const coordinator = new QueryCoordinator(pools.searchExecution);
      await coordinator.execute({
        vault,
        search,
        analysis,
        analyzerIdentity: analyzer.identity,
        snapshot: snapshotHandle(built, `pin-latency-warm-${workers}`),
        deadline: Date.now() + 120_000,
        cancellationId: `ac6-latency-warm-${workers}`
      });
      const timings = [];
      for (let index = 0; index < repetitions; index += 1) {
        const started = performance.now();
        const result = await coordinator.execute({
          vault,
          search,
          analysis,
          analyzerIdentity: analyzer.identity,
          snapshot: snapshotHandle(built, `pin-latency-${workers}-${index}`),
          deadline: Date.now() + 120_000,
          cancellationId: `ac6-latency-${workers}-${index}`
        });
        assert.deepEqual(
          normalizeScorePayload(result),
          baseline,
          `latency fan-out result must match monolithic baseline (workers=${workers} index=${index})`
        );
        timings.push(performance.now() - started);
      }
      return percentiles(timings);
    } finally {
      await pools.close();
    }
  }

  const one = await measure(1);
  const four = await measure(4);
  console.log(
    `AC6 latency: docs=${documentCount} reps=${repetitions} ` +
    `workers1_p50=${one.p50.toFixed(1)}ms workers1_p95=${one.p95.toFixed(1)}ms ` +
    `workers4_p50=${four.p50.toFixed(1)}ms workers4_p95=${four.p95.toFixed(1)}ms`
  );
});

function percentiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95)
  };
}

function percentile(sorted, q) {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[Math.max(0, index)];
}
