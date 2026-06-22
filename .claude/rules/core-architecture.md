---
paths:
  - "src/core/**"
---
# Core Architecture

`src/core/*` is the shell-independent layer shared by the CLI and the MCP server: **raw-string in,
structured out.** Both adapters call the same core functions, so the core must stay free of any
transport-specific concern.

## Principles

- **Core purity.** No `process.argv`, `process.stdin`, or `process.stdout`; no native delegation. If a feature needs argv or stdout, it belongs in `src/cli/*` or `src/mcp/*`, not here (`docs/development.md:5`).
- **Downward dependency only.** Core may use the L1 platform layer (`native/`, `net/`, errors/version) but must never import the L3 adapters (`cli/`, `mcp/`).
- **Kiwi never imports search.** `src/core/kiwi/*` is standalone Korean-analysis infrastructure. `src/core/search/analyzer.ts` adapts Kiwi for search in one direction only; the reverse import is forbidden (`docs/development.md:7`).
- **One shared surface.** The barrel `src/core/index.ts` is the surface both adapters consume (e.g. `writeVaultFile`, `editVaultFile`, `applyVaultPatch`). Keep new core capabilities reachable there rather than wiring adapters to deep internals.

See `docs/ARCHITECTURE.md` for the current layer graph.

## DO / DON'T

| DO | DON'T |
|----|-------|
| Return structured data and let the adapter render it | `console.log` / read `process.stdin` from inside core |
| Add a shared capability to core and expose it via the barrel | Duplicate logic in both `cli/commands/*` and `mcp/tools.ts` |
| Keep `kiwi/*` importing only kiwi + platform utilities | `import` a `search/*` module from `kiwi/*` |
| Import platform helpers (`native/`, `net/`) when needed | `import` anything from `src/cli/*` or `src/mcp/*` into core |
