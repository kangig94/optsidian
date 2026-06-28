#!/usr/bin/env bash
# Install Optsidian from the latest published GitHub release:
#   - download the latest stable release assets
#   - verify downloaded file checksums
#   - verify GitHub release attestations for supported releases
#   - install optsidian / optsidian-mcp into ~/.local/bin
#   - write managed install metadata into ~/.cache/optsidian/install.json
#   - register the optsidian MCP server with any detected Codex/Claude client

set -euo pipefail
umask 077

RELEASE_API_BASE="${OPTSIDIAN_RELEASE_API_BASE:-https://api.github.com/repos/kangig94/optsidian/releases}"
RELEASE_REPOSITORY="kangig94/optsidian"
RELEASE_SIGNER_WORKFLOW="kangig94/optsidian/.github/workflows/release.yml"
# v0.3.x is the one-release bridge that lets v0.2.x installs update forward.
# TODO(v0.4.0): remove checksum/best-effort modes and require attestations only.
FIRST_ATTESTED_RELEASE="v0.3.0"
MIN_SUPPORTED_INSTALL_TAG="v0.3.0"
RELEASE_VERIFY="${OPTSIDIAN_RELEASE_VERIFY:-required}"
HTTP_RESPONSE_MAX_BYTES=$((50 * 1024 * 1024))
MCP_NAME="optsidian"
BIN_DIR="${OPTSIDIAN_BIN_DIR:-${HOME}/.local/bin}"
STATE_BASE="${OPTSIDIAN_STATE_BASE:-${XDG_CACHE_HOME:-${HOME}/.cache}/optsidian}"
RELEASE_DIR="${STATE_BASE}/releases"
MANIFEST_PATH="${STATE_BASE}/install.json"
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: install.sh

Installs the latest stable Optsidian GitHub release on Linux or macOS.

Optional environment:
  OPTSIDIAN_VAULT_PATH=/absolute/path/to/vault
    Fallback vault root used when native Obsidian CLI cannot resolve a vault.
  OPTSIDIAN_RELEASE_VERIFY=required|best-effort|checksum
    Release attestation verification mode. Default: required.
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

assert_download_size() {
  local file="$1"
  local label="$2"
  local bytes
  bytes="$(wc -c < "${file}")"
  bytes="${bytes//[[:space:]]/}"
  if [ "${bytes}" -gt "${HTTP_RESPONSE_MAX_BYTES}" ]; then
    echo "ERROR: ${label} exceeded 50MB download limit (${bytes} bytes)."
    exit 1
  fi
}

private_path_hint() {
  echo "This often happens when optsidian was previously run with sudo or the path is owned by another user."
  echo "Fix the ownership/permissions or remove the path, then retry."
}

ensure_private_dir() {
  local dir="$1"
  local label="$2"
  if ! mkdir -p "${dir}"; then
    echo "ERROR: cannot create ${label}: ${dir}"
    private_path_hint
    exit 1
  fi
  if [ ! -d "${dir}" ]; then
    echo "ERROR: ${label} is not a directory: ${dir}"
    exit 1
  fi
  if [ ! -O "${dir}" ]; then
    echo "ERROR: ${label} is not owned by the current user: ${dir}"
    private_path_hint
    exit 1
  fi
  if ! chmod 0700 "${dir}"; then
    echo "ERROR: cannot set ${label} to 0700: ${dir}"
    private_path_hint
    exit 1
  fi
}

ensure_private_file_target() {
  local file="$1"
  local label="$2"
  if [ ! -e "${file}" ]; then
    return
  fi
  if [ ! -f "${file}" ]; then
    echo "ERROR: ${label} is not a file: ${file}"
    exit 1
  fi
  if [ ! -O "${file}" ]; then
    echo "ERROR: ${label} is not owned by the current user: ${file}"
    private_path_hint
    exit 1
  fi
}

