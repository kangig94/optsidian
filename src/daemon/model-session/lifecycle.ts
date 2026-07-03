import { Attempt, type AttemptOwner } from '../../core/lifecycle/conditional-commit.js';

export type ModelDevice = 'gpu' | 'cpu';

export type VramProbeResult = {
  freeBytes: number;
  totalBytes?: number;
};

export type ModelEncodeOrigin = 'query-text' | 'document-embed';

export type ModelSession = {
  readonly device: ModelDevice;
  encode(
    texts: readonly string[],
    options?: {
      signal?: AbortSignal;
      inputKind?: 'query' | 'document';
    },
  ): Promise<readonly (readonly number[])[]>;
  close(): void | Promise<void>;
};

export type ModelSessionLifecycleOptions = {
  requiredVramBytes: number;
  probeVram: () => VramProbeResult | Promise<VramProbeResult>;
  loadSession: (device: ModelDevice, options: { signal?: AbortSignal }) => Promise<ModelSession>;
  terminateLoad?: (device: ModelDevice, reason: 'deadline' | 'abort') => void | Promise<void>;
  idleMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  isOomError?: (error: unknown) => boolean;
};

export class ModelSessionLifecycle {
  private readonly requiredVramBytes: number;
  private readonly probeVram: () => VramProbeResult | Promise<VramProbeResult>;
  private readonly loadSession: (device: ModelDevice, options: { signal?: AbortSignal }) => Promise<ModelSession>;
  private readonly terminateLoad: (device: ModelDevice, reason: 'deadline' | 'abort') => void | Promise<void>;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly isOomError: (error: unknown) => boolean;
  private readonly loadAttemptOwner: AttemptOwner<ModelSession> = { current: undefined };
  private session: ModelSession | undefined;
  private loadAttempt: Attempt<ModelSession> | undefined;
  private loadingDevice: ModelDevice | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private suppressPromotionAfterGpuOom = false;

  constructor(options: ModelSessionLifecycleOptions) {
    this.requiredVramBytes = options.requiredVramBytes;
    this.probeVram = options.probeVram;
    this.loadSession = options.loadSession;
    this.terminateLoad = options.terminateLoad ?? (() => undefined);
    this.idleMs = options.idleMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.isOomError = options.isOomError ?? defaultIsOomError;
  }

  async encode(
    texts: readonly string[],
    options: {
      deadline: number;
      signal?: AbortSignal;
      origin: ModelEncodeOrigin;
      suppressCpuPromotion?: boolean;
    },
  ): Promise<readonly (readonly number[])[]> {
    const session = await this.ensureSession({
      deadline: options.deadline,
      signal: options.signal,
    });
    try {
      const output = await abortable(
        session.encode(texts, {
          signal: options.signal,
          inputKind: options.origin === 'query-text' ? 'query' : 'document',
        }),
        options.signal,
        () => undefined,
      );
      if (options.origin === 'query-text' && !options.suppressCpuPromotion) {
        await this.promoteCpuSessionIfGpuAvailable(options.signal);
      }
      return output;
    } finally {
      // Re-arm idle unload even when the encode (or promotion) throws — `ensureSession` cleared the
      // timer on entry, so a failed encode would otherwise leave the loaded session resident forever.
      this.armIdleUnload();
    }
  }

  async unload(): Promise<void> {
    this.clearIdleUnload();
    const attempt = this.loadAttempt;
    if (attempt && this.loadAttemptOwner.current === attempt) {
      this.loadAttemptOwner.current = undefined;
      const device = this.loadingDevice;
      this.loadingDevice = undefined;
      if (device) await this.terminateLoad(device, 'abort');
    }
    const session = this.session;
    this.session = undefined;
    if (session) await session.close();
  }

  stats(): {
    loaded: boolean;
    device?: ModelDevice;
    loadingDevice?: ModelDevice;
    idleDeadline?: string;
  } {
    return {
      loaded: this.session !== undefined,
      ...(this.session ? { device: this.session.device } : {}),
      ...(this.loadingDevice ? { loadingDevice: this.loadingDevice } : {}),
      ...(this.idleTimer ? { idleDeadline: new Date(this.now() + this.idleMs).toISOString() } : {}),
    };
  }

  private async ensureSession(options: { deadline: number; signal?: AbortSignal }): Promise<ModelSession> {
    if (this.session) {
      this.clearIdleUnload();
      return this.session;
    }
    const current = this.loadAttempt;
    if (current && !current.aborted) {
      return this.waitForLoadAttempt(current, options.deadline, options.signal);
    }

    const attempt = Attempt.start(
      this.loadAttemptOwner,
      async (signal) => {
        const device = await this.pickDevice();
        throwIfLoadAborted(signal);
        return this.startLoadWithFallback(device, signal);
      },
      {
        install: (session) => {
          this.session = session;
          this.armIdleUnload();
        },
        close: (session) => session.close(),
      },
    );
    this.loadAttempt = attempt;
    attempt.result
      .finally(() => {
        if (this.loadAttempt !== attempt) return;
        this.loadAttempt = undefined;
        if (this.loadAttemptOwner.current === attempt) this.loadAttemptOwner.current = undefined;
        this.loadingDevice = undefined;
      })
      .catch(() => undefined);
    return this.waitForLoadAttempt(attempt, options.deadline, options.signal);
  }

