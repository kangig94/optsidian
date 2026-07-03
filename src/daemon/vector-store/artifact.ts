import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { optsidianCacheRoot } from '../../core/cache-root.js';
import { installArtifact } from '../../core/lifecycle/artifact-install.js';
import { ensureExistingPrivateFileSync, ensurePrivateDirSync, writePrivateFileSync } from '../../core/private-path.js';
import { RuntimeError } from '../../errors.js';
import { downloadFileStreaming } from '../../net/github.js';

const CORAL_NEEDLE_VERSION = 'v0.2.0';
const CORAL_NEEDLE_RELEASE_BASE_URL = `https://github.com/kangig94/coral-needle/releases/download/${CORAL_NEEDLE_VERSION}`;
const CORAL_NEEDLE_MANIFEST = 'optsidian-coral-needle.json';
const CORAL_NEEDLE_BINDING = 'coral-needle.node';
const CORAL_NEEDLE_INSTALL_TIMEOUT_MS = 30_000;

type CoralNeedlePlatform = 'darwin' | 'linux' | 'win32';
export type CoralNeedleArch = 'amd64' | 'arm64';
type CoralNeedleArchiveType = 'tar.gz' | 'zip';

export type CoralNeedleReleaseAsset = {
  platform: CoralNeedlePlatform;
  arch: CoralNeedleArch;
  archiveType: CoralNeedleArchiveType;
  name: string;
  size: number;
  sha256: string;
  bindingSize: number;
  bindingSha256: string;
};

type CoralNeedleManifest = {
  package: 'coral-needle';
  version: string;
  platform: CoralNeedlePlatform;
  arch: CoralNeedleArch;
  assetName: string;
  assetSha256: string;
  installedAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
};

export type CoralNeedleEnsureOptions = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture | CoralNeedleArch;
  asset?: CoralNeedleReleaseAsset;
  downloadFile?: typeof downloadFileStreaming;
  lockTimeoutMs?: number;
};

const RELEASE_ASSETS: readonly CoralNeedleReleaseAsset[] = [
  {
    platform: 'darwin',
    arch: 'amd64',
    archiveType: 'tar.gz',
    name: 'coral-needle-v0.2.0-darwin-amd64.tar.gz',
    size: 16_013_479,
    sha256: 'e01ec9e9eb9513e3ecbc99345235b04c6797b882e736b4178cb9fb42abdda451',
    bindingSize: 59_379_968,
    bindingSha256: '35978c08dcda03ba8b555c1ebbb456d7307324d7c7a4e947b6173a7db6f99ff4',
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    archiveType: 'tar.gz',
    name: 'coral-needle-v0.2.0-darwin-arm64.tar.gz',
    size: 13_288_044,
    sha256: 'f36aaf6948178848119a96c3a4b66d83cf3a6fa482ac6886688c3f4fdb6bdba0',
    bindingSize: 49_065_312,
    bindingSha256: 'f1d4a9c728902d39d2160490918278a369c9fdeec31a1e0e808db710a46d074e',
  },
  {
    platform: 'linux',
    arch: 'amd64',
    archiveType: 'tar.gz',
    name: 'coral-needle-v0.2.0-linux-amd64.tar.gz',
    size: 21_133_478,
    sha256: '0b7c2ffa40b2e5c82c5bedc0809209cacd2081a4ae56a40556ab84ea68d0f7bb',
    bindingSize: 68_473_184,
    bindingSha256: 'd4006424a9976fd28f96aa13fba00d275261890307a069f683932dceae531e78',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    archiveType: 'tar.gz',
    name: 'coral-needle-v0.2.0-linux-arm64.tar.gz',
    size: 17_811_683,
    sha256: '62f71aa110de299edee1808af797ecf3af9e3187376f6db5ecbce3bdedea4f87',
    bindingSize: 57_679_776,
    bindingSha256: '9d44a720851d17d8e1e99db2e92bb5a7d6071fdbcb556c839c161c8e3c3c1a31',
  },
  {
    platform: 'win32',
    arch: 'amd64',
    archiveType: 'zip',
    name: 'coral-needle-v0.2.0-win32-amd64.zip',
    size: 12_990_936,
    sha256: 'fb000834134b5d1d2ee4c8b158487f27ab35fef5e3f01fc18961d5fd384f8013',
    bindingSize: 209_920,
    bindingSha256: 'bf6e95198f286b9957f14dbca52d5e811ff189bb93b9f9009b03fe391be05f0d',
  },
];