ensure_private_file() {
  local file="$1"
  local label="$2"
  ensure_private_file_target "${file}" "${label}"
  if ! chmod 0600 "${file}"; then
    echo "ERROR: cannot set ${label} to 0600: ${file}"
    private_path_hint
    exit 1
  fi
}

case "$(uname -s)" in
  Linux|Darwin)
    ;;
  *)
    echo "ERROR: install.sh currently supports Linux and macOS only."
    exit 1
    ;;
esac

echo "==> Checking prerequisites"
command -v curl >/dev/null || { echo "ERROR: curl is required"; exit 1; }
command -v node >/dev/null || { echo "ERROR: node is required"; exit 1; }
command -v wc >/dev/null || { echo "ERROR: wc is required"; exit 1; }
NODE_VERSION="$(node --version 2>/dev/null || true)"
case "${NODE_VERSION}" in
  v[0-9]*)
    ;;
  *)
    echo "ERROR: failed to determine the installed Node.js version"
    exit 1
    ;;
esac
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "ERROR: Node.js 20 or newer is required (found ${NODE_VERSION})"
  exit 1
fi

if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ]; then
  if [ ! -d "${OPTSIDIAN_VAULT_PATH}" ]; then
    echo "ERROR: OPTSIDIAN_VAULT_PATH is not a directory: ${OPTSIDIAN_VAULT_PATH}"
    exit 1
  fi
  OPTSIDIAN_VAULT_PATH="$(cd "${OPTSIDIAN_VAULT_PATH}" && pwd)"
fi

HAS_CLAUDE=0
HAS_CODEX=0
command -v claude >/dev/null && HAS_CLAUDE=1
command -v codex >/dev/null && HAS_CODEX=1
[ "${HAS_CLAUDE}" = "1" ] && echo "  - claude detected: $(claude --version 2>/dev/null | head -1)"
[ "${HAS_CODEX}" = "1" ] && echo "  - codex  detected: $(codex --version 2>/dev/null | head -1)"

case "${RELEASE_VERIFY}" in
  required|best-effort|checksum)
    ;;
  *)
    echo "ERROR: OPTSIDIAN_RELEASE_VERIFY must be one of: required, best-effort, checksum."
    exit 1
    ;;
esac

CURL_ARGS=(--max-filesize "${HTTP_RESPONSE_MAX_BYTES}")
CURL_HEADERS=(-H "Accept: application/vnd.github+json" -H "User-Agent: optsidian-install")

WORK_DIR="$(mktemp -d)"
RELEASE_JSON="${WORK_DIR}/release.json"
mkdir -p "${BIN_DIR}"
ensure_private_dir "${STATE_BASE}" "Optsidian state directory"
ensure_private_dir "${RELEASE_DIR}" "Optsidian release cache directory"

echo "==> Resolving latest stable release"
curl -fsSL "${CURL_ARGS[@]}" "${CURL_HEADERS[@]}" "${RELEASE_API_BASE}/latest" > "${RELEASE_JSON}"
assert_download_size "${RELEASE_JSON}" "release metadata"

eval "$(
  node - "${RELEASE_JSON}" "${MIN_SUPPORTED_INSTALL_TAG}" "${FIRST_ATTESTED_RELEASE}" "${RELEASE_VERIFY}" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const minSupportedTag = process.argv[3];
