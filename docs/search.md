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

`N` in load sweeps means daemon worker count. Quality baselines use `--concurrency=1` against a
warm pinned snapshot.

## Evaluation Modes

Use the same evaluation script for both per-fixture and mixed-vault scoring:

- `KLUE100`: run the KLUE query spec with `path` scoped to `KLUE100`.
- `English100`: run the SciFact query spec with `path` scoped to `English100`.
- `Mixed200`: concatenate the KLUE100 and English100 query specs, remove the `path` filter from
  every query, and evaluate against the shared 200-document vault.

The mixed evaluation is the primary regression target for multilingual search behavior because
Korean and English documents compete in the same result set. The per-fixture evaluations remain
useful for isolating whether a change helps or hurts one language family.

`search:eval` runs in warm mode by default: it executes one unmeasured search before scoring so the
daemon can load the vault and pin a snapshot. Use `--no-warmup` only when explicitly measuring
cold-start behavior.

Index lifecycle requests use a work-sized deadline rather than a fixed 30 second budget. When the
client sends `LoadVault`, `Rebuild`, `Refresh`, `Compact`, or `Clear` without an explicit
`deadlineMs`, it counts visible Markdown notes in the vault and uses:

```text
deadline = 30 seconds + 750 milliseconds * markdown_note_count
```

Warm search latency targets still apply to searches against an already loaded snapshot. The longer
lifecycle deadline exists so large vault load/build work can finish instead of failing at a fixed
timeout.

The daemon reports lifecycle progress through `index status` and daemon `Status` JSON. Interactive
`index warm`, `index rebuild`, and `search:eval` warmup render a single stderr progress line showing
the current phase, completed count, total count when known, and current file. This progress output is
TTY-only and does not change stdout JSON/text results.

Use `--concurrency=<n>` to run benchmark queries through concurrent workers. This is required when
measuring daemon queueing behavior because sequential evaluation does not stress the worker pools.
Treat `--concurrency=1` as the quality-scoring mode. Higher search concurrency is a load test for
queueing and tail latency; if recall changes there, investigate shared daemon/cache behavior before
using that run as a search-quality baseline.

## Baseline

Current KLUE100 baseline through daemon RPC on a pinned positional snapshot:

```text
score: n=100 top1=0.730 recall@3=0.840 recall@5=0.890 recall@10=0.980 mrr@10=0.798 avg=1857.2ms p50=1851.5ms p95=1951.2ms
score.mrc: n=30 top1=0.867 recall@3=0.933 recall@5=0.933 recall@10=1.000 mrr@10=0.910 avg=1870.4ms p50=1868.9ms p95=1986.3ms
score.sts: n=20 top1=0.300 recall@3=0.550 recall@5=0.750 recall@10=0.900 mrr@10=0.461 avg=1864.0ms p50=1862.6ms p95=1948.2ms
score.wos: n=20 top1=0.550 recall@3=0.750 recall@5=0.800 recall@10=1.000 mrr@10=0.662 avg=1860.8ms p50=1851.7ms p95=1916.8ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=1837.0ms p50=1834.3ms p95=1920.0ms
```

Current English100 baseline through daemon RPC on a pinned positional snapshot:

```text
score: n=100 top1=0.630 recall@3=0.760 recall@5=0.800 recall@10=0.870 mrr@10=0.705 avg=1839.8ms p50=1827.5ms p95=1928.5ms
score.scifact: n=100 top1=0.630 recall@3=0.760 recall@5=0.800 recall@10=0.870 mrr@10=0.705 avg=1839.8ms p50=1827.5ms p95=1928.5ms
```

Current Mixed200 baseline through daemon RPC on a pinned positional snapshot:

```text
score: n=200 top1=0.680 recall@3=0.800 recall@5=0.845 recall@10=0.920 mrr@10=0.750 avg=1739.6ms p50=1732.1ms p95=1821.3ms
score.mrc: n=30 top1=0.867 recall@3=0.933 recall@5=0.933 recall@10=1.000 mrr@10=0.910 avg=1734.5ms p50=1725.6ms p95=1843.2ms
score.scifact: n=100 top1=0.630 recall@3=0.760 recall@5=0.800 recall@10=0.860 mrr@10=0.703 avg=1742.3ms p50=1732.1ms p95=1853.2ms
score.sts: n=20 top1=0.300 recall@3=0.550 recall@5=0.750 recall@10=0.900 mrr@10=0.461 avg=1735.7ms p50=1732.1ms p95=1802.8ms
score.wos: n=20 top1=0.550 recall@3=0.750 recall@5=0.800 recall@10=1.000 mrr@10=0.662 avg=1753.2ms p50=1753.4ms p95=1812.3ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=1729.2ms p50=1727.4ms p95=1814.8ms
```

## Worker Pools

Worker pool size is controlled by `search.queryWorkers`, `search.indexWorkers`, and daemon
environment overrides such as `OPTSIDIAN_SEARCH_QUERY_WORKERS` and
`OPTSIDIAN_SEARCH_INDEX_WORKERS`. Search-execution worker sizing is daemon-managed unless overridden
for stress tests with `OPTSIDIAN_SEARCH_EXECUTION_WORKERS`.

The deterministic quality baseline is the `--concurrency=1` Mixed200 score above. Higher
concurrency runs are load tests for queueing, cancellation, deadline handling, and tail latency, not
quality baselines.
