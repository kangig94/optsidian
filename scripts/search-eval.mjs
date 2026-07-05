#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const SEARCH_DAEMON_SLO_FIXTURE = Object.freeze({
  name: 'IR qrels warm pinned snapshot',
  gate: 'opt-in benchmark outside npm test',
  corpus: 'IR qrels fixture',
  envelope: {
    node: '>=24.15.0',
    storage: 'local SSD',
    minLogicalCpu: 4,
    snapshot: 'warm pinned snapshot',
    analyzerPools: 'warmed',
  },
  targets: [
    { concurrency: 1, p50MsMax: 300, p95MsMax: 600 },
    { concurrency: 4, p95MsMax: 900, provisional: true },
    { concurrency: 8, p95MsMax: 1500, provisional: true },
    { concurrency: 16, p95MsMax: 2500, provisional: true },
  ],
  semantics: {
    deadline: 'Every request honors a queue deadline.',
    cancellation: 'Every request is cancellable.',
    backpressure: 'Low-priority background work is shed or deferred before query work.',
    determinism: 'Deadline and cancellation change success vs error only; never ordering, partial results, or repin.',
  },
});
const INDEX_BENCHMARK_ACTIONS = new Set(['load', 'rebuild', 'clear', 'clear-load', 'clear-rebuild']);
const SEARCH_TOKEN_CHANNELS = ['morph', 'surface', 'ngram'];
const SPEED_MEASUREMENT_REPEAT = 3;
const MODEL_ENCODE_P0_BENCHMARK = 'model-encode-p0';
const MODEL_ENCODE_P0_DEFAULT_MODELS = ['bge-m3', 'multilingual-e5-small'];
const MODEL_ENCODE_P0_DEFAULT_EXECUTION_PROVIDERS = ['cuda', 'cpu'];
const MODEL_ENCODE_P0_DEFAULT_SEQ_LENGTHS = [32, 128, 512];
const MODEL_ENCODE_P0_DEFAULT_BATCH_SIZES = [1, 4, 8];
const MODEL_ENCODE_P0_DEFAULT_OVERFLOW_WIDTHS = [1, 2];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--print-search-daemon-slo-fixture')) {
  console.log(JSON.stringify(SEARCH_DAEMON_SLO_FIXTURE, null, 2));
  process.exit(0);
}
const options = parseOptions(args);
if (options.offlineExplainTrace) {
  runOfflineExplainTrace(options);
  process.exit(0);
}
const benchmark = options.benchmark ?? (options.indexActions ? 'index' : 'quality');
if (benchmark === MODEL_ENCODE_P0_BENCHMARK) {
  const report = options.p0DryRun ? modelEncodeP0DryRunReport(options) : await runModelEncodeP0Benchmark(options);
  if (options.format === 'json' || options.p0DryRun) console.log(JSON.stringify(report, null, 2));
  else printModelEncodeP0Summary(report);
  process.exitCode = report.ok === false ? 1 : 0;
} else if (benchmark === 'index') {
  const report = await runIndexBenchmark(options);
  if (options.format === 'json') console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.actions.every((action) => action.ok) ? 0 : 1;
} else {
  const runs = await runQualityBenchmark(options);
  process.exitCode = options.scoreOnly || runs.every((run) => run.failed === 0) ? 0 : 1;
}

function parseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage(undefined, 0);
    } else if (arg.startsWith('--spec=')) {
      parsed.spec = path.resolve(arg.slice('--spec='.length));
    } else if (arg.startsWith('--cli=')) {
      parsed.cli = path.resolve(arg.slice('--cli='.length));
    } else if (arg.startsWith('--vault=')) {
      parsed.vault = path.resolve(arg.slice('--vault='.length));
    } else if (arg.startsWith('--vault-path=')) {
      parsed.vault = path.resolve(arg.slice('--vault-path='.length));
    } else if (arg.startsWith('vault-path=')) {
      parsed.vault = path.resolve(arg.slice('vault-path='.length));
    } else if (arg.startsWith('--mode=')) {
      parsed.mode = arg.slice('--mode='.length);
      if (parsed.mode !== 'core' && parsed.mode !== 'e2e') {
        usage('mode must be one of: core, e2e');
      }
    } else if (arg.startsWith('--benchmark=')) {
      parsed.benchmark = parseBenchmark(arg.slice('--benchmark='.length));
    } else if (arg.startsWith('--bench=')) {
      parsed.benchmark = parseBenchmark(arg.slice('--bench='.length));
    } else if (arg.startsWith('--model=')) {
      parsed.p0Models = parseStringList(arg.slice('--model='.length), 'model');
    } else if (arg.startsWith('--models=')) {
      parsed.p0Models = parseStringList(arg.slice('--models='.length), 'models');
    } else if (arg.startsWith('--execution-providers=')) {
      parsed.p0ExecutionProviders = parseExecutionProviders(arg.slice('--execution-providers='.length));
    } else if (arg.startsWith('--execution-provider=')) {
      parsed.p0ExecutionProviders = parseExecutionProviders(arg.slice('--execution-provider='.length));
    } else if (arg.startsWith('--seq-lengths=')) {
      parsed.p0SeqLengths = parsePositiveIntList(arg.slice('--seq-lengths='.length), 'seq-lengths');
    } else if (arg.startsWith('--batch-sizes=')) {
      parsed.p0BatchSizes = parsePositiveIntList(arg.slice('--batch-sizes='.length), 'batch-sizes');
    } else if (arg.startsWith('--overflow-widths=')) {
      parsed.p0OverflowWidths = parsePositiveIntList(arg.slice('--overflow-widths='.length), 'overflow-widths');
    } else if (arg.startsWith('--p0-query-count=')) {
      parsed.p0QueryCount = parsePositiveInt(arg.slice('--p0-query-count='.length), 'p0-query-count');
    } else if (arg.startsWith('--p0-bulk-units=')) {
      parsed.p0BulkUnits = parsePositiveInt(arg.slice('--p0-bulk-units='.length), 'p0-bulk-units');
    } else if (arg.startsWith('--p0-fairness-units=')) {
      parsed.p0FairnessUnits = parsePositiveInt(arg.slice('--p0-fairness-units='.length), 'p0-fairness-units');
    } else if (arg.startsWith('--p0-turnstile-seq=')) {
      parsed.p0TurnstileSeq = parsePositiveInt(arg.slice('--p0-turnstile-seq='.length), 'p0-turnstile-seq');
    } else if (arg.startsWith('--p0-turnstile-batch=')) {
      parsed.p0TurnstileBatch = parsePositiveInt(arg.slice('--p0-turnstile-batch='.length), 'p0-turnstile-batch');
    } else if (arg.startsWith('--p0-probe-repeat=')) {
      parsed.p0ProbeRepeat = parsePositiveInt(arg.slice('--p0-probe-repeat='.length), 'p0-probe-repeat');
    } else if (arg.startsWith('--p0-timeout-ms=')) {
      parsed.p0TimeoutMs = parsePositiveInt(arg.slice('--p0-timeout-ms='.length), 'p0-timeout-ms');
    } else if (arg === '--p0-dry-run') {
      parsed.p0DryRun = true;
    } else if (arg.startsWith('--ngram=')) {
      parsed.ngram = parseBooleanOption(arg.slice('--ngram='.length), 'ngram');
    } else if (arg.startsWith('--retrieval=')) {
      parsed.retrieval = parseRetrieval(arg.slice('--retrieval='.length));
    } else if (arg.startsWith('--index-actions=')) {
      parsed.indexActions = parseIndexActions(arg.slice('--index-actions='.length));
    } else if (arg.startsWith('--index-action=')) {
      parsed.indexActions ??= [];
      parsed.indexActions.push(...parseIndexActions(arg.slice('--index-action='.length)));
    } else if (arg.startsWith('--deadline-ms=')) {
      parsed.deadlineMs = parsePositiveInt(arg.slice('--deadline-ms='.length), 'deadline-ms');
    } else if (arg.startsWith('--suite=')) {
      parsed.suites ??= [];
      parsed.suites.push(parseSuite(arg.slice('--suite='.length)));
    } else if (arg.startsWith('--offline-explain-trace=')) {
      parsed.offlineExplainTrace = path.resolve(arg.slice('--offline-explain-trace='.length));
    } else if (arg === '--offline-explain-trace') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) usage('--offline-explain-trace requires a path');
      parsed.offlineExplainTrace = path.resolve(next);
      index += 1;
    } else if (arg.startsWith('--format=')) {
      parsed.format = arg.slice('--format='.length);
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--verbose') {
      parsed.verbose = true;
    } else if (arg === '--score-only') {
      parsed.scoreOnly = true;
      parsed.quiet = true;
    } else if (arg === '--measure-speed' || arg === '--measure-latency') {
      parsed.measureSpeed = true;
    } else if (arg.startsWith('--workers=')) {
      parsed.workers = parsePositiveInt(arg.slice('--workers='.length), 'workers');
    } else if (arg.startsWith('--concurrency=')) {
      parsed.concurrency = parsePositiveInt(arg.slice('--concurrency='.length), 'concurrency');
    } else if (arg.startsWith('--repeat=')) {
      parsed.repeat = parsePositiveInt(arg.slice('--repeat='.length), 'repeat');
    } else if (arg.startsWith('--failure-report=')) {
      parsed.failureReport = path.resolve(arg.slice('--failure-report='.length));
    } else if (arg === '--failure-report') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) usage('--failure-report requires a path');
      parsed.failureReport = path.resolve(next);
      index += 1;
    } else if (arg.startsWith('--failure-inspect-limit=')) {
      parsed.failureInspectLimit = parsePositiveInt(
        arg.slice('--failure-inspect-limit='.length),
        'failure-inspect-limit',
      );
    } else if (arg === '--no-warmup') {
      parsed.noWarmup = true;
    } else if (arg === '--no-progress') {
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
  const mode = options.mode ?? 'core';
  const retrieval = options.retrieval ?? 'lexical';
  const measureSpeed = Boolean(options.measureSpeed);
  const concurrency = options.concurrency ?? defaultQualityConcurrency();
  const vaultRoot = options.vault ?? process.env.OPTSIDIAN_VAULT_PATH;

  if (!vaultRoot) {
    usage('Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.');
  }

  const specPath = options.spec ?? path.join(vaultRoot, 'SearchEval', 'queries.json');
  const cliPath = options.cli ?? path.join(repoRoot, 'dist', 'optsidian');

  if (!fs.existsSync(specPath)) usage(`Query spec not found: ${specPath}`);
  if (mode === 'e2e' && !fs.existsSync(cliPath)) usage(`Optsidian CLI not found: ${cliPath}. Run npm run build first.`);

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (!Array.isArray(spec.queries)) usage(`Query spec must contain a queries array: ${specPath}`);
  const repeat = options.repeat ?? (measureSpeed ? SPEED_MEASUREMENT_REPEAT : 1);
  const runner = await searchRunner(mode, cliPath, vaultRoot, options);
  const runSearch = runner.runSearch;
  const warmup = {
    index: runner.indexWarmup,
    search: undefined,
  };

  if (!options.noWarmup && spec.queries.length > 0) {
    warmup.search = await runSearchWarmup(runSearch, spec.queries[0]);
  }

  printWarmupSummary(warmup, { mode, retrieval });
  const fleet = await runner
    .status?.()
    .then(statusModelSummary)
    .catch(() => undefined);
  if (fleet) printFleetSummary(fleet);

  const runs = [];
  for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
    const run = await runEvaluation(spec.queries, concurrency, runSearch, options, runIndex);
    runs.push(run);
    printRunSummary(run, { mode, retrieval, concurrency, repeat, runIndex });
    if (fleet) printBatchThroughputSummary(fleet, run, repeat > 1 ? `run ${runIndex}/${repeat} ` : '');
  }

  if (repeat > 1) {
    printRepeatSummary(runs, { mode, retrieval, concurrency });
  }

  if (options.failureReport) {
    writeFailureReport(
      options.failureReport,
      createFailureReport({
        mode,
        retrieval,
        concurrency,
        measureSpeed,
        repeat,
        specPath,
        vaultRoot,
        warmup,
        inspectLimit: options.failureInspectLimit ?? 50,
        runs,
      }),
    );
  }

  return runs;
}

function defaultQualityConcurrency() {
  return 1;
}