const firstAttestedTag = process.argv[4];
const releaseVerify = process.argv[5];
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const tag = String(payload.tag_name || "");
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Invalid release tag: ${tag}`);
}
if (payload.draft) {
  throw new Error(`Release ${tag} is still a draft`);
}
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
if (compareVersion(tag, minSupportedTag) < 0) {
  throw new Error(`Optsidian releases before ${minSupportedTag} are no longer supported by this installer.`);
}
const assetNames = {
  optsidian: `optsidian-${tag}`,
  optsidianMcp: `optsidian-mcp-${tag}`,
  checksums: `checksums-${tag}.txt`,
  attestation: `attestation-${tag}.json`
};
const assets = Array.isArray(payload.assets) ? payload.assets : [];
const optsidianAsset = assets.find((entry) => entry && entry.name === assetNames.optsidian);
const optsidianMcpAsset = assets.find((entry) => entry && entry.name === assetNames.optsidianMcp);
const checksumsAsset = assets.find((entry) => entry && entry.name === assetNames.checksums);
const attestationAsset = assets.find((entry) => entry && entry.name === assetNames.attestation);
if (!optsidianAsset || typeof optsidianAsset.browser_download_url !== "string") {
  throw new Error(`Release ${tag} does not contain asset ${assetNames.optsidian}`);
}
if (!optsidianMcpAsset || typeof optsidianMcpAsset.browser_download_url !== "string") {
  throw new Error(`Release ${tag} does not contain asset ${assetNames.optsidianMcp}`);
}
if (!checksumsAsset || typeof checksumsAsset.browser_download_url !== "string") {
  throw new Error(`Release ${tag} does not contain asset ${assetNames.checksums}`);
}
if (
  releaseVerify === "required" &&
  compareVersion(tag, firstAttestedTag) >= 0 &&
  (!attestationAsset || typeof attestationAsset.browser_download_url !== "string")
) {
  throw new Error(`Release ${tag} does not contain asset ${assetNames.attestation}`);
}
const values = {
  RELEASE_TAG: tag,
  RELEASE_VERSION: tag.slice(1),
  OPTSIDIAN_ASSET_NAME: assetNames.optsidian,
  OPTSIDIAN_ASSET_URL: optsidianAsset.browser_download_url,
  OPTSIDIAN_MCP_ASSET_NAME: assetNames.optsidianMcp,
  OPTSIDIAN_MCP_ASSET_URL: optsidianMcpAsset.browser_download_url,
  CHECKSUMS_ASSET_NAME: assetNames.checksums,
  CHECKSUMS_ASSET_URL: checksumsAsset.browser_download_url,
  ATTESTATION_ASSET_NAME: assetNames.attestation,
  ATTESTATION_ASSET_URL: attestationAsset && typeof attestationAsset.browser_download_url === "string" ? attestationAsset.browser_download_url : ""
};
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
for (const [key, value] of Object.entries(values)) {
  process.stdout.write(`${key}=${shellQuote(value)}\n`);
}
NODE
)"

RELEASE_CACHE_DIR="${RELEASE_DIR}/${RELEASE_TAG}"
ensure_private_dir "${RELEASE_CACHE_DIR}" "Optsidian release cache directory"
OPTSIDIAN_ASSET_PATH="${RELEASE_CACHE_DIR}/${OPTSIDIAN_ASSET_NAME}"
OPTSIDIAN_MCP_ASSET_PATH="${RELEASE_CACHE_DIR}/${OPTSIDIAN_MCP_ASSET_NAME}"
CHECKSUMS_ASSET_PATH="${RELEASE_CACHE_DIR}/${CHECKSUMS_ASSET_NAME}"
ATTESTATION_ASSET_PATH="${RELEASE_CACHE_DIR}/${ATTESTATION_ASSET_NAME}"

echo "==> Downloading ${CHECKSUMS_ASSET_NAME}"
ensure_private_file_target "${CHECKSUMS_ASSET_PATH}" "${CHECKSUMS_ASSET_NAME}"
curl -fsSL "${CURL_ARGS[@]}" "${CURL_HEADERS[@]}" "${CHECKSUMS_ASSET_URL}" -o "${CHECKSUMS_ASSET_PATH}"
assert_download_size "${CHECKSUMS_ASSET_PATH}" "${CHECKSUMS_ASSET_NAME}"
ensure_private_file "${CHECKSUMS_ASSET_PATH}" "${CHECKSUMS_ASSET_NAME}"
echo "==> Downloading ${OPTSIDIAN_ASSET_NAME}"
ensure_private_file_target "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_ASSET_NAME}"
curl -fsSL "${CURL_ARGS[@]}" "${CURL_HEADERS[@]}" "${OPTSIDIAN_ASSET_URL}" -o "${OPTSIDIAN_ASSET_PATH}"
assert_download_size "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_ASSET_NAME}"
ensure_private_file "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_ASSET_NAME}"
echo "==> Downloading ${OPTSIDIAN_MCP_ASSET_NAME}"
ensure_private_file_target "${OPTSIDIAN_MCP_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_NAME}"
curl -fsSL "${CURL_ARGS[@]}" "${CURL_HEADERS[@]}" "${OPTSIDIAN_MCP_ASSET_URL}" -o "${OPTSIDIAN_MCP_ASSET_PATH}"
assert_download_size "${OPTSIDIAN_MCP_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_NAME}"
ensure_private_file "${OPTSIDIAN_MCP_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_NAME}"

echo "==> Verifying downloaded checksums"
node - "${CHECKSUMS_ASSET_PATH}" "${OPTSIDIAN_ASSET_NAME}" "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_NAME}" "${OPTSIDIAN_MCP_ASSET_PATH}" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const checksumsFile = process.argv[2];
const assets = [
  { name: process.argv[3], filePath: process.argv[4] },
  { name: process.argv[5], filePath: process.argv[6] }
];
const checksums = new Map();
for (const line of fs.readFileSync(checksumsFile, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match) throw new Error("checksums.txt is invalid");
  checksums.set(match[2], match[1]);
}

for (const asset of assets) {
  const expected = checksums.get(asset.name);
  if (!expected) throw new Error(`checksums.txt is missing ${asset.name}`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(asset.filePath)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset.name}`);
}
NODE

