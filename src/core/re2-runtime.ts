import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { optsidianCacheRoot } from './cache-root.js';
import {
  ensureExistingPrivateFileSync,
  ensurePrivateDirSync,
  writePrivateFileAtomicSync,
  writePrivateFileSync,
} from './private-path.js';
import { downloadFile } from '../net/github.js';
import { RuntimeError } from '../errors.js';

const RE2_WASM_VERSION = '1.0.2';
const RE2_WASM_TARBALL_SHA256 = '921fcca89d8a0fec91e4a4e175d016d5fc91770af44090b6f7925896bd985231';
const RE2_WASM_TARBALL_SHA512_BASE64 =
  'VXUdgSiUrE/WZXn6gUIVVIsg0+Hp6VPZPOaHCay+OuFKy6u/8ktmeNEf+U5qSA8jzGGFsg8jrDNu1BeHpz2pJA==';
const RE2_WASM_TARBALL_SIZE = 371_488;
const RE2_WASM_TARBALL_MAX_BYTES = 5 * 1024 * 1024;
const RE2_WASM_TARBALL_URL = `https://registry.npmjs.org/re2-wasm/-/re2-wasm-${RE2_WASM_VERSION}.tgz`;
const RE2_WASM_INSTALL_ID = `${RE2_WASM_VERSION}-${RE2_WASM_TARBALL_SHA256.slice(0, 16)}`;
const RE2_WASM_MANIFEST = 'optsidian-re2-wasm.json';
const RE2_WASM_INSTALL_TIMEOUT_MS = 30_000;
const RE2_WASM_LOCK_STALE_MS = 2 * 60 * 1000;

type Re2RuntimeFile = {
  tarPath: string;
  installPath: string;
  size: number;
  sha256: string;
};

const RE2_RUNTIME_FILES: Re2RuntimeFile[] = [
  {
    tarPath: 'package/build/src/re2.js',
    installPath: 'build/src/re2.js',
    size: 19_359,
    sha256: 'f3a4439f133118d55475e92eb43c15e6339ff59194835b0c0818d2e0f6cef9e1',
  },
  {
    tarPath: 'package/build/wasm/re2.js',
    installPath: 'build/wasm/re2.js',
    size: 216_772,
    sha256: '4bfa5d6a8dd0052da8d06baf171078a392dc9c70592d5dca90c9aefa9006336e',
  },
  {
    tarPath: 'package/build/wasm/re2.wasm',
    installPath: 'build/wasm/re2.wasm',
    size: 858_542,
    sha256: '79e025a30d20157807add5e7d01acefe700f06721f4a56669b0bad5d00995e72',
  },
  {
    tarPath: 'package/package.json',
    installPath: 'package.json',
    size: 1_033,
    sha256: '2245b33b842b891159696e9c35b2bb1164150fd784667f2a036a090bfb4af25d',
  },
  {
    tarPath: 'package/LICENSE',
    installPath: 'LICENSE',
    size: 11_357,
    sha256: '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd',
  },
];

type Re2RuntimeManifest = {
  package: 're2-wasm';
  version: string;
  tarballSha256: string;
  installedAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
};

type Re2Constructor = new (pattern: string, flags: string) => Re2Regex;

export type Re2Regex = {
  lastIndex: number;
  exec(input: string): RegExpExecArray | null;
  test(input: string): boolean;
};

let cachedRE2: Re2Constructor | undefined;
let cachedRuntimeDir: string | undefined;

function re2RuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), 're2-wasm', RE2_WASM_INSTALL_ID);
}

