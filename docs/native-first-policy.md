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
- Plugin, theme, sync, history, template, hotkey, and developer commands, except custom-source `plugin:install`

These commands are delegated exactly unless explicitly moved into the optimized set later.

MCP exposes five tools: `command_map`, `command_run`, `write`, `edit`, and `apply_patch`.
`command_run` is the native/CLI passthrough bridge for MCP clients; the mutation tools remain
shell-safe structured shortcuts for common vault writes.

## Optimized Native Names

The following native command names are intentionally optimized:

- `read`: native `read` has no line ranges, bounded output, or line-numbered context.

This is the only intentional native-name replacement in V1.

## Extended Commands

These commands are added or extended because the native CLI does not provide an equivalent LLM-oriented tool surface:

- `grep`
- `search`
- `similarity`
- `index`
- `config`
- `frontmatter`
- `edit`
- `write`
- `apply_patch`
- `copy`
- `mkdir`
- `open-gui`
- `update`
- `plugin:install`

`grep` is intentionally not named `search`: it is exact/regex line matching for evidence checks. `search` is note-level ranked discovery backed by an external cache index. `similarity` is a Retrieve-backed extension for dense/link note retrieval and ad-hoc text comparisons; unsupported historical filter/projection flags are rejected instead of silently ignored. Search defaults to exhaustive daemon execution. `mode=approximate` / `--approximate` and its `budget-*` flags are Optsidian extensions and always surface warning labels in results.

`frontmatter` does not replace native `property:*` commands. It provides an LLM-oriented structured editing surface with dry-run diffs, JSON values, MCP mutation support, and direct file fallback when native Obsidian vault resolution is unavailable.

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
