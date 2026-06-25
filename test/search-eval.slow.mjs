import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = process.cwd();

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map(
      (match) => match[0]
    );
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
  const terms = [...raw.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map(
    (match) => match[0]
  );
  return {
    raw,
    primaryChannel: "morph",
    primaryTerms: terms,
    channels: { morph: terms, surface: terms, ngram: [] }
  };
}

function tempRoot(prefix = "optsidian-search-eval-slow-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function futureImport(relativePath) {
  return import(path.join(repoRoot, relativePath));
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

function assertOkSpawn(result, label) {
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("search:eval offline explain trace replay validates mutations deterministically", async () => {
  const dir = tempRoot();
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha Project.md", "# Alpha Project\n\nalpha project target\n");
  writeVaultFile(vault, "Beta Project.md", "# Beta Project\n\nalpha project beta body\n");
  writeVaultFile(vault, "Gamma.md", "# Gamma\n\nunrelated\n");
  const analyzer = testAnalyzer();
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: "pin-search-eval-slow",
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      bytes: sharedHandle(segment.bytes)
    }))
  };
  const explained = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: "alpha project", limit: 5, debug: true }),
    analysis: testQueryAnalysis("alpha project"),
    analyzerIdentity: analyzer.identity,
    snapshot,
    explain: true
  });

  assert.equal(explained.ok, true);
  assert.ok(explained.explainTrace);
  assert.ok(explained.explainTrace.inputs.candidateSet.candidates.length > 0);
  assert.deepEqual(explained.explainTrace.inputs.queryAnalysis, testQueryAnalysis("alpha project"));

  const trace = explained.explainTrace;
  const tracePath = path.join(dir, "trace.json");
  fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  const replayArgs = [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/search-eval.mjs"),
    "--offline-explain-trace",
    tracePath,
    "--format=json"
  ];
  const replayEnv = {
    ...process.env,
    OPTSIDIAN_SEARCH_DAEMON_SOCKET: path.join(dir, "missing.sock"),
    OPTSIDIAN_VAULT_PATH: path.join(dir, "missing-vault")
  };
  const replay = spawnSync(process.execPath, replayArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: replayEnv
  });

  assertOkSpawn(replay, "offline explain replay");
  const replayAgain = spawnSync(process.execPath, replayArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: replayEnv
  });
  assertOkSpawn(replayAgain, "offline explain replay repeat");
  assert.equal(replayAgain.stdout, replay.stdout);
  const replayed = JSON.parse(replay.stdout);
  assert.equal(replayed.outputHash, trace.expectedOutputHash);

  const mutations = [
    ["rankingAlgorithmId", "different-ranker"],
    ["rankingConfig", { ...trace.rankingConfig, rrfK: trace.rankingConfig.rrfK + 1 }],
    ["inputs", { ...trace.inputs, candidateSet: { ...trace.inputs.candidateSet, candidates: [] } }],
    ["expectedOutputHash", "0".repeat(64)]
  ];
  for (const [key, value] of mutations) {
    const mutatedPath = path.join(dir, `trace-${key}.json`);
    fs.writeFileSync(mutatedPath, `${JSON.stringify({ ...trace, [key]: value }, null, 2)}\n`);
    const mutated = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts/search-eval.mjs"),
      "--offline-explain-trace",
      mutatedPath,
      "--format=json"
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(mutated.status, 0, `${key} mutation must fail validation`);
    assert.match(mutated.stderr || mutated.stdout, /trace validation|output hash|ranking algorithm|ranking config|candidate/i);
  }
});

test("search:eval SLO fixture is opt-in documentation", () => {
  const fixtureResult = spawnSync(process.execPath, [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/search-eval.mjs"),
    "--print-search-daemon-slo-fixture"
  ], { cwd: repoRoot, encoding: "utf8" });
  assertOkSpawn(fixtureResult, "SLO fixture");
  const fixture = JSON.parse(fixtureResult.stdout);

  assert.equal(fixture.name, "Mixed200 warm pinned snapshot");
  assert.equal(fixture.gate, "opt-in benchmark outside npm test");
  assert.deepEqual(fixture.targets, [
    { concurrency: 1, p50MsMax: 300, p95MsMax: 600 },
    { concurrency: 4, p95MsMax: 900, provisional: true },
    { concurrency: 8, p95MsMax: 1500, provisional: true },
    { concurrency: 16, p95MsMax: 2500, provisional: true }
  ]);
});

test("search:eval index benchmark reports cache and action timings", () => {
  const vault = tempRoot();
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nneedle alpha\n");
  writeVaultFile(vault, "Beta.md", "# Beta\n\nneedle beta\n");
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/search-eval.mjs",
    vault,
    "--benchmark=index",
    "--index-actions=clear-load",
    "--format=json",
    "--quiet",
    "--no-progress"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: tempRoot("optsidian-index-bench-runtime-"),
      XDG_CACHE_HOME: tempRoot("optsidian-index-bench-cache-")
    }
  });
  assertOkSpawn(result, "index benchmark");
  const report = JSON.parse(result.stdout);

  assert.equal(report.benchmark, "index");
  assert.equal(report.vault.fileCount, 2);
  assert.equal(report.actions.length, 1);
  assert.equal(report.actions[0].action, "clear-load");
  assert.equal(report.actions[0].ok, true);
  assert.ok(report.actions[0].elapsedMs > 0);
  assert.deepEqual(report.actions[0].phases.map((phase) => phase.name), ["clear", "load"]);
  assert.match(report.actions[0].snapshotId, /^[0-9a-f]{64}$/);
  assert.ok(report.cache.after.byteCount > 0);
  assert.equal(report.daemonReady.ok, true);
});
