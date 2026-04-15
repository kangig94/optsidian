# Usage Guide

`optsidian` uses the same `key=value` argument style as the Obsidian CLI.

```bash
optsidian <command> key=value flag
```

Values with spaces should be quoted by the shell:

```bash
optsidian read path="Projects/My Note.md" head=20
```

## Command Routing

Most Obsidian commands are delegated directly:

```bash
optsidian files
optsidian tags counts
optsidian delete path=old.md
optsidian property:set path=note.md name=status value=active
```

These preserve native stdout, stderr, and exit code.

Use `raw` when you explicitly want native Obsidian behavior:

```bash
optsidian raw --help
optsidian raw read path=README.md
```

## Vault Selection

`vault=<name>` is forwarded during vault resolution.

```bash
optsidian read vault=Work path=README.md head=20
optsidian search vault=Work query=TODO
optsidian grep vault=Work query=TODO
```

Optimized commands resolve paths relative to the selected vault root.

For MCP, vault selection happens when `optsidian-mcp` starts. It first runs native `obsidian vault info=path`. Pass `--vault <name>` or set `OPTSIDIAN_VAULT=<name>` to forward a vault name to native Obsidian.

```bash
optsidian-mcp --vault Work
OPTSIDIAN_VAULT=Work optsidian-mcp
```

If Obsidian GUI may be closed, provide a fallback path. The fallback is used only when native vault resolution fails.

```bash
optsidian-mcp --vault-path /path/to/vault
OPTSIDIAN_VAULT_PATH=/path/to/vault optsidian-mcp
```

## Reading

```bash
optsidian read path=note.md
optsidian read path=note.md head=50
optsidian read path=note.md tail=30
optsidian read path=note.md lines=10:40
optsidian read path=note.md around="needle" context=4
optsidian read path=note.md max-chars=5000
optsidian read path=note.md format=json
```

Only one of `lines=`, `head=`, `tail=`, and `around=` may be used at a time.

## Search and Grep

`search` ranks notes. `grep` finds exact line evidence.

```bash
optsidian search query="alpha rollout"
optsidian search query="alpha rollout" limit=10
optsidian search query="alpha rollout" path=Projects
optsidian search query="#project alpha" format=json
```

Search output includes note title, aliases, tags, matched fields with matching query terms, and body-focused snippets. Frontmatter participates in ranking but is not returned as snippet evidence. JSON output also includes `scope` when `path=` is used and per-result `fieldMatches`.

The search index is cached outside the vault and rebuilt automatically when stale. Use `index` for manual cache management:

```bash
optsidian index status
optsidian index rebuild
optsidian index clear
```

```bash
optsidian grep query=TODO
optsidian grep query=TODO context=2 limit=20
optsidian grep query=TODO path=Projects
optsidian grep query="TODO|FIXME" regex
optsidian grep query=todo case
optsidian grep query=needle all
optsidian grep query=needle include-hidden
optsidian grep query=needle format=json
```

## Editing

Exact replacement:

```bash
optsidian edit path=note.md replace="old" with="new"
optsidian edit path=note.md replace="old" with="new" all
```

Regex replacement:

```bash
optsidian edit path=note.md regex="^status: .*$" with="status: done"
```

Line and range replacement:

```bash
optsidian edit path=note.md line=10 with="- [x] done"
optsidian edit path=note.md range=20:25 with=@replacement.md
```

Preview without writing:

```bash
optsidian edit path=note.md replace="old" with="new" dry-run
```

## Writing

```bash
optsidian write path=Inbox/new.md content="# New note"
optsidian write path=Inbox/new.md content=@local-note.md
optsidian write path=Inbox/new.md content=@local-note.md overwrite
optsidian write path=Inbox/new.md content=@local-note.md dry-run
```

Existing files require `overwrite`.

Inline CLI values are parsed after your shell has already handled quoting and expansion. For payloads containing shell-sensitive syntax, use `content=@file`, `with=@file`, `patch=@file`, or stdin for `apply_patch`.

## Applying Patches

From a file:

```bash
optsidian apply_patch patch=@change.patch
```

From stdin:

```bash
optsidian apply_patch <<'PATCH'
*** Begin Patch
*** Add File: Inbox/new.md
+# New
+
+Body
*** Update File: README.md
@@
-old
+new
*** End Patch
PATCH
```

Supported hunk headers:

```text
*** Add File: <path>
*** Delete File: <path>
*** Update File: <path>
*** Move to: <new-path>
```

Patch paths may be vault-relative or absolute. Absolute paths must resolve inside the vault.

`Add File` refuses existing files. `Move to` refuses to overwrite an existing destination unless it resolves to the same file.

## Copying and Directories

```bash
optsidian mkdir path=Projects/New
optsidian mkdir path=Projects/New parents=false
optsidian copy from=a.md to=b.md
optsidian copy from=Folder to=FolderCopy recursive
optsidian copy from=a.md to=b.md overwrite
```

## JSON Output

The `read`, `search`, and `grep` commands support `format=json`.

```bash
optsidian read path=note.md lines=1:10 format=json
optsidian search query=TODO format=json
optsidian grep query=TODO format=json
```

Native delegated commands keep their original output formats.

## MCP Usage

`optsidian-mcp` exposes the core tools over stdio for MCP clients:

```text
read, search, grep, write, edit, apply_patch, copy, mkdir
```

MCP calls use JSON arguments, not shell tokens. This means values such as `$HOME`, backticks, `$(...)`, YAML frontmatter, and fenced code blocks are delivered as raw strings.

Example `edit` arguments:

```json
{
  "path": "note.md",
  "replace": "status: draft",
  "with": "status: done"
}
```

Example `apply_patch` arguments:

```json
{
  "patch": "*** Begin Patch\n*** Update File: note.md\n@@\n-old\n+new\n*** End Patch\n"
}
```

The MCP server does not expose a raw native Obsidian passthrough tool in V1. Use the CLI for native passthrough.
