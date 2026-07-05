import fs from 'node:fs';
import path from 'node:path';
import { createDaemonPools, type DaemonPools, type DaemonPoolsStats } from './pools.js';
import {
  SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
  type ModelStatsWorkerResult,
  type ModelBulkDeviceStatus,
  type ProfileModelStatus,
  type PruneRequestPayload,
} from './protocol.js';
import { SharedReclamationAuthority, VaultPublisherRegistry } from './search-store/publisher.js';
import { DaemonSearchStoreService } from './search-store/service.js';
import { createDaemonSnapshotStore, createWorkerEmbeddingSetBuilder } from './search-store/snapshot-store.js';
import type { DaemonSnapshotStore, SnapshotDirtyMark } from './search-store/snapshot-store.js';
import { SearchCacheCatalog } from './search-store/cache-catalog.js';
import {
  createEmbedScheduler,
  envForDaemonOnnxExecutionPolicy,
  type EmbedScheduler,
  type EmbedSchedulerLaneStats,
  type GpuEmbeddingDeviceBulkDeviceStats,
  type VectorGenerationManager,
} from './embed-scheduler.js';
import type { SearchIndexPruneResult } from '../core/types.js';
import { createLocalOnnxProviderFromConfig } from '../core/search/dense/local-onnx.js';
import { DeterministicHashProvider } from '../core/search/dense/provider.js';
import { VaultRegistry } from './vault-registry.js';
import {
  effectiveSearchRuntimeProfile,
  envForSearchRuntimeProfile,
  lexicalIdentityHashForSearchRuntimeProfile,
  normalizeSearchRuntimeProfile,
  searchRuntimeProfileHash,
  settingsForSearchRuntimeProfile,
  type SearchRuntimeProfile,
} from './runtime-profile.js';
import { residentModelKey } from './model-session/provider-key.js';
import {
  startRetrievalSaveWatcher,
  type RetrievalSaveWatcher,
  type VaultChangeProducerOptions,
  type VaultDirtyMark,
} from './vector-store/watcher.js';
import type { CurrentWriterToken, TenancyFenceProvider } from '../core/lifecycle/conditional-commit.js';

export type ProfileRuntimeStatus = {
  profileHash: string;
  profile: SearchRuntimeProfile;
  activeRequests: number;
  idleDeadline?: string;
  model: ProfileRuntimeModelStatus;
  pools: DaemonPoolsStats;
  searchStore: ReturnType<DaemonSearchStoreService['stats']>;
  embedScheduler: EmbedSchedulerLaneStats;
  vaults: ReturnType<VaultRegistry['list']>;
};

export type ProfileRuntimeModelStatus = ProfileModelStatus;

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
  pendingJournalSeqs: Set<number>;
  journalChain: Promise<void>;
  foldChain: Promise<void>;
  running?: Promise<void>;
};

type ResidentModelStats = ModelStatsWorkerResult & {
  unavailable?: boolean;
  busy?: boolean;
  reason?: 'unavailable' | 'busy';
};

export type RuntimeSaveWatcherFactory = (options: VaultChangeProducerOptions) => RetrievalSaveWatcher;

export type ProfileManagerOptions = {
  startSaveWatcher?: RuntimeSaveWatcherFactory;
  saveWatcherDebounceMs?: number;
  saveWatcherFallbackPollMs?: number;
  saveMutationDeadlineMs?: number;
  tenancyFence?: TenancyFenceProvider & { writerToken?: CurrentWriterToken };
};

const MAX_CANCELLED_IDS = 4096;
const MODEL_STATUS_DEADLINE_MS = 100;

