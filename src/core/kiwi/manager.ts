import { threadId } from 'node:worker_threads';
import { Attempt, type AttemptOwner } from '../lifecycle/conditional-commit.js';
import {
  inspectKiwiModelArtifact,
  inspectKiwiWasmArtifact,
  kiwiDataDir,
  type KiwiModelArtifactInspectOptions,
  type KiwiModelArtifactState,
  type KiwiWasmArtifactState,
} from './artifact.js';
import type { KiwiAnalyzer, KiwiAnalyzerIdentity } from './loader.js';

export type KiwiDeclaredAnalyzer = 'ko';

export type KiwiManagerStatus =
  | {
      state: 'unloaded';
      leaseCount: 0;
      model: KiwiModelArtifactState;
    }
  | {
      state: 'loading';
      leaseCount: number;
      model: KiwiModelArtifactState;
    }
  | {
      state: 'loaded';
      leaseCount: number;
      model: KiwiModelArtifactState;
      identity: KiwiAnalyzerIdentity;
    };

type KiwiLease = {
  analyzer: KiwiAnalyzer | null;
  activeAnalyzers: KiwiDeclaredAnalyzer[];
  release(): Promise<void>;
};

type ActiveKiwiHandle = {
  analyzer: KiwiAnalyzer;
  envKey: string;
  leaseCount: number;
  closed: boolean;
  disposed: boolean;
};

type KiwiManagerOptions = {
  idleTtlMs?: number;
  loadAnalyzer?: (options: { env: NodeJS.ProcessEnv; installIfMissing: boolean }) => Promise<KiwiAnalyzer>;
  inspectModelArtifact?: (env: NodeJS.ProcessEnv, options?: KiwiModelArtifactInspectOptions) => KiwiModelArtifactState;
  inspectWasmArtifact?: (env: NodeJS.ProcessEnv) => KiwiWasmArtifactState;
};

const KIWI_IDLE_TTL_MS = 5 * 60 * 1000;

export class KiwiAnalyzerTerminalLoadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'KiwiAnalyzerTerminalLoadError';
    this.cause = cause;
    Object.setPrototypeOf(this, KiwiAnalyzerTerminalLoadError.prototype);
  }
}