async function runIndexBenchmark(options) {
  const mode = options.mode ?? 'core';
  if (mode !== 'core') usage('--benchmark=index supports --mode=core only');
  if (options.failureReport) usage('--failure-report is only supported by --benchmark=quality');
  if (options.scoreOnly) usage('--score-only is only supported by --benchmark=quality');
  if (options.format && options.format !== 'json' && options.format !== 'text')
    usage('--benchmark=index supports --format=json or --format=text');
  const vaultRoot = options.vault ?? process.env.OPTSIDIAN_VAULT_PATH;
  if (!vaultRoot) {
    usage('Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.');
  }
  const cliPath = options.cli ?? path.join(repoRoot, 'dist', 'optsidian');
  const repeat = options.repeat ?? 1;
  const actions = options.indexActions?.length ? options.indexActions : ['clear-load', 'rebuild', 'load'];
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { searchStoreCachePaths } = await import('../src/daemon/search-store/cache-paths.ts');
  const { effectiveSearchRuntimeProfile, lexicalIdentityHashForSearchRuntimeProfile } =
    await import('../src/daemon/runtime-profile.ts');
  const evalEnv = searchEvalEnv(options);
  const runtimeProfile = effectiveSearchRuntimeProfile(process.cwd(), evalEnv);
  const lexicalIdentityHash = lexicalIdentityHashForSearchRuntimeProfile(runtimeProfile);
  const client = createSearchDaemonClient({ binaryPath: cliPath, env: evalEnv, runtimeProfile });
  const vault = markdownVaultStats(vaultRoot);
  const cachePaths = safeCachePaths(searchStoreCachePaths, vault.root, evalEnv, { lexicalIdentityHash });
  const cacheBefore = cachePaths ? directoryStats(cachePaths.rootDir) : undefined;
  const daemonReady = await timedPhase('daemon-ready', () =>
    client.status({ deadlineMs: options.deadlineMs ?? 15000 }),
  );
  const benchmarkActions = [];

  for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
    for (const action of actions) {
      const result = await runIndexAction(client, vault.root, action, {
        deadlineMs: options.deadlineMs,
        cacheRoot: cachePaths?.rootDir,
      });
      const enriched = { runIndex, ...result };
      benchmarkActions.push(enriched);
      if (!options.quiet && options.format !== 'json') {
        printIndexAction(enriched, { repeat, vault });
      }
    }
  }

  const finalStatus = await client.status({ deadlineMs: options.deadlineMs ?? 15000 }).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const report = {
    schemaVersion: 2,
    benchmark: 'index',
    generatedAt: new Date().toISOString(),
    mode,
    repeat,
    actionsRequested: actions,
    vault,
    cache: {
      storeId: cachePaths?.storeId,
      vaultDir: cachePaths?.vaultDir,
      rootDir: cachePaths?.rootDir,
      lexicalIdentityHash: cachePaths?.lexicalIdentityHash,
      before: cacheBefore,
      after: cachePaths ? directoryStats(cachePaths.rootDir) : undefined,
    },
    daemonReady: {
      ok: daemonReady.ok,
      elapsedMs: daemonReady.elapsedMs,
      ...(daemonReady.ok
        ? { memory: statusMemorySummary(daemonReady.value), model: statusModelSummary(daemonReady.value) }
        : { error: daemonReady.error }),
    },
    actions: benchmarkActions,
    finalStatus: compactStatus(finalStatus, vault.root),
  };
  if (!options.quiet && options.format !== 'json') printIndexSummary(report);
  return report;
}

function normalizedModelEncodeP0Options(options) {
  return {
    models: uniqueStrings(options.p0Models ?? MODEL_ENCODE_P0_DEFAULT_MODELS),
    executionProviders: uniqueStrings(options.p0ExecutionProviders ?? MODEL_ENCODE_P0_DEFAULT_EXECUTION_PROVIDERS),
    seqLengths: uniqueNumbers(options.p0SeqLengths ?? MODEL_ENCODE_P0_DEFAULT_SEQ_LENGTHS),
    batchSizes: uniqueNumbers(options.p0BatchSizes ?? MODEL_ENCODE_P0_DEFAULT_BATCH_SIZES),
    repeat: options.repeat ?? 2,
    queryCount: options.p0QueryCount ?? 24,
    bulkUnits: options.p0BulkUnits ?? 8,
    fairnessUnitsPerVault: options.p0FairnessUnits ?? 3,
    turnstileSeqLength: options.p0TurnstileSeq ?? 512,
    turnstileBatchSize: options.p0TurnstileBatch ?? 4,
    overflowWidths: uniqueNumbers(options.p0OverflowWidths ?? MODEL_ENCODE_P0_DEFAULT_OVERFLOW_WIDTHS),
    probeRepeat: options.p0ProbeRepeat ?? 10,
    commandTimeoutMs: options.p0TimeoutMs ?? 1000,
  };
}

function modelEncodeP0DryRunReport(options) {
  const config = normalizedModelEncodeP0Options(options);
  return {
    schemaVersion: 1,
    benchmark: MODEL_ENCODE_P0_BENCHMARK,
    dryRun: true,
    generatedAt: new Date().toISOString(),
    config,
    plannedSections: [
      'batchThroughputByModelProviderSeqBatch',
      'queryLatencyIdleVsSharedTurnstileBulk',
      'textWorkerTokenizeVsPreparedTypedArrayTransfer',
      'oneSessionVsTwoSessionVram',
      'nvidiaSmiProbeLatencyFailureTimeout',
      'gpuOnlyVsGpuPlusCpuOverflow',
      'twoConcurrentRebuildFairness',
      'transientGpuFailureRecovery',
    ],
  };
}

async function runModelEncodeP0Benchmark(options) {
  const config = normalizedModelEncodeP0Options(options);
  if (options.format && options.format !== 'json' && options.format !== 'text') {
    usage('--benchmark=model-encode-p0 supports --format=json or --format=text');
  }
  const fleet = await modelEncodeP0FleetSummary(config);
  const sweeps = [];
  for (const model of config.models) {
    for (const executionProvider of config.executionProviders) {
      sweeps.push(
        await safeP0Section(`${model}/${executionProvider}`, () =>
          runModelEncodeP0Sweep(model, executionProvider, config),
        ),
      );
    }
  }

  const primaryModel = config.models[0] ?? 'bge-m3';
  const cudaEnabled = config.executionProviders.includes('cuda');
  const cpuEnabled = config.executionProviders.includes('cpu');
  const queryLatency = cudaEnabled
    ? await safeP0Section('query-latency-shared-turnstile', () => runModelEncodeP0QueryLatency(primaryModel, config))
    : { ok: false, skipped: true, reason: 'cuda execution provider not requested' };
  const transferCost = await safeP0Section('text-vs-prepared-transfer', () =>
    runModelEncodeP0TransferCost(primaryModel, config),
  );
  const sessionVram = cudaEnabled
    ? await safeP0Section('one-vs-two-session-vram', () => runModelEncodeP0SessionVram(primaryModel, config))
    : { ok: false, skipped: true, reason: 'cuda execution provider not requested' };
  const probe = await safeP0Section('nvidia-smi-probe', () => runModelEncodeP0NvidiaSmiProbe(config));
  const overflow =
    cudaEnabled && cpuEnabled
      ? await safeP0Section('gpu-cpu-overflow', () => runModelEncodeP0Overflow(primaryModel, config))
      : { ok: false, skipped: true, reason: 'cuda and cpu execution providers are both required' };
  const fairness = cudaEnabled
    ? await safeP0Section('two-rebuild-fairness', () => runModelEncodeP0Fairness(primaryModel, config))
    : { ok: false, skipped: true, reason: 'cuda execution provider not requested' };
  const transientRecovery = await safeP0Section('transient-gpu-failure-recovery', () =>
    simulateModelEncodeP0TransientGpuFailureRecovery(),
  );
  const ok =
    sweeps.some((section) => section.ok) &&
    [queryLatency, transferCost, sessionVram, probe, overflow, fairness, transientRecovery].every(
      (section) => section.ok || section.skipped,
    );

  return {
    schemaVersion: 1,
    benchmark: MODEL_ENCODE_P0_BENCHMARK,
    generatedAt: new Date().toISOString(),
    ok,
    config,
    fleet,
    sweeps,
    queryLatency,
    transferCost,
    sessionVram,
    nvidiaSmiProbe: probe,
    overflow,
    fairness,
    transientRecovery,
  };
}

async function safeP0Section(name, run) {
  const started = performance.now();
  try {
    const value = await run();
    return {
      ok: true,
      name,
      elapsedMs: roundMs(performance.now() - started),
      ...value,
    };
  } catch (error) {
    return {
      ok: false,
      name,
      elapsedMs: roundMs(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function modelEncodeP0FleetSummary(config) {
  const ort = await import('onnxruntime-node').then((module) => module.default ?? module).catch(() => undefined);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: {
      logicalCpu: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
      model: os.cpus()[0]?.model,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
    },
    onnxruntimeNode: ort?.env?.versions?.node ?? ort?.env?.versions?.common ?? null,
    nvidiaSmi: await nvidiaSmiMemorySummary(config.commandTimeoutMs).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })),
  };
}

