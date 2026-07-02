import fs from "node:fs";
import path from "node:path";
import { createDaemonPools, type DaemonPools } from "./pools.js";
import { SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS, type PruneRequestPayload } from "./protocol.js";
import {
  createDaemonSnapshotStore,
  createWorkerEmbeddingSetBuilder,
  DaemonSearchStoreService,
  type DaemonSnapshotStore,
  type SnapshotDirtyMark
} from "./search-store/index.js";
import { SearchCacheCatalog } from "./search-store/cache-catalog.js";
import { createEmbedScheduler, type EmbedScheduler, type VectorGenerationManager } from "./embed-scheduler.js";
import type { SearchIndexPruneResult } from "../core/types.js";
import {
  DeterministicHashProvider,
  createLocalOnnxProviderFromConfig
} from "../core/search/dense/index.js";
import { VaultRegistry } from "./vault-registry.js";
import {
  effectiveSearchRuntimeProfile,
  envForSearchRuntimeProfile,
  normalizeSearchRuntimeProfile,
  searchRuntimeProfileHash,
  settingsForSearchRuntimeProfile,
  type SearchRuntimeProfile
} from "./runtime-profile.js";
import {
  startRetrievalSaveWatcher,
  type RetrievalSaveWatcher,
  type VaultChangeProducerOptions,
  type VaultDirtyMark
} from "./vector-store/watcher.js";

export type ProfileRuntimeStatus = {
  profileHash: string;
  profile: SearchRuntimeProfile;
  activeRequests: number;
  idleDeadline?: string;
  pools: unknown;
  searchStore: unknown;
  vaults: ReturnType<VaultRegistry["list"]>;
};

export type ProfileRuntimeLease = {
  runtime: ProfileRuntime;
  release(): void;
};

type ProfileRuntimeEntry = {
  runtime: ProfileRuntime;
  activeRequests: number;
  idleTimer?: NodeJS.Timeout;
  idleDeadline?: string;
};

type ProfileRuntimeAcquireOptions = {
  cancellationId?: string;
};

type SavePublicationState = {
  pendingMarks: Map<string, SnapshotDirtyMark>;
  foldChain: Promise<void>;
  running?: Promise<void>;
};

export type RuntimeSaveWatcherFactory = (options: VaultChangeProducerOptions) => RetrievalSaveWatcher;

export type ProfileManagerOptions = {
  startSaveWatcher?: RuntimeSaveWatcherFactory;
  saveWatcherDebounceMs?: number;
  saveWatcherFallbackPollMs?: number;
  saveMutationDeadlineMs?: number;
};

const MAX_CANCELLED_IDS = 4096;

export class ProfileRuntime {
  readonly profile: SearchRuntimeProfile;
  readonly profileHash: string;
  readonly pools: DaemonPools;
  readonly vectorPool: VectorGenerationManager;
  readonly searchStore: DaemonSearchStoreService;
  readonly vaults = new VaultRegistry();
  private readonly embedScheduler: Pick<EmbedScheduler, "cancel">;
  private readonly snapshotStore: Pick<DaemonSnapshotStore, "publishSaveSnapshot" | "foldSaveDirtyMarks">;
  private readonly startSaveWatcher: RuntimeSaveWatcherFactory;
  private readonly saveWatcherDebounceMs: number | undefined;
  private readonly saveWatcherFallbackPollMs: number | undefined;
  private readonly saveMutationDeadlineMs: number;
  private readonly saveWatchers = new Map<string, RetrievalSaveWatcher>();
  private readonly savePublications = new Map<string, SavePublicationState>();
  private nextSaveJobId = 1;

