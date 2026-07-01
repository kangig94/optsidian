# Architecture

`optsidian` is an LLM-optimized wrapper over the native Obsidian CLI. It ships two binaries —
`optsidian` (CLI) and `optsidian-mcp` (an MCP server) — that sit on a single shell-independent
core. The CLI and MCP adapters translate their respective transports into raw-string calls into
`src/core/*`, which returns structured results. Search and similarity are served through one
resident search daemon using query/control RPC sockets, immutable lexical/retrieval snapshots,
Kiwi Korean morphology worker pools, a model-session lifecycle for embeddings, and a vector
generation pool for dense retrieval.

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
| L3 — adapters / daemon | `src/cli.ts`, `src/cli/*`, `src/mcp.ts`, `src/mcp/*`, `src/daemon/*` | CLI and MCP translate their transports into core calls or daemon RPC calls; the search daemon owns snapshot serving, retrieval, indexing, worker pools, query/control sockets, and status. CLI adapters also apply the native-first policy and delegate to the native Obsidian CLI. |
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
| extend | `EXTENDED_COMMANDS` (14) | No native equivalent: `search, similarity, index, config, grep, frontmatter, edit, apply_patch, write, copy, mkdir, open-gui, update, plugin:install`. |

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
nonce-authenticated query socket and control socket, and serves multiple vaults. The daemon is
resident: it does not idle-exit after request release. Embedding model sessions have their own idle
unload lifecycle inside workers, so zero-footprint-at-rest applies to loaded model sessions rather
than to the daemon process.

For the full runtime lifecycle — daemon birth/death, model session load/unload, per-mode request
flow, and cache/index build/publish/GC — see [`lifecycle.md`](lifecycle.md).

| Process | Hidden verb | Module | Transport & lifecycle |
|---------|-------------|--------|-----------------------|
| Search daemon | `__search-daemon` | `src/daemon/server.ts` | Detached `node <bin> __search-daemon`; separate query/control Unix domain sockets under the runtime search-daemon directory. Query RPC exposes `Status`, `Search`, and `Retrieve`; CLI `search` uses `Search` for default lexical search and switches to `Retrieve` for vector/hybrid retrieval, while `explain` uses `Retrieve`. Control RPC exposes `Status`, `LoadVault`, `Rebuild`, `Refresh`, `Compact`, `Clear`, `Prune`, and `Shutdown`. The daemon owns snapshot MVCC, retrieval generations, worker pools, query caches, and loaded vault state. |

**Install / update lifecycle.** `scripts/install.sh` installs a release and writes the manifest
`~/.cache/optsidian/install.json`. `optsidian update` (`src/update/installer.ts`) fetches a release,
verifies its SHA256 and version, installs atomically, and refreshes the MCP registration.

## Search

The search subsystem spans `src/core/search/*`, `src/daemon/search-store/*`, and
`src/daemon/vector-store/*`.

- **Snapshot identity is content-addressed.** The active corpus snapshot id is the hash of the
  canonical snapshot manifest. Retrieval snapshots add the retriever plan, embedding recipe/provider,
  link resolver/scoring identity, and ranking feature version. Query-time pins validate the active
  retrieval pointer against the current expected identity before serving.
- **MVCC, not read-time planning.** Search pins one immutable snapshot for each request. Index jobs
  build and publish new snapshots atomically, and active requests keep their pinned snapshot until
  release. Query release is refcount-only; file deletion and mark-sweep GC are control/index
  maintenance operations.
- **Search and Retrieve are separate query paths.** Query RPC accepts `Search` for default lexical
  search, and `Retrieve` for `origin=text`, `origin=note`, `origin=pair`, vector/hybrid search,
  similarity, and explain. A ready retrieval request is served from a pinned retrieval snapshot and a
  promoted built vector generation. If the generation is absent, stale, or built for a different
  identity, Retrieve returns `status: "index-not-ready"` rather than scanning in-process embedding
  JSON.
- **Query pipeline.** Query search is planned by `SearchQueryPlanner`, scheduled by
  `SearchQueryScheduler` / `SearchQuerySession`, merged by `ResultAggregator`, and hydrated by
  `ResultHydrator`. The retained monolithic `executeSearchJob` / `querySearch` path is the test
  determinism oracle (AC6 baseline), not dead code or the daemon query path.
- **Lexical, dense, and link retrieval.** Lexical retrieval is positional postings over analyzer
  channels. Dense retrieval is a vector-generation-pool query against the active built generation.
  Link retrieval uses the link graph carried with snapshot/shard handles so adjacency candidates
  survive fanout. Phrase, coverage, proximity, rarity, exact identity, snippets, dense agreement,
  link agreement, RRF score, and explain traces are sourced from pinned snapshot data.
- **Worker pools.** Query analyzer workers serve latency-sensitive query tokenization; index analyzer
  workers serve snapshot builds. Embedding workers own `ModelSessionLifecycle` instances and route
  encode/unload/stats through them. Search execution runs in a dedicated pool with request deadlines
  and cancellation.
- **Idle-ready search leases.** Query sessions lease only ready, idle search-execution slots. Leasing is
  atomic, targeted `runOnSlot` consumes the lease, and busy/leased slots are excluded from later leases.
  Scheduler fairness is single-source: active sessions share idle capacity first, then any otherwise
  idle slots are relaxed to runnable sessions.
- **Coverage modes.** `coverage=full` is collect-all: all planned shard units are scheduled and the
  final global ordering is independent of batch composition. `coverage=bounded` schedules a
  deterministic bounded prefix for shard/work budgets and returns warning labels; time budgets are
  best-effort and marked non-reproducible.
- **Korean.** Hangul routes to Kiwi when enabled, with the model downloaded as a SHA256-pinned
  artifact on first use. Parallelism comes from isolated workers, not concurrent calls into one
  analyzer object.

## Host-API Dependency Map

| Host API | Used for |
|----------|----------|
| Native Obsidian CLI (`obsidian`) | Delegated commands and vault discovery. |
| `obsidian://` URI (`src/native/gui.ts`) | Launching / focusing the Obsidian GUI. |
| Kiwi (`kiwi-nlp`) | Korean morphological analysis (WASM). |
| ONNX Runtime | Local embedding model sessions in embedding workers. |
| `coral-needle` | Native vector index instances for built dense generations; tests inject a fake instance when the native `.node` binding is absent. |
| GitHub releases API (`src/net/github.ts`) | Fetching the Kiwi model artifact and self-update releases. |

**Security invariant to preserve.** `src/net/github.ts` strips the `Authorization` header on
cross-origin redirects and resolves tokens via `GITHUB_TOKEN` / `gh` / git-credential, in that order.
Do not regress this when changing the HTTP path.
