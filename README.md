# optsidian

`optsidian` is an LLM-optimized wrapper around the Obsidian CLI.

It follows a native-first policy: commands that Obsidian already handles well are delegated unchanged, while `optsidian` adds Codex-style CLI tools for bounded reads, ranked note search, exact grep output, structured frontmatter edits, safe edits, and patch application inside the active vault. `optsidian-mcp` stays small and exposes only shell-safe mutation tools plus a routing helper.

## Requirements

- Node.js 20 or newer
- `curl` for the release installer
- Codex CLI and Claude Code are optional; detected clients are registered automatically
- A working `obsidian` CLI on `PATH` for native vault resolution
- Linux or macOS for managed install/update

The real Obsidian binary can be overridden with:

```bash
OPTSIDIAN_OBSIDIAN_BIN=/path/to/obsidian optsidian read path=README.md head=20
```

## Install

Install the latest published release from the canonical script:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

The script downloads the latest stable GitHub release assets, verifies downloaded checksums, installs `optsidian` and `optsidian-mcp` into `~/.local/bin`, writes managed install metadata under `~/.cache/optsidian`, and registers `optsidian` with any detected Codex/Claude client. It requires Node.js 20 or newer and does not invoke the native `obsidian` CLI during installation.

If native Obsidian vault lookup is unavailable when the MCP client starts, install with a fallback vault path:

```bash
export OPTSIDIAN_VAULT_PATH=/path/to/vault
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

Then check:

```bash
optsidian --help
optsidian search --help
optsidian-mcp --help
```

Update an existing managed install:

```bash
optsidian update
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/uninstall.sh | bash
```

## MCP Server

`optsidian-mcp` runs a local MCP server over stdio. It resolves the active vault through the native Obsidian CLI at startup, then exposes a small shell-independent JSON mutation surface:

```text
command_map, write, edit, apply_patch
```

Example MCP client config:

```json
{
  "mcpServers": {
    "optsidian": {
      "command": "optsidian-mcp"
    }
  }
}
```

If Obsidian GUI may be closed when Codex starts, add a fallback path. Native vault resolution is still tried first.

```json
{
  "mcpServers": {
    "optsidian": {
      "command": "optsidian-mcp",
      "env": {
        "OPTSIDIAN_VAULT_PATH": "/path/to/vault"
      }
    }
  }
}
```

For a non-default Obsidian binary:

```json
{
  "mcpServers": {
    "optsidian": {
      "command": "optsidian-mcp",
      "env": {
        "OPTSIDIAN_OBSIDIAN_BIN": "/path/to/obsidian"
      }
    }
  }
}
```

MCP tool arguments are JSON, so content strings are passed directly without shell expansion. Use the `command_map` MCP tool for routing first when work goes beyond the MCP mutation tools; it returns the Optsidian CLI-only commands, the exposed MCP tools, and the current native delegated command list, then points detailed syntax to `optsidian --help` or `optsidian <command> --help`.

## Native-First Policy

`optsidian` does not reimplement Obsidian commands that are already sufficient for LLM/tool use. Those commands are delegated with the original arguments, stdout, stderr, and exit code preserved.

Examples that stay native:

```bash
optsidian files
optsidian file path=README.md
optsidian delete path=old.md
optsidian property:set path=note.md name=status value=active
optsidian tasks todo
```

Use `raw` to force native execution:

```bash
optsidian raw --help
optsidian raw search query=foo format=json
```

## Optimized Commands

Detailed syntax for any implemented command:

```bash
optsidian <command> --help
```

### `read`

Read vault files with line ranges and output caps.

```bash
optsidian read path=README.md head=40
optsidian read path=README.md lines=20:60
optsidian read path=README.md around="Native-First" context=5
optsidian read path=README.md lines=1:20 format=json
```

Text output is line-numbered:

```text
path: README.md
lines: 1-3/120
truncated: false

