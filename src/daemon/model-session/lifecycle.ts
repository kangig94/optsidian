export type ModelDevice = "gpu" | "cpu";

export type VramProbeResult = {
  freeBytes: number;
  totalBytes?: number;
};

export type ModelEncodeOrigin = "query-text" | "document-embed";

export type ModelSession = {
  readonly device: ModelDevice;
  encode(texts: readonly string[], options?: {
    signal?: AbortSignal;
    inputKind?: "query" | "document";
  }): Promise<readonly (readonly number[])[]>;
  close(): void | Promise<void>;
};

export type ModelSessionLifecycleOptions = {
  requiredVramBytes: number;
  probeVram: () => VramProbeResult | Promise<VramProbeResult>;
  loadSession: (device: ModelDevice, options: { signal?: AbortSignal }) => Promise<ModelSession>;
  terminateLoad?: (device: ModelDevice, reason: "deadline" | "abort") => void | Promise<void>;
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
  private readonly terminateLoad: (device: ModelDevice, reason: "deadline" | "abort") => void | Promise<void>;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly isOomError: (error: unknown) => boolean;
  private session: ModelSession | undefined;
  private loading: {
    promise: Promise<ModelSession>;
    device: ModelDevice;
    generation: number;
    controller: AbortController;
    waiters: number;
  } | undefined;
  private coldLoad: Promise<ModelSession> | undefined;
  private coldLoadWaiters = 0;
  private coldLoadCancelled = false;
  private loadGeneration = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private suppressPromotionAfterGpuOom = false;
  private currentLoadCancelled = false;

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

  async encode(texts: readonly string[], options: {
    deadline: number;
    signal?: AbortSignal;
    origin: ModelEncodeOrigin;
    suppressCpuPromotion?: boolean;
  }): Promise<readonly (readonly number[])[]> {
    const session = await this.ensureSession({
      deadline: options.deadline,
      signal: options.signal
    });
    try {
      const output = await abortable(
        session.encode(texts, {
          signal: options.signal,
          inputKind: options.origin === "query-text" ? "query" : "document"
        }),
        options.signal,
        () => undefined
      );
      if (!options.suppressCpuPromotion) {
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
      ...(this.loading ? { loadingDevice: this.loading.device } : {}),
      ...(this.idleTimer ? { idleDeadline: new Date(this.now() + this.idleMs).toISOString() } : {})
    };
  }

  private async ensureSession(options: { deadline: number; signal?: AbortSignal }): Promise<ModelSession> {
    if (this.session) {
      this.clearIdleUnload();
      return this.session;
    }
    if (this.loading) {
      return this.waitForSharedLoad(this.loading, options.deadline, options.signal);
    }
    if (this.coldLoad) {
      return this.waitForColdLoad(this.coldLoad, options.deadline, options.signal);
    }
    this.coldLoadCancelled = false;
    const coldLoad = (async () => {
      const device = await this.pickDevice();
      if (this.coldLoadCancelled) {
        throw Object.assign(new Error("model session load was cancelled"), { code: "CANCELLED" });
      }
      return this.startLoadWithFallback(device, options);
    })().finally(() => {
      if (this.coldLoad === coldLoad) this.coldLoad = undefined;
      this.coldLoadWaiters = 0;
    });
    this.coldLoad = coldLoad;
    return this.waitForColdLoad(coldLoad, options.deadline, options.signal);
  }

  private async startLoadWithFallback(
    device: ModelDevice,
    options: { deadline: number; signal?: AbortSignal }
  ): Promise<ModelSession> {
    try {
      return await this.startLoad(device, options);
    } catch (error) {
      if (device !== "gpu" || !this.isOomError(error)) throw error;
      this.suppressPromotionAfterGpuOom = true;
      await this.cancelLoading("gpu", "abort");
      return this.startLoad("cpu", options);
    }
  }

  private async startLoad(device: ModelDevice, options: { deadline: number; signal?: AbortSignal }): Promise<ModelSession> {
    const generation = ++this.loadGeneration;
    this.currentLoadCancelled = false;
    const controller = new AbortController();
    const rawLoad = this.loadSession(device, { signal: controller.signal });
    const promise = rawLoad.then(async (session) => {
      if (this.loadGeneration !== generation) {
        await session.close();
        throw Object.assign(new Error("model session load was superseded"), { code: "CANCELLED" });
      }
      this.session = session;
      this.loading = undefined;
      this.armIdleUnload();
      return session;
    }).catch((error) => {
      if (this.loading?.generation === generation) this.loading = undefined;
      throw error;
    });
    this.loading = { promise, device, generation, controller, waiters: 0 };
    return promise;
  }

  private async promoteCpuSessionIfGpuAvailable(signal: AbortSignal | undefined): Promise<void> {
    const current = this.session;
    if (!current || current.device !== "cpu") return;
    if (this.suppressPromotionAfterGpuOom) {
      this.suppressPromotionAfterGpuOom = false;
      return;
    }
    const device = await this.pickDevice();
    if (device !== "gpu") return;
    const generation = ++this.loadGeneration;
    try {
      const gpu = await abortable(this.loadSession("gpu", { signal }), signal, () => this.terminateLoad("gpu", "abort"));
      if (this.session !== current || this.loadGeneration !== generation) {
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
    if (this.requiredVramBytes <= 0) return "cpu";
    const vram = await this.probeVram();
    return vram.freeBytes >= this.requiredVramBytes * 1.5 ? "gpu" : "cpu";
  }

  private withDeadline<T>(promise: Promise<T>, device: ModelDevice, deadline: number): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      void this.cancelLoading(device, "deadline");
      return Promise.reject(Object.assign(new Error("model session load deadline exceeded"), { code: "DEADLINE_EXCEEDED" }));
    }
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = this.setTimer(() => {
          void this.cancelLoading(device, "deadline");
          reject(Object.assign(new Error("model session load deadline exceeded"), { code: "DEADLINE_EXCEEDED" }));
        }, remaining);
        timer.unref?.();
      })
    ]).finally(() => {
      if (timer) this.clearTimer(timer);
    });
  }

  private async cancelLoading(device: ModelDevice | undefined, reason: "deadline" | "abort"): Promise<void> {
    if (this.currentLoadCancelled) return;
    this.currentLoadCancelled = true;
    this.loadGeneration += 1;
    const loading = this.loading;
    if (loading) loading.controller.abort(reason);
    this.loading = undefined;
    this.coldLoad = undefined;
    this.coldLoadCancelled = true;
    this.coldLoadWaiters = 0;
    if (device) await this.terminateLoad(device, reason);
  }

  private waitForColdLoad(
    promise: Promise<ModelSession>,
    deadline: number,
    signal: AbortSignal | undefined
  ): Promise<ModelSession> {
    this.coldLoadWaiters += 1;
    return this.waitForLoadPromise(
      promise,
      deadline,
      signal,
      () => this.loading?.device,
      (reason) => this.releaseColdLoadWaiter(reason)
    );
  }

  private waitForSharedLoad(
    loading: NonNullable<ModelSessionLifecycle["loading"]>,
    deadline: number,
    signal: AbortSignal | undefined
  ): Promise<ModelSession> {
    loading.waiters += 1;
    return this.waitForLoadPromise(
      loading.promise,
      deadline,
      signal,
      () => loading.device,
      (reason) => this.releaseSharedLoadWaiter(loading, reason)
    );
  }

  private async waitForLoadPromise(
    promise: Promise<ModelSession>,
    deadline: number,
    signal: AbortSignal | undefined,
    device: () => ModelDevice | undefined,
    release: (reason: "deadline" | "abort" | "settled") => void | Promise<void>
  ): Promise<ModelSession> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      await release("deadline");
      throw Object.assign(new Error("model session load deadline exceeded"), { code: "DEADLINE_EXCEEDED" });
    }
    if (signal?.aborted) {
      await release("abort");
      throw Object.assign(new Error("model session request was aborted"), { code: "CANCELLED" });
    }
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    let settled = false;
    const waiter = new Promise<ModelSession>((_resolve, reject) => {
      timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        void Promise.resolve(release("deadline")).finally(() => {
          reject(Object.assign(new Error("model session load deadline exceeded"), { code: "DEADLINE_EXCEEDED" }));
        });
      }, remaining);
      timer.unref?.();
      if (signal) {
        abort = () => {
          if (settled) return;
          settled = true;
          void Promise.resolve(release("abort")).finally(() => {
            reject(Object.assign(new Error("model session request was aborted"), { code: "CANCELLED" }));
          });
        };
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      return await Promise.race([promise, waiter]);
    } finally {
      if (!settled) {
        settled = true;
        await release("settled");
      }
      if (timer) this.clearTimer(timer);
      if (abort && signal) signal.removeEventListener("abort", abort);
      void device;
    }
  }

  private async releaseColdLoadWaiter(reason: "deadline" | "abort" | "settled"): Promise<void> {
    this.coldLoadWaiters = Math.max(0, this.coldLoadWaiters - 1);
    if (reason === "settled" || this.session || this.coldLoadWaiters > 0) return;
    const loading = this.loading;
    await this.cancelLoading(loading?.device, reason);
  }

  private async releaseSharedLoadWaiter(
    loading: NonNullable<ModelSessionLifecycle["loading"]>,
    reason: "deadline" | "abort" | "settled"
  ): Promise<void> {
    loading.waiters = Math.max(0, loading.waiters - 1);
    if (reason === "settled" || this.session) return;
    if (loading.waiters + this.coldLoadWaiters > 0) return;
    await this.cancelLoading(loading.device, reason);
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
  onAbort: () => void | Promise<void>
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    await onAbort();
    throw Object.assign(new Error("model session request was aborted"), { code: "CANCELLED" });
  }
  let abort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    abort = () => {
      void Promise.resolve(onAbort()).finally(() => {
        reject(Object.assign(new Error("model session request was aborted"), { code: "CANCELLED" }));
      });
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function defaultIsOomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /out[- ]?of[- ]?memory|oom|cuda.*memory/i.test(message);
}
