import { createDaemonPools, type DaemonPools } from "./pools.js";
import { SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS, type PruneRequestPayload } from "./protocol.js";
import { createDaemonSnapshotStore, createWorkerEmbeddingSetBuilder, DaemonSearchStoreService } from "./search-store/index.js";
import { SearchCacheCatalog } from "./search-store/cache-catalog.js";
import { createMemoryCoralNeedleInstanceFactory, VectorGenerationPool } from "./vector-store/index.js";
import type { CoralNeedleInstanceFactory } from "./vector-store/types.js";
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

const MAX_CANCELLED_IDS = 4096;

export class ProfileRuntime {
  readonly profile: SearchRuntimeProfile;
  readonly profileHash: string;
  readonly pools: DaemonPools;
  readonly vectorPool: VectorGenerationPool;
  readonly searchStore: DaemonSearchStoreService;
  readonly vaults = new VaultRegistry();

  private constructor(
    profile: SearchRuntimeProfile,
    pools: DaemonPools,
    vectorPool: VectorGenerationPool,
    searchStore: DaemonSearchStoreService
  ) {
    this.profile = profile;
    this.profileHash = searchRuntimeProfileHash(profile);
    this.pools = pools;
    this.vectorPool = vectorPool;
    this.searchStore = searchStore;
  }

  static async create(profile: SearchRuntimeProfile, baseEnv: NodeJS.ProcessEnv): Promise<ProfileRuntime> {
    const normalized = normalizeSearchRuntimeProfile(profile);
    const profileHash = searchRuntimeProfileHash(normalized);
    const env = envForSearchRuntimeProfile(normalized, baseEnv);
    const settings = settingsForSearchRuntimeProfile(normalized);
    const pools = await createDaemonPools(env, settings);
    const vectorPool = new VectorGenerationPool({ factory: vectorInstanceFactory(env) });
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
        embedding: pools.embedding
      }),
      snapshotBuilder: (input) => pools.throughputAnalyzer.buildSnapshot(input.vaultRoot, input.partitionBits, {
        deadline: input.deadline ?? Date.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
        cancellationId: input.cancellationId ?? `${input.vaultRoot}:snapshot-build`,
        vault: input.vaultRoot,
        onProgress: input.progress
      }, input.searchSettings)
    });
    const searchStore = new DaemonSearchStoreService(snapshotStore, pools.latencyAnalyzer, pools.embedding, pools.searchExecution, {
      queryCacheSize: normalized.cache.queryAnalysisEntries,
      searchSettings: normalized.index,
      settings,
      vectorPool
    });
    return new ProfileRuntime(normalized, pools, vectorPool, searchStore);
  }

  cancel(cancellationId: string): void {
    this.searchStore.cancel(cancellationId);
    this.pools.cancel(cancellationId);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.vectorPool.close(),
      this.pools.close()
    ]);
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
}

function vectorInstanceFactory(env: NodeJS.ProcessEnv): CoralNeedleInstanceFactory | undefined {
  const mode = env.OPTSIDIAN_SEARCH_VECTOR_INSTANCE?.trim().toLowerCase();
  if (mode === "memory" || env.OPTSIDIAN_TEST_FAKE_CORAL_NEEDLE === "1") {
    return createMemoryCoralNeedleInstanceFactory();
  }
  return undefined;
}

export class ProfileManager {
  private readonly runtimes = new Map<string, ProfileRuntimeEntry>();
  private readonly pending = new Map<string, Promise<ProfileRuntimeEntry>>();
  private readonly cancelled = new Set<string>();
  private readonly defaultProfile: SearchRuntimeProfile;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private closed = false;

  constructor(baseEnv: NodeJS.ProcessEnv) {
    this.baseEnv = baseEnv;
    this.defaultProfile = effectiveSearchRuntimeProfile(process.cwd(), baseEnv);
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
    const created = ProfileRuntime.create(profile, this.baseEnv)
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
