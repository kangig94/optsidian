import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const searchEval = path.join(repoRoot, 'scripts/search-eval.mjs');

test('model encode P0 harness dry-run reports the required measurement sections', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      searchEval,
      '--benchmark=model-encode-p0',
      '--p0-dry-run',
      '--models=bge-m3',
      '--execution-providers=cuda,cpu',
      '--seq-lengths=32,128',
      '--batch-sizes=1,4',
      '--overflow-widths=1',
      '--p0-query-count=3',
      '--p0-bulk-units=2',
      '--p0-fairness-units=2',
      '--format=json',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, `dry-run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.benchmark, 'model-encode-p0');
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.config.models, ['bge-m3']);
  assert.deepEqual(report.config.executionProviders, ['cuda', 'cpu']);
  assert.deepEqual(report.config.seqLengths, [32, 128]);
  assert.deepEqual(report.config.batchSizes, [1, 4]);
  assert.deepEqual(report.config.overflowWidths, [1]);
  assert.deepEqual(report.plannedSections, [
    'batchThroughputByModelProviderSeqBatch',
    'queryLatencyIdleVsSharedTurnstileBulk',
    'textWorkerTokenizeVsPreparedTypedArrayTransfer',
    'oneSessionVsTwoSessionVram',
    'nvidiaSmiProbeLatencyFailureTimeout',
    'gpuOnlyVsGpuPlusCpuOverflow',
    'twoConcurrentRebuildFairness',
    'transientGpuFailureRecovery',
  ]);
});

test('model encode P0 harness rejects unsupported execution providers before running measurements', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', searchEval, '--benchmark=p0', '--p0-dry-run', '--execution-providers=metal', '--format=json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /execution-providers must include only cuda,cpu/);
});
