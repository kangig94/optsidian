import { isMainThread, parentPort, workerData, type TransferListItem } from 'node:worker_threads';
import { analyzeSearchQuery } from '../core/search/analysis/query.js';
import type { SearchTextAnalysisOptions } from '../core/search/analysis/query.js';
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer } from '../core/search/analyzer.js';
import { LocalOnnxProvider, type OnnxExecutionProvider } from '../core/search/dense/local-onnx.js';
import { DeterministicHashProvider } from '../core/search/dense/provider.js';
import type { EmbeddingProvider } from '../core/search/dense/provider.js';
import { ModelSessionLifecycle } from './model-session/lifecycle.js';
import type {
  DeviceLoadPolicy,
  ModelDevice,
  ModelLoadTerminationReason,
  ModelSession,
  ModelSessionLoadOptions,
} from './model-session/lifecycle.js';
import type { DaemonWorkerSlotDevice } from './worker-pool.js';
import { residentModelKey } from './model-session/provider-key.js';
import type { IndexAffectingSearchSettings } from '../core/search/index-settings.js';
import { readOptsidianSettings } from '../core/settings.js';
import type {
  ModelProviderPayload,
  ModelEncodeWorkerPayload,
  SearchIndexProgressUpdate,
  VectorBuildWorkerPayload,
  VectorPrewarmWorkerPayload,
  VectorUpsertWorkerPayload,
} from './protocol.js';
import { buildCanonicalSearchSnapshot, parseBuildDocumentBatch, reduceBuildSegment } from './search-store/builder.js';
import {
  executeSearchJob,
  executeSearchShardJob,
  preloadSearchExecutionSnapshot,
  searchExecutionCacheStats,
  type SearchExecutionJob,
  type SearchExecutionSnapshotHandle,
  type SearchShardExecutionJob,
} from './search-execution.js';
import { createCoralNeedleProcessInstanceFactory } from './vector-store/process-instance.js';
import type { CoralNeedleInstance } from './vector-store/types.js';

type WorkerEnvelope = {
  id: number;
  request: {
    type: string;
    payload?: unknown;
  };
};

type WorkerContext = {
  optsidianSearchWorker?: boolean;
  kind?: 'analyzer' | 'search' | 'embedding' | 'vector';
  slotIndex?: number;
  slotDevice?: DaemonWorkerSlotDevice;
  env?: NodeJS.ProcessEnv;
};

let analyzer: SearchAnalyzer | undefined;
let embeddingLifecycle: ModelSessionLifecycle | undefined;
let embeddingLifecycleResidentModelKey: string | undefined;
const inFlightLocalOnnxProviders = new Map<string, LocalOnnxProvider>();
let searchDaemonWorkerProcessErrorHandlersInstalled = false;

export async function runSearchDaemonWorker(): Promise<void> {
  if (isMainThread || !parentPort) return;
  const context = workerData as WorkerContext;
  if (context.optsidianSearchWorker !== true) return;
  installSearchDaemonWorkerProcessErrorHandlers();
  const env = context.env ?? process.env;
  parentPort.on('message', (message: WorkerEnvelope) => {
    void handleMessage(message, context, env);
  });
}

async function handleMessage(message: WorkerEnvelope, context: WorkerContext, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const result = await dispatch(message.request.type, message.request.payload, context, env, (progress) => {
      const memory = workerLocalMemoryUsage();
      parentPort?.postMessage({
        id: message.id,
        progress,
        memory,
        memoryRss: memory.rss,
      });
    });
    const memory = workerLocalMemoryUsage();
    const response = {
      id: message.id,
      ok: true,
      result,
      memory,
      memoryRss: memory.rss,
    };
    parentPort?.postMessage(response, transferListForWorkerResult(result));
  } catch (error) {
    const memory = workerLocalMemoryUsage();
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: {
        code: (error as { code?: unknown } | undefined)?.code,
        message: error instanceof Error ? error.message : String(error),
      },
      memory,
      memoryRss: memory.rss,
    });
  }
}

