# optsidian - Development Instructions

`optsidian` is an LLM-optimized wrapper over the native Obsidian CLI with Codex-style editing tools.
It ships two binaries — `optsidian` (CLI) and `optsidian-mcp` (an MCP server) — that sit on a single
shell-independent core (`src/core/*`). The CLI and MCP adapters translate their transports into core
calls; the core returns structured results. Full-text search uses a purpose-built positional index
with Korean morphology (Kiwi), served by one background `search-daemon`. TypeScript (strict, ESM),
Node ≥ 20.

**Critical Requirements**:
- Never corrupt or let a write escape the user's vault — writes are atomic (temp+rename) and every path resolves through `resolveVaultPath`.
- Keep `src/core/*` shell-independent: no `process.argv`/`stdin`/`stdout`, no native delegation.
- Native-first: wrap the Obsidian CLI, don't reimplement it. Classify every command delegate/optimize/extend in `src/cli/policy.ts`.
- Version index identity (`SEARCH_SCHEMA_VERSION` / analyzer identity) on any change that affects search index contents.

**Key Documentation**:
- `docs/ARCHITECTURE.md` - layer graph, dependency rules, modification policy, command + MCP surface, single-daemon topology
- `docs/development.md` - developer workflow and the implicit architectural invariants
- `docs/native-first-policy.md` - the delegate/optimize/extend command policy
- `docs/usage.md` - CLI and MCP usage reference

**Build Commands**:
```bash
npm run typecheck   # tsc --noEmit (strict, NodeNext)
npm run build       # esbuild bundle → dist/optsidian, dist/optsidian-mcp
npm test            # typecheck + build + node --test test/*.test.mjs (via tsx)
```

Rules in `.claude/rules/` are auto-loaded. Domain-specific rules activate based on file paths being edited via `paths:` frontmatter.

Good code guides readers naturally — structure reveals intent without requiring explanation.

## Workflow

**Before**: Read `docs/ARCHITECTURE.md` and `docs/development.md`. Identify required agent consultations from the matrix in `.claude/rules/agents.md`.

**During**: Invoke domain agents per the consultation matrix. Follow the source tree policy and layer dependency rules (`.claude/rules/design-philosophy.md`).

**After Implementation** (strict order, fail-fast by cost):

**Scope gate**: Steps 1-4 apply only when source-affecting files are modified (source code, build config, dependencies). Non-source changes (docs, agent definitions, config prose) skip entirely.

1. **Lint** - no linter is configured; the `npm run typecheck` gate stands in (cheapest check first).
2. **Review Gate** - invoke `Skill(tier-review)`. BLOCKING items must pass before build.
3. **Build** - `npm run build`.
4. **Test** - `npm test`. All tests must pass and all errors must be zero before declaring complete. Never assume errors are "pre-existing" without tracing the stack and verifying the affected code was not modified.
