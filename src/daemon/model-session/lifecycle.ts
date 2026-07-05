import {
  Attempt,
  AttemptCancelledError,
  AttemptSupersededError,
  type AttemptOwner,
} from '../../core/lifecycle/conditional-commit.js';
import type { EmbeddingProviderIdentity } from '../../core/search/dense/provider.js';
import { isOnnxDeviceFailure, type OnnxExecutionProvider } from '../../core/search/dense/local-onnx.js';
import { VRAM_PROBE_TTL_MS } from './vram-probe.js';

export type ModelDevice = 'gpu' | 'cpu';
export type ModelLoadPurpose = 'initial' | 'fallback' | 'promotion';
export type ModelLoadTerminationReason = 'deadline' | 'abort' | 'superseded';

type VramProbeResult = {
  freeBytes: number;
  totalBytes?: number;
  atMs?: number;
  fresh?: boolean;
};

export type DeviceLoadPolicy =
  | { mode: 'cpu' }
  | { mode: 'auto'; requiredVramBytes: number; probeVram: () => VramProbeResult | Promise<VramProbeResult> }
  | { mode: 'gpu' };

export type ModelEncodeOrigin = 'query-text' | 'document-embed';

export type ModelSession = {
  readonly requestedLoadDevice: ModelDevice;
  readonly device: ModelDevice;
  readonly executionProvider?: OnnxExecutionProvider;
  readonly providerIdentity?: EmbeddingProviderIdentity;
  readonly stableProviderKey?: string;
  encode(
    texts: readonly string[],
    options?: {
      signal?: AbortSignal;
      inputKind?: 'query' | 'document';
    },
  ): Promise<readonly (readonly number[])[]>;
  close(): void | Promise<void>;
};

export type ModelSessionLoadOptions = {
  signal?: AbortSignal;
  loadId: string;
  purpose: ModelLoadPurpose;
};

export type ModelSessionLifecycleStats = {
  loaded: boolean;
  devicePolicy: DeviceLoadPolicy['mode'];
  stableProviderKey?: string;
  providerIdentity?: EmbeddingProviderIdentity;
  requestedLoadDevice?: ModelDevice;
  device?: ModelDevice;
  executionProvider?: OnnxExecutionProvider;
  loadingDevice?: ModelDevice;
  idleDeadline?: string;
};

type ModelSessionFacts = {
  providerIdentity?: EmbeddingProviderIdentity;
  stableProviderKey?: string;
  requestedLoadDevice: ModelDevice;
  device: ModelDevice;
  executionProvider?: OnnxExecutionProvider;
};

export type ModelSessionEncodeResult = ModelSessionFacts & {
  vectors: readonly (readonly number[])[];
};

