#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SEARCH_DAEMON_SLO_FIXTURE = Object.freeze({
  name: "Mixed200 warm pinned snapshot",
  gate: "opt-in benchmark outside npm test",
  corpus: "Mixed200",
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

process.exitCode = options.scoreOnly || runs.every((run) => run.failed === 0) ? 0 : 1;

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
  if (mode === "e2e") return (queryCase) => runE2eSearch(cliPath, vaultRoot, queryCase);
  try {
    const { createSearchDaemonClient } = await import("../src/daemon/client.ts");
    const client = createSearchDaemonClient({
      binaryPath: cliPath
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
  if (trace.frozenReplayFormulaVersion !== "rrf-metadata-v1/offline-1") {
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
  const candidates = trace.inputs.candidateSet.candidates.map((candidate, index) => {
    const feature = featuresByCandidate.get(candidate.candidateId) ?? featuresByCandidate.get(candidate.documentId);
    const exactPriority = priorityNumber(feature.identity?.exactPriority);
    const phrasePriority = priorityNumber(feature.identity?.phrasePriority);
    const coverageTerms = numberOrZero(feature.coverage?.terms);
    const coverageFieldScore = numberOrZero(feature.coverage?.fieldScore);
    const rarityScore = numberOrZero(feature.rarity?.score);
    const proximityScore = bestFeatureProximity(feature);
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
      proximityScore
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
  return {
    rrfK: config.rrfK,
    weights: config.weights,
    signalWeights: config.signalWeights,
    coverageBucketMinTerms: config.constants?.COVERAGE_BUCKET_MIN_TERMS ?? null
  };
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
  return score;
}

function rrfContribution(rank, weight, rrfK) {
  return weight / (rrfK + rank);
}

function compareRankedMatches(left, right) {
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
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
  if (right.proximityScore !== left.proximityScore) return right.proximityScore - left.proximityScore;
  if (right.rarityScore !== left.rarityScore) return right.rarityScore - left.rarityScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function compareCoverageRank(left, right) {
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (right.proximityScore !== left.proximityScore) return right.proximityScore - left.proximityScore;
  if (right.rarityScore !== left.rarityScore) return right.rarityScore - left.rarityScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function rankedOutputCandidate(candidate) {
  return {
    path: candidate.path,
    bucket: rankBucketName(candidate.bucket),
    score: candidate.score,
    baseRank: candidate.baseRank,
    exactPriority: nullablePriority(candidate.exactPriority),
    phrasePriority: nullablePriority(candidate.phrasePriority),
    coverageTerms: candidate.coverageTerms,
    coverageFieldScore: candidate.coverageFieldScore,
    rarityScore: candidate.rarityScore,
    proximityScore: candidate.proximityScore
  };
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

function runE2eSearch(cliPath, vaultRoot, queryCase) {
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
    env: process.env
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
    limit: queryCase.limit ?? 10
  };
}

function createFailureReport({ mode, concurrency, repeat, specPath, vaultRoot, inspectLimit, runs }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    concurrency,
    repeat,
    specPath,
    vaultRoot,
    inspectLimit,
    repeatSummary: summarizeRuns(runs),
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
      failures: run.failures.map(serializeFailure)
    }))
  };
}

function serializeFailure(failure) {
  return {
    index: failure.index,
    case: failure.case,
    elapsedMs: failure.elapsedMs,
    expected: failure.expected,
    rank: failure.rank,
    topMatches: failure.topMatches,
    ...(failure.error ? { error: failure.error } : {}),
    ...(failure.inspect ? { inspect: failure.inspect } : {})
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
  console.error("Usage: npm run search:eval -- <vault-path> [--mode=core|e2e] [--spec=<queries.json>] [--cli=<dist/optsidian>] [--quiet] [--score-only] [--concurrency=<n>] [--repeat=<n>] [--failure-report=<path>] [--failure-inspect-limit=<n>] [--no-warmup] [--no-progress]");
  console.error("       npm run search:eval -- --print-search-daemon-slo-fixture");
  process.exit(code);
}
