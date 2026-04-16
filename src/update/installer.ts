import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { RuntimeError, UsageError } from "../errors.js";
import { OPTSIDIAN_VERSION } from "../version.js";

const DEFAULT_RELEASE_API_BASE = "https://api.github.com/repos/kangig94/optsidian/releases";
const MCP_NAME = "optsidian";

export type InstallManifest = {
  version: string;
  tag: string;
  binDir: string;
  optsidianPath: string;
  optsidianMcpPath: string;
  vaultPath?: string;
  codexRegistered: boolean;
  claudeRegistered: boolean;
  installedAt: string;
};

export type UpdateCheckResult = {
  ok: true;
  command: "update";
  action: "check";
  currentVersion: string;
  targetTag: string;
  targetVersion: string;
  managedInstall: boolean;
  needsUpdate: boolean;
  repairNeeded: boolean;
  installPath?: string;
  guidance?: string;
};

export type UpdateInstallResult = {
  ok: true;
  command: "update";
  action: "install";
  status: "current" | "updated" | "repaired";
  previousVersion: string;
  targetTag: string;
  installedVersion: string;
  binDir: string;
  codexRegistered: boolean;
  claudeRegistered: boolean;
  warnings: string[];
};

type ReleaseInfo = {
  tag: string;
  version: string;
  optsidianAssetName: string;
  optsidianDownloadUrl: string;
  optsidianMcpAssetName: string;
  optsidianMcpDownloadUrl: string;
  checksumsAssetName: string;
  checksumsDownloadUrl: string;
};

type RegistrationResult = {
  codexPresent: boolean;
  codexRegistered: boolean;
  claudePresent: boolean;
  claudeRegistered: boolean;
  warnings: string[];
};

export function stateBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPTSIDIAN_STATE_BASE) {
    return path.resolve(env.OPTSIDIAN_STATE_BASE);
  }
  const cacheRoot = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "optsidian");
}

export function manifestFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateBaseDir(env), "install.json");
}

export function releasesCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateBaseDir(env), "releases");
}

export function defaultBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPTSIDIAN_BIN_DIR) {
    return path.resolve(env.OPTSIDIAN_BIN_DIR);
  }
  return path.join(os.homedir(), ".local", "bin");
}

export function normalizeTag(input: string): string {
  const trimmed = input.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new UsageError(`version must use vX.Y.Z or X.Y.Z; received: ${input}`);
  }
  return tag;
}

export function versionFromTag(tag: string): string {
  return normalizeTag(tag).slice(1);
}

export function assetNameForTag(tag: string): string {
  return `optsidian-${normalizeTag(tag)}`;
}

export function mcpAssetNameForTag(tag: string): string {
  return `optsidian-mcp-${normalizeTag(tag)}`;
}

export function checksumsAssetNameForTag(tag: string): string {
  return `checksums-${normalizeTag(tag)}.txt`;
}

export function releaseApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPTSIDIAN_RELEASE_API_BASE || DEFAULT_RELEASE_API_BASE).replace(/\/+$/, "");
}

export function loadInstallManifest(env: NodeJS.ProcessEnv = process.env): InstallManifest | undefined {
  const file = manifestFilePath(env);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InstallManifest>;
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.binDir !== "string" ||
    typeof parsed.optsidianPath !== "string" ||
    typeof parsed.optsidianMcpPath !== "string" ||
    typeof parsed.codexRegistered !== "boolean" ||
    typeof parsed.claudeRegistered !== "boolean" ||
    typeof parsed.installedAt !== "string"
  ) {
    throw new RuntimeError(`Install manifest is invalid: ${file}`);
  }
  if (parsed.vaultPath !== undefined && typeof parsed.vaultPath !== "string") {
    throw new RuntimeError(`Install manifest is invalid: ${file}`);
  }
  return {
    version: parsed.version,
    tag: parsed.tag,
    binDir: parsed.binDir,
    optsidianPath: parsed.optsidianPath,
    optsidianMcpPath: parsed.optsidianMcpPath,
    vaultPath: parsed.vaultPath,
    codexRegistered: parsed.codexRegistered,
    claudeRegistered: parsed.claudeRegistered,
    installedAt: parsed.installedAt
  };
}

