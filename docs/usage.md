# Usage Guide

`optsidian` uses the same `key=value` argument style as the Obsidian CLI.

```bash
optsidian <command> key=value flag
```

Values with spaces should be quoted by the shell:

```bash
optsidian read path="Projects/My Note.md" head=20
```

Detailed syntax is always available from the CLI:

```bash
optsidian --help
optsidian <command> --help
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

Command routing in V1:

- CLI-only: `read`, `search`, `grep`, `index`, `config`, `copy`, `mkdir`, `open-gui`, `update`, `frontmatter`, `plugin:install`
- MCP tools: `command_map`, `write`, `edit`, `apply_patch`

Marketplace plugin installs stay native:

```bash
optsidian plugin:install id=obsidian-git enable
```

Optsidian extends `plugin:install` for custom plugin sources:

```bash
optsidian plugin:install url=https://github.com/user/my-plugin.git ref=main dir=dist/obsidian-plugin vault-path=/path/to/vault enable
optsidian plugin:install url=user/my-plugin vault-path=/path/to/vault
optsidian plugin:install url=github.company.com/user/my-plugin vault-path=/path/to/vault
optsidian plugin:install path=../my-plugin/dist/obsidian-plugin vault-path=/path/to/vault enable
```

## Vault Selection

`vault=<name>` is forwarded during native vault resolution.

```bash
optsidian read vault=Work path=README.md head=20
optsidian search vault=Work query=TODO
optsidian grep vault=Work query=TODO
```

For file-only Optsidian commands, `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH=<path>` pins operations to a fixed vault root and does not require native vault resolution:

```bash
optsidian read vault-path=/path/to/vault path=README.md head=20
OPTSIDIAN_VAULT_PATH=/path/to/vault optsidian search query=TODO
```

Do not combine `vault=<name>` and `vault-path=<path>` in the same command. Native passthrough commands reject explicit `vault-path=<path>` and still require the Obsidian GUI/native CLI context.

Native passthrough commands use the vault from the active Obsidian window. When multiple vault windows are open, changing window focus changes the native active vault. Use `open-gui vault-path=<path>` before native/plugin commands when you need to force a specific vault.

Optimized commands resolve paths relative to the selected vault root.

For MCP, vault selection happens when a vault-dependent tool is called. Without a fixed path, each call runs native `obsidian vault info=path` and uses the current active vault.

On Linux, `optsidian` and `optsidian-mcp` try to recover the Obsidian GUI launch context at runtime when the current process is missing the usual GUI session variables. If Obsidian GUI may be closed, provide a fixed vault path. When set, MCP stays pinned to that path and does not follow active vault changes in the GUI. Without a resolved vault, the MCP server still connects and mutation tools return a runtime error telling the client to launch Obsidian GUI or configure a fixed vault path.

```bash
optsidian-mcp --vault-path /path/to/vault
OPTSIDIAN_VAULT_PATH=/path/to/vault optsidian-mcp
```

## Launching Obsidian GUI

Use `open-gui` when you want native/plugin/app commands and Obsidian is not already running:

```bash
optsidian open-gui
optsidian open-gui vault-path=/path/to/vault
optsidian open-gui no-wait
```

By default, `open-gui` waits up to 10 seconds for native vault resolution before returning. When `vault-path=<path>` is provided, readiness requires that path to become the active native vault. Opening or focusing a vault this way can change the active vault seen by later native commands. Use `no-wait` only when you want fire-and-forget launch behavior and will not immediately run native/plugin commands. If your system has no `obsidian://` URI opener, set `OPTSIDIAN_OBSIDIAN_APP_BIN=/path/to/obsidian`.

## Install and Update

Install the latest stable release:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

The installer does not invoke the native `obsidian` CLI. Native vault resolution and any Linux GUI env recovery still happen later when `optsidian` or `optsidian-mcp` actually run.
It requires Node.js 20 or newer plus `curl`.

Check or apply managed updates:

```bash
optsidian update
```

Managed updates require the install manifest created by `install.sh`. The installer and updater currently support Linux and macOS.

## Reading

```bash
optsidian read path=note.md
optsidian read path=note.md head=50
optsidian read path=note.md tail=30
optsidian read path=note.md lines=10:40
optsidian read path=note.md around="needle" context=4
optsidian read path=note.md max-lines=200
optsidian read path=note.md format=json
```

Only one of `lines=`, `head=`, `tail=`, and `around=` may be used at a time.

## Search and Grep

`search` ranks notes. `grep` finds exact line evidence.

```bash
optsidian search query="alpha rollout"
optsidian search query="alpha rollout" limit=10
optsidian search query="alpha rollout" path=Projects
optsidian search query="review" field=body
optsidian search query="rollout" tag=project path=Projects
optsidian search tag=project,alpha
optsidian search query="#project alpha" format=json
```

Search returns only note path, title, tags, and body-focused snippets. Frontmatter participates in ranking but is not returned as snippet evidence. `field=` is only valid when `query=` is present. Search indexes analyzer tokens; the default analyzer uses `Intl.Segmenter` plus Latin-only diacritic folding and ASCII stemming, so CJK text has a useful zero-config baseline without a language-specific model.

The search index is cached outside the vault and rebuilt automatically as needed. The cache path is `$XDG_CACHE_HOME/optsidian/<vault-realpath-hash>/` or `~/.cache/optsidian/<vault-realpath-hash>/`, with `search.orama`, `manifest.json`, and `analysis-cache.json` for the default analyzer. The manifest records schema, Node/ICU, tokenizer tier, and analyzer identity, so changing analyzer settings rebuilds the index. During analyzer tier upgrades, a valid Intl-tier index can be served immediately while a background reconcile rebuilds the target tier. `index status` reports cache readiness plus stale-tier, reconcile-lock, and last reconcile result diagnostics when present:

