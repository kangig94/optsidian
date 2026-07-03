import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { optsidianCacheRoot } from '../../cache-root.js';
import { installArtifact } from '../../lifecycle/artifact-install.js';
import { ensurePrivateDirSync, writePrivateFileSync } from '../../private-path.js';
import { downloadFileStreaming } from '../../../net/github.js';
import { RuntimeError } from '../../../errors.js';

export type LocalOnnxModelKey = 'bge-m3' | 'multilingual-e5-small';
export type LocalOnnxModelAlias = LocalOnnxModelKey | 'e5-small' | 'BAAI/bge-m3' | 'intfloat/multilingual-e5-small';

export type LocalOnnxArtifactFileRole = 'model' | 'tokenizer';

export type LocalOnnxArtifactFile = {
  path: string;
  role: LocalOnnxArtifactFileRole;
  sha256: string;
  sizeBytes: number;
  requiredForSession?: true;
  requiredForTokenizer?: true;
};

export type LocalOnnxModelDescriptor = {
  key: LocalOnnxModelKey;
  modelId: string;
  revision: string;
  displayName: string;
  dim: number;
  maxTokens: number;
  pooling: 'mean';
  normalization: 'l2';
  quantization: 'none';
  dtype: 'float32';
  opset: number;
  inputTemplate: {
    default: string;
    query: string;
    document: string;
  };
  files: readonly LocalOnnxArtifactFile[];
};

export type LocalOnnxArtifactManifest = {
  packageId: 'dense-onnx';
  modelKey: LocalOnnxModelKey;
  modelId: string;
  revision: string;
  sourceBaseUrl: string;
  files: readonly LocalOnnxArtifactFile[];
  modelArtifactSha256: string;
  tokenizerArtifactSha256: string;
  installedAt: string;
};

export type LocalOnnxArtifactState = {
  targetDir: string;
  manifestPath: string;
  installed: boolean;
  manifest: LocalOnnxArtifactManifest | null;
  missingFiles: string[];
};

export type LocalOnnxArtifactEnsureOptions = {
  forceInstall?: boolean;
  verifyFiles?: 'metadata' | 'digest';
  descriptor?: LocalOnnxModelDescriptor;
  downloadFile?: typeof downloadFileStreaming;
  lockTimeoutMs?: number;
  lockPollMs?: number;
};

export type LocalOnnxArtifactInstallResult =
  | {
      status: 'installed' | 'already_installed';
      method: 'huggingface-resolve';
      modelKey: LocalOnnxModelKey;
      targetDir: string;
    }
  | {
      status: 'error';
      code: string;
      message: string;
    };

const LOCAL_ONNX_ARTIFACT_SCHEMA_VERSION = 'dense-onnx-artifacts-v1';
const LOCAL_ONNX_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_ONNX_INSTALL_POLL_MS = 25;

export const LOCAL_ONNX_RENDERED_TEXT_PROJECTION_VERSION = 'rendered-text-projection-v1';
export const LOCAL_ONNX_RECIPE_VERSION = 'local-onnx-embedding-recipe-v1';
export const ONNXRUNTIME_NODE_RUNTIME_VERSION = '1.27.0';
export const HUGGINGFACE_TOKENIZERS_RUNTIME_VERSION = '0.1.3';