export function saveInstallManifest(manifest: InstallManifest, env: NodeJS.ProcessEnv = process.env): void {
  const file = manifestFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function checkForUpdate(options: { tag?: string; env?: NodeJS.ProcessEnv } = {}): Promise<UpdateCheckResult> {
  assertSupportedPlatform();
  const env = options.env ?? process.env;
  const target = await fetchReleaseInfo({ tag: options.tag, env });
  const manifest = loadInstallManifest(env);
  const health = manifest ? inspectManagedInstall(manifest) : undefined;
  const currentVersion = manifest?.version ?? OPTSIDIAN_VERSION;
  const comparison = compareVersions(currentVersion, target.version);
  const repairReasons = manifest && health && !health.healthy ? [...health.reasons] : [];
  if (manifest && comparison === 0 && health?.healthy) {
    const remoteChecksums = await fetchReleaseChecksums(target, env);
    repairReasons.push(...compareInstalledChecksums(manifest, target, remoteChecksums));
  }
  const repairNeeded = repairReasons.length > 0;
  return {
    ok: true,
    command: "update",
    action: "check",
    currentVersion,
    targetTag: target.tag,
    targetVersion: target.version,
    managedInstall: Boolean(manifest),
    needsUpdate: options.tag ? comparison !== 0 || repairNeeded : comparison < 0 || repairNeeded,
    repairNeeded,
    installPath: manifest?.binDir,
    guidance: !manifest
      ? "Managed install metadata not found. Re-run scripts/install.sh to adopt managed updates."
      : repairNeeded
        ? `Managed install needs repair: ${repairReasons.join("; ")}`
        : undefined
  };
}

export async function installRelease(options: { tag?: string; env?: NodeJS.ProcessEnv } = {}): Promise<UpdateInstallResult> {
  assertSupportedPlatform();
  const env = options.env ?? process.env;
  const manifest = loadInstallManifest(env);
  if (!manifest) {
    throw new RuntimeError("Managed install metadata not found. Re-run scripts/install.sh to adopt managed updates.");
  }

  const target = await fetchReleaseInfo({ tag: options.tag, env });
  const health = inspectManagedInstall(manifest);
  const sameVersion = compareVersions(manifest.version, target.version) === 0;
  const repairReasons = health.healthy ? compareInstalledChecksums(manifest, target, await fetchReleaseChecksums(target, env)) : [...health.reasons];
  if (sameVersion && health.healthy && repairReasons.length === 0) {
    return {
      ok: true,
      command: "update",
      action: "install",
      status: "current",
      previousVersion: manifest.version,
      targetTag: target.tag,
      installedVersion: manifest.version,
      binDir: manifest.binDir,
      codexRegistered: manifest.codexRegistered,
      claudeRegistered: manifest.claudeRegistered,
      warnings: []
    };
  }

  fs.mkdirSync(releasesCacheDir(env), { recursive: true });
  const releaseDir = path.join(releasesCacheDir(env), target.tag);
  fs.mkdirSync(releaseDir, { recursive: true });
  const optsidianAssetPath = path.join(releaseDir, target.optsidianAssetName);
  const optsidianMcpAssetPath = path.join(releaseDir, target.optsidianMcpAssetName);
  const checksumsPath = path.join(releaseDir, target.checksumsAssetName);

  await downloadFile(target.checksumsDownloadUrl, checksumsPath, env);
  await downloadFile(target.optsidianDownloadUrl, optsidianAssetPath, env);
  await downloadFile(target.optsidianMcpDownloadUrl, optsidianMcpAssetPath, env);
  verifyDownloadedAssets(checksumsPath, [
    { name: target.optsidianAssetName, filePath: optsidianAssetPath },
    { name: target.optsidianMcpAssetName, filePath: optsidianMcpAssetPath }
  ]);
  verifyExecutableVersion(optsidianAssetPath, target.version, target.optsidianAssetName);
  verifyExecutableVersion(optsidianMcpAssetPath, target.version, target.optsidianMcpAssetName);

  installExecutable(optsidianAssetPath, manifest.optsidianPath);
  installExecutable(optsidianMcpAssetPath, manifest.optsidianMcpPath);

  const vaultPath = resolveManagedVaultPath(manifest, env);
  const registration = refreshMcpRegistration({
    mcpPath: manifest.optsidianMcpPath,
    vaultPath,
    env
  });

  saveInstallManifest(
    {
      version: target.version,
      tag: target.tag,
      binDir: manifest.binDir,
      optsidianPath: manifest.optsidianPath,
      optsidianMcpPath: manifest.optsidianMcpPath,
      vaultPath,
      codexRegistered: registration.codexRegistered,
      claudeRegistered: registration.claudeRegistered,
      installedAt: new Date().toISOString()
    },
    env
  );

  return {
    ok: true,
    command: "update",
    action: "install",
    status: sameVersion ? "repaired" : "updated",
    previousVersion: manifest.version,
    targetTag: target.tag,
    installedVersion: target.version,
    binDir: manifest.binDir,
    codexRegistered: registration.codexRegistered,
    claudeRegistered: registration.claudeRegistered,
    warnings: registration.warnings
  };
}

function assertSupportedPlatform(): void {
  if (process.platform === "linux" || process.platform === "darwin") {
    return;
  }
  throw new RuntimeError("optsidian update/install currently supports Linux and macOS only.");
}

async function fetchReleaseInfo(options: { tag?: string; env?: NodeJS.ProcessEnv }): Promise<ReleaseInfo> {
  const env = options.env ?? process.env;
  const requestedTag = options.tag ? normalizeTag(options.tag) : undefined;
  const endpoint = requestedTag ? `${releaseApiBase(env)}/tags/${encodeURIComponent(requestedTag)}` : `${releaseApiBase(env)}/latest`;
  const payload = await fetchJson(endpoint, env);
  return parseReleaseInfo(payload, requestedTag);
}

async function fetchJson(url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const response = await requestBuffer(url, env);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new RuntimeError("Release metadata payload is invalid");
  }
}