async function runModelEncodeP0Sweep(model, executionProvider, config) {
  const ctx = await createModelEncodeP0Context(model, executionProvider);
  try {
    const rows = [];
    for (const seqLength of config.seqLengths) {
      if (seqLength > ctx.descriptor.maxTokens) {
        rows.push({ model: ctx.model, executionProvider, seqLength, skipped: true, reason: 'exceeds model maxTokens' });
        continue;
      }
      const encoding = encodingForP0SequenceLength(ctx.tokenizer, ctx.descriptor, seqLength, 'document');
      for (const batchSize of config.batchSizes) {
        const feeds = feedsForP0Batch(ctx, encoding, batchSize, seqLength);
        await runP0Session(ctx.session, feeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
        const durations = [];
        for (let repeat = 0; repeat < config.repeat; repeat += 1) {
          const started = performance.now();
          await runP0Session(ctx.session, feeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
          durations.push(performance.now() - started);
        }
        const sorted = durations.toSorted((left, right) => left - right);
        const medianMs = median(sorted);
        rows.push({
          model: ctx.model,
          executionProvider,
          seqLength,
          batchSize,
          repeat: config.repeat,
          medianMs: roundMs(medianMs),
          p95Ms: roundMs(percentile(sorted, 95)),
          docsPerSec: roundNumber((batchSize / medianMs) * 1000, 2),
          tokensPerSec: roundNumber(((batchSize * seqLength) / medianMs) * 1000, 0),
        });
      }
    }
    return { model: ctx.model, executionProvider, rows };
  } finally {
    await ctx.close();
  }
}

async function runModelEncodeP0QueryLatency(model, config) {
  const ctx = await createModelEncodeP0Context(model, 'cuda');
  try {
    const querySeqLength = Math.min(32, ctx.descriptor.maxTokens);
    const bulkSeqLength = Math.min(config.turnstileSeqLength, ctx.descriptor.maxTokens);
    const bulkBatchSize = config.turnstileBatchSize;
    const queryFeeds = feedsForP0Batch(
      ctx,
      encodingForP0SequenceLength(ctx.tokenizer, ctx.descriptor, querySeqLength, 'query'),
      1,
      querySeqLength,
    );
    const bulkFeeds = feedsForP0Batch(
      ctx,
      encodingForP0SequenceLength(ctx.tokenizer, ctx.descriptor, bulkSeqLength, 'document'),
      bulkBatchSize,
      bulkSeqLength,
    );
    await runP0Session(ctx.session, queryFeeds, { expectedBatch: 1, expectedSeqLength: querySeqLength });
    await runP0Session(ctx.session, bulkFeeds, { expectedBatch: bulkBatchSize, expectedSeqLength: bulkSeqLength });

    const idleLatencies = [];
    for (let index = 0; index < config.queryCount; index += 1) {
      const started = performance.now();
      await runP0Session(ctx.session, queryFeeds, { expectedBatch: 1, expectedSeqLength: querySeqLength });
      idleLatencies.push(performance.now() - started);
    }

    const bulkSampleStarted = performance.now();
    await runP0Session(ctx.session, bulkFeeds, { expectedBatch: bulkBatchSize, expectedSeqLength: bulkSeqLength });
    const bulkUnitMs = performance.now() - bulkSampleStarted;
    const turnstile = createP0Turnstile();
    const rebuildQueryLatencies = [];
    let bulkCompleted = 0;
    const bulkRun = (async () => {
      for (let index = 0; index < config.bulkUnits; index += 1) {
        await turnstile.run(async () => {
          await runP0Session(ctx.session, bulkFeeds, {
            expectedBatch: bulkBatchSize,
            expectedSeqLength: bulkSeqLength,
          });
          bulkCompleted += 1;
        });
        await delay(0);
      }
    })();
    const queryRun = (async () => {
      const spacingMs = Math.max(1, Math.min(25, bulkUnitMs / 2));
      for (let index = 0; index < config.queryCount; index += 1) {
        await delay(spacingMs);
        const requestedAt = performance.now();
        await turnstile.run(() =>
          runP0Session(ctx.session, queryFeeds, { expectedBatch: 1, expectedSeqLength: querySeqLength }),
        );
        rebuildQueryLatencies.push(performance.now() - requestedAt);
      }
    })();
    await Promise.all([bulkRun, queryRun]);

    return {
      model: ctx.model,
      executionProvider: 'cuda',
      querySeqLength,
      bulkSeqLength,
      bulkBatchSize,
      bulkUnits: config.bulkUnits,
      bulkCompleted,
      bulkUnitMs: roundMs(bulkUnitMs),
      idle: latencySummary(idleLatencies),
      sharedTurnstileDuringBulk: latencySummary(rebuildQueryLatencies),
    };
  } finally {
    await ctx.close();
  }
}

async function runModelEncodeP0TransferCost(model, config) {
  const ctx = await createModelEncodeP0TokenizerContext(model);
  const seqLength = Math.min(config.turnstileSeqLength, ctx.descriptor.maxTokens);
  const batchSize = config.turnstileBatchSize;
  const texts = Array.from({ length: batchSize }, (_, index) => {
    const inputKind = index % 2 === 0 ? 'document' : 'query';
    return renderP0EmbeddingInput(
      ctx.descriptor,
      textForP0SequenceLength(ctx.tokenizer, ctx.descriptor, seqLength, inputKind),
      inputKind,
    );
  });
  const worker = createP0TransferWorker(ctx);
  try {
    await worker.request({ kind: 'text', texts, maxTokens: seqLength });
    const textWorkerTokenize = [];
    for (let repeat = 0; repeat < config.repeat; repeat += 1) {
      const started = performance.now();
      await worker.request({ kind: 'text', texts, maxTokens: seqLength });
      textWorkerTokenize.push(performance.now() - started);
    }

    const preparedPayloads = Array.from({ length: config.repeat }, () =>
      preparedTransferPayload(ctx, texts, seqLength, { rendered: true }),
    );
    const preparedTransfer = [];
    for (const payload of preparedPayloads) {
      const started = performance.now();
      await worker.request(
        {
          kind: 'prepared',
          batchSize: payload.batchSize,
          seqLength: payload.seqLength,
          inputIds: payload.inputIds,
          attentionMask: payload.attentionMask,
        },
        [payload.inputIds.buffer, payload.attentionMask.buffer],
      );
      preparedTransfer.push(performance.now() - started);
    }

    const parentTokenize = [];
    const parentTokenizePlusTransfer = [];
    for (let repeat = 0; repeat < config.repeat; repeat += 1) {
      const tokenizeStarted = performance.now();
      const payload = preparedTransferPayload(ctx, texts, seqLength, { rendered: true });
      parentTokenize.push(performance.now() - tokenizeStarted);
      await worker.request(
        {
          kind: 'prepared',
          batchSize: payload.batchSize,
          seqLength: payload.seqLength,
          inputIds: payload.inputIds,
          attentionMask: payload.attentionMask,
        },
        [payload.inputIds.buffer, payload.attentionMask.buffer],
      );
      parentTokenizePlusTransfer.push(performance.now() - tokenizeStarted);
    }

    return {
      model: ctx.model,
      seqLength,
      batchSize,
      repeat: config.repeat,
      textWorkerTokenizeMs: latencySummary(textWorkerTokenize),
      preparedTransferOnlyMs: latencySummary(preparedTransfer),
      parentTokenizeMs: latencySummary(parentTokenize),
      parentTokenizePlusPreparedTransferMs: latencySummary(parentTokenizePlusTransfer),
      payloadBytes: batchSize * seqLength * Int32Array.BYTES_PER_ELEMENT * 2,
    };
  } finally {
    await worker.close();
  }
}

async function runModelEncodeP0SessionVram(model, config) {
  const tokenizerContext = await createModelEncodeP0TokenizerContext(model);
  const ort = await import('onnxruntime-node').then((module) => module.default ?? module);
  let firstSession;
  let secondSession;
  try {
    const seqLength = Math.min(32, tokenizerContext.descriptor.maxTokens);
    const before = await nvidiaSmiMemorySummary(config.commandTimeoutMs);
    firstSession = await createP0OrtSession(ort, tokenizerContext.modelPath, 'cuda');
    const ctx = {
      ...tokenizerContext,
      executionProvider: 'cuda',
      ort,
      session: firstSession,
    };
    const feeds = feedsForP0Batch(
      ctx,
      encodingForP0SequenceLength(ctx.tokenizer, ctx.descriptor, seqLength, 'query'),
      1,
      seqLength,
    );
    await runP0Session(ctx.session, feeds, { expectedBatch: 1, expectedSeqLength: seqLength });
    const afterOne = await nvidiaSmiMemorySummary(config.commandTimeoutMs);
    let secondOk = false;
    let secondError;
    try {
      secondSession = await createP0OrtSession(ctx.ort, ctx.modelPath, 'cuda');
      await runP0Session(secondSession, feeds, { expectedBatch: 1, expectedSeqLength: seqLength });
      secondOk = true;
    } catch (error) {
      secondError = error instanceof Error ? error.message : String(error);
    }
    const afterTwoAttempt = await nvidiaSmiMemorySummary(config.commandTimeoutMs);
    return {
      model: ctx.model,
      seqLength,
      before,
      afterOne,
      afterTwoAttempt,
      oneSessionFreeDeltaMiB: gpuFreeDeltaMiB(before, afterOne),
      twoSessionAdditionalFreeDeltaMiB: gpuFreeDeltaMiB(afterOne, afterTwoAttempt),
      secondSession: secondOk
        ? { ok: true, oom: false }
        : { ok: false, oom: /out of memory|oom/i.test(secondError ?? ''), error: secondError },
    };
  } finally {
    if (secondSession?.release) await secondSession.release();
    if (firstSession?.release) await firstSession.release();
  }
}

async function runModelEncodeP0NvidiaSmiProbe(config) {
  const latencies = [];
  for (let index = 0; index < config.probeRepeat; index += 1) {
    const result = await runCommandTimed(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      config.commandTimeoutMs,
    );
    if (!result.ok) throw new Error(result.error ?? `nvidia-smi failed with code ${result.code}`);
    latencies.push(result.elapsedMs);
  }
  const invalid = await runCommandTimed(
    'nvidia-smi',
    ['--query-gpu=definitely.invalid', '--format=csv,noheader,nounits'],
    config.commandTimeoutMs,
  );
  const timeout = await runCommandTimed('nvidia-smi', ['-l', '1'], Math.min(100, config.commandTimeoutMs));
  return {
    repeat: config.probeRepeat,
    successLatencyMs: latencySummary(latencies),
    invalidQueryFailure: compactCommandResult(invalid),
    timeoutCase: compactCommandResult(timeout),
  };
}

async function runModelEncodeP0Overflow(model, config) {
  const gpu = await createModelEncodeP0Context(model, 'cuda');
  const cpu = await createModelEncodeP0Context(model, 'cpu');
  try {
    const seqLength = Math.min(config.turnstileSeqLength, gpu.descriptor.maxTokens);
    const batchSize = Math.max(1, Math.min(config.turnstileBatchSize, 4));
    const encoding = encodingForP0SequenceLength(gpu.tokenizer, gpu.descriptor, seqLength, 'document');
    const gpuFeeds = feedsForP0Batch(gpu, encoding, batchSize, seqLength);
    const cpuFeeds = feedsForP0Batch(cpu, encoding, batchSize, seqLength);
    await runP0Session(gpu.session, gpuFeeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
    await runP0Session(cpu.session, cpuFeeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });

    const gpuOnly = await runP0Loop(gpu.session, gpuFeeds, config.bulkUnits, batchSize, seqLength);
    const overflowRows = [];
    for (const width of config.overflowWidths) {
      const started = performance.now();
      const gpuRun = runP0Loop(gpu.session, gpuFeeds, config.bulkUnits, batchSize, seqLength);
      const cpuRuns = Array.from({ length: width }, () =>
        runP0Loop(cpu.session, cpuFeeds, config.bulkUnits, batchSize, seqLength),
      );
      const completed = await Promise.all([gpuRun, ...cpuRuns]);
      const elapsedMs = performance.now() - started;
      const docs = completed.reduce((sum, row) => sum + row.docs, 0);
      overflowRows.push({
        cpuOverflowWidth: width,
        elapsedMs: roundMs(elapsedMs),
        docs,
        docsPerSec: roundNumber((docs / elapsedMs) * 1000, 2),
        tokensPerSec: roundNumber(((docs * seqLength) / elapsedMs) * 1000, 0),
      });
    }
    return {
      model: gpu.model,
      seqLength,
      batchSize,
      unitsPerLane: config.bulkUnits,
      gpuOnly,
      gpuPlusCpuOverflow: overflowRows,
    };
  } finally {
    await Promise.allSettled([gpu.close(), cpu.close()]);
  }
}

async function runModelEncodeP0Fairness(model, config) {
  const ctx = await createModelEncodeP0Context(model, 'cuda');
  try {
    const seqLength = Math.min(config.turnstileSeqLength, ctx.descriptor.maxTokens);
    const batchSize = config.turnstileBatchSize;
    const feeds = feedsForP0Batch(
      ctx,
      encodingForP0SequenceLength(ctx.tokenizer, ctx.descriptor, seqLength, 'document'),
      batchSize,
      seqLength,
    );
    await runP0Session(ctx.session, feeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
    const vaults = [
      { key: 'vault-a', remaining: config.fairnessUnitsPerVault, completedAt: undefined },
      { key: 'vault-b', remaining: config.fairnessUnitsPerVault, completedAt: undefined },
    ];
    const order = [];
    const started = performance.now();
    while (vaults.some((vault) => vault.remaining > 0)) {
      for (const vault of vaults) {
        if (vault.remaining <= 0) continue;
        await runP0Session(ctx.session, feeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
        vault.remaining -= 1;
        order.push(vault.key);
        if (vault.remaining === 0) vault.completedAt = performance.now() - started;
      }
    }
    const counts = Object.fromEntries(
      vaults.map((vault) => [vault.key, config.fairnessUnitsPerVault - vault.remaining]),
    );
    return {
      model: ctx.model,
      seqLength,
      batchSize,
      unitsPerVault: config.fairnessUnitsPerVault,
      order,
      counts,
      maxConsecutiveSameVault: maxConsecutiveSameValue(order),
      completionSkewMs: roundMs(Math.abs((vaults[0].completedAt ?? 0) - (vaults[1].completedAt ?? 0))),
    };
  } finally {
    await ctx.close();
  }
}

async function simulateModelEncodeP0TransientGpuFailureRecovery() {
  const { createOnnxSessionWithFallback } = await import('../src/core/search/dense/local-onnx.ts');
  const attempts = [];
  let cudaFailuresRemaining = 1;
  const fakeSession = (executionProvider) => ({
    executionProvider,
    inputNames: ['input_ids', 'attention_mask'],
    async run() {
      return {};
    },
    async release() {},
  });
  const ort = {
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: {
      async create(_modelPath, options) {
        const executionProvider = options.executionProviders[0];
        attempts.push(executionProvider);
        if (executionProvider === 'cuda' && cudaFailuresRemaining > 0) {
          cudaFailuresRemaining -= 1;
          throw new Error('simulated CUDA session create failure');
        }
        return fakeSession(executionProvider);
      },
    },
  };
  const first = await createOnnxSessionWithFallback({
    ort,
    modelPath: '/tmp/p0-transient.onnx',
    executionProvider: 'auto',
    platform: 'linux',
    allowCpuFallback: true,
  });
  const second = await createOnnxSessionWithFallback({
    ort,
    modelPath: '/tmp/p0-transient.onnx',
    executionProvider: 'auto',
    platform: 'linux',
    allowCpuFallback: true,
  });
  return {
    scenario: 'first CUDA create fails, CPU fallback serves, later demand retries CUDA successfully',
    attempts,
    firstExecutionProvider: first.executionProvider,
    firstFailures: first.failures,
    secondExecutionProvider: second.executionProvider,
    recovered: first.executionProvider === 'cpu' && second.executionProvider === 'cuda',
  };
}

async function createModelEncodeP0Context(model, executionProvider) {
  const tokenizerContext = await createModelEncodeP0TokenizerContext(model);
  const ort = await import('onnxruntime-node').then((module) => module.default ?? module);
  const session = await createP0OrtSession(ort, tokenizerContext.modelPath, executionProvider);
  return {
    ...tokenizerContext,
    executionProvider,
    ort,
    session,
    close: async () => {
      if (session.release) await session.release();
    },
  };
}

async function createModelEncodeP0TokenizerContext(model) {
  const artifacts = await import('../src/core/search/dense/artifacts.ts');
  const modelKey = artifacts.resolveLocalOnnxModelKey(model);
  const descriptor = artifacts.localOnnxModelDescriptor(modelKey);
  const installed = await artifacts.ensureLocalOnnxModelArtifact(modelKey, process.env, { verifyFiles: 'metadata' });
  if (installed.status === 'error') throw new Error(`failed to prepare ${modelKey} artifact: ${installed.message}`);
  const tokenizer = await loadP0Tokenizer(
    artifacts.localOnnxTokenizerJsonPath(modelKey, process.env),
    artifacts.localOnnxTokenizerConfigPath(modelKey, process.env),
  );
  return {
    model: modelKey,
    descriptor,
    tokenizer,
    modelPath: artifacts.localOnnxSessionModelPath(modelKey, process.env),
    tokenizerJsonPath: artifacts.localOnnxTokenizerJsonPath(modelKey, process.env),
    tokenizerConfigPath: artifacts.localOnnxTokenizerConfigPath(modelKey, process.env),
  };
}

async function loadP0Tokenizer(tokenizerJsonPath, tokenizerConfigPath) {
  const imported = await import('@huggingface/tokenizers');
  const Tokenizer = imported.Tokenizer ?? imported.default?.Tokenizer;
  if (!Tokenizer) throw new Error('@huggingface/tokenizers did not export Tokenizer');
  return new Tokenizer(
    JSON.parse(fs.readFileSync(tokenizerJsonPath, 'utf8')),
    JSON.parse(fs.readFileSync(tokenizerConfigPath, 'utf8')),
  );
}

async function createP0OrtSession(ort, modelPath, executionProvider) {
  return ort.InferenceSession.create(modelPath, {
    executionProviders:
      executionProvider === 'cuda'
        ? [
            {
              name: 'cuda',
              deviceId: 0,
            },
          ]
        : ['cpu'],
  });
}

function textForP0SequenceLength(tokenizer, descriptor, seqLength, inputKind) {
  const phrase = 'semantic retrieval benchmark passage with enough repeated tokens';
  let repeat = Math.max(1, Math.ceil(seqLength / 6));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = Array.from({ length: repeat }, () => phrase).join(' ');
    const rendered = renderP0EmbeddingInput(descriptor, text, inputKind);
    const encoded = tokenizer.encode(rendered, { add_special_tokens: true });
    if (encoded.ids.length >= seqLength) return text;
    repeat *= 2;
  }
  return Array.from({ length: repeat }, () => phrase).join(' ');
}

function encodingForP0SequenceLength(tokenizer, descriptor, seqLength, inputKind) {
  const text = textForP0SequenceLength(tokenizer, descriptor, seqLength, inputKind);
  const rendered = renderP0EmbeddingInput(descriptor, text, inputKind);
  const encoded = tokenizer.encode(rendered, { add_special_tokens: true });
  return truncateOrPadP0Encoding(encoded, seqLength);
}

function renderP0EmbeddingInput(descriptor, text, inputKind) {
  const template = descriptor.inputTemplate[inputKind] ?? descriptor.inputTemplate.default;
  return template.replace('{text}', text);
}

function truncateOrPadP0Encoding(encoding, seqLength) {
  const ids = Array.from(encoding.ids).slice(0, seqLength);
  const attentionMask = Array.from(encoding.attention_mask).slice(0, seqLength);
  const tokenTypeIds = encoding.token_type_ids ? Array.from(encoding.token_type_ids).slice(0, seqLength) : undefined;
  const padId = ids.at(-1) ?? 0;
  while (ids.length < seqLength) ids.push(padId);
  while (attentionMask.length < seqLength) attentionMask.push(1);
  if (tokenTypeIds) while (tokenTypeIds.length < seqLength) tokenTypeIds.push(0);
  return {
    ids,
    attention_mask: attentionMask,
    ...(tokenTypeIds ? { token_type_ids: tokenTypeIds } : {}),
  };
}

function feedsForP0Batch(ctx, encoding, batchSize, seqLength) {
  const inputNames = new Set(ctx.session.inputNames ?? ['input_ids', 'attention_mask']);
  const feeds = {};
  if (inputNames.has('input_ids'))
    feeds.input_ids = new ctx.ort.Tensor('int64', repeatP0Int64(encoding.ids, batchSize), [batchSize, seqLength]);
  if (inputNames.has('attention_mask')) {
    feeds.attention_mask = new ctx.ort.Tensor('int64', repeatP0Int64(encoding.attention_mask, batchSize), [
      batchSize,
      seqLength,
    ]);
  }
  if (inputNames.has('token_type_ids')) {
    feeds.token_type_ids = new ctx.ort.Tensor(
      'int64',
      repeatP0Int64(encoding.token_type_ids ?? new Array(seqLength).fill(0), batchSize),
      [batchSize, seqLength],
    );
  }
  return feeds;
}

function repeatP0Int64(values, batchSize) {
  const repeated = new BigInt64Array(values.length * batchSize);
  for (let row = 0; row < batchSize; row += 1) {
    const offset = row * values.length;
    for (let index = 0; index < values.length; index += 1) {
      repeated[offset + index] = BigInt(values[index] ?? 0);
    }
  }
  return repeated;
}

async function runP0Session(session, feeds, expected) {
  const output = await session.run(feeds);
  const tensor = output.last_hidden_state ?? Object.values(output)[0];
  if (!tensor?.dims) return output;
  const dims = tensor.dims.map((value) => Number(value));
  if (dims.length >= 2 && dims[0] !== expected.expectedBatch) {
    throw new Error(`ONNX output batch mismatch: expected ${expected.expectedBatch}, got ${dims[0]}`);
  }
  if (dims.length >= 2 && dims[1] !== expected.expectedSeqLength) {
    throw new Error(`ONNX output sequence mismatch: expected ${expected.expectedSeqLength}, got ${dims[1]}`);
  }
  return output;
}

async function runP0Loop(session, feeds, units, batchSize, seqLength) {
  const started = performance.now();
  for (let index = 0; index < units; index += 1) {
    await runP0Session(session, feeds, { expectedBatch: batchSize, expectedSeqLength: seqLength });
  }
  const elapsedMs = performance.now() - started;
  const docs = units * batchSize;
  return {
    units,
    docs,
    elapsedMs: roundMs(elapsedMs),
    docsPerSec: roundNumber((docs / elapsedMs) * 1000, 2),
    tokensPerSec: roundNumber(((docs * seqLength) / elapsedMs) * 1000, 0),
  };
}

function createP0Turnstile() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const runAfterTail = tail.catch(() => undefined).then(task);
      tail = runAfterTail.then(
        () => undefined,
        () => undefined,
      );
      return runAfterTail;
    },
  };
}

