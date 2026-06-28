# optsidian

`optsidian` is an LLM-optimized wrapper around the Obsidian CLI.

It follows a native-first policy: commands that Obsidian already handles well are delegated unchanged, while `optsidian` adds Codex-style CLI tools for bounded reads, ranked note search, exact grep output, structured frontmatter edits, safe edits, and patch application inside the active vault. `optsidian-mcp` stays small and exposes only shell-safe mutation tools plus a routing helper.

## Requirements

- Node.js 20 or newer
- `curl` for the release installer
- Codex CLI and Claude Code are optional; detected clients are registered automatically
- A working `obsidian` CLI on `PATH` for active vault resolution and native/plugin commands
- Linux or macOS for managed install/update

The real Obsidian binary can be overridden with:

```bash
OPTSIDIAN_OBSIDIAN_BIN=/path/to/obsidian optsidian read path=README.md head=20
```

For file-only Optsidian commands, a fixed vault path avoids native vault resolution:

```bash
optsidian read vault-path=/path/to/vault path=README.md head=20
OPTSIDIAN_VAULT_PATH=/path/to/vault optsidian write path=note.md content="hello"
```

To launch Obsidian explicitly before native/plugin commands:

```bash
optsidian open-gui
optsidian open-gui vault-path=/path/to/vault
```

`open-gui` waits up to 10 seconds for native vault resolution before returning. Opening a vault path can change the active vault seen by later native commands.

## Install

Install the latest published release from the canonical script:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

The script downloads the latest stable GitHub release assets, verifies downloaded checksums, installs `optsidian` and `optsidian-mcp` into `~/.local/bin`, writes managed install metadata under `~/.cache/optsidian`, and registers `optsidian` with any detected Codex/Claude client. It requires Node.js 20 or newer and does not invoke the native `obsidian` CLI during installation.

If you want MCP to stay pinned to one vault regardless of the active GUI vault, install with a fixed vault path:

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

### Separate Claude config dirs (`CLAUDE_CONFIG_DIR`)

`install.sh` registers the MCP only with the Claude config dir active during install (`~/.claude` by default). Claude Code stores MCP servers per config dir (in `<CLAUDE_CONFIG_DIR>/.claude.json`), so register once for each additional config dir:

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude-work claude mcp add optsidian -s user -- ~/.local/bin/optsidian-mcp
```

Append `-e OPTSIDIAN_VAULT_PATH=/path/to/vault` to match a fixed-vault install. Codex keeps a single global config, so it needs no per-config-dir step. The entry points at the stable `~/.local/bin/optsidian-mcp` path, so `optsidian update` (which replaces that binary in place) reaches every registered config dir automatically — no re-registration needed.

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/uninstall.sh | bash
```

## MCP Server

`optsidian-mcp` runs a local MCP server over stdio. It always starts and exposes a small shell-independent JSON tool surface for command routing and vault mutation. Vault-dependent tools resolve the active vault through the native Obsidian CLI when they are called:

```text
command_map, command_run, write, edit, apply_patch
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

On Linux, `optsidian` and `optsidian-mcp` try to recover the Obsidian GUI launch context at runtime when the current process is missing `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR`. If Obsidian GUI may be closed when tools are called, add a fixed vault path. Without one, vault-dependent tools resolve the current active vault on every call. If no active vault is available, the MCP server still connects and vault-dependent tools return a runtime error telling the client to launch Obsidian GUI or configure a fixed vault path.

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

MCP tool arguments are JSON, so content strings are passed directly without shell expansion. Use the `command_map` MCP tool for routing first when work goes beyond the MCP mutation tools; it returns the Optsidian CLI-only commands, exposed MCP tools, and the current native delegated command list, then points detailed syntax to `optsidian --help` or `optsidian <command> --help`.

## Plugin Installs

Obsidian marketplace plugin installs stay native:

```bash
optsidian plugin:install id=obsidian-git enable
```

Optsidian extends `plugin:install` for custom plugin sources that are not available through the native marketplace command:

```bash
optsidian plugin:install url=https://github.com/user/my-plugin.git ref=main dir=dist/obsidian-plugin vault-path=/path/to/vault enable
optsidian plugin:install url=user/my-plugin vault-path=/path/to/vault
optsidian plugin:install url=github.company.com/user/my-plugin vault-path=/path/to/vault
optsidian plugin:install url=github.company.com/user/private-plugin auth=true vault-path=/path/to/vault
optsidian plugin:install path=../my-plugin/dist/obsidian-plugin vault-path=/path/to/vault enable
```

Custom installs read `manifest.json`, install into `.obsidian/plugins/<manifest.id>`, and can update `community-plugins.json` with `enable`. `url=user/repo` resolves to GitHub.com; scheme-less hosts such as `github.company.com/user/repo` try a GitHub Enterprise-style release lookup before cloning. Release probing and asset downloads do not send GitHub credentials by default; pass `auth=true` only for private releases you trust. With `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH`, this file install path works even when the Obsidian GUI is not running. After install, Optsidian tries a best-effort native refresh when the target vault is the active Obsidian vault. `plugin:reload` itself remains a native passthrough command.

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

Text output is line-numbered (tab-separated, like `cat -n`):

```text
path: README.md
lines: 1-3/120
truncated: false

