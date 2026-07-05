import fs from 'node:fs';
import { Attempt, AttemptCancelledError, type AttemptOwner } from '../../lifecycle/conditional-commit.js';
import {
  normalizeEmbeddingVector,
  type EmbeddingInputKind,
  type EmbeddingProvider,
  type EmbeddingProviderIdentity,
  type EmbeddingVector,
} from './provider.js';
import type { EmbeddingRecipeIdentity } from './embedding-set.js';
import type { OptsidianSettings } from '../../settings.js';
import {
  HUGGINGFACE_TOKENIZERS_RUNTIME_VERSION,
  LOCAL_ONNX_RECIPE_VERSION,
  LOCAL_ONNX_RENDERED_TEXT_PROJECTION_VERSION,
  ONNXRUNTIME_NODE_RUNTIME_VERSION,
  ensureLocalOnnxModelArtifact,
  localOnnxModelArtifactHash,
  localOnnxModelDescriptor,
  localOnnxSessionModelPath,
  localOnnxTokenizerArtifactHash,
  localOnnxTokenizerConfigPath,
  localOnnxTokenizerJsonPath,
  resolveLocalOnnxModelKey,
  type LocalOnnxModelAlias,
  type LocalOnnxModelDescriptor,
  type LocalOnnxModelKey,
} from './artifacts.js';
import { RuntimeError } from '../../../errors.js';

export type OnnxExecutionProvider = 'cuda' | 'coreml' | 'cpu';
export type OnnxExecutionProviderPreference = 'auto' | OnnxExecutionProvider;

export type OnnxExecutionPolicy = {
  intraOpNumThreads: number;
  interOpNumThreads: number;
};

export type LocalOnnxProviderSelection = {
  kind: 'local-onnx';
  model: LocalOnnxModelKey;
};

export type LocalOnnxTokenizerEncoding = {
  ids: number[];
  attention_mask: number[];
  token_type_ids?: number[];
  tokens?: string[];
};

export type LocalOnnxTokenizer = {
  encode(text: string, options?: { add_special_tokens?: boolean }): LocalOnnxTokenizerEncoding;
};

export type LocalOnnxTensor = {
  type?: string;
  data: ArrayLike<number> | BigInt64Array;
  dims: readonly number[];
};

export type LocalOnnxSession = {
  inputNames?: readonly string[];
  outputNames?: readonly string[];
  run(feeds: Record<string, LocalOnnxTensor>): Promise<Record<string, LocalOnnxTensor>>;
  release?(): void | Promise<void>;
};

export type LocalOnnxRuntime = {
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: readonly number[]) => LocalOnnxTensor;
  InferenceSession: {
    create(
      modelPath: string,
      options: {
        executionProviders: readonly OnnxExecutionProvider[];
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
      },
    ): Promise<LocalOnnxSession>;
  };
};

export type LocalOnnxProviderOptions = {
  model?: LocalOnnxModelAlias | string;
  env?: NodeJS.ProcessEnv;
  executionProvider?: OnnxExecutionProviderPreference;
  allowCpuFallback?: boolean;
  executionPolicy?: OnnxExecutionPolicy;
  ort?: LocalOnnxRuntime;
  tokenizer?: LocalOnnxTokenizer;
  ensureArtifact?: (descriptor: LocalOnnxModelDescriptor, env: NodeJS.ProcessEnv) => Promise<void>;
  loadTokenizer?: (descriptor: LocalOnnxModelDescriptor, env: NodeJS.ProcessEnv) => Promise<LocalOnnxTokenizer>;
  runtimeVersion?: string;
  tokenizerRuntimeVersion?: string;
  platform?: NodeJS.Platform;
};

export type LocalOnnxSessionSelection = {
  session: LocalOnnxSession;
  executionProvider: OnnxExecutionProvider;
  attempted: readonly OnnxExecutionProvider[];
  failures: readonly { executionProvider: OnnxExecutionProvider; message: string }[];
};