SHOULD_VERIFY_ATTESTATION="$(
  node - "${RELEASE_TAG}" "${FIRST_ATTESTED_RELEASE}" "${RELEASE_VERIFY}" <<'NODE'
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
const tag = process.argv[2];
const firstAttested = process.argv[3];
const mode = process.argv[4];
process.stdout.write(mode !== "checksum" && compareVersion(tag, firstAttested) >= 0 ? "1" : "0");
NODE
)"

if [ "${SHOULD_VERIFY_ATTESTATION}" = "1" ]; then
  if [ -z "${ATTESTATION_ASSET_URL}" ]; then
    if [ "${RELEASE_VERIFY}" = "required" ]; then
      echo "ERROR: Release ${RELEASE_TAG} does not contain asset ${ATTESTATION_ASSET_NAME}."
      exit 1
    fi
    echo "WARN: release attestation is missing; continuing because OPTSIDIAN_RELEASE_VERIFY=${RELEASE_VERIFY}"
  elif ! command -v gh >/dev/null; then
    if [ "${RELEASE_VERIFY}" = "required" ]; then
      echo "ERROR: GitHub CLI (gh) is required to verify release attestations for ${RELEASE_TAG}."
      exit 1
    fi
    echo "WARN: gh is not available; continuing because OPTSIDIAN_RELEASE_VERIFY=${RELEASE_VERIFY}"
  else
    echo "==> Downloading ${ATTESTATION_ASSET_NAME}"
    ensure_private_file_target "${ATTESTATION_ASSET_PATH}" "${ATTESTATION_ASSET_NAME}"
    curl -fsSL "${CURL_ARGS[@]}" "${CURL_HEADERS[@]}" "${ATTESTATION_ASSET_URL}" -o "${ATTESTATION_ASSET_PATH}"
    assert_download_size "${ATTESTATION_ASSET_PATH}" "${ATTESTATION_ASSET_NAME}"
    ensure_private_file "${ATTESTATION_ASSET_PATH}" "${ATTESTATION_ASSET_NAME}"
    echo "==> Verifying release attestations"
    GH_CONFIG_DIR="${WORK_DIR}/gh-config"
    mkdir -p "${GH_CONFIG_DIR}"
    chmod 0700 "${GH_CONFIG_DIR}"
    for asset_path in "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_PATH}"; do
      if ! env GH_CONFIG_DIR="${GH_CONFIG_DIR}" GITHUB_TOKEN="" GH_TOKEN="" gh attestation verify "${asset_path}" \
        --repo "${RELEASE_REPOSITORY}" \
        --signer-workflow "${RELEASE_SIGNER_WORKFLOW}" \
        --deny-self-hosted-runners \
        --bundle "${ATTESTATION_ASSET_PATH}"; then
        if [ "${RELEASE_VERIFY}" = "required" ]; then
          echo "ERROR: release attestation verification failed for ${asset_path}"
          exit 1
        fi
        echo "WARN: release attestation verification failed for ${asset_path}; continuing because OPTSIDIAN_RELEASE_VERIFY=${RELEASE_VERIFY}"
      fi
    done
  fi
