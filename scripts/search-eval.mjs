#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SEARCH_DAEMON_SLO_FIXTURE = Object.freeze({
  name: "Mixed600 warm pinned snapshot",
  gate: "opt-in benchmark outside npm test",
  corpus: "Mixed600",
  envelope: {
    node: ">=20",
    storage: "local SSD",
    minLogicalCpu: 4,
    snapshot: "warm pinned snapshot",
    analyzerPools: "warmed"
  },
  targets: [
    { concurrency: 1, p50MsMax: 300, p95MsMax: 600 },
    { concurrency: 4, p95MsMax: 900, provisional: true },
    { concurrency: 8, p95MsMax: 1500, provisional: true },
    { concurrency: 16, p95MsMax: 2500, provisional: true }
  ],
  semantics: {
    deadline: "Every request honors a queue deadline.",
    cancellation: "Every request is cancellable.",
    backpressure: "Low-priority background work is shed or deferred before query work.",
    determinism: "Deadline and cancellation change success vs error only; never ordering, partial results, or repin."
  }
});
const INDEX_BENCHMARK_ACTIONS = new Set(["load", "rebuild", "clear", "clear-load", "clear-rebuild"]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--print-search-daemon-slo-fixture")) {
  console.log(JSON.stringify(SEARCH_DAEMON_SLO_FIXTURE, null, 2));
  process.exit(0);
}
const options = parseOptions(args);
if (options.offlineExplainTrace) {
  runOfflineExplainTrace(options);
  process.exit(0);
}
const benchmark = options.benchmark ?? (options.indexActions ? "index" : "quality");
if (benchmark === "index") {
  const report = await runIndexBenchmark(options);
  if (options.format === "json") console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.actions.every((action) => action.ok) ? 0 : 1;
} else {
  const runs = await runQualityBenchmark(options);
  process.exitCode = options.scoreOnly || runs.every((run) => run.failed === 0) ? 0 : 1;
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage(undefined, 0);
    } else if (arg.startsWith("--spec=")) {
      parsed.spec = path.resolve(arg.slice("--spec=".length));
    } else if (arg.startsWith("--cli=")) {
      parsed.cli = path.resolve(arg.slice("--cli=".length));
    } else if (arg.startsWith("--vault=")) {
      parsed.vault = path.resolve(arg.slice("--vault=".length));
    } else if (arg.startsWith("--vault-path=")) {
      parsed.vault = path.resolve(arg.slice("--vault-path=".length));
    } else if (arg.startsWith("vault-path=")) {
      parsed.vault = path.resolve(arg.slice("vault-path=".length));
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
      if (parsed.mode !== "core" && parsed.mode !== "e2e") {
        usage("mode must be one of: core, e2e");
      }
    } else if (arg.startsWith("--benchmark=")) {
      parsed.benchmark = parseBenchmark(arg.slice("--benchmark=".length));
    } else if (arg.startsWith("--bench=")) {
      parsed.benchmark = parseBenchmark(arg.slice("--bench=".length));
    } else if (arg.startsWith("--ngram=")) {
      parsed.ngram = parseBooleanOption(arg.slice("--ngram=".length), "ngram");
    } else if (arg.startsWith("--index-actions=")) {
      parsed.indexActions = parseIndexActions(arg.slice("--index-actions=".length));
    } else if (arg.startsWith("--index-action=")) {
      parsed.indexActions ??= [];
      parsed.indexActions.push(...parseIndexActions(arg.slice("--index-action=".length)));
    } else if (arg.startsWith("--deadline-ms=")) {
      parsed.deadlineMs = parsePositiveInt(arg.slice("--deadline-ms=".length), "deadline-ms");
    } else if (arg.startsWith("--suite=")) {
      parsed.suites ??= [];
      parsed.suites.push(parseSuite(arg.slice("--suite=".length)));
    } else if (arg.startsWith("--offline-explain-trace=")) {
      parsed.offlineExplainTrace = path.resolve(arg.slice("--offline-explain-trace=".length));
    } else if (arg === "--offline-explain-trace") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) usage("--offline-explain-trace requires a path");
      parsed.offlineExplainTrace = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--format=")) {
      parsed.format = arg.slice("--format=".length);
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--score-only") {
      parsed.scoreOnly = true;
      parsed.quiet = true;
    } else if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = parsePositiveInt(arg.slice("--concurrency=".length), "concurrency");
    } else if (arg.startsWith("--repeat=")) {
      parsed.repeat = parsePositiveInt(arg.slice("--repeat=".length), "repeat");
    } else if (arg.startsWith("--failure-report=")) {
      parsed.failureReport = path.resolve(arg.slice("--failure-report=".length));
    } else if (arg === "--failure-report") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) usage("--failure-report requires a path");
      parsed.failureReport = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--failure-inspect-limit=")) {
      parsed.failureInspectLimit = parsePositiveInt(arg.slice("--failure-inspect-limit=".length), "failure-inspect-limit");
    } else if (arg === "--no-warmup") {
      parsed.noWarmup = true;
    } else if (arg === "--no-progress") {
      parsed.noProgress = true;
    } else if (!parsed.vault) {
      parsed.vault = path.resolve(arg);
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function runQualityBenchmark(options) {
  const mode = options.mode ?? "core";
  const concurrency = options.concurrency ?? 1;
  const vaultRoot = options.vault ?? process.env.OPTSIDIAN_VAULT_PATH;

  if (!vaultRoot) {
    usage("Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.");
  }

  const specPath = options.spec ?? path.join(vaultRoot, "SearchEval", "queries.json");
  const cliPath = options.cli ?? path.join(repoRoot, "dist", "optsidian");

  if (!fs.existsSync(specPath)) usage(`Query spec not found: ${specPath}`);
  if (mode === "e2e" && !fs.existsSync(cliPath)) usage(`Optsidian CLI not found: ${cliPath}. Run npm run build first.`);

  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  if (!Array.isArray(spec.queries)) usage(`Query spec must contain a queries array: ${specPath}`);
  const repeat = options.repeat ?? 1;
  const runSearch = await searchRunner(mode, cliPath, vaultRoot, options);

  if (!options.noWarmup && spec.queries.length > 0) {
    await runSearch({ ...spec.queries[0], limit: 1 });
  }

  const runs = [];
  for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
    const run = await runEvaluation(spec.queries, concurrency, runSearch, options, runIndex);
    runs.push(run);
    printRunSummary(run, { mode, concurrency, repeat, runIndex });
  }

  if (repeat > 1) {
    printRepeatSummary(runs, { mode, concurrency });
  }

  if (options.failureReport) {
    writeFailureReport(options.failureReport, createFailureReport({
      mode,
      concurrency,
      repeat,
      specPath,
      vaultRoot,
      inspectLimit: options.failureInspectLimit ?? 50,
      runs
    }));
  }

  return runs;
}

