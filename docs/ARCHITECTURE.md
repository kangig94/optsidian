# Architecture

`optsidian` is an LLM-optimized wrapper over the native Obsidian CLI. It ships two binaries —
`optsidian` (CLI) and `optsidian-mcp` (an MCP server) — that sit on a single shell-independent
core. The CLI and MCP adapters translate their respective transports into raw-string calls into
`src/core/*`, which returns structured results. Search is served through one search daemon using a
snapshot-resident positional engine plus Kiwi Korean morphology worker pools.

This document anchors the layer graph, the dependency rules, and the per-directory modification
policy. It describes architectural roles and decisions — not source contents. For developer
workflow and the implicit invariants in prose, see [`development.md`](development.md); for the
native-first command policy, see [`native-first-policy.md`](native-first-policy.md).

## Layers

```
L3 adapters   CLI (src/cli.ts, src/cli/*)        MCP (src/mcp.ts, src/mcp/*)
              Search daemon peer (src/daemon/*)
                     \      all depend down only        /
L2 core              CORE (src/core/*): read edit write apply-patch frontmatter
                     copy mkdir grep + search/* + kiwi/*   (raw-string in / structured out)
L1 platform   native/* (Obsidian CLI + GUI)   net/github.ts   errors.ts / version.ts
                                                  |
                                         update/installer (uses net + native)
```

| Layer | Modules | Role |
|-------|---------|------|
| L3 — adapters / daemon | `src/cli.ts`, `src/cli/*`, `src/mcp.ts`, `src/mcp/*`, `src/daemon/*` | CLI and MCP translate their transports into core calls or daemon RPC calls; the search daemon owns snapshot serving, indexing, worker pools, and status. CLI adapters also apply the native-first policy and delegate to the native Obsidian CLI. |
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
| `src/core/search/*` | Changing the analyzer, token channels, indexed fields, or ranking in a way that affects snapshot contents requires bumping the relevant search identity/schema version (see [Search](#search)). Snapshot indexing, query analysis, positional retrieval, and ranking must stay consistent. |
| `src/core/kiwi/*` | Standalone. Must not import `search/*`. |
| `src/daemon/*` | L3 search-daemon adapter. Owns socket transport, snapshot-store MVCC/GC, worker pools, vault registry, and scheduler. Bump the RPC protocol version on breaking wire changes. No upward dependency on `src/cli/*` or `src/mcp/*`. |
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

`command_run` is part of the V1 MCP contract because it is the MCP-to-CLI bridge for CLI-only and
native-delegated Optsidian commands. Keep this list synchronized with `MCP_TOOL_NAMES`.

## Daemon & Lifecycle State

There is exactly **one** search daemon process. It is started by the shared daemon client, owns a
nonce-authenticated socket, serves multiple vaults, and shuts down by idle policy unless configured
otherwise.

| Process | Hidden verb | Module | Transport & lifecycle |
|---------|-------------|--------|-----------------------|
| Search daemon | `__search-daemon` | `src/daemon/server.ts` | Detached `node <bin> __search-daemon`; Unix domain socket under the runtime search-daemon directory; MessagePack RPC methods `Search`, `Explain`, `Status`, `LoadVault`, `Rebuild`, `Refresh`, `Compact`, `Clear`, and `Shutdown`. The daemon owns snapshot MVCC, worker pools, query caches, and loaded vault state. |

**Install / update lifecycle.** `scripts/install.sh` installs a release and writes the manifest
`~/.cache/optsidian/install.json`. `optsidian update` (`src/update/installer.ts`) fetches a release,
verifies its SHA256 and version, installs atomically, and refreshes the MCP registration.

## Search

The search subsystem spans `src/core/search/*` and `src/daemon/search-store/*`.

- **Snapshot identity is content-addressed.** The active snapshot id is the hash of the canonical
  snapshot manifest. The identity tuple includes build version (segment encoding, partition scheme,
  engine, and identity normalizer), field-set, partition bits, analyzer, settings, ranking-feature,
  and retriever identity.
- **MVCC, not read-time planning.** Search pins one immutable snapshot for each request. Index jobs
  build and publish new snapshots atomically, and active requests keep their pinned snapshot until
  release.
- **One lexical retrieval primitive.** V1 retrieval is positional postings over analyzer channels.
  Phrase, coverage, proximity, rarity, exact identity, snippets, and debug signals are sourced from
  snapshot-resident postings and feature payloads.
- **Worker pools.** Query analyzer workers serve latency-sensitive query tokenization; index analyzer
  workers serve snapshot builds. Search execution runs in a dedicated pool with request deadlines and
  cancellation.
- **Korean.** Hangul routes to Kiwi when enabled, with the model downloaded as a SHA256-pinned
  artifact on first use. Parallelism comes from isolated workers, not concurrent calls into one
  analyzer object.

## Host-API Dependency Map

| Host API | Used for |
|----------|----------|
| Native Obsidian CLI (`obsidian`) | Delegated commands and vault discovery. |
| `obsidian://` URI (`src/native/gui.ts`) | Launching / focusing the Obsidian GUI. |
| Kiwi (`kiwi-nlp`) | Korean morphological analysis (WASM). |
| GitHub releases API (`src/net/github.ts`) | Fetching the Kiwi model artifact and self-update releases. |

**Security invariant to preserve.** `src/net/github.ts` strips the `Authorization` header on
cross-origin redirects and resolves tokens via `GITHUB_TOKEN` / `gh` / git-credential, in that order.
Do not regress this when changing the HTTP path.