fi

echo "==> Verifying downloaded asset versions"
node - "${RELEASE_VERSION}" "${OPTSIDIAN_ASSET_NAME}" "${OPTSIDIAN_ASSET_PATH}" "${OPTSIDIAN_MCP_ASSET_NAME}" "${OPTSIDIAN_MCP_ASSET_PATH}" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const expectedVersion = process.argv[2];
const assets = [
  { name: process.argv[3], filePath: process.argv[4] },
  { name: process.argv[5], filePath: process.argv[6] }
];

for (const asset of assets) {
  const probePath = path.join(
    os.tmpdir(),
    `optsidian-install-version-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  try {
    fs.copyFileSync(asset.filePath, probePath);
    fs.chmodSync(probePath, 0o755);
    const result = spawnSync(process.execPath, [probePath, "--version"], { encoding: "utf8" });
    if (result.error) throw new Error(`Failed to execute ${asset.name}: ${result.error.message}`);
    if ((result.status ?? 1) !== 0) {
      throw new Error((result.stderr || result.stdout || `Failed to execute ${asset.name}`).trim());
    }
    const actualVersion = String(result.stdout || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(actualVersion)) {
      throw new Error(`Invalid version output from ${asset.name}: ${actualVersion}`);
    }
    if (actualVersion !== expectedVersion) {
      throw new Error(`${asset.name} version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
    }
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}
NODE

echo "==> Installing commands into ${BIN_DIR}"
install_executable() {
  local source_path="$1"
  local dest_path="$2"
  local tmp_path="${dest_path}.install-$$-${RANDOM}"
  cp "${source_path}" "${tmp_path}"
  chmod 0755 "${tmp_path}"
  mv "${tmp_path}" "${dest_path}"
}
install_executable "${OPTSIDIAN_ASSET_PATH}" "${BIN_DIR}/optsidian"
install_executable "${OPTSIDIAN_MCP_ASSET_PATH}" "${BIN_DIR}/optsidian-mcp"

CLAUDE_REGISTERED=0
if [ "${HAS_CLAUDE}" = "1" ]; then
  echo "==> Registering '${MCP_NAME}' with Claude Code"
  claude mcp remove "${MCP_NAME}" -s user 2>/dev/null || true
  if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ]; then
    if claude mcp add "${MCP_NAME}" -s user \
      -e OPTSIDIAN_VAULT_PATH="${OPTSIDIAN_VAULT_PATH}" \
      -- "${BIN_DIR}/optsidian-mcp"; then
      CLAUDE_REGISTERED=1
    else
      echo "WARN: failed to register '${MCP_NAME}' with Claude Code"
    fi
  else
    if claude mcp add "${MCP_NAME}" -s user -- "${BIN_DIR}/optsidian-mcp"; then
      CLAUDE_REGISTERED=1
    else
      echo "WARN: failed to register '${MCP_NAME}' with Claude Code"
    fi
  fi
fi

