import os from 'node:os';
import { readOptsidianSettings, type OptsidianSettings } from '../core/settings.js';
import type { OnnxExecutionPolicy, OnnxExecutionProvider } from '../core/search/dense/local-onnx.js';
import {
  SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
  type ModelEncodeWorkerPayload,
  type ModelEncodeWorkerResult,
  type ModelStatsWorkerResult,
} from './protocol.js';
import { createEmbeddingWorkerPool, type EmbeddingWorkerPool } from './pools.js';
import type { WorkerPoolRunOptions } from './worker-pool.js';
import { VectorGenerationPool } from './vector-store/pool.js';
import type { VectorGenerationPoolOptions } from './vector-store/pool.js';

export type EmbedSchedulerLane = 'query' | 'save' | 'refresh' | 'rebuild';

export type EmbedSchedulerLaneStats = {
  runningLane: EmbedSchedulerLane | undefined;
  lanes: Record<string, number>;
  activeLaneScopes: Record<string, number>;
  querySingleFlights: number;
  gpuDevice: GpuEmbeddingDeviceStats;
};

export class VectorGenerationManager extends VectorGenerationPool {}

export type GpuQueryMode = 'shared';

export const GPU_EMBEDDING_DEVICE_RETRY_TTL_MS = 60_000;

export type EmbedSchedulerOptions = {
  env?: NodeJS.ProcessEnv;
  settings?: OptsidianSettings;
  embedding?: EmbeddingWorkerPool;
  gpuDevice?: GpuEmbeddingDevice;
  onnxExecutionPolicy?: OnnxExecutionPolicy;
  ownsEmbedding?: boolean;
  vectorManager?: VectorGenerationManager;
  vectorManagerOptions?: VectorGenerationPoolOptions;
  ownsVectorManager?: boolean;
  modelLoadBarrier?: () => Promise<void>;
  now?: () => number;
  gpuQueryMode?: GpuQueryMode;
};

export type EmbedSchedulerDrainOptions = {
  cancel?: boolean;
};

type QueryEncodeWaiter = {
  cancellationId: string;
  timer?: NodeJS.Timeout;
  resolve(value: ModelEncodeWorkerResult): void;
  reject(error: Error): void;
};

type QueryEncodeFlight = {
  key: string;
  schedulerCancellationId: string;
  promise: Promise<ModelEncodeWorkerResult>;
  waiters: Set<QueryEncodeWaiter>;
  settled?: { ok: true; result: ModelEncodeWorkerResult } | { ok: false; error: Error };
};

const LANE_ORDER: readonly EmbedSchedulerLane[] = ['query', 'save', 'refresh', 'rebuild'];
const BULK_LANES: readonly BulkEmbeddingLane[] = ['save', 'refresh', 'rebuild'];
const MAX_CANCELLED_IDS = 4096;
const OPTSIDIAN_SEARCH_ONNX_INTRA_OP_THREADS = 'OPTSIDIAN_SEARCH_ONNX_INTRA_OP_THREADS';
const OPTSIDIAN_SEARCH_ONNX_OPENMP = 'OPTSIDIAN_SEARCH_ONNX_OPENMP';

type GpuEmbeddingDeviceJob = {
  lane: EmbedSchedulerLane;
  payload: ModelEncodeWorkerPayload;
  options: WorkerPoolRunOptions;
  fairnessKey: string;
  resolve(value: ModelEncodeWorkerResult): void;
  reject(error: Error): void;
};

export type GpuEmbeddingDeviceOptions = {
  embedding: EmbeddingExecutor;
  now: () => number;
  queryMode?: GpuQueryMode;
  onIdle?: () => void;
};

export type GpuEmbeddingDeviceStats = {
  runningLane: EmbedSchedulerLane | undefined;
  lanes: Record<EmbedSchedulerLane, number>;
  activeLaneCounts: Record<EmbedSchedulerLane, number>;
  gpuAvailable: boolean;
  queryMode: GpuQueryMode;
  gpuRetryAtMs?: number;
  retryAfterMs?: number;
  bulk: {
    devices: GpuEmbeddingDeviceBulkDeviceStats[];
    queueDepth: number;
    inFlight: number;
    queuedDocs: number;
    batchTokenBudget?: number;
    etaMs?: number;
  };
};