1 | # optsidian
2 |
3 | `optsidian` is an LLM-optimized wrapper...
```

## Extended Commands

### `search`

Rank notes by title, tags, aliases, headings, path, and body.

```bash
optsidian search query="alpha rollout"
optsidian search query="alpha rollout" limit=10
optsidian search query="alpha rollout" path=Projects
optsidian search query="review" field=body
optsidian search query="rollout" tag=project path=Projects
optsidian search tag=project,alpha
optsidian search query="#project alpha" format=json
```

Search returns only note path, title, tags, and body-focused snippets. Frontmatter is indexed for ranking, but it is not shown as snippet evidence. `field=` is only valid when `query=` is present.

The search index is stored outside the vault under the OS cache directory and rebuilt automatically as needed. `index status` only reports whether a usable cache exists.

```bash
optsidian index status
optsidian index rebuild
optsidian index clear
```

### `grep`

Find exact or regex line matches in vault text with compact output.

```bash
optsidian grep query=TODO context=2 limit=20
optsidian grep query="status: active" path=Projects
optsidian grep query="foo\\d+" regex case format=json
```

By default, grep includes Markdown files and skips `.obsidian`, `.git`, `.trash`, `node_modules`, and hidden directories. Use `all` for non-Markdown files and `include-hidden` for hidden directories other than protected internals.

### `frontmatter`

Read and mutate YAML frontmatter in Markdown files without editing raw text.

```bash
optsidian frontmatter read path=note.md
optsidian frontmatter set path=note.md key=status value=active
optsidian frontmatter set path=note.md key=priority value-json=3
optsidian frontmatter add path=note.md key=tags value=project
optsidian frontmatter remove path=note.md key=tags value=old
optsidian frontmatter delete path=note.md key=status dry-run
```

`value=` is stored as a string. Use `value-json=` for numbers, booleans, arrays, objects, or null. Both value forms support `@file`. Frontmatter mutations preserve the Markdown body exactly and reject invalid YAML, duplicate keys, and non-mapping frontmatter roots.

### `edit`

Apply exact, regex, line, or range edits.

```bash
optsidian edit path=note.md replace="old text" with="new text"
optsidian edit path=note.md replace="old" with="new" all
optsidian edit path=note.md regex="^status: .*$" with="status: done"
optsidian edit path=note.md line=12 with="- [x] finished"
optsidian edit path=note.md range=20:25 with=@section.md dry-run
```

Replacement text is literal. Strings such as `$&` and `$1` are not interpreted as JavaScript replacement tokens.

### `write`

Write a whole file with an overwrite guard.

```bash
optsidian write path=Inbox/new.md content="# New note"
optsidian write path=Inbox/new.md content=@note.md overwrite
optsidian write path=Inbox/new.md content=@note.md dry-run
```

### `apply_patch`

Apply Codex-style patches inside the vault.

```bash
optsidian apply_patch patch=@change.patch
```

Or via stdin:

```bash
optsidian apply_patch <<'PATCH'
*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch
PATCH
```

The patch grammar is compatible with Codex-style `Add File`, `Update File`, `Delete File`, and `Move to` hunks. Absolute paths are parsed, but rejected unless they resolve inside the active vault. `Add File` refuses existing files, and `Move to` refuses to overwrite an existing destination unless it is the same file.

### `copy` and `mkdir`

```bash
optsidian mkdir path=Projects/New
optsidian copy from=Templates/template_project.md to=Projects/New/New.md
optsidian copy from=Templates to=Backups/Templates recursive
```

## Safety Model

- Optimized and extended commands are constrained to the active vault root.
- Relative paths resolve from the vault root, not the shell cwd.
- Existing paths are checked with `realpath`.
- New paths validate the nearest existing parent.
- Symlink escapes outside the vault are rejected.
- Mutating commands apply immediately unless `dry-run` is passed.
- File writes are atomic per file.
- Multi-file `apply_patch` is not transactional, matching Codex behavior.

## Architecture

`src/core/*` is the shell-independent command layer. It accepts raw strings and returns structured results, so MCP tools can call it directly without command-line quoting or stdout parsing. `src/cli/*` is only the CLI adapter: argument parsing, native Obsidian delegation, vault discovery, and text/json rendering. `src/mcp/*` is the stdio MCP adapter.

## Development

```bash
npm install
npm run build
npm test
```

Useful local checks:

```bash
dist/optsidian --help
dist/optsidian-mcp --help
dist/optsidian files total
dist/optsidian read path=README.md head=10
npm pack --dry-run
```

## Documentation

- [Usage guide](docs/usage.md)
- [Native-first policy](docs/native-first-policy.md)
- [Development notes](docs/development.md)
