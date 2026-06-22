---
paths:
  - "src/cli.ts"
  - "src/cli/**"
  - "src/mcp.ts"
  - "src/mcp/**"
---
# Command Contract

The CLI and MCP server are thin adapters over the core. Their contract — which commands exist, what
they accept, what they return — must stay honest against the implementation, the native-first policy,
and the docs.

## Principles

- **Native-first classification.** Every command is delegate, optimize, or extend in `src/cli/policy.ts`. Adding or changing a command means updating that table — and never implementing a command that is native-sufficient (a regression test enforces this).
- **Adapters stay thin.** `src/cli/commands/*` and `src/mcp/tools.ts` parse input and render output; the logic lives in `src/core/*`. CLI and MCP should converge on the same core function (e.g. both `write` paths call `writeVaultFile`).
- **MCP annotations must be truthful.** A tool's zod input schema, its result shaping, and especially its `destructiveHint` / `openWorldHint` flags must match what it actually does. A destructive, open-world tool must be annotated as such.
- **Keep the documented surface in sync.** The command/flag/output surface in `README.md`, `docs/usage.md`, and `docs/native-first-policy.md` must track the implementation. If you find a divergence you cannot confidently resolve (e.g. the `command_run` MCP tool), flag it for the maintainer — do not silently change behavior or docs to "match".

## DO / DON'T

| DO | DON'T |
|----|-------|
| Classify a new command in `policy.ts` and update its test | Add a command that duplicates native-sufficient behavior |
| Keep CLI/MCP adapters limited to parse + render | Put vault or search logic in `commands/*` or `tools.ts` |
| Set `destructiveHint`/`openWorldHint` to match real behavior | Register a destructive tool without the hint |
| Route CLI and MCP to the same core function | Re-implement an operation separately per adapter |
| Surface a doc/impl contract divergence you can't resolve | Edit product docs to paper over an unverified contradiction |
