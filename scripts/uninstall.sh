#!/usr/bin/env bash
# Uninstall Optsidian:
#   - remove the optsidian MCP registration from Codex and Claude Code
#   - remove optsidian / optsidian-mcp from the managed install location
#   - remove managed install metadata and cached release assets

set -euo pipefail

MCP_NAME="optsidian"
BIN_DIR="${OPTSIDIAN_BIN_DIR:-${HOME}/.local/bin}"
STATE_BASE="${OPTSIDIAN_STATE_BASE:-${XDG_CACHE_HOME:-${HOME}/.cache}/optsidian}"
MANIFEST_PATH="${STATE_BASE}/install.json"

usage() {
  cat <<'EOF'
Usage: uninstall.sh

Removes Optsidian commands, managed install metadata, and MCP client registrations.
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

OPT_PATH="${BIN_DIR}/optsidian"
MCP_PATH="${BIN_DIR}/optsidian-mcp"
if [ -f "${MANIFEST_PATH}" ] && command -v node >/dev/null; then
  eval "$(
    node - "${MANIFEST_PATH}" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const values = {
  OPT_PATH: typeof payload.optsidianPath === "string" ? payload.optsidianPath : "",
  MCP_PATH: typeof payload.optsidianMcpPath === "string" ? payload.optsidianMcpPath : ""
};
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${shellQuote(value)}\n`);
}
NODE
  )" || true
elif [ -f "${MANIFEST_PATH}" ]; then
  echo "WARN: node not found; falling back to ${BIN_DIR} for binary removal"
fi

echo "==> Removing Optsidian commands"
rm -f "${OPT_PATH}" "${MCP_PATH}"
if [ "${OPT_PATH}" != "${BIN_DIR}/optsidian" ] || [ "${MCP_PATH}" != "${BIN_DIR}/optsidian-mcp" ]; then
  rm -f "${BIN_DIR}/optsidian" "${BIN_DIR}/optsidian-mcp"
fi

echo "==> Removing managed install state"
rm -f "${MANIFEST_PATH}"
rm -rf "${STATE_BASE}/releases"

echo "Uninstalled."
