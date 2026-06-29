import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type TransferListItem } from "node:worker_threads";
import type { SearchIndexProgressUpdate } from "./protocol.js";

export type DaemonWorkerKind = "analyzer" | "search";

export type DaemonWorkerRequest = {
  type: string;
  payload?: unknown;
  transferList?: readonly TransferListItem[];
};

export type WorkerPoolRunOptions = {
  deadline: number;
  cancellationId: string;
  requestId?: string;
  vault?: string;
  onProgress?: (progress: SearchIndexProgressUpdate) => void;
};

export type WorkerPoolOptions = {
  name: string;
  kind: DaemonWorkerKind;
  size: number;
  env?: NodeJS.ProcessEnv;
  workerScript?: string;
  maxQueueSize?: number;
  maxCrashRetries?: number;
  memoryLimitBytes?: number;
  heapGuardBytes?: number;
  rssGuardBytes?: number;
  rssGuardStrikes?: number;
  microbatchSize?: number;
  autoWarmup?: boolean;
};

type WorkerEnvelope = {
  id: number;
  request: DaemonWorkerRequest;
};

type WorkerReply =
  | {
      id: number;
      ok: true;
      result: unknown;
      memory?: WorkerMemoryUsage;
      memoryRss: number;
    }
  | {
      id: number;
      ok: false;
      error: {
        code?: string;
        message: string;
      };
      memory?: WorkerMemoryUsage;
      memoryRss: number;
    }
  | {
      id: number;
      progress: SearchIndexProgressUpdate;
      memory?: WorkerMemoryUsage;
      memoryRss: number;
    };

type WorkerMemoryUsage = {
  rss?: number;
  heapTotal?: number;
  heapUsed: number;
  external?: number;
  arrayBuffers?: number;
};

type QueueItem<T> = {
  id: number;
  request: DaemonWorkerRequest;
  options: WorkerPoolRunOptions;
  resolve(value: T): void;
  reject(error: Error): void;
  crashAttempts: number;
  targetSlotId?: number;
  timer?: NodeJS.Timeout;
};

type ReadyCallbacks = {
  resolveReady(): void;
  rejectReady(error: Error): void;
};

type WorkerSlot = {
  id: number;
  worker: Worker;
  busy: QueueItem<unknown> | undefined;
  leased: boolean;
  restarting: boolean;
  ready: Promise<void>;
  readyState: boolean;
  warmupStarted: boolean;
  warmupResult: unknown;
  restartAttempts: number;
  completedJobs: number;
  rssGuardStrikes: number;
  lastMemory?: WorkerMemoryUsage;
  lastRestartReason?: string;
  lastRestartAt?: string;
};

type RestartPlan = {
  restartAttempts: number;
  delayMs: number;
};

const DEFAULT_MAX_QUEUE_SIZE = 1024;
const DEFAULT_MAX_CRASH_RETRIES = 2;
const DEFAULT_MICROBATCH_SIZE = 64;
const DEFAULT_WORKER_HEAP_GUARD_BYTES = 512 * 1024 * 1024;
const DEFAULT_RSS_GUARD_STRIKES = 3;
const MAX_CANCELLED_IDS = 4096;
const MAX_SLOT_RESTART_ATTEMPTS = 3;
const SLOT_RESTART_BACKOFF_BASE_MS = 100;
const SLOT_RESTART_BACKOFF_CAP_MS = 5_000;

export class DaemonWorkerPool {
  private readonly options: Required<WorkerPoolOptions>;
  private readonly queue: Array<QueueItem<unknown>> = [];
  private readonly slots: WorkerSlot[] = [];
  private readonly cancelled = new Set<string>();
  private nextId = 1;
  private nextSlotId = 1;
  private lastVault: string | undefined;
  private closed = false;
  private restartCount = 0;
  private lastRestartReason: string | undefined;
  private lastRestartAt: string | undefined;
  private lastReadyError: Error | undefined;

