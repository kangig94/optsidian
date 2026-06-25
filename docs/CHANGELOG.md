# Next Release Notes

## Changes

- Add a `search:eval:spec` generator that rebuilds KLUE100, English100, and Mixed200 query specs from the benchmark vault.
- Document that Optsidian's `SearchEval/queries.json` is generated locally, not provided by upstream KLUE or BEIR sources.
- Refresh search benchmark baselines against the regenerated query specs.

<!--
This file is not the release archive. GitHub Releases are the archive.
During release, read this file, verify it against the git history since the
previous tag, write the GitHub Release body manually, and clear this file in a
follow-up commit after the release is published and verified.
-->
