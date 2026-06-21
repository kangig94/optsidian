import type { SearchDeclaredAnalyzer } from "./search-analyzer.js";
import { inspectKiwiModelArtifact, type KiwiModelArtifactState } from "./kiwi-artifact.js";
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
};

type KiwiManagerOptions = {
  idleTtlMs?: number;
  loadAnalyzer?: (options: { env: NodeJS.ProcessEnv; installIfMissing: boolean }) => Promise<KiwiAnalyzer>;
  inspectModelArtifact?: (env: NodeJS.ProcessEnv) => KiwiModelArtifactState;
};

type DegradedState = {
  reason: string;
  modelStateKey: string;
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
  private readonly inspectModelArtifact: (env: NodeJS.ProcessEnv) => KiwiModelArtifactState;
  private activeHandle: ActiveKiwiHandle | null = null;
  private loadPromise: Promise<ActiveKiwiHandle> | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private degraded: DegradedState | null = null;

  constructor(options: KiwiManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? KIWI_IDLE_TTL_MS;
    this.loadAnalyzer = options.loadAnalyzer ?? (async (loadOptions) => {
      const { loadKiwiAnalyzer } = await import("./kiwi-loader.js");
      return loadKiwiAnalyzer(loadOptions);
    });
    this.inspectModelArtifact = options.inspectModelArtifact ?? inspectKiwiModelArtifact;
  }

  status(env: NodeJS.ProcessEnv = process.env): KiwiManagerStatus {
    const model = this.inspectModelArtifact(env);
    if (this.loadPromise) {
      return { state: "loading", leaseCount: this.activeHandle?.leaseCount ?? 0, model };
    }
    if (this.activeHandle && !this.activeHandle.closed) {
      return {
        state: "loaded",
        leaseCount: this.activeHandle.leaseCount,
        model,
        identity: this.activeHandle.analyzer.identity
      };
    }
    if (this.degraded) {
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
    if (handle && !handle.closed) {
      handle.closed = true;
      await handle.analyzer.dispose();
    }
    this.activeHandle = null;
  }

  private async acquire(
    env: NodeJS.ProcessEnv,
    declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
    options: { wait: boolean; installIfMissing: boolean }
  ): Promise<KiwiLease> {
    const normalized = normalizeDeclaredAnalyzers(declaredAnalyzers);
    if (!normalized.includes("ko")) return noopLease(normalized);

    const model = this.inspectModelArtifact(env);
    if (this.degraded && model.installed && modelStateKey(model) !== this.degraded.modelStateKey) {
      this.degraded = null;
    }

    const existing = this.activeHandle;
    if (existing && !existing.closed && existing.envKey === envKey(env)) {
      return this.leaseHandle(existing, normalized);
    }

    if (!options.wait) return noopLease(withoutKiwi(normalized));
    if (this.degraded) return noopLease(withoutKiwi(normalized));

    const handle = await this.ensureLoaded(env, options.installIfMissing);
    return this.leaseHandle(handle, normalized);
  }

  private async ensureLoaded(env: NodeJS.ProcessEnv, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    const key = envKey(env);
    if (this.activeHandle && !this.activeHandle.closed && this.activeHandle.envKey === key) {
      return this.activeHandle;
    }
    if (this.loadPromise) return this.loadPromise;

    this.clearIdleTimer();
    this.loadPromise = this.loadFresh(env, key, installIfMissing);
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async loadFresh(env: NodeJS.ProcessEnv, key: string, installIfMissing: boolean): Promise<ActiveKiwiHandle> {
    try {
      if (this.activeHandle && !this.activeHandle.closed) {
        this.activeHandle.closed = true;
        await this.activeHandle.analyzer.dispose();
      }
      const analyzer = await this.loadAnalyzer({ env, installIfMissing });
      const handle: ActiveKiwiHandle = {
        analyzer,
        envKey: key,
        leaseCount: 0,
        closed: false
      };
      this.activeHandle = handle;
      this.degraded = null;
      return handle;
    } catch (error) {
      const model = this.inspectModelArtifact(env);
      if (model.installed) {
        this.degraded = {
          reason: errorMessage(error),
          modelStateKey: modelStateKey(model)
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
        if (handle.leaseCount === 0 && this.activeHandle === handle && !handle.closed) {
          this.scheduleIdleEviction(handle);
        }
      }
    };
  }

  private scheduleIdleEviction(handle: ActiveKiwiHandle): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (handle.leaseCount > 0 || this.activeHandle !== handle || handle.closed) return;
      handle.closed = true;
      void handle.analyzer.dispose().finally(() => {
        if (this.activeHandle === handle) this.activeHandle = null;
      });
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
  return env.XDG_CACHE_HOME ?? "";
}

function modelStateKey(state: KiwiModelArtifactState): string {
  if (!state.installed || !state.manifest) return `missing:${state.missingFiles.join(",")}`;
  return `${state.manifest.kiwiNlpVersion}:${state.manifest.modelVersion}:${state.manifest.archiveSha256}:${state.manifest.installedAt}`;
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
