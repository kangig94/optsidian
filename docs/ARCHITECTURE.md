# Architecture

`optsidian` is an LLM-optimized wrapper over the native Obsidian CLI. It ships two binaries —
`optsidian` (CLI) and `optsidian-mcp` (an MCP server) — that sit on a single shell-independent
core. The CLI and MCP adapters translate their respective transports into raw-string calls into
`src/core/*`, which returns structured results. Search (Orama full-text + Kiwi Korean
morphology) is the largest subsystem and runs behind two background daemons.

This document anchors the layer graph, the dependency rules, and the per-directory modification
policy. It describes architectural roles and decisions — not source contents. For developer
workflow and the implicit invariants in prose, see [`development.md`](development.md); for the
native-first command policy, see [`native-first-policy.md`](native-first-policy.md).

## Layers

```
L3 adapters   CLI (src/cli.ts, src/cli/*)        MCP (src/mcp.ts, src/mcp/*)
                     \      both depend down only       /
L2 core              CORE (src/core/*): read edit write apply-patch frontmatter
                     copy mkdir grep + search/* + kiwi/*   (raw-string in / structured out)
L1 platform   native/* (Obsidian CLI + GUI)   net/github.ts   errors.ts / version.ts
                                                  |
                                         update/installer (uses net + native)
```

| Layer | Modules | Role |
|-------|---------|------|
| L3 — adapters | `src/cli.ts`, `src/cli/*`, `src/mcp.ts`, `src/mcp/*` | Translate a transport (argv / MCP stdio) into core calls; render structured results back. CLI adapters also apply the native-first policy and delegate to the native Obsidian CLI. |
| L2 — core | `src/core/*` including `search/*` and `kiwi/*` | Shell-independent command layer shared by both adapters: raw-string in, structured out. Editing, frontmatter, search/indexing, Korean analysis. |
| L1 — platform | `src/native/*`, `src/net/github.ts`, `src/errors.ts`, `src/version.ts` | OS- and service-facing primitives: native Obsidian invocation + GUI launch, GitHub HTTP, error/exit-code types, version. `src/update/installer.ts` composes net + native for self-update. |

## Dependency Rules

1. **Downward only.** L3 may depend on L2 and L1; L2 and L1 never import L3. The core is the
   shared substrate, not a consumer of the adapters.
2. **Core purity.** `src/core/*` must not touch `process.argv` / `process.stdin` / `process.stdout`
   and must not perform native delegation. Core is raw-string in / structured out so the CLI and MCP
   adapters can both call it unchanged (`development.md`).
3. **Kiwi never imports search.** `src/core/kiwi/*` is standalone Korean-analysis infrastructure;
   `src/core/search/analyzer.ts` adapts Kiwi for search in one direction only. The reverse import is
   forbidden (`development.md`).
4. **All vault mutations resolve through `resolveVaultPath`.** Every read/write/edit path passes
   through `src/core/path.ts` `resolveVaultPath`, which keeps paths inside the vault and rejects
   symlink escapes (`development.md`).

## Modification Policy