export class ProfileRuntime {
  readonly profile: SearchRuntimeProfile;
  readonly profileHash: string;
  readonly pools: DaemonPools;
  readonly vectorPool: VectorGenerationManager;
  readonly searchStore: DaemonSearchStoreService;
  readonly expectedResidentModelKey: string;
  readonly vaults = new VaultRegistry();
  private readonly embedScheduler: Pick<EmbedScheduler, 'cancel' | 'laneStats' | 'modelStats'>;
  private readonly snapshotStore: Pick<
    DaemonSnapshotStore,
    | 'publishSaveSnapshot'
    | 'foldSaveDirtyMarks'
    | 'journalSaveDirtyMarks'
    | 'journalPendingDebounce'
    | 'recordSaveFailure'
    | 'drainPublishers'
    | 'close'
  >;
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
    snapshotStore: Pick<
      DaemonSnapshotStore,
      | 'publishSaveSnapshot'
      | 'foldSaveDirtyMarks'
      | 'journalSaveDirtyMarks'
      | 'journalPendingDebounce'
      | 'recordSaveFailure'
      | 'drainPublishers'
      | 'close'
    >,
    searchStore: DaemonSearchStoreService,
    embedScheduler: Pick<EmbedScheduler, 'cancel' | 'laneStats' | 'modelStats'>,
    expectedResidentModelKey: string,
    options: ProfileManagerOptions,
  ) {
    this.profile = profile;
    this.profileHash = searchRuntimeProfileHash(profile);
    this.pools = pools;
    this.vectorPool = vectorPool;
    this.expectedResidentModelKey = expectedResidentModelKey;
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
    publisherRegistry: VaultPublisherRegistry,
    reclamationAuthority: SharedReclamationAuthority,
    options: ProfileManagerOptions = {},
  ): Promise<ProfileRuntime> {
    const normalized = normalizeSearchRuntimeProfile(profile);
    const profileHash = searchRuntimeProfileHash(normalized);
    const profileEnv = envForSearchRuntimeProfile(normalized, baseEnv);
    const onnxExecutionPolicy = embedScheduler.onnxExecutionPolicy;
    const env = envForDaemonOnnxExecutionPolicy(profileEnv, onnxExecutionPolicy);
    const settings = settingsForSearchRuntimeProfile(normalized);
    const pools = await createDaemonPools(env, settings, { embedding: embedScheduler.embedding });
    const vectorPool = embedScheduler.vectorManager;
    const embeddingProvider =
      normalized.embedding.provider === 'deterministic-hash'
        ? new DeterministicHashProvider()
        : createLocalOnnxProviderFromConfig(settings, env, { executionPolicy: onnxExecutionPolicy });
    const providerPayload =
      normalized.embedding.provider === 'deterministic-hash'
        ? {
            kind: 'deterministic-hash' as const,
            model: embeddingProvider.identity.model,
            dim: embeddingProvider.identity.dim,
          }
        : {
            kind: 'local-onnx' as const,
            model: normalized.embedding.model,
            executionPolicy: onnxExecutionPolicy,
            devicePolicy: normalized.embedding.devicePolicy,
          };
    const expectedResidentModelKey = residentModelKey(providerPayload);
    const snapshotStore = createDaemonSnapshotStore({
      env,
      countCap: normalized.memory.snapshotCountCap,
      byteCap: normalized.memory.snapshotByteCap,
      retentionCount: normalized.cache.snapshotRetention,
      profileHash,
      lexicalIdentityHash: lexicalIdentityHashForSearchRuntimeProfile(normalized),
      searchSettings: normalized.index,
      partitionBits: normalized.index.partitionBits,
      vectorPool,
      publisherRegistry,
      reclamationAuthority,
      tenancyFence: options.tenancyFence,
      publisherLaneCancellation: {
        cancelSnapshotEffects: (cancellationId) => {
          pools.throughputAnalyzer.cancel(cancellationId);
        },
        cancelEmbedScheduler: (cancellationId) => {
          embedScheduler.cancel(cancellationId);
        },
        cancelWorkerPools: (cancellationId) => {
          pools.cancel(cancellationId);
        },
      },
      embeddingSetBuilder: createWorkerEmbeddingSetBuilder({
        provider: embeddingProvider,
        providerPayload,
        embedding: embedScheduler,
        profileHash,
      }),
      snapshotBuilder: (input) =>
        pools.throughputAnalyzer.buildSnapshot(
          input.vaultRoot,
          input.partitionBits,
          {
            deadline: input.deadline ?? Date.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
            cancellationId: input.cancellationId ?? `${input.vaultRoot}:snapshot-build`,
            vault: input.vaultRoot,
            onProgress: input.progress,
          },
          input.searchSettings,
          input.base,
        ),
    });
    const searchStore = new DaemonSearchStoreService(
      snapshotStore,
      pools.latencyAnalyzer,
      embedScheduler,
      pools.searchExecution,
      {
        queryCacheSize: normalized.cache.queryAnalysisEntries,
        searchSettings: normalized.index,
        settings,
        env,
        onnxExecutionPolicy,
        devicePolicy: normalized.embedding.devicePolicy,
      },
    );
    return new ProfileRuntime(
      normalized,
      pools,
      vectorPool,
      snapshotStore,
      searchStore,
      embedScheduler,
      expectedResidentModelKey,
      options,
    );
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
      },
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
    for (const watcher of this.saveWatchers.values()) {
      await watcher.flushNow?.();
      watcher.close();
    }
    this.saveWatchers.clear();
    await this.snapshotStore.drainPublishers();
    await this.snapshotStore.close();
    await this.pools.close();
  }

  async status(
    context: { deadline: number; cancellationId: string; vault?: string },
    lifecycle: { activeRequests: number; idleDeadline?: string },
    residentModelStats?: ResidentModelStats,
  ): Promise<ProfileRuntimeStatus> {
    const modelStats = residentModelStats ?? (await this.modelStatsBestEffort(context));
    const pools = await this.pools.stats(context);
    const embedScheduler = this.embedScheduler.laneStats();
    return {
      profileHash: this.profileHash,
      profile: this.profile,
      activeRequests: lifecycle.activeRequests,
      ...(lifecycle.idleDeadline ? { idleDeadline: lifecycle.idleDeadline } : {}),
      model: this.projectModelStatus(modelStats, embedScheduler, pools),
      pools,
      searchStore: this.searchStore.stats(),
      embedScheduler,
      vaults: this.vaults.list(),
    };
  }

  private async modelStatsBestEffort(context: {
    deadline: number;
    cancellationId: string;
    vault?: string;
  }): Promise<ResidentModelStats> {
    const deadline = modelStatusDeadline(context.deadline);
    if (deadline <= Date.now()) return unavailableModelStats('busy');
    try {
      return await withModelStatusDeadline(
        this.embedScheduler.modelStats({
          deadline,
          cancellationId: context.cancellationId,
          requestId: `${context.cancellationId}:model-status`,
          ...(context.vault ? { vault: context.vault } : {}),
        }),
        deadline,
      );
    } catch (error) {
      return unavailableModelStats(modelStatusUnavailableReason(error));
    }
  }

  private projectModelStatus(
    resident: ResidentModelStats,
    scheduler: EmbedSchedulerLaneStats,
    pools: DaemonPoolsStats,
  ): ProfileRuntimeModelStatus {
    const residentMatches = resident.loaded === true && resident.residentModelKey === this.expectedResidentModelKey;
    const gpuRetry = scheduler.gpuDevice.retryAfterMs;
    const usesCpuFallback = gpuRetry !== undefined && this.profile.embedding.devicePolicy !== 'gpu';
    const fallbackResidentMatches = usesCpuFallback && residentMatches;
    return {
      query: {
        device: fallbackResidentMatches
          ? (resident.device ?? 'cpu')
          : residentMatches
            ? (resident.device ?? null)
            : null,
        executionProvider: fallbackResidentMatches
          ? (resident.executionProvider ?? 'cpu')
          : residentMatches
            ? (resident.executionProvider ?? null)
            : null,
        loaded: residentMatches,
        mode: scheduler.gpuDevice.queryMode,
        retryAfter: gpuRetry ?? null,
      },
      bulk: projectBulkModelStatus(scheduler, pools),
    };
  }

  private enqueueSaveSnapshot(vaultRoot: string, marks: readonly VaultDirtyMark[]): void {
    if (marks.length === 0) return;
    const saveMarks = marks.map(snapshotDirtyMarkFromVaultMark);
    const state = this.savePublicationState(vaultRoot);
    mergeDirtyMarks(state.pendingMarks, saveMarks);
    this.enqueueSaveDirtyJournal(vaultRoot, saveMarks, state);
    if (state.running) this.enqueueActiveSaveFold(vaultRoot, saveMarks, state);
    else this.startSavePublicationDrain(vaultRoot, state);
  }

  private enqueueSaveDirtyJournal(
    vaultRoot: string,
    marks: readonly SnapshotDirtyMark[],
    state: SavePublicationState,
  ): void {
    const batchJournalSeqs: number[] = [];
    const journal = state.journalChain.then(async () => {
      const journalSeqs = await this.snapshotStore.journalSaveDirtyMarks(vaultRoot, marks);
      batchJournalSeqs.push(...journalSeqs);
      for (const journalSeq of journalSeqs) state.pendingJournalSeqs.add(journalSeq);
    });
    state.journalChain = journal.catch(async (error) => {
      for (const journalSeq of batchJournalSeqs) state.pendingJournalSeqs.delete(journalSeq);
      for (const mark of marks) {
        const key = dirtyMarkKey(mark);
        if (state.pendingMarks.get(key) === mark) state.pendingMarks.delete(key);
      }
      await this.snapshotStore.recordSaveFailure(vaultRoot, batchJournalSeqs, error).catch(() => undefined);
    });
    void journal.catch(() => undefined);
  }

  private savePublicationState(vaultRoot: string): SavePublicationState {
    let state = this.savePublications.get(vaultRoot);
    if (!state) {
      state = {
        pendingMarks: new Map(),
        pendingJournalSeqs: new Set(),
        journalChain: Promise.resolve(),
        foldChain: Promise.resolve(),
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
      await state.journalChain;
      if (state.pendingMarks.size === 0) continue;
      const journalSeqs = [...state.pendingJournalSeqs];
      drainDirtyMarks(state.pendingMarks);
      state.pendingJournalSeqs.clear();
      await state.foldChain;
      const saveJobId = this.nextSaveJobId++;
      const cancellationId = `save:${this.profileHash}:${saveJobId}`;
      const deadline = Date.now() + this.saveMutationDeadlineMs;
      try {
        await this.snapshotStore.publishSaveSnapshot(vaultRoot, {
          deadline,
          cancellationId,
        });
      } catch (error) {
        await this.snapshotStore.recordSaveFailure(vaultRoot, journalSeqs, error);
        throw error;
      }
    }
  }

  private enqueueActiveSaveFold(
    vaultRoot: string,
    marks: readonly SnapshotDirtyMark[],
    state: SavePublicationState,
  ): void {
    const saveJobId = this.nextSaveJobId++;
    const cancellationId = `save-fold:${this.profileHash}:${saveJobId}`;
    const fold = state.foldChain.then(async () => {
      await this.snapshotStore.foldSaveDirtyMarks(vaultRoot, marks, {
        deadline: Date.now() + this.saveMutationDeadlineMs,
        cancellationId,
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
    ...(mark.contentHash !== undefined ? { contentHash: mark.contentHash } : {}),
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

function modelStatusDeadline(requestDeadline: number): number {
  return Math.min(requestDeadline, Date.now() + MODEL_STATUS_DEADLINE_MS);
}

function unavailableModelStats(reason: 'unavailable' | 'busy'): ResidentModelStats {
  return {
    loaded: false,
    unavailable: true,
    ...(reason === 'busy' ? { busy: true } : {}),
    reason,
  };
}

function modelStatusUnavailableReason(error: unknown): 'unavailable' | 'busy' {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 'BACKPRESSURE' || code === 'DEADLINE_EXCEEDED' ? 'busy' : 'unavailable';
}

function withModelStatusDeadline(
  promise: Promise<ModelStatsWorkerResult>,
  deadline: number,
): Promise<ResidentModelStats> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.resolve(unavailableModelStats('busy'));
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<ResidentModelStats>((resolve) => {
    timeout = setTimeout(() => {
      resolve(unavailableModelStats('busy'));
    }, remainingMs);
    timeout.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function projectBulkModelStatus(
  scheduler: EmbedSchedulerLaneStats,
  pools: DaemonPoolsStats,
): ProfileRuntimeModelStatus['bulk'] {
  const ownerBulk = scheduler.gpuDevice.bulk;
  return {
    devices: projectBulkDevices(ownerBulk.devices, pools.embedding),
    queueDepth: ownerBulk.queueDepth,
    inFlight: ownerBulk.inFlight,
    batchTokenBudget: ownerBulk.batchTokenBudget ?? null,
    etaMs: ownerBulk.etaMs ?? null,
  };
}

function projectBulkDevices(
  ownerDevices: readonly GpuEmbeddingDeviceBulkDeviceStats[],
  embeddingStats: DaemonPoolsStats['embedding'],
): ModelBulkDeviceStatus[] {
  const byId = new Map<string, ModelBulkDeviceStatus>();
  const ownerByKind = new Map(ownerDevices.map((device) => [device.kind, device]));
  const representedOwnerKinds = new Set<'gpu' | 'cpu'>();
  const slots = Array.isArray(embeddingStats?.slots) ? embeddingStats.slots : [];
  for (const slot of slots) {
    const slotDevice = slot.slotDevice;
    const identity = slotDeviceIdentity(slotDevice);
    if (!identity) continue;
    const owner = ownerByKind.get(identity.kind);
    if (owner) representedOwnerKinds.add(owner.kind);
    const existing = byId.get(identity.deviceId);
    const next: ModelBulkDeviceStatus = {
      deviceId: identity.deviceId,
      executionProvider: identity.executionProvider,
      busy: Boolean(existing?.busy) || slot.busy || Boolean(owner?.busy),
      docsPerSec: Math.max(existing?.docsPerSec ?? 0, owner?.docsPerSec ?? 0),
    };
    byId.set(identity.deviceId, next);
  }
  for (const owner of ownerDevices) {
    if (representedOwnerKinds.has(owner.kind)) continue;
    const deviceId = owner.deviceId;
    if (byId.has(deviceId)) continue;
    byId.set(deviceId, {
      deviceId,
      executionProvider: owner.executionProvider ?? null,
      busy: owner.busy,
      docsPerSec: owner.docsPerSec,
    });
  }
  return [...byId.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function slotDeviceIdentity(slotDevice: unknown):
  | {
      kind: 'gpu' | 'cpu';
      deviceId: string;
      executionProvider: ModelStatsWorkerResult['executionProvider'];
    }
  | undefined {
  if (!slotDevice || typeof slotDevice !== 'object') return undefined;
  const kind = 'kind' in slotDevice ? (slotDevice as { kind?: unknown }).kind : undefined;
  if (kind === 'cpu') return { kind: 'cpu', deviceId: 'cpu', executionProvider: 'cpu' };
  if (kind === 'coreml') return { kind: 'gpu', deviceId: 'coreml', executionProvider: 'coreml' };
  if (kind === 'cuda') {
    const rawDeviceId = 'deviceId' in slotDevice ? (slotDevice as { deviceId?: unknown }).deviceId : undefined;
    const deviceId = Number.isInteger(rawDeviceId) ? Number(rawDeviceId) : 0;
    return { kind: 'gpu', deviceId: `cuda:${deviceId}`, executionProvider: 'cuda' };
  }
  return undefined;
}

export class ProfileManager {
  private readonly runtimes = new Map<string, ProfileRuntimeEntry>();
  private readonly pending = new Map<string, Promise<ProfileRuntimeEntry>>();
  private readonly cancelled = new Set<string>();
  private readonly defaultProfile: SearchRuntimeProfile;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly embedScheduler: EmbedScheduler;
  private readonly publisherRegistry = new VaultPublisherRegistry();
  private readonly reclamationAuthority = new SharedReclamationAuthority();
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

  async acquire(
    payload: { profile?: SearchRuntimeProfile },
    options: ProfileRuntimeAcquireOptions = {},
  ): Promise<ProfileRuntimeLease> {
    if (this.closed) throw Object.assign(new Error('profile manager is closed'), { code: 'SEARCH_DAEMON_NOT_READY' });
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
      },
    };
  }

  async withRuntimeFor<T>(
    payload: { profile?: SearchRuntimeProfile },
    fn: (runtime: ProfileRuntime) => Promise<T>,
    options: ProfileRuntimeAcquireOptions = {},
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
    const created = ProfileRuntime.create(
      profile,
      this.baseEnv,
      this.embedScheduler,
      this.publisherRegistry,
      this.reclamationAuthority,
      this.options,
    )
      .then(async (runtime) => {
        if (this.closed) {
          await runtime.close();
          throw Object.assign(new Error('profile manager is closed'), { code: 'SEARCH_DAEMON_NOT_READY' });
        }
        const entry: ProfileRuntimeEntry = {
          runtime,
          activeRequests: 0,
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
      if (this.closed) throw Object.assign(new Error('profile manager is closed'), { code: 'SEARCH_DAEMON_NOT_READY' });
      if (this.runtimes.get(profileHash) === entry) return entry;
    }
  }

  profileForPayload(payload: { profile?: SearchRuntimeProfile }): SearchRuntimeProfile {
    if (!payload.profile) return this.defaultProfile;
    try {
      return normalizeSearchRuntimeProfile(payload.profile);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'BAD_REQUEST' });
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
    await this.publisherRegistry.close();
    if (this.ownsEmbedScheduler) await this.embedScheduler.close();
  }

  async status(context: {
    deadline: number;
    cancellationId: string;
    vault?: string;
  }): Promise<Record<string, ProfileRuntimeStatus>> {
    const runtimeEntries = [...this.runtimes.values()];
    if (runtimeEntries.length === 0) return {};
    const residentModelStats = await this.modelStatsBestEffort(context);
    const entries = await Promise.all(
      runtimeEntries.map(
        async (entry) =>
          [
            entry.runtime.profileHash,
            await entry.runtime.status(
              context,
              {
                activeRequests: entry.activeRequests,
                ...(entry.idleDeadline ? { idleDeadline: entry.idleDeadline } : {}),
              },
              residentModelStats,
            ),
          ] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  private async modelStatsBestEffort(context: {
    deadline: number;
    cancellationId: string;
    vault?: string;
  }): Promise<ResidentModelStats> {
    const deadline = modelStatusDeadline(context.deadline);
    if (deadline <= Date.now()) return unavailableModelStats('busy');
    try {
      return await withModelStatusDeadline(
        this.embedScheduler.modelStats({
          deadline,
          cancellationId: context.cancellationId,
          requestId: `${context.cancellationId}:model-status`,
          ...(context.vault ? { vault: context.vault } : {}),
        }),
        deadline,
      );
    } catch (error) {
      return unavailableModelStats(modelStatusUnavailableReason(error));
    }
  }

  pruneSearchCaches(payload: PruneRequestPayload): SearchIndexPruneResult {
    return new SearchCacheCatalog({ env: this.baseEnv }).prune({
      unusedDays: payload.unusedDays,
      dryRun: payload.dryRun,
      protectedStoreIds: this.protectedStoreIdsForPrune(),
    });
  }

  listVaults(): ReturnType<VaultRegistry['list']> {
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
  return Object.assign(new Error('profile runtime request was cancelled'), { code: 'CANCELLED' });
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
