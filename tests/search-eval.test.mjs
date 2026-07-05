import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();

function tempRoot(prefix = 'optsidian-search-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeUv(dir) {
  const fakeUv = path.join(dir, 'fake-uv.cjs');
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const dataset = valueOf("--dataset");
const output = valueOf("--output");
const documentsOutput = valueOf("--documents-output");
const docId = dataset + "/doc-1";
const logEntry = {
  dataset,
  maxQueries: Number(valueOf("--max-queries")),
  querySample: valueOf("--query-sample"),
  querySeed: Number(valueOf("--query-seed")),
  maxQrelsPerQuery: Number(valueOf("--max-qrels-per-query")),
  maxNegativeQrelsPerQuery: Number(valueOf("--max-negative-qrels-per-query")),
  corpusMode: valueOf("--corpus-mode"),
  sampleSize: Number(valueOf("--sample-size")),
  sampleSeed: Number(valueOf("--sample-seed")),
  documentSample: valueOf("--document-sample")
};
fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify(logEntry) + "\\n");
fs.mkdirSync(path.dirname(documentsOutput), { recursive: true });
fs.writeFileSync(documentsOutput, JSON.stringify({
  docId,
  fields: {
    doc_id: docId,
    title: dataset + " title",
    text: dataset + " body"
  }
}) + "\\n");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-06-27T00:00:00.000Z",
  irDatasetsVersion: "fake",
  dataset: { id: dataset, docsCount: 1, queriesCount: 1, qrelsCount: 1 },
  options: logEntry,
  queries: [{
    queryId: "q1",
    text: dataset + " query",
    fields: { query_id: "q1", text: dataset + " query" },
    qrels: [{ query_id: "q1", doc_id: docId, relevance: 1 }]
  }],
  documentsFile: documentsOutput,
  documentsCount: 1,
  missingDocIds: [],
  sampling: {
    query: { mode: logEntry.querySample, seed: logEntry.querySeed },
    documents: { mode: logEntry.documentSample, seed: logEntry.sampleSeed }
  }
}, null, 2) + "\\n");
`;
  fs.writeFileSync(fakeUv, script);
  fs.chmodSync(fakeUv, 0o755);
  return fakeUv;
}

function runIrGenerator(args) {
  const dir = tempRoot();
  const vault = path.join(dir, 'vault');
  const fakeUv = makeFakeUv(dir);
  const logPath = path.join(dir, 'uv.log');
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/generate-search-eval-ir-dataset.mjs'),
      vault,
      '--dataset=miracl/ko/dev',
      '--dataset=beir/nfcorpus/test',
      `--uv=${fakeUv}`,
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FAKE_UV_LOG: logPath },
    },
  );
  assert.equal(result.status, 0, `generator failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const calls = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { calls, vault };
}

function makeFakeSearchCli(dir) {
  const fakeCli = path.join(dir, 'fake-search-cli.cjs');
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_SEARCH_CLI_LOG, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    workers: process.env.OPTSIDIAN_SEARCH_WORKERS,
    executionWorkers: process.env.OPTSIDIAN_SEARCH_EXECUTION_WORKERS,
    queryWorkers: process.env.OPTSIDIAN_SEARCH_QUERY_WORKERS,
    indexWorkers: process.env.OPTSIDIAN_SEARCH_INDEX_WORKERS
  }
}) + "\\n");
console.log(JSON.stringify({
  ok: true,
  command: "search",
  matches: [{ path: "Expected.md" }]
}));
`;
  fs.writeFileSync(fakeCli, script);
  fs.chmodSync(fakeCli, 0o755);
  return fakeCli;
}

function makeFakeIrDatasets(dir) {
  const modulePath = path.join(dir, 'ir_datasets.py');
  const script = `
__version__ = "fake"

class Row:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

class Store:
    def __init__(self, docs):
        self.docs = {doc.doc_id: doc for doc in docs}
    def get(self, doc_id):
        return self.docs.get(doc_id)
    def close(self):
        pass

