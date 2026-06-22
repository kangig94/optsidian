import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { RuntimeError } from "../../errors.js";
import { optsidianCacheRoot } from "../cache-root.js";

export const KIWI_NLP_VERSION = "0.23.0";
export const KIWI_MODEL_VERSION = "0.23.0";
export const KIWI_MODEL_TYPE = "cong-global";
export const KIWI_MODEL_RELEASE_TAG = `v${KIWI_MODEL_VERSION}`;
export const KIWI_MODEL_ASSET_NAME = `kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;
export const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_RELEASE_TAG}/${KIWI_MODEL_ASSET_NAME}`;
export const KIWI_MODEL_SHA256 = "355a006ab0bd4dec171cdca8e0b0d951e82bd5bc5993265421d8961876f20430";
export const KIWI_MODEL_ARCHIVE_SIZE_BYTES = 88_069_544;
export const KIWI_MODEL_TAR_PREFIX = "models/cong/base/";
export const KIWI_WASM_FILE_NAME = "kiwi-wasm.wasm";
export const KIWI_WASM_NPM_TARBALL_URL = `https://registry.npmjs.org/kiwi-nlp/-/kiwi-nlp-${KIWI_NLP_VERSION}.tgz`;
export const KIWI_WASM_TAR_PATH = `package/dist/${KIWI_WASM_FILE_NAME}`;
export const KIWI_WASM_SHA256 = "1b78e48701468610cbb49b34105fd297dc1252774ef5c861ebf80fd6cc7d664e";
export const KIWI_WASM_SIZE_BYTES = 3_779_034;
export const KIWI_MODEL_FILES = [
  "sj.morph",
  "default.dict",
  "dialect.dict",
  "multi.dict",
  "typo.dict",
  "combiningRule.txt",
  "cong.mdl",
  "extract.mdl",
  "nounchr.mdl"
] as const;

export type KiwiModelFileName = (typeof KIWI_MODEL_FILES)[number];

// Extracted file hashes for the archive pinned by KIWI_MODEL_SHA256.
const KIWI_MODEL_FILE_SHA256: Record<KiwiModelFileName, string> = {
  "sj.morph": "5e3dab2def6d2cc079e21d5477bd610a391c69045d08caf1e0bbeabda8db8d1b",
  "default.dict": "d4293e44b2588d0c3aabbce607a0f41ad3534abd31b34139847b127254e01549",
  "dialect.dict": "bb6f0ab37dbfcc0fd33dc679121218d24725ae438f31bb362f9b24703e93cda2",
  "multi.dict": "e9eff7712d163b214c750333a5d388ab77b50ec386ae55b360babcd24c0c3195",
  "typo.dict": "aa15e48fcd32886441fc1ff9719a3109d3192e91d4b67efbd64260610d68322d",
  "combiningRule.txt": "3d864f76eade67b250d37f4ee83de848b04fb14d0cd6ed36c36d0b210ad38ebc",
  "cong.mdl": "bd9ca89ee1b72e750c8e2166a17c80a0fe3fabd828c78b1f0928486a6b1833a7",
  "extract.mdl": "a0c92ffc051e43ae497845cdb8d4c8b9e2f359893cb55c67279c76d1d531ee17",
  "nounchr.mdl": "4b687e36836dd60dcb7addcfcf369ac082b339bab76549574ac1ce2b7ccd6836"
};

export type KiwiModelArtifactManifest = {
  packageId: "kiwi";
  kiwiNlpVersion: string;
  modelVersion: string;
  modelType: typeof KIWI_MODEL_TYPE;
  sourceUrl: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  files: readonly KiwiModelFileName[];
  installedAt: string;
};

export type KiwiModelArtifactState = {
  targetDir: string;
  manifestPath: string;
  installed: boolean;
  manifest: KiwiModelArtifactManifest | null;
  missingFiles: string[];
};

export type KiwiModelArtifactInspectOptions = {
  verifyFiles?: "digest" | "metadata";
};

export type KiwiModelArtifactEnsureOptions = KiwiModelArtifactInspectOptions & {
  forceInstall?: boolean;
};

export type KiwiWasmArtifactManifest = {
  packageId: "kiwi-wasm";
  kiwiNlpVersion: string;
  sourceUrl: string;
  wasmSha256: string;
  wasmSizeBytes: number;
  file: typeof KIWI_WASM_FILE_NAME;
  installedAt: string;
};

export type KiwiWasmArtifactState = {
  targetDir: string;
  manifestPath: string;
  wasmPath: string;
  installed: boolean;
  manifest: KiwiWasmArtifactManifest | null;
  missingFiles: string[];
};