async function runIndexBenchmark(options) {
  const mode = options.mode ?? "core";
  if (mode !== "core") usage("--benchmark=index supports --mode=core only");
  if (options.failureReport) usage("--failure-report is only supported by --benchmark=quality");
  if (options.scoreOnly) usage("--score-only is only supported by --benchmark=quality");
  if (options.format && options.format !== "json" && options.format !== "text") usage("--benchmark=index supports --format=json or --format=text");
  const vaultRoot = options.vault ?? process.env.OPTSIDIAN_VAULT_PATH;
  if (!vaultRoot) {
    usage("Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.");
  }
  const cliPath = options.cli ?? path.join(repoRoot, "dist", "optsidian");
  const repeat = options.repeat ?? 1;
  const actions = options.indexActions?.length ? options.indexActions : ["clear-load", "rebuild", "load"];
  const { createSearchDaemonClient } = await import("../src/daemon/client.ts");
  const { searchStoreCachePaths } = await import("../src/daemon/search-store/cache-paths.ts");
  const client = createSearchDaemonClient({ binaryPath: cliPath, env: searchEvalEnv(options) });
  const vault = markdownVaultStats(vaultRoot);
  const cachePaths = safeCachePaths(searchStoreCachePaths, vault.root);
  const cacheBefore = cachePaths ? directoryStats(cachePaths.rootDir) : undefined;
  const daemonReady = await timedPhase("daemon-ready", () => client.status({ deadlineMs: options.deadlineMs ?? 15000 }));
  const benchmarkActions = [];

  for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
    for (const action of actions) {
      const result = await runIndexAction(client, vault.root, action, {
        deadlineMs: options.deadlineMs,
        cacheRoot: cachePaths?.rootDir
      });
      const enriched = { runIndex, ...result };
      benchmarkActions.push(enriched);
      if (!options.quiet && options.format !== "json") {
        printIndexAction(enriched, { repeat, vault });
      }
    }
  }

  const finalStatus = await client.status({ deadlineMs: options.deadlineMs ?? 15000 }).catch((error) => ({
    error: error instanceof Error ? error.message : String(error)
  }));
  const report = {
    schemaVersion: 1,
    benchmark: "index",
    generatedAt: new Date().toISOString(),
    mode,
    repeat,
    actionsRequested: actions,
    vault,
    cache: {
      rootDir: cachePaths?.rootDir,
      before: cacheBefore,
      after: cachePaths ? directoryStats(cachePaths.rootDir) : undefined
    },
    daemonReady: {
      ok: daemonReady.ok,
      elapsedMs: daemonReady.elapsedMs,
      ...(daemonReady.ok ? { memory: statusMemorySummary(daemonReady.value) } : { error: daemonReady.error })
    },
    actions: benchmarkActions,
    finalStatus: compactStatus(finalStatus, vault.root)
  };
  if (!options.quiet && options.format !== "json") printIndexSummary(report);
  return report;
}

async function runIndexAction(client, vaultRoot, action, options) {
  const phases = [];
  const request = { vault: vaultRoot, ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) };
  const started = performance.now();
  let payload;
  try {
    if (action === "load") {
      payload = await recordPhase(phases, "load", () => client.loadVault(request));
    } else if (action === "rebuild") {
      payload = await recordPhase(phases, "rebuild", () => client.rebuild(request));
    } else if (action === "clear") {
      payload = await recordPhase(phases, "clear", () => client.clear(request));
    } else if (action === "clear-load") {
      await recordPhase(phases, "clear", () => client.clear(request));
      payload = await recordPhase(phases, "load", () => client.loadVault(request));
    } else if (action === "clear-rebuild") {
      await recordPhase(phases, "clear", () => client.clear(request));
      payload = await recordPhase(phases, "rebuild", () => client.rebuild(request));
    } else {
      usage(`Unknown index action: ${action}`);
    }
    const elapsedMs = roundMs(performance.now() - started);
    const status = await client.status({ deadlineMs: options.deadlineMs ?? 15000 }).catch((error) => ({
      error: error instanceof Error ? error.message : String(error)
    }));
    return {
      action,
      ok: true,
      elapsedMs,
      phases,
      snapshotId: payloadSnapshotId(payload) ?? vaultStatus(status, vaultRoot)?.snapshotId,
      vault: vaultStatus(status, vaultRoot),
      cache: options.cacheRoot ? directoryStats(options.cacheRoot) : undefined,
      memory: statusMemorySummary(status),
      searchStore: status.searchStore
    };
  } catch (error) {
    return {
      action,
      ok: false,
      elapsedMs: roundMs(performance.now() - started),
      phases,
      error: error instanceof Error ? error.message : String(error),
      cache: options.cacheRoot ? directoryStats(options.cacheRoot) : undefined
    };
  }
}

async function recordPhase(phases, name, run) {
  const phase = await timedPhase(name, run);
  phases.push(phase.ok
    ? { name, ok: true, elapsedMs: phase.elapsedMs, snapshotId: payloadSnapshotId(phase.value) }
    : { name, ok: false, elapsedMs: phase.elapsedMs, error: phase.error });
  if (!phase.ok) throw new Error(phase.error);
  return phase.value;
}

async function timedPhase(name, run) {
  const started = performance.now();
  try {
    const value = await run();
    return {
      name,
      ok: true,
      elapsedMs: roundMs(performance.now() - started),
      value
    };
  } catch (error) {
    return {
      name,
      ok: false,
      elapsedMs: roundMs(performance.now() - started),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseBenchmark(raw) {
  if (raw === "search") return "quality";
  if (raw === "quality" || raw === "index") return raw;
  usage("benchmark must be one of: quality, search, index");
}

function parseIndexActions(raw) {
  const actions = raw.split(",").map((action) => action.trim()).filter(Boolean);
  if (actions.length === 0) usage("index-actions must include at least one action");
  for (const action of actions) {
    if (!INDEX_BENCHMARK_ACTIONS.has(action)) {
      usage(`index action must be one of: ${[...INDEX_BENCHMARK_ACTIONS].join(", ")}`);
    }
  }
  return actions;
}

function markdownVaultStats(vaultRoot) {
  const root = fs.realpathSync(vaultRoot);
  const files = visibleMarkdownFiles(root);
  let byteCount = 0;
  for (const file of files) byteCount += fs.statSync(file).size;
  return {
    root,
    fileCount: files.length,
    byteCount,
    mib: mibNumber(byteCount)
  };
}

function visibleMarkdownFiles(root, start = root) {
  const output = [];
  for (const entry of safeReadDir(start)) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(start, entry.name);
    if (entry.isDirectory()) {
      output.push(...visibleMarkdownFiles(root, abs));
      continue;
    }
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".md") continue;
    output.push(abs);
  }
  return output;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function safeCachePaths(searchStoreCachePaths, vaultRoot) {
  try {
    return searchStoreCachePaths(vaultRoot);
  } catch {
    return undefined;
  }
}

function directoryStats(root) {
  const stats = { exists: fs.existsSync(root), files: 0, byteCount: 0, mib: 0 };
  if (!stats.exists) return stats;
  const visit = (dir) => {
    for (const entry of safeReadDir(dir)) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        stats.files += 1;
        stats.byteCount += fs.statSync(abs).size;
      }
    }
  };
  visit(root);
  stats.mib = mibNumber(stats.byteCount);
  return stats;
}