export class LocalOnnxProvider implements EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity;
  readonly recipeIdentity: EmbeddingRecipeIdentity;
  readonly descriptor: LocalOnnxModelDescriptor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executionProviderPreference: OnnxExecutionProviderPreference;
  private readonly allowCpuFallback: boolean;
  private readonly executionPolicy: OnnxExecutionPolicy | undefined;
  private readonly injectedOrt: LocalOnnxRuntime | undefined;
  private readonly injectedTokenizer: LocalOnnxTokenizer | undefined;
  private readonly ensureArtifactImpl: (descriptor: LocalOnnxModelDescriptor, env: NodeJS.ProcessEnv) => Promise<void>;
  private readonly loadTokenizerImpl: (
    descriptor: LocalOnnxModelDescriptor,
    env: NodeJS.ProcessEnv,
  ) => Promise<LocalOnnxTokenizer>;
  private readonly platform: NodeJS.Platform;
  private readonly ortAttemptOwner: AttemptOwner<LocalOnnxRuntime> = { current: undefined };
  private readonly tokenizerAttemptOwner: AttemptOwner<LocalOnnxTokenizer> = { current: undefined };
  private readonly sessionAttemptOwner: AttemptOwner<LocalOnnxSessionSelection> = { current: undefined };
  private ortAttempt: Attempt<LocalOnnxRuntime> | undefined;
  private tokenizerAttempt: Attempt<LocalOnnxTokenizer> | undefined;
  private sessionAttempt: Attempt<LocalOnnxSessionSelection> | undefined;
  private sessionAttemptKey: string | undefined;
  private selectedExecutionProvider: OnnxExecutionProvider | undefined;
  private activeOrt: LocalOnnxRuntime | undefined;
  private activeSessionSelection: LocalOnnxSessionSelection | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: LocalOnnxProviderOptions = {}) {
    this.descriptor = localOnnxModelDescriptor(options.model);
    this.env = options.env ?? process.env;
    this.executionProviderPreference = options.executionProvider ?? 'auto';
    this.allowCpuFallback = options.allowCpuFallback ?? true;
    this.executionPolicy = normalizeOnnxExecutionPolicy(options.executionPolicy);
    this.injectedOrt = options.ort;
    this.injectedTokenizer = options.tokenizer;
    this.platform = options.platform ?? process.platform;
    this.ensureArtifactImpl = options.ensureArtifact ?? defaultEnsureArtifact;
    this.loadTokenizerImpl = options.loadTokenizer ?? defaultLoadTokenizer;
    this.identity = {
      id: 'local-onnx',
      model: this.descriptor.key,
      dim: this.descriptor.dim,
      version: '1',
    };
    this.recipeIdentity = localOnnxEmbeddingRecipeIdentity({
      descriptor: this.descriptor,
      provider: this.identity,
      runtimeVersion: options.runtimeVersion ?? ONNXRUNTIME_NODE_RUNTIME_VERSION,
      tokenizerRuntimeVersion: options.tokenizerRuntimeVersion ?? HUGGINGFACE_TOKENIZERS_RUNTIME_VERSION,
    });
  }

  get executionProvider(): OnnxExecutionProvider | undefined {
    return this.selectedExecutionProvider;
  }

  async embed(
    text: string,
    options: { inputKind?: EmbeddingInputKind; signal?: AbortSignal } = {},
  ): Promise<EmbeddingVector> {
    const [tokenizer, selection] = await Promise.all([this.tokenizer(), this.session({ signal: options.signal })]);
    throwIfOnnxLoadAborted(options.signal);
    const rendered = renderLocalOnnxEmbeddingInput(this.descriptor, text, options.inputKind ?? 'document');
    const encoded = truncateEncoding(
      tokenizer.encode(rendered, { add_special_tokens: true }),
      this.descriptor.maxTokens,
    );
    const feeds = this.feedsForEncoding(encoded, selection.session);
    let output: Record<string, LocalOnnxTensor>;
    try {
      output = await selection.session.run(feeds);
    } catch (error) {
      if (isGpuExecutionProvider(selection.executionProvider) && isOnnxDeviceFailure(error)) {
        await this.close().catch(() => undefined);
      }
      throw error;
    }
    return meanPoolLastHiddenState(output, encoded.attention_mask, this.descriptor.dim);
  }

  async load(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.session({ signal: options.signal });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closePromise = this.closeOnce().finally(() => {
      if (this.closePromise === closePromise) this.closePromise = undefined;
    });
    this.closePromise = closePromise;
    return closePromise;
  }

  private async closeOnce(): Promise<void> {
    const attempt = this.sessionAttempt;
    this.sessionAttempt = undefined;
    this.sessionAttemptKey = undefined;
    if (attempt && this.sessionAttemptOwner.current === attempt) {
      this.sessionAttemptOwner.current = undefined;
      attempt.cancel(new AttemptCancelledError('ONNX session load was cancelled by provider close.'));
    }
    // Await the in-flight load attempt's settlement AFTER detaching ownership. A superseded attempt
    // closes its own produced session asynchronously (the Attempt `close` callback); if close()
    // returned before that ran, a caller sequencing teardown/exit after close() could observe a
    // use-after-close as the abandoned session releases in the background. Reading the active
    // selection after the await also captures any session that installed before we detached.
    if (attempt) await attempt.result.catch(() => undefined);
    const selection = this.activeSessionSelection;
    this.activeSessionSelection = undefined;
    this.selectedExecutionProvider = undefined;
    if (selection?.session.release) await selection.session.release();
  }

  private async tokenizer(): Promise<LocalOnnxTokenizer> {
    if (this.injectedTokenizer) return this.injectedTokenizer;
    if (this.tokenizerAttempt) return this.tokenizerAttempt.wait();
    const attempt = Attempt.start(this.tokenizerAttemptOwner, async () => {
      await this.ensureArtifact();
      return this.loadTokenizerImpl(this.descriptor, this.env);
    });
    this.tokenizerAttempt = attempt;
    attempt.result.catch(() => {
      if (this.tokenizerAttempt !== attempt) return;
      this.tokenizerAttempt = undefined;
      if (this.tokenizerAttemptOwner.current === attempt) this.tokenizerAttemptOwner.current = undefined;
    });
    return attempt.wait();
  }

  private async session(options: { signal?: AbortSignal } = {}): Promise<LocalOnnxSessionSelection> {
    if (this.closePromise) await this.closePromise;
    const modelPath = localOnnxSessionModelPath(this.descriptor.key, this.env);
    const sessionKey = localOnnxSessionCacheKey({
      modelPath,
      executionProvider: this.executionProviderPreference,
      executionPolicy: this.executionPolicy,
      allowCpuFallback: this.allowCpuFallback,
    });
    if (this.sessionAttempt && this.sessionAttemptKey === sessionKey)
      return this.sessionAttempt.wait({ signal: options.signal });
    if (this.sessionAttempt) await this.close();
    const attempt = Attempt.start(
      this.sessionAttemptOwner,
      async (signal) => {
        throwIfOnnxLoadAborted(signal);
        await this.ensureArtifact(signal);
        throwIfOnnxLoadAborted(signal);
        const ort = await this.ort(signal);
        throwIfOnnxLoadAborted(signal);
        this.activeOrt = ort;
        const selection = await createOnnxSessionWithFallback({
          ort,
          modelPath,
          executionProvider: this.executionProviderPreference,
          allowCpuFallback: this.allowCpuFallback,
          executionPolicy: this.executionPolicy,
          platform: this.platform,
          signal,
        });
        throwIfOnnxLoadAborted(signal);
        return selection;
      },
      {
        install: (selection) => {
          this.activeSessionSelection = selection;
          this.selectedExecutionProvider = selection.executionProvider;
        },
        close: (selection) => selection.session.release?.(),
      },
    );
    this.sessionAttempt = attempt;
    this.sessionAttemptKey = sessionKey;
    attempt.result.catch(() => {
      if (this.sessionAttempt !== attempt) return;
      this.sessionAttempt = undefined;
      this.sessionAttemptKey = undefined;
      if (this.sessionAttemptOwner.current === attempt) this.sessionAttemptOwner.current = undefined;
    });
    return attempt.wait({ signal: options.signal });
  }

  private async ort(signal?: AbortSignal): Promise<LocalOnnxRuntime> {
    throwIfOnnxLoadAborted(signal);
    if (this.injectedOrt) {
      this.activeOrt = this.injectedOrt;
      return this.injectedOrt;
    }
    if (!this.ortAttempt) {
      const attempt = Attempt.start(
        this.ortAttemptOwner,
        async (attemptSignal) => {
          throwIfOnnxLoadAborted(attemptSignal);
          const ort = await importOnnxRuntime();
          throwIfOnnxLoadAborted(attemptSignal);
          return ort;
        },
        {
          install: (ort) => {
            this.activeOrt = ort;
          },
        },
      );
      this.ortAttempt = attempt;
      attempt.result.catch(() => {
        if (this.ortAttempt !== attempt) return;
        this.ortAttempt = undefined;
        if (this.ortAttemptOwner.current === attempt) this.ortAttemptOwner.current = undefined;
      });
    }
    this.activeOrt = await this.ortAttempt.wait({ signal });
    return this.activeOrt;
  }

  private async ensureArtifact(signal?: AbortSignal): Promise<void> {
    throwIfOnnxLoadAborted(signal);
    if (this.injectedOrt && this.injectedTokenizer) return;
    await this.ensureArtifactImpl(this.descriptor, this.env);
    throwIfOnnxLoadAborted(signal);
  }

  private feedsForEncoding(
    encoded: LocalOnnxTokenizerEncoding,
    session: LocalOnnxSession,
  ): Record<string, LocalOnnxTensor> {
    const ortTensor = (name: string, values: readonly number[]) =>
      new (this.activeOrt?.Tensor ?? LazyTensor)(name, int64(values), [1, values.length]);
    const inputNames = new Set(session.inputNames ?? ['input_ids', 'attention_mask']);
    const feeds: Record<string, LocalOnnxTensor> = {};
    if (inputNames.has('input_ids')) feeds.input_ids = ortTensor('int64', encoded.ids);
    if (inputNames.has('attention_mask')) feeds.attention_mask = ortTensor('int64', encoded.attention_mask);
    if (inputNames.has('token_type_ids')) {
      feeds.token_type_ids = ortTensor('int64', encoded.token_type_ids ?? new Array(encoded.ids.length).fill(0));
    }
    return feeds;
  }
}