| Directory | Modification rule |
|-----------|-------------------|
| `src/core/*` | Pure and shared. No `process.*` I/O, no native delegation. New logic lives here so both adapters get it; adapters stay thin. |
| `src/core/search/*` | Changing the analyzer, token channels, indexed fields, or ranking in a way that affects index contents requires bumping `SEARCH_CACHE_VERSION` (see [Search](#search)). Persisted index, in-memory overlay, and live analysis must stay consistent. |
| `src/core/kiwi/*` | Standalone. Must not import `search/*`. |
| `src/cli/policy.ts` | The native-first policy table. Classify every new command (delegate / optimize / extend) and keep the table, its regression test, and the docs in sync. |
| `src/mcp/tools.ts` | MCP tool registration. zod input schemas and the `destructiveHint` / `openWorldHint` annotations must match real behavior. |
| `src/native/*`, `src/net/*`, `src/update/*` | Platform layer. No upward dependency on the adapters; no core dependency on these beyond the documented composition in `update/installer.ts`. |

## Extension-Point Catalog

### CLI command surface

The native-first policy (`src/cli/policy.ts`) sorts every command into one of three classes.
`src/cli/policy.ts` is the source of truth — cite the symbols, not a re-typed list.

| Class | Symbol | Meaning |
|-------|--------|---------|
| delegate | `NATIVE_SUFFICIENT_COMMANDS` | Native Obsidian CLI behavior is sufficient; `optsidian` passes the command straight through. |
| optimize | `read` | The native name is kept but the behavior is replaced with an LLM-friendlier one (line ranges, bounded output). |
| extend | `EXTENDED_COMMANDS` (13) | No native equivalent: `search, index, config, grep, frontmatter, edit, apply_patch, write, copy, mkdir, open-gui, update, plugin:install`. |

A regression test enforces that no command is both implemented and native-sufficient
(`native-first-policy.md` guardrail).

### MCP tool surface — 5 tools

Registered in `src/mcp/tools.ts`; the canonical list is `MCP_TOOL_NAMES` in `src/cli/help.ts`.

| Tool | Notes |
|------|-------|
| `command_map` | Routing helper — reports the available tools and command map at runtime. |
| `command_run` | ⚠ `destructiveHint: true, openWorldHint: true`. Runs any Optsidian command, including native-delegated ones, reaching the running Obsidian. |
| `write` | → `writeVaultFile` (atomic). |
| `edit` | → `editVaultFile`. |
| `apply_patch` | → `applyVaultPatch`. |

> **Discrepancy to reconcile (recorded, not resolved here).** Three sources disagree about the MCP
> surface:
> - (a) the prose docs (`README.md`, `docs/usage.md`, `docs/native-first-policy.md`) list **4**
>   tools and promise "MCP does not expose a native passthrough tool in V1";
> - (b) the code's own `MCP_TOOL_NAMES` and the `command_map` tool advertise **5** tools at runtime,
>   including `command_run`;
> - (c) `command_run` *is* the native passthrough that (a) says does not exist.
>
> This document records the code reality. Whether the docs are stale or `command_run` is unintended
> is a product decision left to the maintainer; the prose docs are deliberately not edited.

## Daemons & Lifecycle State

There are exactly **two** background daemons. Reconcile work runs under mkdir-based locks — it is
not a third daemon.

| Daemon | Hidden verb | Module | Transport & lifecycle |
|--------|-------------|--------|-----------------------|
| Analyzer | `__analyzer-daemon` | `src/core/search/analyzer.ts` | Detached `node <bin> __analyzer-daemon`; Unix domain socket `…/optsidian/analyzer-<protoVer>-<identity>.sock` (Windows: named pipe); newline-delimited JSON `tokenizeBatch`; idle-shutdown after 5 min. Reuses the loaded Kiwi WASM across CLI invocations. |
| Index / warm | `__index-daemon` | `src/core/search/warm-daemon.ts` | Separate daemon and socket `index-<protoVer>-<identity>.sock`; methods `warmRecent` / `warmVault` / `status` / `shutdown`; incrementally warms vaults accessed in the last 7 days. |

**Install / update lifecycle.** `scripts/install.sh` installs a release and writes the manifest
`~/.cache/optsidian/install.json`. `optsidian update` (`src/update/installer.ts`) fetches a release,
verifies its SHA256 and version, installs atomically, and refreshes the MCP registration.

## Search

The search subsystem (`src/core/search/*`, ~5,800 LOC) is the most complex part of the codebase.

- **Index identity has one cache version.** `SEARCH_CACHE_VERSION` covers the persisted Orama index,
  manifest identity, and analysis-cache payload. During unreleased development, collapse multiple
  incompatible edits into one bump instead of incrementing per commit. Runtime-only ranking changes
  do not require an index/cache version bump; `index warm` can force a rebuild when needed.
- **Three retrieval paths must agree.** A persisted on-disk index, an in-memory overlay for small
  recent diffs, and live analysis all feed results; the read-time planner selects among them and
  they must stay consistent.
- **Locks, not transactions.** `reconcile.lock` and `index-writer.lock` are mkdir-based exclusive
  directories; persistence writes an atomic index + manifest pair bound by a digest commit.
- **Korean.** Hangul runs route to Kiwi, which is loaded as WASM behind a single-instance lease
  manager (`src/core/kiwi/*`) and downloaded as a SHA256-pinned model artifact on first use.

## Host-API Dependency Map

| Host API | Used for |
|----------|----------|
| Native Obsidian CLI (`obsidian`) | Delegated commands and vault discovery. |
| `obsidian://` URI (`src/native/gui.ts`) | Launching / focusing the Obsidian GUI. |
| Orama (`@orama/orama`) | The full-text index engine. |
| Kiwi (`kiwi-nlp`) | Korean morphological analysis (WASM). |
| GitHub releases API (`src/net/github.ts`) | Fetching the Kiwi model artifact and self-update releases. |

**Security invariant to preserve.** `src/net/github.ts` strips the `Authorization` header on
cross-origin redirects and resolves tokens via `GITHUB_TOKEN` / `gh` / git-credential, in that order.
Do not regress this when changing the HTTP path.