function payloadSnapshotId(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  return typeof payload.snapshotId === "string" ? payload.snapshotId : undefined;
}

function vaultStatus(status, vaultRoot) {
  if (!status || status.error || !Array.isArray(status.vaults)) return undefined;
  const resolved = path.resolve(vaultRoot);
  return status.vaults.find((candidate) => path.resolve(candidate.vault) === resolved);
}

function statusMemorySummary(status) {
  if (!status || status.error || !status.pools) return undefined;
  const pools = [
    status.pools.latencyAnalyzer,
    status.pools.throughputAnalyzer,
    status.pools.searchExecution
  ].filter(Boolean);
  const daemonRssValues = pools
    .map((pool) => pool.processMemory?.rss)
    .filter((value) => Number.isFinite(value));
  let workerRssObservedMaxBytes = 0;
  let workerHeapUsedBytes = 0;
  let completedJobs = 0;
  for (const pool of pools) {
    for (const slot of pool.slots ?? []) {
      const rss = slot.lastMemory?.rss;
      const heapUsed = slot.lastMemory?.heapUsed;
      if (Number.isFinite(rss)) workerRssObservedMaxBytes = Math.max(workerRssObservedMaxBytes, rss);
      if (Number.isFinite(heapUsed)) workerHeapUsedBytes += heapUsed;
      if (Number.isFinite(slot.completedJobs)) completedJobs += slot.completedJobs;
    }
  }
  return {
    daemonRssBytes: daemonRssValues.length > 0 ? Math.max(...daemonRssValues) : undefined,
    workerRssObservedMaxBytes,
    workerHeapUsedBytes,
    completedJobs
  };
}

function compactStatus(status, vaultRoot) {
  if (!status || status.error) return status;
  return {
    ready: status.ready,
    phase: status.phase,
    metrics: status.metrics,
    vault: vaultStatus(status, vaultRoot),
    memory: statusMemorySummary(status),
    searchStore: status.searchStore
  };
}

function printIndexAction(result, context) {
  const status = result.ok ? "ok" : "fail";
  const snapshot = shortId(result.snapshotId ?? result.vault?.snapshotId);
  const cache = result.cache ? formatBytes(result.cache.byteCount) : "n/a";
  const rss = result.memory?.daemonRssBytes ? formatBytes(result.memory.daemonRssBytes) : "n/a";
  const phases = result.phases.map((phase) => `${phase.name}=${phase.elapsedMs.toFixed(1)}ms`).join(",");
  console.log([
    "index:",
    `run=${result.runIndex}/${context.repeat}`,
    `action=${result.action}`,
    status,
    `elapsed=${result.elapsedMs.toFixed(1)}ms`,
    `files=${context.vault.fileCount}`,
    `md=${formatBytes(context.vault.byteCount)}`,
    `cache=${cache}`,
    `rss=${rss}`,
    `snapshot=${snapshot || "none"}`,
    `phases=${phases || "none"}`
  ].join(" "));
  if (!result.ok) console.log(`       error: ${result.error}`);
}

function printIndexSummary(report) {
  const daemon = report.daemonReady.ok
    ? `daemonReady=${report.daemonReady.elapsedMs.toFixed(1)}ms`
    : `daemonReady=failed:${report.daemonReady.error}`;
  console.log(`index.summary: benchmark=index repeat=${report.repeat} ${daemon} vaultFiles=${report.vault.fileCount} vaultBytes=${formatBytes(report.vault.byteCount)}`);
  for (const action of report.actionsRequested) {
    const runs = report.actions.filter((candidate) => candidate.action === action);
    const ok = runs.filter((run) => run.ok);
    const sorted = ok.map((run) => run.elapsedMs).sort((left, right) => left - right);
    console.log([
      "index.summary:",
      `action=${action}`,
      `ok=${ok.length}/${runs.length}`,
      `median=${median(sorted).toFixed(1)}ms`,
      `avg=${average(sorted).toFixed(1)}ms`,
      `p95=${percentile(sorted, 95).toFixed(1)}ms`
    ].join(" "));
  }
}

function shortId(value) {
  return typeof value === "string" && value.length > 12 ? value.slice(0, 12) : value;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
}

function mibNumber(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(3));
}

async function runEvaluation(queryCases, concurrency, runSearch, options, runIndex) {
  let passed = 0;
  let failed = 0;
  const timings = [];
  const overallMetrics = createMetrics();
  const taskMetrics = new Map();
  const failures = [];

  const runStarted = performance.now();
  await runQueryCases(queryCases, concurrency, async (queryCase, caseIndex) => {
    const started = performance.now();
    const result = await runSearch(queryCase);
    const elapsed = performance.now() - started;
    timings.push(elapsed);

    if (!result.ok) {
      failed += 1;
      recordMetrics(overallMetrics, undefined, elapsed);
      recordTaskMetrics(taskMetrics, queryCase, undefined, elapsed);
      failures.push(createFailure({ queryCase, caseIndex, elapsed, error: result.error }));
      if (!options.quiet) printCase("FAIL", elapsed, queryLabel(queryCase), result.error);
      return;
    }

    const paths = result.payload.matches.map((match) => match.path);
    const rank = expectedRank(paths, queryCase);
    recordMetrics(overallMetrics, rank, elapsed);
    recordTaskMetrics(taskMetrics, queryCase, rank, elapsed);
    const ok = matchesExpectation(paths, queryCase);
    if (ok) {
      passed += 1;
      if (!options.quiet) printCase("OK", elapsed, queryLabel(queryCase), paths.slice(0, 3).join(" | "));
    } else {
      failed += 1;
      failures.push(createFailure({ queryCase, caseIndex, elapsed, paths, rank }));
      if (!options.quiet) {
        printCase("FAIL", elapsed, queryLabel(queryCase), paths.slice(0, 3).join(" | "));
        const expected = expectedPaths(queryCase).join(", ") || "(no expectation)";
        console.log(`      expected: ${expected}`);
      }
    }
  });

  const runElapsed = performance.now() - runStarted;
  failures.sort((left, right) => left.index - right.index);

  if (options.failureReport && failures.length > 0) {
    await inspectFailures(failures, runSearch, options.failureInspectLimit ?? 50);
  }

  return {
    runIndex,
    passed,
    failed,
    total: passed + failed,
    elapsedMs: runElapsed,
    timings,
    overallMetrics,
    taskMetrics,
    failures
  };
}

async function runQueryCases(queryCases, concurrency, runCase) {
  if (concurrency <= 1) {
    for (let index = 0; index < queryCases.length; index += 1) await runCase(queryCases[index], index);
    return;
  }
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, queryCases.length) }, async () => {
    while (nextIndex < queryCases.length) {
      const caseIndex = nextIndex;
      const queryCase = queryCases[caseIndex];
      nextIndex += 1;
      await runCase(queryCase, caseIndex);
    }
  });
  await Promise.all(workers);
}