class Dataset:
    def __init__(self):
        self.queries = [
            Row(query_id="q1", text="short alpha"),
            Row(query_id="q2", text="long alpha beta gamma delta epsilon zeta eta theta"),
            Row(query_id="q3", text="HTLV 1 biomarker"),
            Row(query_id="q4", text="\\uac80\\uc0c9 \\ud55c\\uad6d\\uc5b4"),
            Row(query_id="q5", text="mixed alpha 2026"),
        ]
        self.qrels = []
        self.docs = []
        for index in range(1, 6):
            self.qrels.append(Row(query_id=f"q{index}", doc_id=f"pos-{index}", relevance=2 if index == 2 else 1))
            self.qrels.append(Row(query_id=f"q{index}", doc_id=f"neg-{index}", relevance=0))
            self.docs.append(Row(doc_id=f"pos-{index}", title=f"Positive {index}", text=f"positive\\u2028target {index}", source="judged"))
            self.docs.append(Row(doc_id=f"neg-{index}", title=f"Negative {index}", text=f"negative target {index}", source="judged"))
        for index in range(1, 21):
            source = "journal-a" if index % 2 == 0 else "journal-b"
            self.docs.append(Row(doc_id=f"bg-{index}", title=f"Background {index}", text=f"background text {index}", source=source))
    def qrels_iter(self):
        return iter(self.qrels)
    def queries_iter(self):
        return iter(self.queries)
    def docs_iter(self):
        return iter(self.docs)
    def docs_store(self):
        return Store(self.docs)
    def docs_count(self):
        return len(self.docs)
    def queries_count(self):
        return len(self.queries)
    def qrels_count(self):
        return len(self.qrels)

def load(dataset_id):
    return Dataset()
`;
  fs.writeFileSync(modulePath, script);
}

test('IR eval smoke preset balances Korean and English fixture size', () => {
  const { calls, vault } = runIrGenerator(['--smoke']);

  assert.deepEqual(
    calls.map((call) => call.dataset),
    ['miracl/ko/dev', 'beir/nfcorpus/test'],
  );
  for (const call of calls) {
    assert.equal(call.maxQueries, 50);
    assert.equal(call.querySample, 'random');
    assert.equal(call.querySeed, 0);
    assert.equal(call.maxQrelsPerQuery, 1);
    assert.equal(call.maxNegativeQrelsPerQuery, 0);
    assert.equal(call.corpusMode, 'smoke');
    assert.equal(call.sampleSize, 50);
    assert.equal(call.sampleSeed, 0);
    assert.equal(call.documentSample, 'random');
  }

  const spec = JSON.parse(fs.readFileSync(path.join(vault, 'SearchEval', 'queries.json'), 'utf8'));
  assert.equal(spec.preset, 'smoke');
  assert.equal(spec.corpusMode, 'smoke');
  assert.equal(spec.queries.length, 2);
});

test('IR eval dev preset uses medium balanced sampled corpora', () => {
  const { calls, vault } = runIrGenerator(['--dev']);

  assert.deepEqual(
    calls.map((call) => call.dataset),
    ['miracl/ko/dev', 'beir/nfcorpus/test'],
  );
  for (const call of calls) {
    assert.equal(call.maxQueries, 200);
    assert.equal(call.querySample, 'stratified');
    assert.equal(call.querySeed, 0);
    assert.equal(call.maxQrelsPerQuery, 3);
    assert.equal(call.maxNegativeQrelsPerQuery, 2);
    assert.equal(call.corpusMode, 'smoke');
    assert.equal(call.sampleSize, 5000);
    assert.equal(call.sampleSeed, 0);
    assert.equal(call.documentSample, 'stratified');
  }

  const spec = JSON.parse(fs.readFileSync(path.join(vault, 'SearchEval', 'queries.json'), 'utf8'));
  assert.equal(spec.preset, 'dev');
  assert.equal(spec.corpusMode, 'smoke');
  assert.equal(spec.queries.length, 2);
  const summaryName = fs.readdirSync(path.join(vault, 'SearchEval')).find((name) => name.endsWith('.summary.json'));
  const summary = JSON.parse(fs.readFileSync(path.join(vault, 'SearchEval', summaryName), 'utf8'));
  assert.equal(summary.datasets[0].sampling.query.mode, 'stratified');
  assert.equal(summary.datasets[0].sampling.documents.mode, 'stratified');
});

test('search eval workers option drives daemon worker env without raising default concurrency', () => {
  const dir = tempRoot();
  const vault = path.join(dir, 'vault');
  const specDir = path.join(vault, 'SearchEval');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    path.join(specDir, 'queries.json'),
    JSON.stringify({
      queries: [
        { query: 'alpha', expected: 'Expected.md' },
        { query: 'beta', expected: 'Expected.md' },
      ],
    }),
  );
  const fakeCli = makeFakeSearchCli(dir);
  const logPath = path.join(dir, 'search-cli.log');
  const env = { ...process.env, FAKE_SEARCH_CLI_LOG: logPath };
  delete env.OPTSIDIAN_SEARCH_WORKERS;
  delete env.OPTSIDIAN_SEARCH_EXECUTION_WORKERS;
  delete env.OPTSIDIAN_SEARCH_QUERY_WORKERS;
  delete env.OPTSIDIAN_SEARCH_INDEX_WORKERS;

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(repoRoot, 'scripts/search-eval.mjs'),
      vault,
      '--mode=e2e',
      `--cli=${fakeCli}`,
      '--workers=2',
      '--ngram=off',
      '--no-progress',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    },
  );

  assert.equal(result.status, 0, `search eval failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(
    result.stdout,
    /summary: mode=e2e retrieval=lexical concurrency=1 2\/2 passed total=\d+\.\dms qps=\d+\.\d{3} p50=\d+\.\dms p95=\d+\.\dms/,
  );
  assert.match(result.stdout, /score: n=2 .* avg=\d+\.\dms p50=\d+\.\dms p95=\d+\.\dms/);
  const calls = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.env.workers, '2');
    assert.equal(call.env.executionWorkers, '2');
    assert.equal(call.env.queryWorkers, '1');
    assert.equal(call.env.indexWorkers, '1');
  }
});