export const LOCAL_ONNX_MODELS: Readonly<Record<LocalOnnxModelKey, LocalOnnxModelDescriptor>> = {
  'bge-m3': {
    key: 'bge-m3',
    modelId: 'BAAI/bge-m3',
    revision: '5617a9f61b028005a4858fdac845db406aefb181',
    displayName: 'BGE-M3',
    dim: 1024,
    maxTokens: 8192,
    pooling: 'mean',
    normalization: 'l2',
    quantization: 'none',
    dtype: 'float32',
    opset: 11,
    inputTemplate: {
      default: '{text}',
      query: '{text}',
      document: '{text}',
    },
    files: [
      {
        path: 'onnx/model.onnx',
        role: 'model',
        sha256: 'f84251230831afb359ab26d9fd37d5936d4d9bb5d1d5410e66442f630f24435b',
        sizeBytes: 724_923,
        requiredForSession: true,
      },
      {
        path: 'onnx/model.onnx_data',
        role: 'model',
        sha256: '1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4',
        sizeBytes: 2_266_820_608,
        requiredForSession: true,
      },
      {
        path: 'onnx/config.json',
        role: 'model',
        sha256: 'f24afd5de914fba8c668426c43d208a1a54022500c63b2c160be20891686fce8',
        sizeBytes: 698,
      },
      {
        path: 'onnx/tokenizer.json',
        role: 'tokenizer',
        sha256: '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790',
        sizeBytes: 17_082_821,
        requiredForTokenizer: true,
      },
      {
        path: 'onnx/tokenizer_config.json',
        role: 'tokenizer',
        sha256: '7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4',
        sizeBytes: 1_173,
        requiredForTokenizer: true,
      },
      {
        path: 'onnx/special_tokens_map.json',
        role: 'tokenizer',
        sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835',
        sizeBytes: 964,
      },
    ],
  },
  'multilingual-e5-small': {
    key: 'multilingual-e5-small',
    modelId: 'intfloat/multilingual-e5-small',
    revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
    displayName: 'multilingual-e5-small',
    dim: 384,
    maxTokens: 512,
    pooling: 'mean',
    normalization: 'l2',
    quantization: 'none',
    dtype: 'float32',
    opset: 11,
    inputTemplate: {
      default: 'passage: {text}',
      query: 'query: {text}',
      document: 'passage: {text}',
    },
    files: [
      {
        path: 'onnx/model.onnx',
        role: 'model',
        sha256: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
        sizeBytes: 470_268_510,
        requiredForSession: true,
      },
      {
        path: 'onnx/config.json',
        role: 'model',
        sha256: 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6',
        sizeBytes: 653,
      },
      {
        path: 'onnx/tokenizer.json',
        role: 'tokenizer',
        sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
        sizeBytes: 17_082_730,
        requiredForTokenizer: true,
      },
      {
        path: 'onnx/tokenizer_config.json',
        role: 'tokenizer',
        sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
        sizeBytes: 443,
        requiredForTokenizer: true,
      },
      {
        path: 'onnx/special_tokens_map.json',
        role: 'tokenizer',
        sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
        sizeBytes: 167,
      },
    ],
  },
};

export function resolveLocalOnnxModelKey(input: string | undefined | null): LocalOnnxModelKey {
  const normalized = (input ?? 'bge-m3').trim().toLowerCase();
  if (normalized === '' || normalized === 'bge' || normalized === 'bge-m3' || normalized === 'baai/bge-m3')
    return 'bge-m3';
  if (
    normalized === 'e5' ||
    normalized === 'e5-small' ||
    normalized === 'multilingual-e5-small' ||
    normalized === 'intfloat/multilingual-e5-small'
  ) {
    return 'multilingual-e5-small';
  }
  throw new RuntimeError(`unsupported local ONNX embedding model: ${input}`);
}

export function localOnnxModelDescriptor(input: LocalOnnxModelAlias | string | undefined): LocalOnnxModelDescriptor {
  return LOCAL_ONNX_MODELS[resolveLocalOnnxModelKey(input)];
}

export function localOnnxDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(optsidianCacheRoot(env), 'dense-onnx');
}

export function localOnnxModelDir(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const descriptor = localOnnxModelDescriptor(model);
  return path.join(localOnnxDataDir(env), descriptor.key, descriptor.revision);
}

export function localOnnxManifestPath(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(localOnnxModelDir(model, env), 'manifest.json');
}

export function localOnnxModelFilePath(
  model: LocalOnnxModelAlias | string | undefined,
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(localOnnxModelDir(model, env), filePath);
}

export function localOnnxSessionModelPath(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const descriptor = localOnnxModelDescriptor(model);
  const graph = descriptor.files.find((file) => file.requiredForSession && file.path.endsWith('.onnx'));
  if (!graph) throw new RuntimeError(`local ONNX model ${descriptor.key} does not declare a session graph`);
  return localOnnxModelFilePath(descriptor.key, graph.path, env);
}

export function localOnnxTokenizerJsonPath(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return localOnnxModelFilePath(model, 'onnx/tokenizer.json', env);
}

export function localOnnxTokenizerConfigPath(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return localOnnxModelFilePath(model, 'onnx/tokenizer_config.json', env);
}

export function inspectLocalOnnxModelArtifact(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
  options: { verifyFiles?: 'metadata' | 'digest'; descriptor?: LocalOnnxModelDescriptor } = {},
): LocalOnnxArtifactState {
  const descriptor = options.descriptor ?? localOnnxModelDescriptor(model);
  const manifest = readInstalledManifest(descriptor, env);
  const missingFiles = inspectLocalOnnxFiles(descriptor, env, options.verifyFiles ?? 'digest');
  return {
    targetDir: localOnnxModelDir(descriptor.key, env),
    manifestPath: localOnnxManifestPath(descriptor.key, env),
    installed: manifest !== null && missingFiles.length === 0,
    manifest,
    missingFiles,
  };
}