  private constructor(
    profile: SearchRuntimeProfile,
    pools: DaemonPools,
    vectorPool: VectorGenerationManager,
    snapshotStore: Pick<DaemonSnapshotStore, "publishSaveSnapshot" | "foldSaveDirtyMarks">,
    searchStore: DaemonSearchStoreService,
    embedScheduler: Pick<EmbedScheduler, "cancel">,
    options: ProfileManagerOptions
  ) {
    this.profile = profile;
    this.profileHash = searchRuntimeProfileHash(profile);
    this.pools = pools;
    this.vectorPool = vectorPool;
    this.snapshotStore = snapshotStore;
    this.searchStore = searchStore;
    this.embedScheduler = embedScheduler;
    this.startSaveWatcher = options.startSaveWatcher ?? startRetrievalSaveWatcher;
    this.saveWatcherDebounceMs = options.saveWatcherDebounceMs;
    this.saveWatcherFallbackPollMs = options.saveWatcherFallbackPollMs;
    this.saveMutationDeadlineMs = options.saveMutationDeadlineMs ?? SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS;
  }

  static async create(
    profile: SearchRuntimeProfile,
    baseEnv: NodeJS.ProcessEnv,
    embedScheduler: EmbedScheduler,
    options: ProfileManagerOptions = {}
  ): Promise<ProfileRuntime> {
    const normalized = normalizeSearchRuntimeProfile(profile);
    const profileHash = searchRuntimeProfileHash(normalized);
    const env = envForSearchRuntimeProfile(normalized, baseEnv);
    const settings = settingsForSearchRuntimeProfile(normalized);
    const pools = await createDaemonPools(env, settings, { embedding: embedScheduler.embedding });
    const vectorPool = embedScheduler.vectorManager;
    const embeddingProvider = normalized.embedding.provider === "deterministic-hash"
      ? new DeterministicHashProvider()
      : createLocalOnnxProviderFromConfig(settings, env);
    const providerPayload = normalized.embedding.provider === "deterministic-hash"
      ? {
          kind: "deterministic-hash" as const,
          model: embeddingProvider.identity.model,
          dim: embeddingProvider.identity.dim
        }
      : {
          kind: "local-onnx" as const,
          model: normalized.embedding.model
        };
    const snapshotStore = createDaemonSnapshotStore({
      env,
      countCap: normalized.memory.snapshotCountCap,
      byteCap: normalized.memory.snapshotByteCap,
      retentionCount: normalized.cache.snapshotRetention,
      profileHash,
      searchSettings: normalized.index,
      vectorPool,
      embeddingSetBuilder: createWorkerEmbeddingSetBuilder({
        provider: embeddingProvider,
        providerPayload,
        embedding: embedScheduler
      }),
      snapshotBuilder: (input) => pools.throughputAnalyzer.buildSnapshot(input.vaultRoot, input.partitionBits, {
        deadline: input.deadline ?? Date.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
        cancellationId: input.cancellationId ?? `${input.vaultRoot}:snapshot-build`,
        vault: input.vaultRoot,
        onProgress: input.progress
      }, input.searchSettings)
    });
    const searchStore = new DaemonSearchStoreService(snapshotStore, pools.latencyAnalyzer, embedScheduler, pools.searchExecution, {
      queryCacheSize: normalized.cache.queryAnalysisEntries,
      searchSettings: normalized.index,
      settings,
      vectorPool
    });
    return new ProfileRuntime(normalized, pools, vectorPool, snapshotStore, searchStore, embedScheduler, options);
  }

  cancel(cancellationId: string): void {
    this.searchStore.cancel(cancellationId);
    this.pools.cancel(cancellationId);
    this.embedScheduler.cancel(cancellationId);
  }

  startSaveWatcherForVault(vaultRoot: string): void {
    const canonicalVaultRoot = canonicalRuntimeVault(vaultRoot);
    if (this.saveWatchers.has(canonicalVaultRoot)) return;
    const options: VaultChangeProducerOptions = {
      vaultRoot: canonicalVaultRoot,
      onDirtyMarks: (marks) => {
        this.enqueueSaveSnapshot(canonicalVaultRoot, marks);
      }
    };
    if (this.saveWatcherDebounceMs !== undefined) options.debounceMs = this.saveWatcherDebounceMs;
    if (this.saveWatcherFallbackPollMs !== undefined) options.fallbackPollMs = this.saveWatcherFallbackPollMs;
    const watcher = this.startSaveWatcher(options);
    this.saveWatchers.set(canonicalVaultRoot, watcher);
  }

