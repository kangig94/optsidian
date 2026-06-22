# Development Notes

## Project Layout

The core layer must not depend on `process.argv`, `process.stdin`, `process.stdout`, or native Obsidian process delegation. CLI and MCP adapters only translate external inputs into core params and render returned results.

Kiwi runtime code lives under `src/core/kiwi/*` as Korean text-analysis infrastructure. Search adapts it through `src/core/search/analyzer.ts`; Kiwi modules must not import search modules.

## Search Layout Rules

`search` is an Optsidian-extended command. Keep the public core surface at `src/core/search/index.ts`; split internals under `src/core/search/*` by pipeline concern, not by caller.

- `analysis/*` owns query/document token analysis, Korean analyzer behavior, and channel construction.
- `retrieval/*` owns Orama lookups, candidate limits, and per-channel result merging.
- `ranking/*` owns exact identity ranking, phrase ranking, coverage ranking, RRF, and final scoring.
- `planner.ts` owns read-time plan selection across target persisted index, compatible baseline index, empty building response, and full-build fallback.
- Analyzer routing, Markdown parsing, warm daemon, warm schedule state, cache paths, documents, manifests, locks, persistence, overlays, projections, warmup, reconcile, snippets, debug, and status each stay in their matching top-level search module.

Layout-only skeleton files are allowed only while an active search migration is in progress. A functional search change should populate the matching module and avoid adding new behavior to `index.ts` unless it is preserving the public entrypoint, re-exporting public helpers, or coordinating modules.

If a new search concern does not fit the existing modules, update these layout rules before adding the module. Avoid catch-all utility modules; name the module after the pipeline responsibility it owns.

Analyzer and token semantics are part of search index identity. If a change alters token fields, analyzer fallback, channel construction, ranking identity, or persisted query behavior, update the relevant schema/cache/identity version and keep persisted index, overlay index, and live query analysis on the same semantics.

Korean search changes should model token channels explicitly, for example surface, morph, stem or lemma, and ngram. Retrieve per channel, fuse with explicit weights, and expose enough debug detail to explain which channel matched; avoid one-off string trimming inside ranking code.

## Commands

```bash
npm install
npm run build
npm run package:release
npm test
npm pack --dry-run
```

Run the built CLI locally:

```bash
dist/optsidian --help
dist/optsidian-mcp --help
dist/optsidian files total
dist/optsidian read path=README.md head=10
```

## Versioning

`package.json` is the single version source. Bump it with npm's built-in command:

```bash
npm version patch --no-git-tag-version
npm run build
```

`npm version` updates `package.json` and `package-lock.json`. The build reads `package.json` and embeds that version into `optsidian --version`, `optsidian-mcp --version`, help output, and MCP server metadata.

## Release Flow

Published installs and updates come from GitHub Releases, not source clones.

Release checklist:

```bash
npm version patch --no-git-tag-version
npm test
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

The `release.yml` workflow validates that the pushed tag matches `package.json`, runs the full test suite, builds `dist/`, emits `release/optsidian-vX.Y.Z`, `release/optsidian-mcp-vX.Y.Z`, and `release/checksums-vX.Y.Z.txt`, and publishes the GitHub Release. If the same tag is force-moved and pushed again, the workflow cancels any in-flight run for that tag and refreshes the existing release assets in place with `gh release upload --clobber`.

## Native Obsidian Binary

By default, `optsidian` invokes `obsidian` from `PATH`.

Override it with:

```bash
OPTSIDIAN_OBSIDIAN_BIN=/path/to/obsidian dist/optsidian files
```

Tests use this variable to point at a fake Obsidian executable.

## CLI Vault Resolution

Implemented file commands resolve `vault-path=<path>` first, then `OPTSIDIAN_VAULT_PATH`, then native `obsidian vault info=path` with optional `vault=<name>`. Fixed vault paths are only for Optsidian-implemented commands; delegated native commands still require the Obsidian GUI/native CLI context.

`open-gui` is an implemented CLI command that launches the `obsidian://open` URI through the OS opener. `vault-path=<path>` becomes `obsidian://open?path=<path>`. Set `OPTSIDIAN_OBSIDIAN_APP_BIN` in tests or unusual environments to bypass the OS URI opener and run a specific app binary.

## MCP Vault Resolution

`optsidian-mcp` does not fail startup when vault resolution is unavailable. Vault-dependent tool calls resolve the current active vault with native `obsidian vault info=path` each time they run, unless `--vault-path <path>` or `OPTSIDIAN_VAULT_PATH=<path>` pins MCP to a fixed vault path. Without either, mutation tools return a runtime error that tells the client to launch Obsidian GUI or configure a fixed vault path.

## Plugin Install Extension

`plugin:install` is extended only for custom plugin sources. Native marketplace installs such as `plugin:install id=<plugin-id>` are delegated unchanged.

Custom `url=<git-url>` and `path=<plugin-dir>` installs are implemented in `src/cli/commands/plugin.ts`. They read `manifest.json`, copy the plugin directory into `.obsidian/plugins/<manifest.id>`, optionally update `community-plugins.json` with `enable`, and try a best-effort native refresh when the target vault is also the active native Obsidian vault. With `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH`, the file install path works without native vault resolution or a running Obsidian GUI. `plugin:reload` remains a native passthrough command.

There is no custom registry or update command. Re-run `plugin:install url=...` or `plugin:install path=...` to replace the installed plugin with the current source.

## Exit Codes

- `0`: success
- `1`: runtime or patch application failure
- `2`: usage or validation failure

Delegated native commands preserve the native Obsidian exit code.

## Path Safety

Optimized and extended core functions must call `resolveVaultPath`.

The path guard:

- resolves relative paths against the vault root
- allows absolute paths only if they resolve inside the vault
- checks existing paths with `realpath`
- checks new paths through the nearest existing parent
- rejects symlink escapes outside the vault

## Mutation Rules

- Mutating commands apply immediately.
- `dry-run` must not write.
- Whole-file writes use per-file atomic replacement.
- Multi-file `apply_patch` is not transactional; this intentionally matches Codex behavior.
- `apply_patch` add and move hunks must not silently overwrite unrelated existing files.
- Native deletion is not reimplemented; use delegated `delete`.

## Shell Boundary

The CLI accepts Obsidian-style `key=value` tokens, so inline shell-sensitive strings still pass through the user's shell before optsidian receives them. For large or sensitive payloads, prefer `@file` or stdin. MCP accepts JSON arguments and passes raw strings directly to core; tests cover `$HOME`, backticks, `$(...)`, and fenced code blocks.

## Adding a Command

Before adding a command:

1. Check whether native Obsidian already provides a sufficient command.
2. If native is sufficient, delegate and do not implement it.
3. Add or change behavior in `src/core/*` first.
4. Add a thin adapter in `src/cli/commands/*` only for CLI parsing and rendering.
5. Add or update MCP tool registration if the command should be exposed over MCP.
6. If optimizing a native command, add it to the optimized set and document why.
7. If adding a missing feature, add it to the extended set.
8. Add tests for direct core behavior, routing, MCP shape, vault safety, output shape, and failure behavior.

The policy regression test must keep passing.
