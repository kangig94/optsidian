import fs from 'node:fs';
import { Attempt, type AttemptOwner } from '../../lifecycle/conditional-commit.js';
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
      options: { executionProviders: readonly OnnxExecutionProvider[] },
    ): Promise<LocalOnnxSession>;
  };
};

export type LocalOnnxProviderOptions = {
  model?: LocalOnnxModelAlias | string;
  env?: NodeJS.ProcessEnv;
  executionProvider?: OnnxExecutionProviderPreference;
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
  private selectedExecutionProvider: OnnxExecutionProvider | undefined;
  private activeOrt: LocalOnnxRuntime | undefined;
  private activeSessionSelection: LocalOnnxSessionSelection | undefined;

  constructor(options: LocalOnnxProviderOptions = {}) {
    this.descriptor = localOnnxModelDescriptor(options.model);
    this.env = options.env ?? process.env;
    this.executionProviderPreference = options.executionProvider ?? 'auto';
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

  async embed(text: string, options: { inputKind?: EmbeddingInputKind } = {}): Promise<EmbeddingVector> {
    const [tokenizer, selection] = await Promise.all([this.tokenizer(), this.session()]);
    const rendered = renderLocalOnnxEmbeddingInput(this.descriptor, text, options.inputKind ?? 'document');
    const encoded = truncateEncoding(
      tokenizer.encode(rendered, { add_special_tokens: true }),
      this.descriptor.maxTokens,
    );
    const feeds = this.feedsForEncoding(encoded, selection.session);
    const output = await selection.session.run(feeds);
    return meanPoolLastHiddenState(output, encoded.attention_mask, this.descriptor.dim);
  }

  async close(): Promise<void> {
    const attempt = this.sessionAttempt;
    this.sessionAttempt = undefined;
    if (attempt && this.sessionAttemptOwner.current === attempt) this.sessionAttemptOwner.current = undefined;
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

  private async session(): Promise<LocalOnnxSessionSelection> {
    if (this.sessionAttempt) return this.sessionAttempt.wait();
    const attempt = Attempt.start(
      this.sessionAttemptOwner,
      async () => {
        await this.ensureArtifact();
        const ort = await this.ort();
        this.activeOrt = ort;
        const modelPath = localOnnxSessionModelPath(this.descriptor.key, this.env);
        const selection = await createOnnxSessionWithFallback({
          ort,
          modelPath,
          executionProvider: this.executionProviderPreference,
          platform: this.platform,
        });
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
    attempt.result.catch(() => {
      if (this.sessionAttempt !== attempt) return;
      this.sessionAttempt = undefined;
      if (this.sessionAttemptOwner.current === attempt) this.sessionAttemptOwner.current = undefined;
    });
    return attempt.wait();
  }

  private async ort(): Promise<LocalOnnxRuntime> {
    if (this.injectedOrt) {
      this.activeOrt = this.injectedOrt;
      return this.injectedOrt;
    }
    if (!this.ortAttempt) {
      const attempt = Attempt.start(this.ortAttemptOwner, () => importOnnxRuntime(), {
        install: (ort) => {
          this.activeOrt = ort;
        },
      });
      this.ortAttempt = attempt;
      attempt.result.catch(() => {
        if (this.ortAttempt !== attempt) return;
        this.ortAttempt = undefined;
        if (this.ortAttemptOwner.current === attempt) this.ortAttemptOwner.current = undefined;
      });
    }
    this.activeOrt = await this.ortAttempt.wait();
    return this.activeOrt;
  }

  private async ensureArtifact(): Promise<void> {
    if (this.injectedOrt && this.injectedTokenizer) return;
    await this.ensureArtifactImpl(this.descriptor, this.env);
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

export function localOnnxEmbeddingRecipeIdentity(input: {
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
  platform?: NodeJS.Platform;
}): Promise<LocalOnnxSessionSelection> {
  const attempted = candidateExecutionProviders(input.executionProvider ?? 'auto', input.platform ?? process.platform);
  const failures: { executionProvider: OnnxExecutionProvider; message: string }[] = [];
  for (const executionProvider of attempted) {
    try {
      const session = await input.ort.InferenceSession.create(input.modelPath, {
        executionProviders: [executionProvider],
      });
      return { session, executionProvider, attempted, failures };
    } catch (error) {
      failures.push({
        executionProvider,
        message: error instanceof Error ? error.message : String(error),
      });
      if (executionProvider === 'cpu') break;
    }
  }
  const detail = failures.map((failure) => `${failure.executionProvider}: ${failure.message}`).join('; ');
  throw new RuntimeError(`failed to create ONNX inference session${detail ? ` (${detail})` : ''}`);
}

export function candidateExecutionProviders(
  preference: OnnxExecutionProviderPreference = 'auto',
  platform: NodeJS.Platform = process.platform,
): OnnxExecutionProvider[] {
  if (preference !== 'auto') return preference === 'cpu' ? ['cpu'] : [preference, 'cpu'];
  if (platform === 'linux') return ['cuda', 'cpu'];
  if (platform === 'darwin') return ['coreml', 'cpu'];
  return ['cpu'];
}

export function renderLocalOnnxEmbeddingInput(
  descriptor: LocalOnnxModelDescriptor,
  text: string,
  inputKind: EmbeddingInputKind = 'document',
): string {
  const template = descriptor.inputTemplate[inputKind] ?? descriptor.inputTemplate.default;
  return template.replace('{text}', text);
}

export function truncateEncoding(encoding: LocalOnnxTokenizerEncoding, maxTokens: number): LocalOnnxTokenizerEncoding {
  const length = Math.min(maxTokens, encoding.ids.length, encoding.attention_mask.length);
  return {
    ids: encoding.ids.slice(0, length),
    attention_mask: encoding.attention_mask.slice(0, length),
    ...(encoding.token_type_ids ? { token_type_ids: encoding.token_type_ids.slice(0, length) } : {}),
    ...(encoding.tokens ? { tokens: encoding.tokens.slice(0, length) } : {}),
  };
}

export function meanPoolLastHiddenState(
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
  const imported = await import(moduleName);
  const Tokenizer = (imported as { Tokenizer?: new (tokenizer: object, config: object) => LocalOnnxTokenizer })
    .Tokenizer;
  if (!Tokenizer) throw new RuntimeError('@huggingface/tokenizers did not export Tokenizer');
  const tokenizerJson = JSON.parse(fs.readFileSync(localOnnxTokenizerJsonPath(descriptor.key, env), 'utf8')) as object;
  const tokenizerConfig = JSON.parse(
    fs.readFileSync(localOnnxTokenizerConfigPath(descriptor.key, env), 'utf8'),
  ) as object;
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}

async function importOnnxRuntime(): Promise<LocalOnnxRuntime> {
  const moduleName = 'onnxruntime' + '-node';
  const imported = await import(moduleName);
  const runtime = (imported as { default?: unknown }).default ?? imported;
  if (!isOnnxRuntime(runtime)) throw new RuntimeError('onnxruntime-node did not export an ONNX runtime API');
  return runtime;
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