export async function ensureRe2Runtime(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const targetDir = re2RuntimeDir(env);
  if (isRe2RuntimeInstalled(targetDir)) return targetDir;

  ensurePrivateDirSync(optsidianCacheRoot(env), 'Optsidian cache directory');
  ensurePrivateDirSync(path.dirname(targetDir), 'Optsidian RE2 wasm cache directory');
  const release = await acquireInstallLock(
    path.join(path.dirname(targetDir), 'install.lock'),
    RE2_WASM_INSTALL_TIMEOUT_MS,
  );
  try {
    if (isRe2RuntimeInstalled(targetDir)) return targetDir;
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    const tempDir = path.join(
      path.dirname(targetDir),
      `.install-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    ensurePrivateDirSync(tempDir, 'Optsidian RE2 wasm temp directory');
    try {
      await installRe2Runtime(tempDir, env);
      fs.renameSync(tempDir, targetDir);
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    assertRe2RuntimeInstalled(targetDir);
    return targetDir;
  } finally {
    release();
  }
}

export function getRe2ClassSync(env: NodeJS.ProcessEnv = process.env): Re2Constructor {
  const runtimeDir = re2RuntimeDir(env);
  if (cachedRE2 && cachedRuntimeDir === runtimeDir) return cachedRE2;
  assertRe2RuntimeInstalled(runtimeDir);
  try {
    const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
    const loaded = requireFromRuntime(path.join(runtimeDir, 'build/src/re2.js')) as { RE2?: unknown };
    if (typeof loaded.RE2 !== 'function') {
      throw new RuntimeError('RE2 wasm runtime did not export RE2');
    }
    cachedRuntimeDir = runtimeDir;
    cachedRE2 = loaded.RE2 as Re2Constructor;
    return cachedRE2;
  } catch (error) {
    throw new RuntimeError(`Failed to load RE2 wasm runtime: ${errorMessage(error)}`);
  }
}

function isRe2RuntimeInstalled(runtimeDir = re2RuntimeDir()): boolean {
  try {
    assertRe2RuntimeInstalled(runtimeDir);
    return true;
  } catch {
    return false;
  }
}

function assertRe2RuntimeInstalled(runtimeDir: string): void {
  if (!fs.existsSync(runtimeDir)) {
    throw new RuntimeError(`RE2 wasm runtime is not installed: ${runtimeDir}`);
  }
  ensurePrivateDirSync(runtimeDir, 'Optsidian RE2 wasm runtime directory');
  const manifestPath = path.join(runtimeDir, RE2_WASM_MANIFEST);
  if (!ensureExistingPrivateFileSync(manifestPath, 'Optsidian RE2 wasm manifest')) {
    throw new RuntimeError(`RE2 wasm runtime is not installed: ${runtimeDir}`);
  }
  const manifest = readManifest(manifestPath);
  if (
    manifest.package !== 're2-wasm' ||
    manifest.version !== RE2_WASM_VERSION ||
    manifest.tarballSha256 !== RE2_WASM_TARBALL_SHA256
  ) {
    throw new RuntimeError(`RE2 wasm runtime manifest is invalid: ${manifestPath}`);
  }
  for (const file of RE2_RUNTIME_FILES) {
    assertRuntimeFile(runtimeDir, file);
  }
}

async function installRe2Runtime(tempDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const tarballPath = path.join(tempDir, `re2-wasm-${RE2_WASM_VERSION}.tgz`);
  await downloadFile(re2WasmTarballUrl(env), tarballPath, env, {
    sendAuth: false,
    maxBytes: RE2_WASM_TARBALL_MAX_BYTES,
  });
  const tarball = fs.readFileSync(tarballPath);
  verifyTarball(tarball);
  extractRuntimeFiles(tarball, tempDir);
  writePrivateFileSync(
    path.join(tempDir, RE2_WASM_MANIFEST),
    `${JSON.stringify(runtimeManifest(), null, 2)}\n`,
    'Optsidian RE2 wasm manifest',
  );
  fs.rmSync(tarballPath, { force: true });
}

function re2WasmTarballUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.OPTSIDIAN_RE2_WASM_TARBALL_URL?.trim();
  const raw = configured ? configured : RE2_WASM_TARBALL_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RuntimeError(`RE2 wasm tarball URL is invalid: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new RuntimeError('RE2 wasm tarball URL must use https');
  }
  return parsed.toString();
}

function verifyTarball(tarball: Buffer): void {
  if (tarball.length !== RE2_WASM_TARBALL_SIZE) {
    throw new RuntimeError(`RE2 wasm tarball size mismatch: expected ${RE2_WASM_TARBALL_SIZE}, got ${tarball.length}`);
  }
  const sha256 = digestHex(tarball);
  if (sha256 !== RE2_WASM_TARBALL_SHA256) {
    throw new RuntimeError('RE2 wasm tarball sha256 mismatch');
  }
  const sha512 = crypto.createHash('sha512').update(tarball).digest('base64');
  if (sha512 !== RE2_WASM_TARBALL_SHA512_BASE64) {
    throw new RuntimeError('RE2 wasm tarball integrity mismatch');
  }
}

function extractRuntimeFiles(tarball: Buffer, tempDir: string): void {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(tarball);
  } catch (error) {
    throw new RuntimeError(`Failed to decompress RE2 wasm tarball: ${errorMessage(error)}`);
  }
  const required = new Map(RE2_RUNTIME_FILES.map((file) => [file.tarPath, file]));
  const found = new Set<string>();
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
      throw new RuntimeError(`RE2 wasm tarball entry exceeds archive size: ${name}`);
    }
    const file = required.get(name);
    if (file) {
      if (type !== '0' && type !== '\0') {
        throw new RuntimeError(`RE2 wasm tarball entry is not a regular file: ${name}`);
      }
      const data = tar.subarray(dataStart, dataEnd);
      verifyRuntimeFileData(file, data);
      const target = safeInstallPath(tempDir, file.installPath);
      writePrivateFileAtomicSync(target, data, 'Optsidian RE2 wasm runtime file');
      found.add(name);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const file of RE2_RUNTIME_FILES) {
    if (!found.has(file.tarPath)) {
      throw new RuntimeError(`RE2 wasm tarball is missing ${file.tarPath}`);
    }
  }
}