export type GpuEmbeddingDeviceBulkDeviceStats = {
  kind: 'gpu' | 'cpu';
  deviceId: string;
  executionProvider?: OnnxExecutionProvider;
  busy: boolean;
  docsPerSec: number;
};

type BulkEmbeddingLane = Exclude<EmbedSchedulerLane, 'query'>;
type GpuEmbeddingExecutionDevice = 'gpu' | 'cpu';

export type EmbeddingExecutor = {
  encode(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): Promise<ModelEncodeWorkerResult>;
  encodeGpu(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): Promise<ModelEncodeWorkerResult>;
  encodeCpuFallback(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): Promise<ModelEncodeWorkerResult>;
  hasGpuSlot(): boolean;
  cancel(cancellationId: string): void;
};

class FairGpuEmbeddingQueue {
  private readonly groups = new Map<string, GpuEmbeddingDeviceJob[]>();
  private readonly keys: string[] = [];
  private jobCount = 0;
  private textCount = 0;

  get size(): number {
    return this.jobCount;
  }

  get queuedDocs(): number {
    return this.textCount;
  }

  enqueue(job: GpuEmbeddingDeviceJob): void {
    let group = this.groups.get(job.fairnessKey);
    if (!group) {
      group = [];
      this.groups.set(job.fairnessKey, group);
      this.keys.push(job.fairnessKey);
    }
    group.push(job);
    this.jobCount += 1;
    this.textCount += jobTextCount(job);
  }

  dequeue(avoidKey?: string): GpuEmbeddingDeviceJob | undefined {
    while (this.keys.length > 0) {
      const key = this.takeNextKey(avoidKey);
      const group = this.groups.get(key);
      if (!group || group.length === 0) {
        this.groups.delete(key);
        continue;
      }
      const job = group.shift();
      if (!job) continue;
      this.jobCount = Math.max(0, this.jobCount - 1);
      this.textCount = Math.max(0, this.textCount - jobTextCount(job));
      if (group.length > 0) this.keys.push(key);
      else this.groups.delete(key);
      return job;
    }
    return undefined;
  }

  peek(avoidKey?: string): GpuEmbeddingDeviceJob | undefined {
    if (this.keys.length === 0) return undefined;
    const preferred = this.keys.find((key) => key !== avoidKey) ?? this.keys[0];
    return this.groups.get(preferred)?.[0];
  }

  drain(): GpuEmbeddingDeviceJob[] {
    const jobs: GpuEmbeddingDeviceJob[] = [];
    while (true) {
      const job = this.dequeue();
      if (!job) return jobs;
      jobs.push(job);
    }
  }

  private takeNextKey(avoidKey?: string): string {
    if (avoidKey !== undefined && this.keys.length > 1 && this.keys[0] === avoidKey) {
      const alternate = this.keys.findIndex((key) => key !== avoidKey);
      if (alternate > 0) return this.keys.splice(alternate, 1)[0];
    }
    return this.keys.shift() as string;
  }
}

