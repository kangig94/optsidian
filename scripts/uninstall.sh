#!/usr/bin/env bash
# Uninstall Optsidian:
#   - remove the optsidian MCP registration from Codex and Claude Code
#   - remove ~/.local/bin/optsidian and ~/.local/bin/optsidian-mcp

set -euo pipefail

MCP_NAME="optsidian"
BIN_DIR="${HOME}/.local/bin"

usage() {
  cat <<'EOF'
Usage: uninstall.sh

Removes Optsidian commands and MCP client registrations.
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
    echo "ERROR: uninstall.sh does not accept arguments."
    usage
    exit 1
    ;;
esac

if command -v claude >/dev/null; then
  echo "==> Removing '${MCP_NAME}' from Claude Code"
  claude mcp remove "${MCP_NAME}" -s user 2>/dev/null || true
fi

if command -v codex >/dev/null; then
  echo "==> Removing '${MCP_NAME}' from Codex"
  codex mcp remove "${MCP_NAME}" 2>/dev/null || true
fi

echo "==> Removing Optsidian commands"
rm -f "${BIN_DIR}/optsidian" "${BIN_DIR}/optsidian-mcp"

echo "Uninstalled."