const inFlightInstalls = new Map<string, Promise<string>>();

export function resolveCoralNeedleReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture | CoralNeedleArch = process.arch,
): CoralNeedleReleaseAsset {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  const asset = RELEASE_ASSETS.find(
    (candidate) => candidate.platform === normalizedPlatform && candidate.arch === normalizedArch,
  );
  if (!asset) {
    throw new RuntimeError(`coral-needle ${CORAL_NEEDLE_VERSION} is not available for ${platform}-${arch}`);
  }
  return asset;
}

export function coralNeedleManagedBindingPath(env: NodeJS.ProcessEnv = process.env): string {
  const asset = resolveCoralNeedleReleaseAsset();
  return path.join(coralNeedleInstallDir(asset, env), CORAL_NEEDLE_BINDING);
}

export async function ensureCoralNeedleBinding(
  env: NodeJS.ProcessEnv = process.env,
  options: CoralNeedleEnsureOptions = {},
): Promise<string> {
  const explicit = env.OPTSIDIAN_CORAL_NEEDLE_BINDING?.trim();
  if (explicit) {
    assertExplicitBinding(explicit);
    return path.resolve(explicit);
  }

  const asset = options.asset ?? resolveCoralNeedleReleaseAsset(options.platform, options.arch);
  const targetDir = coralNeedleInstallDir(asset, env);
  const targetPath = path.join(targetDir, CORAL_NEEDLE_BINDING);
  const cacheKey = `${targetPath}:${asset.bindingSha256}`;
  if (isCoralNeedleBindingInstalled(targetDir, asset)) return targetPath;

  const existing = inFlightInstalls.get(cacheKey);
  if (existing) return existing;
  const install = installWithLock(asset, env, options).finally(() => inFlightInstalls.delete(cacheKey));
  inFlightInstalls.set(cacheKey, install);
  return install;
}

function coralNeedleInstallRoot(env: NodeJS.ProcessEnv): string {
  return path.join(optsidianCacheRoot(env), 'coral-needle', CORAL_NEEDLE_VERSION);
}

function coralNeedleInstallDir(asset: CoralNeedleReleaseAsset, env: NodeJS.ProcessEnv): string {
  return path.join(coralNeedleInstallRoot(env), `${asset.platform}-${asset.arch}`);
}

async function installWithLock(
  asset: CoralNeedleReleaseAsset,
  env: NodeJS.ProcessEnv,
  options: CoralNeedleEnsureOptions,
): Promise<string> {
  const root = coralNeedleInstallRoot(env);
  const targetDir = coralNeedleInstallDir(asset, env);
  ensurePrivateDirSync(optsidianCacheRoot(env), 'Optsidian cache directory');
  ensurePrivateDirSync(root, 'Optsidian coral-needle cache directory');
  const installed = await installArtifact<string, 'digest'>({
    artifactDir: targetDir,
    claimDir: path.join(root, 'install.claim'),
    stagingRoot: path.join(root, 'staging'),
    verifyDepth: 'digest',
    timeoutMs: options.lockTimeoutMs ?? CORAL_NEEDLE_INSTALL_TIMEOUT_MS,
    verifyInstalled: (artifactDir) =>
      isCoralNeedleBindingInstalled(artifactDir, asset) ? path.join(artifactDir, CORAL_NEEDLE_BINDING) : undefined,
    stage: (stagingDir) =>
      installCoralNeedleBinding(stagingDir, asset, env, options.downloadFile ?? downloadFileStreaming),
    computeChecksum: (stagingDir) => {
      assertCoralNeedleBindingInstalled(stagingDir, asset);
      return asset.bindingSha256;
    },
    activate: (stagingDir, artifactDir) => {
      replaceArtifactDir(stagingDir, artifactDir);
    },
  });
  return installed.artifact;
}