function preparedTransferPayload(ctx, texts, seqLength, options = {}) {
  const batchSize = texts.length;
  const inputIds = new Int32Array(batchSize * seqLength);
  const attentionMask = new Int32Array(batchSize * seqLength);
  texts.forEach((text, row) => {
    const rendered = options.rendered ? text : renderP0EmbeddingInput(ctx.descriptor, text, 'document');
    const encoding = truncateOrPadP0Encoding(ctx.tokenizer.encode(rendered, { add_special_tokens: true }), seqLength);
    const offset = row * seqLength;
    for (let index = 0; index < seqLength; index += 1) {
      inputIds[offset + index] = encoding.ids[index] ?? 0;
      attentionMask[offset + index] = encoding.attention_mask[index] ?? 0;
    }
  });
  return { batchSize, seqLength, inputIds, attentionMask };
}

function createP0TransferWorker(ctx) {
  const worker = new Worker(
    `
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
const imported = await import('@huggingface/tokenizers');
const Tokenizer = imported.Tokenizer ?? imported.default?.Tokenizer;
const tokenizer = new Tokenizer(
  JSON.parse(fs.readFileSync(workerData.tokenizerJsonPath, 'utf8')),
  JSON.parse(fs.readFileSync(workerData.tokenizerConfigPath, 'utf8')),
);
parentPort.on('message', (message) => {
  try {
    if (message.kind === 'text') {
      let tokenCount = 0;
      for (const text of message.texts) {
        const encoded = tokenizer.encode(text, { add_special_tokens: true });
        tokenCount += Math.min(encoded.attention_mask.length, message.maxTokens);
      }
      parentPort.postMessage({ id: message.id, ok: true, result: { tokenCount } });
      return;
    }
    if (message.kind === 'prepared') {
      parentPort.postMessage({
        id: message.id,
        ok: true,
        result: { bytes: message.inputIds.byteLength + message.attentionMask.byteLength },
      });
      return;
    }
    throw new Error('unknown P0 worker request kind');
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`,
    {
      eval: true,
      type: 'module',
      workerData: {
        tokenizerJsonPath: ctx.tokenizerJsonPath,
        tokenizerConfigPath: ctx.tokenizerConfigPath,
      },
    },
  );
  let nextId = 1;
  const pending = new Map();
  worker.on('message', (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  });
  worker.on('error', (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
  return {
    request(payload, transferList = []) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, ...payload }, transferList);
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}

async function nvidiaSmiMemorySummary(timeoutMs) {
  const result = await runCommandTimed(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
    timeoutMs,
  );
  if (!result.ok) {
    return { ok: false, error: result.error ?? `exit ${result.code}`, elapsedMs: result.elapsedMs };
  }
  const gpus = result.stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [name, totalMiB, freeMiB] = line.split(',').map((part) => part.trim());
      return { name, totalMiB: Number(totalMiB), freeMiB: Number(freeMiB) };
    });
  return { ok: true, elapsedMs: result.elapsedMs, gpus };
}

function gpuFreeDeltaMiB(before, after) {
  const beforeFree = before?.gpus?.[0]?.freeMiB;
  const afterFree = after?.gpus?.[0]?.freeMiB;
  return Number.isFinite(beforeFree) && Number.isFinite(afterFree) ? roundNumber(beforeFree - afterFree, 1) : undefined;
}

function runCommandTimed(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeout.unref();
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        elapsedMs: roundMs(performance.now() - started),
        error: error.message,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        elapsedMs: roundMs(performance.now() - started),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(timedOut ? { error: `command timed out after ${timeoutMs}ms` } : {}),
      });
    });
  });
}

function compactCommandResult(result) {
  return {
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.stderr ? { stderr: result.stderr.trim().slice(0, 240) } : {}),
  };
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: values.length,
    p50Ms: roundMs(percentile(sorted, 50)),
    p95Ms: roundMs(percentile(sorted, 95)),
    p99Ms: roundMs(percentile(sorted, 99)),
    avgMs: roundMs(average(values)),
  };
}

function maxConsecutiveSameValue(values) {
  let max = 0;
  let current = 0;
  let previous;
  for (const value of values) {
    current = value === previous ? current + 1 : 1;
    previous = value;
    max = Math.max(max, current);
  }
  return max;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function uniqueNumbers(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundNumber(value, digits) {
  return Number(value.toFixed(digits));
}

function printModelEncodeP0Summary(report) {
  console.log(
    [
      'model-encode-p0.summary:',
      `ok=${report.ok}`,
      `models=${report.config.models.join(',')}`,
      `providers=${report.config.executionProviders.join(',')}`,
      `seq=${report.config.seqLengths.join(',')}`,
      `batch=${report.config.batchSizes.join(',')}`,
    ].join(' '),
  );
  for (const sweep of report.sweeps) {
    if (!sweep.ok) {
      console.log(`model-encode-p0.sweep: ${sweep.name} failed ${sweep.error}`);
      continue;
    }
    const best = sweep.rows
      .filter((row) => !row.skipped)
      .toSorted((left, right) => right.tokensPerSec - left.tokensPerSec)[0];
    if (best) {
      console.log(
        `model-encode-p0.sweep: ${sweep.name} best seq=${best.seqLength} batch=${best.batchSize} docsPerSec=${best.docsPerSec} tokensPerSec=${best.tokensPerSec}`,
      );
    }
  }
  if (report.queryLatency.ok) {
    console.log(
      `model-encode-p0.query: idleP99=${formatMs(report.queryLatency.idle.p99Ms)} rebuildP99=${formatMs(report.queryLatency.sharedTurnstileDuringBulk.p99Ms)} bulkUnit=${formatMs(report.queryLatency.bulkUnitMs)}`,
    );
  }
}

async function runIndexAction(client, vaultRoot, action, options) {
  const phases = [];
  const request = { vault: vaultRoot, ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) };
  const started = performance.now();
  let payload;
  try {
    if (action === 'load') {
      payload = await recordPhase(phases, 'load', () => client.loadVault(request));
    } else if (action === 'rebuild') {
      payload = await recordPhase(phases, 'rebuild', () => client.rebuild(request));
    } else if (action === 'clear') {
      payload = await recordPhase(phases, 'clear', () => client.clear(request));
    } else if (action === 'clear-load') {
      await recordPhase(phases, 'clear', () => client.clear(request));
      payload = await recordPhase(phases, 'load', () => client.loadVault(request));
    } else if (action === 'clear-rebuild') {
      await recordPhase(phases, 'clear', () => client.clear(request));
      payload = await recordPhase(phases, 'rebuild', () => client.rebuild(request));
    } else {
      usage(`Unknown index action: ${action}`);
    }
    const elapsedMs = roundMs(performance.now() - started);
    const buildTiming = requireDaemonBuildTiming(payload?.buildTiming, action);
    const status = await client.status({ deadlineMs: options.deadlineMs ?? 15000 }).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      action,
      ok: true,
      elapsedMs,
      phases,
      buildPhases: buildTiming.phases,
      ...indexBuildTimingFields(buildTiming),
      snapshotId: payloadSnapshotId(payload) ?? vaultStatus(status, vaultRoot)?.snapshotId,
      vault: vaultStatus(status, vaultRoot),
      cache: options.cacheRoot ? directoryStats(options.cacheRoot) : undefined,
      memory: statusMemorySummary(status),
      model: statusModelSummary(status),
      searchStore: status.searchStore,
    };
  } catch (error) {
    return {
      action,
      ok: false,
      elapsedMs: roundMs(performance.now() - started),
      phases,
      buildPhases: [],
      indexBuildMs: 0,
      lexicalBuildMs: 0,
      denseBuildMs: 0,
      preloadMs: 0,
      buildTimingSource: 'not-observed',
      buildTimingResolutionMs: 0,
      error: error instanceof Error ? error.message : String(error),
      cache: options.cacheRoot ? directoryStats(options.cacheRoot) : undefined,
    };
  }
}