export type KiwiWasmArtifactInspectOptions = {
  verifyFile?: "digest" | "metadata";
};

export type KiwiWasmArtifactEnsureOptions = KiwiWasmArtifactInspectOptions & {
  forceInstall?: boolean;
};

export type KiwiModelArtifactInstallResult =
  | {
      status: "installed" | "already_installed";
      method: "github-release";
      version: string;
      targetDir: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
    };

export type KiwiWasmArtifactInstallResult =
  | {
      status: "installed" | "already_installed";
      method: "npm-tarball";
      version: string;
      targetDir: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
    };

const KIWI_MODEL_DIR_NAME = "cong-base";
const KIWI_MODEL_MANIFEST_FILE = "manifest.json";
const KIWI_WASM_MANIFEST_FILE = "manifest.json";
const KIWI_INSTALL_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const KIWI_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;
const KIWI_INSTALL_LOCK_POLL_MS = 25;
const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPES = new Set(["0", ""]);
let kiwiInstallLockStaleMs = KIWI_INSTALL_LOCK_STALE_MS;

export function __setKiwiInstallLockStaleMsForTests(value: number | undefined): void {
  kiwiInstallLockStaleMs = value ?? KIWI_INSTALL_LOCK_STALE_MS;
}

export function kiwiDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), "kiwi");
}

export function kiwiModelDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiDataDir(env), "models", `v${KIWI_MODEL_VERSION}`, KIWI_MODEL_DIR_NAME);
}

export function kiwiModelManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiModelDir(env), KIWI_MODEL_MANIFEST_FILE);
}

export function kiwiModelFilePath(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiModelDir(env), fileName);
}

export function kiwiWasmDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiDataDir(env), "wasm", `v${KIWI_NLP_VERSION}`);
}

export function kiwiWasmManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiWasmDir(env), KIWI_WASM_MANIFEST_FILE);
}

export function kiwiWasmFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiwiWasmDir(env), KIWI_WASM_FILE_NAME);
}

export function inspectKiwiModelArtifact(
  env: NodeJS.ProcessEnv = process.env,
  options: KiwiModelArtifactInspectOptions = {}
): KiwiModelArtifactState {
  const manifest = readInstalledManifest(env);
  const missingFiles = inspectKiwiModelFiles(env, options.verifyFiles ?? "digest");
  return {
    targetDir: kiwiModelDir(env),
    manifestPath: kiwiModelManifestPath(env),
    installed: manifest !== null && missingFiles.length === 0,
    manifest,
    missingFiles
  };
}

export function readVerifiedKiwiModelFiles(env: NodeJS.ProcessEnv = process.env): Record<KiwiModelFileName, Uint8Array> {
  const files = {} as Record<KiwiModelFileName, Uint8Array>;
  for (const fileName of KIWI_MODEL_FILES) {
    files[fileName] = readVerifiedKiwiModelFile(fileName, env);
  }
  return files;
}

export function inspectKiwiWasmArtifact(
  env: NodeJS.ProcessEnv = process.env,
  options: KiwiWasmArtifactInspectOptions = {}
): KiwiWasmArtifactState {
  const manifest = readInstalledWasmManifest(env);
  const missingFiles = inspectKiwiWasmFile(env, options.verifyFile ?? "digest");
  return {
    targetDir: kiwiWasmDir(env),
    manifestPath: kiwiWasmManifestPath(env),
    wasmPath: kiwiWasmFilePath(env),
    installed: manifest !== null && missingFiles.length === 0,
    manifest,
    missingFiles
  };
}

export function readVerifiedKiwiWasmBinary(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const wasmPath = kiwiWasmFilePath(env);
  let content: Buffer;
  try {
    content = fs.readFileSync(wasmPath);
  } catch (error) {
    throw new RuntimeError(`Kiwi wasm file is not readable: ${errorMessage(error)}`);
  }
  const digest = kiwiWasmDigest(content);
  if (content.length !== KIWI_WASM_SIZE_BYTES) {
    throw new RuntimeError(`Kiwi wasm size mismatch: expected ${KIWI_WASM_SIZE_BYTES}, got ${content.length}`);
  }
  if (digest !== KIWI_WASM_SHA256) {
    throw new RuntimeError(`Kiwi wasm digest mismatch: expected ${KIWI_WASM_SHA256}, got ${digest}`);
  }
  return content;
}