CODEX_REGISTERED=0
if [ "${HAS_CODEX}" = "1" ]; then
  echo "==> Registering '${MCP_NAME}' with Codex"
  codex mcp remove "${MCP_NAME}" 2>/dev/null || true
  if [ -n "${OPTSIDIAN_VAULT_PATH:-}" ]; then
    if codex mcp add "${MCP_NAME}" \
      --env OPTSIDIAN_VAULT_PATH="${OPTSIDIAN_VAULT_PATH}" \
      -- "${BIN_DIR}/optsidian-mcp"; then
      CODEX_REGISTERED=1
    else
      echo "WARN: failed to register '${MCP_NAME}' with Codex"
    fi
  else
    if codex mcp add "${MCP_NAME}" -- "${BIN_DIR}/optsidian-mcp"; then
      CODEX_REGISTERED=1
    else
      echo "WARN: failed to register '${MCP_NAME}' with Codex"
    fi
  fi
fi

if [ "${HAS_CLAUDE}" = "0" ] && [ "${HAS_CODEX}" = "0" ]; then
  echo "==> No supported MCP client detected; skipping MCP registration"
fi

export OPTSIDIAN_MANIFEST_PATH="${MANIFEST_PATH}"
export OPTSIDIAN_MANIFEST_VERSION="${RELEASE_VERSION}"
export OPTSIDIAN_MANIFEST_TAG="${RELEASE_TAG}"
export OPTSIDIAN_MANIFEST_BIN_DIR="${BIN_DIR}"
export OPTSIDIAN_MANIFEST_OPT_PATH="${BIN_DIR}/optsidian"
export OPTSIDIAN_MANIFEST_MCP_PATH="${BIN_DIR}/optsidian-mcp"
export OPTSIDIAN_MANIFEST_VAULT_PATH="${OPTSIDIAN_VAULT_PATH:-}"
export OPTSIDIAN_MANIFEST_CODEX_REGISTERED="${CODEX_REGISTERED}"
export OPTSIDIAN_MANIFEST_CLAUDE_REGISTERED="${CLAUDE_REGISTERED}"
ensure_private_file_target "${MANIFEST_PATH}" "Optsidian install manifest"

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const manifest = {
  version: process.env.OPTSIDIAN_MANIFEST_VERSION,
  tag: process.env.OPTSIDIAN_MANIFEST_TAG,
  binDir: process.env.OPTSIDIAN_MANIFEST_BIN_DIR,
  optsidianPath: process.env.OPTSIDIAN_MANIFEST_OPT_PATH,
  optsidianMcpPath: process.env.OPTSIDIAN_MANIFEST_MCP_PATH,
  vaultPath: process.env.OPTSIDIAN_MANIFEST_VAULT_PATH || undefined,
  codexRegistered: process.env.OPTSIDIAN_MANIFEST_CODEX_REGISTERED === "1",
  claudeRegistered: process.env.OPTSIDIAN_MANIFEST_CLAUDE_REGISTERED === "1",
  installedAt: new Date().toISOString()
};

const manifestPath = process.env.OPTSIDIAN_MANIFEST_PATH;
fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
if (fs.existsSync(manifestPath)) {
  const stat = fs.statSync(manifestPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile()) throw new Error(`Optsidian install manifest is not a file: ${manifestPath}`);
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Optsidian install manifest is owned by uid ${stat.uid}, but the current uid is ${uid}. This often happens when optsidian was previously run with sudo.`);
  }
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(manifestPath, 0o600);
NODE
ensure_private_file "${MANIFEST_PATH}" "Optsidian install manifest"

echo
echo "Installed ${RELEASE_TAG}."
echo
echo "Commands:"
echo "  ${BIN_DIR}/optsidian --help"
echo "  ${BIN_DIR}/optsidian-mcp --help"
echo
echo "Next steps:"
[ "${CLAUDE_REGISTERED}" = "1" ] && echo "  - In Claude Code: type /mcp and reconnect '${MCP_NAME}' or restart the session."
[ "${CODEX_REGISTERED}" = "1" ] && echo "  - In Codex TUI: type /mcp to verify '${MCP_NAME}' is active."
echo "  - Make sure ${BIN_DIR} is on PATH."