function parsePositiveInt(raw, name) {
  if (!/^\d+$/.test(raw)) usage(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) usage(`${name} must be a positive integer`);
  return parsed;
}

async function searchRunner(mode, cliPath, vaultRoot, options) {
  if (mode === "e2e") return (queryCase) => runE2eSearch(cliPath, vaultRoot, queryCase, options);
  try {
    const { createSearchDaemonClient } = await import("../src/daemon/client.ts");
    const client = createSearchDaemonClient({
      binaryPath: cliPath,
      env: searchEvalEnv(options)
    });
    let pinnedSnapshotId = await loadPinnedSnapshotId(client, vaultRoot, {
      progress: shouldRenderProgress(options)
    });
    return async (queryCase) => {
      try {
        const payload = await client.search({
          vault: vaultRoot,
          ...(pinnedSnapshotId ? { snapshotId: pinnedSnapshotId } : {}),
          ...coreSearchParams(queryCase)
        });
        if (!pinnedSnapshotId && payload.snapshotId) pinnedSnapshotId = payload.snapshotId;
        return { ok: true, payload };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };
  } catch (error) {
    usage(`Core mode failed to prepare the search daemon: ${error.message}`);
  }
}

function parseSuite(raw) {
  const split = raw.indexOf(":");
  if (split <= 0) usage("--suite must be NAME:/path/to/queries.json");
  return {
    name: raw.slice(0, split),
    spec: path.resolve(raw.slice(split + 1))
  };
}

function runOfflineExplainTrace(options) {
  if (options.format && options.format !== "json") usage("--offline-explain-trace only supports --format=json");
  const trace = JSON.parse(fs.readFileSync(options.offlineExplainTrace, "utf8"));
  validateOfflineExplainTrace(trace);
  const rankedOutput = replayOfflineExplainTrace(trace);
  const outputHash = sha256(canonicalJson(rankedOutput));
  if (outputHash !== trace.expectedOutputHash) {
    throwTraceValidation(`output hash mismatch: expected ${trace.expectedOutputHash}, got ${outputHash}`);
  }
  console.log(JSON.stringify({ rankedOutput, outputHash }, null, 2));
}

function validateOfflineExplainTrace(trace) {
  if (trace?.schemaVersion !== 1) throwTraceValidation("trace validation failed: schemaVersion must be 1");
  if (trace.rankingAlgorithmId !== "rrf-metadata-v1") {
    throwTraceValidation(`ranking algorithm mismatch: ${trace.rankingAlgorithmId}`);
  }
  if (trace.frozenReplayFormulaVersion !== "rrf-metadata-v1/offline-2") {
    throwTraceValidation(`ranking algorithm replay formula mismatch: ${trace.frozenReplayFormulaVersion}`);
  }
  if (!deepEqualCanonical(trace.rankingConfig, trace.inputs?.rankingConfig)) {
    throwTraceValidation("ranking config mismatch between trace header and inputs");
  }
  if (!trace.inputs?.candidateSet || !Array.isArray(trace.inputs.candidateSet.candidates) || trace.inputs.candidateSet.candidates.length === 0) {
    throwTraceValidation("candidate set is empty or missing");
  }
  if (!Array.isArray(trace.inputs?.featurePayloads)) {
    throwTraceValidation("candidate feature payloads are missing");
  }
  if (!trace.inputs?.queryAnalysis || typeof trace.inputs.queryAnalysis !== "object") {
    throwTraceValidation("query analysis is missing");
  }
  if (typeof trace.expectedOutputHash !== "string" || !/^[0-9a-f]{64}$/.test(trace.expectedOutputHash)) {
    throwTraceValidation("expected output hash is missing or invalid");
  }
  const featuresByCandidate = featurePayloadMap(trace.inputs.featurePayloads);
  for (const candidate of trace.inputs.candidateSet.candidates) {
    if (!candidate?.candidateId || !candidate?.documentId) throwTraceValidation("candidate is missing candidateId/documentId");
    if (!featuresByCandidate.get(candidate.candidateId) && !featuresByCandidate.get(candidate.documentId)) {
      throwTraceValidation(`candidate feature payload missing for ${candidate.candidateId}`);
    }
  }
}

function replayOfflineExplainTrace(trace) {
  const config = normalizeRankingConfig(trace.rankingConfig);
  const featuresByCandidate = featurePayloadMap(trace.inputs.featurePayloads);
  const bodyScoresByCandidate = normalizedBodyScores(trace.inputs.featurePayloads, trace.inputs.queryAnalysis, config);
  const candidates = trace.inputs.candidateSet.candidates.map((candidate, index) => {
    const feature = featuresByCandidate.get(candidate.candidateId) ?? featuresByCandidate.get(candidate.documentId);
    const exactPriority = priorityNumber(feature.identity?.exactPriority);
    const phrasePriority = Math.min(
      priorityNumber(feature.identity?.phrasePriority),
      priorityNumber(bestReplayBodyPhrasePriority(feature, trace.inputs.queryAnalysis, config))
    );
    const coverageTerms = numberOrZero(feature.coverage?.terms);
    const coverageFieldScore = numberOrZero(feature.coverage?.fieldScore);
    const rarityScore = numberOrZero(feature.rarity?.score);
    const proximityScore = bestFeatureProximity(feature);
    const bodyScore = bodyScoresByCandidate.get(candidate.candidateId) ?? bodyScoresByCandidate.get(candidate.documentId) ?? 0;
    return {
      path: candidate.path ?? feature.candidate?.path ?? candidate.documentId,
      bucket: rankBucket(exactPriority, phrasePriority, coverageTerms, config),
      score: 0,
      baseRank: index + 1,
      exactPriority,
      phrasePriority,
      coverageTerms,
      coverageFieldScore,
      rarityScore,
      proximityScore,
      bodyScore,
      includeBodyScore: config.includeBodyScore
    };
  });
  const identityRanks = rankMap(candidates.filter((candidate) => candidate.bucket === 0), compareIdentityRank);
  const phraseRanks = rankMap(candidates.filter((candidate) => candidate.bucket === 1), comparePhraseRank);
  const coverageRanks = rankMap(candidates.filter((candidate) => candidate.bucket === 1 || candidate.bucket === 2), compareCoverageRank);
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate, identityRanks, phraseRanks, coverageRanks, config)
    }))
    .sort(compareRankedMatches)
    .map(rankedOutputCandidate);
}

function normalizeRankingConfig(config) {
  const signalWeights = config.signalWeights ?? {};
  const constants = config.constants ?? {};
  const includeBodyScore = Object.prototype.hasOwnProperty.call(signalWeights, "body");
  return {
    rrfK: config.rrfK,
    weights: config.weights,
    signalWeights: {
      rarity: numberOrZero(signalWeights.rarity),
      proximity: numberOrZero(signalWeights.proximity),
      body: includeBodyScore ? numberOrZero(signalWeights.body) : 0
    },
    includeBodyScore,
    tokenChannelWeights: constants.SEARCH_TOKEN_CHANNEL_WEIGHT ?? { morph: 1, surface: 0.65, ngram: 0.3 },
    coverageBucketMinTerms: constants.COVERAGE_BUCKET_MIN_TERMS ?? null,
    bodyPhrasePriority: constants.PHRASE_PRIORITY?.body ?? 5
  };
}

