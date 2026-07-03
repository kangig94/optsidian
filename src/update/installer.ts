import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureExistingPrivateFileSync,
  ensurePrivateDirSync,
  isPrivatePathError,
  writePrivateFileSync,
} from '../core/private-path.js';
import { RuntimeError, UsageError } from '../errors.js';
import { downloadFile, fetchJson, hasCommand, requestBuffer } from '../net/github.js';
import { resolveVaultPathInput } from '../native/obsidian.js';
import { OPTSIDIAN_VERSION } from '../version.js';

const DEFAULT_RELEASE_API_BASE = 'https://api.github.com/repos/kangig94/optsidian/releases';
const RELEASE_REPOSITORY = 'kangig94/optsidian';
const RELEASE_SIGNER_WORKFLOW = 'kangig94/optsidian/.github/workflows/release.yml';
// v0.3.x is the one-release bridge that lets v0.2.x installs update forward.
// TODO(v0.4.0): remove checksum/best-effort modes and require attestations only.
const FIRST_ATTESTED_RELEASE = 'v0.3.0';
const MIN_SUPPORTED_INSTALL_TAG = 'v0.3.0';
const MCP_NAME = 'optsidian';
const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_NOTICE_NOTIFICATION_INTERVAL_MS = 3 * 60 * 60 * 1000;
const UPDATE_NOTICE_TIMEOUT_MS = 2500;

type InstallManifest = {
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
  command: 'update';
  action: 'check';
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
  command: 'update';
  action: 'install';
  status: 'current' | 'updated' | 'repaired';
  previousVersion: string;
  targetTag: string;
  installedVersion: string;
  binDir: string;
  codexRegistered: boolean;
  claudeRegistered: boolean;
  warnings: string[];
};

export type UpdateNotice = {
  currentVersion: string;
  targetTag: string;
  targetVersion: string;
  message: string;
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
  attestationAssetName: string;
  attestationDownloadUrl?: string;
};

type RegistrationResult = {
  codexPresent: boolean;
  codexRegistered: boolean;
  claudePresent: boolean;
  claudeRegistered: boolean;
  warnings: string[];
};

type UpdateNoticeState = {
  lastAttemptAt?: string;
  lastNotifiedAt?: string;
  currentVersion?: string;
  targetTag?: string;
  targetVersion?: string;
  lastError?: string;
};

// TODO(v0.4.0): delete this mode switch and always enforce attestation verification.
type ReleaseVerifyMode = 'required' | 'best-effort' | 'checksum';

function stateBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPTSIDIAN_STATE_BASE) {
    return path.resolve(env.OPTSIDIAN_STATE_BASE);
  }
  const cacheRoot = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), '.cache');
  return path.join(cacheRoot, 'optsidian');
}

function manifestFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateBaseDir(env), 'install.json');
}

function releasesCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateBaseDir(env), 'releases');
}

function updateNoticeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateBaseDir(env), 'update-check.json');
}

function normalizeTag(input: string): string {
  const trimmed = input.trim();
  const tag = trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new UsageError(`version must use vX.Y.Z or X.Y.Z; received: ${input}`);
  }
  return tag;
}

function versionFromTag(tag: string): string {
  return normalizeTag(tag).slice(1);
}

function assetNameForTag(tag: string): string {
  return `optsidian-${normalizeTag(tag)}`;
}

function mcpAssetNameForTag(tag: string): string {
  return `optsidian-mcp-${normalizeTag(tag)}`;
}

function checksumsAssetNameForTag(tag: string): string {
  return `checksums-${normalizeTag(tag)}.txt`;
}

function attestationAssetNameForTag(tag: string): string {
  return `attestation-${normalizeTag(tag)}.json`;
}

function releaseApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPTSIDIAN_RELEASE_API_BASE?.trim();
  return (configured ? configured : DEFAULT_RELEASE_API_BASE).replace(/\/+$/, '');
}

function loadInstallManifest(env: NodeJS.ProcessEnv = process.env): InstallManifest | undefined {
  ensurePrivateDirSync(stateBaseDir(env), 'Optsidian state directory');
  const file = manifestFilePath(env);
  if (!ensureExistingPrivateFileSync(file, 'Optsidian install manifest')) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstallManifest>;
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.binDir !== 'string' ||
    typeof parsed.optsidianPath !== 'string' ||
    typeof parsed.optsidianMcpPath !== 'string' ||
    typeof parsed.codexRegistered !== 'boolean' ||
    typeof parsed.claudeRegistered !== 'boolean' ||
    typeof parsed.installedAt !== 'string'
  ) {
    throw new RuntimeError(`Install manifest is invalid: ${file}`);
  }
  if (parsed.vaultPath !== undefined && typeof parsed.vaultPath !== 'string') {
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
    installedAt: parsed.installedAt,
  };
}

