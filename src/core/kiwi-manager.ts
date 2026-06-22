import type { SearchDeclaredAnalyzer } from "./search-analyzer.js";
import {
  inspectKiwiModelArtifact,
  inspectKiwiWasmArtifact,
  kiwiDataDir,
  type KiwiModelArtifactInspectOptions,
  type KiwiModelArtifactState,
  type KiwiWasmArtifactState
} from "./kiwi-artifact.js";
import type { KiwiAnalyzer, KiwiAnalyzerIdentity } from "./kiwi-loader.js";

export type KiwiManagerStatus =
  | {
      state: "unloaded";
      leaseCount: 0;
      model: KiwiModelArtifactState;
    }
  | {
      state: "loading";
      leaseCount: number;
      model: KiwiModelArtifactState;
    }
  | {
      state: "loaded";
      leaseCount: number;
      model: KiwiModelArtifactState;
      identity: KiwiAnalyzerIdentity;
    }
  | {
      state: "degraded";
      leaseCount: 0;
      model: KiwiModelArtifactState;
      reason: string;
    };

type KiwiLease = {
  analyzer: KiwiAnalyzer | null;
  activeAnalyzers: SearchDeclaredAnalyzer[];
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

type DegradedState = {
  envKey: string;
  reason: string;
  artifactStateKey: string;
};

const KIWI_IDLE_TTL_MS = 5 * 60 * 1000;

export class KiwiAnalyzerTerminalLoadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "KiwiAnalyzerTerminalLoadError";
    this.cause = cause;
    Object.setPrototypeOf(this, KiwiAnalyzerTerminalLoadError.prototype);
  }
}

export class KiwiAnalyzerManager {
  private readonly idleTtlMs: number;
  private readonly loadAnalyzer: (options: { env: NodeJS.ProcessEnv; installIfMissing: boolean }) => Promise<KiwiAnalyzer>;
  private readonly inspectModelArtifact: (env: NodeJS.ProcessEnv, options?: KiwiModelArtifactInspectOptions) => KiwiModelArtifactState;
  private readonly inspectWasmArtifact: (env: NodeJS.ProcessEnv) => KiwiWasmArtifactState;
  private activeHandle: ActiveKiwiHandle | null = null;
  private loadPromise: Promise<ActiveKiwiHandle> | null = null;
  private loadPromiseKey: string | null = null;
  private loadPromiseInstallsIfMissing = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private degraded: DegradedState | null = null;

  constructor(options: KiwiManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? KIWI_IDLE_TTL_MS;
    this.loadAnalyzer = options.loadAnalyzer ?? (async (loadOptions) => {
      const { loadKiwiAnalyzer } = await import("./kiwi-loader.js");
      return loadKiwiAnalyzer(loadOptions);
    });
    this.inspectModelArtifact = options.inspectModelArtifact ?? inspectKiwiModelArtifact;
    this.inspectWasmArtifact = options.inspectWasmArtifact ?? inspectKiwiWasmArtifact;
  }

