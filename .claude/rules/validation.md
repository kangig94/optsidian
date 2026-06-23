---
paths:
  - "src/**"
---
# Validation Checklists

## BLOCKING (must pass)
- `npm run typecheck` passes (zero errors), `npm run build` succeeds, and `npm test` is green.
- No command is both implemented and native-sufficient — the `src/cli/policy.ts` regression test holds.
- Every vault mutation resolves its path through `resolveVaultPath` (`src/core/path.ts`); no cwd-relative writes, no symlink escape, absolute paths only if inside the vault.
- Any change to the search analyzer, token channels, indexed fields, or ranking that affects index contents bumps `INDEX_BUILD_VERSION` (builder/field/partition/engine) and/or `ANALYZER_VERSION`/the analyzer-cache identity.
- `src/core/*` does not touch `process.argv`/`stdin`/`stdout` or perform native delegation; `src/core/kiwi/*` does not import `src/core/search/*`.

## STRONG (must document if skipped)
- MCP tool `destructiveHint`/`openWorldHint` annotations match real behavior (`src/mcp/tools.ts`).
- The documented command/flag/output surface (README, `docs/usage.md`, `docs/native-first-policy.md`) stays in sync with the implementation — flag divergences, don't silently introduce them.
- Writes are atomic (temp file + rename); `frontmatter` edits preserve BOM/EOL/body bytes.

## MINOR (should document)
- Code complexity within thresholds
- Naming conventions followed (see `conventions.md`)
- No dead code introduced