function saveInstallManifest(manifest: InstallManifest, env: NodeJS.ProcessEnv = process.env): void {
  const file = manifestFilePath(env);
  writePrivateFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'Optsidian install manifest');
}

export async function maybeCheckForUpdateNotice(
  options: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    currentVersion?: string;
    diagnostic?: (message: string) => void;
  } = {},
): Promise<UpdateNotice | undefined> {
  const env = options.env ?? process.env;
  if (isAutoUpdateCheckDisabled(env)) return undefined;

  const now = options.now ?? new Date();
  const state = readUpdateNoticeState(env);
  const currentVersion = options.currentVersion ?? currentInstalledVersion(env);
  let noticeState: UpdateNoticeState | undefined = state;
  let shouldSaveState = false;

  if (isUpdateNoticeFetchDue(state, now, updateNoticeIntervalMs(env))) {
    try {
      const target = await fetchLatestReleaseVersion(env, updateNoticeTimeoutMs(env));
      const lastNotifiedAt = state?.targetVersion === target.version ? state.lastNotifiedAt : undefined;
      noticeState = {
        ...state,
        lastAttemptAt: now.toISOString(),
        lastNotifiedAt,
        currentVersion,
        targetTag: target.tag,
        targetVersion: target.version,
        lastError: undefined,
      };
    } catch (error) {
      noticeState = {
        ...state,
        lastAttemptAt: now.toISOString(),
        currentVersion,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    shouldSaveState = true;
  }

  const notice = noticeFromCachedRelease(noticeState, currentVersion, now, updateNoticeNotificationIntervalMs(env));
  if (notice) {
    writeUpdateNoticeState(
      { ...noticeState, currentVersion, lastNotifiedAt: now.toISOString() },
      env,
      options.diagnostic,
    );
    return notice;
  }

  if (shouldSaveState && noticeState) {
    writeUpdateNoticeState(noticeState, env, options.diagnostic);
  }
  return undefined;
}

function noticeFromCachedRelease(
  state: UpdateNoticeState | undefined,
  currentVersion: string,
  now: Date,
  intervalMs: number,
): UpdateNotice | undefined {
  if (!state?.targetTag || !state.targetVersion) return undefined;
  try {
    if (compareVersions(currentVersion, state.targetVersion) >= 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (!isUpdateNoticeNotificationDue(state, now, intervalMs)) {
    return undefined;
  }
  return {
    currentVersion,
    targetTag: state.targetTag,
    targetVersion: state.targetVersion,
    message: `Optsidian ${state.targetTag} is available (current v${currentVersion}). Run \`optsidian update\`.`,
  };
}

export async function checkForUpdate(
  options: { tag?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<UpdateCheckResult> {
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
    command: 'update',
    action: 'check',
    currentVersion,
    targetTag: target.tag,
    targetVersion: target.version,
    managedInstall: Boolean(manifest),
    needsUpdate: options.tag ? comparison !== 0 || repairNeeded : comparison < 0 || repairNeeded,
    repairNeeded,
    installPath: manifest?.binDir,
    guidance: !manifest
      ? 'Managed install metadata not found. Re-run scripts/install.sh to adopt managed updates.'
      : repairNeeded
        ? `Managed install needs repair: ${repairReasons.join('; ')}`
        : undefined,
  };
}

export async function installRelease(
  options: { tag?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<UpdateInstallResult> {
  assertSupportedPlatform();
  const env = options.env ?? process.env;
  const manifest = loadInstallManifest(env);
  if (!manifest) {
    throw new RuntimeError('Managed install metadata not found. Re-run scripts/install.sh to adopt managed updates.');
  }

  const target = await fetchReleaseInfo({ tag: options.tag, env });
  const health = inspectManagedInstall(manifest);
  const sameVersion = compareVersions(manifest.version, target.version) === 0;
  const repairReasons = health.healthy
    ? compareInstalledChecksums(manifest, target, await fetchReleaseChecksums(target, env))
    : [...health.reasons];
  if (sameVersion && health.healthy && repairReasons.length === 0) {
    return {
      ok: true,
      command: 'update',
      action: 'install',
      status: 'current',
      previousVersion: manifest.version,
      targetTag: target.tag,
      installedVersion: manifest.version,
      binDir: manifest.binDir,
      codexRegistered: manifest.codexRegistered,
      claudeRegistered: manifest.claudeRegistered,
      warnings: [],
    };
  }

  ensurePrivateDirSync(stateBaseDir(env), 'Optsidian state directory');
  ensurePrivateDirSync(releasesCacheDir(env), 'Optsidian release cache directory');
  const releaseDir = path.join(releasesCacheDir(env), target.tag);
  ensurePrivateDirSync(releaseDir, 'Optsidian release cache directory');
  const optsidianAssetPath = path.join(releaseDir, target.optsidianAssetName);
  const optsidianMcpAssetPath = path.join(releaseDir, target.optsidianMcpAssetName);
  const checksumsPath = path.join(releaseDir, target.checksumsAssetName);

  await downloadFile(target.checksumsDownloadUrl, checksumsPath, env, { sendAuth: false });
  await downloadFile(target.optsidianDownloadUrl, optsidianAssetPath, env, { sendAuth: false });
  await downloadFile(target.optsidianMcpDownloadUrl, optsidianMcpAssetPath, env, { sendAuth: false });
  verifyDownloadedAssets(checksumsPath, [
    { name: target.optsidianAssetName, filePath: optsidianAssetPath },
    { name: target.optsidianMcpAssetName, filePath: optsidianMcpAssetPath },
  ]);
  await verifyReleaseAttestation(
    target,
    [
      { name: target.optsidianAssetName, filePath: optsidianAssetPath },
      { name: target.optsidianMcpAssetName, filePath: optsidianMcpAssetPath },
    ],
    releaseDir,
    env,
  );
  verifyExecutableVersion(optsidianAssetPath, target.version, target.optsidianAssetName);
  verifyExecutableVersion(optsidianMcpAssetPath, target.version, target.optsidianMcpAssetName);

  installExecutable(optsidianAssetPath, manifest.optsidianPath);
  installExecutable(optsidianMcpAssetPath, manifest.optsidianMcpPath);

  const vaultPath = resolveManagedVaultPath(manifest, env);
  const registration = refreshMcpRegistration({
    mcpPath: manifest.optsidianMcpPath,
    vaultPath,
    env,
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
      installedAt: new Date().toISOString(),
    },
    env,
  );

  return {
    ok: true,
    command: 'update',
    action: 'install',
    status: sameVersion ? 'repaired' : 'updated',
    previousVersion: manifest.version,
    targetTag: target.tag,
    installedVersion: target.version,
    binDir: manifest.binDir,
    codexRegistered: registration.codexRegistered,
    claudeRegistered: registration.claudeRegistered,
    warnings: registration.warnings,
  };
}

function assertSupportedPlatform(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return;
  }
  throw new RuntimeError('optsidian update/install currently supports Linux and macOS only.');
}

async function fetchReleaseInfo(options: { tag?: string; env?: NodeJS.ProcessEnv }): Promise<ReleaseInfo> {
  const env = options.env ?? process.env;
  const requestedTag = options.tag ? normalizeTag(options.tag) : undefined;
  const endpoint = requestedTag
    ? `${releaseApiBase(env)}/tags/${encodeURIComponent(requestedTag)}`
    : `${releaseApiBase(env)}/latest`;
  const payload = await fetchJson(endpoint, env, { sendAuth: false });
  const target = parseReleaseInfo(payload, requestedTag);
  assertReleaseTargetPolicy(target, env);
  return target;
}

async function fetchLatestReleaseVersion(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ tag: string; version: string }> {
  const payload = await fetchJson(`${releaseApiBase(env)}/latest`, env, { timeoutMs, sendAuth: false });
  if (!payload || typeof payload !== 'object') {
    throw new RuntimeError('Release metadata payload is invalid');
  }
  const json = payload as Record<string, unknown>;
  const tag = normalizeTag(typeof json.tag_name === 'string' ? json.tag_name : '');
  if (json.draft === true) {
    throw new RuntimeError(`Release ${tag} is still a draft`);
  }
  assertSupportedReleaseTag(tag);
  return { tag, version: versionFromTag(tag) };
}

function parseReleaseInfo(payload: unknown, requestedTag: string | undefined): ReleaseInfo {
  if (!payload || typeof payload !== 'object') {
    throw new RuntimeError('Release metadata payload is invalid');
  }
  const json = payload as Record<string, unknown>;
  const tag = normalizeTag(typeof json.tag_name === 'string' ? json.tag_name : '');
  if (requestedTag && tag !== requestedTag) {
    throw new RuntimeError(`Requested ${requestedTag} but release metadata returned ${tag}`);
  }
  if (json.draft === true) {
    throw new RuntimeError(`Release ${tag} is still a draft`);
  }
  const optsidianAssetName = assetNameForTag(tag);
  const optsidianMcpAssetName = mcpAssetNameForTag(tag);
  const checksumsAssetName = checksumsAssetNameForTag(tag);
  const attestationAssetName = attestationAssetNameForTag(tag);
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const optsidianAsset = assets.find((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as Record<string, unknown>).name === optsidianAssetName;
  }) as Record<string, unknown> | undefined;
  const optsidianMcpAsset = assets.find((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as Record<string, unknown>).name === optsidianMcpAssetName;
  }) as Record<string, unknown> | undefined;
  const checksumsAsset = assets.find((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as Record<string, unknown>).name === checksumsAssetName;
  }) as Record<string, unknown> | undefined;
  const attestationAsset = assets.find((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as Record<string, unknown>).name === attestationAssetName;
  }) as Record<string, unknown> | undefined;
  if (!optsidianAsset || typeof optsidianAsset.browser_download_url !== 'string') {
    throw new RuntimeError(`Release ${tag} does not contain asset ${optsidianAssetName}`);
  }
  if (!optsidianMcpAsset || typeof optsidianMcpAsset.browser_download_url !== 'string') {
    throw new RuntimeError(`Release ${tag} does not contain asset ${optsidianMcpAssetName}`);
  }
  if (!checksumsAsset || typeof checksumsAsset.browser_download_url !== 'string') {
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
    checksumsDownloadUrl: checksumsAsset.browser_download_url,
    attestationAssetName,
    attestationDownloadUrl:
      typeof attestationAsset?.browser_download_url === 'string' ? attestationAsset.browser_download_url : undefined,
  };
}

async function fetchReleaseChecksums(target: ReleaseInfo, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const response = await requestBuffer(target.checksumsDownloadUrl, env, { sendAuth: false });
  return parseChecksumsText(response.body.toString('utf8'));
}

async function verifyReleaseAttestation(
  target: ReleaseInfo,
  assets: Array<{ name: string; filePath: string }>,
  releaseDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const mode = releaseVerifyMode(env);
  if (mode === 'checksum' || compareVersions(target.version, versionFromTag(FIRST_ATTESTED_RELEASE)) < 0) return;

  if (!target.attestationDownloadUrl) {
    if (mode === 'required') {
      throw new RuntimeError(`Release ${target.tag} does not contain asset ${target.attestationAssetName}`);
    }
    return;
  }

  if (!hasCommand('gh', env)) {
    if (mode === 'required') {
      throw new RuntimeError(`GitHub CLI (gh) is required to verify release attestations for ${target.tag}`);
    }
    return;
  }

  const bundlePath = path.join(releaseDir, target.attestationAssetName);
  await downloadFile(target.attestationDownloadUrl, bundlePath, env, { sendAuth: false });
  for (const asset of assets) {
    verifyAssetAttestation(asset, bundlePath, env, mode);
  }
}

function verifyAssetAttestation(
  asset: { name: string; filePath: string },
  bundlePath: string,
  env: NodeJS.ProcessEnv,
  mode: ReleaseVerifyMode,
): void {
  const ghConfigDir = path.join(
    os.tmpdir(),
    `optsidian-gh-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 });
  try {
    const result = spawnSync(
      'gh',
      [
        'attestation',
        'verify',
        asset.filePath,
        '--repo',
        RELEASE_REPOSITORY,
        '--signer-workflow',
        RELEASE_SIGNER_WORKFLOW,
        '--deny-self-hosted-runners',
        '--bundle',
        bundlePath,
      ],
      {
        encoding: 'utf8',
        env: unauthenticatedGhEnv(env, ghConfigDir),
      },
    );
    if (result.error || (result.status ?? 1) !== 0) {
      if (mode === 'required') {
        const detail =
          result.error?.message ?? (result.stderr || result.stdout || 'gh attestation verify failed').trim();
        throw new RuntimeError(`Release attestation verification failed for ${asset.name}: ${detail}`);
      }
    }
  } finally {
    fs.rmSync(ghConfigDir, { recursive: true, force: true });
  }
}

function unauthenticatedGhEnv(env: NodeJS.ProcessEnv, ghConfigDir: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GH_CONFIG_DIR: ghConfigDir };
  delete next.GITHUB_TOKEN;
  delete next.GH_TOKEN;
  return next;
}

function verifyDownloadedAssets(checksumsPath: string, assets: Array<{ name: string; filePath: string }>): void {
  if (!fs.existsSync(checksumsPath)) {
    throw new RuntimeError(`Release asset is missing ${path.basename(checksumsPath)}`);
  }
  const checksums = parseChecksumsText(fs.readFileSync(checksumsPath, 'utf8'));

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
      throw new RuntimeError('checksums.txt is invalid');
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function inspectManagedInstall(manifest: InstallManifest): { healthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  inspectInstalledExecutable(manifest.optsidianPath, manifest.version, 'optsidian', reasons);
  inspectInstalledExecutable(manifest.optsidianMcpPath, manifest.version, 'optsidian-mcp', reasons);
  return {
    healthy: reasons.length === 0,
    reasons,
  };
}

function compareInstalledChecksums(
  manifest: InstallManifest,
  target: ReleaseInfo,
  remoteChecksums: Map<string, string>,
): string[] {
  const reasons: string[] = [];
  compareInstalledChecksum(manifest.optsidianPath, target.optsidianAssetName, 'optsidian', remoteChecksums, reasons);
  compareInstalledChecksum(
    manifest.optsidianMcpPath,
    target.optsidianMcpAssetName,
    'optsidian-mcp',
    remoteChecksums,
    reasons,
  );
  return reasons;
}

function compareInstalledChecksum(
  filePath: string,
  assetName: string,
  label: string,
  remoteChecksums: Map<string, string>,
  reasons: string[],
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
    `optsidian-version-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  try {
    fs.copyFileSync(filePath, probePath);
    fs.chmodSync(probePath, 0o755);
    const result = spawnSync(process.execPath, [probePath, '--version'], {
      encoding: 'utf8',
    });
    if (result.error) {
      throw new RuntimeError(`Failed to execute ${label}: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new RuntimeError((result.stderr || result.stdout || `Failed to execute ${label}`).trim());
    }
    const version = (result.stdout || '').trim();
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
    `.optsidian-install-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.copyFileSync(sourcePath, tmpPath);
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);
}

function resolveManagedVaultPath(manifest: InstallManifest, env: NodeJS.ProcessEnv): string | undefined {
  const override = env.OPTSIDIAN_VAULT_PATH;
  const candidate = override !== undefined && override !== '' ? override : manifest.vaultPath;
  if (!candidate) return undefined;
  return resolveVaultPathInput(candidate);
}

function refreshMcpRegistration(options: {
  mcpPath: string;
  vaultPath?: string;
  env?: NodeJS.ProcessEnv;
}): RegistrationResult {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const claudePresent = hasCommand('claude', env);
  const codexPresent = hasCommand('codex', env);

  let claudeRegistered = false;
  if (claudePresent) {
    runCommand('claude', ['mcp', 'remove', MCP_NAME, '-s', 'user'], env);
    const args = ['mcp', 'add', MCP_NAME, '-s', 'user'];
    if (options.vaultPath) {
      args.push('-e', `OPTSIDIAN_VAULT_PATH=${options.vaultPath}`);
    }
    args.push('--', options.mcpPath);
    const result = runCommand('claude', args, env);
    claudeRegistered = result.success;
    if (!result.success) warnings.push(`Claude MCP registration failed: ${result.message}`);
  }

  let codexRegistered = false;
  if (codexPresent) {
    runCommand('codex', ['mcp', 'remove', MCP_NAME], env);
    const args = ['mcp', 'add', MCP_NAME];
    if (options.vaultPath) {
      args.push('--env', `OPTSIDIAN_VAULT_PATH=${options.vaultPath}`);
    }
    args.push('--', options.mcpPath);
    const result = runCommand('codex', args, env);
    codexRegistered = result.success;
    if (!result.success) warnings.push(`Codex MCP registration failed: ${result.message}`);
  }

  return {
    codexPresent,
    codexRegistered,
    claudePresent,
    claudeRegistered,
    warnings,
  };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): { success: boolean; message: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
  });
  if (result.error) {
    return { success: false, message: result.error.message };
  }
  if ((result.status ?? 1) !== 0) {
    return {
      success: false,
      message: (result.stderr || result.stdout || `${command} exited with status ${result.status ?? 1}`).trim(),
    };
  }
  return { success: true, message: '' };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function currentInstalledVersion(env: NodeJS.ProcessEnv): string {
  try {
    return loadInstallManifest(env)?.version ?? OPTSIDIAN_VERSION;
  } catch {
    return OPTSIDIAN_VERSION;
  }
}

function isAutoUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPTSIDIAN_NO_UPDATE_CHECK?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return env.CI === 'true';
}

function readUpdateNoticeState(env: NodeJS.ProcessEnv): UpdateNoticeState | undefined {
  try {
    const file = updateNoticeStatePath(env);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdateNoticeState>;
    return {
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : undefined,
      lastNotifiedAt: typeof parsed.lastNotifiedAt === 'string' ? parsed.lastNotifiedAt : undefined,
      currentVersion: typeof parsed.currentVersion === 'string' ? parsed.currentVersion : undefined,
      targetTag: typeof parsed.targetTag === 'string' ? parsed.targetTag : undefined,
      targetVersion: typeof parsed.targetVersion === 'string' ? parsed.targetVersion : undefined,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeUpdateNoticeState(
  state: UpdateNoticeState,
  env: NodeJS.ProcessEnv,
  diagnostic?: (message: string) => void,
): void {
  try {
    const file = updateNoticeStatePath(env);
    writePrivateFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'Optsidian update notice state');
  } catch (error) {
    if (isPrivatePathError(error)) {
      diagnostic?.(`Cannot save Optsidian update notice state: ${error.message}`);
    }
    // Update notices are best-effort and must never affect the command that triggered them.
  }
}

function isUpdateNoticeFetchDue(state: UpdateNoticeState | undefined, now: Date, intervalMs: number): boolean {
  if (!state?.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return now.getTime() - lastAttemptMs >= intervalMs;
}

function isUpdateNoticeNotificationDue(state: UpdateNoticeState, now: Date, intervalMs: number): boolean {
  if (!state.lastNotifiedAt) return true;
  const lastNotifiedMs = Date.parse(state.lastNotifiedAt);
  if (!Number.isFinite(lastNotifiedMs)) return true;
  return now.getTime() - lastNotifiedMs >= intervalMs;
}

function updateNoticeIntervalMs(env: NodeJS.ProcessEnv): number {
  return nonNegativeIntegerEnv(env, 'OPTSIDIAN_UPDATE_CHECK_INTERVAL_MS', UPDATE_NOTICE_INTERVAL_MS);
}

function updateNoticeNotificationIntervalMs(env: NodeJS.ProcessEnv): number {
  return nonNegativeIntegerEnv(env, 'OPTSIDIAN_UPDATE_NOTICE_INTERVAL_MS', UPDATE_NOTICE_NOTIFICATION_INTERVAL_MS);
}

function updateNoticeTimeoutMs(env: NodeJS.ProcessEnv): number {
  return positiveIntegerEnv(env, 'OPTSIDIAN_UPDATE_CHECK_TIMEOUT_MS', UPDATE_NOTICE_TIMEOUT_MS);
}

function nonNegativeIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertReleaseTargetPolicy(target: ReleaseInfo, env: NodeJS.ProcessEnv): void {
  assertSupportedReleaseTarget(target);
  if (
    releaseVerifyMode(env) === 'required' &&
    compareVersions(target.version, versionFromTag(FIRST_ATTESTED_RELEASE)) >= 0 &&
    !target.attestationDownloadUrl
  ) {
    throw new RuntimeError(`Release ${target.tag} does not contain asset ${target.attestationAssetName}`);
  }
}

function releaseVerifyMode(env: NodeJS.ProcessEnv): ReleaseVerifyMode {
  const raw = env.OPTSIDIAN_RELEASE_VERIFY?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'required';
  if (raw === 'required' || raw === 'best-effort' || raw === 'checksum') return raw;
  throw new RuntimeError('OPTSIDIAN_RELEASE_VERIFY must be one of: required, best-effort, checksum');
}

function assertSupportedReleaseTarget(target: ReleaseInfo): void {
  assertSupportedReleaseTag(target.tag);
}

function assertSupportedReleaseTag(tag: string): void {
  if (compareVersions(versionFromTag(tag), versionFromTag(MIN_SUPPORTED_INSTALL_TAG)) >= 0) return;
  throw new RuntimeError(
    `Optsidian releases before ${MIN_SUPPORTED_INSTALL_TAG} are no longer supported by this installer.`,
  );
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function parseVersion(input: string): [number, number, number] {
  const version = input.startsWith('v') ? input.slice(1) : input;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new RuntimeError(`Invalid semantic version: ${input}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
