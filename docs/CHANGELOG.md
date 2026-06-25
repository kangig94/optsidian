# Next Release Notes

## Changes

- Add a `search:eval:spec` generator that rebuilds KLUE100, English100, and Mixed200 query specs from the benchmark vault.
- Document that Optsidian's `SearchEval/queries.json` is generated locally, not provided by upstream KLUE or BEIR sources.
- Refresh search benchmark baselines against the regenerated query specs.
- Add repeat-run summaries and JSON failure reports to `search:eval` for search tuning.
- Add schema v2 failure classifications to `search:eval --failure-report`, including report/run summaries by failure kind and task.
- Improve ranking by keeping weak ngram-only metadata coverage in the base bucket and ignoring weak English function words for metadata coverage, raising KLUE100 to 100/100, English100 to 90/100, and Mixed200 to 188/200.
- Add dynamic body/snippet index budgets for long notes, including opt-in long-document stress tests, Hangul retrieval fallback, and bytes-aware lifecycle deadlines.
- Split `search:eval` into quality and index benchmark modes while keeping a single script entrypoint and opt-in slow tests.

<!--
This file is not the release archive. GitHub Releases are the archive.
During release, read this file, verify it against the git history since the
previous tag, write the GitHub Release body manually, and clear this file in a
follow-up commit after the release is published and verified.
-->