async function installCoralNeedleBinding(
  tempDir: string,
  asset: CoralNeedleReleaseAsset,
  env: NodeJS.ProcessEnv,
  downloadFile: typeof downloadFileStreaming,
): Promise<void> {
  const archivePath = path.join(tempDir, asset.name);
  await downloadFile(coralNeedleReleaseAssetUrl(asset), archivePath, env, {
    sendAuth: false,
    maxBytes: asset.size + 1024 * 1024,
  });
  const archive = fs.readFileSync(archivePath);
  verifyArchiveData(asset, archive);
  const binding = asset.archiveType === 'tar.gz' ? extractTarGzBinding(archive) : extractZipBinding(archive);
  verifyBindingData(asset, binding);
  writePrivateFileSync(path.join(tempDir, CORAL_NEEDLE_BINDING), binding, 'Optsidian coral-needle binding');
  writePrivateFileSync(
    path.join(tempDir, CORAL_NEEDLE_MANIFEST),
    `${JSON.stringify(coralNeedleManifest(asset), null, 2)}\n`,
    'Optsidian coral-needle manifest',
  );
  fs.rmSync(archivePath, { force: true });
}

function coralNeedleReleaseAssetUrl(asset: CoralNeedleReleaseAsset): string {
  return `${CORAL_NEEDLE_RELEASE_BASE_URL}/${asset.name}`;
}

function isCoralNeedleBindingInstalled(targetDir: string, asset: CoralNeedleReleaseAsset): boolean {
  try {
    assertCoralNeedleBindingInstalled(targetDir, asset);
    return true;
  } catch {
    return false;
  }
}

function replaceArtifactDir(stagingDir: string, artifactDir: string): void {
  ensurePrivateDirSync(path.dirname(artifactDir), 'Optsidian coral-needle artifact directory');
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, artifactDir);
}

function assertCoralNeedleBindingInstalled(targetDir: string, asset: CoralNeedleReleaseAsset): void {
  if (!fs.existsSync(targetDir)) {
    throw new RuntimeError(`coral-needle binding is not installed: ${targetDir}`);
  }
  ensurePrivateDirSync(targetDir, 'Optsidian coral-needle runtime directory');
  const manifestPath = path.join(targetDir, CORAL_NEEDLE_MANIFEST);
  if (!ensureExistingPrivateFileSync(manifestPath, 'Optsidian coral-needle manifest')) {
    throw new RuntimeError(`coral-needle manifest is missing: ${manifestPath}`);
  }
  const manifest = readManifest(manifestPath);
  if (
    manifest.package !== 'coral-needle' ||
    manifest.version !== CORAL_NEEDLE_VERSION ||
    manifest.platform !== asset.platform ||
    manifest.arch !== asset.arch ||
    manifest.assetName !== asset.name ||
    manifest.assetSha256 !== asset.sha256
  ) {
    throw new RuntimeError(`coral-needle manifest is invalid: ${manifestPath}`);
  }
  const bindingPath = path.join(targetDir, CORAL_NEEDLE_BINDING);
  if (!ensureExistingPrivateFileSync(bindingPath, 'Optsidian coral-needle binding')) {
    throw new RuntimeError(`coral-needle binding is missing: ${bindingPath}`);
  }
  verifyBindingData(asset, fs.readFileSync(bindingPath));
}

function assertExplicitBinding(filePath: string): void {
  const target = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new RuntimeError(`Configured coral-needle binding does not exist: ${target}`);
  }
  if (!stat.isFile()) {
    throw new RuntimeError(`Configured coral-needle binding is not a file: ${target}`);
  }
}

function coralNeedleManifest(asset: CoralNeedleReleaseAsset): CoralNeedleManifest {
  return {
    package: 'coral-needle',
    version: CORAL_NEEDLE_VERSION,
    platform: asset.platform,
    arch: asset.arch,
    assetName: asset.name,
    assetSha256: asset.sha256,
    installedAt: new Date().toISOString(),
    files: [
      {
        path: CORAL_NEEDLE_BINDING,
        size: asset.bindingSize,
        sha256: asset.bindingSha256,
      },
    ],
  };
}

function readManifest(filePath: string): CoralNeedleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new RuntimeError(`coral-needle manifest is not readable: ${errorMessage(error)}`);
  }
  if (!isManifest(parsed)) {
    throw new RuntimeError(`coral-needle manifest is invalid: ${filePath}`);
  }
  return parsed;
}

