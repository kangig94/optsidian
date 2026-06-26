# Next Release Notes

## Changes

- Add repeat-run summaries and JSON failure reports to `search:eval` for search tuning.
- Add schema v2 failure classifications to `search:eval --failure-report`, including report/run summaries by failure kind and task.
- Improve ranking by keeping weak ngram-only metadata coverage in the base bucket, ignoring weak English function words for metadata coverage, and using a gated body evidence signal for long Latin queries.
- Document no-ngram as the standard search-quality regression target for new qrels-based search evaluation.
- Replace the old KLUE/SciFact eval generators with a `search:eval:ir-vault` generator backed by `uv run --with ir_datasets`, support full-corpus Obsidian vault regeneration, document qrels-based dataset replacement rules, and extend `search:eval` summaries with qrels Precision@k, MAP, and nDCG@10.
- Preserve source dataset id directory hierarchy under `IR/`, add a seed-0 random 100-query / 100-document smoke preset, make quality eval default to fast multicore score-only runs unless `--measure-speed` is requested, and always render warmup/query progress unless `--no-progress` is passed.
- Make `search:eval` pin the warm snapshot from `LoadVault` directly so eval startup no longer depends on a short post-warmup daemon `Status` deadline.
- Add dynamic body/snippet index budgets for long notes, including opt-in long-document stress tests, Hangul retrieval fallback, and bytes-aware lifecycle deadlines.
- Split `search:eval` into quality and index benchmark modes while keeping a single script entrypoint and opt-in slow tests.

<!--
This file is not the release archive. GitHub Releases are the archive.
During release, read this file, verify it against the git history since the
previous tag, write the GitHub Release body manually, and clear this file in a
follow-up commit after the release is published and verified.
-->