  private async startLoadWithFallback(device: ModelDevice, signal: AbortSignal): Promise<ModelSession> {
    try {
      return await this.startLoad(device, signal);
    } catch (error) {
      throwIfLoadAborted(signal);
      if (device !== 'gpu' || !this.isOomError(error)) throw error;
      this.suppressPromotionAfterGpuOom = true;
      await this.terminateLoad('gpu', 'abort');
      return this.startLoad('cpu', signal);
    }
  }

  private async startLoad(device: ModelDevice, signal: AbortSignal): Promise<ModelSession> {
    this.loadingDevice = device;
    throwIfLoadAborted(signal);
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      if (this.loadingDevice === device) this.loadingDevice = undefined;
      void this.terminateLoad(device, loadTerminationReason(signal));
    };
    signal.addEventListener('abort', terminate, { once: true });
    try {
      return await this.loadSession(device, { signal });
    } finally {
      signal.removeEventListener('abort', terminate);
    }
  }

  private async promoteCpuSessionIfGpuAvailable(signal: AbortSignal | undefined): Promise<void> {
    const current = this.session;
    if (!current || current.device !== 'cpu') return;
    if (this.suppressPromotionAfterGpuOom) {
      this.suppressPromotionAfterGpuOom = false;
      return;
    }
    const device = await this.pickDevice();
    if (device !== 'gpu') return;
    try {
      const gpu = await abortable(this.loadSession('gpu', { signal }), signal, () =>
        this.terminateLoad('gpu', 'abort'),
      );
      if (this.session !== current) {
        await gpu.close();
        return;
      }
      await current.close();
      this.session = gpu;
      this.armIdleUnload();
    } catch (error) {
      if (!this.isOomError(error)) throw error;
    }
  }

  private async pickDevice(): Promise<ModelDevice> {
    // Required VRAM of 0 means "unconfigured" (the out-of-box default) — treat it as CPU rather
    // than letting `0 >= 0 * 1.5` select GPU, so the documented "default is CPU" holds.
    if (this.requiredVramBytes <= 0) return 'cpu';
    const vram = await this.probeVram();
    return vram.freeBytes >= this.requiredVramBytes * 1.5 ? 'gpu' : 'cpu';
  }

  private async waitForLoadAttempt(
    attempt: Attempt<ModelSession>,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<ModelSession> {
    const waiterSignal = this.createWaiterSignal(deadline, signal);
    try {
      return await attempt.wait({ signal: waiterSignal.signal });
    } finally {
      waiterSignal.dispose();
    }
  }

  private createWaiterSignal(
    deadline: number,
    signal: AbortSignal | undefined,
  ): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const abortOnce = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      abortOnce(deadlineExceededError());
    } else {
      timer = this.setTimer(() => {
        abortOnce(deadlineExceededError());
      }, remaining);
      timer.unref?.();
    }
    if (signal?.aborted) {
      abortOnce(requestAbortedError());
    } else if (signal) {
      abort = () => {
        abortOnce(requestAbortedError());
      };
      signal.addEventListener('abort', abort, { once: true });
    }
    return {
      signal: controller.signal,
      dispose: () => {
        if (timer) this.clearTimer(timer);
        if (abort && signal) signal.removeEventListener('abort', abort);
      },
    };
  }

  private armIdleUnload(): void {
    this.clearIdleUnload();
    if (this.idleMs <= 0) {
      void this.unload().catch(() => undefined);
      return;
    }
    this.idleTimer = this.setTimer(() => {
      void this.unload().catch(() => undefined);
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleUnload(): void {
    if (!this.idleTimer) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void | Promise<void>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    await onAbort();
    throw requestAbortedError();
  }
  let abort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    abort = () => {
      void Promise.resolve(onAbort()).finally(() => {
        reject(requestAbortedError());
      });
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function defaultIsOomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /out[- ]?of[- ]?memory|oom|cuda.*memory/i.test(message);
}

function throwIfLoadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = abortSignalReason(signal);
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error('model session load was cancelled'), { code: 'CANCELLED' });
}

function loadTerminationReason(signal: AbortSignal): 'deadline' | 'abort' {
  return errorCode(abortSignalReason(signal)) === 'DEADLINE_EXCEEDED' ? 'deadline' : 'abort';
}

function deadlineExceededError(): Error {
  return Object.assign(new Error('model session load deadline exceeded'), { code: 'DEADLINE_EXCEEDED' });
}

function requestAbortedError(): Error {
  return Object.assign(new Error('model session request was aborted'), { code: 'CANCELLED' });
}

function abortSignalReason(signal: AbortSignal): unknown {
  return 'reason' in signal ? signal.reason : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
