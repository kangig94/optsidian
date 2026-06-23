import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export type DaemonWorkerKind = "analyzer" | "search";

export type DaemonWorkerRequest = {
  type: string;
  payload?: unknown;
};

export type WorkerPoolRunOptions = {
  deadline: number;
  cancellationId: string;
  vault?: string;
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
  microbatchSize?: number;
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
      memoryRss: number;
    }
  | {
      id: number;
      ok: false;
      error: {
        code?: string;
        message: string;
      };
      memoryRss: number;
    };

type QueueItem<T> = {
  id: number;
  request: DaemonWorkerRequest;
  options: WorkerPoolRunOptions;
  resolve(value: T): void;
  reject(error: Error): void;
  crashAttempts: number;
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
  restarting: boolean;
  ready: Promise<void>;
  warmupResult: unknown;
  restartAttempts: number;
};

type RestartPlan = {
  restartAttempts: number;
  delayMs: number;
};

const DEFAULT_MAX_QUEUE_SIZE = 1024;
const DEFAULT_MAX_CRASH_RETRIES = 2;
const DEFAULT_MICROBATCH_SIZE = 64;
const DEFAULT_WORKER_MEMORY_BYTES = 512 * 1024 * 1024;
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

  constructor(options: WorkerPoolOptions) {
    const size = Math.max(1, Math.floor(options.size));
    this.options = {
      env: process.env,
      workerScript: defaultWorkerScript(),
      maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
      maxCrashRetries: DEFAULT_MAX_CRASH_RETRIES,
      memoryLimitBytes: envBytes(options.env ?? process.env, "OPTSIDIAN_SEARCH_WORKER_MEMORY_MB") ?? DEFAULT_WORKER_MEMORY_BYTES,
      microbatchSize: DEFAULT_MICROBATCH_SIZE,
      ...options,
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

  async warmup<T = unknown>(): Promise<T[]> {
    await Promise.all(this.slots.map((slot) => slot.ready));
    return this.slots.map((slot) => slot.warmupResult as T);
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
      this.restartSlot(slot);
    }
  }

  run<T>(request: DaemonWorkerRequest, options: WorkerPoolRunOptions): Promise<T> {
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
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        id,
        request,
        options,
        resolve,
        reject,
        crashAttempts: 0
      };
      this.armDeadline(item);
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
      active: this.slots.filter((slot) => slot.busy).length,
      microbatchSize: this.options.microbatchSize,
      memoryLimitBytes: this.options.memoryLimitBytes
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
      restarting: false,
      ready,
      warmupResult: undefined,
      restartAttempts
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
    worker.postMessage({ id: 0, request: { type: "warmup" } } satisfies WorkerEnvelope);
    return slot;
  }

  private handleMessage(slot: WorkerSlot, message: WorkerReply, readyCallbacks: ReadyCallbacks): void {
    if (message.id === 0) {
      if (message.ok) {
        slot.warmupResult = message.result;
        readyCallbacks.resolveReady();
        this.drain();
      } else {
        this.handleWorkerFailure(slot, poolError(message.error.code ?? "INTERNAL", message.error.message), readyCallbacks);
      }
      return;
    }

    const item = slot.busy;
    if (!item || item.id !== message.id) return;
    slot.busy = undefined;
    slot.restartAttempts = 0;
    this.clearDeadline(item);
    if (message.ok) {
      item.resolve(message.result);
      if (message.memoryRss > this.options.memoryLimitBytes) this.restartSlot(slot);
    } else {
      item.reject(poolError(message.error.code ?? "INTERNAL", message.error.message));
    }
    this.drain();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: Error, readyCallbacks?: ReadyCallbacks): void {
    const item = slot.busy;
    slot.busy = undefined;
    if (item) {
      this.clearDeadline(item);
      if (item.crashAttempts < this.options.maxCrashRetries && Date.now() < item.options.deadline) {
        item.crashAttempts += 1;
        this.armDeadline(item);
        this.queue.unshift(item);
      } else {
        item.reject(poolError("INTERNAL", `${this.options.name} worker crash retry budget exhausted: ${error.message}`));
      }
    }
    this.restartSlot(slot, error, readyCallbacks);
  }

  private restartSlot(slot: WorkerSlot, error?: Error, readyCallbacks?: ReadyCallbacks): void {
    const restartError = error ?? poolError("INTERNAL", `${this.options.name} worker restart failed`);
    if (this.closed) {
      readyCallbacks?.rejectReady(restartError);
      return;
    }
    if (slot.restarting) return;
    const plan = this.restartPlan(slot);
    slot.restarting = true;
    if (!plan) {
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
          if (readyCallbacks) void replacement.ready.then(readyCallbacks.resolveReady, readyCallbacks.rejectReady);
          void replacement.ready.then(() => this.drain(), () => {});
        }, plan.delayMs);
        timer.unref();
      } else {
        readyCallbacks?.rejectReady(restartError);
      }
    });
  }

  private drain(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.busy || slot.restarting) continue;
      const item = this.dequeueRunnable();
      if (!item) return;
      if (Date.now() >= item.options.deadline) {
        this.rejectItem(item, "DEADLINE_EXCEEDED", `${this.options.name} queue deadline expired before execution`);
        continue;
      }
      if (this.cancelled.has(item.options.cancellationId)) {
        this.rejectItem(item, "CANCELLED", `${this.options.name} request was cancelled before execution`);
        continue;
      }
      slot.busy = item;
      slot.worker.postMessage({ id: item.id, request: item.request } satisfies WorkerEnvelope);
    }
  }

  private dequeueRunnable(): QueueItem<unknown> | undefined {
    if (this.queue.length === 0) return undefined;
    const vaults = [...new Set(this.queue.map((item) => item.options.vault ?? ""))];
    const start = this.lastVault === undefined ? 0 : Math.max(0, vaults.indexOf(this.lastVault) + 1);
    const orderedVaults = [...vaults.slice(start), ...vaults.slice(0, start)];
    for (const vault of orderedVaults) {
      const index = this.queue.findIndex((item) => (item.options.vault ?? "") === vault);
      if (index < 0) continue;
      const [item] = this.queue.splice(index, 1);
      this.lastVault = vault;
      return item;
    }
    return this.queue.shift();
  }

  private idleSlot(): WorkerSlot | undefined {
    return this.slots.find((slot) => !slot.busy && !slot.restarting);
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
        this.restartSlot(slot, poolError("DEADLINE_EXCEEDED", `${this.options.name} deadline expired`));
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

export function workerCountFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return Math.max(1, fallback);
  if (!/^\d+$/.test(raw)) return Math.max(1, fallback);
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

function restartBackoffMs(attempts: number): number {
  return Math.min(SLOT_RESTART_BACKOFF_CAP_MS, SLOT_RESTART_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function poolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