export class GpuEmbeddingDevice {
  private readonly embedding: EmbeddingExecutor;
  private readonly now: () => number;
  private readonly queryMode: GpuQueryMode;
  private readonly onIdle: (() => void) | undefined;
  private readonly queryQueue: GpuEmbeddingDeviceJob[] = [];
  private readonly bulkQueues: Record<BulkEmbeddingLane, FairGpuEmbeddingQueue> = {
    save: new FairGpuEmbeddingQueue(),
    refresh: new FairGpuEmbeddingQueue(),
    rebuild: new FairGpuEmbeddingQueue(),
  };
  private readonly activeLaneCounts: Record<EmbedSchedulerLane, number> = {
    query: 0,
    save: 0,
    refresh: 0,
    rebuild: 0,
  };
  private readonly cancelled = new Set<string>();
  private readonly docsPerSec: Record<GpuEmbeddingExecutionDevice, number> = {
    gpu: 0,
    cpu: 0,
  };
  private activeJob: GpuEmbeddingDeviceJob | undefined;
  private activeDevice: GpuEmbeddingExecutionDevice | undefined;
  private gpuRetryAtMs: number | undefined;
  private lastBulkFairnessKey: string | undefined;
  private closed = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: GpuEmbeddingDeviceOptions) {
    this.embedding = options.embedding;
    this.now = options.now;
    this.queryMode = options.queryMode ?? 'shared';
    this.onIdle = options.onIdle;
  }

  encodeQuery(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): Promise<ModelEncodeWorkerResult> {
    return this.enqueue('query', payload, options);
  }

  encodeBulk(
    lane: Exclude<EmbedSchedulerLane, 'query'>,
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
  ): Promise<ModelEncodeWorkerResult> {
    return this.enqueue(lane, payload, options);
  }

  cancel(cancellationId: string): void {
    rememberCancelled(this.cancelled, cancellationId);
    if (this.activeJob?.options.cancellationId === cancellationId) this.embedding.cancel(cancellationId);
    this.drainQueue();
    this.resolveDrainWaitersIfIdle();
  }

  async drain(options: EmbedSchedulerDrainOptions = {}): Promise<void> {
    if (options.cancel) this.cancelQueuedWork();
    this.drainQueue();
    await this.waitForDrained();
  }

  close(): void {
    this.closed = true;
    this.cancelQueuedWork();
  }

  stats(): GpuEmbeddingDeviceStats {
    const gpuRetryAtMs = this.gpuRetryAtMs;
    const bulk = this.bulkStats();
    return {
      runningLane: this.activeJob?.lane,
      lanes: this.queueLengths(),
      activeLaneCounts: { ...this.activeLaneCounts },
      gpuAvailable: gpuRetryAtMs === undefined,
      queryMode: this.queryMode,
      ...(gpuRetryAtMs === undefined
        ? {}
        : {
            gpuRetryAtMs,
            retryAfterMs: Math.max(0, gpuRetryAtMs - this.now()),
          }),
      bulk,
    };
  }

  isIdle(): boolean {
    return (
      this.activeJob === undefined &&
      this.queryQueue.length === 0 &&
      BULK_LANES.every((lane) => this.bulkQueues[lane].size === 0)
    );
  }

  private enqueue(
    lane: EmbedSchedulerLane,
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
  ): Promise<ModelEncodeWorkerResult> {
    if (this.closed) {
      return Promise.reject(
        Object.assign(new Error('GPU embedding device is closed'), { code: 'SEARCH_DAEMON_NOT_READY' }),
      );
    }
    if (this.now() >= options.deadline) {
      return Promise.reject(
        Object.assign(new Error('GPU embedding deadline expired before admission'), { code: 'DEADLINE_EXCEEDED' }),
      );
    }
    if (this.cancelled.has(options.cancellationId)) {
      return Promise.reject(
        Object.assign(new Error('GPU embedding request was cancelled before admission'), { code: 'CANCELLED' }),
      );
    }
    return new Promise((resolve, reject) => {
      const job: GpuEmbeddingDeviceJob = {
        lane,
        payload,
        options,
        fairnessKey: gpuEmbeddingJobFairnessKey(payload, options),
        resolve,
        reject,
      };
      if (lane === 'query') this.queryQueue.push(job);
      else this.bulkQueues[lane].enqueue(job);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.closed || this.activeJob) return;
    while (!this.activeJob) {
      const job = this.selectNextJob();
      if (!job) {
        this.resolveDrainWaitersIfIdle();
        return;
      }
      if (this.cancelled.has(job.options.cancellationId)) {
        job.reject(
          Object.assign(new Error('GPU embedding request was cancelled before execution'), { code: 'CANCELLED' }),
        );
        continue;
      }
      if (this.now() >= job.options.deadline) {
        job.reject(
          Object.assign(new Error('GPU embedding deadline expired before execution'), { code: 'DEADLINE_EXCEEDED' }),
        );
        continue;
      }
      this.activeJob = job;
      this.activeLaneCounts[job.lane] += 1;
      this.executeJob(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeLaneCounts[job.lane] = Math.max(0, this.activeLaneCounts[job.lane] - 1);
          if (this.activeJob === job) this.activeJob = undefined;
          this.drainQueue();
        });
    }
  }

  private selectNextJob(): GpuEmbeddingDeviceJob | undefined {
    const query = this.queryQueue.shift();
    if (query) return query;
    for (const lane of BULK_LANES) {
      const job = this.bulkQueues[lane].dequeue(this.lastBulkFairnessKey);
      if (!job) continue;
      this.lastBulkFairnessKey = job.fairnessKey;
      return job;
    }
    return undefined;
  }

  private async executeJob(job: GpuEmbeddingDeviceJob): Promise<ModelEncodeWorkerResult> {
    if (this.shouldUseCpuFallback(job.payload)) return this.encodeOnCpuFallback(job.payload, job.options, job.lane);
    try {
      const result = await this.encodeOnGpu(job.payload, job.options, job.lane);
      this.gpuRetryAtMs = undefined;
      return result;
    } catch (error) {
      if (!this.canFallbackToCpu(job.payload, error)) throw error;
      this.gpuRetryAtMs = this.now() + GPU_EMBEDDING_DEVICE_RETRY_TTL_MS;
      return this.encodeOnCpuFallback(job.payload, job.options, job.lane);
    }
  }

  private shouldUseCpuFallback(payload: ModelEncodeWorkerPayload): boolean {
    if (payload.provider.kind !== 'local-onnx') return true;
    if (payload.provider.devicePolicy === 'cpu') return true;
    if (payload.provider.devicePolicy === 'gpu') return false;
    if (!this.embeddingHasGpuSlot()) return true;
    return this.gpuRetryAtMs !== undefined && this.now() < this.gpuRetryAtMs;
  }

  private canFallbackToCpu(payload: ModelEncodeWorkerPayload, error: unknown): boolean {
    if (payload.provider.kind !== 'local-onnx') return false;
    if (payload.provider.devicePolicy === 'gpu') return false;
    return isModelDeviceUnavailable(error);
  }

  private encodeOnGpu(
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
    lane: EmbedSchedulerLane,
  ): Promise<ModelEncodeWorkerResult> {
    return this.measureDevice('gpu', lane, payload, () => this.embedding.encodeGpu(payload, options));
  }

  private encodeOnCpuFallback(
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
    lane: EmbedSchedulerLane,
  ): Promise<ModelEncodeWorkerResult> {
    return this.measureDevice('cpu', lane, payload, () => this.embedding.encodeCpuFallback(payload, options));
  }

  private embeddingHasGpuSlot(): boolean {
    return this.embedding.hasGpuSlot();
  }

  private cancelQueuedWork(): void {
    if (this.activeJob) {
      rememberCancelled(this.cancelled, this.activeJob.options.cancellationId);
      this.embedding.cancel(this.activeJob.options.cancellationId);
    }
    const jobs = [...this.queryQueue.splice(0), ...BULK_LANES.flatMap((lane) => this.bulkQueues[lane].drain())];
    for (const job of jobs) {
      rememberCancelled(this.cancelled, job.options.cancellationId);
      job.reject(
        Object.assign(new Error('GPU embedding request was cancelled before execution'), { code: 'CANCELLED' }),
      );
    }
    this.resolveDrainWaitersIfIdle();
  }

  private queueLengths(): Record<EmbedSchedulerLane, number> {
    return {
      query: this.queryQueue.length,
      save: this.bulkQueues.save.size,
      refresh: this.bulkQueues.refresh.size,
      rebuild: this.bulkQueues.rebuild.size,
    };
  }

  private bulkStats(): GpuEmbeddingDeviceStats['bulk'] {
    const queueDepth = BULK_LANES.reduce((sum, lane) => sum + this.bulkQueues[lane].size, 0);
    const queuedDocs = BULK_LANES.reduce((sum, lane) => sum + this.bulkQueues[lane].queuedDocs, 0);
    const activeBulkJob = this.activeJob && this.activeJob.lane !== 'query' ? this.activeJob : undefined;
    const inFlight = activeBulkJob ? 1 : 0;
    const batchTokenBudget =
      activeBulkJob?.payload.maxTokenBudget ??
      BULK_LANES.map((lane) => this.bulkQueues[lane].peek(this.lastBulkFairnessKey)?.payload.maxTokenBudget).find(
        (value) => value !== undefined,
      );
    const activeDocs = activeBulkJob ? jobTextCount(activeBulkJob) : 0;
    const docsPerSec = this.docsPerSec[this.servingBulkDevice()];
    const etaMs =
      docsPerSec > 0 && queuedDocs + activeDocs > 0 ? ((queuedDocs + activeDocs) / docsPerSec) * 1000 : undefined;
    const devices: GpuEmbeddingDeviceBulkDeviceStats[] = [];
    if (this.embeddingHasGpuSlot()) {
      devices.push({
        kind: 'gpu',
        deviceId: 'gpu',
        busy: this.activeDevice === 'gpu',
        docsPerSec: roundRate(this.docsPerSec.gpu),
      });
    }
    devices.push({
      kind: 'cpu',
      deviceId: 'cpu',
      executionProvider: 'cpu',
      busy: this.activeDevice === 'cpu',
      docsPerSec: roundRate(this.docsPerSec.cpu),
    });
    return {
      devices,
      queueDepth,
      inFlight,
      queuedDocs,
      ...(batchTokenBudget !== undefined ? { batchTokenBudget } : {}),
      ...(etaMs !== undefined ? { etaMs: Math.max(0, Math.round(etaMs)) } : {}),
    };
  }

  private async measureDevice(
    device: GpuEmbeddingExecutionDevice,
    lane: EmbedSchedulerLane,
    payload: ModelEncodeWorkerPayload,
    run: () => Promise<ModelEncodeWorkerResult>,
  ): Promise<ModelEncodeWorkerResult> {
    const started = this.now();
    this.activeDevice = device;
    try {
      const result = await run();
      const elapsedMs = Math.max(1, this.now() - started);
      const docs = Math.max(0, result.consumedCount ?? result.vectors.length ?? payload.texts.length);
      if (lane !== 'query' && docs > 0) this.docsPerSec[device] = (docs / elapsedMs) * 1000;
      return result;
    } finally {
      if (this.activeDevice === device) this.activeDevice = undefined;
    }
  }

  private servingBulkDevice(): GpuEmbeddingExecutionDevice {
    if (!this.embeddingHasGpuSlot()) return 'cpu';
    if (this.activeDevice) return this.activeDevice;
    if (this.gpuRetryAtMs !== undefined && this.now() < this.gpuRetryAtMs) return 'cpu';
    return 'gpu';
  }

  private waitForDrained(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private resolveDrainWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
    this.onIdle?.();
  }
}