function assertRuntimeFile(runtimeDir: string, file: Re2RuntimeFile): void {
  const target = safeInstallPath(runtimeDir, file.installPath);
  if (!ensureExistingPrivateFileSync(target, 'Optsidian RE2 wasm runtime file')) {
    throw new RuntimeError(`RE2 wasm runtime file is missing: ${file.installPath}`);
  }
  const data = fs.readFileSync(target);
  verifyRuntimeFileData(file, data);
}

function verifyRuntimeFileData(file: Re2RuntimeFile, data: Buffer): void {
  if (data.length !== file.size) {
    throw new RuntimeError(`RE2 wasm runtime file size mismatch for ${file.installPath}`);
  }
  const sha256 = digestHex(data);
  if (sha256 !== file.sha256) {
    throw new RuntimeError(`RE2 wasm runtime file sha256 mismatch for ${file.installPath}`);
  }
}

function safeInstallPath(root: string, relPath: string): string {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) {
    throw new RuntimeError(`Unsafe RE2 wasm runtime path: ${relPath}`);
  }
  return path.join(root, relPath);
}

function readManifest(filePath: string): Re2RuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new RuntimeError(`RE2 wasm manifest is not readable: ${errorMessage(error)}`);
  }
  if (!isManifest(parsed)) {
    throw new RuntimeError(`RE2 wasm manifest is invalid: ${filePath}`);
  }
  return parsed;
}

function runtimeManifest(): Re2RuntimeManifest {
  return {
    package: 're2-wasm',
    version: RE2_WASM_VERSION,
    tarballSha256: RE2_WASM_TARBALL_SHA256,
    installedAt: new Date().toISOString(),
    files: RE2_RUNTIME_FILES.map((file) => ({
      path: file.installPath,
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

function isManifest(value: unknown): value is Re2RuntimeManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Re2RuntimeManifest>;
  return (
    record.package === 're2-wasm' &&
    typeof record.version === 'string' &&
    typeof record.tarballSha256 === 'string' &&
    typeof record.installedAt === 'string' &&
    Array.isArray(record.files)
  );
}

function tarHeaderName(header: Buffer): string {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function tarHeaderSize(header: Buffer): number {
  const raw = tarString(header, 124, 12).trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new RuntimeError('RE2 wasm tarball has an invalid tar size header');
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

async function acquireInstallLock(lockDir: string, timeoutMs: number): Promise<() => void> {
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      ensurePrivateDirSync(lockDir, 'Optsidian RE2 wasm install lock directory');
      writePrivateFileSync(
        path.join(lockDir, 'owner.json'),
        `${JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'Optsidian RE2 wasm install lock owner',
      );
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (removeStaleInstallLock(lockDir)) continue;
      if (Date.now() - start >= timeoutMs) {
        throw new RuntimeError(`Timed out waiting for RE2 wasm install lock: ${lockDir}`);
      }
      await sleep(50);
    }
  }
}

function removeStaleInstallLock(lockDir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs < RE2_WASM_LOCK_STALE_MS) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function digestHex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
