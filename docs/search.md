# Search Benchmark

This document records the benchmark fixtures used for Optsidian search work.

## KLUE Source

The Korean fixture is generated from KLUE v1.1 dev data:

```text
https://github.com/KLUE-benchmark/KLUE
```

KLUE is published under CC BY-SA 4.0.

## English Source

The English fixture is generated from BEIR SciFact data:

```text
https://huggingface.co/datasets/BeIR/scifact
https://huggingface.co/datasets/BeIR/scifact-qrels
```

BEIR SciFact and its qrels are published under CC BY-SA 4.0.

## KLUE100 Sampling

`KLUE100` is a deterministic 100-document sample from the KLUE v1.1 dev split.

The sample is balanced across four KLUE tasks:

| Task | Docs | Selection | Query |
|------|------|-----------|-------|
| YNAT | 30 | evenly spaced indices across the dev split | headline |
| STS | 20 | evenly spaced indices across the dev split | sentence 2 |
| MRC | 30 | evenly spaced indices across the dev article list | selected question plus first answer when available |
| WOS | 20 | evenly spaced indices across the dev split | middle user turn, falling back to the first available turn |

Use 0-based indexing. For a split with `total` rows and a desired sample count `count`, choose:

```text
index(i) = round(i * (total - 1) / (count - 1))
for i = 0..count-1
```

If a rounded index is already selected, increment it until an unused index is found. This should not
normally matter for the current KLUE counts, but it is the tie-break rule.

Task-specific construction:

- YNAT: use the selected row as the document; query is `title`.
- STS: use the selected row as the document; query is `sentence2`.
- MRC: sample over the top-level `data` article list; use `paragraphs[0]`; choose the first QA with
  at least one answer, otherwise the first QA; query is the question plus the first answer when an
  answer exists, otherwise the question alone.
- WOS: use the selected row as the document; query is the middle `user` turn using
  `floor(userTurns.length / 2)`, falling back to the first available user turn, then the first
  dialogue turn.

This deterministic procedure is intended to let a fresh setup produce the same 100 KLUE documents
and queries.

## English100 Sampling

`English100` is a deterministic 100-document sample from BEIR SciFact.

The sample is built from the SciFact test qrels:

1. Sort query ids by numeric value when possible, otherwise lexicographically.
2. For each query, choose the highest-scored relevant document.
3. If multiple relevant documents have the same score, choose the lowest corpus id by numeric value
   when possible, otherwise lexicographically.
4. Skip documents already selected by earlier queries.
5. Stop after 100 unique documents.

Each benchmark query uses the BEIR query text. The expected note is the selected relevant document
from qrels.

This deterministic procedure is intended to let a fresh setup produce the same 100 SciFact
documents and queries.

## Fixture Construction

Dataset rows are converted into Obsidian Markdown notes rather than indexed as raw JSON.

Each generated note has frontmatter for search metadata:

- `title`
- `aliases`
- `tags`
- `source`
- `guid`
- `klue_task`
- source-specific ids such as `beir_id` or `beir_query_id`

The body text is shaped by task:

| Task | Note body |
|------|-----------|
| YNAT | headline and topic metadata |
| STS | sentence 1 and sentence 2 |
| MRC | article title, question, first answer when available, and context |
| WOS | dialogue turns and dialogue state values |
| SciFact | paper title, abstract text, BEIR corpus id, query id, and qrel score |

Each generated benchmark query has one expected note. Query construction follows the task:

| Task | Query construction |
|------|--------------------|
| YNAT | headline |
| STS | sentence 2 |
| MRC | selected question plus first answer when available; question only when no answer is available |
| WOS | middle user turn, falling back to the first available turn |
| SciFact | BEIR query text |

The benchmark queries are scoped to their generated fixture so other benchmark samples do not
compete with the target 100-document sample.

## Query Spec Regeneration

Upstream datasets do not provide Optsidian's `SearchEval/queries.json` file. Regenerate the local
query specs from the generated benchmark vault:

```bash
npm run search:eval:spec -- /path/to/test_search
```

This writes:

- `SearchEval/klue100.queries.json`: KLUE100 queries with `path=KLUE100`
- `SearchEval/english100.queries.json`: English100 queries with `path=English100`
- `SearchEval/queries.json`: Mixed200 queries without path scoping

KLUE query text is reconstructed from the generated Markdown notes. SciFact query text is fetched
from the Hugging Face `BeIR/scifact` queries split and joined through each note's `beir_query_id`.
For offline regeneration, pass `--scifact-queries-json=<file>` with rows containing `_id` and `text`.

## Search Architecture

The search daemon owns the hot search path:

- Load and keep immutable positional snapshots in memory.
- Tokenize each query once, cache query analysis by analyzer identity and raw query text, and reuse
  it across repeated CLI/MCP searches.
- Keep analyzer workers isolated. A single Kiwi instance should process one request at a time.
  Parallelism comes from query and index worker pools with isolated analyzer instances.
- Persist line-level snippet data during indexing so search does not reread and retokenize matched
  files only to build snippets.