export class EmbedScheduler {
  readonly embedding: EmbeddingWorkerPool;
  readonly onnxExecutionPolicy: OnnxExecutionPolicy;
  readonly vectorManager: VectorGenerationManager;

  private readonly gpuDevice: GpuEmbeddingDevice;
  private readonly ownsEmbedding: boolean;
  private readonly ownsVectorManager: boolean;
  private readonly modelLoadBarrier: (() => Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly laneScopes: Record<EmbedSchedulerLane, number> = {
    query: 0,
    save: 0,
    refresh: 0,
    rebuild: 0,
  };
  private readonly cancelled = new Set<string>();
  private readonly querySingleFlights = new Map<string, QueryEncodeFlight>();
  private nextQueryFlightId = 1;
  private closing = false;
  private closed = false;
  private modelLoadBarrierPromise: Promise<void> | undefined;
  private drainWaiters: Array<() => void> = [];

  constructor(options: EmbedSchedulerOptions = {}) {
    const baseEnv = options.env ?? process.env;
    this.onnxExecutionPolicy = options.onnxExecutionPolicy ?? resolveDaemonOnnxExecutionPolicy(baseEnv);
    const env = envForDaemonOnnxExecutionPolicy(baseEnv, this.onnxExecutionPolicy);
    const settings = options.settings ?? readOptsidianSettings(process.cwd(), env);
    this.embedding = options.embedding ?? createEmbeddingWorkerPool(env, settings);
    this.now = options.now ?? Date.now;
    this.gpuDevice =
      options.gpuDevice ??
      new GpuEmbeddingDevice({
        embedding: this.embedding,
        now: this.now,
        queryMode: options.gpuQueryMode ?? 'shared',
        onIdle: () => {
          this.resolveDrainWaitersIfIdle();
        },
      });
    this.vectorManager = options.vectorManager ?? new VectorGenerationManager(options.vectorManagerOptions);
    this.ownsEmbedding = options.ownsEmbedding ?? options.embedding === undefined;
    this.ownsVectorManager = options.ownsVectorManager ?? true;
    this.modelLoadBarrier = options.modelLoadBarrier;
  }

  async encode(
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
    lane: EmbedSchedulerLane = payload.inputKind === 'query' ? 'query' : 'rebuild',
  ): Promise<ModelEncodeWorkerResult> {
    await this.waitForModelLoadBarrier();
    this.assertCanAdmit(lane, options);
    if (lane === 'query' && payload.inputKind === 'query') {
      const key = queryEncodeSingleFlightKey(payload);
      const existing = this.querySingleFlights.get(key);
      if (existing) return this.attachQueryEncodeWaiter(existing, options);
      const schedulerCancellationId = `query-encode:${this.nextQueryFlightId++}:${key}`;
      const scheduled = this.gpuDevice.encodeQuery(payload, { ...options, cancellationId: schedulerCancellationId });
      const flight: QueryEncodeFlight = {
        key,
        schedulerCancellationId,
        promise: scheduled,
        waiters: new Set(),
      };
      this.querySingleFlights.set(key, flight);
      scheduled
        .then(
          (result) => {
            flight.settled = { ok: true, result };
            for (const waiter of flight.waiters) {
              if (waiter.timer) clearTimeout(waiter.timer);
              waiter.resolve(result);
            }
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            flight.settled = { ok: false, error: failure };
            for (const waiter of flight.waiters) {
              if (waiter.timer) clearTimeout(waiter.timer);
              waiter.reject(failure);
            }
          },
        )
        .finally(() => {
          if (this.querySingleFlights.get(key) === flight) this.querySingleFlights.delete(key);
          flight.waiters.clear();
        });
      return this.attachQueryEncodeWaiter(flight, options);
    }
    const bulkLane: Exclude<EmbedSchedulerLane, 'query'> = lane === 'query' ? 'rebuild' : lane;
    return this.gpuDevice.encodeBulk(bulkLane, payload, options);
  }

  private assertCanAdmit(lane: EmbedSchedulerLane, options: WorkerPoolRunOptions): void {
    if (this.closed || (this.closing && this.laneScopes[lane] === 0)) {
      throw Object.assign(new Error('embed scheduler is closed'), { code: 'SEARCH_DAEMON_NOT_READY' });
    }
    if (this.now() >= options.deadline) {
      throw Object.assign(new Error('embed scheduler deadline expired before admission'), {
        code: 'DEADLINE_EXCEEDED',
      });
    }
    if (this.cancelled.has(options.cancellationId)) {
      throw Object.assign(new Error('embed scheduler request was cancelled before admission'), { code: 'CANCELLED' });
    }
  }

  private waitForModelLoadBarrier(): Promise<void> {
    if (!this.modelLoadBarrier) return Promise.resolve();
    this.modelLoadBarrierPromise ??= Promise.resolve()
      .then(() => this.modelLoadBarrier?.())
      .then(() => undefined);
    return this.modelLoadBarrierPromise;
  }

  async withLaneScope<T>(lane: EmbedSchedulerLane, fn: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) {
      throw Object.assign(new Error('embed scheduler is closed'), { code: 'SEARCH_DAEMON_NOT_READY' });
    }
    this.laneScopes[lane] += 1;
    try {
      return await fn();
    } finally {
      this.laneScopes[lane] = Math.max(0, this.laneScopes[lane] - 1);
      this.resolveDrainWaitersIfIdle();
    }
  }

