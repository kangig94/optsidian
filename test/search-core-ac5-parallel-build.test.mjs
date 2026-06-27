import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

const repoRoot = process.cwd();

function tempRoot(prefix = "optsidian-search-ac5-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function syntheticBody(index) {
  const korean = "검색 병렬 색인 문서 토큰 위치 통계 결정성";
  const english = "parallel build deterministic byte identical snapshot scoring segment postings";
  return Array.from({ length: 80 }, (_, repeat) =>
    `${english} ${korean} doc-${index} repeat-${repeat} topic-${index % 11}`
  ).join("\n");
}

function createSyntheticVault(documentCount) {
  const vault = tempRoot();
  for (let index = 0; index < documentCount; index += 1) {
    writeVaultFile(
      vault,
      `folder-${index % 8}/Doc ${String(index).padStart(3, "0")}.md`,
      [
        "---",
        `tags: [tag-${index % 5}, ac5]`,
        "---",
        `# Parallel Build ${index}`,
        "",
        syntheticBody(index)
      ].join("\n")
    );
  }
  return vault;
}

async function buildWithIndexWorkers(vault, workers) {
  const { createDaemonPools } = await import(path.join(repoRoot, "src/daemon/pools.ts"));
  const pools = await createDaemonPools({
    ...process.env,
    OPTSIDIAN_SEARCH_ANALYZER: "intl",
    OPTSIDIAN_SEARCH_EXTRA_LANGS: "",
    OPTSIDIAN_SEARCH_QUERY_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_WORKERS: String(workers),
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: "1",
    OPTSIDIAN_SEARCH_INDEX_MICROBATCH: "8"
  }, {});
  try {
    await pools.throughputAnalyzer.warmup(workers);
    const started = performance.now();
    const built = await pools.throughputAnalyzer.buildSnapshot(vault, 3, {
      deadline: Date.now() + 180_000,
      cancellationId: `ac5-parallel-build-${workers}`,
      vault
    }, { ngram: true });
    return { built, elapsedMs: performance.now() - started };
  } finally {
    await pools.close();
  }
}

function shuffled(values) {
  return [...values].sort((left, right) => right.partitionId - left.partitionId);
}

test("AC5 parallel index build is byte-identical to one-worker build and reports speedup", { timeout: 240_000 }, async () => {
  const { INDEX_BUILD_VERSION } = await import(path.join(repoRoot, "src/daemon/search-store/builder.ts"));
  const { reduceCanonicalBm25GlobalStats, canonicalValueBytes } = await import(
    path.join(repoRoot, "src/core/search/segments/index.ts")
  );
  const { SEARCH_TOKEN_CHANNELS } = await import(path.join(repoRoot, "src/core/search/analysis/index.ts"));
  const documentCount = 160;
  const vault = createSyntheticVault(documentCount);

  const oneWorker = await buildWithIndexWorkers(vault, 1);
  const fourWorkers = await buildWithIndexWorkers(vault, 4);
  const ratio = oneWorker.elapsedMs / Math.max(fourWorkers.elapsedMs, 1);

  assert.equal(oneWorker.built.snapshotId, fourWorkers.built.snapshotId);
  assert.deepEqual(oneWorker.built.manifest, fourWorkers.built.manifest);
  assert.deepEqual(
    oneWorker.built.segments.map((segment) => Buffer.from(segment.bytes).toString("hex")),
    fourWorkers.built.segments.map((segment) => Buffer.from(segment.bytes).toString("hex"))
  );
  assert.equal(oneWorker.built.identityTuple.buildVersion, "daemon-positional-build-v5");
  assert.equal(fourWorkers.built.identityTuple.buildVersion, INDEX_BUILD_VERSION);

  const orderedStats = reduceCanonicalBm25GlobalStats(
    fourWorkers.built.segments.map((segment) => segment.bm25Stats),
    SEARCH_TOKEN_CHANNELS
  );
  const shuffledStats = reduceCanonicalBm25GlobalStats(
    shuffled(fourWorkers.built.segments).map((segment) => segment.bm25Stats),
    SEARCH_TOKEN_CHANNELS
  );
  assert.equal(
    Buffer.from(canonicalValueBytes(orderedStats)).toString("hex"),
    Buffer.from(canonicalValueBytes(shuffledStats)).toString("hex")
  );

  console.log(
    `AC5 parallel build: docs=${documentCount} snapshotId=${oneWorker.built.snapshotId} ` +
    `workers1=${oneWorker.elapsedMs.toFixed(1)}ms workers4=${fourWorkers.elapsedMs.toFixed(1)}ms ` +
    `speedup=${ratio.toFixed(2)}x`
  );
});