export async function ensureKiwiModelArtifact(
  env: NodeJS.ProcessEnv = process.env,
  options: KiwiModelArtifactEnsureOptions = {}
): Promise<KiwiModelArtifactInstallResult> {
  const dataDir = kiwiDataDir(env);
  fs.mkdirSync(dataDir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = await acquireInstallLock(path.join(dataDir, "install.lock"), KIWI_INSTALL_LOCK_TIMEOUT_MS);
    if (options.forceInstall !== true) {
      const current = inspectKiwiModelArtifact(env, { verifyFiles: options.verifyFiles ?? "digest" });
      if (current.installed) {
        return {
          status: "already_installed",
          method: "github-release",
          version: KIWI_MODEL_VERSION,
          targetDir: current.targetDir
        };
      }
    }
    return await installDownloadedModel(env);
  } catch (error) {
    return {
      status: "error",
      code: errorCode(error),
      message: errorMessage(error)
    };
  } finally {
    release?.();
  }
}

export async function ensureKiwiWasmArtifact(
  env: NodeJS.ProcessEnv = process.env,
  options: KiwiWasmArtifactEnsureOptions = {}
): Promise<KiwiWasmArtifactInstallResult> {
  const dataDir = kiwiDataDir(env);
  fs.mkdirSync(dataDir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = await acquireInstallLock(path.join(dataDir, "wasm-install.lock"), KIWI_INSTALL_LOCK_TIMEOUT_MS);
    if (options.forceInstall !== true) {
      const current = inspectKiwiWasmArtifact(env, { verifyFile: options.verifyFile ?? "digest" });
      if (current.installed) {
        return {
          status: "already_installed",
          method: "npm-tarball",
          version: KIWI_NLP_VERSION,
          targetDir: current.targetDir
        };
      }
    }
    return await installDownloadedWasm(env);
  } catch (error) {
    return {
      status: "error",
      code: errorCode(error),
      message: errorMessage(error)
    };
  } finally {
    release?.();
  }
}

function readInstalledManifest(env: NodeJS.ProcessEnv): KiwiModelArtifactManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(kiwiModelManifestPath(env), "utf8")) as unknown;
    return isKiwiModelArtifactManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readInstalledWasmManifest(env: NodeJS.ProcessEnv): KiwiWasmArtifactManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(kiwiWasmManifestPath(env), "utf8")) as unknown;
    return isKiwiWasmArtifactManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isKiwiModelArtifactManifest(value: unknown): value is KiwiModelArtifactManifest {
  const files = isRecord(value) && Array.isArray(value.files) ? value.files : null;
  return (
    isRecord(value) &&
    value.packageId === "kiwi" &&
    value.kiwiNlpVersion === KIWI_NLP_VERSION &&
    value.modelVersion === KIWI_MODEL_VERSION &&
    value.modelType === KIWI_MODEL_TYPE &&
    value.sourceUrl === KIWI_MODEL_URL &&
    value.archiveSha256 === KIWI_MODEL_SHA256 &&
    value.archiveSizeBytes === KIWI_MODEL_ARCHIVE_SIZE_BYTES &&
    files !== null &&
    files.length === KIWI_MODEL_FILES.length &&
    KIWI_MODEL_FILES.every((fileName) => files.includes(fileName)) &&
    typeof value.installedAt === "string"
  );
}

function isKiwiWasmArtifactManifest(value: unknown): value is KiwiWasmArtifactManifest {
  return (
    isRecord(value) &&
    value.packageId === "kiwi-wasm" &&
    value.kiwiNlpVersion === KIWI_NLP_VERSION &&
    value.sourceUrl === KIWI_WASM_NPM_TARBALL_URL &&
    value.wasmSha256 === KIWI_WASM_SHA256 &&
    value.wasmSizeBytes === KIWI_WASM_SIZE_BYTES &&
    value.file === KIWI_WASM_FILE_NAME &&
    typeof value.installedAt === "string"
  );
}

async function installDownloadedModel(env: NodeJS.ProcessEnv): Promise<KiwiModelArtifactInstallResult> {
  const archive = await downloadBuffer(KIWI_MODEL_URL);
  if (archive.length !== KIWI_MODEL_ARCHIVE_SIZE_BYTES) {
    throw new RuntimeError(`Kiwi model archive size mismatch: expected ${KIWI_MODEL_ARCHIVE_SIZE_BYTES}, got ${archive.length}`);
  }
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  if (digest !== KIWI_MODEL_SHA256) {
    throw new RuntimeError(`Kiwi model archive digest mismatch: expected ${KIWI_MODEL_SHA256}, got ${digest}`);
  }

  const modelFiles = extractKiwiModelFiles(archive);
  writeModelFilesAtomic(env, modelFiles);
  return {
    status: "installed",
    method: "github-release",
    version: KIWI_MODEL_VERSION,
    targetDir: kiwiModelDir(env)
  };
}