  modelStats(options: WorkerPoolRunOptions): Promise<ModelStatsWorkerResult> {
    return this.embedding.modelStats(options);
  }

  cancel(cancellationId: string): void {
    rememberCancelled(this.cancelled, cancellationId);
    this.cancelQueryEncodeWaiters(cancellationId);
    this.gpuDevice.cancel(cancellationId);
    this.resolveDrainWaitersIfIdle();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.drain();
    this.gpuDevice.close();
    try {
      await this.embedding.unload({
        deadline: this.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
        cancellationId: 'embed-scheduler-close',
        requestId: 'embed-scheduler-close',
      });
    } catch {
      // Best-effort unload during close; owned resources are closed below.
    }
    if (this.ownsEmbedding) {
      await this.embedding.close();
    }
    if (this.ownsVectorManager) {
      await this.vectorManager.close();
    }
    this.closed = true;
  }

  stats() {
    return {
      ...this.laneStats(),
      embedding: this.embedding.stats(),
      vectorManager: this.vectorManager.statsForTests(),
    };
  }

  laneStats(): EmbedSchedulerLaneStats {
    const gpuStats = this.gpuDevice.stats();
    return {
      runningLane: gpuStats.runningLane,
      lanes: Object.fromEntries(LANE_ORDER.map((lane) => [lane, gpuStats.lanes[lane]])),
      activeLaneScopes: Object.fromEntries(LANE_ORDER.map((lane) => [lane, this.laneScopes[lane]])),
      querySingleFlights: this.querySingleFlights.size,
      gpuDevice: gpuStats,
    };
  }