function parseReleaseInfo(payload: unknown, requestedTag: string | undefined): ReleaseInfo {
  if (!payload || typeof payload !== "object") {
    throw new RuntimeError("Release metadata payload is invalid");
  }
  const json = payload as Record<string, unknown>;
  const tag = normalizeTag(String(json.tag_name ?? ""));
  if (requestedTag && tag !== requestedTag) {
    throw new RuntimeError(`Requested ${requestedTag} but release metadata returned ${tag}`);
  }
  if (json.draft === true) {
    throw new RuntimeError(`Release ${tag} is still a draft`);
  }
  const optsidianAssetName = assetNameForTag(tag);
  const optsidianMcpAssetName = mcpAssetNameForTag(tag);
  const checksumsAssetName = checksumsAssetNameForTag(tag);
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const optsidianAsset = assets.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>).name === optsidianAssetName;
  }) as Record<string, unknown> | undefined;
  const optsidianMcpAsset = assets.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>).name === optsidianMcpAssetName;
  }) as Record<string, unknown> | undefined;
  const checksumsAsset = assets.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as Record<string, unknown>).name === checksumsAssetName;
  }) as Record<string, unknown> | undefined;
  if (!optsidianAsset || typeof optsidianAsset.browser_download_url !== "string") {
    throw new RuntimeError(`Release ${tag} does not contain asset ${optsidianAssetName}`);
  }
  if (!optsidianMcpAsset || typeof optsidianMcpAsset.browser_download_url !== "string") {
    throw new RuntimeError(`Release ${tag} does not contain asset ${optsidianMcpAssetName}`);
  }
  if (!checksumsAsset || typeof checksumsAsset.browser_download_url !== "string") {
    throw new RuntimeError(`Release ${tag} does not contain asset ${checksumsAssetName}`);
  }
  return {
    tag,
    version: versionFromTag(tag),
    optsidianAssetName,
    optsidianDownloadUrl: optsidianAsset.browser_download_url,
    optsidianMcpAssetName,
    optsidianMcpDownloadUrl: optsidianMcpAsset.browser_download_url,
    checksumsAssetName,
    checksumsDownloadUrl: checksumsAsset.browser_download_url
  };
}