async function installDownloadedWasm(env: NodeJS.ProcessEnv): Promise<KiwiWasmArtifactInstallResult> {
  const archive = await downloadBuffer(KIWI_WASM_NPM_TARBALL_URL);
  const wasm = extractKiwiWasmFile(archive);
  if (wasm.length !== KIWI_WASM_SIZE_BYTES) {
    throw new RuntimeError(`Kiwi wasm size mismatch: expected ${KIWI_WASM_SIZE_BYTES}, got ${wasm.length}`);
  }
  const digest = crypto.createHash("sha256").update(wasm).digest("hex");
  if (digest !== KIWI_WASM_SHA256) {
    throw new RuntimeError(`Kiwi wasm digest mismatch: expected ${KIWI_WASM_SHA256}, got ${digest}`);
  }

  writeWasmFileAtomic(env, wasm);
  return {
    status: "installed",
    method: "npm-tarball",
    version: KIWI_NLP_VERSION,
    targetDir: kiwiWasmDir(env)
  };
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "optsidian"
    }
  });
  if (!response.ok) {
    throw new RuntimeError(`Failed to download Kiwi artifact from ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function extractKiwiWasmFile(archiveBuffer: Buffer): Buffer {
  const tarBuffer = zlib.gunzipSync(archiveBuffer);
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = tarFieldToString(header.subarray(0, 100));
    const prefix = tarFieldToString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarFieldToNumber(header.subarray(124, 136));
    const typeFlag = header[156] === 0 ? "" : String.fromCharCode(header[156]);
    offset += TAR_BLOCK_SIZE;

    const data = tarBuffer.subarray(offset, offset + size);
    if (TAR_FILE_TYPES.has(typeFlag) && fullName === KIWI_WASM_TAR_PATH) {
      return Buffer.from(data);
    }

    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  throw new RuntimeError(`Kiwi npm tarball is missing required file: ${KIWI_WASM_TAR_PATH}`);
}

function extractKiwiModelFiles(archiveBuffer: Buffer): Map<KiwiModelFileName, Buffer> {
  const tarBuffer = zlib.gunzipSync(archiveBuffer);
  const required = new Set<string>(KIWI_MODEL_FILES);
  const files = new Map<KiwiModelFileName, Buffer>();
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = tarFieldToString(header.subarray(0, 100));
    const prefix = tarFieldToString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarFieldToNumber(header.subarray(124, 136));
    const typeFlag = header[156] === 0 ? "" : String.fromCharCode(header[156]);
    offset += TAR_BLOCK_SIZE;

    const data = tarBuffer.subarray(offset, offset + size);
    if (TAR_FILE_TYPES.has(typeFlag) && fullName.startsWith(KIWI_MODEL_TAR_PREFIX)) {
      const fileName = fullName.slice(KIWI_MODEL_TAR_PREFIX.length);
      if (required.has(fileName) && !fileName.includes("/")) {
        files.set(fileName as KiwiModelFileName, Buffer.from(data));
      }
    }

    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  const missing = KIWI_MODEL_FILES.filter((fileName) => !files.has(fileName));
  if (missing.length > 0) throw new RuntimeError(`Kiwi model archive is missing required files: ${missing.join(", ")}`);
  return files;
}

function inspectKiwiModelFiles(env: NodeJS.ProcessEnv, verifyFiles: "digest" | "metadata"): string[] {
  const missingFiles: string[] = [];
  for (const fileName of KIWI_MODEL_FILES) {
    const modelPath = kiwiModelFilePath(fileName, env);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(modelPath);
    } catch {
      missingFiles.push(fileName);
      continue;
    }
    if (!stat.isFile()) {
      missingFiles.push(fileName);
      continue;
    }
    if (verifyFiles === "metadata") continue;
    let digest: string;
    try {
      digest = kiwiModelFileDigest(fs.readFileSync(modelPath));
    } catch {
      missingFiles.push(`${fileName} (read failed)`);
      continue;
    }
    if (digest !== KIWI_MODEL_FILE_SHA256[fileName]) {
      missingFiles.push(`${fileName} (digest mismatch)`);
    }
  }
  return missingFiles;
}

function readVerifiedKiwiModelFile(fileName: KiwiModelFileName, env: NodeJS.ProcessEnv): Uint8Array {
  const modelPath = kiwiModelFilePath(fileName, env);
  let content: Buffer;
  try {
    content = fs.readFileSync(modelPath);
  } catch (error) {
    throw new RuntimeError(`Kiwi model file ${fileName} is not readable: ${errorMessage(error)}`);
  }
  const digest = kiwiModelFileDigest(content);
  if (digest !== KIWI_MODEL_FILE_SHA256[fileName]) {
    throw new RuntimeError(`Kiwi model file ${fileName} digest mismatch: expected ${KIWI_MODEL_FILE_SHA256[fileName]}, got ${digest}`);
  }
  return content;
}

function kiwiModelFileDigest(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function inspectKiwiWasmFile(env: NodeJS.ProcessEnv, verifyFile: "digest" | "metadata"): string[] {
  const wasmPath = kiwiWasmFilePath(env);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(wasmPath);
  } catch {
    return [KIWI_WASM_FILE_NAME];
  }
  if (!stat.isFile()) return [KIWI_WASM_FILE_NAME];
  if (stat.size !== KIWI_WASM_SIZE_BYTES) return [`${KIWI_WASM_FILE_NAME} (size mismatch)`];
  if (verifyFile === "metadata") return [];
  let digest: string;
  try {
    digest = kiwiWasmDigest(fs.readFileSync(wasmPath));
  } catch {
    return [`${KIWI_WASM_FILE_NAME} (read failed)`];
  }
  if (digest !== KIWI_WASM_SHA256) return [`${KIWI_WASM_FILE_NAME} (digest mismatch)`];
  return [];
}

function kiwiWasmDigest(content: Uint8Array): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function writeWasmFileAtomic(env: NodeJS.ProcessEnv, wasm: Buffer): void {
  const targetDir = kiwiWasmDir(env);
  const parentDir = path.dirname(targetDir);
  const stagingDir = path.join(parentDir, `.wasm-${process.pid}-${Date.now()}.part`);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(stagingDir, KIWI_WASM_FILE_NAME), wasm);
    fs.writeFileSync(path.join(stagingDir, KIWI_WASM_MANIFEST_FILE), `${JSON.stringify(createWasmManifest(), null, 2)}\n`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function writeModelFilesAtomic(env: NodeJS.ProcessEnv, modelFiles: ReadonlyMap<KiwiModelFileName, Buffer>): void {
  const targetDir = kiwiModelDir(env);
  const parentDir = path.dirname(targetDir);
  const stagingDir = path.join(parentDir, `.cong-base-${process.pid}-${Date.now()}.part`);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const fileName of KIWI_MODEL_FILES) {
      const content = modelFiles.get(fileName);
      if (!content) throw new RuntimeError(`Kiwi model file ${fileName} was not extracted`);
      fs.writeFileSync(path.join(stagingDir, fileName), content);
    }
    fs.writeFileSync(path.join(stagingDir, KIWI_MODEL_MANIFEST_FILE), `${JSON.stringify(createManifest(), null, 2)}\n`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function createManifest(): KiwiModelArtifactManifest {
  return {
    packageId: "kiwi",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE,
    sourceUrl: KIWI_MODEL_URL,
    archiveSha256: KIWI_MODEL_SHA256,
    archiveSizeBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES,
    files: [...KIWI_MODEL_FILES],
    installedAt: new Date().toISOString()
  };
}

function createWasmManifest(): KiwiWasmArtifactManifest {
  return {
    packageId: "kiwi-wasm",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    sourceUrl: KIWI_WASM_NPM_TARBALL_URL,
    wasmSha256: KIWI_WASM_SHA256,
    wasmSizeBytes: KIWI_WASM_SIZE_BYTES,
    file: KIWI_WASM_FILE_NAME,
    installedAt: new Date().toISOString()
  };
}

async function acquireInstallLock(lockDir: string, timeoutMs: number): Promise<() => void> {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      writeInstallLockOwner(lockDir);
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!isPathExistsError(error)) throw error;
      if (removeStaleInstallLock(lockDir)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new RuntimeError(`Timed out waiting for Kiwi model install lock: ${lockDir}`);
      }
      await sleep(KIWI_INSTALL_LOCK_POLL_MS);
    }
  }
}

function writeInstallLockOwner(lockDir: string): void {
  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`);
  } catch {
    // The lock itself is the directory; owner metadata is best-effort diagnostics.
  }
}

function removeStaleInstallLock(lockDir: string): boolean {
  if (kiwiInstallLockStaleMs < 1) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
  if (Date.now() - stat.mtimeMs < kiwiInstallLockStaleMs) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tarFieldToString(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/\0.*$/, "").trim();
}

function tarFieldToNumber(buffer: Buffer): number {
  const raw = tarFieldToString(buffer);
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof RuntimeError ? "runtime_error" : (error as NodeJS.ErrnoException | undefined)?.code ?? "kiwi_model_install_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