async function recordPhase(phases, name, run) {
  const phase = await timedPhase(name, run);
  phases.push(
    phase.ok
      ? { name, ok: true, elapsedMs: phase.elapsedMs, snapshotId: payloadSnapshotId(phase.value) }
      : { name, ok: false, elapsedMs: phase.elapsedMs, error: phase.error },
  );
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
      value,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      elapsedMs: roundMs(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function indexBuildTimingFields(buildTiming) {
  return {
    indexBuildMs: buildTiming.indexBuildMs,
    lexicalBuildMs: buildTiming.lexicalBuildMs,
    denseBuildMs: buildTiming.denseBuildMs,
    preloadMs: buildTiming.preloadMs,
    buildTimingSource: buildTiming.source,
    buildTimingResolutionMs: 0,
  };
}

function requireDaemonBuildTiming(value, action) {
  const timing = normalizeDaemonBuildTiming(value);
  if (!timing) throw new Error(`${action} did not return daemon build timing`);
  return timing;
}

function normalizeDaemonBuildTiming(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.source !== 'daemon-progress') return undefined;
  const phases = Array.isArray(value.phases) ? value.phases.map(normalizeBuildPhase).filter(Boolean) : [];
  const indexBuildMs = finiteNumber(value.indexBuildMs);
  const lexicalBuildMs = finiteNumber(value.lexicalBuildMs);
  const denseBuildMs = finiteNumber(value.denseBuildMs);
  const preloadMs = finiteNumber(value.preloadMs);
  if (
    indexBuildMs === undefined ||
    lexicalBuildMs === undefined ||
    denseBuildMs === undefined ||
    preloadMs === undefined
  ) {
    return undefined;
  }
  return {
    source: 'daemon-progress',
    indexBuildMs: roundMs(indexBuildMs),
    lexicalBuildMs: roundMs(lexicalBuildMs),
    denseBuildMs: roundMs(denseBuildMs),
    preloadMs: roundMs(preloadMs),
    phases,
  };
}

function normalizeBuildPhase(value) {
  if (!value || typeof value !== 'object' || typeof value.phase !== 'string') return undefined;
  const elapsedMs = finiteNumber(value.elapsedMs);
  if (elapsedMs === undefined) return undefined;
  const total = finiteNumber(value.total);
  return {
    phase: value.phase,
    elapsedMs: roundMs(elapsedMs),
    ...(total === undefined ? {} : { total }),
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseBenchmark(raw) {
  if (raw === 'search') return 'quality';
  if (raw === 'p0' || raw === 'model-encode' || raw === MODEL_ENCODE_P0_BENCHMARK) return MODEL_ENCODE_P0_BENCHMARK;
  if (raw === 'quality' || raw === 'index') return raw;
  usage('benchmark must be one of: quality, search, index, model-encode-p0');
}

function parseRetrieval(raw) {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'lexical' || normalized === 'vector' || normalized === 'hybrid') return normalized;
  usage('retrieval must be one of: lexical, vector, hybrid');
}

function parseIndexActions(raw) {
  const actions = raw
    .split(',')
    .map((action) => action.trim())
    .filter(Boolean);
  if (actions.length === 0) usage('index-actions must include at least one action');
  for (const action of actions) {
    if (!INDEX_BENCHMARK_ACTIONS.has(action)) {
      usage(`index action must be one of: ${[...INDEX_BENCHMARK_ACTIONS].join(', ')}`);
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
    mib: mibNumber(byteCount),
  };
}

function visibleMarkdownFiles(root, start = root) {
  const output = [];
  for (const entry of safeReadDir(start)) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(start, entry.name);
    if (entry.isDirectory()) {
      output.push(...visibleMarkdownFiles(root, abs));
      continue;
    }
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
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

function safeCachePaths(searchStoreCachePaths, vaultRoot, env = process.env, identity = {}) {
  try {
    return searchStoreCachePaths(vaultRoot, env, identity);
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
  if (!payload || typeof payload !== 'object') return undefined;
  return typeof payload.snapshotId === 'string' ? payload.snapshotId : undefined;
}

function vaultStatus(status, vaultRoot) {
  if (!status || status.error || !Array.isArray(status.vaults)) return undefined;
  const resolved = path.resolve(vaultRoot);
  return status.vaults.find((candidate) => path.resolve(candidate.vault) === resolved);
}

function statusMemorySummary(status) {
  if (!status || status.error || !status.pools) return undefined;
  const pools = [status.pools.latencyAnalyzer, status.pools.throughputAnalyzer, status.pools.searchExecution].filter(
    Boolean,
  );
  const daemonRssValues = pools.map((pool) => pool.processMemory?.rss).filter((value) => Number.isFinite(value));
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
    completedJobs,
  };
}

function statusModelSummary(status) {
  if (!status || status.error || !status.profiles || typeof status.profiles !== 'object') return undefined;
  const profiles = {};
  for (const [profileHash, profile] of Object.entries(status.profiles)) {
    const model = profile?.model;
    if (!model || typeof model !== 'object') continue;
    const query = model.query && typeof model.query === 'object' ? model.query : {};
    const bulk = model.bulk && typeof model.bulk === 'object' ? model.bulk : {};
    profiles[profileHash] = {
      query: {
        device: query.device ?? null,
        executionProvider: query.executionProvider ?? null,
        loaded: query.loaded === true,
        mode: query.mode ?? null,
        retryAfter: query.retryAfter ?? null,
      },
      bulk: {
        devices: Array.isArray(bulk.devices)
          ? bulk.devices.map((device) => ({
              deviceId: device.deviceId ?? null,
              executionProvider: device.executionProvider ?? null,
              busy: device.busy === true,
              docsPerSec: Number.isFinite(device.docsPerSec) ? device.docsPerSec : 0,
            }))
          : [],
        queueDepth: Number.isFinite(bulk.queueDepth) ? bulk.queueDepth : 0,
        inFlight: Number.isFinite(bulk.inFlight) ? bulk.inFlight : 0,
        batchTokenBudget: Number.isFinite(bulk.batchTokenBudget) ? bulk.batchTokenBudget : null,
        etaMs: Number.isFinite(bulk.etaMs) ? bulk.etaMs : null,
      },
    };
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function printFleetSummary(modelSummary, prefix = '') {
  if (!modelSummary || typeof modelSummary !== 'object') return;
  for (const [profileHash, model] of Object.entries(modelSummary)) {
    const query = model.query ?? {};
    const bulk = model.bulk ?? {};
    const devices = (bulk.devices ?? [])
      .map(
        (device) =>
          `${device.deviceId ?? 'unknown'}/${device.executionProvider ?? 'unknown'}${device.busy ? ':busy' : ''}@${formatDocsPerSec(
            device.docsPerSec,
          )}`,
      )
      .join(',');
    console.log(
      [
        `${prefix}fleet:`,
        `profile=${shortId(profileHash)}`,
        `query=${query.device ?? 'unknown'}/${query.executionProvider ?? 'unknown'}`,
        `loaded=${query.loaded === true}`,
        `mode=${query.mode ?? 'unknown'}`,
        `retryAfter=${query.retryAfter ?? 'none'}`,
        `bulkDevices=${devices || 'none'}`,
        `queue=${bulk.queueDepth ?? 0}`,
        `inFlight=${bulk.inFlight ?? 0}`,
        `budget=${bulk.batchTokenBudget ?? 'unknown'}`,
        `eta=${bulk.etaMs === null || bulk.etaMs === undefined ? 'unknown' : formatDuration(bulk.etaMs)}`,
      ].join(' '),
    );
  }
}

function printBatchThroughputSummary(modelSummary, run, prefix = '') {
  if (!modelSummary || typeof modelSummary !== 'object') return;
  const batchedDocsPerSec = Object.values(modelSummary).reduce((sum, model) => {
    const devices = model.bulk?.devices;
    if (!Array.isArray(devices)) return sum;
    return (
      sum +
      devices.reduce((deviceSum, device) => deviceSum + (Number.isFinite(device.docsPerSec) ? device.docsPerSec : 0), 0)
    );
  }, 0);
  const batchOneQps = run ? Number(queriesPerSecond(run.total, run.elapsedMs)) : 0;
  console.log(
    [
      `${prefix}throughput:`,
      `batch1=${batchOneQps.toFixed(3)}qps`,
      `batched=${batchedDocsPerSec > 0 ? `${batchedDocsPerSec.toFixed(2)}docs/s` : 'unknown'}`,
      `ratio=${batchedDocsPerSec > 0 && batchOneQps > 0 ? (batchedDocsPerSec / batchOneQps).toFixed(2) : 'unknown'}`,
    ].join(' '),
  );
}

function formatDocsPerSec(value) {
  return Number.isFinite(value) && value > 0 ? `${value.toFixed(2)}docs/s` : '0.00docs/s';
}

function compactStatus(status, vaultRoot) {
  if (!status || status.error) return status;
  return {
    ready: status.ready,
    phase: status.phase,
    metrics: status.metrics,
    vault: vaultStatus(status, vaultRoot),
    memory: statusMemorySummary(status),
    model: statusModelSummary(status),
    searchStore: status.searchStore,
  };
}

function printIndexAction(result, context) {
  const status = result.ok ? 'ok' : 'fail';
  const snapshot = shortId(result.snapshotId ?? result.vault?.snapshotId);
  const cache = result.cache ? formatBytes(result.cache.byteCount) : 'n/a';
  const rss = result.memory?.daemonRssBytes ? formatBytes(result.memory.daemonRssBytes) : 'n/a';
  const phases = result.phases.map((phase) => `${phase.name}=${phase.elapsedMs.toFixed(1)}ms`).join(',');
  console.log(
    [
      'index:',
      `run=${result.runIndex}/${context.repeat}`,
      `action=${result.action}`,
      status,
      `elapsed=${result.elapsedMs.toFixed(1)}ms`,
      `indexBuild=${formatMs(result.indexBuildMs)}`,
      `files=${context.vault.fileCount}`,
      `md=${formatBytes(context.vault.byteCount)}`,
      `cache=${cache}`,
      `rss=${rss}`,
      `snapshot=${snapshot || 'none'}`,
      `phases=${phases || 'none'}`,
    ].join(' '),
  );
  if (result.buildPhases?.length) {
    const build = result.buildPhases.map((phase) => `${phase.phase}=${phase.elapsedMs.toFixed(0)}ms`).join(' ');
    console.log(
      [
        '       build:',
        `index=${formatMs(result.indexBuildMs)}`,
        `lexical=${formatMs(result.lexicalBuildMs)}`,
        `dense=${formatMs(result.denseBuildMs)}`,
        `preload=${formatMs(result.preloadMs)}`,
        `source=${result.buildTimingSource}`,
        build,
      ].join(' '),
    );
  }
  if (result.model) {
    printFleetSummary(result.model, '       ');
    printBatchThroughputSummary(result.model, { total: 1, elapsedMs: result.elapsedMs }, '       ');
  }
  if (!result.ok) console.log(`       error: ${result.error}`);
}

function printIndexSummary(report) {
  const daemon = report.daemonReady.ok
    ? `daemonReady=${report.daemonReady.elapsedMs.toFixed(1)}ms`
    : `daemonReady=failed:${report.daemonReady.error}`;
  console.log(
    `index.summary: benchmark=index repeat=${report.repeat} ${daemon} vaultFiles=${report.vault.fileCount} vaultBytes=${formatBytes(report.vault.byteCount)}`,
  );
  for (const action of report.actionsRequested) {
    const runs = report.actions.filter((candidate) => candidate.action === action);
    const ok = runs.filter((run) => run.ok);
    const sorted = ok.map((run) => run.elapsedMs).sort((left, right) => left - right);
    const buildSorted = ok
      .map((run) => run.indexBuildMs)
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    console.log(
      [
        'index.summary:',
        `action=${action}`,
        `ok=${ok.length}/${runs.length}`,
        `median=${median(sorted).toFixed(1)}ms`,
        `avg=${average(sorted).toFixed(1)}ms`,
        `p95=${percentile(sorted, 95).toFixed(1)}ms`,
        `indexBuildMedian=${formatMs(median(buildSorted))}`,
        `indexBuildAvg=${formatMs(average(buildSorted))}`,
        `indexBuildP95=${formatMs(percentile(buildSorted, 95))}`,
      ].join(' '),
    );
  }
}

function shortId(value) {
  return typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : 'n/a';
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
  const progress = createEvaluationProgress({
    enabled: shouldRenderProgress(options),
    total: queryCases.length,
    concurrency,
    runIndex,
  });

  const runStarted = performance.now();
  try {
    await runQueryCases(queryCases, concurrency, async (queryCase, caseIndex) => {
      progress.start(queryCase, caseIndex);
      const started = performance.now();
      const result = await runSearch(queryCase);
      const elapsed = performance.now() - started;
      timings.push(elapsed);

      if (!result.ok) {
        failed += 1;
        recordMetrics(overallMetrics, undefined, elapsed);
        recordTaskMetrics(taskMetrics, queryCase, undefined, elapsed);
        failures.push(createFailure({ queryCase, caseIndex, elapsed, error: result.error }));
        if (shouldPrintCase(options, 'FAIL')) {
          printCase('FAIL', elapsed, queryLabel(queryCase), result.error);
        }
        progress.finish({ passed, failed });
        return;
      }

      const paths = result.payload.matches.map((match) => match.path);
      const ranking = rankingMetrics(paths, queryCase);
      const rank = ranking.rank;
      recordMetrics(overallMetrics, ranking, elapsed);
      recordTaskMetrics(taskMetrics, queryCase, ranking, elapsed);
      const ok = matchesExpectation(paths, queryCase);
      if (ok) {
        passed += 1;
        if (shouldPrintCase(options, 'OK')) {
          printCase('OK', elapsed, queryLabel(queryCase), paths.slice(0, 3).join(' | '));
        }
      } else {
        failed += 1;
        failures.push(createFailure({ queryCase, caseIndex, elapsed, paths, rank }));
        if (shouldPrintCase(options, 'FAIL')) {
          printCase('FAIL', elapsed, queryLabel(queryCase), paths.slice(0, 3).join(' | '));
          const expected = expectedPaths(queryCase).join(', ') || '(no expectation)';
          console.log(`      expected: ${expected}`);
        }
      }
      progress.finish({ passed, failed });
    });
  } finally {
    progress.close({ passed, failed });
  }

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
    failures,
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

function createEvaluationProgress({ enabled, total, concurrency, runIndex }) {
  const writer = createProgressWriter({ enabled, intervalMs: 1000 });
  const startedAt = performance.now();
  let active = 0;
  let started = 0;
  let completed = 0;
  let passed = 0;
  let failed = 0;
  let current = '';

  const render = () => {
    const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 1;
    const elapsedMs = performance.now() - startedAt;
    const rate = elapsedMs > 0 ? completed / (elapsedMs / 1000) : 0;
    const remaining = Math.max(0, total - completed);
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : undefined;
    const runLabel = runIndex ? ` run=${runIndex}` : '';
    const currentText = current ? ` current=${truncateMiddle(current, 48)}` : '';
    return [
      `eval${runLabel}`,
      `queries ${progressBar(ratio, total > 0)} ${Math.floor(ratio * 100)
        .toString()
        .padStart(3)}%`,
      `${completed}/${total}`,
      `started=${started}`,
      `active=${active}/${Math.min(concurrency, Math.max(total, 1))}`,
      `passed=${passed}`,
      `failed=${failed}`,
      `elapsed=${formatDuration(elapsedMs)}`,
      `rate=${formatRate(rate)}`,
      `eta=${etaMs === undefined ? 'unknown' : formatDuration(etaMs)}${currentText}`,
    ].join(' ');
  };

  const timer = setInterval(() => writer.write(render()), 1000);
  timer.unref();
  writer.write(render(), { force: true });

  return {
    start(queryCase, caseIndex) {
      active += 1;
      started += 1;
      current = `${caseIndex + 1}:${queryLabel(queryCase)}`;
      writer.write(render(), { force: started === 1 });
    },
    finish(counts) {
      active = Math.max(0, active - 1);
      completed += 1;
      passed = counts.passed;
      failed = counts.failed;
      writer.write(render(), { force: completed === total });
    },
    close(counts) {
      clearInterval(timer);
      passed = counts.passed;
      failed = counts.failed;
      completed = Math.max(completed, passed + failed);
      active = 0;
      writer.finish(render());
    },
  };
}

function createProgressWriter({ enabled, intervalMs }) {
  const interactive = process.stderr.isTTY === true;
  let lastLength = 0;
  let lastLine = '';
  let lastWrite = 0;

  return {
    write(line, { force = false } = {}) {
      if (!enabled) return;
      const now = Date.now();
      if (!force && !interactive) {
        if (line === lastLine) return;
        if (now - lastWrite < intervalMs) return;
      }
      lastLine = line;
      lastWrite = now;
      if (interactive) {
        const padded = line.padEnd(lastLength);
        lastLength = Math.max(lastLength, line.length);
        process.stderr.write(`\r${padded}`);
      } else {
        process.stderr.write(`${line}\n`);
      }
    },
    clear() {
      if (!enabled || !interactive || lastLength === 0) return;
      process.stderr.write(`\r${' '.repeat(lastLength)}\r`);
      lastLength = 0;
    },
    finish(line) {
      if (!enabled) return;
      if (interactive) {
        this.write(line, { force: true });
        process.stderr.write('\n');
        lastLength = 0;
      } else if (line && line !== lastLine) {
        this.write(line, { force: true });
      }
    },
  };
}

function progressBar(ratio, knownTotal) {
  const filled = knownTotal ? Math.round(ratio * 20) : 0;
  return `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}s`;
}

function formatRate(itemsPerSecond) {
  if (!Number.isFinite(itemsPerSecond) || itemsPerSecond <= 0) return '0.00it/s';
  if (itemsPerSecond >= 100) return `${itemsPerSecond.toFixed(1)}it/s`;
  return `${itemsPerSecond.toFixed(2)}it/s`;
}

function parsePositiveInt(raw, name) {
  if (!/^\d+$/.test(raw)) usage(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) usage(`${name} must be a positive integer`);
  return parsed;
}

function parsePositiveIntList(raw, name) {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parsePositiveInt(value, name));
  if (values.length === 0) usage(`${name} must include at least one positive integer`);
  return values;
}

function parseStringList(raw, name) {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) usage(`${name} must include at least one value`);
  return values;
}

function parseExecutionProviders(raw) {
  const providers = parseStringList(raw, 'execution-providers');
  for (const provider of providers) {
    if (!['cuda', 'cpu'].includes(provider)) usage('execution-providers must include only cuda,cpu');
  }
  return providers;
}

async function searchRunner(mode, cliPath, vaultRoot, options) {
  if (mode === 'e2e') {
    return {
      runSearch: (queryCase) => runE2eSearch(cliPath, vaultRoot, queryCase, options),
      indexWarmup: {
        mode,
        ok: true,
        elapsedMs: 0,
        buildPhases: [],
        indexBuildMs: 0,
        lexicalBuildMs: 0,
        denseBuildMs: 0,
        preloadMs: 0,
        buildTimingSource: 'not-applicable',
        buildTimingResolutionMs: 0,
      },
      status: undefined,
    };
  }
  try {
    const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
    const client = createSearchDaemonClient({
      binaryPath: cliPath,
      env: searchEvalEnv(options),
    });
    const indexWarmup = await loadPinnedSnapshot(client, vaultRoot, {
      progress: shouldRenderProgress(options),
      deadlineMs: options.deadlineMs,
    });
    let pinnedSnapshotId = indexWarmup.snapshotId;
    return {
      indexWarmup,
      status: () => client.status({ deadlineMs: options.deadlineMs ?? 15000 }),
      runSearch: async (queryCase) => {
        try {
          const payload = await client.search({
            vault: vaultRoot,
            ...(pinnedSnapshotId ? { snapshotId: pinnedSnapshotId } : {}),
            ...coreSearchParams(queryCase, options.retrieval),
          });
          if (!pinnedSnapshotId && payload.snapshotId) pinnedSnapshotId = payload.snapshotId;
          return { ok: true, payload };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
    };
  } catch (error) {
    usage(`Core mode failed to prepare the search daemon: ${error.message}`);
  }
}

function parseSuite(raw) {
  const split = raw.indexOf(':');
  if (split <= 0) usage('--suite must be NAME:/path/to/queries.json');
  return {
    name: raw.slice(0, split),
    spec: path.resolve(raw.slice(split + 1)),
  };
}

function runOfflineExplainTrace(options) {
  if (options.format && options.format !== 'json') usage('--offline-explain-trace only supports --format=json');
  const trace = JSON.parse(fs.readFileSync(options.offlineExplainTrace, 'utf8'));
  validateOfflineExplainTrace(trace);
  const rankedOutput = replayOfflineExplainTrace(trace);
  const outputHash = sha256(canonicalJson(rankedOutput));
  if (outputHash !== trace.expectedOutputHash) {
    throwTraceValidation(`output hash mismatch: expected ${trace.expectedOutputHash}, got ${outputHash}`);
  }
  console.log(JSON.stringify({ rankedOutput, outputHash }, null, 2));
}

function validateOfflineExplainTrace(trace) {
  if (trace?.schemaVersion !== 1) throwTraceValidation('trace validation failed: schemaVersion must be 1');
  if (trace.rankingAlgorithmId !== 'unified-scalar-ac4-v1') {
    throwTraceValidation(`ranking algorithm mismatch: ${trace.rankingAlgorithmId}`);
  }
  if (trace.frozenReplayFormulaVersion !== 'unified-scalar-ac4-v1/offline-1') {
    throwTraceValidation(`ranking algorithm replay formula mismatch: ${trace.frozenReplayFormulaVersion}`);
  }
  if (!deepEqualCanonical(trace.rankingConfig, trace.inputs?.rankingConfig)) {
    throwTraceValidation('ranking config mismatch between trace header and inputs');
  }
  if (
    !trace.inputs?.candidateSet ||
    !Array.isArray(trace.inputs.candidateSet.candidates) ||
    trace.inputs.candidateSet.candidates.length === 0
  ) {
    throwTraceValidation('candidate set is empty or missing');
  }
  if (!Array.isArray(trace.inputs?.featurePayloads)) {
    throwTraceValidation('candidate feature payloads are missing');
  }
  if (!trace.inputs?.queryAnalysis || typeof trace.inputs.queryAnalysis !== 'object') {
    throwTraceValidation('query analysis is missing');
  }
  if (typeof trace.expectedOutputHash !== 'string' || !/^[0-9a-f]{64}$/.test(trace.expectedOutputHash)) {
    throwTraceValidation('expected output hash is missing or invalid');
  }
  const featuresByCandidate = featurePayloadMap(trace.inputs.featurePayloads);
  for (const candidate of trace.inputs.candidateSet.candidates) {
    if (!candidate?.candidateId || !candidate?.documentId)
      throwTraceValidation('candidate is missing candidateId/documentId');
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
    const lexicalScore = featureLexicalScore(feature, config);
    const identityScore = identityScoreFromExactPriority(exactPriority);
    const proximityScore = featureProximityScore(feature);
    const denseAgreement = numberOrZero(feature.denseAgreement ?? feature.retrieverSignals?.dense?.normalizedScore);
    const linkAgreement = numberOrZero(feature.linkAgreement ?? feature.retrieverSignals?.link?.normalizedScore);
    return {
      path: candidate.path ?? feature.candidate?.path ?? candidate.documentId,
      bucket: rankBucket(exactPriority, phrasePriority, coverageTerms, config),
      score: 0,
      baseRank: index + 1,
      exactPriority,
      phrasePriority,
      coverageTerms,
      coverageFieldScore,
      lexicalScore,
      identityScore,
      exactLambda: config.exactLambda,
      denseAgreement,
      linkAgreement,
      rrfScore: numberOrZero(feature.rrfScore),
      rarityScore: 0,
      proximityScore,
      bodyScore: 0,
    };
  });
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate, config),
    }))
    .sort(compareRankedMatches)
    .map(rankedOutputCandidate);
}

function normalizeRankingConfig(config) {
  const constants = config.constants ?? {};
  const lambdas = constants.SEARCH_SCORING_LAMBDAS ?? { phrase: 0.06, exact: 0, dense: 0, link: 0 };
  return {
    lambdas: {
      phrase: numberOrZero(lambdas.phrase),
      exact: numberOrZero(lambdas.exact),
      dense: numberOrZero(lambdas.dense),
      link: numberOrZero(lambdas.link),
    },
    exactLambda: numberOrZero(config.exactDominanceBound?.lambdaExact ?? lambdas.exact),
    tokenChannelWeights: constants.SEARCH_TOKEN_CHANNEL_WEIGHT ?? { morph: 1, surface: 0.65, ngram: 0.3 },
    fieldChannelBoosts: constants.SEARCH_FIELD_CHANNEL_BOOST ?? {
      morph: { title: 8, tags: 7, aliases: 6, headings: 4, path: 2, body: 1 },
      surface: { title: 6, tags: 5, aliases: 4, headings: 3, path: 1.5, body: 0.8 },
      ngram: { title: 3, tags: 2.5, aliases: 2, headings: 1.5, path: 1, body: 0.4 },
    },
    coverageBucketMinTerms: constants.COVERAGE_BUCKET_MIN_TERMS ?? 1,
    exactPriority: constants.EXACT_PRIORITY ?? { title: 0, alias: 1, filenameStem: 2 },
  };
}

function featureLexicalScore(feature, config) {
  let score = 0;
  for (const term of canonicalBm25Order(feature?.bm25 ?? [])) {
    score +=
      numberOrZero(term.score) *
      numberOrZero(config.tokenChannelWeights[term.channel]) *
      numberOrZero(config.fieldChannelBoosts[term.channel]?.[term.field]);
  }
  return score;
}

function canonicalBm25Order(terms) {
  return [...terms].sort(compareCanonicalBm25Terms);
}

function compareCanonicalBm25Terms(left, right) {
  return (
    SEARCH_TOKEN_CHANNELS.indexOf(left.channel) - SEARCH_TOKEN_CHANNELS.indexOf(right.channel) ||
    numberOrZero(left.fieldId) - numberOrZero(right.fieldId) ||
    String(left.term ?? '').localeCompare(String(right.term ?? ''))
  );
}

function featureProximityScore(feature) {
  return (feature?.proximity ?? []).reduce((sum, match) => sum + numberOrZero(match.score), 0);
}

function identityScoreFromExactPriority(priority) {
  if (priority === 0) return 3;
  if (priority === 1) return 2;
  if (priority === 2) return 1;
  return 0;
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

function rerankScore(candidate, config) {
  return (
    numberOrZero(candidate.lexicalScore) +
    numberOrZero(config.lambdas.phrase) * numberOrZero(candidate.proximityScore) +
    numberOrZero(candidate.exactLambda) * numberOrZero(candidate.identityScore) +
    numberOrZero(config.lambdas.dense) * numberOrZero(candidate.denseAgreement) +
    numberOrZero(config.lambdas.link) * numberOrZero(candidate.linkAgreement)
  );
}

function compareRankedMatches(left, right) {
  if (right.score !== left.score) return right.score - left.score;
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
    lexicalScore: candidate.lexicalScore,
    identityScore: candidate.identityScore,
    exactLambda: candidate.exactLambda,
    denseAgreement: candidate.denseAgreement,
    linkAgreement: candidate.linkAgreement,
    rrfScore: candidate.rrfScore,
    rarityScore: candidate.rarityScore,
    proximityScore: candidate.proximityScore,
    bodyScore: candidate.bodyScore,
  };
  return output;
}

function rankBucketName(bucket) {
  if (bucket === 0) return 'exact';
  if (bucket === 1) return 'phrase';
  if (bucket === 2) return 'coverage';
  return 'base';
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function loadPinnedSnapshot(client, vaultRoot, options = {}) {
  const loadPhase = await timedPhase('warmup-load', () =>
    withWarmupProgress(client, vaultRoot, options, () =>
      client.loadVault({
        vault: vaultRoot,
        ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
      }),
    ),
  );
  if (!loadPhase.ok) throw new Error(loadPhase.error);
  const loadResult = loadPhase.value;
  const buildTiming = requireDaemonBuildTiming(loadResult?.buildTiming, 'warmup-load');
  const loadedSnapshotId = payloadSnapshotId(loadResult);
  const warmup = {
    mode: 'core',
    ok: true,
    elapsedMs: loadPhase.elapsedMs,
    buildPhases: buildTiming.phases,
    ...indexBuildTimingFields(buildTiming),
    ...(loadedSnapshotId ? { snapshotId: loadedSnapshotId } : {}),
  };

  if (loadedSnapshotId) return warmup;

  const failed = loadResult?.vaults?.find(
    (vault) => path.resolve(vault.vaultRoot) === path.resolve(vaultRoot) && vault.status === 'failed',
  );
  if (failed) {
    throw new Error(`warm LoadVault failed: ${failed.error ?? 'unknown error'}`);
  }

  const status = await client.status({ deadlineMs: options.deadlineMs ?? 30000 });
  const resolvedVault = path.resolve(vaultRoot);
  const vault = status.vaults.find((candidate) => path.resolve(candidate.vault) === resolvedVault);
  if (!vault?.snapshotId) {
    const error = vault?.error ? `: ${vault.error}` : '';
    throw new Error(`warm LoadVault did not produce a snapshot${error}`);
  }
  return { ...warmup, snapshotId: vault.snapshotId };
}

async function runSearchWarmup(runSearch, queryCase) {
  const phase = await timedPhase('warmup-search', () => runSearch({ ...queryCase, limit: 1 }));
  return phase.ok
    ? { ok: true, elapsedMs: phase.elapsedMs }
    : { ok: false, elapsedMs: phase.elapsedMs, error: phase.error };
}

async function withWarmupProgress(client, vaultRoot, options, run) {
  if (!options.progress) return run();

  const writer = createProgressWriter({ enabled: true, intervalMs: 1000 });
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      writer.write(renderWarmupProgress(await client.status({ deadlineMs: 1000 }), vaultRoot));
    } catch {
      writer.write(`warmup loading ${path.basename(path.resolve(vaultRoot))}`);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 500);
  timer.unref();
  void poll();
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    clearInterval(timer);
    writer.finish(`warmup ${ok ? 'done' : 'stopped'} ${path.basename(path.resolve(vaultRoot))}`);
  }
}

function shouldRenderProgress(options) {
  return options.noProgress !== true;
}

function renderWarmupProgress(status, vaultRoot) {
  const resolvedVault = path.resolve(vaultRoot);
  const vault = status.vaults.find((candidate) => path.resolve(candidate.vault) === resolvedVault);
  if (!vault?.progress) return `warmup ${vault?.state ?? 'loading'} ${path.basename(resolvedVault)}`;
  const progress = vault.progress;
  const completed = progress.completed ?? 0;
  const total = progress.total;
  const ratio = total && total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  const filled = total === undefined ? 0 : Math.round(ratio * 20);
  const bar = `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
  const percent =
    total && total > 0
      ? `${Math.floor(ratio * 100)
          .toString()
          .padStart(3)}%`
      : ' --%';
  const counts = total === undefined ? String(completed) : `${completed}/${total}`;
  const current = progress.current ? ` ${truncateMiddle(progress.current, 36)}` : '';
  const message = progress.message ? ` ${progress.message}` : '';
  return `warmup ${progress.phase} ${bar} ${percent} ${counts} ${path.basename(resolvedVault)}${current}${message}`;
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function coreSearchParams(queryCase, retrieval) {
  return {
    query: queryCase.query || undefined,
    path: queryCase.path,
    tags: parseTags(queryCase),
    fields: parseFields(queryCase.field),
    limit: queryCase.limit ?? 10,
    deadlineMs: queryCase.deadlineMs ?? 30000,
    ...(retrieval && retrieval !== 'lexical' ? { retrieval } : {}),
  };
}

function runE2eSearch(cliPath, vaultRoot, queryCase, options) {
  const cliArgs = [cliPath, 'search', 'format=json', `limit=${queryCase.limit ?? 10}`, `vault-path=${vaultRoot}`];
  if (queryCase.query) cliArgs.push(`query=${queryCase.query}`);
  const tags = parseTags(queryCase);
  if (tags?.length) cliArgs.push(`tag=${tags.join(',')}`);
  if (queryCase.path) cliArgs.push(`path=${queryCase.path}`);
  const fields = parseFields(queryCase.field);
  if (fields?.length) cliArgs.push(`field=${fields.join(',')}`);
  if (options.retrieval && options.retrieval !== 'lexical') cliArgs.push(`retrieval=${options.retrieval}`);

  const child = spawnSync(process.execPath, cliArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: searchEvalEnv(options),
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
  if (queryCase.tag)
    return String(queryCase.tag)
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  return undefined;
}

function parseFields(value) {
  if (Array.isArray(value)) return value;
  if (!value) return undefined;
  return String(value)
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

function searchEvalEnv(options) {
  const workers = effectiveEvalWorkers(options);
  return {
    ...process.env,
    OPTSIDIAN_SEARCH_NGRAM: options.ngram === true ? 'true' : 'false',
    OPTSIDIAN_SEARCH_WORKERS: String(workers),
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(workers),
    OPTSIDIAN_SEARCH_QUERY_WORKERS: process.env.OPTSIDIAN_SEARCH_QUERY_WORKERS ?? '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: process.env.OPTSIDIAN_SEARCH_INDEX_WORKERS ?? '1',
  };
}

function effectiveEvalWorkers(options) {
  return (
    options.workers ??
    envPositiveInt(process.env.OPTSIDIAN_SEARCH_EXECUTION_WORKERS) ??
    envPositiveInt(process.env.OPTSIDIAN_SEARCH_WORKERS) ??
    defaultSearchExecutionWorkers()
  );
}

function defaultSearchExecutionWorkers() {
  const logicalBudget = Math.max(
    4,
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  );
  return Math.max(1, Math.min(4, Math.floor(logicalBudget / 4)));
}

function envPositiveInt(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBooleanOption(raw, name) {
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  usage(`${name} must be on or off`);
}

function matchesExpectation(paths, queryCase) {
  const relevance = relevanceMap(queryCase);
  if (relevance.size > 0) return paths.some((candidate) => (relevance.get(candidate) ?? 0) > 0);
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

function rankingMetrics(paths, queryCase) {
  const relevance = relevanceMap(queryCase);
  if (relevance.size === 0) {
    return { rank: expectedRank(paths, queryCase), hasQrels: false };
  }

  const positiveRelevance = [...relevance.values()].filter((score) => score > 0).sort((left, right) => right - left);
  const positiveCount = positiveRelevance.length;
  const rankIndex = paths.findIndex((candidate) => (relevance.get(candidate) ?? 0) > 0);
  const rank = rankIndex === -1 ? 0 : rankIndex + 1;
  let positiveSeen = 0;
  let averagePrecisionSum = 0;

  for (let index = 0; index < paths.length; index += 1) {
    if ((relevance.get(paths[index]) ?? 0) <= 0) continue;
    positiveSeen += 1;
    averagePrecisionSum += positiveSeen / (index + 1);
  }

  return {
    rank,
    hasQrels: true,
    precision1: precisionAt(paths, relevance, 1),
    precision3: precisionAt(paths, relevance, 3),
    precision5: precisionAt(paths, relevance, 5),
    precision10: precisionAt(paths, relevance, 10),
    averagePrecision: positiveCount > 0 ? averagePrecisionSum / positiveCount : 0,
    ndcg10: ndcgAt(paths, relevance, positiveRelevance, 10),
  };
}

function relevanceMap(queryCase) {
  const source = queryCase.relevance ?? queryCase.relevant ?? queryCase.qrels;
  const map = new Map();
  if (!source) return map;

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (Array.isArray(entry) && entry.length >= 2) {
        map.set(String(entry[0]), Number(entry[1]));
      } else if (entry && typeof entry === 'object') {
        const candidatePath = entry.path ?? entry.expected ?? entry.doc ?? entry.document ?? entry.documentPath;
        const score = entry.relevance ?? entry.score ?? entry.grade;
        if (candidatePath !== undefined && score !== undefined) map.set(String(candidatePath), Number(score));
      }
    }
    return map;
  }

  if (typeof source === 'object') {
    for (const [candidatePath, score] of Object.entries(source)) {
      map.set(candidatePath, Number(score));
    }
  }

  return map;
}

function precisionAt(paths, relevance, cutoff) {
  let relevant = 0;
  for (const candidate of paths.slice(0, cutoff)) {
    if ((relevance.get(candidate) ?? 0) > 0) relevant += 1;
  }
  return relevant / cutoff;
}

function ndcgAt(paths, relevance, positiveRelevance, cutoff) {
  const dcg = paths.slice(0, cutoff).reduce((sum, candidate, index) => {
    const score = relevance.get(candidate) ?? 0;
    if (score <= 0) return sum;
    return sum + dcgGain(score, index + 1);
  }, 0);
  const ideal = positiveRelevance.slice(0, cutoff).reduce((sum, score, index) => sum + dcgGain(score, index + 1), 0);
  return ideal > 0 ? dcg / ideal : 0;
}

function dcgGain(relevance, rank) {
  return (2 ** relevance - 1) / Math.log2(rank + 1);
}

function createMetrics() {
  return {
    total: 0,
    top1: 0,
    recall3: 0,
    recall5: 0,
    recall10: 0,
    reciprocalRank: 0,
    qrelTotal: 0,
    precision1: 0,
    precision3: 0,
    precision5: 0,
    precision10: 0,
    averagePrecision: 0,
    ndcg10: 0,
    timings: [],
  };
}

function recordTaskMetrics(taskMetrics, queryCase, ranking, elapsed) {
  if (!queryCase.task) return;
  if (!taskMetrics.has(queryCase.task)) taskMetrics.set(queryCase.task, createMetrics());
  recordMetrics(taskMetrics.get(queryCase.task), ranking, elapsed);
}

function recordMetrics(metrics, ranking, elapsed) {
  metrics.total += 1;
  metrics.timings.push(elapsed);
  const rank = ranking?.rank;
  if (rank === undefined) return;
  if (rank === 1) metrics.top1 += 1;
  if (rank > 0 && rank <= 3) metrics.recall3 += 1;
  if (rank > 0 && rank <= 5) metrics.recall5 += 1;
  if (rank > 0 && rank <= 10) {
    metrics.recall10 += 1;
    metrics.reciprocalRank += 1 / rank;
  }
  if (ranking.hasQrels) {
    metrics.qrelTotal += 1;
    metrics.precision1 += ranking.precision1;
    metrics.precision3 += ranking.precision3;
    metrics.precision5 += ranking.precision5;
    metrics.precision10 += ranking.precision10;
    metrics.averagePrecision += ranking.averagePrecision;
    metrics.ndcg10 += ranking.ndcg10;
  }
}

function metricsLine(label, metrics) {
  const sortedTimings = [...metrics.timings].sort((a, b) => a - b);
  const denominator = metrics.total || 1;
  const parts = [
    `${label}: n=${metrics.total}`,
    `top1=${ratio(metrics.top1, denominator)}`,
    `recall@3=${ratio(metrics.recall3, denominator)}`,
    `recall@5=${ratio(metrics.recall5, denominator)}`,
    `recall@10=${ratio(metrics.recall10, denominator)}`,
    `mrr@10=${ratio(metrics.reciprocalRank, denominator)}`,
  ];
  if (metrics.qrelTotal > 0) {
    const qrelDenominator = metrics.qrelTotal;
    parts.push(
      `qrels=${metrics.qrelTotal}`,
      `p@1=${ratio(metrics.precision1, qrelDenominator)}`,
      `p@3=${ratio(metrics.precision3, qrelDenominator)}`,
      `p@5=${ratio(metrics.precision5, qrelDenominator)}`,
      `p@10=${ratio(metrics.precision10, qrelDenominator)}`,
      `map=${ratio(metrics.averagePrecision, qrelDenominator)}`,
      `ndcg@10=${ratio(metrics.ndcg10, qrelDenominator)}`,
    );
  }
  parts.push(
    `avg=${average(metrics.timings).toFixed(1)}ms`,
    `p50=${percentile(sortedTimings, 50).toFixed(1)}ms`,
    `p95=${percentile(sortedTimings, 95).toFixed(1)}ms`,
  );
  return parts.join(' ');
}

function printWarmupSummary(warmup, context) {
  const index = warmup.index ?? {};
  const search = warmup.search;
  const summary = [
    `warmup: mode=${context.mode}`,
    `retrieval=${context.retrieval}`,
    `indexElapsed=${formatMs(index.elapsedMs)}`,
    `indexBuild=${formatMs(index.indexBuildMs)}`,
    `lexical=${formatMs(index.lexicalBuildMs)}`,
    `dense=${formatMs(index.denseBuildMs)}`,
    `preload=${formatMs(index.preloadMs)}`,
    `source=${index.buildTimingSource ?? 'n/a'}`,
    `search=${search ? (search.ok ? formatMs(search.elapsedMs) : `fail:${search.error}`) : 'skipped'}`,
    `snapshot=${shortId(index.snapshotId) || 'none'}`,
  ];
  console.log(summary.join(' '));
  if (index.buildPhases?.length) {
    const phases = index.buildPhases.map((phase) => `${phase.phase}=${phase.elapsedMs.toFixed(0)}ms`).join(' ');
    console.log(`        build: ${phases}`);
  }
}

function printRunSummary(run, context) {
  const sortedTimings = [...run.timings].sort((a, b) => a - b);
  const prefix = context.repeat > 1 ? `run ${context.runIndex}/${context.repeat} ` : '';
  const summary = [
    `${prefix}summary: mode=${context.mode}`,
    `retrieval=${context.retrieval}`,
    `concurrency=${context.concurrency}`,
    `${run.passed}/${run.total} passed`,
    `total=${run.elapsedMs.toFixed(1)}ms`,
    `qps=${queriesPerSecond(run.total, run.elapsedMs)}`,
    `p50=${percentile(sortedTimings, 50).toFixed(1)}ms`,
    `p95=${percentile(sortedTimings, 95).toFixed(1)}ms`,
  ];
  console.log(summary.join(' '));
  printPrefixedMetrics('score', run.overallMetrics, prefix);
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
    `retrieval=${context.retrieval}`,
    `concurrency=${context.concurrency}`,
    `passedMedian=${median(runs.map((run) => run.passed)).toFixed(1)}/${total}`,
    `top1Median=${median(scoreSummaries.map((score) => score.top1)).toFixed(3)}`,
    `recall@10Median=${median(scoreSummaries.map((score) => score.recall10)).toFixed(3)}`,
    `mrr@10Median=${median(scoreSummaries.map((score) => score.mrr10)).toFixed(3)}`,
    `avgMedian=${median(scoreSummaries.map((score) => score.avgMs)).toFixed(1)}ms`,
    `p50Median=${median(scoreSummaries.map((score) => score.p50Ms)).toFixed(1)}ms`,
    `p95Median=${median(scoreSummaries.map((score) => score.p95Ms)).toFixed(1)}ms`,
  ];
  console.log(summary.join(' '));
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
      rank: rankingMetrics(paths, failure.queryCase).rank ?? null,
      topMatches: paths.slice(0, Math.min(paths.length, limit)),
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
    ...(error ? { error } : {}),
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
    limit: queryCase.limit ?? 10,
  };
}

function failureExpectationKind(queryCase) {
  if (relevanceMap(queryCase).size > 0) {
    return 'relevance';
  }
  if (queryCase.expected) {
    return 'any';
  }
  if (queryCase.expectFirst) {
    return 'first';
  }
  if (queryCase.expectIncludes) {
    return 'includes';
  }
  return 'none';
}

function createFailureReport({
  mode,
  retrieval,
  concurrency,
  measureSpeed,
  repeat,
  specPath,
  vaultRoot,
  warmup,
  inspectLimit,
  runs,
}) {
  const allFailures = runs.flatMap((run) => run.failures);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode,
    retrieval,
    concurrency,
    measureSpeed,
    repeat,
    specPath,
    vaultRoot,
    warmup: serializeWarmup(warmup),
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
          .map(([task, metrics]) => [task, summarizeMetrics(metrics)]),
      ),
      failureSummary: summarizeFailures(run.failures),
      failures: run.failures.map(serializeFailure),
    })),
  };
}

function serializeWarmup(warmup) {
  return {
    index: warmup.index ? serializeIndexWarmup(warmup.index) : undefined,
    search: warmup.search ? { ...warmup.search } : undefined,
  };
}

function serializeIndexWarmup(warmup) {
  return {
    mode: warmup.mode,
    ok: warmup.ok,
    elapsedMs: warmup.elapsedMs,
    indexBuildMs: warmup.indexBuildMs,
    lexicalBuildMs: warmup.lexicalBuildMs,
    denseBuildMs: warmup.denseBuildMs,
    preloadMs: warmup.preloadMs,
    buildTimingSource: warmup.buildTimingSource,
    buildTimingResolutionMs: warmup.buildTimingResolutionMs,
    buildPhases: warmup.buildPhases ?? [],
    ...(warmup.snapshotId ? { snapshotId: warmup.snapshotId } : {}),
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
    ...(failure.inspect ? { inspect: failure.inspect } : {}),
  };
}

function summarizeFailures(failures) {
  const summary = emptyFailureSummary();

  for (const failure of failures) {
    const classification = classifyFailure(failure);
    countFailure(summary, classification);

    const task = failure.case.task ?? 'unknown';
    summary.byTask[task] ??= emptyFailureTaskSummary();
    countFailure(summary.byTask[task], classification);
  }

  return finalizeFailureSummary(summary);
}

function emptyFailureSummary() {
  return {
    ...emptyFailureTaskSummary(),
    byTask: {},
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
    byKind: {},
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
    byKind: sortedCountRecord(summary.byKind),
  };

  if (summary.byTask) {
    finalized.byTask = Object.fromEntries(
      Object.entries(summary.byTask)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([task, taskSummary]) => [
          task,
          {
            ...taskSummary,
            byKind: sortedCountRecord(taskSummary.byKind),
          },
        ]),
    );
  }

  return finalized;
}

function sortedCountRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
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
  const top1Miss = failure.case.expectation === 'first' && scoringRank !== null && scoringRank > 1;
  const topKMiss = scoringMiss;
  const top10Miss = topKMiss && scoringLimit >= 10;
  const top50Missing = inspectLimit >= 50 && inspectMiss;
  const rerankMiss = topKMiss && inspectHit;
  const candidateLimit = inspectMiss && inspectReturned >= inspectLimit;
  const lexicalMissing = inspectMiss && inspectReturned < inspectLimit;

  let kind = 'expectation-mismatch';
  if (error) {
    kind = failure.error ? 'search-error' : 'inspect-error';
  } else if (top1Miss) {
    kind = 'top1-miss';
  } else if (rerankMiss) {
    kind = 'rerank-miss';
  } else if (candidateLimit) {
    kind = 'candidate-limit';
  } else if (lexicalMissing) {
    kind = 'lexical-missing';
  } else if (topKMiss) {
    kind = 'topk-miss';
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
    error,
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
    p95MsMedian: median(scoreSummaries.map((summary) => summary.p95Ms)),
  };
}

function summarizeMetrics(metrics) {
  const sortedTimings = [...metrics.timings].sort((a, b) => a - b);
  const denominator = metrics.total || 1;
  const summary = {
    n: metrics.total,
    top1: Number(ratio(metrics.top1, denominator)),
    recall3: Number(ratio(metrics.recall3, denominator)),
    recall5: Number(ratio(metrics.recall5, denominator)),
    recall10: Number(ratio(metrics.recall10, denominator)),
    mrr10: Number(ratio(metrics.reciprocalRank, denominator)),
    avgMs: roundMs(average(metrics.timings)),
    p50Ms: roundMs(percentile(sortedTimings, 50)),
    p95Ms: roundMs(percentile(sortedTimings, 95)),
  };
  if (metrics.qrelTotal > 0) {
    const qrelDenominator = metrics.qrelTotal;
    summary.qrels = metrics.qrelTotal;
    summary.precision1 = Number(ratio(metrics.precision1, qrelDenominator));
    summary.precision3 = Number(ratio(metrics.precision3, qrelDenominator));
    summary.precision5 = Number(ratio(metrics.precision5, qrelDenominator));
    summary.precision10 = Number(ratio(metrics.precision10, qrelDenominator));
    summary.map = Number(ratio(metrics.averagePrecision, qrelDenominator));
    summary.ndcg10 = Number(ratio(metrics.ndcg10, qrelDenominator));
  }
  return summary;
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
  if (elapsedMs <= 0) return '0.000';
  return ((total / elapsedMs) * 1000).toFixed(3);
}

function queryLabel(queryCase) {
  if (queryCase.tag && !queryCase.query) return `tag:${queryCase.tag}`;
  return queryCase.query ?? '(empty query)';
}

function shouldPrintCase(options, status) {
  if (options.quiet) return false;
  if (options.verbose) return true;
  return status !== 'OK';
}

function printCase(status, elapsed, label, details) {
  const paddedStatus = status.padEnd(4);
  const elapsedText = elapsed === undefined ? '' : ` ${`${elapsed.toFixed(1)}ms`.padStart(8)}`;
  console.log(`${paddedStatus}${elapsedText} ${label} -> ${details}`);
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
  console.error(
    'Usage: npm run search:eval -- <vault-path> [--benchmark=quality|index|model-encode-p0] [--mode=core|e2e] [--retrieval=lexical|vector|hybrid] [--spec=<queries.json>] [--cli=<dist/optsidian>] [--ngram=off|on] [--quiet] [--score-only] [--measure-speed] [--workers=<n>] [--concurrency=<n>] [--repeat=<n>] [--failure-report=<path>] [--failure-inspect-limit=<n>] [--no-warmup] [--no-progress]',
  );
  console.error(
    '       npm run search:eval -- <vault-path> --benchmark=index [--index-actions=clear-load,rebuild,load] [--ngram=off|on] [--repeat=<n>] [--deadline-ms=<n>] [--format=json]',
  );
  console.error(
    '       npm run search:eval -- --benchmark=model-encode-p0 [--models=bge-m3,multilingual-e5-small] [--execution-providers=cuda,cpu] [--seq-lengths=32,128,512] [--batch-sizes=1,4,8] [--format=json]',
  );
  console.error('       npm run search:eval -- --print-search-daemon-slo-fixture');
  process.exit(code);
}