async function downloadFile(url: string, targetPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const response = await requestBuffer(url, env);
  const tmpPath = `${targetPath}.download-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, response.body);
  fs.renameSync(tmpPath, targetPath);
}

async function fetchReleaseChecksums(target: ReleaseInfo, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const response = await requestBuffer(target.checksumsDownloadUrl, env);
  return parseChecksumsText(response.body.toString("utf8"));
}

async function requestBuffer(
  url: string,
  env: NodeJS.ProcessEnv,
  redirects = 0
): Promise<{ statusCode: number; body: Buffer }> {
  if (hasProxyEnv(env)) {
    if (!hasCommand("curl", env)) {
      throw new RuntimeError("Proxy environment detected, but curl is not available for optsidian update.");
    }
    return requestBufferWithCurl(url, env);
  }
  return requestBufferDirect(url, env, redirects);
}

async function requestBufferDirect(
  url: string,
  env: NodeJS.ProcessEnv,
  redirects = 0
): Promise<{ statusCode: number; body: Buffer }> {
  if (redirects > 5) {
    throw new RuntimeError(`Too many redirects while fetching ${url}`);
  }

  const target = new URL(url);
  const requestImpl = target.protocol === "https:" ? https.request : http.request;
  const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const request = requestImpl(
        target,
        {
          method: "GET",
          headers: githubHeaders(env),
          agent: false
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
          res.on("error", reject);
        }
      );
      request.on("error", reject);
      request.end();
    }
  );

  const statusCode = response.statusCode;
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    const location = response.headers.location;
    if (typeof location !== "string" || location.length === 0) {
      throw new RuntimeError(`Redirect response from ${url} did not include a location header`);
    }
    return requestBuffer(new URL(location, target).toString(), env, redirects + 1);
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new RuntimeError(`Failed to fetch ${url} (${statusCode})`);
  }

  return {
    statusCode,
    body: response.body
  };
}

async function requestBufferWithCurl(url: string, env: NodeJS.ProcessEnv): Promise<{ statusCode: number; body: Buffer }> {
  const args = ["-fsSL", "-H", "Accept: application/vnd.github+json", "-H", `User-Agent: optsidian/${OPTSIDIAN_VERSION}`];
  if (env.GITHUB_TOKEN) {
    args.push("-H", `Authorization: Bearer ${env.GITHUB_TOKEN}`);
  }
  args.push(url);
  const result = spawnSync("curl", args, {
    env
  });
  if (result.error) {
    throw new RuntimeError(`Failed to execute curl: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const message = (result.stderr || result.stdout || Buffer.from("curl failed")).toString("utf8").trim();
    throw new RuntimeError(message || `Failed to fetch ${url}`);
  }
  return {
    statusCode: 200,
    body: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  };
}

function verifyDownloadedAssets(checksumsPath: string, assets: Array<{ name: string; filePath: string }>): void {
  if (!fs.existsSync(checksumsPath)) {
    throw new RuntimeError(`Release asset is missing ${path.basename(checksumsPath)}`);
  }
  const checksums = parseChecksumsText(fs.readFileSync(checksumsPath, "utf8"));

  for (const asset of assets) {
    if (!fs.existsSync(asset.filePath)) {
      throw new RuntimeError(`Release asset is missing ${asset.name}`);
    }
    const expected = checksums.get(asset.name);
    if (!expected) {
      throw new RuntimeError(`checksums.txt is missing ${asset.name}`);
    }
    const actual = sha256File(asset.filePath);
    if (expected !== actual) {
      throw new RuntimeError(`Checksum mismatch for ${asset.name}`);
    }
  }
}

