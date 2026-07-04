import { isMainThread, parentPort, workerData, type TransferListItem } from 'node:worker_threads';
import { analyzeSearchQuery } from '../core/search/analysis/query.js';
import type { SearchTextAnalysisOptions } from '../core/search/analysis/query.js';
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer } from '../core/search/analyzer.js';
import { LocalOnnxProvider } from '../core/search/dense/local-onnx.js';
import { DeterministicHashProvider } from '../core/search/dense/provider.js';
import type { EmbeddingProvider } from '../core/search/dense/provider.js';
import { ModelSessionLifecycle } from './model-session/lifecycle.js';
import type { ModelDevice, ModelSession } from './model-session/lifecycle.js';
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
  env?: NodeJS.ProcessEnv;
};

let analyzer: SearchAnalyzer | undefined;
let embeddingLifecycle: ModelSessionLifecycle | undefined;
let embeddingLifecycleKey: string | undefined;
let embeddingProviderIdentity: EmbeddingProvider['identity'] | undefined;
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
    if (type === 'modelEncode') return modelEncode(payload as ModelEncodeWorkerPayload);
    if (type === 'modelUnload') {
      await embeddingLifecycle?.unload();
      embeddingLifecycle = undefined;
      embeddingLifecycleKey = undefined;
      embeddingProviderIdentity = undefined;
      return { unloaded: true };
    }
    if (type === 'modelStats') return { loaded: embeddingLifecycle?.stats().loaded === true };
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

async function modelEncode(input: ModelEncodeWorkerPayload) {
  const lifecycle = lifecycleForPayload(input.provider);
  const vectors = await lifecycle.encode(input.texts, {
    deadline: Date.now() + modelEncodeDeadlineMs(),
    origin: input.inputKind === 'query' ? 'query-text' : 'document-embed',
    suppressCpuPromotion: input.suppressCpuPromotion,
  });
  const provider = embeddingProviderIdentity;
  if (!provider) throw Object.assign(new Error('embedding provider identity is unavailable'), { code: 'INTERNAL' });
  return {
    provider,
    vectors,
  };
}

function lifecycleForPayload(payload: ModelProviderPayload): ModelSessionLifecycle {
  const key = stableProviderKey(payload);
  if (embeddingLifecycle && embeddingLifecycleKey === key) return embeddingLifecycle;
  void embeddingLifecycle?.unload().catch(() => undefined);
  embeddingLifecycleKey = key;
  embeddingProviderIdentity = undefined;
  embeddingLifecycle = new ModelSessionLifecycle({
    requiredVramBytes: modelRequiredVramBytes(),
    probeVram: probeWorkerVram,
    loadSession: async (device) => providerSessionForPayload(payload, device),
    terminateLoad: async () => undefined,
    idleMs: modelIdleMs(),
  });
  return embeddingLifecycle;
}

async function providerSessionForPayload(payload: ModelProviderPayload, device: ModelDevice): Promise<ModelSession> {
  const provider = providerForPayload(payload, device);
  embeddingProviderIdentity = provider.identity;
  return {
    device,
    async encode(texts, options) {
      return Promise.all(
        texts.map(async (text) =>
          provider.embed(text, {
            inputKind: options?.inputKind,
          }),
        ),
      );
    },
    async close() {
      const close = (provider as EmbeddingProvider & { close?: () => void | Promise<void> }).close;
      if (close) await close.call(provider);
    },
  };
}

function providerForPayload(payload: ModelProviderPayload, device: ModelDevice = 'cpu'): EmbeddingProvider {
  if (payload.kind === 'deterministic-hash') {
    return new DeterministicHashProvider({
      model: payload.model,
      dim: payload.dim,
      fixtures: payload.fixtures ? new Map(payload.fixtures) : undefined,
    });
  }
  if (payload.kind === 'local-onnx') {
    return new LocalOnnxProvider({
      model: payload.model,
      executionProvider: payload.executionProvider ?? executionProviderForDevice(device),
      executionPolicy: payload.executionPolicy,
    });
  }
  throw Object.assign(
    new Error(`unsupported embedding provider kind: ${String((payload as { kind?: unknown }).kind)}`),
    { code: 'BAD_REQUEST' },
  );
}

function executionProviderForDevice(device: ModelDevice) {
  if (device === 'cpu') return 'cpu';
  if (process.platform === 'darwin') return 'coreml';
  return 'cuda';
}

function stableProviderKey(payload: ModelProviderPayload): string {
  if (payload.kind === 'local-onnx') {
    return JSON.stringify({
      kind: payload.kind,
      model: payload.model ?? null,
      executionProvider: payload.executionProvider ?? null,
      executionPolicy: {
        intraOpNumThreads: payload.executionPolicy.intraOpNumThreads,
        interOpNumThreads: payload.executionPolicy.interOpNumThreads,
      },
    });
  }
  return JSON.stringify(payload, (_key: string, value: unknown): unknown =>
    value instanceof Map ? Array.from((value as ReadonlyMap<unknown, unknown>).entries()) : value,
  );
}

export const stableProviderKeyForTests = stableProviderKey;

function modelRequiredVramBytes(): number {
  return envBytes(process.env.OPTSIDIAN_SEARCH_MODEL_REQUIRED_VRAM_MB) ?? 0;
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

function probeWorkerVram() {
  return {
    freeBytes: envBytes(process.env.OPTSIDIAN_SEARCH_MODEL_FREE_VRAM_MB) ?? 0,
  };
}

function envBytes(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw) * 1024 * 1024;
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