  async drain(options: EmbedSchedulerDrainOptions = {}): Promise<void> {
    if (options.cancel) this.cancelQueuedWork();
    await this.gpuDevice.drain(options);
    await this.waitForDrained();
  }

  private attachQueryEncodeWaiter(
    flight: QueryEncodeFlight,
    options: WorkerPoolRunOptions,
  ): Promise<ModelEncodeWorkerResult> {
    if (this.cancelled.has(options.cancellationId)) {
      return Promise.reject(
        Object.assign(new Error('embed scheduler request was cancelled before admission'), { code: 'CANCELLED' }),
      );
    }
    if (this.now() >= options.deadline) {
      return Promise.reject(
        Object.assign(new Error('embed scheduler deadline expired before admission'), { code: 'DEADLINE_EXCEEDED' }),
      );
    }
    // A waiter can attach after the flight already settled (its resolve/reject ran, but the
    // `.finally` that clears `waiters` has not yet). Serve the stored outcome directly instead of
    // enqueuing into a Set that is about to be cleared — otherwise this waiter would hang forever.
    if (flight.settled) {
      return flight.settled.ok ? Promise.resolve(flight.settled.result) : Promise.reject(flight.settled.error);
    }
    return new Promise((resolve, reject) => {
      const waiter: QueryEncodeWaiter = {
        cancellationId: options.cancellationId,
        resolve,
        reject,
      };
      const timeoutMs = Math.max(1, options.deadline - this.now());
      waiter.timer = setTimeout(() => {
        if (!flight.waiters.delete(waiter)) return;
        waiter.reject(
          Object.assign(new Error('embed scheduler query waiter deadline expired'), { code: 'DEADLINE_EXCEEDED' }),
        );
        if (flight.waiters.size === 0) {
          rememberCancelled(this.cancelled, flight.schedulerCancellationId);
          this.gpuDevice.cancel(flight.schedulerCancellationId);
          if (this.querySingleFlights.get(flight.key) === flight) this.querySingleFlights.delete(flight.key);
        }
        this.resolveDrainWaitersIfIdle();
      }, timeoutMs);
      waiter.timer.unref();
      flight.waiters.add(waiter);
    });
  }