export class KiwiAnalyzerManager {
  private readonly idleTtlMs: number;
  private readonly loadAnalyzer: (options: {
    env: NodeJS.ProcessEnv;
    installIfMissing: boolean;
  }) => Promise<KiwiAnalyzer>;
  private readonly inspectModelArtifact: (
    env: NodeJS.ProcessEnv,
    options?: KiwiModelArtifactInspectOptions,
  ) => KiwiModelArtifactState;
  private readonly inspectWasmArtifact: (env: NodeJS.ProcessEnv) => KiwiWasmArtifactState;
  private readonly loadAttemptOwner: AttemptOwner<ActiveKiwiHandle> = { current: undefined };
  private activeHandle: ActiveKiwiHandle | null = null;
  private loadAttempt: Attempt<ActiveKiwiHandle> | undefined;
  private loadAttemptKey: string | null = null;
  private loadAttemptInstallsIfMissing = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: KiwiManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? KIWI_IDLE_TTL_MS;
    this.loadAnalyzer =
      options.loadAnalyzer ??
      (async (loadOptions) => {
        const { loadKiwiAnalyzer } = await import('./loader.js');
        return loadKiwiAnalyzer(loadOptions);
      });
    this.inspectModelArtifact = options.inspectModelArtifact ?? inspectKiwiModelArtifact;
    this.inspectWasmArtifact = options.inspectWasmArtifact ?? inspectKiwiWasmArtifact;
  }

  status(env: NodeJS.ProcessEnv = process.env): KiwiManagerStatus {
    const key = envKey(env);
    const model = this.inspectModelArtifact(env, { verifyFiles: 'metadata' });
    if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
      return {
        state: 'loaded',
        leaseCount: this.activeHandle.leaseCount,
        model,
        identity: this.activeHandle.analyzer.identity,
      };
    }
    if (this.loadAttempt && this.loadAttemptKey === key) {
      return { state: 'loading', leaseCount: 0, model };
    }
    return { state: 'unloaded', leaseCount: 0, model };
  }

  isTerminalLoadError(error: unknown): boolean {
    return error instanceof KiwiAnalyzerTerminalLoadError;
  }

  async withAnalyzerLease<T>(
    env: NodeJS.ProcessEnv,
    declaredAnalyzers: readonly KiwiDeclaredAnalyzer[],
    options: { wait: boolean; installIfMissing: boolean },
    run: (lease: { analyzer: KiwiAnalyzer | null; activeAnalyzers: KiwiDeclaredAnalyzer[] }) => T | Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(env, declaredAnalyzers, options);
    try {
      return await run({ analyzer: lease.analyzer, activeAnalyzers: lease.activeAnalyzers });
    } finally {
      await lease.release();
    }
  }

  currentAnalyzer(): KiwiAnalyzer | null {
    return this.activeHandle && !this.activeHandle.closed ? this.activeHandle.analyzer : null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    const attempt = this.loadAttempt;
    if (attempt && this.loadAttemptOwner.current === attempt) this.loadAttemptOwner.current = undefined;
    this.loadAttempt = undefined;
    this.loadAttemptKey = null;
    this.loadAttemptInstallsIfMissing = false;
    const handle = this.activeHandle;
    if (handle) await this.disposeHandle(handle);
  }

  private async acquire(
    env: NodeJS.ProcessEnv,
    declaredAnalyzers: readonly KiwiDeclaredAnalyzer[],
    options: { wait: boolean; installIfMissing: boolean },
  ): Promise<KiwiLease> {
    if (this.closed) {
      throw Object.assign(new Error('Kiwi analyzer manager is closed'), { code: 'CLOSED' });
    }
    const normalized = normalizeDeclaredAnalyzers(declaredAnalyzers);
    if (!normalized.includes('ko')) return noopLease(normalized);
    const key = envKey(env);

    const existing = this.activeHandle;
    if (existing && !existing.closed && existing.envKey === key) {
      return this.leaseHandle(existing, normalized);
    }

    if (!options.wait) return noopLease(withoutKiwi(normalized));

    const handle = await this.ensureLoaded(env, options.installIfMissing);
    return this.leaseHandle(handle, normalized);
  }

  private async ensureLoaded(env: NodeJS.ProcessEnv, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    const key = envKey(env);
    if (this.closed) {
      throw Object.assign(new Error('Kiwi analyzer manager is closed'), { code: 'CLOSED' });
    }
    if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
      return this.activeHandle;
    }
    while (this.loadAttempt) {
      const pending = this.loadAttempt;
      if (this.loadAttemptKey === key && (this.loadAttemptInstallsIfMissing || !installIfMissing)) {
        return pending.wait();
      }
      try {
        await pending.wait();
      } catch {
        // The caller needs the requested env/load mode; retry after the in-flight load settles.
      }
      if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
        return this.activeHandle;
      }
    }

    this.clearIdleTimer();
    const attempt = Attempt.start(this.loadAttemptOwner, () => this.loadFresh(env, installIfMissing), {
      install: async (handle) => {
        if (this.closed) throw Object.assign(new Error('Kiwi analyzer manager is closed'), { code: 'CLOSED' });
        await this.replaceActiveHandle(handle);
      },
      close: (handle) => this.disposeHandle(handle),
    });
    this.loadAttempt = attempt;
    this.loadAttemptKey = key;
    this.loadAttemptInstallsIfMissing = installIfMissing;
    attempt.result
      .finally(() => {
        if (this.loadAttempt !== attempt) return;
        this.loadAttempt = undefined;
        this.loadAttemptKey = null;
        this.loadAttemptInstallsIfMissing = false;
        if (this.loadAttemptOwner.current === attempt) this.loadAttemptOwner.current = undefined;
      })
      .catch(() => undefined);
    return attempt.wait();
  }

  private async loadFresh(env: NodeJS.ProcessEnv, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    try {
      const analyzer = await this.loadAnalyzer({ env, installIfMissing });
      const handle: ActiveKiwiHandle = {
        analyzer,
        envKey: envKey(env),
        leaseCount: 0,
        closed: false,
        disposed: false,
      };
      return handle;
    } catch (error) {
      const model = this.inspectModelArtifact(env);
      const wasm = this.inspectWasmArtifact(env);
      if (model.installed && wasm.installed) {
        throw new KiwiAnalyzerTerminalLoadError(`Kiwi analyzer load failed: ${errorMessage(error)}`, error);
      }
      throw error;
    }
  }

  private leaseHandle(handle: ActiveKiwiHandle, activeAnalyzers: KiwiDeclaredAnalyzer[]): KiwiLease {
    this.clearIdleTimer();
    handle.leaseCount += 1;
    let released = false;
    return {
      analyzer: handle.analyzer,
      activeAnalyzers,
      release: async () => {
        if (released) return;
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        if (handle.leaseCount === 0) {
          if (handle.closed || this.activeHandle !== handle) {
            await this.disposeHandle(handle);
          } else {
            this.scheduleIdleEviction(handle);
          }
        }
      },
    };
  }

  private async replaceActiveHandle(next: ActiveKiwiHandle): Promise<void> {
    const previous = this.activeHandle;
    this.activeHandle = next;
    if (!previous || previous === next || previous.disposed) return;
    if (previous.leaseCount > 0) {
      previous.closed = true;
      return;
    }
    await this.disposeHandle(previous);
  }

  private async disposeHandle(handle: ActiveKiwiHandle): Promise<void> {
    if (handle.disposed) return;
    handle.closed = true;
    handle.disposed = true;
    await handle.analyzer.dispose();
    if (this.activeHandle === handle) this.activeHandle = null;
  }

  private scheduleIdleEviction(handle: ActiveKiwiHandle): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (handle.leaseCount > 0 || this.activeHandle !== handle || handle.closed) return;
      void this.disposeHandle(handle);
    }, this.idleTtlMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function noopLease(activeAnalyzers: KiwiDeclaredAnalyzer[]): KiwiLease {
  return {
    analyzer: null,
    activeAnalyzers,
    async release(): Promise<void> {},
  };
}

function normalizeDeclaredAnalyzers(values: readonly KiwiDeclaredAnalyzer[]): KiwiDeclaredAnalyzer[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function withoutKiwi(values: readonly KiwiDeclaredAnalyzer[]): KiwiDeclaredAnalyzer[] {
  return normalizeDeclaredAnalyzers(values).filter((value) => value !== 'ko');
}

function envKey(env: NodeJS.ProcessEnv): string {
  return kiwiDataDir(env);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: KiwiAnalyzerManager | null = null;
let singletonThreadId = threadId;

export function getKiwiAnalyzerManager(): KiwiAnalyzerManager {
  if (!singleton || singletonThreadId !== threadId) {
    singleton = new KiwiAnalyzerManager();
    singletonThreadId = threadId;
  }
  return singleton;
}

function __setKiwiAnalyzerManagerForTests(manager: KiwiAnalyzerManager | null): void {
  singleton = manager;
  singletonThreadId = threadId;
}
