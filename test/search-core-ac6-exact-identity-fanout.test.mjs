import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function tempRoot(prefix = "optsidian-search-ac6-identity-") {
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

function snapshotHandle(built, pinToken) {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes)
    }))
  };
}

// Builds a corpus where:
//   - several documents carry a distinctive single-token frontmatter title that a
//     single-term query matches EXACTLY (exact title identity -> identityScore > 0), and
//   - BM25 single-term bounds vary sharply across shards (one document concentrates a
//     rare term in a short title field), so a per-shard recompute of the exact-dominance
//     bound diverges from the corpus-wide bound.
async function buildIdentitySnapshot(partitionBits = 4) {
  const { buildCanonicalSearchSnapshot } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const vault = tempRoot();
  const titles = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  for (let index = 0; index < 80; index += 1) {
    const title = titles[index % titles.length];
    // One document gets an extreme single-term concentration in a short title field, which
    // dominates the corpus-wide single-term BM25 bound while being absent from other shards.
    const skewed = index === 7
      ? `title: ${"needle ".repeat(8)}${title}`
      : `title: ${title}`;
    writeVaultFile(
      vault,
      `folder-${index % 8}/Doc ${String(index).padStart(4, "0")}.md`,
      [
        "---",
        skewed,
        "tags: [ac6, group-" + (index % 4) + "]",
        "---",
        `# Heading ${index}`,
        "",
        Array.from({ length: 6 + (index % 5) }, (_, repeat) =>
          `common needle fanout shard partition scoring doc-${index} repeat-${repeat}`
        ).join("\n")
      ].join("\n")
    );
  }
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits });
  assert.ok(built.segments.length >= 2, "AC6 identity fixture must span at least two partitions");
  return { analyzer, built, vault };
}

function normalizeScorePayload(result) {
  return result.matches.map((match) => ({
    path: match.path,
    score: match.debug?.rerankScore,
    identityScore: match.debug?.identityScore
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

test("AC6 exact dominance bound computation reuses cached snapshot state by snapshotId", async () => {
  const {
    exactDominanceBoundForSearchHandle,
    searchExecutionCacheStats
  } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const { built } = await buildIdentitySnapshot(4);
  const search = normalizeSearchParams({ query: "alpha", limit: 10 });
  const analysis = testQueryAnalysis("alpha");
  const snapshot = snapshotHandle(built, "pin-bound-cache");
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

test("AC6 fan-out is byte-identical to monolithic for exact-identity queries across topologies", { timeout: 240_000 }, async () => {
  const { executeSearchJob } = await import(path.join(repoRoot, "src/daemon/search-execution.ts"));
  const { QueryCoordinator } = await import(path.join(repoRoot, "src/daemon/search-store/query-coordinator.ts"));
  const { normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const { analyzer, built, vault } = await buildIdentitySnapshot(4);

  // Each query exactly equals a document title, so the matched documents earn an exact
  // title identity (identityScore > 0) and their rank.score includes exactLambda * identityScore.
  const queryCases = [
    { query: "alpha", limit: 12 },
    { query: "delta", limit: 10 },
    { query: "hotel", limit: 8 }
  ];
  const workerCounts = [1, 2, 4];
  const assignments = ["identity", "reverse"];
  const baselines = new Map();
  let explainReplayChecked = false;

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
    assert.ok(
      baselinePayload.some((entry) => (entry.identityScore ?? 0) > 0),
      `query=${queryCase.query} must produce at least one exact-identity match (identityScore > 0)`
    );
    baselines.set(queryCase.query, baselinePayload);
  }

  for (const workers of workerCounts) {
    for (const assignment of assignments) {
      const pools = await createFanoutPool(workers, assignment);
      try {
        const coordinator = new QueryCoordinator(pools.searchExecution);
        for (const queryCase of queryCases) {
          const search = normalizeSearchParams({ ...queryCase, debug: true });
          const explain = !explainReplayChecked && workers === 2 && assignment === "reverse" && queryCase.query === "alpha";
          const result = await coordinator.execute({
            vault,
            search,
            analysis: testQueryAnalysis(queryCase.query),
            analyzerIdentity: analyzer.identity,
            snapshot: snapshotHandle(built, `pin-${workers}-${assignment}-${queryCase.query}`),
            deadline: Date.now() + 120_000,
            cancellationId: `ac6-identity-${workers}-${assignment}-${crypto.randomUUID()}`,
            explain
          });
          assert.deepEqual(
            normalizeScorePayload(result),
            baselines.get(queryCase.query),
            `query=${queryCase.query} workers=${workers} assignment=${assignment}`
          );
          if (explain) {
            assert.ok(result.explainTrace, "fan-out explain should include a trace");
            const tracePath = path.join(tempRoot("optsidian-ac6-explain-"), "trace.json");
            fs.writeFileSync(tracePath, `${JSON.stringify(result.explainTrace, null, 2)}\n`);
            const replay = spawnSync(process.execPath, [
              "--import",
              "tsx",
              path.join(repoRoot, "scripts/search-eval.mjs"),
              "--offline-explain-trace",
              tracePath,
              "--format=json"
            ], { cwd: repoRoot, encoding: "utf8" });
            assert.equal(replay.status, 0, `offline replay failed\nstdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`);
            const replayed = JSON.parse(replay.stdout);
            assert.equal(replayed.outputHash, result.explainTrace.expectedOutputHash);
            explainReplayChecked = true;
          }
        }
      } finally {
        await pools.close();
      }
    }
  }

  assert.equal(explainReplayChecked, true);
  console.log(`AC6 exact-identity byte-identity: workers=${workerCounts.join("/")} assignments=${assignments.join("/")} queries=${queryCases.length}`);
});
