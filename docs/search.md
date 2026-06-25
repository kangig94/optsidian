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
https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip
```

BEIR SciFact is published under CC BY-SA 4.0. The Hugging Face repository is
useful as a cloneable corpus/query source; the BEIR zip also includes test
qrels in TSV form.

## KLUE Sampling

`KLUE300` is a deterministic 300-document sample from the KLUE v1.1 dev split.
`KLUE100` is a deterministic subset sampled from `KLUE300`; the benchmark specs
target the `KLUE` corpus folder and do not use a separate `KLUE100` corpus.

The sample is balanced across four KLUE tasks:

| Task | KLUE300 Docs | KLUE100 Subset | Selection | Query |
|------|------:|------:|-----------|-------|
| YNAT | 90 | 30 | evenly spaced indices across the dev split | headline |
| STS | 60 | 20 | evenly spaced indices across the dev split | sentence 2 |
| MRC | 90 | 30 | evenly spaced indices across non-impossible dev QAs | selected question plus answer text when available |
| WOS | 60 | 20 | evenly spaced indices across the dev split | middle user turn, falling back to the first available turn |

Use 0-based indexing. For a split with `total` rows and a desired sample count `count`, choose:

```text
index(i) = round(i * (total - 1) / (count - 1))
for i = 0..count-1
```

If a rounded index is already selected, increment it until an unused index is found. This should not
normally matter for the current KLUE counts, but it is the tie-break rule.

`KLUE100` uses the same formula again over each task's selected `KLUE300`
rows. Therefore every `KLUE100` expected note is also present in `KLUE300`.

Task-specific construction:

- YNAT: use the selected row as the document; query is `title`.
- STS: use the selected row as the document; query is `sentence2`.
- MRC: flatten non-impossible dev QAs across all articles and paragraphs; query is the question plus
  all unique answer texts when available, otherwise the question alone.
- WOS: use the selected row as the document; query is the middle `user` turn using
  `floor(userTurns.length / 2)`, falling back to the first available user turn, then the first
  dialogue turn.

This deterministic procedure is intended to let a fresh setup produce the same
300 KLUE notes and both query specs.

## English Sampling

`English300` is the BEIR SciFact test query set expressed as Obsidian notes.
`English100` is a deterministic subset sampled from `English300`; the benchmark
specs target the `English` corpus folder and do not use a separate `English100`
corpus.

The sample is built from the SciFact test qrels:

1. Sort query ids by numeric value when possible, otherwise lexicographically.
2. For each query, choose the highest-scored relevant document.
3. If multiple relevant documents have the same score, choose the lowest corpus id by numeric value
   when possible, otherwise lexicographically.
4. Keep all 300 unique test query ids.
5. Write one note per selected corpus document; multiple query ids may point to the same note.

Each benchmark query uses the BEIR query text. The expected note is the selected relevant document
from qrels.

`English100` uses the same even-index formula over the 300-query list, so every
`English100` expected note is also present in `English300`.

## Fixture Construction

Dataset rows are converted into Obsidian Markdown notes rather than indexed as raw JSON.

Each generated note has frontmatter for search metadata:

- `title`
- `aliases`
- `tags`
- `source`
- `guid`
- `klue_task`
- source-specific ids such as `beir_id` or `beir_query_ids`

The body text is shaped by task:

| Task | Note body |
|------|-----------|
| YNAT | headline and topic metadata |
| STS | sentence 1 and sentence 2 |
| MRC | article title, question, answer texts when available, and context |
| WOS | dialogue turns and dialogue state values |
| SciFact | paper title, abstract text, BEIR corpus id, query ids, and qrel scores |

Each generated benchmark query has one expected note. Query construction follows the task:

| Task | Query construction |
|------|--------------------|
| YNAT | headline |
| STS | sentence 2 |
| MRC | selected question plus answer texts when available; question only when no answer is available |
| WOS | middle user turn, falling back to the first available turn |
| SciFact | BEIR query text |

The benchmark queries are scoped to their generated fixture for isolated runs.
The mixed specs remove this path scope so Korean and English notes compete in
the same result set.

## Query Spec Regeneration

Upstream datasets do not provide Optsidian's generated Markdown vault or
`SearchEval/*.queries.json` files. To rebuild the benchmark vault from cloned
sources:

```bash
git clone --depth=1 https://github.com/KLUE-benchmark/KLUE /tmp/KLUE
git clone --depth=1 https://huggingface.co/datasets/BeIR/scifact /tmp/scifact-hf
curl -fsSL https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip -o /tmp/scifact.zip
unzip -q /tmp/scifact.zip -d /tmp/scifact-beir
npm run search:eval:vault -- /path/to/test_search --klue-repo=/tmp/KLUE --scifact-dir=/tmp/scifact-beir/scifact --clean
```

The Hugging Face clone records the cloneable English dataset source. The BEIR
zip is used by the generator because it includes qrels as plain TSV. The
generator writes `KLUE` and `English` corpus folders. Existing legacy
`KLUE100` or `English100` folders are left untouched, but the generated specs do
not read or target them.

Regenerate query specs from an existing generated benchmark vault:

```bash
npm run search:eval:spec -- /path/to/test_search --scifact-queries-json=/path/to/test_search/SearchEval/scifact-test-queries.jsonl
```

This writes:

- `SearchEval/klue100.queries.json`: KLUE100 subset queries with `path=KLUE`
- `SearchEval/klue300.queries.json`: KLUE300 queries with `path=KLUE`
- `SearchEval/english100.queries.json`: English100 subset queries with `path=English`
- `SearchEval/english300.queries.json`: English300 queries with `path=English`
- `SearchEval/mixed200.queries.json`: KLUE100 + English100 without path scoping
- `SearchEval/mixed600.queries.json`: KLUE300 + English300 without path scoping
- `SearchEval/mixed600.smoke60.queries.json`: representative 60-query Mixed600 subset without
  path scoping, for fast smoke/proxy runs
- `SearchEval/queries.json`: the same Mixed600 spec, for the default `search:eval` path

KLUE query text is reconstructed from the generated Markdown notes. SciFact
query text is joined through each note's `beir_query_ids`. Without
`--scifact-queries-json`, the generator fetches the Hugging Face
`BeIR/scifact` queries split.

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

- `KLUE300`: run the KLUE query spec with `path` scoped to `KLUE`.
- `English300`: run the SciFact query spec with `path` scoped to `English`.
- `Mixed600`: concatenate the KLUE300 and English300 query specs, remove the `path` filter from
  every query, and evaluate against the shared generated vault.
- `Mixed600 smoke60`: fixed 60-query subset of Mixed600 for quick smoke/proxy checks. It
  keeps the same task proportions as Mixed600: 9 YNAT, 6 STS, 9 MRC, 6 WOS, and 30 SciFact queries.
- `KLUE100`, `English100`, and `Mixed200`: smaller deterministic subsets of the 300/600 specs for
  quicker local checks.

The mixed evaluation is the primary regression target for multilingual search behavior because
Korean and English documents compete in the same result set. The per-fixture evaluations remain
useful for isolating whether a change helps or hurts one language family. Use Mixed600 smoke60 for
inner-loop checks, then confirm with the full Mixed600 run before treating a change as a quality or
throughput baseline.

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
candidate-limit, lexical-recall, or reranking problem. Failure report schema version 2 also includes
`failureSummary` at the report and run level, plus a per-failure `classification` block. Use
`byKind`, `byTask`, `top1Miss`, `top10Miss`, `top50Missing`, `rerankMiss`, `candidateLimit`, and
`lexicalMissing` to triage benchmark regressions before opening individual failures.

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
base bucket. It also excludes weak English function words from metadata coverage scoring while
retaining polarity terms such as `not`. Long Latin query ranking includes a normalized body BM25
signal so body evidence can break otherwise metadata-heavy SciFact ties. Body ngram budgets are
dynamic by note length, and Hangul ngram retrieval falls back to morph/surface retrieval only when
the ngram candidate set is empty.

| Fixture | Passed | Top1 | Recall@3 | Recall@5 | Recall@10 | MRR@10 | Avg | P50 | P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| KLUE100 | 99/100 | 0.800 | 0.940 | 0.940 | 0.990 | 0.868 | 138.2ms | 133.3ms | 176.3ms |
| English100 | 83/100 | 0.710 | 0.750 | 0.780 | 0.830 | 0.740 | 149.8ms | 151.2ms | 176.4ms |
| Mixed200 | 182/200 | 0.755 | 0.845 | 0.860 | 0.910 | 0.804 | 189.6ms | 149.1ms | 179.9ms |
| KLUE300 | 291/300 | 0.780 | 0.887 | 0.923 | 0.970 | 0.841 | 140.5ms | 139.0ms | 173.1ms |
| English300 | 246/300 | 0.677 | 0.750 | 0.783 | 0.820 | 0.722 | 153.5ms | 153.9ms | 178.1ms |
| Mixed600 | 536/600 | 0.728 | 0.818 | 0.853 | 0.893 | 0.781 | 147.5ms | 149.2ms | 179.1ms |

The lower scores compared with the earlier hand-built 100/200 fixtures are
expected: the 2026-06-26 fixture rebuild makes the 100 specs subsets of the
larger 300/600 corpus instead of maintaining separate easier 100-note folders.
The latest full failure reports have no lexical-missing failures. Mixed600 has
64 misses: 55 SciFact, 3 STS, and 6 WOS. Of those, 52 are rerank misses and 12
are candidate-limit misses.

Wall-clock reference times:

| Spec | Total | QPS |
| --- | ---: | ---: |
| KLUE300 | 42.1s | 7.118 |
| English300 | 46.1s | 6.512 |
| Mixed600 | 88.5s | 6.780 |
| Mixed600 smoke60 | 8.9s | 6.756 |
| KLUE300 + English300 + Mixed600 | 176.7s | - |

The Mixed600 smoke60 reference run scored 55/60 with
`top1=0.750 recall@10=0.917 mrr@10=0.801`. Treat it as a quick regression
signal, not as the authoritative quality baseline.

KLUE100:

```text
score: n=100 top1=0.800 recall@3=0.940 recall@5=0.940 recall@10=0.990 mrr@10=0.868 avg=138.2ms p50=133.3ms p95=176.3ms
score.mrc: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=139.0ms p50=139.8ms p95=160.9ms
score.sts: n=20 top1=0.500 recall@3=0.850 recall@5=0.850 recall@10=1.000 mrr@10=0.687 avg=136.8ms p50=134.9ms p95=162.8ms
score.wos: n=20 top1=0.500 recall@3=0.850 recall@5=0.850 recall@10=0.950 mrr@10=0.655 avg=158.2ms p50=162.4ms p95=181.7ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=125.1ms p50=123.0ms p95=140.8ms
```

English100:

```text
score: n=100 top1=0.710 recall@3=0.750 recall@5=0.780 recall@10=0.830 mrr@10=0.740 avg=149.8ms p50=151.2ms p95=176.4ms
score.scifact: n=100 top1=0.710 recall@3=0.750 recall@5=0.780 recall@10=0.830 mrr@10=0.740 avg=149.8ms p50=151.2ms p95=176.4ms
```

Mixed200:

```text
score: n=200 top1=0.755 recall@3=0.845 recall@5=0.860 recall@10=0.910 mrr@10=0.804 avg=189.6ms p50=149.1ms p95=179.9ms
score.mrc: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=150.4ms p50=149.4ms p95=171.0ms
score.scifact: n=100 top1=0.710 recall@3=0.750 recall@5=0.780 recall@10=0.830 mrr@10=0.740 avg=233.4ms p50=151.4ms p95=178.8ms
score.sts: n=20 top1=0.500 recall@3=0.850 recall@5=0.850 recall@10=1.000 mrr@10=0.687 avg=147.8ms p50=146.7ms p95=174.4ms
score.wos: n=20 top1=0.500 recall@3=0.850 recall@5=0.850 recall@10=0.950 mrr@10=0.655 avg=163.1ms p50=167.1ms p95=193.8ms
score.ynat: n=30 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=128.1ms p50=128.9ms p95=144.4ms
```

KLUE300:

```text
score: n=300 top1=0.780 recall@3=0.887 recall@5=0.923 recall@10=0.970 mrr@10=0.841 avg=140.5ms p50=139.0ms p95=173.1ms
score.mrc: n=90 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=146.2ms p50=143.7ms p95=171.9ms
score.sts: n=60 top1=0.550 recall@3=0.783 recall@5=0.850 recall@10=0.950 mrr@10=0.686 avg=140.8ms p50=140.4ms p95=163.7ms
score.wos: n=60 top1=0.350 recall@3=0.650 recall@5=0.767 recall@10=0.900 mrr@10=0.520 avg=152.9ms p50=152.1ms p95=180.0ms
score.ynat: n=90 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=126.2ms p50=124.4ms p95=147.5ms
```

English300:

```text
score: n=300 top1=0.677 recall@3=0.750 recall@5=0.783 recall@10=0.820 mrr@10=0.722 avg=153.5ms p50=153.9ms p95=178.1ms
score.scifact: n=300 top1=0.677 recall@3=0.750 recall@5=0.783 recall@10=0.820 mrr@10=0.722 avg=153.5ms p50=153.9ms p95=178.1ms
```

Mixed600:

```text
score: n=600 top1=0.728 recall@3=0.818 recall@5=0.853 recall@10=0.893 mrr@10=0.781 avg=147.5ms p50=149.2ms p95=179.1ms
score.mrc: n=90 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=146.6ms p50=146.2ms p95=170.9ms
score.scifact: n=300 top1=0.677 recall@3=0.750 recall@5=0.783 recall@10=0.817 mrr@10=0.721 avg=155.8ms p50=154.9ms p95=180.7ms
score.sts: n=60 top1=0.550 recall@3=0.783 recall@5=0.850 recall@10=0.950 mrr@10=0.686 avg=140.6ms p50=140.4ms p95=164.2ms
score.wos: n=60 top1=0.350 recall@3=0.650 recall@5=0.767 recall@10=0.900 mrr@10=0.520 avg=151.1ms p50=150.2ms p95=180.8ms
score.ynat: n=90 top1=1.000 recall@3=1.000 recall@5=1.000 recall@10=1.000 mrr@10=1.000 avg=122.8ms p50=121.5ms p95=137.6ms
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

The deterministic quality baseline is the `--concurrency=1` Mixed600 score above. Higher
concurrency runs are load tests for queueing, cancellation, deadline handling, and tail latency, not
quality baselines.
