#!/usr/bin/env bash
# Install Optsidian:
#   - clone the repository into a temporary directory
#   - install dependencies and build bundled standalone commands
#   - copy optsidian / optsidian-mcp into ~/.local/bin
#   - register the optsidian MCP server with Codex and Claude Code
#
# Idempotent: re-running rebuilds, overwrites the two commands, and refreshes
# MCP registrations.

set -euo pipefail

REPO_URL="https://github.com/kangig94/optsidian.git"
MCP_NAME="optsidian"
BIN_DIR="${HOME}/.local/bin"
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: install.sh

Installs Optsidian commands and registers the Optsidian MCP server.

Optional environment:
  OPTSIDIAN_VAULT_PATH=/absolute/path/to/vault
    Fallback vault root used when native Obsidian CLI cannot resolve a vault.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "ERROR: install.sh does not accept arguments."
    usage
    exit 1
    ;;
esac

cleanup() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

echo "==> Checking prerequisites"
command -v git >/dev/null || { echo "ERROR: git is required"; exit 1; }
command -v node >/dev/null || { echo "ERROR: node is required"; exit 1; }
command -v npm >/dev/null || { echo "ERROR: npm is required"; exit 1; }

HAS_CLAUDE=0
HAS_CODEX=0
command -v claude >/dev/null && HAS_CLAUDE=1
command -v codex >/dev/null && HAS_CODEX=1

if [ "${HAS_CLAUDE}" = "0" ] && [ "${HAS_CODEX}" = "0" ]; then
  echo "ERROR: neither 'claude' nor 'codex' CLI is installed."
  echo "       Install at least one MCP-aware client, then re-run this script."
  exit 1
fi

if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ] && [ ! -d "${OPTSIDIAN_VAULT_PATH}" ]; then
  echo "ERROR: OPTSIDIAN_VAULT_PATH is not a directory: ${OPTSIDIAN_VAULT_PATH}"
  exit 1
fi

[ "${HAS_CLAUDE}" = "1" ] && echo "  - claude detected: $(claude --version 2>/dev/null | head -1)"
[ "${HAS_CODEX}" = "1" ] && echo "  - codex  detected: $(codex --version 2>/dev/null | head -1)"

WORK_DIR="$(mktemp -d)"

echo "==> Cloning ${REPO_URL}"
git clone --depth 1 "${REPO_URL}" "${WORK_DIR}/optsidian"
cd "${WORK_DIR}/optsidian"

echo "==> Installing dependencies"
npm install

echo "==> Building bundled commands"
npm run build

if [ ! -x "dist/optsidian" ] || [ ! -x "dist/optsidian-mcp" ]; then
  echo "ERROR: bundled outputs missing after build"
  exit 1
fi

echo "==> Installing commands into ${BIN_DIR}"
mkdir -p "${BIN_DIR}"
install -m 0755 dist/optsidian "${BIN_DIR}/optsidian"
install -m 0755 dist/optsidian-mcp "${BIN_DIR}/optsidian-mcp"

if ! command -v obsidian >/dev/null; then
  echo "WARN: obsidian CLI not found on PATH."
  echo "      Set OPTSIDIAN_VAULT_PATH when installing if native vault lookup is unavailable."
elif obsidian vault info=path >/dev/null 2>&1; then
  echo "==> Native Obsidian vault resolution works"
else
  echo "WARN: native Obsidian vault resolution failed. Obsidian GUI may be closed."
  if [ -z "${OPTSIDIAN_VAULT_PATH:-}" ]; then
    echo "      Set OPTSIDIAN_VAULT_PATH when installing to configure fallback vault access."
  fi
fi

if [ "${HAS_CLAUDE}" = "1" ]; then
  echo "==> Registering '${MCP_NAME}' with Claude Code"
  claude mcp remove "${MCP_NAME}" -s user 2>/dev/null || true
  if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ]; then
    claude mcp add "${MCP_NAME}" -s user \
      -e OPTSIDIAN_VAULT_PATH="${OPTSIDIAN_VAULT_PATH}" \
      -- "${BIN_DIR}/optsidian-mcp"
  else
    claude mcp add "${MCP_NAME}" -s user -- "${BIN_DIR}/optsidian-mcp"
  fi
fi

if [ "${HAS_CODEX}" = "1" ]; then
  echo "==> Registering '${MCP_NAME}' with Codex"
  codex mcp remove "${MCP_NAME}" 2>/dev/null || true
  if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ]; then
    codex mcp add "${MCP_NAME}" \
      --env OPTSIDIAN_VAULT_PATH="${OPTSIDIAN_VAULT_PATH}" \
      -- "${BIN_DIR}/optsidian-mcp"
  else
    codex mcp add "${MCP_NAME}" -- "${BIN_DIR}/optsidian-mcp"
  fi
fi

echo
echo "Installed."
echo
echo "Commands:"
echo "  ${BIN_DIR}/optsidian --help"
echo "  ${BIN_DIR}/optsidian-mcp --help"
echo
echo "Next steps:"
[ "${HAS_CLAUDE}" = "1" ] && echo "  - In Claude Code: type /mcp and reconnect '${MCP_NAME}' or restart the session."
[ "${HAS_CODEX}" = "1" ] && echo "  - In Codex TUI: type /mcp to verify '${MCP_NAME}' is active."
echo "  - Make sure ${BIN_DIR} is on PATH."