function normalizedBodyScores(features, queryAnalysis, config) {
  const scores = new Map();
  if (!config.includeBodyScore || !shouldUseBodyRankSignal(queryAnalysis)) return scores;
  const rawScores = [];
  let maxBodyScore = 0;
  for (const feature of features) {
    const keys = [feature?.candidate?.candidateId, feature?.candidate?.documentId].filter(Boolean);
    if (keys.length === 0) continue;
    const bodyScore = featureBodyScore(feature, config);
    rawScores.push({ keys, bodyScore });
    if (bodyScore > maxBodyScore) maxBodyScore = bodyScore;
  }
  if (maxBodyScore <= 0) return scores;
  for (const entry of rawScores) {
    for (const key of entry.keys) scores.set(key, entry.bodyScore / maxBodyScore);
  }
  return scores;
}

function shouldUseBodyRankSignal(queryAnalysis) {
  if (/[\uac00-\ud7af]/u.test(queryAnalysis.raw ?? "")) return false;
  let asciiTerms = 0;
  for (const term of queryAnalysis.channels?.surface ?? []) {
    if (!/[a-z]/i.test(term)) continue;
    asciiTerms += 1;
    if (asciiTerms >= 4) return true;
  }
  return false;
}

function featureBodyScore(feature, config) {
  let score = 0;
  for (const term of feature?.bm25 ?? []) {
    if (term.field !== "body") continue;
    score += numberOrZero(term.score) * numberOrZero(config.tokenChannelWeights[term.channel]);
  }
  return score;
}

function bestReplayBodyPhrasePriority(feature, queryAnalysis, config) {
  if ((feature.phrasePositions ?? []).some((match) => match.field === "body")) return config.bodyPhrasePriority;
  const compactRaw = compactBodyPhrase(queryAnalysis.raw ?? "");
  if (
    compactRaw.length > 1 &&
    (feature.snippetScoringInputs ?? []).some((input) => compactBodyPhrase(input.text ?? "").includes(compactRaw))
  ) {
    return config.bodyPhrasePriority;
  }
  const surfaceTerms = queryAnalysis.channels?.surface ?? [];
  if (surfaceTerms.length === 0) return undefined;
  return (feature.snippetScoringInputs ?? []).some((input) =>
    containsTokenSequence(input.channels?.surface ?? [], surfaceTerms)
  )
    ? config.bodyPhrasePriority
    : undefined;
}