function parseChecksumsText(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match) {
      throw new RuntimeError("checksums.txt is invalid");
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function inspectManagedInstall(manifest: InstallManifest): { healthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  inspectInstalledExecutable(manifest.optsidianPath, manifest.version, "optsidian", reasons);
  inspectInstalledExecutable(manifest.optsidianMcpPath, manifest.version, "optsidian-mcp", reasons);
  return {
    healthy: reasons.length === 0,
    reasons
  };
}

function compareInstalledChecksums(
  manifest: InstallManifest,
  target: ReleaseInfo,
  remoteChecksums: Map<string, string>
): string[] {
  const reasons: string[] = [];
  compareInstalledChecksum(manifest.optsidianPath, target.optsidianAssetName, "optsidian", remoteChecksums, reasons);
  compareInstalledChecksum(manifest.optsidianMcpPath, target.optsidianMcpAssetName, "optsidian-mcp", remoteChecksums, reasons);
  return reasons;
}

function compareInstalledChecksum(
  filePath: string,
  assetName: string,
  label: string,
  remoteChecksums: Map<string, string>,
  reasons: string[]
): void {
  if (!fs.existsSync(filePath)) {
    reasons.push(`${label} is missing at ${filePath}`);
    return;
  }
  const expected = remoteChecksums.get(assetName);
  if (!expected) {
    reasons.push(`release checksum is missing ${assetName}`);
    return;
  }
  const actual = sha256File(filePath);
  if (actual !== expected) {
    reasons.push(`${label} checksum differs from release ${assetName}`);
  }
}

function inspectInstalledExecutable(filePath: string, expectedVersion: string, label: string, reasons: string[]): void {
  if (!fs.existsSync(filePath)) {
    reasons.push(`${label} is missing at ${filePath}`);
    return;
  }
  try {
    const actualVersion = readExecutableVersion(filePath, label);
    if (actualVersion !== expectedVersion) {
      reasons.push(`${label} version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`${label} is unreadable: ${message}`);
  }
}

function verifyExecutableVersion(filePath: string, expectedVersion: string, label: string): void {
  const actualVersion = readExecutableVersion(filePath, label);
  if (actualVersion !== expectedVersion) {
    throw new RuntimeError(`${label} version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
  }
}

function readExecutableVersion(filePath: string, label: string): string {
  const probePath = path.join(
    os.tmpdir(),
    `optsidian-version-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  try {
    fs.copyFileSync(filePath, probePath);
    fs.chmodSync(probePath, 0o755);
    const result = spawnSync(process.execPath, [probePath, "--version"], {
      encoding: "utf8"
    });
    if (result.error) {
      throw new RuntimeError(`Failed to execute ${label}: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new RuntimeError((result.stderr || result.stdout || `Failed to execute ${label}`).trim());
    }
    const version = (result.stdout || "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new RuntimeError(`Invalid version output from ${label}: ${version}`);
    }
    return version;
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

function installExecutable(sourcePath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(destPath),
    `.optsidian-install-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.copyFileSync(sourcePath, tmpPath);
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);
}

function resolveManagedVaultPath(manifest: InstallManifest, env: NodeJS.ProcessEnv): string | undefined {
  const override = env.OPTSIDIAN_VAULT_PATH;
  const candidate = override !== undefined && override !== "" ? override : manifest.vaultPath;
  if (!candidate) return undefined;
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new RuntimeError(`Fallback vault path does not exist: ${candidate}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new RuntimeError(`Fallback vault path is not a directory: ${candidate}`);
  }
  return fs.realpathSync(resolved);
}

function refreshMcpRegistration(options: { mcpPath: string; vaultPath?: string; env?: NodeJS.ProcessEnv }): RegistrationResult {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const claudePresent = hasCommand("claude", env);
  const codexPresent = hasCommand("codex", env);

  let claudeRegistered = false;
  if (claudePresent) {
    runCommand("claude", ["mcp", "remove", MCP_NAME, "-s", "user"], env);
    const args = ["mcp", "add", MCP_NAME, "-s", "user"];
    if (options.vaultPath) {
      args.push("-e", `OPTSIDIAN_VAULT_PATH=${options.vaultPath}`);
    }
    args.push("--", options.mcpPath);
    const result = runCommand("claude", args, env);
    claudeRegistered = result.success;
    if (!result.success) warnings.push(`Claude MCP registration failed: ${result.message}`);
  }

  let codexRegistered = false;
  if (codexPresent) {
    runCommand("codex", ["mcp", "remove", MCP_NAME], env);
    const args = ["mcp", "add", MCP_NAME];
    if (options.vaultPath) {
      args.push("--env", `OPTSIDIAN_VAULT_PATH=${options.vaultPath}`);
    }
    args.push("--", options.mcpPath);
    const result = runCommand("codex", args, env);
    codexRegistered = result.success;
    if (!result.success) warnings.push(`Codex MCP registration failed: ${result.message}`);
  }

  return {
    codexPresent,
    codexRegistered,
    claudePresent,
    claudeRegistered,
    warnings
  };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): { success: boolean; message: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env
  });
  if (result.error) {
    return { success: false, message: result.error.message };
  }
  if ((result.status ?? 1) !== 0) {
    return {
      success: false,
      message: (result.stderr || result.stdout || `${command} exited with status ${result.status ?? 1}`).trim()
    };
  }
  return { success: true, message: "" };
}

function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const searchPath = env.PATH || process.env.PATH || "";
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `optsidian/${OPTSIDIAN_VERSION}`,
    Connection: "close"
  };
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function parseVersion(input: string): [number, number, number] {
  const version = input.startsWith("v") ? input.slice(1) : input;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new RuntimeError(`Invalid semantic version: ${input}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