export function resolveLocalOnnxProviderSelection(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): LocalOnnxProviderSelection {
  const raw = env.OPTSIDIAN_SEARCH_EMBEDDING_MODEL ?? settings.search?.embeddingModel ?? 'bge-m3';
  return {
    kind: 'local-onnx',
    model: resolveLocalOnnxModelKey(raw),
  };
}

export function createLocalOnnxProviderFromConfig(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<LocalOnnxProviderOptions, 'model' | 'env'> = {},
): LocalOnnxProvider {
  const selection = resolveLocalOnnxProviderSelection(settings, env);
  return new LocalOnnxProvider({
    ...options,
    env,
    model: selection.model,
  });
}

function localOnnxEmbeddingRecipeIdentity(input: {
  descriptor: LocalOnnxModelDescriptor;
  provider: EmbeddingProviderIdentity;
  runtimeVersion?: string;
  tokenizerRuntimeVersion?: string;
}): EmbeddingRecipeIdentity {
  const descriptor = input.descriptor;
  return {
    schemaVersion: 1,
    provider: {
      id: input.provider.id,
      model: input.provider.model,
      dim: input.provider.dim,
      version: input.provider.version,
    },
    recipeVersion: LOCAL_ONNX_RECIPE_VERSION,
    projectionVersion: LOCAL_ONNX_RENDERED_TEXT_PROJECTION_VERSION,
    normalization: descriptor.normalization,
    modelArtifact: {
      modelId: descriptor.modelId,
      revision: descriptor.revision,
      sha256: localOnnxModelArtifactHash(descriptor),
      files: descriptor.files
        .filter((file) => file.role === 'model')
        .map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes })),
    },
    tokenizer: {
      sha256: localOnnxTokenizerArtifactHash(descriptor),
      runtime: {
        name: '@huggingface/tokenizers',
        version: input.tokenizerRuntimeVersion ?? HUGGINGFACE_TOKENIZERS_RUNTIME_VERSION,
      },
      files: descriptor.files
        .filter((file) => file.role === 'tokenizer')
        .map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes })),
    },
    onnx: {
      graphSha256:
        descriptor.files.find((file) => file.requiredForSession && file.path.endsWith('.onnx'))?.sha256 ??
        localOnnxModelArtifactHash(descriptor),
      opset: descriptor.opset,
      runtime: {
        name: 'onnxruntime-node',
        version: input.runtimeVersion ?? ONNXRUNTIME_NODE_RUNTIME_VERSION,
      },
    },
    quantization: descriptor.quantization,
    dtype: descriptor.dtype,
    dim: descriptor.dim,
    pooling: descriptor.pooling,
    maxTokens: descriptor.maxTokens,
    chunking: {
      strategy: 'truncate',
      maxTokens: descriptor.maxTokens,
      overlapTokens: 0,
    },
    inputTemplate: descriptor.inputTemplate,
    renderedTextProjectionVersion: LOCAL_ONNX_RENDERED_TEXT_PROJECTION_VERSION,
  };
}