function compactBodyPhrase(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

function containsTokenSequence(tokens, sequence) {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[start + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function featurePayloadMap(features) {
  const byCandidate = new Map();
  for (const feature of features) {
    if (feature?.candidate?.candidateId) byCandidate.set(feature.candidate.candidateId, feature);
    if (feature?.candidate?.documentId) byCandidate.set(feature.candidate.documentId, feature);
  }
  return byCandidate;
}

function rankBucket(exactPriority, phrasePriority, coverageTerms, config = { coverageBucketMinTerms: null }) {
  if (Number.isFinite(exactPriority)) return 0;
  if (Number.isFinite(phrasePriority)) return 1;
  if (config.coverageBucketMinTerms === null) return coverageTerms > 0 ? 2 : 3;
  if (coverageTerms >= config.coverageBucketMinTerms) return 2;
  return 3;
}

function rankMap(candidates, compare) {
  return new Map([...candidates].sort(compare).map((candidate, index) => [candidate.path, index + 1]));
}

function rerankScore(candidate, identityRanks, phraseRanks, coverageRanks, config) {
  let score = rrfContribution(candidate.baseRank, config.weights.base, config.rrfK);
  if (candidate.bucket === 0) {
    const rank = identityRanks.get(candidate.path);
    if (rank) score += rrfContribution(rank, config.weights.identity, config.rrfK);
  } else if (candidate.bucket === 1) {
    const phraseRank = phraseRanks.get(candidate.path);
    if (phraseRank) score += rrfContribution(phraseRank, config.weights.phrase, config.rrfK);
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, config.weights.coverage, config.rrfK);
  } else if (candidate.bucket === 2) {
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, config.weights.coverage, config.rrfK);
  }
  score += candidate.rarityScore * config.signalWeights.rarity;
  score += candidate.proximityScore * config.signalWeights.proximity;
  score += candidate.bodyScore * config.signalWeights.body;
  return score;
}

function rrfContribution(rank, weight, rrfK) {
  return weight / (rrfK + rank);
}

function compareRankedMatches(left, right) {
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  const priorityCompare = compareBucketPriority(left, right);
  if (priorityCompare !== 0) return priorityCompare;
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
}

function compareBucketPriority(left, right) {
  if (left.bucket === 0) return priorityNumber(left.exactPriority) - priorityNumber(right.exactPriority);
  if (left.bucket === 1) return priorityNumber(left.phrasePriority) - priorityNumber(right.phrasePriority);
  return 0;
}

function compareIdentityRank(left, right) {
  if (left.exactPriority !== right.exactPriority) return left.exactPriority - right.exactPriority;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function comparePhraseRank(left, right) {
  if (left.phrasePriority !== right.phrasePriority) return left.phrasePriority - right.phrasePriority;
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (right.bodyScore !== left.bodyScore) return right.bodyScore - left.bodyScore;
  if (right.proximityScore !== left.proximityScore) return right.proximityScore - left.proximityScore;
  if (right.rarityScore !== left.rarityScore) return right.rarityScore - left.rarityScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function compareCoverageRank(left, right) {
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (right.bodyScore !== left.bodyScore) return right.bodyScore - left.bodyScore;
  if (right.proximityScore !== left.proximityScore) return right.proximityScore - left.proximityScore;
  if (right.rarityScore !== left.rarityScore) return right.rarityScore - left.rarityScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function rankedOutputCandidate(candidate) {
  const output = {
    path: candidate.path,
    bucket: rankBucketName(candidate.bucket),
    score: candidate.score,
    baseRank: candidate.baseRank,
    exactPriority: nullablePriority(candidate.exactPriority),
    phrasePriority: nullablePriority(candidate.phrasePriority),
    coverageTerms: candidate.coverageTerms,
    coverageFieldScore: candidate.coverageFieldScore,
    rarityScore: candidate.rarityScore,
    proximityScore: candidate.proximityScore,
    ...(candidate.includeBodyScore ? { bodyScore: candidate.bodyScore } : {})
  };
  return output;
}

function rankBucketName(bucket) {
  if (bucket === 0) return "exact";
  if (bucket === 1) return "phrase";
  if (bucket === 2) return "coverage";
  return "base";
}

function bestFeatureProximity(feature) {
  let best = 0;
  for (const match of feature.proximity ?? []) {
    best = Math.max(best, numberOrZero(match.score) * fieldWeight(match.field) * channelWeight(match.channel));
  }
  return best;
}

function fieldWeight(field) {
  const boost = { title: 8, tags: 7, aliases: 6, headings: 4, path: 2, body: 1 };
  return (boost[field] ?? 1) / boost.title;
}

function channelWeight(channel) {
  return { morph: 1, surface: 0.65, ngram: 0.3 }[channel] ?? 0;
}

function priorityNumber(value) {
  return value === null || value === undefined ? Number.POSITIVE_INFINITY : Number(value);
}

function nullablePriority(value) {
  return Number.isFinite(value) ? value : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function throwTraceValidation(message) {
  console.error(`trace validation failed: ${message}`);
  process.exit(2);
}

function deepEqualCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function ratioNumber(value) {
  return value.toFixed(3);
}

async function loadPinnedSnapshotId(client, vaultRoot, options = {}) {
  await withWarmupProgress(client, vaultRoot, options, () => client.loadVault({ vault: vaultRoot }));
  const status = await client.status();
  const resolvedVault = path.resolve(vaultRoot);
  const vault = status.vaults.find((candidate) => path.resolve(candidate.vault) === resolvedVault);
  if (!vault?.snapshotId) {
    const error = vault?.error ? `: ${vault.error}` : "";
    throw new Error(`warm LoadVault did not produce a snapshot${error}`);
  }
  return vault.snapshotId;
}

async function withWarmupProgress(client, vaultRoot, options, run) {
  if (!options.progress) return run();

  let lastLength = 0;
  let polling = false;
  const write = (line) => {
    const padded = line.padEnd(lastLength);
    lastLength = Math.max(lastLength, line.length);
    process.stderr.write(`\r${padded}`);
  };
  const clear = () => {
    if (lastLength > 0) process.stderr.write(`\r${" ".repeat(lastLength)}\r`);
  };
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      write(renderWarmupProgress(await client.status({ deadlineMs: 1000 }), vaultRoot));
    } catch {
      write(`warmup loading ${path.basename(path.resolve(vaultRoot))}`);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 500);
  timer.unref();
  void poll();
  try {
    return await run();
  } finally {
    clearInterval(timer);
    clear();
  }
}

function shouldRenderProgress(options) {
  return options.noProgress !== true && process.stderr.isTTY === true;
}

function renderWarmupProgress(status, vaultRoot) {
  const resolvedVault = path.resolve(vaultRoot);
  const vault = status.vaults.find((candidate) => path.resolve(candidate.vault) === resolvedVault);
  if (!vault?.progress) return `warmup ${vault?.state ?? "loading"} ${path.basename(resolvedVault)}`;
  const progress = vault.progress;
  const completed = progress.completed ?? 0;
  const total = progress.total;
  const ratio = total && total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  const filled = total === undefined ? 0 : Math.round(ratio * 20);
  const bar = `[${"#".repeat(filled)}${".".repeat(20 - filled)}]`;
  const percent = total && total > 0 ? `${Math.floor(ratio * 100).toString().padStart(3)}%` : " --%";
  const counts = total === undefined ? String(completed) : `${completed}/${total}`;
  const current = progress.current ? ` ${truncateMiddle(progress.current, 36)}` : "";
  const message = progress.message ? ` ${progress.message}` : "";
  return `warmup ${progress.phase} ${bar} ${percent} ${counts} ${path.basename(resolvedVault)}${current}${message}`;
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function coreSearchParams(queryCase) {
  return {
    query: queryCase.query || undefined,
    path: queryCase.path,
    tags: parseTags(queryCase),
    fields: parseFields(queryCase.field),
    limit: queryCase.limit ?? 10,
    deadlineMs: queryCase.deadlineMs ?? 30000
  };
}

function runE2eSearch(cliPath, vaultRoot, queryCase, options) {
  const cliArgs = [
    cliPath,
    "search",
    "format=json",
    `limit=${queryCase.limit ?? 10}`,
    `vault-path=${vaultRoot}`
  ];
  if (queryCase.query) cliArgs.push(`query=${queryCase.query}`);
  const tags = parseTags(queryCase);
  if (tags?.length) cliArgs.push(`tag=${tags.join(",")}`);
  if (queryCase.path) cliArgs.push(`path=${queryCase.path}`);
  const fields = parseFields(queryCase.field);
  if (fields?.length) cliArgs.push(`field=${fields.join(",")}`);

  const child = spawnSync(process.execPath, cliArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: searchEvalEnv(options)
  });

  if (child.status !== 0) {
    return { ok: false, error: child.stderr.trim() || child.stdout.trim() || `exit ${child.status}` };
  }

  try {
    return { ok: true, payload: JSON.parse(child.stdout) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}\n${child.stdout}` };
  }
}

function parseTags(queryCase) {
  if (Array.isArray(queryCase.tags)) return queryCase.tags;
  if (Array.isArray(queryCase.tag)) return queryCase.tag;
  if (queryCase.tag) return String(queryCase.tag).split(",").map((tag) => tag.trim()).filter(Boolean);
  return undefined;
}

function parseFields(value) {
  if (Array.isArray(value)) return value;
  if (!value) return undefined;
  return String(value).split(",").map((field) => field.trim()).filter(Boolean);
}

function searchEvalEnv(options) {
  return {
    ...process.env,
    OPTSIDIAN_SEARCH_NGRAM: options.ngram === true ? "true" : "false"
  };
}

function parseBooleanOption(raw, name) {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  usage(`${name} must be on or off`);
}

function matchesExpectation(paths, queryCase) {
  if (queryCase.expected) return paths.includes(queryCase.expected);
  if (queryCase.expectFirst) return paths[0] === queryCase.expectFirst;
  if (queryCase.expectIncludes) return queryCase.expectIncludes.every((expected) => paths.includes(expected));
  return true;
}

function expectedPaths(queryCase) {
  if (queryCase.expected) return [queryCase.expected];
  if (queryCase.expectFirst) return [queryCase.expectFirst];
  if (queryCase.expectIncludes) return queryCase.expectIncludes;
  return [];
}

function expectedRank(paths, queryCase) {
  const expected = new Set(expectedPaths(queryCase));
  if (expected.size === 0) return undefined;
  const index = paths.findIndex((candidate) => expected.has(candidate));
  return index === -1 ? 0 : index + 1;
}

function createMetrics() {
  return {
    total: 0,
    top1: 0,
    recall3: 0,
    recall5: 0,
    recall10: 0,
    reciprocalRank: 0,
    timings: []
  };
}

function recordTaskMetrics(taskMetrics, queryCase, rank, elapsed) {
  if (!queryCase.task) return;
  if (!taskMetrics.has(queryCase.task)) taskMetrics.set(queryCase.task, createMetrics());
  recordMetrics(taskMetrics.get(queryCase.task), rank, elapsed);
}

function recordMetrics(metrics, rank, elapsed) {
  metrics.total += 1;
  metrics.timings.push(elapsed);
  if (rank === undefined) return;
  if (rank === 1) metrics.top1 += 1;
  if (rank > 0 && rank <= 3) metrics.recall3 += 1;
  if (rank > 0 && rank <= 5) metrics.recall5 += 1;
  if (rank > 0 && rank <= 10) {
    metrics.recall10 += 1;
    metrics.reciprocalRank += 1 / rank;
  }
}

function metricsLine(label, metrics) {
  const sortedTimings = [...metrics.timings].sort((a, b) => a - b);
  const denominator = metrics.total || 1;
  return [
    `${label}: n=${metrics.total}`,
    `top1=${ratio(metrics.top1, denominator)}`,
    `recall@3=${ratio(metrics.recall3, denominator)}`,
    `recall@5=${ratio(metrics.recall5, denominator)}`,
    `recall@10=${ratio(metrics.recall10, denominator)}`,
    `mrr@10=${ratio(metrics.reciprocalRank, denominator)}`,
    `avg=${average(metrics.timings).toFixed(1)}ms`,
    `p50=${percentile(sortedTimings, 50).toFixed(1)}ms`,
    `p95=${percentile(sortedTimings, 95).toFixed(1)}ms`
  ].join(" ");
}

function printRunSummary(run, context) {
  const sortedTimings = [...run.timings].sort((a, b) => a - b);
  const prefix = context.repeat > 1 ? `run ${context.runIndex}/${context.repeat} ` : "";
  const summary = [
    `${prefix}summary: mode=${context.mode}`,
    `concurrency=${context.concurrency}`,
    `${run.passed}/${run.total} passed,`,
    `total=${run.elapsedMs.toFixed(1)}ms,`,
    `qps=${queriesPerSecond(run.total, run.elapsedMs)},`,
    `p50=${percentile(sortedTimings, 50).toFixed(1)}ms,`,
    `p95=${percentile(sortedTimings, 95).toFixed(1)}ms`
  ].join(" ");
  console.log(summary);
  printPrefixedMetrics("score", run.overallMetrics, prefix);
  if (run.taskMetrics.size > 0) {
    for (const [task, metrics] of [...run.taskMetrics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      printPrefixedMetrics(`score.${task}`, metrics, prefix);
    }
  }
}

function printPrefixedMetrics(label, metrics, prefix) {
  const line = metricsLine(label, metrics);
  console.log(prefix ? `${prefix}${line}` : line);
}

function printRepeatSummary(runs, context) {
  const total = runs[0]?.total ?? 0;
  const scoreSummaries = runs.map((run) => summarizeMetrics(run.overallMetrics));
  const summary = [
    `repeat: runs=${runs.length}`,
    `mode=${context.mode}`,
    `concurrency=${context.concurrency}`,
    `passedMedian=${median(runs.map((run) => run.passed)).toFixed(1)}/${total}`,
    `top1Median=${median(scoreSummaries.map((score) => score.top1)).toFixed(3)}`,
    `recall@10Median=${median(scoreSummaries.map((score) => score.recall10)).toFixed(3)}`,
    `mrr@10Median=${median(scoreSummaries.map((score) => score.mrr10)).toFixed(3)}`,
    `avgMedian=${median(scoreSummaries.map((score) => score.avgMs)).toFixed(1)}ms`,
    `p50Median=${median(scoreSummaries.map((score) => score.p50Ms)).toFixed(1)}ms`,
    `p95Median=${median(scoreSummaries.map((score) => score.p95Ms)).toFixed(1)}ms`
  ].join(" ");
  console.log(summary);
}

async function inspectFailures(failures, runSearch, inspectLimit) {
  for (const failure of failures) {
    const scoringLimit = failure.case.limit ?? 10;
    const limit = Math.max(scoringLimit, inspectLimit);
    if (failure.error && limit === scoringLimit) continue;
    const result = await runSearch({ ...failure.queryCase, limit });
    if (!result.ok) {
      failure.inspect = { limit, ok: false, error: result.error };
      continue;
    }
    const paths = result.payload.matches.map((match) => match.path);
    failure.inspect = {
      limit,
      ok: true,
      rank: expectedRank(paths, failure.queryCase) ?? null,
      topMatches: paths.slice(0, Math.min(paths.length, limit))
    };
  }
}

function createFailure({ queryCase, caseIndex, elapsed, error, paths = [], rank }) {
  return {
    index: caseIndex,
    case: reportQueryCase(queryCase),
    queryCase,
    elapsedMs: roundMs(elapsed),
    expected: expectedPaths(queryCase),
    rank: rank ?? null,
    topMatches: paths.slice(0, Math.min(paths.length, queryCase.limit ?? 10)),
    ...(error ? { error } : {})
  };
}

function reportQueryCase(queryCase) {
  return {
    ...(queryCase.id !== undefined ? { id: queryCase.id } : {}),
    ...(queryCase.task !== undefined ? { task: queryCase.task } : {}),
    ...(queryCase.query !== undefined ? { query: queryCase.query } : {}),
    ...(queryCase.path !== undefined ? { path: queryCase.path } : {}),
    ...(queryCase.field !== undefined ? { field: queryCase.field } : {}),
    ...(queryCase.tag !== undefined ? { tag: queryCase.tag } : {}),
    ...(queryCase.tags !== undefined ? { tags: queryCase.tags } : {}),
    expectation: failureExpectationKind(queryCase),
    limit: queryCase.limit ?? 10
  };
}

function failureExpectationKind(queryCase) {
  if (queryCase.expected) {
    return "any";
  }
  if (queryCase.expectFirst) {
    return "first";
  }
  if (queryCase.expectIncludes) {
    return "includes";
  }
  return "none";
}

function createFailureReport({ mode, concurrency, repeat, specPath, vaultRoot, inspectLimit, runs }) {
  const allFailures = runs.flatMap((run) => run.failures);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode,
    concurrency,
    repeat,
    specPath,
    vaultRoot,
    inspectLimit,
    repeatSummary: summarizeRuns(runs),
    failureSummary: summarizeFailures(allFailures),
    runs: runs.map((run) => ({
      runIndex: run.runIndex,
      passed: run.passed,
      failed: run.failed,
      total: run.total,
      elapsedMs: roundMs(run.elapsedMs),
      score: summarizeMetrics(run.overallMetrics),
      taskScores: Object.fromEntries(
        [...run.taskMetrics.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([task, metrics]) => [task, summarizeMetrics(metrics)])
      ),
      failureSummary: summarizeFailures(run.failures),
      failures: run.failures.map(serializeFailure)
    }))
  };
}

function serializeFailure(failure) {
  const classification = classifyFailure(failure);

  return {
    index: failure.index,
    case: failure.case,
    elapsedMs: failure.elapsedMs,
    expected: failure.expected,
    rank: failure.rank,
    topMatches: failure.topMatches,
    classification,
    ...(failure.error ? { error: failure.error } : {}),
    ...(failure.inspect ? { inspect: failure.inspect } : {})
  };
}

function summarizeFailures(failures) {
  const summary = emptyFailureSummary();

  for (const failure of failures) {
    const classification = classifyFailure(failure);
    countFailure(summary, classification);

    const task = failure.case.task ?? "unknown";
    summary.byTask[task] ??= emptyFailureTaskSummary();
    countFailure(summary.byTask[task], classification);
  }

  return finalizeFailureSummary(summary);
}

function emptyFailureSummary() {
  return {
    ...emptyFailureTaskSummary(),
    byTask: {}
  };
}

function emptyFailureTaskSummary() {
  return {
    total: 0,
    top1Miss: 0,
    topKMiss: 0,
    top10Miss: 0,
    top50Missing: 0,
    rerankMiss: 0,
    candidateLimit: 0,
    lexicalMissing: 0,
    errors: 0,
    byKind: {}
  };
}

function countFailure(summary, classification) {
  summary.total += 1;
  summary.byKind[classification.kind] = (summary.byKind[classification.kind] ?? 0) + 1;

  if (classification.top1Miss) {
    summary.top1Miss += 1;
  }
  if (classification.topKMiss) {
    summary.topKMiss += 1;
  }
  if (classification.top10Miss) {
    summary.top10Miss += 1;
  }
  if (classification.top50Missing) {
    summary.top50Missing += 1;
  }
  if (classification.rerankMiss) {
    summary.rerankMiss += 1;
  }
  if (classification.candidateLimit) {
    summary.candidateLimit += 1;
  }
  if (classification.lexicalMissing) {
    summary.lexicalMissing += 1;
  }
  if (classification.error) {
    summary.errors += 1;
  }
}

function finalizeFailureSummary(summary) {
  const finalized = {
    ...summary,
    byKind: sortedCountRecord(summary.byKind)
  };

  if (summary.byTask) {
    finalized.byTask = Object.fromEntries(
      Object.entries(summary.byTask)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([task, taskSummary]) => [
          task,
          {
            ...taskSummary,
            byKind: sortedCountRecord(taskSummary.byKind)
          }
        ])
    );
  }

  return finalized;
}

function sortedCountRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function classifyFailure(failure) {
  const scoringLimit = failure.case.limit ?? 10;
  const scoringRank = failure.rank;
  const inspect = failure.inspect;
  const inspectOk = inspect?.ok === true;
  const inspectLimit = inspect?.limit;
  const inspectReturned = inspectOk ? inspect.topMatches.length : undefined;
  const inspectRank = inspectOk ? inspect.rank : null;
  const scoringMiss = scoringRank === null || scoringRank === 0;
  const inspectMiss = inspectOk && (inspectRank === null || inspectRank === 0);
  const inspectHit = inspectOk && inspectRank > 0;
  const error = Boolean(failure.error) || inspect?.ok === false;
  const top1Miss =
    failure.case.expectation === "first" && scoringRank !== null && scoringRank > 1;
  const topKMiss = scoringMiss;
  const top10Miss = topKMiss && scoringLimit >= 10;
  const top50Missing = inspectLimit >= 50 && inspectMiss;
  const rerankMiss = topKMiss && inspectHit;
  const candidateLimit = inspectMiss && inspectReturned >= inspectLimit;
  const lexicalMissing = inspectMiss && inspectReturned < inspectLimit;

  let kind = "expectation-mismatch";
  if (error) {
    kind = failure.error ? "search-error" : "inspect-error";
  } else if (top1Miss) {
    kind = "top1-miss";
  } else if (rerankMiss) {
    kind = "rerank-miss";
  } else if (candidateLimit) {
    kind = "candidate-limit";
  } else if (lexicalMissing) {
    kind = "lexical-missing";
  } else if (topKMiss) {
    kind = "topk-miss";
  }

  return {
    kind,
    scoringLimit,
    scoringRank,
    ...(inspectLimit !== undefined ? { inspectLimit } : {}),
    ...(inspectOk ? { inspectRank, inspectReturned } : {}),
    top1Miss,
    topKMiss,
    top10Miss,
    top50Missing,
    rerankMiss,
    candidateLimit,
    lexicalMissing,
    error
  };
}

function summarizeRuns(runs) {
  const scoreSummaries = runs.map((run) => summarizeMetrics(run.overallMetrics));
  return {
    runs: runs.length,
    total: runs[0]?.total ?? 0,
    passedMedian: median(runs.map((run) => run.passed)),
    failedMedian: median(runs.map((run) => run.failed)),
    top1Median: median(scoreSummaries.map((summary) => summary.top1)),
    recall10Median: median(scoreSummaries.map((summary) => summary.recall10)),
    mrr10Median: median(scoreSummaries.map((summary) => summary.mrr10)),
    avgMsMedian: median(scoreSummaries.map((summary) => summary.avgMs)),
    p50MsMedian: median(scoreSummaries.map((summary) => summary.p50Ms)),
    p95MsMedian: median(scoreSummaries.map((summary) => summary.p95Ms))
  };
}

function summarizeMetrics(metrics) {
  const sortedTimings = [...metrics.timings].sort((a, b) => a - b);
  const denominator = metrics.total || 1;
  return {
    n: metrics.total,
    top1: Number(ratio(metrics.top1, denominator)),
    recall3: Number(ratio(metrics.recall3, denominator)),
    recall5: Number(ratio(metrics.recall5, denominator)),
    recall10: Number(ratio(metrics.recall10, denominator)),
    mrr10: Number(ratio(metrics.reciprocalRank, denominator)),
    avgMs: roundMs(average(metrics.timings)),
    p50Ms: roundMs(percentile(sortedTimings, 50)),
    p95Ms: roundMs(percentile(sortedTimings, 95))
  };
}

function writeFailureReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const tmpPath = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmpPath, reportPath);
}

function ratio(numerator, denominator) {
  return (numerator / denominator).toFixed(3);
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function queriesPerSecond(total, elapsedMs) {
  if (elapsedMs <= 0) return "0.000";
  return ((total / elapsedMs) * 1000).toFixed(3);
}

function queryLabel(queryCase) {
  if (queryCase.tag && !queryCase.query) return `tag:${queryCase.tag}`;
  return queryCase.query ?? "(empty query)";
}

function printCase(status, elapsed, label, details) {
  const paddedStatus = status.padEnd(4);
  const paddedMs = `${elapsed.toFixed(1)}ms`.padStart(8);
  console.log(`${paddedStatus} ${paddedMs} ${label} -> ${details}`);
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percent / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error("Usage: npm run search:eval -- <vault-path> [--benchmark=quality|index] [--mode=core|e2e] [--spec=<queries.json>] [--cli=<dist/optsidian>] [--ngram=off|on] [--quiet] [--score-only] [--concurrency=<n>] [--repeat=<n>] [--failure-report=<path>] [--failure-inspect-limit=<n>] [--no-warmup] [--no-progress]");
  console.error("       npm run search:eval -- <vault-path> --benchmark=index [--index-actions=clear-load,rebuild,load] [--ngram=off|on] [--repeat=<n>] [--deadline-ms=<n>] [--format=json]");
  console.error("       npm run search:eval -- --print-search-daemon-slo-fixture");
  process.exit(code);
}