  constructor(options: WorkerPoolOptions) {
    const size = Math.max(1, Math.floor(options.size));
    const env = options.env ?? process.env;
    const heapGuardBytes =
      options.heapGuardBytes ??
      options.memoryLimitBytes ??
      envBytes(env, "OPTSIDIAN_SEARCH_WORKER_HEAP_GUARD_MB") ??
      envBytes(env, "OPTSIDIAN_SEARCH_WORKER_MEMORY_MB") ??
      DEFAULT_WORKER_HEAP_GUARD_BYTES;
    this.options = {
      env,
      workerScript: defaultWorkerScript(),
      maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
      maxCrashRetries: DEFAULT_MAX_CRASH_RETRIES,
      microbatchSize: DEFAULT_MICROBATCH_SIZE,
      autoWarmup: true,
      ...options,
      memoryLimitBytes: heapGuardBytes,
      heapGuardBytes,
      rssGuardBytes: options.rssGuardBytes ?? envBytes(env, "OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_MB") ?? 0,
      rssGuardStrikes: options.rssGuardStrikes ?? envNumber(env, "OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_STRIKES") ?? DEFAULT_RSS_GUARD_STRIKES,
      size
    };
    for (let index = 0; index < size; index += 1) this.slots.push(this.createSlot(0));
  }

  get name(): string {
    return this.options.name;
  }

  get microbatchSize(): number {
    return this.options.microbatchSize;
  }

  async warmup<T = unknown>(minimumReady = this.slots.length): Promise<T[]> {
    const target = Math.max(1, Math.min(this.slots.length, Math.floor(minimumReady)));
    for (const slot of this.slots) this.startWarmup(slot);
    while (!this.closed) {
      const ready = this.readySlots();
      if (ready.length >= target) return ready.map((slot) => slot.warmupResult as T);
      const pending = this.slots
        .filter((slot) => !slot.readyState && !slot.restarting)
        .map((slot) => slot.ready.catch(() => undefined));
      if (pending.length === 0) {
        if (this.slots.length < target) throw this.lastReadyError ?? poolError("INTERNAL", `${this.options.name} pool has no warmable workers`);
        await delay(10);
      } else {
        await Promise.race(pending);
      }
    }
    throw poolError("INTERNAL", `${this.options.name} pool is closed`);
  }

