# Development Notes

## Project Layout

```text
src/cli.ts                         CLI binary entrypoint
src/cli/args.ts                    CLI key=value parsing and @file reads
src/cli/policy.ts                  native-first routing table
src/cli/delegate.ts                native Obsidian process delegation
src/cli/vault.ts                   vault root resolution through native Obsidian
src/cli/render.ts                  CLI text/json rendering
src/cli/commands/*.ts              thin CLI adapters
src/update/installer.ts            release lookup, managed install state, and updater
src/mcp.ts                         MCP stdio binary entrypoint
src/mcp/*.ts                       MCP tool registration, config, result mapping
src/native/obsidian.ts             shared native Obsidian process helpers
src/core/index.ts                  public core API for future non-shell adapters
src/core/path.ts                   vault path safety
src/core/read.ts                   bounded file reads
src/core/search.ts                 ranked note search and cache management
src/core/search-parse.ts           Markdown metadata extraction for search
src/core/frontmatter.ts            YAML frontmatter parsing and mutation
src/core/grep.ts                   line-oriented vault grep
src/core/edit.ts                   exact/regex/line/range edits
src/core/write.ts                  whole-file writes
src/core/apply-patch.ts            Codex-compatible patch engine
test/cli.test.mjs                  end-to-end tests with fake Obsidian
test/core.test.mjs                 direct core API tests
test/mcp.test.mjs                  MCP adapter and tool handler tests
test/release.test.mjs              release packaging, installer, and updater tests
```

The core layer must not depend on `process.argv`, `process.stdin`, `process.stdout`, or native Obsidian process delegation. CLI and MCP adapters only translate external inputs into core params and render returned results.

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

## MCP Vault Resolution

`optsidian-mcp` resolves the vault at startup with native `obsidian vault info=path`. If native resolution fails, it can use `--vault-path <path>` or `OPTSIDIAN_VAULT_PATH=<path>` as a fallback. The fallback exists because native Obsidian CLI may require the GUI to be running, while MCP file tools can operate directly on vault files.

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