export async function ensureLocalOnnxModelArtifact(
  model: LocalOnnxModelAlias | string | undefined = 'bge-m3',
  env: NodeJS.ProcessEnv = process.env,
  options: LocalOnnxArtifactEnsureOptions = {},
): Promise<LocalOnnxArtifactInstallResult> {
  const descriptor = options.descriptor ?? localOnnxModelDescriptor(model);
  ensureLocalOnnxDataDir(env);
  try {
    const verifyDepth = options.verifyFiles ?? 'metadata';
    let acceptExisting = options.forceInstall !== true;
    const installed = await installArtifact<LocalOnnxArtifactState, typeof verifyDepth>({
      artifactDir: localOnnxModelDir(descriptor.key, env),
      claimDir: path.join(localOnnxDataDir(env), `${descriptor.key}.install.claim`),
      stagingRoot: path.join(localOnnxDataDir(env), 'staging'),
      verifyDepth,
      timeoutMs: options.lockTimeoutMs ?? LOCAL_ONNX_INSTALL_TIMEOUT_MS,
      pollMs: options.lockPollMs ?? LOCAL_ONNX_INSTALL_POLL_MS,
      verifyInstalled: (_artifactDir, depth) =>
        acceptExisting ? installedLocalOnnxModelArtifact(descriptor, env, depth) : undefined,
      stage: (stagingDir) =>
        stageDownloadedModel(descriptor, env, options.downloadFile ?? downloadFileStreaming, stagingDir),
      computeChecksum: (stagingDir) => verifyStagedLocalOnnxModel(descriptor, stagingDir),
      activate: (stagingDir, artifactDir) => {
        acceptExisting = true;
        replaceArtifactDir(stagingDir, artifactDir);
      },
    });
    return {
      status: installed.activated ? 'installed' : 'already_installed',
      method: 'huggingface-resolve',
      modelKey: descriptor.key,
      targetDir: installed.artifact.targetDir,
    };
  } catch (error) {
    return {
      status: 'error',
      code: errorCode(error),
      message: errorMessage(error),
    };
  }
}

export function localOnnxModelArtifactHash(descriptor: LocalOnnxModelDescriptor): string {
  return combinedFilesHash(descriptor.files.filter((file) => file.role === 'model'));
}

export function localOnnxTokenizerArtifactHash(descriptor: LocalOnnxModelDescriptor): string {
  return combinedFilesHash(descriptor.files.filter((file) => file.role === 'tokenizer'));
}

function readInstalledManifest(
  descriptor: LocalOnnxModelDescriptor,
  env: NodeJS.ProcessEnv,
): LocalOnnxArtifactManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(localOnnxManifestPath(descriptor.key, env), 'utf8')) as unknown;
    return isLocalOnnxArtifactManifest(parsed, descriptor) ? parsed : null;
  } catch {
    return null;
  }
}

function isLocalOnnxArtifactManifest(
  value: unknown,
  descriptor: LocalOnnxModelDescriptor,
): value is LocalOnnxArtifactManifest {
  if (!isRecord(value) || value.packageId !== 'dense-onnx') return false;
  if (
    value.modelKey !== descriptor.key ||
    value.modelId !== descriptor.modelId ||
    value.revision !== descriptor.revision
  )
    return false;
  if (value.sourceBaseUrl !== sourceBaseUrl(descriptor)) return false;
  if (value.modelArtifactSha256 !== localOnnxModelArtifactHash(descriptor)) return false;
  if (value.tokenizerArtifactSha256 !== localOnnxTokenizerArtifactHash(descriptor)) return false;
  const files = Array.isArray(value.files) ? value.files : null;
  if (!files || files.length !== descriptor.files.length) return false;
  if (typeof value.installedAt !== 'string') return false;
  return descriptor.files.every((file) =>
    files.some(
      (entry) =>
        isRecord(entry) &&
        entry.path === file.path &&
        entry.role === file.role &&
        entry.sha256 === file.sha256 &&
        entry.sizeBytes === file.sizeBytes,
    ),
  );
}

function installedLocalOnnxModelArtifact(
  descriptor: LocalOnnxModelDescriptor,
  env: NodeJS.ProcessEnv,
  verifyFiles: 'metadata' | 'digest',
): LocalOnnxArtifactState | undefined {
  const current = inspectLocalOnnxModelArtifact(descriptor.key, env, { verifyFiles, descriptor });
  return current.installed ? current : undefined;
}