test('search eval speed flag changes default repeat without changing summary shape', () => {
  const dir = tempRoot();
  const vault = path.join(dir, 'vault');
  const specDir = path.join(vault, 'SearchEval');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    path.join(specDir, 'queries.json'),
    JSON.stringify({
      queries: [
        { query: 'alpha', expected: 'Expected.md' },
        { query: 'beta', expected: 'Expected.md' },
      ],
    }),
  );
  const fakeCli = makeFakeSearchCli(dir);
  const logPath = path.join(dir, 'search-cli.log');

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(repoRoot, 'scripts/search-eval.mjs'),
      vault,
      '--mode=e2e',
      `--cli=${fakeCli}`,
      '--measure-speed',
      '--ngram=off',
      '--no-progress',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FAKE_SEARCH_CLI_LOG: logPath },
    },
  );

  assert.equal(result.status, 0, `search eval failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /run 1\/3 summary: mode=e2e retrieval=lexical concurrency=1 2\/2 passed total=/);
  assert.match(result.stdout, /run 2\/3 summary: mode=e2e retrieval=lexical concurrency=1 2\/2 passed total=/);
  assert.match(result.stdout, /run 3\/3 summary: mode=e2e retrieval=lexical concurrency=1 2\/2 passed total=/);
  assert.match(result.stdout, /repeat: runs=3 .* avgMedian=\d+\.\dms p50Median=\d+\.\dms p95Median=\d+\.\dms/);
  const calls = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 7);
});

test('index eval reports the runtime lexical store cache path', async () => {
  const { createSearchDaemonClient } = await import('../src/daemon/client.ts');
  const { effectiveSearchRuntimeProfile, lexicalIdentityHashForSearchRuntimeProfile } =
    await import('../src/daemon/runtime-profile.ts');
  const dir = tempRoot();
  const vault = path.join(dir, 'vault');
  const runtimeDir = path.join(dir, 'runtime');
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '1000',
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_NGRAM: 'false',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
  };
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Alpha.md'), '# Alpha\n\nsearch fixture\n');

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(repoRoot, 'scripts/search-eval.mjs'),
      vault,
      '--benchmark=index',
      '--index-actions=clear',
      '--format=json',
      '--no-progress',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    },
  );

  try {
    assert.equal(result.status, 0, `index eval failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    const expectedLexicalIdentityHash = lexicalIdentityHashForSearchRuntimeProfile(
      effectiveSearchRuntimeProfile(repoRoot, env),
    );

    assert.equal(report.cache.lexicalIdentityHash, expectedLexicalIdentityHash);
    assert.equal(path.basename(report.cache.rootDir), expectedLexicalIdentityHash);
    assert.equal(report.cache.rootDir.includes('default-lexical'), false);
    assert.equal(report.actions[0].indexBuildMs, 0);
    assert.equal(report.actions[0].buildTimingSource, 'daemon-progress');
    assert.equal(report.actions[0].buildTimingResolutionMs, 0);
  } finally {
    const hasOwner = fs.existsSync(runtimeDir) && fs.readdirSync(runtimeDir).some((name) => name.endsWith('.owner'));
    if (hasOwner) {
      const client = createSearchDaemonClient({
        runtimeDir,
        binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
        env,
      });
      await client.shutdown({ deadlineMs: 5000 }).catch(() => {});
    }
  }
});

