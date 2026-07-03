import { AsyncLocalStorage } from 'node:async_hooks';
import { readOptsidianSettings, type OptsidianSettings } from '../core/settings.js';
import {
  SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
  type ModelEncodeWorkerPayload,
  type ModelEncodeWorkerResult,
} from './protocol.js';
import { createEmbeddingWorkerPool, type EmbeddingWorkerPool } from './pools.js';
import type { WorkerPoolRunOptions } from './worker-pool.js';
import { VectorGenerationPool, type VectorGenerationPoolOptions } from './vector-store/index.js';

export type EmbedSchedulerLane = 'query' | 'save' | 'refresh' | 'rebuild';

export class VectorGenerationManager extends VectorGenerationPool {}

export type EmbedSchedulerOptions = {
  env?: NodeJS.ProcessEnv;
  settings?: OptsidianSettings;
  embedding?: EmbeddingWorkerPool;
  ownsEmbedding?: boolean;
  vectorManager?: VectorGenerationManager;
  vectorManagerOptions?: VectorGenerationPoolOptions;
  ownsVectorManager?: boolean;
  now?: () => number;
};

export type EmbedSchedulerDrainOptions = {
  cancel?: boolean;
};

type SchedulerJob<T> = {
  lane: EmbedSchedulerLane;
  options: WorkerPoolRunOptions;
  task: () => Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

type QueryEncodeWaiter = {
  cancellationId: string;
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
const MAX_CANCELLED_IDS = 4096;

export class EmbedScheduler {
  readonly embedding: EmbeddingWorkerPool;
  readonly vectorManager: VectorGenerationManager;

  private readonly ownsEmbedding: boolean;
  private readonly ownsVectorManager: boolean;
  private readonly now: () => number;
  private readonly activeLaneContext = new AsyncLocalStorage<EmbedSchedulerLane>();
  private readonly lanes: Record<EmbedSchedulerLane, Array<SchedulerJob<unknown>>> = {
    query: [],
    save: [],
    refresh: [],
    rebuild: [],
  };
  private readonly activeLaneCounts: Record<EmbedSchedulerLane, number> = {
    query: 0,
    save: 0,
    refresh: 0,
    rebuild: 0,
  };
  private readonly laneScopes: Record<EmbedSchedulerLane, number> = {
    query: 0,
    save: 0,
    refresh: 0,
    rebuild: 0,
  };
  private readonly cancelled = new Set<string>();
  private readonly querySingleFlights = new Map<string, QueryEncodeFlight>();
  private running = false;
  private runningLane: EmbedSchedulerLane | undefined;
  private runningJob: SchedulerJob<unknown> | undefined;
  private nextQueryFlightId = 1;
  private closing = false;
  private closed = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: EmbedSchedulerOptions = {}) {
    const env = options.env ?? process.env;
    const settings = options.settings ?? readOptsidianSettings(process.cwd(), env);
    this.embedding = options.embedding ?? createEmbeddingWorkerPool(env, settings);
    this.vectorManager = options.vectorManager ?? new VectorGenerationManager(options.vectorManagerOptions);
    this.ownsEmbedding = options.ownsEmbedding ?? options.embedding === undefined;
    this.ownsVectorManager = options.ownsVectorManager ?? true;
    this.now = options.now ?? Date.now;
  }

  // Model execution is intentionally process-size-1. Same-model profiles get lane fairness here;
  // different-model profiles serialize in worker-entry by evicting and reloading the resident model.
  encode(
    payload: ModelEncodeWorkerPayload,
    options: WorkerPoolRunOptions,
    lane: EmbedSchedulerLane = payload.inputKind === 'query' ? 'query' : 'rebuild',
  ): Promise<ModelEncodeWorkerResult> {
    if (lane === 'query' && payload.inputKind === 'query') {
      const key = queryEncodeSingleFlightKey(payload);
      const existing = this.querySingleFlights.get(key);
      if (existing) return this.attachQueryEncodeWaiter(existing, options);
      const schedulerCancellationId = `query-encode:${this.nextQueryFlightId++}:${key}`;
      const scheduled = this.run(
        lane,
        () =>
          this.embedding.encode(
            {
              ...payload,
              suppressCpuPromotion: payload.suppressCpuPromotion === true || this.rebuildLaneIsActive(),
            },
            { ...options, cancellationId: schedulerCancellationId },
          ),
        { ...options, cancellationId: schedulerCancellationId },
      );
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
            for (const waiter of flight.waiters) waiter.resolve(result);
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            flight.settled = { ok: false, error: failure };
            for (const waiter of flight.waiters) waiter.reject(failure);
          },
        )
        .finally(() => {
          if (this.querySingleFlights.get(key) === flight) this.querySingleFlights.delete(key);
          flight.waiters.clear();
        });
      return this.attachQueryEncodeWaiter(flight, options);
    }
    return this.run(
      lane,
      () =>
        this.embedding.encode(
          {
            ...payload,
            // Only the foreground query lane may trigger an inline CPU→GPU promotion; a background
            // document-embed batch (save/refresh/rebuild) must never block a queued query behind a GPU
            // model load, which would violate the documented query > save > refresh > rebuild priority.
            suppressCpuPromotion:
              payload.suppressCpuPromotion === true || lane !== 'query' || this.rebuildLaneIsActive(),
          },
          options,
        ),
      options,
    );
  }

  run<T>(lane: EmbedSchedulerLane, task: () => Promise<T>, options: WorkerPoolRunOptions): Promise<T> {
    if (this.closed || (this.closing && this.laneScopes[lane] === 0)) {
      return Promise.reject(Object.assign(new Error('embed scheduler is closed'), { code: 'SEARCH_DAEMON_NOT_READY' }));
    }
    if (this.now() >= options.deadline) {
      return Promise.reject(
        Object.assign(new Error('embed scheduler deadline expired before admission'), { code: 'DEADLINE_EXCEEDED' }),
      );
    }
    if (this.cancelled.has(options.cancellationId)) {
      return Promise.reject(
        Object.assign(new Error('embed scheduler request was cancelled before admission'), { code: 'CANCELLED' }),
      );
    }
    if (this.runningLane === lane && this.activeLaneContext.getStore() === lane) {
      return Promise.resolve().then(task);
    }
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push({
        lane,
        options,
        task,
        resolve: resolve,
        reject,
      });
      this.pump();
    });
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

  cancel(cancellationId: string): void {
    rememberCancelled(this.cancelled, cancellationId);
    this.cancelQueryEncodeWaiters(cancellationId);
    for (const lane of LANE_ORDER) {
      for (let index = this.lanes[lane].length - 1; index >= 0; index -= 1) {
        const job = this.lanes[lane][index];
        if (job.options.cancellationId !== cancellationId) continue;
        this.lanes[lane].splice(index, 1);
        job.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
    }
    this.embedding.cancel(cancellationId);
    this.resolveDrainWaitersIfIdle();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.drain();
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
      lanes: Object.fromEntries(LANE_ORDER.map((lane) => [lane, this.lanes[lane].length])),
      runningLane: this.runningLane,
      activeLaneScopes: Object.fromEntries(LANE_ORDER.map((lane) => [lane, this.laneScopes[lane]])),
      querySingleFlights: this.querySingleFlights.size,
      embedding: this.embedding.stats(),
      vectorManager: this.vectorManager.statsForTests(),
    };
  }

  async drain(options: EmbedSchedulerDrainOptions = {}): Promise<void> {
    if (options.cancel) this.cancelQueuedWork();
    this.pump();
    await this.waitForDrained();
  }

  private pump(): void {
    if (this.running || this.closed) return;
    const job = this.dequeue();
    if (!job) {
      this.resolveDrainWaitersIfIdle();
      return;
    }
    if (this.cancelled.has(job.options.cancellationId)) {
      job.reject(
        Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
      );
      this.pump();
      return;
    }
    if (this.now() >= job.options.deadline) {
      job.reject(
        Object.assign(new Error('embed scheduler deadline expired before execution'), { code: 'DEADLINE_EXCEEDED' }),
      );
      this.pump();
      return;
    }
    this.running = true;
    this.runningLane = job.lane;
    this.runningJob = job;
    this.activeLaneCounts[job.lane] += 1;
    Promise.resolve()
      .then(() => this.activeLaneContext.run(job.lane, () => job.task()))
      .then(job.resolve, job.reject)
      .finally(() => {
        this.activeLaneCounts[job.lane] = Math.max(0, this.activeLaneCounts[job.lane] - 1);
        this.running = false;
        this.runningLane = undefined;
        this.runningJob = undefined;
        this.pump();
      });
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
      flight.waiters.add(waiter);
    });
  }

  private cancelQueuedWork(): void {
    if (this.runningJob) {
      rememberCancelled(this.cancelled, this.runningJob.options.cancellationId);
      this.embedding.cancel(this.runningJob.options.cancellationId);
    }
    for (const flight of this.querySingleFlights.values()) {
      rememberCancelled(this.cancelled, flight.schedulerCancellationId);
      this.embedding.cancel(flight.schedulerCancellationId);
      for (const waiter of flight.waiters) {
        waiter.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
      flight.waiters.clear();
    }
    this.querySingleFlights.clear();

    for (const lane of LANE_ORDER) {
      const jobs = this.lanes[lane].splice(0);
      for (const job of jobs) {
        rememberCancelled(this.cancelled, job.options.cancellationId);
        this.embedding.cancel(job.options.cancellationId);
        job.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
    }
    this.resolveDrainWaitersIfIdle();
  }

  private cancelQueryEncodeWaiters(cancellationId: string): void {
    for (const flight of this.querySingleFlights.values()) {
      for (const waiter of [...flight.waiters]) {
        if (waiter.cancellationId !== cancellationId) continue;
        flight.waiters.delete(waiter);
        waiter.reject(
          Object.assign(new Error('embed scheduler request was cancelled before execution'), { code: 'CANCELLED' }),
        );
      }
      if (flight.waiters.size === 0) {
        rememberCancelled(this.cancelled, flight.schedulerCancellationId);
        this.embedding.cancel(flight.schedulerCancellationId);
        if (this.querySingleFlights.get(flight.key) === flight) this.querySingleFlights.delete(flight.key);
      }
    }
  }

  private dequeue(): SchedulerJob<unknown> | undefined {
    for (const lane of LANE_ORDER) {
      const job = this.lanes[lane].shift();
      if (job) return job;
    }
    return undefined;
  }

  private rebuildLaneIsActive(): boolean {
    return this.activeLaneCounts.rebuild > 0 || this.laneScopes.rebuild > 0 || this.lanes.rebuild.length > 0;
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
    return (
      !this.running &&
      LANE_ORDER.every((lane) => this.lanes[lane].length === 0) &&
      LANE_ORDER.every((lane) => this.activeLaneCounts[lane] === 0) &&
      LANE_ORDER.every((lane) => this.laneScopes[lane] === 0)
    );
  }
}

export function createEmbedScheduler(options: EmbedSchedulerOptions = {}): EmbedScheduler {
  return new EmbedScheduler(options);
}

function queryEncodeSingleFlightKey(payload: ModelEncodeWorkerPayload): string {
  return stableJson({
    provider: payload.provider,
    inputKind: payload.inputKind ?? 'document',
    texts: payload.texts,
  });
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
