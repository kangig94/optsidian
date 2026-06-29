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
optsidian search vault=Work TODO
optsidian grep vault=Work query=TODO
```

For file-only Optsidian commands, `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH=<path>` pins operations to a fixed vault root and does not require native vault resolution:

```bash
optsidian read vault-path=/path/to/vault path=README.md head=20
OPTSIDIAN_VAULT_PATH=/path/to/vault optsidian search TODO
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
It requires Node.js 24.15.0 or newer plus `curl`. Default install/update verification also requires GitHub CLI (`gh`) for release attestation checks. Official Optsidian release downloads do not send GitHub credentials, and HTTP responses are capped at 50MB. Set `OPTSIDIAN_RELEASE_VERIFY=checksum` only as an explicit checksum-only fallback.

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

Only one of `lines=`, `head=`, `tail=`, and `around=` may be used at a time. `read`, `edit`, and direct-file `grep` reject vault files larger than 25MB; directory `grep` skips files above that per-file cap.

## Search and Grep

`search` ranks notes. `grep` finds exact line evidence.

```bash
optsidian search "alpha rollout"
optsidian search "alpha rollout" limit=10
optsidian search "alpha rollout" path=Projects
optsidian search review field=body
optsidian search rollout tag=project path=Projects
optsidian search tag=project,alpha
optsidian search "#project alpha" format=json
optsidian search "project alpha" format=json debug=true
optsidian search "project alpha" --approximate budget-shards=8
optsidian search "project alpha" mode=approximate budget-work=25000 format=json
```

Search returns only note path, title, tags, and body-focused snippets. Frontmatter participates in ranking but is not returned as snippet evidence; `keywords` / `keyword` frontmatter values are indexed through the alias search surface. `query=` is still accepted as a compatibility form. `field=` is only valid when a query is present. Add `debug=true` with `format=json` to include analyzer tokens, matched token channels, and ranking diagnostics. Search indexes morph analyzer tokens and normalized surface tokens by default. Korean 2/3-gram tokens are not part of the default search path; they are opt-in through `search.ngram=true` or `OPTSIDIAN_SEARCH_NGRAM=true` for manual comparison or targeted Korean tokenization experiments. Surface tokens preserve the compact form and also expand common path/title compounds such as `HumanoidMotionTracking`, `DDPMScheduler`, and `Sim2Real` into searchable parts. Candidate retrieval runs per channel and fuses channel ranks with explicit weights before metadata reranking. The reranker prioritizes exact note identity, phrase matches, metadata coverage, candidate-local term rarity, and term proximity; if strict retrieval finds no candidates, it can run a narrow Latin fuzzy retry for 5+ character alphanumeric terms with edit distance 1. With Kiwi enabled, compact Korean query compounds also reuse the morph split as an identity phrase candidate, so `정책학습` can receive the same phrase ranking signals as `정책 학습`. The default analyzer uses `Intl.Segmenter` plus Latin-only diacritic folding and ASCII stemming, so CJK text has a useful zero-config baseline without a language-specific model.

With `format=json`, the search envelope carries a top-level `snapshotId` alongside `matches`: the 64-hex content-addressed id of the immutable snapshot the request was served from. Results are a pure function of that snapshot, so the id identifies exactly which index produced the matches; with `debug=true` the same id also appears under each match's `debug.snapshotId`.

Search defaults to `mode=exhaustive`, which schedules all matching shard work for the pinned snapshot before ranking the final result. `mode=approximate` or `--approximate` opts into a bounded shard/work prefix with `budget-shards=<n>` and/or `budget-work=<n>`. Approximate results always include a top-level `warnings` array containing `approximate`; text output renders this as `warning: approximate`. `budget-time-ms=<n>` is best-effort and can vary with runtime scheduling, so it also returns the exact warning label `non-reproducible`. Budgets are accepted only in approximate mode; combining `mode=exhaustive` with any `budget-*` flag is an error.

The search daemon stores immutable positional snapshots outside the vault under the OS cache directory. The cache path is `$XDG_CACHE_HOME/optsidian/<vault-realpath-hash>/` or `~/.cache/optsidian/<vault-realpath-hash>/`; active snapshots live under the daemon snapshot store with a durable active pointer. Each snapshot contains canonical field text, analyzer token channels, positional postings, per-field term statistics, metadata features, and line snippet data. Query analysis runs once per request and is cached by analyzer identity, settings hash, fields, and raw query. Candidate retrieval uses positional postings only; phrase, proximity, rarity, and coverage signals come from snapshot-resident postings and feature payloads. CLI and MCP searches are daemon RPC calls only: if the daemon cannot start or become ready, search fails clearly instead of falling back to in-process indexing. `index status` reports daemon readiness, request metrics, and loaded vault snapshot states. `index rebuild`, `index warm`, and `index clear` are daemon RPC mutations.