async function stageDownloadedModel(
  descriptor: LocalOnnxModelDescriptor,
  env: NodeJS.ProcessEnv,
  downloadFile: typeof downloadFileStreaming,
  stagingDir: string,
): Promise<void> {
  for (const file of descriptor.files) {
    const target = path.join(stagingDir, file.path);
    ensurePrivateDirSync(path.dirname(target), 'Optsidian local ONNX artifact directory');
    await downloadFile(sourceUrl(descriptor, file), target, env, {
      sendAuth: false,
      maxBytes: file.sizeBytes,
    });
    await verifyLocalOnnxFile(target, file);
  }
  writePrivateFileSync(
    path.join(stagingDir, 'manifest.json'),
    `${JSON.stringify(createManifest(descriptor), null, 2)}\n`,
    'Optsidian local ONNX manifest',
  );
}

function inspectLocalOnnxFiles(
  descriptor: LocalOnnxModelDescriptor,
  env: NodeJS.ProcessEnv,
  verifyFiles: 'metadata' | 'digest',
): string[] {
  const missingFiles: string[] = [];
  for (const file of descriptor.files) {
    const filePath = localOnnxModelFilePath(descriptor.key, file.path, env);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      missingFiles.push(file.path);
      continue;
    }
    if (!stat.isFile()) {
      missingFiles.push(file.path);
      continue;
    }
    if (stat.size !== file.sizeBytes) {
      missingFiles.push(`${file.path} (size mismatch)`);
      continue;
    }
    if (verifyFiles === 'metadata') continue;
    const digest = sha256FileSync(filePath);
    if (digest !== file.sha256) missingFiles.push(`${file.path} (digest mismatch)`);
  }
  return missingFiles;
}

async function verifyLocalOnnxFile(filePath: string, file: LocalOnnxArtifactFile): Promise<void> {
  const stat = fs.statSync(filePath);
  if (stat.size !== file.sizeBytes) {
    throw new RuntimeError(
      `local ONNX artifact ${file.path} size mismatch: expected ${file.sizeBytes}, got ${stat.size}`,
    );
  }
  const digest = await sha256File(filePath);
  if (digest !== file.sha256) {
    throw new RuntimeError(`local ONNX artifact ${file.path} digest mismatch: expected ${file.sha256}, got ${digest}`);
  }
}

async function verifyStagedLocalOnnxModel(descriptor: LocalOnnxModelDescriptor, stagingDir: string): Promise<string> {
  for (const file of descriptor.files) {
    await verifyLocalOnnxFile(path.join(stagingDir, file.path), file);
  }
  return combinedFilesHash(descriptor.files);
}

function replaceArtifactDir(stagingDir: string, artifactDir: string): void {
  ensurePrivateDirSync(path.dirname(artifactDir), 'Optsidian local ONNX artifact directory');
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, artifactDir);
}

function createManifest(descriptor: LocalOnnxModelDescriptor): LocalOnnxArtifactManifest {
  return {
    packageId: 'dense-onnx',
    modelKey: descriptor.key,
    modelId: descriptor.modelId,
    revision: descriptor.revision,
    sourceBaseUrl: sourceBaseUrl(descriptor),
    files: descriptor.files,
    modelArtifactSha256: localOnnxModelArtifactHash(descriptor),
    tokenizerArtifactSha256: localOnnxTokenizerArtifactHash(descriptor),
    installedAt: new Date().toISOString(),
  };
}

function sourceBaseUrl(descriptor: LocalOnnxModelDescriptor): string {
  return `https://huggingface.co/${descriptor.modelId}/resolve/${descriptor.revision}`;
}

function sourceUrl(descriptor: LocalOnnxModelDescriptor, file: LocalOnnxArtifactFile): string {
  return `${sourceBaseUrl(descriptor)}/${file.path}`;
}

function combinedFilesHash(files: readonly LocalOnnxArtifactFile[]): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: LOCAL_ONNX_ARTIFACT_SCHEMA_VERSION,
        files: [...files]
          .map((file) => ({
            path: file.path,
            role: file.role,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }),
    )
    .digest('hex');
}

function ensureLocalOnnxDataDir(env: NodeJS.ProcessEnv): void {
  ensurePrivateDirSync(optsidianCacheRoot(env), 'Optsidian cache directory');
  ensurePrivateDirSync(localOnnxDataDir(env), 'Optsidian local ONNX cache directory');
}

function sha256FileSync(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof RuntimeError
    ? 'runtime_error'
    : ((error as NodeJS.ErrnoException | undefined)?.code ?? 'local_onnx_model_install_failed');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