- Build updated snapshots in the background, then atomically swap the active snapshot. Search
  should always run against one deterministic snapshot.
- Keep all ordering stable with explicit tie-breakers, usually score first and path second.
- Budget long body-derived indexes without truncating the stored note body. Notes up to 64Ki chars
  use full body analysis with 4096 body ngram terms; notes up to 512Ki chars use full body analysis
  with 8192 body ngram terms; larger notes use deterministic whole-document sampling with 12288 or
  16384 body ngram terms. Metadata ngrams for path, title, aliases, tags, and headings remain
  uncapped because those fields are naturally small and carry high-value identity signals.
- Cap snippet scoring analysis separately from snippet display: each analyzed line is capped at
  4096 chars and 512 terms per channel, and each note analyzes at most 3000 sampled lines /
  512Ki chars for snippet scoring. Raw line snippets remain available for fallback display.
- Keep long-document build stress coverage out of the default test path. `npm test` covers budget
  selection and normal snapshot contracts; run `npm run test:slow` before changing long-body
  sampling, snippet sampling, `search:eval` benchmark modes, or index-build timeout policy.

`N` in load sweeps means daemon worker count. Quality baselines use `--concurrency=1` against a
warm pinned snapshot.

## Evaluation Modes

Use the same evaluation script for both search-quality and index-lifecycle benchmarks. The default
benchmark is `quality`, which scores queries from a query spec:

- `KLUE100`: run the KLUE query spec with `path` scoped to `KLUE100`.
- `English100`: run the SciFact query spec with `path` scoped to `English100`.
- `Mixed200`: concatenate the KLUE100 and English100 query specs, remove the `path` filter from
  every query, and evaluate against the shared 200-document vault.

The mixed evaluation is the primary regression target for multilingual search behavior because
Korean and English documents compete in the same result set. The per-fixture evaluations remain
useful for isolating whether a change helps or hurts one language family.

`search:eval` runs in warm mode by default: it executes one unmeasured search before scoring so the
daemon can load the vault and pin a snapshot. A cold `Search` only blocks on one search-execution
worker preloading the snapshot; additional search workers hydrate the snapshot on demand. Use
`--no-warmup` only when explicitly measuring cold-start behavior.

Index lifecycle requests use a work-sized deadline rather than a fixed short budget. When the
client sends `LoadVault`, `Rebuild`, `Refresh`, `Compact`, `Clear`, or a cold `Search` / `Explain`
without an explicit `deadlineMs`, it counts visible Markdown notes and Markdown bytes in the vault
and uses:

```text
deadline = 60 seconds + 750 milliseconds * markdown_note_count + 5 seconds * markdown_MiB
```

Warm search latency targets still apply to searches against an already loaded snapshot. The longer
lifecycle deadline exists so large vault load/build/preload work can finish instead of failing at a
fixed timeout.

The daemon reports lifecycle progress through `index status` and daemon `Status` JSON. Interactive
`index warm`, `index rebuild`, and `search:eval` warmup render a single stderr progress line showing
the current phase, completed count, total count when known, and current file. This progress output is
TTY-only and does not change stdout JSON/text results.

Use `--concurrency=<n>` to run benchmark queries through concurrent workers. This is required when
measuring daemon queueing behavior because sequential evaluation does not stress the worker pools.
Treat `--concurrency=1` as the quality-scoring mode. Higher search concurrency is a load test for
queueing and tail latency; if recall changes there, investigate shared daemon/cache behavior before
using that run as a search-quality baseline.

Use `--repeat=<n>` when comparing latency changes. It reuses the same warm pinned snapshot, runs the
same spec repeatedly, prints every run, and ends with a median repeat summary. Prefer the median over
a single run when deciding whether a speed or memory change is real.

Use `--failure-report=<path>` when analyzing ranking misses. The report records each failed query,
expected path, rank within the scored limit, top matches, per-task scores, and a follow-up inspection
search. The inspection search defaults to `--failure-inspect-limit=50` and does not change scoring
metrics or the reported run time. This is the primary input for deciding whether a miss is a
candidate-limit, lexical-recall, or reranking problem.

Use `--benchmark=index` when measuring vault indexing lifecycle cost instead of query quality:

```bash
npm run search:eval -- /path/to/test_search --benchmark=index
npm run search:eval -- /path/to/test_search --benchmark=index --index-actions=clear-load,rebuild,load --repeat=3
npm run search:eval -- /path/to/test_search --benchmark=index --format=json --quiet
```

Index benchmark actions are:

- `clear-load`: clear the persisted search store, then run `LoadVault`.
- `rebuild`: force `Rebuild` against the current vault.
- `load`: run `LoadVault` with the current persisted cache.
- `clear` and `clear-rebuild`: lower-level variants for isolating cache removal and forced rebuild
  behavior.

The text output is for quick local comparison. JSON output records vault Markdown file/byte counts,
cache directory size before and after the run, per-action elapsed time and phases, snapshot id,
daemon status, and observed memory summaries. Worker RSS is reported as a maximum observed RSS value,
not a sum, because Node worker threads share process RSS.