function workerLocalMemoryUsage(): NodeJS.MemoryUsage {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

async function dispatch(
  type: string,
  payload: unknown,
  context: WorkerContext,
  env: NodeJS.ProcessEnv,
  progress: (progress: SearchIndexProgressUpdate) => void,
): Promise<unknown> {
  if (type === 'warmup') {
    if (context.kind === 'analyzer') {
      const activeAnalyzer = analyzerForWorker(env);
      return withSearchAnalyzerLease(
        activeAnalyzer,
        async (leased) => {
          await leased.tokenizeBatch(['warmup latin', '한국어']);
          return { analyzerIdentity: leased.identity };
        },
        undefined,
        {
          wait: true,
          installIfMissing: true,
        },
      );
    }
    return { ready: true };
  }
  if (context.kind === 'search') {
    if (type === 'search') return executeSearchJob(payload as SearchExecutionJob);
    if (type === 'searchShard') return executeSearchShardJob(payload as SearchShardExecutionJob);
    if (type === 'preloadSnapshot') return preloadSearchExecutionSnapshot(payload as SearchExecutionSnapshotHandle);
    if (type === 'searchExecutionStats') return searchExecutionCacheStats();
    throw Object.assign(new Error(`unsupported search worker job: ${type}`), { code: 'BAD_REQUEST' });
  }
  if (context.kind === 'embedding') {
    if (type === 'modelEncode') return modelEncode(payload as ModelEncodeWorkerPayload, context);
    if (type === 'modelUnload') {
      await embeddingLifecycle?.unload();
      embeddingLifecycle = undefined;
      embeddingLifecycleResidentModelKey = undefined;
      return { unloaded: true };
    }
    if (type === 'modelStats') return embeddingLifecycle?.stats() ?? { loaded: false };
    throw Object.assign(new Error(`unsupported embedding worker job: ${type}`), { code: 'BAD_REQUEST' });
  }
  if (context.kind === 'vector') {
    if (type === 'vectorUpsert') return vectorUpsert(payload as VectorUpsertWorkerPayload);
    if (type === 'vectorBuild') return vectorBuild(payload as VectorBuildWorkerPayload);
    if (type === 'vectorPrewarm') return vectorPrewarm(payload as VectorPrewarmWorkerPayload);
    if (type === 'vectorClose')
      return { ok: true, generationId: (payload as { generationId?: string } | undefined)?.generationId ?? '' };
    if (type === 'vectorStats') return {};
    throw Object.assign(new Error(`unsupported vector worker job: ${type}`), { code: 'BAD_REQUEST' });
  }
  if (context.kind !== 'analyzer') {
    throw Object.assign(new Error(`unsupported worker kind: ${String(context.kind)}`), { code: 'BAD_REQUEST' });
  }
  const activeAnalyzer = analyzerForWorker(env);
  if (type === 'analyzeQuery') {
    const input = payload as { rawQuery: string; options?: SearchTextAnalysisOptions };
    return withSearchAnalyzerLease(
      activeAnalyzer,
      async (leased) => ({
        analyzerIdentity: leased.identity,
        analysis: await analyzeSearchQuery(input.rawQuery, leased, input.options),
      }),
      undefined,
      { wait: true, installIfMissing: true },
    );
  }
  if (type === 'tokenizeBatch') {
    const input = payload as { texts: string[] };
    return withSearchAnalyzerLease(
      activeAnalyzer,
      async (leased) => ({
        analyzerIdentity: leased.identity,
        tokens: await leased.tokenizeBatch(input.texts),
      }),
      undefined,
      { wait: true, installIfMissing: true },
    );
  }
  if (type === 'buildSnapshot') {
    const input = payload as {
      vaultRoot: string;
      partitionBits?: number;
      searchSettings?: Partial<IndexAffectingSearchSettings>;
    };
    return withSearchAnalyzerLease(
      activeAnalyzer,
      (leased) =>
        buildCanonicalSearchSnapshot({
          vaultRoot: input.vaultRoot,
          analyzer: leased,
          searchSettings: input.searchSettings,
          partitionBits: input.partitionBits,
          progress,
        }),
      undefined,
      { wait: true, installIfMissing: true },
    );
  }
  if (type === 'parseBuildDocuments') {
    const input = payload as {
      vaultRoot: string;
      relPaths: readonly string[];
      partitionBits: number;
      searchSettings: IndexAffectingSearchSettings;
    };
    return withSearchAnalyzerLease(activeAnalyzer, (leased) => parseBuildDocumentBatch(input, leased), undefined, {
      wait: true,
      installIfMissing: true,
    });
  }
  if (type === 'reduceBuildSegment') {
    const input = payload as Parameters<typeof reduceBuildSegment>[0];
    return reduceBuildSegment(input);
  }
  throw Object.assign(new Error(`unsupported analyzer worker job: ${type}`), { code: 'BAD_REQUEST' });
}

async function modelEncode(input: ModelEncodeWorkerPayload, context: WorkerContext) {
  const lifecycle = await lifecycleForPayload(input.provider, context);
  const encodeOptions = {
    deadline: Date.now() + modelEncodeDeadlineMs(),
    origin: input.inputKind === 'query' ? ('query-text' as const) : ('document-embed' as const),
    suppressCpuPromotion: true,
    policy: deviceLoadPolicyForPayload(input.provider, context),
  };
  if (input.maxTokenBudget !== undefined) {
    const encoded = await lifecycle.encodeTokenBudgetBatch(input.texts, {
      ...encodeOptions,
      maxTokenBudget: input.maxTokenBudget,
      requestIndexes: input.requestIndexes,
      documentIds: input.documentIds,
    });
    const provider = encoded.providerIdentity;
    if (!provider) throw Object.assign(new Error('embedding provider identity is unavailable'), { code: 'INTERNAL' });
    return {
      provider,
      vectors: encoded.vectors,
      consumedCount: encoded.consumedCount,
      requestIndexes: encoded.requestIndexes,
      documentIds: encoded.documentIds,
      tokenCounts: encoded.tokenCounts,
    };
  }
  const encoded = await lifecycle.encode(input.texts, encodeOptions);
  const provider = encoded.providerIdentity;
  if (!provider) throw Object.assign(new Error('embedding provider identity is unavailable'), { code: 'INTERNAL' });
  return {
    provider,
    vectors: encoded.vectors,
  };
}

async function lifecycleForPayload(
  payload: ModelProviderPayload,
  context: WorkerContext,
): Promise<ModelSessionLifecycle> {
  const key = residentModelKey(payload);
  if (embeddingLifecycle && embeddingLifecycleResidentModelKey === key) return embeddingLifecycle;
  await embeddingLifecycle?.unload('superseded');
  embeddingLifecycleResidentModelKey = key;
  embeddingLifecycle = new ModelSessionLifecycle({
    policy: deviceLoadPolicyForPayload(payload, context),
    loadSession: async (device, options) => providerSessionForPayload(payload, device, options, key, context),
    terminateLoad: async (loadId, requestedDevice, reason) => terminateLoad(loadId, requestedDevice, reason),
    idleMs: modelIdleMs(),
  });
  return embeddingLifecycle;
}

async function providerSessionForPayload(
  payload: ModelProviderPayload,
  requestedDevice: ModelDevice,
  options: ModelSessionLoadOptions,
  residentKey: string,
  context: WorkerContext,
): Promise<ModelSession> {
  const provider = providerForPayload(payload, requestedDevice, options.policy.mode, context);
  const localOnnxProvider = provider instanceof LocalOnnxProvider ? provider : undefined;
  if (localOnnxProvider) inFlightLocalOnnxProviders.set(options.loadId, localOnnxProvider);
  try {
    if (localOnnxProvider) await localOnnxProvider.load({ signal: options.signal });
    const executionProvider = localOnnxProvider?.executionProvider;
    const device = actualDeviceForExecutionProvider(executionProvider) ?? requestedDevice;
    const session: ModelSession = {
      requestedLoadDevice: requestedDevice,
      device,
      ...(executionProvider ? { executionProvider } : {}),
      providerIdentity: provider.identity,
      residentModelKey: residentKey,
      async encode(texts, encodeOptions) {
        if (localOnnxProvider) {
          return localOnnxProvider.encodeBatch(texts, {
            inputKind: encodeOptions?.inputKind,
            signal: encodeOptions?.signal,
          });
        }
        return Promise.all(
          texts.map(async (text) => {
            return provider.embed(text, { inputKind: encodeOptions?.inputKind });
          }),
        );
      },
      async encodeTokenBudgetBatch(texts, encodeOptions) {
        if (localOnnxProvider) {
          return localOnnxProvider.encodeTokenBudgetBatch(texts, {
            inputKind: encodeOptions?.inputKind,
            signal: encodeOptions?.signal,
            maxTokenBudget: encodeOptions.maxTokenBudget,
            requestIndexes: encodeOptions.requestIndexes,
            documentIds: encodeOptions.documentIds,
          });
        }
        const vectors = await Promise.all(
          texts.map((text) => Promise.resolve(provider.embed(text, { inputKind: encodeOptions?.inputKind }))),
        );
        const requestIndexes = texts.map((_text, index) => encodeOptions.requestIndexes?.[index] ?? index);
        return {
          vectors,
          consumedCount: vectors.length,
          requestIndexes,
          documentIds: requestIndexes.map(
            (requestIndex, index) => encodeOptions.documentIds?.[index] ?? String(requestIndex),
          ),
          tokenCounts: vectors.map(() => 0),
        };
      },
      async close() {
        const close = (provider as EmbeddingProvider & { close?: () => void | Promise<void> }).close;
        if (close) await close.call(provider);
      },
    };
    return session;
  } catch (error) {
    const close = (provider as EmbeddingProvider & { close?: () => void | Promise<void> }).close;
    if (close) await Promise.resolve(close.call(provider)).catch(() => undefined);
    throw error;
  } finally {
    if (localOnnxProvider && inFlightLocalOnnxProviders.get(options.loadId) === localOnnxProvider) {
      inFlightLocalOnnxProviders.delete(options.loadId);
    }
  }
}

function deviceLoadPolicyForPayload(payload: ModelProviderPayload, context?: WorkerContext): DeviceLoadPolicy {
  if (payload.kind !== 'local-onnx') return { mode: 'cpu' };
  const slotDevice = requireEmbeddingSlotDevice(context);
  switch (slotDevice.kind) {
    case 'cpu':
      return { mode: 'cpu' };
    case 'cuda':
    case 'coreml':
      return { mode: 'gpu' };
  }
}

async function terminateLoad(
  loadId: string,
  _requestedDevice: ModelDevice,
  _reason: ModelLoadTerminationReason,
): Promise<void> {
  const provider = inFlightLocalOnnxProviders.get(loadId);
  if (!provider) return;
  inFlightLocalOnnxProviders.delete(loadId);
  await provider.close();
}

function providerForPayload(
  payload: ModelProviderPayload,
  device: ModelDevice = 'cpu',
  resolvedPolicyMode: DeviceLoadPolicy['mode'] = 'cpu',
  context?: WorkerContext,
): EmbeddingProvider {
  if (payload.kind === 'deterministic-hash') {
    return new DeterministicHashProvider({
      model: payload.model,
      dim: payload.dim,
      fixtures: payload.fixtures ? new Map(payload.fixtures) : undefined,
    });
  }
  if (payload.kind === 'local-onnx') {
    const slotDevice = requireEmbeddingSlotDevice(context);
    const executionProvider = executionProviderForDevice(device, slotDevice);
    return new LocalOnnxProvider({
      model: payload.model,
      executionProvider,
      allowCpuFallback: resolvedPolicyMode !== 'gpu',
      executionPolicy: payload.executionPolicy,
      deviceId: slotDevice.kind === 'cuda' ? slotDevice.deviceId : undefined,
    });
  }
  throw Object.assign(
    new Error(`unsupported embedding provider kind: ${String((payload as { kind?: unknown }).kind)}`),
    { code: 'BAD_REQUEST' },
  );
}

function requireEmbeddingSlotDevice(context: WorkerContext | undefined): DaemonWorkerSlotDevice {
  if (context?.slotDevice) return context.slotDevice;
  throw Object.assign(new Error('embedding worker is missing its slot device'), { code: 'INTERNAL' });
}

export function workerEntryDeviceLoadForTests(
  payload: ModelProviderPayload,
  slotDevice: DaemonWorkerSlotDevice,
): {
  policy: DeviceLoadPolicy;
  executionProvider: OnnxExecutionProvider;
  deviceId?: number;
} {
  const context: WorkerContext = { kind: 'embedding', slotDevice };
  const policy = deviceLoadPolicyForPayload(payload, context);
  const requestedDevice = policy.mode === 'cpu' ? 'cpu' : 'gpu';
  const executionProvider = executionProviderForDevice(requestedDevice, slotDevice);
  return {
    policy,
    executionProvider,
    ...(slotDevice.kind === 'cuda' ? { deviceId: slotDevice.deviceId } : {}),
  };
}

function executionProviderForDevice(device: ModelDevice, slotDevice?: DaemonWorkerSlotDevice) {
  if (slotDevice?.kind === 'cpu') return 'cpu';
  if (slotDevice?.kind === 'cuda') return 'cuda';
  if (slotDevice?.kind === 'coreml') return 'coreml';
  if (device === 'cpu') return 'cpu';
  if (process.platform === 'darwin') return 'coreml';
  return 'cuda';
}

function actualDeviceForExecutionProvider(
  executionProvider: OnnxExecutionProvider | undefined,
): ModelDevice | undefined {
  if (!executionProvider) return undefined;
  return executionProvider === 'cpu' ? 'cpu' : 'gpu';
}

function modelIdleMs(): number {
  const raw = process.env.OPTSIDIAN_SEARCH_MODEL_IDLE_MS;
  if (!raw || !/^\d+$/.test(raw)) return 5 * 60 * 1000;
  return Number(raw);
}

function modelEncodeDeadlineMs(): number {
  const raw = process.env.OPTSIDIAN_SEARCH_MODEL_ENCODE_DEADLINE_MS;
  if (!raw || !/^\d+$/.test(raw)) return 60_000;
  return Number(raw);
}

async function vectorUpsert(input: VectorUpsertWorkerPayload) {
  return withVectorInstance(input, async (instance) => {
    await instance.initStore(input.dbPath);
    await instance.setActiveSpec(input.spec);
    await instance.upsertChunks(input.chunks);
    return { ok: true, generationId: input.generationId };
  });
}

async function vectorBuild(input: VectorBuildWorkerPayload) {
  return withVectorInstance(input, async (instance) => {
    await instance.initStore(input.dbPath);
    await instance.setActiveSpec(input.spec);
    if (input.chunks && input.chunks.length > 0) await instance.upsertChunks(input.chunks);
    await instance.buildIndex(input.engineName ?? 'auto');
    return { ok: true, generationId: input.generationId };
  });
}

async function vectorPrewarm(input: VectorPrewarmWorkerPayload) {
  return withVectorInstance(input, async (instance) => {
    await instance.initStore(input.dbPath);
    await instance.setActiveSpec(input.spec);
    await instance.buildIndex(input.engineName ?? 'auto');
    return { ok: true, generationId: input.generationId };
  });
}

async function withVectorInstance<T>(
  input: VectorUpsertWorkerPayload | VectorBuildWorkerPayload | VectorPrewarmWorkerPayload,
  fn: (instance: CoralNeedleInstance) => Promise<T>,
): Promise<T> {
  const instance = await createCoralNeedleProcessInstanceFactory().create({
    role: 'staging',
    key: input.key,
    generationId: input.generationId,
    dbPath: input.dbPath,
  });
  try {
    return await fn(instance);
  } finally {
    await Promise.resolve(instance.close()).catch(() => undefined);
  }
}

function analyzerForWorker(env: NodeJS.ProcessEnv): SearchAnalyzer {
  analyzer ??= resolveSearchAnalyzer(env, readOptsidianSettings(process.cwd(), env), {
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {}),
  });
  return analyzer;
}