function isManifest(value: unknown): value is CoralNeedleManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CoralNeedleManifest>;
  return (
    record.package === 'coral-needle' &&
    typeof record.version === 'string' &&
    typeof record.platform === 'string' &&
    typeof record.arch === 'string' &&
    typeof record.assetName === 'string' &&
    typeof record.assetSha256 === 'string' &&
    typeof record.installedAt === 'string' &&
    Array.isArray(record.files)
  );
}

function verifyArchiveData(asset: CoralNeedleReleaseAsset, data: Buffer): void {
  if (data.length !== asset.size) {
    throw new RuntimeError(
      `coral-needle archive size mismatch for ${asset.name}: expected ${asset.size}, got ${data.length}`,
    );
  }
  if (digestHex(data) !== asset.sha256) {
    throw new RuntimeError(`coral-needle archive sha256 mismatch for ${asset.name}`);
  }
}

function verifyBindingData(asset: CoralNeedleReleaseAsset, data: Buffer): void {
  if (data.length !== asset.bindingSize) {
    throw new RuntimeError(
      `coral-needle binding size mismatch for ${asset.platform}-${asset.arch}: expected ${asset.bindingSize}, got ${data.length}`,
    );
  }
  if (digestHex(data) !== asset.bindingSha256) {
    throw new RuntimeError(`coral-needle binding sha256 mismatch for ${asset.platform}-${asset.arch}`);
  }
}

function extractTarGzBinding(archive: Buffer): Buffer {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(archive);
  } catch (error) {
    throw new RuntimeError(`Failed to decompress coral-needle archive: ${errorMessage(error)}`);
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const name = tarHeaderName(header);
    const size = tarHeaderSize(header);
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new RuntimeError(`coral-needle archive entry exceeds archive size: ${name}`);
    }
    if (name === CORAL_NEEDLE_BINDING) {
      if (type !== '0' && type !== '\0') {
        throw new RuntimeError(`coral-needle archive entry is not a regular file: ${name}`);
      }
      return Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new RuntimeError(`coral-needle archive is missing ${CORAL_NEEDLE_BINDING}`);
}

function extractZipBinding(archive: Buffer): Buffer {
  const centralDirectoryOffset = zipCentralDirectoryOffset(archive);
  let offset = centralDirectoryOffset;
  while (offset + 46 <= archive.length) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) break;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) throw new RuntimeError('coral-needle zip central directory is truncated');
    const name = archive.subarray(nameStart, nameEnd).toString('utf8');
    if (name === CORAL_NEEDLE_BINDING) {
      return extractZipFileData(archive, localHeaderOffset, method, compressedSize, uncompressedSize);
    }
    offset = nameEnd + extraLength + commentLength;
  }
  throw new RuntimeError(`coral-needle zip archive is missing ${CORAL_NEEDLE_BINDING}`);
}

function extractZipFileData(
  archive: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new RuntimeError('coral-needle zip local file header is invalid');
  }
  const nameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > archive.length) throw new RuntimeError('coral-needle zip entry exceeds archive size');
  const compressed = archive.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (method === 0) {
    data = Buffer.from(compressed);
  } else if (method === 8) {
    data = zlib.inflateRawSync(compressed);
  } else {
    throw new RuntimeError(`coral-needle zip compression method is unsupported: ${method}`);
  }
  if (data.length !== uncompressedSize) {
    throw new RuntimeError(`coral-needle zip entry size mismatch: expected ${uncompressedSize}, got ${data.length}`);
  }
  return data;
}

function zipCentralDirectoryOffset(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return archive.readUInt32LE(offset + 16);
    }
  }
  throw new RuntimeError('coral-needle zip end-of-central-directory record is missing');
}

function tarHeaderName(header: Buffer): string {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function tarHeaderSize(header: Buffer): number {
  const raw = tarString(header, 124, 12).trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new RuntimeError('coral-needle archive has an invalid tar size header');
  }
  return Number.parseInt(raw, 8);
}

function tarString(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function normalizePlatform(platform: NodeJS.Platform): CoralNeedlePlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new RuntimeError(`coral-needle ${CORAL_NEEDLE_VERSION} is not available for ${platform}`);
}

function normalizeArch(arch: NodeJS.Architecture | CoralNeedleArch): CoralNeedleArch {
  if (arch === 'x64' || arch === 'amd64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new RuntimeError(`coral-needle ${CORAL_NEEDLE_VERSION} is not available for ${arch}`);
}

function digestHex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