  status(env: NodeJS.ProcessEnv = process.env): KiwiManagerStatus {
    const key = envKey(env);
    const model = this.inspectModelArtifact(env, { verifyFiles: "metadata" });
    if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
      return {
        state: "loaded",
        leaseCount: this.activeHandle.leaseCount,
        model,
        identity: this.activeHandle.analyzer.identity
      };
    }
    if (this.loadPromise && this.loadPromiseKey === key) {
      return { state: "loading", leaseCount: 0, model };
    }
    if (this.degraded && this.degraded.envKey === key) {
      return {
        state: "degraded",
        leaseCount: 0,
        model,
        reason: this.degraded.reason
      };
    }
    return { state: "unloaded", leaseCount: 0, model };
  }

  isTerminalLoadError(error: unknown): boolean {
    return error instanceof KiwiAnalyzerTerminalLoadError;
  }

  async withAnalyzerLease<T>(
    env: NodeJS.ProcessEnv,
    declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
    options: { wait: boolean; installIfMissing: boolean },
    run: (lease: { analyzer: KiwiAnalyzer | null; activeAnalyzers: SearchDeclaredAnalyzer[] }) => T | Promise<T>
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
    this.clearIdleTimer();
    const handle = this.activeHandle;
    if (handle) await this.disposeHandle(handle);
  }

  private async acquire(
    env: NodeJS.ProcessEnv,
    declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
    options: { wait: boolean; installIfMissing: boolean }
  ): Promise<KiwiLease> {
    const normalized = normalizeDeclaredAnalyzers(declaredAnalyzers);
    if (!normalized.includes("ko")) return noopLease(normalized);
    const key = envKey(env);

    const existing = this.activeHandle;
    if (existing && !existing.closed && existing.envKey === key) {
      return this.leaseHandle(existing, normalized);
    }

    if (this.degraded && this.degraded.envKey === key) {
      const model = this.inspectModelArtifact(env, { verifyFiles: "digest" });
      if (!model.installed || artifactStateKey(model, this.inspectWasmArtifact(env)) !== this.degraded.artifactStateKey) {
        this.degraded = null;
      }
    }

    if (!options.wait) return noopLease(withoutKiwi(normalized));
    if (this.degraded && this.degraded.envKey === key) return noopLease(withoutKiwi(normalized));

    const handle = await this.ensureLoaded(env, options.installIfMissing);
    return this.leaseHandle(handle, normalized);
  }

  private async ensureLoaded(env: NodeJS.ProcessEnv, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    const key = envKey(env);
    if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
      return this.activeHandle;
    }
    while (this.loadPromise) {
      const pending = this.loadPromise;
      if (this.loadPromiseKey === key && (this.loadPromiseInstallsIfMissing || !installIfMissing)) {
        return pending;
      }
      try {
        await pending;
      } catch {
        // The caller needs the requested env/load mode; retry after the in-flight load settles.
      }
      if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
        return this.activeHandle;
      }
    }

    this.clearIdleTimer();
    this.loadPromiseKey = key;
    this.loadPromiseInstallsIfMissing = installIfMissing;
    this.loadPromise = this.loadFresh(env, key, installIfMissing);
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
      this.loadPromiseKey = null;
      this.loadPromiseInstallsIfMissing = false;
    }
  }

  private async loadFresh(env: NodeJS.ProcessEnv, key: string, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    try {
      const analyzer = await this.loadAnalyzer({ env, installIfMissing });
      const handle: ActiveKiwiHandle = {
        analyzer,
        envKey: key,
        leaseCount: 0,
        closed: false,
        disposed: false
      };
      await this.replaceActiveHandle(handle);
      this.degraded = null;
      return handle;
    } catch (error) {
      const model = this.inspectModelArtifact(env);
      const wasm = this.inspectWasmArtifact(env);
      if (model.installed && wasm.installed) {
        this.degraded = {
          envKey: key,
          reason: errorMessage(error),
          artifactStateKey: artifactStateKey(model, wasm)
        };
        throw new KiwiAnalyzerTerminalLoadError(`Kiwi analyzer load failed: ${errorMessage(error)}`, error);
      }
      throw error;
    }
  }

  private leaseHandle(handle: ActiveKiwiHandle, activeAnalyzers: SearchDeclaredAnalyzer[]): KiwiLease {
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
      }
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

function noopLease(activeAnalyzers: SearchDeclaredAnalyzer[]): KiwiLease {
  return {
    analyzer: null,
    activeAnalyzers,
    async release(): Promise<void> {}
  };
}

function normalizeDeclaredAnalyzers(values: readonly SearchDeclaredAnalyzer[]): SearchDeclaredAnalyzer[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function withoutKiwi(values: readonly SearchDeclaredAnalyzer[]): SearchDeclaredAnalyzer[] {
  return normalizeDeclaredAnalyzers(values).filter((value) => value !== "ko");
}

function envKey(env: NodeJS.ProcessEnv): string {
  return kiwiDataDir(env);
}

function modelStateKey(state: KiwiModelArtifactState): string {
  if (!state.installed || !state.manifest) return `missing:${state.missingFiles.join(",")}`;
  return `${state.manifest.kiwiNlpVersion}:${state.manifest.modelVersion}:${state.manifest.archiveSha256}:${state.manifest.installedAt}`;
}

function wasmStateKey(state: KiwiWasmArtifactState): string {
  if (!state.installed || !state.manifest) return `missing:${state.missingFiles.join(",")}`;
  return `${state.manifest.kiwiNlpVersion}:${state.manifest.wasmSha256}:${state.manifest.installedAt}`;
}

function artifactStateKey(model: KiwiModelArtifactState, wasm: KiwiWasmArtifactState): string {
  return `model:${modelStateKey(model)}|wasm:${wasmStateKey(wasm)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: KiwiAnalyzerManager | null = null;

export function getKiwiAnalyzerManager(): KiwiAnalyzerManager {
  singleton ??= new KiwiAnalyzerManager();
  return singleton;
}

export function __setKiwiAnalyzerManagerForTests(manager: KiwiAnalyzerManager | null): void {
  singleton = manager;
}