function installSearchDaemonWorkerProcessErrorHandlers(): void {
  if (searchDaemonWorkerProcessErrorHandlersInstalled) return;
  searchDaemonWorkerProcessErrorHandlersInstalled = true;
  process.on('uncaughtException', (error) => {
    logSearchDaemonWorkerProcessError('uncaughtException', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logSearchDaemonWorkerProcessError('unhandledRejection', reason);
    process.exit(1);
  });
}

function logSearchDaemonWorkerProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error && error.stack ? error.stack : String(error);
  try {
    process.stderr.write(`[optsidian search worker] ${kind}: ${message}\n`);
  } catch {
    // Ignore stderr failures while reporting process-level errors.
  }
}

function transferListForWorkerResult(result: unknown): TransferListItem[] {
  const buffers = new Set<ArrayBuffer>();
  if (isObjectRecord(result)) {
    addUint8ArrayTransfer(buffers, result.bytes);
    addUint8ArrayTransfer(buffers, result.canonicalManifestBytes);
    const segments = result.segments;
    if (Array.isArray(segments)) {
      for (const segment of segments) {
        if (isObjectRecord(segment)) addUint8ArrayTransfer(buffers, segment.bytes);
      }
    }
  }
  return [...buffers];
}

function addUint8ArrayTransfer(buffers: Set<ArrayBuffer>, value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  if (!(value.buffer instanceof ArrayBuffer)) return;
  buffers.add(value.buffer);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