1	# optsidian
2	
3	`optsidian` is an LLM-optimized wrapper...
```

## Extended Commands

### `search`

Rank notes by title, tags, aliases, headings, path, and body.

```bash
optsidian search "alpha rollout"
optsidian search "alpha rollout" limit=10
optsidian search "alpha rollout" path=Projects
optsidian search review field=body
optsidian search rollout tag=project path=Projects
optsidian search tag=project,alpha
optsidian search "#project alpha" format=json
```

Search returns only note path, title, tags, and body-focused snippets. Frontmatter is indexed for ranking, but it is not shown as snippet evidence. `query=` is still accepted as a compatibility form. `field=` is only valid when a query is present. Search indexes analyzer tokens; the default analyzer uses `Intl.Segmenter` plus Latin-only diacritic folding and ASCII stemming for a zero-config multilingual baseline.

The search daemon stores immutable positional snapshots outside the vault under the OS cache directory. The cache path is `$XDG_CACHE_HOME/optsidian/<vault-realpath-hash>/` or `~/.cache/optsidian/<vault-realpath-hash>/`; active snapshots live under the daemon snapshot store with a durable active pointer. Each snapshot contains canonical field text, analyzer token channels, positional postings, term statistics, metadata features, and line snippet data. CLI and MCP searches are daemon RPC calls only: if the daemon cannot start or become ready, search fails clearly instead of falling back to in-process indexing. `index status` reports daemon readiness, request metrics, and loaded vault snapshot states; `index rebuild`, `index warm`, and `index clear` are daemon RPC mutations. `OPTSIDIAN_SEARCH_EXTRA_LANGS=ko` or `search.extraLangs=ko` enables Kiwi Korean analysis in daemon worker pools; the Kiwi model is downloaded lazily into `$XDG_CACHE_HOME/optsidian/kiwi/`. Korean 2/3-gram indexing is not part of the default search path and can be enabled for manual comparison with `OPTSIDIAN_SEARCH_NGRAM=true` or `search.ngram=true`. Tune worker pools and cache pressure with `search.queryWorkers`, `search.indexWorkers`, `search.snapshotRetentionCount`, `search.queryCacheSize`, `search.memoryBudgetCount`, `search.memoryBudgetBytes`, and `search.daemonIdleMs` or their matching `OPTSIDIAN_SEARCH_*` environment variables.

Global settings are written to `$XDG_CONFIG_HOME/optsidian/settings.json`, or `~/.config/optsidian/settings.json` when `XDG_CONFIG_HOME` is unset. A project-local `.optsidian/settings.json` is read as an override when present, but the `config` command does not create or edit it. Environment variables still override file settings:

```bash
optsidian config set search.analyzer=intl
optsidian config set search.extraLangs=ko
optsidian config set search.ngram=false
optsidian config set search.queryWorkers=2
optsidian config set search.indexWorkers=2
optsidian config set search.snapshotRetentionCount=8
optsidian config set search.queryCacheSize=512
optsidian config set search.memoryBudgetCount=8
optsidian config set search.memoryBudgetBytes=268435456
optsidian config set search.daemonIdleMs=300000
optsidian config get search.extraLangs
```

```bash
optsidian index status
optsidian index rebuild
optsidian index warm
optsidian index clear
```

`index warm` loads or refreshes daemon snapshots for discovered vaults. It reads Obsidian's vault registry from `OBSIDIAN_CONFIG` when set, otherwise from the standard Obsidian config locations such as `$XDG_CONFIG_HOME/obsidian/obsidian.json`, `~/.config/obsidian/obsidian.json`, Flatpak's Obsidian config path, macOS Application Support, or `%APPDATA%\obsidian\obsidian.json`. `vault-path=<path>` limits warmup to one vault.

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

`src/core/*` is the shell-independent command layer. It accepts raw strings and returns structured results, so MCP tools can call it directly without command-line quoting or stdout parsing. `src/cli/*` is only the CLI adapter: argument parsing, native Obsidian delegation, vault discovery, and text/json rendering. `src/daemon/*` is the L3 search-daemon peer that owns RPC transport, snapshot serving, worker pools, and vault search state. `src/cli/commands/plugin.ts` implements the custom-source `plugin:install` extension. `src/mcp/*` is the stdio MCP adapter.

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
