# Next Release Notes

## Changes

- Add a `search:eval:vault` generator that rebuilds the benchmark vault from cloned KLUE and BEIR SciFact sources.
- Expand search evaluation to KLUE300, English300, and Mixed600 while keeping KLUE100, English100, and Mixed200 as deterministic subsets of the 300/600 specs.
- Add a `search:eval:spec` generator that rebuilds 100/300 and 200/600 query specs from the benchmark vault.
- Document that Optsidian's `SearchEval/queries.json` is generated locally, not provided by upstream KLUE or BEIR sources.
- Refresh search benchmark baselines against the regenerated 300/600 query specs.
- Add repeat-run summaries and JSON failure reports to `search:eval` for search tuning.
- Add schema v2 failure classifications to `search:eval --failure-report`, including report/run summaries by failure kind and task.
- Improve ranking by keeping weak ngram-only metadata coverage in the base bucket, ignoring weak English function words for metadata coverage, and using a gated body evidence signal for long Latin queries; the current expanded baseline is documented in `docs/search.md`.
- Add dynamic body/snippet index budgets for long notes, including opt-in long-document stress tests, Hangul retrieval fallback, and bytes-aware lifecycle deadlines.
- Split `search:eval` into quality and index benchmark modes while keeping a single script entrypoint and opt-in slow tests.

<!--
This file is not the release archive. GitHub Releases are the archive.
During release, read this file, verify it against the git history since the
previous tag, write the GitHub Release body manually, and clear this file in a
follow-up commit after the release is published and verified.
-->