  stopSaveWatcherForVault(vaultRoot: string): void {
    const canonicalVaultRoot = canonicalRuntimeVault(vaultRoot);
    const watcher = this.saveWatchers.get(canonicalVaultRoot);
    if (!watcher) return;
    watcher.close();
    this.saveWatchers.delete(canonicalVaultRoot);
  }

  async close(): Promise<void> {
    for (const watcher of this.saveWatchers.values()) watcher.close();
    this.saveWatchers.clear();
    await this.pools.close();
  }

  async status(
    context: { deadline: number; cancellationId: string; vault?: string },
    lifecycle: { activeRequests: number; idleDeadline?: string }
  ): Promise<ProfileRuntimeStatus> {
    return {
      profileHash: this.profileHash,
      profile: this.profile,
      activeRequests: lifecycle.activeRequests,
      ...(lifecycle.idleDeadline ? { idleDeadline: lifecycle.idleDeadline } : {}),
      pools: await this.pools.stats(context),
      searchStore: this.searchStore.stats(),
      vaults: this.vaults.list()
    };
  }

  private enqueueSaveSnapshot(vaultRoot: string, marks: readonly VaultDirtyMark[]): void {
    if (marks.length === 0) return;
    const saveMarks = marks.map(snapshotDirtyMarkFromVaultMark);
    const state = this.savePublicationState(vaultRoot);
    mergeDirtyMarks(state.pendingMarks, saveMarks);
    if (state.running) this.enqueueActiveSaveFold(vaultRoot, saveMarks, state);
    else this.startSavePublicationDrain(vaultRoot, state);
  }

  private savePublicationState(vaultRoot: string): SavePublicationState {
    let state = this.savePublications.get(vaultRoot);
    if (!state) {
      state = {
        pendingMarks: new Map(),
        foldChain: Promise.resolve()
      };
      this.savePublications.set(vaultRoot, state);
    }
    return state;
  }

  private startSavePublicationDrain(vaultRoot: string, state: SavePublicationState): void {
    const running = this.drainSavePublications(vaultRoot, state).finally(() => {
      if (state.running === running) {
        state.running = undefined;
        if (state.pendingMarks.size === 0) this.savePublications.delete(vaultRoot);
        else this.startSavePublicationDrain(vaultRoot, state);
      }
    });
    state.running = running;
    void running.catch(() => undefined);
  }

  private async drainSavePublications(vaultRoot: string, state: SavePublicationState): Promise<void> {
    while (state.pendingMarks.size > 0) {
      drainDirtyMarks(state.pendingMarks);
      await state.foldChain;
      const saveJobId = this.nextSaveJobId++;
      const cancellationId = `save:${this.profileHash}:${saveJobId}`;
      const deadline = Date.now() + this.saveMutationDeadlineMs;
      await this.snapshotStore.publishSaveSnapshot(vaultRoot, {
        deadline,
        cancellationId
      });
    }
  }

  private enqueueActiveSaveFold(vaultRoot: string, marks: readonly SnapshotDirtyMark[], state: SavePublicationState): void {
    const saveJobId = this.nextSaveJobId++;
    const cancellationId = `save-fold:${this.profileHash}:${saveJobId}`;
    const fold = state.foldChain.then(async () => {
      await this.snapshotStore.foldSaveDirtyMarks(vaultRoot, marks, {
        deadline: Date.now() + this.saveMutationDeadlineMs,
        cancellationId
      });
    });
    state.foldChain = fold.catch(() => undefined);
    void fold.catch(() => undefined);
  }
}