## Baseline

Current baseline is measured through daemon RPC with `--mode=core --concurrency=1` in warm
scoring mode.
The 2026-06-26 run uses regenerated `SearchEval/*.queries.json` specs from `npm run
search:eval:spec`, lazy daemon startup, one-worker cold search preload, pinned positional
snapshots, and the metadata coverage threshold that keeps weak ngram-only metadata matches in the
base bucket. Body ngram budgets are dynamic by note length, and Hangul ngram retrieval falls back to
morph/surface retrieval only when the ngram candidate set is empty.

| Fixture | Passed | Top1 | Recall@3 | Recall@5 | Recall@10 | MRR@10 | Avg | P50 | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| KLUE100 | 100/100 | 0.920 | 0.980 | 1.000 | 1.000 | 0.953 | 119.8ms | 119.0ms | 156.0ms |
| English100 | 87/100 | 0.640 | 0.760 | 0.800 | 0.870 | 0.710 | 130.0ms | 127.0ms | 161.3ms |
| Mixed200 | 187/200 | 0.780 | 0.870 | 0.900 | 0.935 | 0.831 | 118.9ms | 117.3ms | 152.5ms |

KLUE100:

```text
score: n=100 top1=0.920 recall@3=0.980 recall@5=1.000 recall@10=1.000 mrr@10=0.953 avg=119.8ms p50=119.0ms p95=156.0ms
score.mrc: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=118.9ms p50=119.6ms p95=145.7ms
score.sts: n=20 top1=0.850 recall@3=0.950 recall@5=1.000 recall@10=1.000 mrr@10=0.910 avg=133.8ms p50=133.9ms p95=159.2ms
score.wos: n=20 top1=0.750 recall@3=0.950 recall@5=1.000 recall@10=1.000 mrr@10=0.854 avg=127.5ms p50=124.4ms p95=156.0ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=106.2ms p50=106.7ms p95=131.8ms
```

English100:

```text
score: n=100 top1=0.640 recall@3=0.760 recall@5=0.800 recall@10=0.870 mrr@10=0.710 avg=130.0ms p50=127.0ms p95=161.3ms
score.scifact: n=100 top1=0.640 recall@3=0.760 recall@5=0.800 recall@10=0.870 mrr@10=0.710 avg=130.0ms p50=127.0ms p95=161.3ms
```

Mixed200:

```text
score: n=200 top1=0.780 recall@3=0.870 recall@5=0.900 recall@10=0.935 mrr@10=0.831 avg=118.9ms p50=117.3ms p95=152.5ms
score.mrc: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=107.7ms p50=106.9ms p95=124.1ms
score.scifact: n=100 top1=0.640 recall@3=0.760 recall@5=0.800 recall@10=0.870 mrr@10=0.709 avg=127.1ms p50=123.2ms p95=158.6ms
score.sts: n=20 top1=0.850 recall@3=0.950 recall@5=1.000 recall@10=1.000 mrr@10=0.910 avg=114.9ms p50=109.1ms p95=136.7ms
score.wos: n=20 top1=0.750 recall@3=0.950 recall@5=1.000 recall@10=1.000 mrr@10=0.854 avg=122.9ms p50=119.7ms p95=152.5ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=102.9ms p50=99.3ms p95=125.1ms
```

## Worker Pools

Worker pool size is controlled by `search.queryWorkers`, `search.indexWorkers`, and daemon
environment overrides such as `OPTSIDIAN_SEARCH_QUERY_WORKERS` and
`OPTSIDIAN_SEARCH_INDEX_WORKERS`. Search-execution worker sizing is daemon-managed unless overridden
for stress tests with `OPTSIDIAN_SEARCH_EXECUTION_WORKERS`.

Daemon startup is lazy. The daemon becomes ready after one search-execution worker is ready; latency
analyzer workers warm on the first query analysis request, and throughput analyzer workers warm only
for snapshot build/rebuild work. This keeps a status-only cold daemon light and avoids loading the
Kiwi model twice for search-only use.

Cold query `Search` / `Explain` requests load the active snapshot, warm the query analyzer, and block
on one search-execution worker preloading that snapshot before running the query. The analyzer warmup
overlaps snapshot load/preload work. Cold metadata-only searches, such as tag-only searches, skip
positional snapshot preload and hydrate only document metadata in the search worker. Explicit
lifecycle warmup commands such as `index warm`, `index rebuild`, `refresh`, and `compact` still
preload all search-execution workers for the active snapshot.

Cold-start reference measurements from the 2026-06-24 lazy-startup run:

| Scenario | Latency | RSS After Ready |
| --- | ---: | ---: |
| `index status` from no daemon | 0.22s | 189MB |
| first metadata-only `search tag=...` from no daemon | 0.73s | 324MB |
| first query `search <text>` from no daemon | 2.59s | 1.45GB |

The deterministic quality baseline is the `--concurrency=1` Mixed200 score above. Higher
concurrency runs are load tests for queueing, cancellation, deadline handling, and tail latency, not
quality baselines.