  private cancelQueuedWork(): void {
    void this.gpuDevice.drain({ cancel: true }).catch(() => undefined);
    for (const flight of this.querySingleFlights.values()) {
      rememberCancelled(this.cancelled, flight.schedulerCancellationId);
      this.embedding.cancel(flight.schedulerCancellationId);
      for (const waiter of flight.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
      flight.waiters.clear();
    }
    this.querySingleFlights.clear();
    this.resolveDrainWaitersIfIdle();
  }

  private cancelQueryEncodeWaiters(cancellationId: string): void {
    for (const flight of this.querySingleFlights.values()) {
      for (const waiter of [...flight.waiters]) {
        if (waiter.cancellationId !== cancellationId) continue;
        flight.waiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
      if (flight.waiters.size === 0) {
        rememberCancelled(this.cancelled, flight.schedulerCancellationId);
        this.gpuDevice.cancel(flight.schedulerCancellationId);
        if (this.querySingleFlights.get(flight.key) === flight) this.querySingleFlights.delete(flight.key);
      }
    }
  }

  private waitForDrained(): Promise<void> {
    if (this.isDrained()) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private resolveDrainWaitersIfIdle(): void {
    if (!this.isDrained()) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  private isDrained(): boolean {
    return this.gpuDevice.isIdle() && LANE_ORDER.every((lane) => this.laneScopes[lane] === 0);
  }
}

export function createEmbedScheduler(options: EmbedSchedulerOptions = {}): EmbedScheduler {
  return new EmbedScheduler(options);
}

function resolveDaemonOnnxExecutionPolicy(env: NodeJS.ProcessEnv): OnnxExecutionPolicy {
  const availableCores = os.availableParallelism?.() ?? os.cpus().length;
  const cores = Math.max(1, Math.floor(availableCores || 1));
  const override = envPositiveInteger(env[OPTSIDIAN_SEARCH_ONNX_INTRA_OP_THREADS]);
  return {
    intraOpNumThreads: Math.max(1, override ?? cores - 1),
    interOpNumThreads: 1,
  };
}

export function envForDaemonOnnxExecutionPolicy(
  env: NodeJS.ProcessEnv,
  executionPolicy: OnnxExecutionPolicy,
): NodeJS.ProcessEnv {
  if (!onnxOpenMpThreadEnvEnabled(env)) return env;
  return {
    ...env,
    OMP_NUM_THREADS: String(executionPolicy.intraOpNumThreads),
  };
}

function onnxOpenMpThreadEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OMP_NUM_THREADS !== undefined || envFlagEnabled(env[OPTSIDIAN_SEARCH_ONNX_OPENMP]);
}

function envFlagEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  return /^(1|true|yes|on)$/iu.test(raw.trim());
}

function envPositiveInteger(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/u.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

function queryEncodeSingleFlightKey(payload: ModelEncodeWorkerPayload): string {
  return stableJson({
    provider: payload.provider,
    inputKind: payload.inputKind ?? 'document',
    texts: payload.texts,
  });
}

function gpuEmbeddingJobFairnessKey(payload: ModelEncodeWorkerPayload, options: WorkerPoolRunOptions): string {
  return `${payload.profileHash ?? 'default-profile'}\0${options.vault ?? 'default-vault'}`;
}

function jobTextCount(job: GpuEmbeddingDeviceJob): number {
  return Math.max(0, job.payload.texts.length);
}

function roundRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
}

function rememberCancelled(cancelled: Set<string>, cancellationId: string): void {
  cancelled.delete(cancellationId);
  cancelled.add(cancellationId);
  while (cancelled.size > MAX_CANCELLED_IDS) {
    const oldest = cancelled.values().next();
    if (oldest.done) break;
    cancelled.delete(oldest.value);
  }
}

function isModelDeviceUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'MODEL_DEVICE_UNAVAILABLE') return true;
  const message = errorMessageWithCause(error);
  const deviceToken = /\b(cuda|cudnn|cublas|cufft|coreml|metal|gpu|device|ep|execution provider)\b/iu;
  const failureToken =
    /\b(unavailable|failed|failure|lost|reset|exhausted|out of memory|oom|alloc(?:ation)? failed|alloc_failed)\b/iu;
  return deviceToken.test(message) && failureToken.test(message);
}

function errorMessageWithCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause !== undefined ? ` ${errorMessageWithCause(error.cause)}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