```bash
optsidian index status
optsidian index rebuild
optsidian index warm
optsidian index clear
```

`index warm` loads or refreshes daemon snapshots for discovered vaults. It reads Obsidian's vault registry from `OBSIDIAN_CONFIG` when set, otherwise from the standard Obsidian config locations such as `$XDG_CONFIG_HOME/obsidian/obsidian.json`, `~/.config/obsidian/obsidian.json`, Flatpak's Obsidian config path, macOS Application Support, or `%APPDATA%\obsidian\obsidian.json`. `vault-path=<path>` limits warmup to one vault.

`OPTSIDIAN_SEARCH_EXTRA_LANGS=ko` or `search.extraLangs=ko` enables Kiwi Korean analysis in daemon worker pools. The Kiwi model is downloaded lazily into `$XDG_CACHE_HOME/optsidian/kiwi/`. `search.analyzer=intl|kiwi` selects the analyzer policy, `search.ngram=true|false` controls the opt-in Korean ngram channel, `search.queryWorkers` and `search.indexWorkers` size the latency and indexing analyzer pools, and request timeouts are controlled at the daemon RPC/request layer. Search query history is not persisted. Repeated query analysis is cached only in daemon memory, capped at 64 entries by default, and can be disabled with `search.queryCacheSize=0` or `OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE=0`.

Global settings are written to `$XDG_CONFIG_HOME/optsidian/settings.json`, or `~/.config/optsidian/settings.json` when `XDG_CONFIG_HOME` is unset. A project-local `.optsidian/settings.json` is read as an override when present, but the `config` command does not create or edit it. Environment variables still override file settings:

```bash
optsidian config set search.analyzer=intl
optsidian config set search.extraLangs=ko
optsidian config set search.ngram=false
optsidian config set search.queryWorkers=2
optsidian config set search.indexWorkers=2
optsidian config set search.snapshotRetentionCount=8
optsidian config set search.queryCacheSize=64
optsidian config set search.memoryBudgetCount=8
optsidian config set search.memoryBudgetBytes=268435456
optsidian config set search.daemonIdleMs=300000
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

Regex mode uses a pinned RE2 wasm runtime cached under `~/.cache/optsidian`. Optsidian downloads the small runtime tarball without credentials on first regex use, verifies embedded hashes, and then loads it from the private cache.

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

Regex selectors use RE2 rather than JavaScript `RegExp`; backreferences and lookaround assertions are rejected. Replacement text is literal, so `$1` stays `$1`.

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
optsidian plugin:install url=github.company.com/user/private-plugin auth=true vault-path=/path/to/vault
optsidian plugin:install path=../my-plugin/dist/obsidian-plugin vault-path=/path/to/vault enable
```

Custom installs copy the plugin directory into `.obsidian/plugins/<manifest.id>`. `url=user/repo` resolves to GitHub.com; scheme-less hosts such as `github.company.com/user/repo` resolve to `https://github.company.com/user/repo` and use the GitHub Enterprise-style `/api/v3` releases API before falling back to clone. Release probing and asset downloads do not send GitHub credentials by default; pass `auth=true` only for private releases you trust. The source must contain `manifest.json` and `main.js`; use `dir=<subdir>` when a git repository stores the plugin artifact below the repository root. `enable` updates `community-plugins.json`. With `vault-path=<path>` or `OPTSIDIAN_VAULT_PATH`, this file install path works even when the Obsidian GUI is not running. After install, Optsidian tries a best-effort native refresh when the target vault is the active Obsidian vault. `plugin:reload` itself remains a native passthrough command.

## JSON Output

The `read`, `search`, `grep`, `frontmatter`, `config`, and custom-source `plugin:install` commands support `format=json`.

```bash
optsidian read path=note.md lines=1:10 format=json
optsidian search TODO format=json debug=true
optsidian grep query=TODO format=json
optsidian frontmatter read path=note.md format=json
optsidian config list format=json
optsidian plugin:install path=../my-plugin vault-path=/path/to/vault format=json
```

Native delegated commands keep their original output formats.

## MCP Usage

`optsidian-mcp` exposes a small CLI-routing and mutation tool surface over stdio for MCP clients:

```text
command_map, command_run, write, edit, apply_patch
```

MCP calls use JSON arguments, not shell tokens. This means values such as `$HOME`, backticks, `$(...)`, YAML frontmatter, and fenced code blocks are delivered as raw strings. `command_run` is the MCP-to-CLI bridge for CLI-only and native-delegated Optsidian commands.

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
