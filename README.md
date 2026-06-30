# optsidian

`optsidian` connects LLM tools to your Obsidian vault.

It is not a second Obsidian UI. It is a small CLI and MCP bridge that lets
agents resolve your vault, search notes, read bounded file slices, edit files,
apply patches, and delegate native Obsidian or plugin commands when Obsidian is
already the right tool.

This README is intentionally short. After installation, Codex and Claude can
discover exact command syntax through MCP routing and `optsidian --help`.

## Install

**Requirements:** Node.js 24.15.0+, `curl`, a working `obsidian` CLI on `PATH`,
and Linux or macOS for the managed installer/update flow. GitHub CLI (`gh`) is
required for the default release attestation check; use the explicit checksum
fallback only in constrained environments.

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

The installer downloads public release assets without GitHub credentials,
verifies checksums and GitHub release attestations, installs `optsidian` and
`optsidian-mcp` into `~/.local/bin`, writes managed install metadata under
`~/.cache/optsidian`, and registers detected Codex/Claude clients.

Pin MCP to one vault if you do not want it to follow the active Obsidian GUI
vault:

```bash
export OPTSIDIAN_VAULT_PATH=/path/to/vault
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

Update:

```bash
optsidian update
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/uninstall.sh | bash
```

If release attestation verification is unavailable:

```bash
export OPTSIDIAN_RELEASE_VERIFY=checksum
curl -fsSL https://raw.githubusercontent.com/kangig94/optsidian/main/scripts/install.sh | bash
```

Checksum-only verification exists for migration and constrained environments.
Attestations are preferred, and checksum-only mode is planned to go away in a
future breaking release.

## Try It Now

Restart Codex or Claude after installing, then ask the model to use optsidian:

```text
Search my Obsidian vault for notes about the Q3 plan and summarize the decisions.
```

For a quick local smoke test:

```bash
optsidian --help
optsidian search "project notes"
```

## Vault Selection

By default, optsidian asks the native Obsidian CLI which vault is active. This is
convenient when the GUI is open.

Set a fixed vault when Obsidian may be closed, automation should not depend on
the GUI state, or MCP must always use the same vault:

```bash
export OPTSIDIAN_VAULT_PATH=/path/to/vault
```

For a non-standard Obsidian binary:

```bash
export OPTSIDIAN_OBSIDIAN_BIN=/path/to/obsidian
```

## MCP

`optsidian-mcp` runs a local MCP server over stdio. The installer registers it
for detected Codex/Claude clients automatically.

Manual client config:

```json
{
  "mcpServers": {
    "optsidian": {
      "command": "optsidian-mcp"
    }
  }
}
```

Pinned-vault config:

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

Claude Code stores MCP servers per config directory. If you use multiple Claude
config dirs, register each one:

```bash
CLAUDE_CONFIG_DIR=$HOME/.claude-work claude mcp add optsidian -s user -- ~/.local/bin/optsidian-mcp
```

Add `-e OPTSIDIAN_VAULT_PATH=/path/to/vault` if that config should be pinned to
one vault.

## Search And Cache

Search is served by a local daemon. It stores search indexes outside the vault
under `$XDG_CACHE_HOME/optsidian` or `~/.cache/optsidian`.

The cache is private (`0700` directories, `0600` files), stores the full index
data needed for search quality, and does not persist search query history.
Repeated query analysis is cached only in memory.

Unused search stores can be pruned:

```bash
optsidian index prune --dry-run
optsidian index prune unused-days=30
```

Pruning is based on when a vault cache was last used, not when the vault content
last changed. Read-only vaults that are searched regularly are kept.

Regex grep/edit uses a pinned RE2 wasm runtime. The wasm package is downloaded
on demand without credentials, verified by embedded hashes, and cached under the
optsidian cache root.

## Dense Search GPU Runtime

Dense semantic search uses ONNX Runtime. On Linux, GPU acceleration requires the
CUDA 12.x runtime and cuDNN 9 built for CUDA 12. For example:

```bash
sudo apt install cudnn9-cuda-12
sudo ldconfig
```

cuDNN 9 must be the cu12 build to match `onnxruntime-node`'s CUDA execution
provider. If CUDA or that cuDNN build is missing, optsidian falls back
gracefully to CPU-only dense search. macOS uses the CoreML/Metal execution
provider and does not require cuDNN.

## Native Commands And Plugins

Optsidian delegates native Obsidian commands when Obsidian already handles them
well. It adds LLM-friendly wrappers only where bounded output, structured edits,
ranked search, or vault-constrained file mutation matter.

Marketplace plugin installs stay native. Custom URL/path plugin installs exist
for trusted plugins that are not available through the marketplace, but they
install JavaScript into Obsidian. Treat custom plugin sources as code execution.
Release probing and asset downloads do not send GitHub credentials by default;
private plugin releases require an explicit authenticated install.

## Human CLI Reference

Humans should not need the full command catalog in this README:

```bash
optsidian --help
optsidian <command> --help
```

For agents, the MCP routing tool is the source of truth.

## Troubleshooting

- MCP connects but vault tools fail: open Obsidian GUI or set
  `OPTSIDIAN_VAULT_PATH`.
- A separate Claude config dir does not see optsidian: register that
  `CLAUDE_CONFIG_DIR` explicitly.
- Permission errors under `~/.cache/optsidian`: optsidian may have been run with
  `sudo` before; fix ownership or remove that cache path.
- Attestation verification fails because `gh` is unavailable: install/update can
  use explicit `OPTSIDIAN_RELEASE_VERIFY=checksum`, but attestations are the
  default trust path.

## Development

```bash
npm install
npm run build
npm test
```

## Documentation

- [Usage guide](docs/usage.md)
- [Native-first policy](docs/native-first-policy.md)
- [Development notes](docs/development.md)
