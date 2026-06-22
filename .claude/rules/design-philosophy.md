# Design Philosophy

<!-- GENERATION RULE: This file must contain only STABLE PRINCIPLES - not volatile facts.
     Module dependency graphs, specific file lists, and current architecture details
     belong in docs/ (ARCHITECTURE.md, development.md). Reference docs instead of duplicating.
     Test: if content needs updating on refactor (without principle change), it belongs in docs. -->

## Core Principles

**Clarity First**: Good code guides readers naturally — structure reveals intent without requiring explanation. Dense code can be clear; minimal code can be confusing. Optimize for cognitive load, not line count.

**Native-first**: `optsidian` wraps the native Obsidian CLI; it does not reimplement it. Classify every command as delegate (native is sufficient), optimize (keep the name, replace the behavior with an LLM-friendlier one), or extend (no native equivalent). When in doubt, delegate.
- The policy lives in `src/cli/policy.ts`; a regression test forbids a command being both implemented and native-sufficient.

**Core purity**: `src/core/*` is shell-independent — raw-string in, structured out. It must not touch `process.argv`/`stdin`/`stdout` or perform native delegation, so the CLI and MCP adapters can both call it unchanged.

**Vault safety above all**: Never corrupt or let a write escape the user's vault. All writes are atomic (temp file + rename); all paths resolve through `resolveVaultPath`.

**Deterministic search identity**: Anything that changes index contents — the analyzer, the token channels, the indexed fields, the ranking — is versioned so stale indexes are detectable. The persisted index, the in-memory overlay, and live analysis must agree.

## Source Tree Policy

| Directory | Layer | Contents | Modification Rule |
|-----------|-------|----------|-------------------|
| `src/cli.ts`, `src/cli/*` | L3 adapter | argv dispatch, arg parsing, rendering, native-first policy, delegation | Adapters stay thin (parse + render); logic belongs in core. Keep `policy.ts` + its test + docs in sync. |
| `src/mcp.ts`, `src/mcp/*` | L3 adapter | MCP stdio server, tool registration, result shaping | zod schemas and `destructiveHint`/`openWorldHint` must match real behavior. |
| `src/core/*` | L2 core | shared command layer (read, edit, write, apply-patch, frontmatter, copy, mkdir, grep) | Pure and shared. No process I/O, no native delegation. |
| `src/core/search/*` | L2 core | Orama index, retrieval, RRF ranking, the two daemons, locks/persistence | Index-affecting changes bump `SEARCH_SCHEMA_VERSION` / analyzer identity. |
| `src/core/kiwi/*` | L2 core | Korean morphological analysis (WASM), model artifact, lease manager | Must not import `search/*`. |
| `src/native/*` | L1 platform | native Obsidian invocation, GUI launch, vault discovery | No upward import of L3. |
| `src/net/github.ts`, `src/update/*` | L1 platform | GitHub HTTP, self-update | Preserve the redirect auth-stripping invariant in `net/github.ts`. |

Key rules:
1. Layer dependency: code in Lx may only depend on L0..L(x-1). L3 → L2 → L1; lower layers never import the adapters.
2. `src/core/kiwi/*` never imports `src/core/search/*` (one-directional adapter only).
3. All vault mutations go through `resolveVaultPath` (`src/core/path.ts`).

## Module Structure

Dependency direction is strict: the CLI and MCP adapters import from core; core never imports the adapters. See `docs/ARCHITECTURE.md` for the current layer graph and the two-daemon search topology.

## Agent System Philosophy

- **Tiered Expertise**: OPUS for safety/orchestration, SONNET for domain/quality
- **Mandatory Consultations**: Cross-domain changes require multiple agents (see `agents.md` consultation matrix)
- **Final validation**: `Skill(tier-review)` as the mandatory last step (reads `agents.md`, spawns agents by tier)