function snapshotDirtyMarkFromVaultMark(mark: VaultDirtyMark): SnapshotDirtyMark {
  return {
    docId: mark.docId,
    path: mark.path,
    ...(mark.contentHash !== undefined ? { contentHash: mark.contentHash } : {})
  };
}

function mergeDirtyMarks(target: Map<string, SnapshotDirtyMark>, marks: readonly SnapshotDirtyMark[]): void {
  for (const mark of marks) target.set(dirtyMarkKey(mark), mark);
}

function drainDirtyMarks(target: Map<string, SnapshotDirtyMark>): void {
  target.clear();
}

function dirtyMarkKey(mark: SnapshotDirtyMark): string {
  return `${mark.docId}\0${mark.path}`;
}

export class ProfileManager {
  private readonly runtimes = new Map<string, ProfileRuntimeEntry>();
  private readonly pending = new Map<string, Promise<ProfileRuntimeEntry>>();
  private readonly cancelled = new Set<string>();
  private readonly defaultProfile: SearchRuntimeProfile;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly embedScheduler: EmbedScheduler;
  private readonly ownsEmbedScheduler: boolean;
  private readonly options: ProfileManagerOptions;
  private closed = false;

  constructor(baseEnv: NodeJS.ProcessEnv, embedScheduler?: EmbedScheduler, options: ProfileManagerOptions = {}) {
    this.baseEnv = baseEnv;
    this.defaultProfile = effectiveSearchRuntimeProfile(process.cwd(), baseEnv);
    this.embedScheduler = embedScheduler ?? createEmbedScheduler({ env: baseEnv });
    this.ownsEmbedScheduler = embedScheduler === undefined;
    this.options = options;
  }

  async acquire(payload: { profile?: SearchRuntimeProfile }, options: ProfileRuntimeAcquireOptions = {}): Promise<ProfileRuntimeLease> {
    if (this.closed) throw Object.assign(new Error("profile manager is closed"), { code: "SEARCH_DAEMON_NOT_READY" });
    const profile = this.profileForPayload(payload);
    const profileHash = searchRuntimeProfileHash(profile);
    assertNotCancelled(options.cancellationId, this.cancelled);
    const entry = await this.liveEntryFor(profileHash, profile);
    if (options.cancellationId && this.cancelled.has(options.cancellationId)) {
      entry.runtime.cancel(options.cancellationId);
      throw cancelledError();
    }
    this.retain(entry);
    let released = false;
    return {
      runtime: entry.runtime,
      release: () => {
        if (released) return;
        released = true;
        this.release(profileHash, entry);
      }
    };
  }

  async withRuntimeFor<T>(
    payload: { profile?: SearchRuntimeProfile },
    fn: (runtime: ProfileRuntime) => Promise<T>,
    options: ProfileRuntimeAcquireOptions = {}
  ): Promise<T> {
    const lease = await this.acquire(payload, options);
    try {
      return await fn(lease.runtime);
    } finally {
      lease.release();
    }
  }

  private async entryFor(profileHash: string, profile: SearchRuntimeProfile): Promise<ProfileRuntimeEntry> {
    const current = this.runtimes.get(profileHash);
    if (current) return current;
    const pending = this.pending.get(profileHash);
    if (pending) return pending;
    const created = ProfileRuntime.create(profile, this.baseEnv, this.embedScheduler, this.options)
      .then(async (runtime) => {
        if (this.closed) {
          await runtime.close();
          throw Object.assign(new Error("profile manager is closed"), { code: "SEARCH_DAEMON_NOT_READY" });
        }
        const entry: ProfileRuntimeEntry = {
          runtime,
          activeRequests: 0
        };
        this.runtimes.set(profileHash, entry);
        this.pending.delete(profileHash);
        return entry;
      })
      .catch((error) => {
        this.pending.delete(profileHash);
        throw error;
      });
    this.pending.set(profileHash, created);
    return created;
  }