```bash
optsidian index status
optsidian index rebuild
optsidian index warm
optsidian index clear
```

`index warm` prebuilds search indexes for discovered vaults. It reads Obsidian's vault registry from `OBSIDIAN_CONFIG` when set, otherwise from the standard Obsidian config locations such as `$XDG_CONFIG_HOME/obsidian/obsidian.json`, `~/.config/obsidian/obsidian.json`, Flatpak's Obsidian config path, macOS Application Support, or `%APPDATA%\obsidian\obsidian.json`. `vault-path=<path>` limits warmup to one vault.

Set `OPTSIDIAN_SEARCH_ANALYZER=intl-daemon` to route the same Intl analyzer through Optsidian's analyzer daemon. The daemon exits after 5 minutes idle by default; override with `OPTSIDIAN_ANALYZER_IDLE_MS=<ms>`. Analyzer requests time out after 60 seconds by default; override with `OPTSIDIAN_ANALYZER_REQUEST_TIMEOUT_MS=<ms>`. `OPTSIDIAN_SEARCH_EXTRA_LANGS=ko` is parsed as a future Korean analyzer opt-in, but no dedicated Korean backend ships yet, so Hangul still falls back to the Intl baseline. This is mainly infrastructure for heavier analyzer backends.

Global settings are written to `$XDG_CONFIG_HOME/optsidian/settings.json`, or `~/.config/optsidian/settings.json` when `XDG_CONFIG_HOME` is unset. A project-local `.optsidian/settings.json` is read as an override when present, but the `config` command does not create or edit it. Environment variables still override file settings:

```bash
optsidian config set search.analyzer=intl-daemon
optsidian config set search.extraLangs=ko
optsidian config get search.extraLangs
optsidian config unset search.extraLangs
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

## Frontmatter

`frontmatter` reads and mutates top-level YAML frontmatter keys in Markdown files.

```bash
optsidian frontmatter read path=note.md
optsidian frontmatter read path=note.md format=json
optsidian frontmatter set path=note.md key=status value=active
optsidian frontmatter set path=note.md key=priority value-json=3
optsidian frontmatter set path=note.md key=aliases value-json=@aliases.json
optsidian frontmatter add path=note.md key=tags value=project
optsidian frontmatter remove path=note.md key=tags value=project
optsidian frontmatter delete path=note.md key=status dry-run
```

`value=` is stored as a string. `value-json=` stores JSON-compatible values such as numbers, booleans, arrays, objects, and null. Mutations preserve the Markdown body exactly and reject invalid YAML, duplicate keys, and non-mapping frontmatter roots.

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

## Plugin Installs

`plugin:install id=<plugin-id>` is delegated to native Obsidian unchanged. Use it for marketplace/community plugins:

```bash
optsidian plugin:install id=obsidian-git enable
```

`url=` and `path=` are Optsidian custom-source extensions for plugins that are not available through the native marketplace install command:

```bash
optsidian plugin:install url=git@github.com:user/my-plugin.git ref=main vault-path=/path/to/vault enable
optsidian plugin:install url=user/my-plugin vault-path=/path/to/vault
optsidian plugin:install url=github.com/user/my-plugin vault-path=/path/to/vault
optsidian plugin:install url=github.company.com/user/my-plugin vault-path=/path/to/vault
optsidian plugin:install path=../my-plugin/dist/obsidian-plugin vault-path=/path/to/vault enable
```

Custom installs copy the plugin directory into `.obsidian/plugins/<manifest.id>`. `url=user/repo` resolves to GitHub.com; scheme-less hosts such as `github.company.com/user/repo` resolve to `https://github.company.com/user/repo` and use the GitHub Enterprise-style `/api/v3` releases API before falling back to clone. The source must contain `manifest.json` and `main.js`; use `dir=<subdir>` when a git repository stores the plugin artifact below the repository root. `enable` updates `community-plugins.json`. With `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH`, this file install path works even when the Obsidian GUI is not running. After install, Optsidian tries a best-effort native refresh when the target vault is the active Obsidian vault. `plugin:reload` itself remains a native passthrough command.

## JSON Output

The `read`, `search`, `grep`, `frontmatter`, `config`, and custom-source `plugin:install` commands support `format=json`.

```bash
optsidian read path=note.md lines=1:10 format=json
optsidian search query=TODO format=json
optsidian grep query=TODO format=json
optsidian frontmatter read path=note.md format=json
optsidian config list format=json
optsidian plugin:install path=../my-plugin vault-path=/path/to/vault format=json
```

Native delegated commands keep their original output formats.

## MCP Usage

`optsidian-mcp` exposes a small mutation-oriented tool surface over stdio for MCP clients:

```text
command_map, write, edit, apply_patch
```

MCP calls use JSON arguments, not shell tokens. This means values such as `$HOME`, backticks, `$(...)`, YAML frontmatter, and fenced code blocks are delivered as raw strings.

Call `command_map` first when work goes beyond the MCP mutation tools. It returns the CLI-only split, the available MCP tools, the current native delegated command list, and an explicit preference rule: prefer Optsidian for Obsidian vault work and use Optsidian CLI commands for CLI-only and native passthrough operations. It then points detailed syntax back to:

```text
optsidian --help
optsidian <command> --help
```

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