test('IR exporter stratified dev sampling is deterministic and auditable', () => {
  const dir = tempRoot();
  makeFakeIrDatasets(dir);
  const output = path.join(dir, 'export.json');
  const documentsOutput = path.join(dir, 'documents.jsonl');
  const args = [
    'scripts/export-ir-dataset.py',
    '--dataset=fake/dev',
    `--output=${output}`,
    `--documents-output=${documentsOutput}`,
    '--max-queries=4',
    '--query-sample=stratified',
    '--query-seed=0',
    '--max-qrels-per-query=1',
    '--max-negative-qrels-per-query=1',
    '--corpus-mode=smoke',
    '--sample-size=12',
    '--sample-seed=0',
    '--document-sample=stratified',
  ];
  const env = { ...process.env, PYTHONPATH: dir };
  const first = spawnSync('python3', args, { cwd: repoRoot, encoding: 'utf8', env });
  assert.equal(first.status, 0, `exporter failed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  const firstPayload = JSON.parse(fs.readFileSync(output, 'utf8'));
  const firstDocs = fs.readFileSync(documentsOutput, 'utf8');
  assert.equal(firstDocs.includes('\u2028'), false);
  for (const line of firstDocs.trim().split('\n')) JSON.parse(line);

  const second = spawnSync('python3', args, { cwd: repoRoot, encoding: 'utf8', env });
  assert.equal(second.status, 0, `exporter repeat failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  const secondPayload = JSON.parse(fs.readFileSync(output, 'utf8'));
  delete firstPayload.generatedAt;
  delete secondPayload.generatedAt;
  assert.deepEqual(secondPayload, firstPayload);
  assert.equal(fs.readFileSync(documentsOutput, 'utf8'), firstDocs);

  const payload = firstPayload;
  assert.equal(payload.options.querySample, 'stratified');
  assert.equal(payload.options.documentSample, 'stratified');
  assert.equal(payload.options.maxNegativeQrelsPerQuery, 1);
  assert.equal(payload.sampling.query.selected, 4);
  assert.equal(payload.sampling.documents.mode, 'stratified');
  assert.ok(Object.keys(payload.sampling.query.selectedBuckets).length > 1);
  assert.ok(Object.keys(payload.sampling.documents.selectedBackgroundStrata).length > 0);
  assert.equal(payload.queries.length, 4);
  assert.ok(payload.queries.every((query) => query.qrels.some((qrel) => qrel.relevance <= 0)));
});