  cancel(cancellationId: string): void {
    this.rememberCancelled(cancellationId);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item.options.cancellationId !== cancellationId) continue;
      this.queue.splice(index, 1);
      this.rejectItem(item, "CANCELLED", "worker job was cancelled before execution");
    }
    for (const slot of this.slots) {
      const item = slot.busy;
      if (!item || item.options.cancellationId !== cancellationId) continue;
      this.rejectItem(item, "CANCELLED", "worker job was cancelled during execution");
      slot.busy = undefined;
      this.restartSlot(slot, undefined, undefined, "cancelled");
    }
  }

  run<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions): Promise<T> {
    return this.enqueue(request, options);
  }

  runOnSlot<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions, slotId: number): Promise<T> {
    return this.enqueue(request, options, slotId);
  }

  runOnAll<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions): Promise<T[]> {
    return this.runOnSlots(request, options, this.slotIds());
  }

  runOnSlots<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions, slotIds: readonly number[]): Promise<T[]> {
    return Promise.all(slotIds.map((slotId) => this.enqueue<T>(request, options, slotId)));
  }

  slotIds(): number[] {
    return this.slots.map((slot) => slot.id);
  }

  readySlotIds(): number[] {
    return this.readySlots().map((slot) => slot.id);
  }

  idleReadySlotIds(): number[] {
    return this.idleReadySlots().map((slot) => slot.id);
  }

  leaseIdleSlot(): number | undefined {
    if (this.closed) return undefined;
    const slot = this.idleSlot();
    if (!slot) return undefined;
    slot.leased = true;
    return slot.id;
  }

  releaseIdleSlot(slotId: number): boolean {
    const slot = this.slots.find((candidate) => candidate.id === slotId);
    if (!slot?.leased || slot.busy || slot.restarting) return false;
    slot.leased = false;
    this.drain();
    return true;
  }

  private enqueue<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions, targetSlotId?: number): Promise<T> {
    if (this.closed) return Promise.reject(poolError("INTERNAL", `${this.options.name} pool is closed`));
    if (Date.now() >= options.deadline) {
      return Promise.reject(poolError("DEADLINE_EXCEEDED", `${this.options.name} queue deadline expired before admission`));
    }
    if (this.cancelled.has(options.cancellationId)) {
      return Promise.reject(poolError("CANCELLED", `${this.options.name} request was cancelled before admission`));
    }
    if (this.queue.length >= this.options.maxQueueSize && this.idleSlot() === undefined) {
      return Promise.reject(poolError("BACKPRESSURE", `${this.options.name} queue is full`));
    }
    let target: WorkerSlot | undefined;
    if (targetSlotId !== undefined) {
      target = this.slots.find((slot) => slot.id === targetSlotId);
      if (!target) return Promise.reject(poolError("INTERNAL", `${this.options.name} target worker is no longer available`));
      this.startWarmup(target);
    } else {
      for (const slot of this.slots) this.startWarmup(slot);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        id,
        request,
        options,
        resolve,
        reject,
        crashAttempts: 0,
        targetSlotId
      };
      this.armDeadline(item);
      if (target?.leased && target.readyState && !target.busy && !target.restarting) {
        target.leased = false;
        this.dispatchItem(target, item as QueueItem<unknown>);
        if (!target.busy) this.drain();
        return;
      }
      this.queue.push(item as QueueItem<unknown>);
      this.drain();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) this.rejectItem(item, "CANCELLED", `${this.options.name} pool is closing`);
    }
    await Promise.all(this.slots.map((slot) => slot.worker.terminate().catch(() => 0)));
  }

  stats() {
    return {
      name: this.options.name,
      kind: this.options.kind,
      workers: this.slots.length,
      queued: this.queue.length,
      active: this.slots.filter((slot) => this.slotOccupied(slot)).length,
      ready: this.readySlots().length,
      microbatchSize: this.options.microbatchSize,
      memoryLimitBytes: this.options.memoryLimitBytes,
      heapGuardBytes: this.options.heapGuardBytes,
      rssGuardBytes: this.options.rssGuardBytes || undefined,
      rssGuardStrikes: this.options.rssGuardBytes > 0 ? this.options.rssGuardStrikes : undefined,
      restarts: this.restartCount,
      lastRestartReason: this.lastRestartReason,
      lastRestartAt: this.lastRestartAt,
      processMemory: process.memoryUsage(),
      slots: this.slots.map((slot) => ({
        id: slot.id,
        ready: slot.readyState,
        warmupStarted: slot.warmupStarted,
        busy: this.slotOccupied(slot),
        restarting: slot.restarting,
        restartAttempts: slot.restartAttempts,
        completedJobs: slot.completedJobs,
        rssGuardStrikes: slot.rssGuardStrikes,
        lastMemory: slot.lastMemory,
        lastRestartReason: slot.lastRestartReason,
        lastRestartAt: slot.lastRestartAt
      }))
    };
  }

  private createSlot(restartAttempts: number): WorkerSlot {
    const id = this.nextSlotId++;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = new Worker(this.options.workerScript, {
      workerData: {
        optsidianSearchWorker: true,
        kind: this.options.kind,
        poolName: this.options.name,
        env: this.options.env,
        microbatchSize: this.options.microbatchSize
      },
      env: this.options.env,
      execArgv: workerExecArgv()
    });
    const slot: WorkerSlot = {
      id,
      worker,
      busy: undefined,
      leased: false,
      restarting: false,
      ready,
      readyState: false,
      warmupStarted: false,
      warmupResult: undefined,
      restartAttempts,
      completedJobs: 0,
      rssGuardStrikes: 0
    };
    const readyCallbacks: ReadyCallbacks = { resolveReady, rejectReady };
    worker.on("message", (message: unknown) => this.handleMessage(slot, message as WorkerReply, readyCallbacks));
    worker.on("error", (error) => {
      const workerError = error instanceof Error ? error : new Error(String(error));
      this.handleWorkerFailure(slot, workerError, readyCallbacks);
    });
    worker.on("exit", (code) => {
      if (this.closed || slot.restarting) return;
      const error = poolError("INTERNAL", `${this.options.name} worker exited with code ${code}`);
      this.handleWorkerFailure(slot, error, readyCallbacks);
    });
    if (this.options.autoWarmup) this.startWarmup(slot);
    return slot;
  }

  private startWarmup(slot: WorkerSlot): void {
    if (slot.warmupStarted || slot.readyState || slot.restarting) return;
    slot.warmupStarted = true;
    this.postToWorker(slot, { id: 0, request: { type: "warmup" } });
  }

  private recordMemory(slot: WorkerSlot, message: WorkerReply): void {
    slot.lastMemory = message.memory ?? {
      rss: message.memoryRss,
      heapUsed: message.memoryRss
    };
  }

  private handleMessage(slot: WorkerSlot, message: WorkerReply, readyCallbacks: ReadyCallbacks): void {
    this.recordMemory(slot, message);
    if ("progress" in message) {
      const item = slot.busy;
      if (item && item.id === message.id) item.options.onProgress?.(message.progress);
      return;
    }

    if (message.id === 0) {
      if (message.ok) {
        slot.warmupResult = message.result;
        slot.readyState = true;
        readyCallbacks.resolveReady();
        this.drain();
      } else {
        this.handleWarmupFailure(slot, poolError(message.error.code ?? "INTERNAL", message.error.message), readyCallbacks);
      }
      return;
    }

    const item = slot.busy;
    if (!item || item.id !== message.id) return;
    slot.busy = undefined;
    slot.restartAttempts = 0;
    this.clearDeadline(item);
    if (message.ok) {
      slot.completedJobs += 1;
      item.resolve(message.result);
      const restartReason = memoryRestartReason(message, slot, this.options);
      if (restartReason) this.restartSlot(slot, undefined, undefined, restartReason);
    } else {
      item.reject(poolError(message.error.code ?? "INTERNAL", message.error.message));
    }
    this.drain();
  }

  private handleWarmupFailure(slot: WorkerSlot, error: Error, readyCallbacks: ReadyCallbacks): void {
    this.lastReadyError = error;
    if (!slot.restarting) {
      slot.restarting = true;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      void slot.worker.terminate().catch(() => 0);
    }
    readyCallbacks.rejectReady(error);
    this.drain();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: Error, readyCallbacks?: ReadyCallbacks): void {
    if (!slot.readyState) this.lastReadyError = error;
    const item = slot.busy;
    slot.busy = undefined;
    slot.leased = false;
    if (item) {
      this.clearDeadline(item);
      if (item.crashAttempts < this.options.maxCrashRetries && Date.now() < item.options.deadline) {
        item.crashAttempts += 1;
        if (item.targetSlotId === slot.id) delete item.targetSlotId;
        this.armDeadline(item);
        this.queue.unshift(item);
      } else {
        item.reject(poolError("INTERNAL", `${this.options.name} worker crash retry budget exhausted: ${error.message}`));
      }
    }
    this.restartSlot(slot, error, readyCallbacks, error.message);
  }

  private restartSlot(slot: WorkerSlot, error?: Error, readyCallbacks?: ReadyCallbacks, reason?: string): void {
    const previousSlotId = slot.id;
    const restartError = error ?? poolError("INTERNAL", `${this.options.name} worker restart failed`);
    if (this.closed) {
      readyCallbacks?.rejectReady(restartError);
      return;
    }
    if (slot.restarting) return;
    const plan = this.restartPlan(slot);
    slot.restarting = true;
    slot.leased = false;
    const restartReason = reason ?? error?.message ?? "restart";
    const restartedAt = new Date().toISOString();
    slot.lastRestartReason = restartReason;
    slot.lastRestartAt = restartedAt;
    this.restartCount += 1;
    this.lastRestartReason = restartReason;
    this.lastRestartAt = restartedAt;
    if (!plan) {
      this.retargetQueuedItems(previousSlotId);
      void slot.worker.terminate().catch(() => 0).finally(() => {
        const index = this.slots.indexOf(slot);
        if (index >= 0) this.slots.splice(index, 1);
      });
      readyCallbacks?.rejectReady(restartError);
      return;
    }
    void slot.worker.terminate().catch(() => 0).finally(() => {
      const index = this.slots.indexOf(slot);
      if (index >= 0 && !this.closed) {
        const timer = setTimeout(() => {
          if (this.closed) {
            readyCallbacks?.rejectReady(restartError);
            return;
          }
          const replacement = this.createSlot(plan.restartAttempts);
          this.slots[index] = replacement;
          this.retargetQueuedItems(previousSlotId, replacement.id);
          if (readyCallbacks) void replacement.ready.then(readyCallbacks.resolveReady, readyCallbacks.rejectReady);
          void replacement.ready.then(() => this.drain(), () => {});
        }, plan.delayMs);
        timer.unref();
      } else {
        readyCallbacks?.rejectReady(restartError);
      }
    });
  }

  private retargetQueuedItems(previousSlotId: number, nextSlotId?: number): void {
    for (const item of this.queue) {
      if (item.targetSlotId !== previousSlotId) continue;
      if (nextSlotId === undefined) delete item.targetSlotId;
      else item.targetSlotId = nextSlotId;
    }
  }

  private drain(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (!slot.readyState || this.slotOccupied(slot) || slot.restarting) continue;
      const item = this.dequeueRunnable(slot);
      if (!item) continue;
      this.dispatchItem(slot, item);
    }
  }

  private dispatchItem(slot: WorkerSlot, item: QueueItem<unknown>): void {
    if (Date.now() >= item.options.deadline) {
      this.rejectItem(item, "DEADLINE_EXCEEDED", `${this.options.name} queue deadline expired before execution`);
      return;
    }
    if (this.cancelled.has(item.options.cancellationId)) {
      this.rejectItem(item, "CANCELLED", `${this.options.name} request was cancelled before execution`);
      return;
    }
    slot.busy = item;
    this.postToWorker(slot, { id: item.id, request: item.request });
  }

  private postToWorker(slot: WorkerSlot, envelope: WorkerEnvelope): void {
    const { transferList, ...request } = envelope.request;
    slot.worker.postMessage({ id: envelope.id, request } satisfies WorkerEnvelope, transferList ?? []);
  }

  // drain calls this per idle slot, so the scan is O(slots × queue); the queue is expected to stay small.
  private dequeueRunnable(slot: WorkerSlot): QueueItem<unknown> | undefined {
    if (this.queue.length === 0) return undefined;
    const targeted = this.dequeueTargetedRunnable(slot);
    if (targeted) return targeted;
    const runnable = this.queue.filter((item) => item.targetSlotId === undefined);
    const vaults = [...new Set(runnable.map((item) => item.options.vault ?? ""))];
    const start = this.lastVault === undefined ? 0 : Math.max(0, vaults.indexOf(this.lastVault) + 1);
    const orderedVaults = [...vaults.slice(start), ...vaults.slice(0, start)];
    for (const vault of orderedVaults) {
      const index = this.queue.findIndex((item) => item.targetSlotId === undefined && (item.options.vault ?? "") === vault);
      if (index < 0) continue;
      const [item] = this.queue.splice(index, 1);
      this.lastVault = vault;
      return item;
    }
    const genericIndex = this.queue.findIndex((item) => item.targetSlotId === undefined);
    if (genericIndex < 0) return undefined;
    const [item] = this.queue.splice(genericIndex, 1);
    return item;
  }

  private dequeueTargetedRunnable(slot: WorkerSlot): QueueItem<unknown> | undefined {
    const index = this.queue.findIndex((item) => item.targetSlotId === slot.id);
    if (index < 0) return undefined;
    const [item] = this.queue.splice(index, 1);
    return item;
  }

  private idleSlot(): WorkerSlot | undefined {
    return this.idleReadySlots()[0];
  }

  private idleReadySlots(): WorkerSlot[] {
    return this.slots.filter((slot) => slot.readyState && !this.slotOccupied(slot) && !slot.restarting);
  }

  private slotOccupied(slot: WorkerSlot): boolean {
    return slot.busy !== undefined || slot.leased;
  }

  private readySlots(): WorkerSlot[] {
    return this.slots.filter((slot) => slot.readyState && !slot.restarting);
  }

  private armDeadline(item: QueueItem<unknown>): void {
    this.clearDeadline(item);
    const remaining = item.options.deadline - Date.now();
    item.timer = setTimeout(() => {
      const queuedIndex = this.queue.indexOf(item);
      if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
      for (const slot of this.slots) {
        if (slot.busy !== item) continue;
        slot.busy = undefined;
        this.restartSlot(slot, poolError("DEADLINE_EXCEEDED", `${this.options.name} deadline expired`), undefined, "deadline");
      }
      this.rejectItem(item, "DEADLINE_EXCEEDED", `${this.options.name} deadline expired`);
    }, Math.max(1, remaining));
    item.timer.unref();
  }

  private clearDeadline(item: QueueItem<unknown>): void {
    if (!item.timer) return;
    clearTimeout(item.timer);
    item.timer = undefined;
  }

  private rejectItem(item: QueueItem<unknown>, code: string, message: string): void {
    this.clearDeadline(item);
    item.reject(poolError(code, message));
  }

  private rememberCancelled(cancellationId: string): void {
    this.cancelled.delete(cancellationId);
    this.cancelled.add(cancellationId);
    while (this.cancelled.size > MAX_CANCELLED_IDS) {
      const oldest = this.cancelled.values().next();
      if (oldest.done) break;
      this.cancelled.delete(oldest.value);
    }
  }

  private restartPlan(slot: WorkerSlot): RestartPlan | undefined {
    if (slot.restartAttempts < MAX_SLOT_RESTART_ATTEMPTS) {
      const restartAttempts = slot.restartAttempts + 1;
      return {
        restartAttempts,
        delayMs: restartBackoffMs(restartAttempts)
      };
    }
    return undefined;
  }
}