  private async liveEntryFor(profileHash: string, profile: SearchRuntimeProfile): Promise<ProfileRuntimeEntry> {
    while (true) {
      const entry = await this.entryFor(profileHash, profile);
      if (this.closed) throw Object.assign(new Error("profile manager is closed"), { code: "SEARCH_DAEMON_NOT_READY" });
      if (this.runtimes.get(profileHash) === entry) return entry;
    }
  }

  profileForPayload(payload: { profile?: SearchRuntimeProfile }): SearchRuntimeProfile {
    if (!payload.profile) return this.defaultProfile;
    try {
      return normalizeSearchRuntimeProfile(payload.profile);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: "BAD_REQUEST" });
    }
  }

  cancel(cancellationId: string): void {
    rememberCancelled(this.cancelled, cancellationId);
    for (const entry of this.runtimes.values()) entry.runtime.cancel(cancellationId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.runtimes.entries()].map(([profileHash, entry]) => this.closeEntry(profileHash, entry)));
    if (this.ownsEmbedScheduler) await this.embedScheduler.close();
  }

  async status(context: { deadline: number; cancellationId: string; vault?: string }): Promise<Record<string, ProfileRuntimeStatus>> {
    const entries = await Promise.all([...this.runtimes.values()].map(async (entry) => [
      entry.runtime.profileHash,
      await entry.runtime.status(context, {
        activeRequests: entry.activeRequests,
        ...(entry.idleDeadline ? { idleDeadline: entry.idleDeadline } : {})
      })
    ] as const));
    return Object.fromEntries(entries);
  }

  pruneSearchCaches(payload: PruneRequestPayload): SearchIndexPruneResult {
    return new SearchCacheCatalog({ env: this.baseEnv }).prune({
      unusedDays: payload.unusedDays,
      dryRun: payload.dryRun,
      protectedStoreIds: this.protectedStoreIdsForPrune()
    });
  }

  listVaults(): ReturnType<VaultRegistry["list"]> {
    return [...this.runtimes.values()].flatMap((entry) => entry.runtime.vaults.list());
  }

  private protectedStoreIdsForPrune(): Set<string> {
    const protectedStoreIds = new Set<string>();
    for (const entry of this.runtimes.values()) {
      for (const storeId of entry.runtime.searchStore.protectedStoreIdsForPrune()) {
        protectedStoreIds.add(storeId);
      }
    }
    return protectedStoreIds;
  }

  private retain(entry: ProfileRuntimeEntry): void {
    entry.activeRequests += 1;
    this.clearIdleTimer(entry);
  }

  private release(profileHash: string, entry: ProfileRuntimeEntry): void {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    if (entry.activeRequests > 0 || this.closed) return;
    this.armIdleTimer(profileHash, entry);
  }

  private armIdleTimer(_profileHash: string, entry: ProfileRuntimeEntry): void {
    this.clearIdleTimer(entry);
  }

  private clearIdleTimer(entry: ProfileRuntimeEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.idleDeadline = undefined;
  }

  private async closeEntryIfIdle(profileHash: string, entry: ProfileRuntimeEntry): Promise<void> {
    if (this.runtimes.get(profileHash) !== entry || entry.activeRequests > 0) return;
    await this.closeEntry(profileHash, entry);
  }

  private async closeEntry(profileHash: string, entry: ProfileRuntimeEntry): Promise<void> {
    if (this.runtimes.get(profileHash) !== entry) return;
    this.runtimes.delete(profileHash);
    this.clearIdleTimer(entry);
    await entry.runtime.close();
  }
}

function assertNotCancelled(cancellationId: string | undefined, cancelled: ReadonlySet<string>): void {
  if (!cancellationId || !cancelled.has(cancellationId)) return;
  throw cancelledError();
}

function cancelledError(): Error {
  return Object.assign(new Error("profile runtime request was cancelled"), { code: "CANCELLED" });
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

function canonicalRuntimeVault(vaultRoot: string): string {
  const resolved = path.resolve(vaultRoot);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
