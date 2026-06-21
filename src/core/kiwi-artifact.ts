import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { RuntimeError } from "../errors.js";
import { optsidianCacheRoot } from "./cache-root.js";

export const KIWI_NLP_VERSION = "0.23.0";
export const KIWI_MODEL_VERSION = "0.23.0";
export const KIWI_MODEL_TYPE = "cong-global";
export const KIWI_MODEL_RELEASE_TAG = `v${KIWI_MODEL_VERSION}`;
export const KIWI_MODEL_ASSET_NAME = `kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;
export const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_RELEASE_TAG}/${KIWI_MODEL_ASSET_NAME}`;
export const KIWI_MODEL_SHA256 = "355a006ab0bd4dec171cdca8e0b0d951e82bd5bc5993265421d8961876f20430";
export const KIWI_MODEL_ARCHIVE_SIZE_BYTES = 88_069_544;
export const KIWI_MODEL_TAR_PREFIX = "models/cong/base/";
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

const KIWI_MODEL_DIR_NAME = "cong-base";
const KIWI_MODEL_MANIFEST_FILE = "manifest.json";
const KIWI_INSTALL_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPES = new Set(["0", ""]);

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

export function inspectKiwiModelArtifact(env: NodeJS.ProcessEnv = process.env): KiwiModelArtifactState {
  const manifest = readInstalledManifest(env);
  const missingFiles = KIWI_MODEL_FILES.filter((fileName) => !isFile(kiwiModelFilePath(fileName, env)));
  return {
    targetDir: kiwiModelDir(env),
    manifestPath: kiwiModelManifestPath(env),
    installed: manifest !== null && missingFiles.length === 0,
    manifest,
    missingFiles
  };
}

export async function ensureKiwiModelArtifact(env: NodeJS.ProcessEnv = process.env): Promise<KiwiModelArtifactInstallResult> {
  const dataDir = kiwiDataDir(env);
  fs.mkdirSync(dataDir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = await acquireInstallLock(path.join(dataDir, "install.lock"), KIWI_INSTALL_LOCK_TIMEOUT_MS);
    const current = inspectKiwiModelArtifact(env);
    if (current.installed) {
      return {
        status: "already_installed",
        method: "github-release",
        version: KIWI_MODEL_VERSION,
        targetDir: current.targetDir
      };
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

function readInstalledManifest(env: NodeJS.ProcessEnv): KiwiModelArtifactManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(kiwiModelManifestPath(env), "utf8")) as unknown;
    return isKiwiModelArtifactManifest(parsed) ? parsed : null;
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

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "optsidian"
    }
  });
  if (!response.ok) {
    throw new RuntimeError(`Failed to download Kiwi model: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
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

function acquireInstallLock(lockDir: string, timeoutMs: number): Promise<() => void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        resolve(() => fs.rmSync(lockDir, { recursive: true, force: true }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          reject(error);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new RuntimeError(`Timed out waiting for Kiwi model install lock: ${lockDir}`));
          return;
        }
        setTimeout(attempt, 25);
      }
    };
    attempt();
  });
}

function tarFieldToString(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/\0.*$/, "").trim();
}

function tarFieldToNumber(buffer: Buffer): number {
  const raw = tarFieldToString(buffer);
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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