export async function createOnnxSessionWithFallback(input: {
  ort: LocalOnnxRuntime;
  modelPath: string;
  executionProvider?: OnnxExecutionProviderPreference;
  allowCpuFallback?: boolean;
  executionPolicy?: OnnxExecutionPolicy;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}): Promise<LocalOnnxSessionSelection> {
  const allowCpuFallback = input.allowCpuFallback ?? true;
  const attempted = candidateExecutionProviders(
    input.executionProvider ?? 'auto',
    input.platform ?? process.platform,
    allowCpuFallback,
  );
  const failures: { executionProvider: OnnxExecutionProvider; message: string }[] = [];
  if (attempted.length === 0) {
    throw onnxSessionCreateError(failures, allowCpuFallback, input.executionProvider ?? 'auto');
  }
  for (const executionProvider of attempted) {
    try {
      throwIfOnnxLoadAborted(input.signal);
      const session = await input.ort.InferenceSession.create(input.modelPath, {
        executionProviders: [executionProvider],
        ...(input.executionPolicy
          ? {
              intraOpNumThreads: input.executionPolicy.intraOpNumThreads,
              interOpNumThreads: input.executionPolicy.interOpNumThreads,
            }
          : {}),
      });
      try {
        throwIfOnnxLoadAborted(input.signal);
      } catch (error) {
        if (session.release) await session.release();
        throw error;
      }
      return { session, executionProvider, attempted, failures };
    } catch (error) {
      throwIfOnnxLoadAborted(input.signal);
      failures.push({
        executionProvider,
        message: error instanceof Error ? error.message : String(error),
      });
      if (executionProvider === 'cpu') break;
    }
  }
  throw onnxSessionCreateError(failures, allowCpuFallback, input.executionProvider ?? 'auto');
}