export function logicalCpuWorkerBudget(): number {
  return Math.max(4, os.availableParallelism?.() ?? os.cpus().length ?? 4);
}

export function defaultSearchExecutionWorkerCount(cpuCores = logicalCpuWorkerBudget()): number {
  return Math.max(1, Math.min(4, Math.floor(cpuCores / 4)));
}

export function workerCountFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  return optionalWorkerCountFromEnv(env, key) ?? Math.max(1, fallback);
}

export function optionalWorkerCountFromEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
}

function defaultWorkerScript(): string {
  const distCli = path.resolve(process.cwd(), "dist", "optsidian");
  if (fs.existsSync(distCli)) return distCli;
  const sourceCli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  if (fs.existsSync(sourceCli)) return sourceCli;
  const bundled = process.argv[1];
  if (bundled && fs.existsSync(bundled)) return bundled;
  return fileURLToPath(import.meta.url);
}

function workerExecArgv(): string[] {
  return process.execArgv.filter((arg) => arg === "--import" || arg === "tsx" || arg.endsWith("/tsx"));
}

function envBytes(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw)) * 1024 * 1024;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
}

function memoryRestartReason(
  message: WorkerReply,
  slot: WorkerSlot,
  options: Required<WorkerPoolOptions>
): string | undefined {
  const heapUsed = message.memory?.heapUsed ?? message.memoryRss;
  if (heapUsed > options.heapGuardBytes) {
    return `heap guard exceeded (${heapUsed} > ${options.heapGuardBytes})`;
  }
  const rss = message.memory?.rss ?? message.memoryRss;
  if (options.rssGuardBytes <= 0 || rss <= options.rssGuardBytes) {
    slot.rssGuardStrikes = 0;
    return undefined;
  }
  slot.rssGuardStrikes += 1;
  if (slot.rssGuardStrikes < options.rssGuardStrikes) return undefined;
  return `rss guard exceeded (${rss} > ${options.rssGuardBytes})`;
}

function restartBackoffMs(attempts: number): number {
  return Math.min(SLOT_RESTART_BACKOFF_CAP_MS, SLOT_RESTART_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function poolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
