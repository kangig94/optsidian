# Native-First Policy

`optsidian` is a wrapper, not a replacement for the Obsidian CLI.

The rule is:

```text
If native Obsidian CLI behavior is already sufficient, optsidian delegates it.
If native behavior is missing Codex-style or LLM-friendly controls, optsidian may optimize it.
If native behavior has no equivalent, optsidian may extend it.
```

## Sufficient Native Commands

V1 treats these command families as native-sufficient:

- File and folder listing/info: `files`, `folders`, `file`, `folder`
- Obsidian file operations: `create`, `delete`, `move`, `rename`, `append`, `prepend`
- Metadata and task tools: `properties`, `property:*`, `tasks`, `task`, `tags`
- Link and outline tools: `links`, `backlinks`, `outline`, `unresolved`
- Vault and workspace tools: `vault`, `vaults`, `workspace`
- Plugin, theme, sync, history, template, hotkey, and developer commands

These commands are delegated exactly unless explicitly moved into the optimized set later.

MCP does not expose a native passthrough tool in V1. Native-first delegation is a CLI behavior; MCP exposes only the implemented structured tools.

## Optimized Native Names

The following native command names are intentionally optimized:

- `read`: native `read` has no line ranges, bounded output, or line-numbered context.

This is the only intentional native-name replacement in V1.

## Extended Commands

These commands are added because the native CLI does not provide an equivalent LLM-oriented tool surface:

- `grep`
- `search`
- `index`
- `edit`
- `write`
- `apply_patch`
- `copy`
- `mkdir`

`grep` is intentionally not named `search`: it is exact/regex line matching for evidence checks. `search` is note-level ranked discovery backed by an external cache index.

## Guardrail

The implementation has a policy table in `src/cli/policy.ts`.

Tests assert that no command can be both:

- implemented by `optsidian`
- marked native-sufficient

This prevents accidental reimplementation of Obsidian features that should remain delegated.

## Revisiting the Policy

If Obsidian later adds fully LLM-friendly behavior for an optimized command, prefer one of these outcomes:

1. Remove the `optsidian` implementation and delegate to native.
2. Keep the optimized behavior only if it still provides a distinct, documented advantage.
3. Move the optimized behavior to a new name if preserving native semantics becomes more important.