function normalizeOnnxExecutionPolicy(policy: OnnxExecutionPolicy | undefined): OnnxExecutionPolicy | undefined {
  if (!policy) return undefined;
  return {
    intraOpNumThreads: Math.max(1, Math.floor(policy.intraOpNumThreads)),
    interOpNumThreads: Math.max(1, Math.floor(policy.interOpNumThreads)),
  };
}

function localOnnxSessionCacheKey(input: {
  modelPath: string;
  executionProvider: OnnxExecutionProviderPreference;
  allowCpuFallback: boolean;
  executionPolicy?: OnnxExecutionPolicy;
}): string {
  return JSON.stringify({
    modelPath: input.modelPath,
    executionProvider: input.executionProvider,
    allowCpuFallback: input.allowCpuFallback,
    executionPolicy: input.executionPolicy ?? null,
  });
}

export function candidateExecutionProviders(
  preference: OnnxExecutionProviderPreference = 'auto',
  platform: NodeJS.Platform = process.platform,
  allowCpuFallback = true,
): OnnxExecutionProvider[] {
  if (preference !== 'auto') {
    if (preference === 'cpu') return ['cpu'];
    return allowCpuFallback ? [preference, 'cpu'] : [preference];
  }
  if (platform === 'linux') return allowCpuFallback ? ['cuda', 'cpu'] : ['cuda'];
  if (platform === 'darwin') return allowCpuFallback ? ['coreml', 'cpu'] : ['coreml'];
  if (!allowCpuFallback) return [];
  return ['cpu'];
}