export type ModelSessionLifecycleOptions = {
  policy: DeviceLoadPolicy;
  loadSession: (device: ModelDevice, options: ModelSessionLoadOptions) => Promise<ModelSession>;
  terminateLoad?: (loadId: string, device: ModelDevice, reason: ModelLoadTerminationReason) => void | Promise<void>;
  idleMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

type LoadDeviceSelection = {
  device: ModelDevice;
  probeEpochMs?: number;
};

type ActiveOwnedLoad = {
  loadId: string;
  requestedDevice: ModelDevice;
  purpose: ModelLoadPurpose;
  terminate(reason: ModelLoadTerminationReason): Promise<void>;
};

class GpuPromotionUnavailableError extends Error {
  constructor() {
    super('GPU promotion did not produce a GPU session');
    this.name = 'GpuPromotionUnavailableError';
  }
}

export class ModelSessionLifecycle {
  private readonly policy: DeviceLoadPolicy;
  private readonly loadSession: (device: ModelDevice, options: ModelSessionLoadOptions) => Promise<ModelSession>;
  private readonly terminateLoad: (
    loadId: string,
    device: ModelDevice,
    reason: ModelLoadTerminationReason,
  ) => void | Promise<void>;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly loadAttemptOwner: AttemptOwner<ModelSession> = { current: undefined };
  private readonly promotionAttemptOwner: AttemptOwner<ModelSession> = { current: undefined };
  private readonly activeLoads = new Map<string, ActiveOwnedLoad>();
  private session: ModelSession | undefined;
  private loadAttempt: Attempt<ModelSession> | undefined;
  private promotionAttempt: Attempt<ModelSession> | undefined;
  private loadingDevice: ModelDevice | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private nextLoadId = 1;
  private gpuUnavailableUntilMs: number | undefined;

  constructor(options: ModelSessionLifecycleOptions) {
    this.policy = options.policy;
    this.loadSession = options.loadSession;
    this.terminateLoad = options.terminateLoad ?? (() => undefined);
    this.idleMs = options.idleMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async encode(
    texts: readonly string[],
    options: {
      deadline: number;
      signal?: AbortSignal;
      origin: ModelEncodeOrigin;
      suppressCpuPromotion?: boolean;
    },
  ): Promise<ModelSessionEncodeResult> {
    let session = await this.ensureSession({
      deadline: options.deadline,
      signal: options.signal,
    });
    let suppressPromotion =
      options.suppressCpuPromotion === true ||
      (this.policy.mode === 'auto' && session.requestedLoadDevice === 'gpu' && session.device === 'cpu');
    try {
      let vectors: readonly (readonly number[])[];
      try {
        vectors = await this.encodeWithSession(session, texts, options);
      } catch (error) {
        if (!this.isGpuRuntimeDeviceFailure(session, error)) throw error;
        await this.retireResidentSession(session);
        if (this.policy.mode === 'gpu') throw modelDeviceUnavailableError(error);
        this.markGpuUnavailableFromNow();
        session = await this.ensureSession({
          deadline: options.deadline,
          signal: options.signal,
        });
        suppressPromotion = true;
        vectors = await this.encodeWithSession(session, texts, options);
      }
      const facts = modelSessionFacts(session);
      if (options.origin === 'query-text' && !suppressPromotion) {
        void this.promoteCpuSessionIfGpuAvailable(options.signal).catch(() => undefined);
      }
      return { vectors, ...facts };
    } finally {
      if (this.session) this.armIdleUnload();
    }
  }

  async unload(reason: Extract<ModelLoadTerminationReason, 'abort' | 'superseded'> = 'abort'): Promise<void> {
    this.clearIdleUnload();
    const attempts = [this.loadAttempt, this.promotionAttempt].filter(
      (attempt): attempt is Attempt<ModelSession> => attempt !== undefined,
    );
    if (this.loadAttempt && this.loadAttemptOwner.current === this.loadAttempt) {
      this.loadAttemptOwner.current = undefined;
    }
    if (this.promotionAttempt && this.promotionAttemptOwner.current === this.promotionAttempt) {
      this.promotionAttemptOwner.current = undefined;
    }
    for (const attempt of attempts) {
      attempt.cancel(new AttemptCancelledError(`Model session load was ${reason}.`));
    }
    await Promise.all([...this.activeLoads.values()].map((load) => load.terminate(reason)));
    await Promise.all(attempts.map((attempt) => attempt.result.catch(() => undefined)));
    this.loadAttempt = undefined;
    this.promotionAttempt = undefined;
    this.loadingDevice = undefined;

    const session = this.session;
    this.session = undefined;
    if (session) await session.close();
  }

  stats(): ModelSessionLifecycleStats {
    const session = this.session;
    return {
      loaded: session !== undefined,
      devicePolicy: this.policy.mode,
      ...(session?.stableProviderKey ? { stableProviderKey: session.stableProviderKey } : {}),
      ...(session?.providerIdentity ? { providerIdentity: session.providerIdentity } : {}),
      ...(session?.requestedLoadDevice ? { requestedLoadDevice: session.requestedLoadDevice } : {}),
      ...(session?.device ? { device: session.device } : {}),
      ...(session?.executionProvider ? { executionProvider: session.executionProvider } : {}),
      ...(this.loadingDevice ? { loadingDevice: this.loadingDevice } : {}),
      ...(this.idleTimer ? { idleDeadline: new Date(this.now() + this.idleMs).toISOString() } : {}),
    };
  }

  currentSession(): ModelSession | undefined {
    return this.session;
  }

  private async ensureSession(options: { deadline: number; signal?: AbortSignal }): Promise<ModelSession> {
    if (this.session) {
      this.clearIdleUnload();
      return this.session;
    }
    const current = this.loadAttempt;
    if (current) {
      if (!current.aborted) return this.waitForLoadAttempt(current, options.deadline, options.signal);
      await this.waitForAttemptSettlement(current, options.deadline, options.signal);
      if (this.session) {
        this.clearIdleUnload();
        return this.session;
      }
    }

    const attempt = Attempt.start(
      this.loadAttemptOwner,
      async (signal) => {
        const selection = await this.pickLoadDevice();
        throwIfLoadAborted(signal);
        return this.startLoadWithFallback(selection, signal, 'initial');
      },
      {
        install: (session) => {
          this.session = session;
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
        this.refreshLoadingDevice();
      })
      .catch(() => undefined);
    return this.waitForLoadAttempt(attempt, options.deadline, options.signal);
  }

  private async startLoadWithFallback(
    selection: LoadDeviceSelection,
    signal: AbortSignal,
    purpose: ModelLoadPurpose,
  ): Promise<ModelSession> {
    if (selection.device !== 'gpu') return this.startOwnedLoad('cpu', signal, purpose);

    try {
      const session = await this.startOwnedLoad('gpu', signal, purpose);
      if (this.policy.mode === 'gpu' && session.device !== 'gpu') {
        await session.close();
        throw modelDeviceUnavailableError(new Error('forced GPU load produced a CPU session'));
      }
      this.noteGpuRequestedLoadResult(session, selection);
      return session;
    } catch (error) {
      throwIfLoadAborted(signal);
      if (isLifecycleCancellation(error)) throw error;
      if (this.policy.mode === 'gpu') throw modelDeviceUnavailableError(error);
      if (this.policy.mode !== 'auto') throw error;
      this.markGpuUnavailableFromNow();
      return this.startOwnedLoad('cpu', signal, 'fallback');
    }
  }

  private async startOwnedLoad(
    requestedDevice: ModelDevice,
    signal: AbortSignal,
    purpose: ModelLoadPurpose,
  ): Promise<ModelSession> {
    const loadId = `model-load-${this.nextLoadId++}`;
    let terminationPromise: Promise<void> | undefined;
    const load: ActiveOwnedLoad = {
      loadId,
      requestedDevice,
      purpose,
      terminate: async (reason) => {
        terminationPromise ??= Promise.resolve(this.terminateLoad(loadId, requestedDevice, reason));
        await terminationPromise;
      },
    };
    this.activeLoads.set(loadId, load);
    this.loadingDevice = requestedDevice;

    const terminateOnAbort = () => {
      void load.terminate(loadTerminationReason(signal)).catch(() => undefined);
    };
    if (signal.aborted) {
      await load.terminate(loadTerminationReason(signal));
      throwIfLoadAborted(signal);
    }
    signal.addEventListener('abort', terminateOnAbort, { once: true });
    try {
      return await this.loadSession(requestedDevice, { signal, loadId, purpose });
    } finally {
      signal.removeEventListener('abort', terminateOnAbort);
      this.activeLoads.delete(loadId);
      this.refreshLoadingDevice();
    }
  }

  private async promoteCpuSessionIfGpuAvailable(signal: AbortSignal | undefined): Promise<void> {
    if (this.policy.mode !== 'auto') return;
    const current = this.session;
    if (!current || current.device !== 'cpu') return;
    if (this.promotionAttempt) {
      await this.promotionAttempt.wait({ signal }).catch((error: unknown) => {
        if (signal?.aborted && errorCode(error) === 'CANCELLED') throw error;
      });
      return;
    }
    const selection = await this.pickLoadDevice();
    if (selection.device !== 'gpu') return;

    const attempt = Attempt.start(
      this.promotionAttemptOwner,
      async (attemptSignal) => {
        const promoted = await this.startOwnedLoad('gpu', attemptSignal, 'promotion');
        if (promoted.device !== 'gpu') {
          this.markGpuUnavailableFromNow();
          await promoted.close();
          throw new GpuPromotionUnavailableError();
        }
        this.clearGpuUnavailable();
        return promoted;
      },
      {
        install: async (promoted) => {
          if (this.session !== current) throw new AttemptSupersededError();
          await current.close();
          this.session = promoted;
        },
        close: (session) => session.close(),
      },
    );
    this.promotionAttempt = attempt;
    attempt.result
      .finally(() => {
        if (this.promotionAttempt !== attempt) return;
        this.promotionAttempt = undefined;
        if (this.promotionAttemptOwner.current === attempt) this.promotionAttemptOwner.current = undefined;
        this.refreshLoadingDevice();
      })
      .catch(() => undefined);

    try {
      await attempt.wait({ signal });
    } catch (error) {
      if (signal?.aborted && errorCode(error) === 'CANCELLED') throw error;
      if (isLifecycleCancellation(error) || error instanceof GpuPromotionUnavailableError) return;
      this.markGpuUnavailableFromNow();
    }
  }

  private async pickLoadDevice(): Promise<LoadDeviceSelection> {
    if (this.policy.mode === 'cpu') return { device: 'cpu' };
    if (this.policy.mode === 'gpu') return { device: 'gpu' };

    const nowMs = this.now();
    if (this.gpuUnavailableUntilMs !== undefined && nowMs < this.gpuUnavailableUntilMs) {
      return { device: 'cpu' };
    }
    const probe = await this.policy.probeVram();
    const probeEpochMs = probe.atMs ?? nowMs;
    if (probe.fresh !== false) this.clearGpuUnavailable();
    if (probe.freeBytes >= this.policy.requiredVramBytes * 1.5) {
      return { device: 'gpu', probeEpochMs };
    }
    this.markGpuUnavailableFromProbe(probeEpochMs);
    return { device: 'cpu', probeEpochMs };
  }

  private noteGpuRequestedLoadResult(session: ModelSession, _selection: LoadDeviceSelection): void {
    if (session.device === 'gpu') {
      this.clearGpuUnavailable();
      return;
    }
    if (this.policy.mode === 'auto') this.markGpuUnavailableFromNow();
  }

  private markGpuUnavailableFromProbe(probeEpochMs: number | undefined): void {
    if (this.policy.mode !== 'auto') return;
    this.gpuUnavailableUntilMs = (probeEpochMs ?? this.now()) + VRAM_PROBE_TTL_MS;
  }

  private markGpuUnavailableFromNow(): void {
    if (this.policy.mode !== 'auto') return;
    this.gpuUnavailableUntilMs = this.now() + VRAM_PROBE_TTL_MS;
  }

  private clearGpuUnavailable(): void {
    this.gpuUnavailableUntilMs = undefined;
  }

  private async encodeWithSession(
    session: ModelSession,
    texts: readonly string[],
    options: {
      signal?: AbortSignal;
      origin: ModelEncodeOrigin;
    },
  ): Promise<readonly (readonly number[])[]> {
    return abortable(
      session.encode(texts, {
        signal: options.signal,
        inputKind: options.origin === 'query-text' ? 'query' : 'document',
      }),
      options.signal,
      () => undefined,
    );
  }

  private isGpuRuntimeDeviceFailure(session: ModelSession, error: unknown): boolean {
    if (this.policy.mode === 'cpu') return false;
    if (session.device !== 'gpu' && session.executionProvider !== 'cuda' && session.executionProvider !== 'coreml') {
      return false;
    }
    return isOnnxDeviceFailure(error);
  }

  private async retireResidentSession(session: ModelSession): Promise<void> {
    if (this.session === session) this.session = undefined;
    await Promise.resolve(session.close()).catch(() => undefined);
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

  private async waitForAttemptSettlement(
    attempt: Attempt<ModelSession>,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const waiterSignal = this.createWaiterSignal(deadline, signal);
    try {
      await abortable(
        attempt.result.then(
          () => undefined,
          () => undefined,
        ),
        waiterSignal.signal,
        () => undefined,
      );
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

  private refreshLoadingDevice(): void {
    const latest = [...this.activeLoads.values()].at(-1);
    this.loadingDevice = latest?.requestedDevice;
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
    throw errorFromAbortSignal(signal);
  }
  let abort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    abort = () => {
      void Promise.resolve(onAbort()).finally(() => {
        reject(errorFromAbortSignal(signal));
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

function throwIfLoadAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw errorFromAbortSignal(signal);
}

function loadTerminationReason(signal: AbortSignal): ModelLoadTerminationReason {
  return errorCode(abortSignalReason(signal)) === 'DEADLINE_EXCEEDED' ? 'deadline' : 'abort';
}

function deadlineExceededError(): Error {
  return Object.assign(new Error('model session load deadline exceeded'), { code: 'DEADLINE_EXCEEDED' });
}

function requestAbortedError(): Error {
  return Object.assign(new Error('model session request was aborted'), { code: 'CANCELLED' });
}

function errorFromAbortSignal(signal: AbortSignal): Error {
  const reason = abortSignalReason(signal);
  if (reason instanceof Error) return reason;
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

function isLifecycleCancellation(error: unknown): boolean {
  return (
    error instanceof AttemptCancelledError ||
    error instanceof AttemptSupersededError ||
    errorCode(error) === 'CANCELLED' ||
    errorCode(error) === 'DEADLINE_EXCEEDED'
  );
}

function modelSessionFacts(session: ModelSession): ModelSessionFacts {
  return {
    ...(session.providerIdentity ? { providerIdentity: session.providerIdentity } : {}),
    ...(session.stableProviderKey ? { stableProviderKey: session.stableProviderKey } : {}),
    requestedLoadDevice: session.requestedLoadDevice,
    device: session.device,
    ...(session.executionProvider ? { executionProvider: session.executionProvider } : {}),
  };
}

function modelDeviceUnavailableError(error: unknown): Error {
  if (errorCode(error) === 'MODEL_DEVICE_UNAVAILABLE' && error instanceof Error) return error;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`model device unavailable: ${message}`), {
    code: 'MODEL_DEVICE_UNAVAILABLE',
    cause: error,
  });
}