export function isOnnxDeviceFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (/\b(out of memory|oom|alloc(?:ation)? failed|alloc_failed)\b/.test(message)) return true;
  if (/\b(cuda|cudnn|cublas|cufft|coreml|metal)\b/.test(message)) return true;
  if (/\b(ep|execution provider)\b/.test(message)) return true;
  if (/\b(device|gpu)\b.*\b(unavailable|failed|failure|lost|reset|exhausted)\b/.test(message)) return true;
  if (/\b(unavailable|failed|failure|lost|reset|exhausted)\b.*\b(device|gpu)\b/.test(message)) return true;
  return false;
}

function onnxSessionCreateError(
  failures: readonly { executionProvider: OnnxExecutionProvider; message: string }[],
  allowCpuFallback: boolean,
  preference: OnnxExecutionProviderPreference,
): RuntimeError {
  const detail = failures.map((failure) => `${failure.executionProvider}: ${failure.message}`).join('; ');
  const error = new RuntimeError(`failed to create ONNX inference session${detail ? ` (${detail})` : ''}`);
  if (!allowCpuFallback && preference !== 'cpu') {
    Object.assign(error, { code: 'MODEL_DEVICE_UNAVAILABLE' });
  }
  return error;
}

function isGpuExecutionProvider(executionProvider: OnnxExecutionProvider): boolean {
  return executionProvider === 'cuda' || executionProvider === 'coreml';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause !== undefined ? ` ${errorMessage(error.cause)}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

function throwIfOnnxLoadAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = 'reason' in signal ? signal.reason : undefined;
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error('ONNX session load was cancelled'), { code: 'CANCELLED' });
}

function renderLocalOnnxEmbeddingInput(
  descriptor: LocalOnnxModelDescriptor,
  text: string,
  inputKind: EmbeddingInputKind = 'document',
): string {
  const template = descriptor.inputTemplate[inputKind] ?? descriptor.inputTemplate.default;
  return template.replace('{text}', text);
}

function truncateEncoding(encoding: LocalOnnxTokenizerEncoding, maxTokens: number): LocalOnnxTokenizerEncoding {
  const length = Math.min(maxTokens, encoding.ids.length, encoding.attention_mask.length);
  return {
    ids: encoding.ids.slice(0, length),
    attention_mask: encoding.attention_mask.slice(0, length),
    ...(encoding.token_type_ids ? { token_type_ids: encoding.token_type_ids.slice(0, length) } : {}),
    ...(encoding.tokens ? { tokens: encoding.tokens.slice(0, length) } : {}),
  };
}

function meanPoolLastHiddenState(
  output: Record<string, LocalOnnxTensor>,
  attentionMask: readonly number[],
  expectedDim: number,
): EmbeddingVector {
  const tensor = output.last_hidden_state ?? Object.values(output)[0];
  if (!tensor) throw new RuntimeError('ONNX embedding output did not include last_hidden_state');
  const dims = tensor.dims.map((value) => Number(value));
  if (dims.length !== 3) throw new RuntimeError(`ONNX last_hidden_state must be rank 3, got rank ${dims.length}`);
  const [batch, sequenceLength, dim] = dims;
  if (batch !== 1) throw new RuntimeError(`ONNX embedding provider expected batch 1, got ${batch}`);
  if (dim !== expectedDim)
    throw new RuntimeError(`ONNX embedding dim ${dim} does not match expected dim ${expectedDim}`);
  if (sequenceLength > attentionMask.length) {
    throw new RuntimeError(
      `ONNX attention mask length ${attentionMask.length} is shorter than sequence length ${sequenceLength}`,
    );
  }
  const data = numericTensorData(tensor);
  const pooled = new Array(dim).fill(0);
  let tokenCount = 0;
  for (let token = 0; token < sequenceLength; token += 1) {
    if ((attentionMask[token] ?? 0) <= 0) continue;
    tokenCount += 1;
    const offset = token * dim;
    for (let index = 0; index < dim; index += 1) pooled[index] += data[offset + index] ?? 0;
  }
  if (tokenCount === 0) throw new RuntimeError('ONNX attention mask did not select any tokens');
  for (let index = 0; index < pooled.length; index += 1) pooled[index] /= tokenCount;
  return normalizeEmbeddingVector(pooled, expectedDim);
}

async function defaultEnsureArtifact(descriptor: LocalOnnxModelDescriptor, env: NodeJS.ProcessEnv): Promise<void> {
  const installed = await ensureLocalOnnxModelArtifact(descriptor.key, env, { verifyFiles: 'metadata' });
  if (installed.status === 'error') throw new RuntimeError(installed.message);
}

async function defaultLoadTokenizer(
  descriptor: LocalOnnxModelDescriptor,
  env: NodeJS.ProcessEnv,
): Promise<LocalOnnxTokenizer> {
  const moduleName = '@huggingface/' + 'tokenizers';
  const imported: unknown = await import(moduleName);
  const Tokenizer = (imported as { Tokenizer?: new (tokenizer: object, config: object) => LocalOnnxTokenizer })
    .Tokenizer;
  if (!Tokenizer) throw new RuntimeError('@huggingface/tokenizers did not export Tokenizer');
  const tokenizerJson = parseJsonObject(fs.readFileSync(localOnnxTokenizerJsonPath(descriptor.key, env), 'utf8'));
  const tokenizerConfig = parseJsonObject(fs.readFileSync(localOnnxTokenizerConfigPath(descriptor.key, env), 'utf8'));
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}

async function importOnnxRuntime(): Promise<LocalOnnxRuntime> {
  const moduleName = 'onnxruntime' + '-node';
  const imported: unknown = await import(moduleName);
  const runtime = (imported as { default?: unknown }).default ?? imported;
  if (!isOnnxRuntime(runtime)) throw new RuntimeError('onnxruntime-node did not export an ONNX runtime API');
  return runtime;
}

function parseJsonObject(source: string): object {
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('local ONNX artifact JSON must be an object');
  }
  return value;
}

function isOnnxRuntime(value: unknown): value is LocalOnnxRuntime {
  return (
    value !== null &&
    typeof value === 'object' &&
    'Tensor' in value &&
    'InferenceSession' in value &&
    typeof (value as { InferenceSession?: { create?: unknown } }).InferenceSession?.create === 'function'
  );
}

function int64(values: readonly number[]): BigInt64Array {
  const output = new BigInt64Array(values.length);
  for (let index = 0; index < values.length; index += 1) output[index] = BigInt(values[index] ?? 0);
  return output;
}

function numericTensorData(tensor: LocalOnnxTensor): ArrayLike<number> {
  if (tensor.data instanceof BigInt64Array) throw new RuntimeError('ONNX last_hidden_state must be floating point');
  return tensor.data;
}

class LazyTensor implements LocalOnnxTensor {
  readonly type: string;
  readonly data: BigInt64Array | Float32Array;
  readonly dims: readonly number[];

  constructor(type: string, data: BigInt64Array | Float32Array, dims: readonly number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}
