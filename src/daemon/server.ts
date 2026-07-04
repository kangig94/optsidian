import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync } from '../core/private-path.js';
import {
  createProcessToken,
  isAlive,
  processStartIdIsAuthoritative,
  type ProcessToken,
} from '../core/lifecycle/process-token.js';
import { ExclusiveClaim } from '../core/lifecycle/exclusive-claim.js';
import {
  SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS,
  SEARCH_DAEMON_PULSE_STALENESS_MS,
  SEARCH_DAEMON_PULSE_TICK_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type ControlDaemonRequest,
  type MutatingControlDaemonMethod,
  type QueryDaemonRequest,
  type SearchIndexProgressUpdate,
  type SearchDaemonPhase,
  type ShutdownSupersessionPayload,
  type DaemonRequestBase,
  type HeartbeatResult,
  type StatusResult,
  type DaemonConcurrencyStatus,
  type DaemonPoolConcurrency,
  type EmbedLaneConcurrency,
  type CacheConcurrency,
} from './protocol.js';
import { connectRpc, createRpcServer, probeSocketPath, type RpcRequestLike, type RpcServer } from './transport.js';
import { DaemonMetrics } from './metrics.js';
import {
  computeBinaryVersion,
  computeRuntimeHash,
  computeRuntimeScopeHash,
  createBindBackedTenancyFenceProvider,
  createOwnerRecord,
  createOwnerRegistry,
  currentUid,
  defaultSearchDaemonBinaryPath,
  defaultSearchDaemonRuntimeDir,
  discoverDaemonPredecessors,
  nextOwnerEpoch,
  ownerMatchesDesired,
  publishOwnerAndInitialPulse,
  randomIncarnationId,
  readOwnerPulse,
  readOwnerRecordAtPath,
  readReapedMarker,
  readSupersessionSentinel,
  reapedMarkerMatchesSupersession,
  reapedMarkerPath,
  recordSuccessorClaimHolder,
  resetSuccessorBreaker,
  sameOwnerIncarnation,
  socketPathForOwner,
  successorClaimDir,
  startupGraceMs,
  sweepStaleDaemonSockets,
  supersessionSentinelPath,
  writeReapedMarker,
  writeSupersessionSentinel,
  type DesiredOwnerIdentity,
  type OwnerPulse,
  type OwnerRecord,
  type OwnerRegistry,
  type SupersessionSentinelPredecessor,
  type VerifiedDaemonPredecessor,
} from './owner-registry.js';
import { createRequestScheduler } from './scheduler.js';
import { ProfileManager, type ProfileRuntime, type ProfileRuntimeStatus } from './profile-manager.js';
import type { SearchExecutionCacheStats } from './search-store/search-execution-state.js';
import { readOptsidianSettings, type OptsidianSettings } from '../core/settings.js';
import { recoverRetrievalStartupState } from './vector-store/freshness.js';
import { createEmbedScheduler, type EmbedScheduler } from './embed-scheduler.js';
import { logSearchDaemonProcessError, superviseBackground } from './supervise.js';

export type RunSearchDaemonOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

type QueryRuntime = SearchDaemon;
type ControlRuntime = SearchDaemon;
type RegistryHandler<R> = (request: RpcRequestLike, runtime: R) => unknown | Promise<unknown>;
type RejectMutatingKeys<T> = Extract<keyof T, MutatingControlDaemonMethod> extends never ? T : never;

/**
 * @lintignore Runtime-generated type tests import this contract.
 */
export type QueryMethodRegistry<R> = Partial<{
  [M in QueryDaemonRequest['method']]: (
    request: Extract<QueryDaemonRequest, { method: M }>,
    runtime: R,
  ) => unknown | Promise<unknown>;
}> & {
  [M in MutatingControlDaemonMethod]?: never;
};

export type CapabilityDispatchServer = {
  readonly methods: readonly string[];
  handleRequest(request: RpcRequestLike): Promise<unknown>;
};

// Registry preserves literal method keys so RejectMutatingKeys can reject mutators at compile time.
export function createQueryServer<R, Registry extends Record<string, RegistryHandler<R>>>(
  readRegistry: RejectMutatingKeys<Registry> & Registry,
  runtime: R,
): CapabilityDispatchServer {
  return createCapabilityDispatchServer(readRegistry, runtime, 'query daemon');
}

function createControlServer<R>(
  controlRegistry: Record<string, RegistryHandler<R>>,
  runtime: R,
): CapabilityDispatchServer {
  return createCapabilityDispatchServer(controlRegistry, runtime, 'control daemon');
}

let searchDaemonProcessErrorHandlersInstalled = false;

export async function runSearchDaemon(options: RunSearchDaemonOptions = {}): Promise<void> {
  installSearchDaemonProcessErrorHandlers();
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  if (argv.includes('--print-info')) {
    const owner = resolveOwnerFromEnv(env);
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
        socketPath: owner.socketPath,
        runtimeHash: owner.slot.runtimeHash,
        runtimeScopeHash: owner.slot.runtimeScopeHash,
        binaryVersion: owner.binaryVersion,
      })}\n`,
    );
    return;
  }

  const daemon = await SearchDaemon.start({ env });
  await daemon.waitForShutdown();
}

type StartOptions = {
  env: NodeJS.ProcessEnv;
};

type SupersessionTargetKind = 'upgrade' | 'same-protocol-wedged';

type SupersessionTarget = VerifiedDaemonPredecessor & {
  kind: SupersessionTargetKind;
  markerPath: string;
  supersession: ShutdownSupersessionPayload;
  sigtermSent?: boolean;
};

class SearchDaemon {
  private phase: SearchDaemonPhase = 'starting';
  private readonly metrics = new DaemonMetrics();
  private readonly scheduler = createRequestScheduler();
  private readonly embedScheduler: EmbedScheduler;
  private readonly profiles: ProfileManager;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private readonly registry: OwnerRegistry;
  private readonly owner: OwnerRecord;
  private readonly rpcServer: RpcServer;
  private readonly queryServer: CapabilityDispatchServer;
  private readonly controlServer: CapabilityDispatchServer;
  private readonly idleMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly activeCancellationIds = new Map<string, string>();
  private readonly readyWaiters = new Set<() => void>();
  private pulseSeq = 0;
  private progressSeq = 0;
  private pulseUpdatedAt: string;
  private pulseTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private ownershipTimer: NodeJS.Timeout | undefined;
  private ownershipWatcher: fs.FSWatcher | undefined;
  private reapedMarker: ShutdownSupersessionPayload | undefined;

  constructor(
    registry: OwnerRegistry,
    owner: OwnerRecord,
    rpcServer: RpcServer,
    embedScheduler: EmbedScheduler,
    profiles: ProfileManager,
    idleMs: number,
    env: NodeJS.ProcessEnv,
  ) {
    this.registry = registry;
    this.owner = owner;
    this.rpcServer = rpcServer;
    this.embedScheduler = embedScheduler;
    this.profiles = profiles;
    this.idleMs = idleMs;
    this.env = env;
    this.pulseUpdatedAt = owner.startedAt;
    this.queryServer = createQueryServer(queryRegistry(), this);
    this.controlServer = createControlServer(controlRegistry(), this);
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  static async start(options: StartOptions): Promise<SearchDaemon> {
    let ownerSeed = resolveOwnerFromEnv(options.env);
    if (ownerSeed.incarnationId === 'pending') {
      // Standalone boot (not spawned through a client that pre-acquired the lease and passed an
      // intended incarnation): self-mint one, matching pre-admission behavior. A client-provided
      // incarnation is adopted as-is above; the successor claim below is likewise self-acquired
      // when no client-provided claim id is present, so the ExclusiveClaim still arbitrates ≤1 owner.
      ownerSeed = { ...ownerSeed, incarnationId: randomIncarnationId() };
    }
    const desired = desiredFromOwner(ownerSeed);
    const registry = createOwnerRegistry({
      env: options.env,
      desired,
    });
    ensurePrivateDirSync(registry.runtimeDir, 'Optsidian search daemon runtime directory');
    const processToken = createProcessToken();
    const successorClaim = await bindSuccessorClaimOrExit(registry, options.env, processToken);
    const tenancyFenceClaimId = crypto.randomUUID();
    let rpcServer: RpcServer | undefined;
    let embedScheduler: EmbedScheduler | undefined;
    let profiles: ProfileManager | undefined;
    let owner: OwnerRecord | undefined;
    let daemon: SearchDaemon | undefined;
    let bootFailed = false;
    const bootWaiters = new Set<() => void>();
    const wakeBootWaiters = () => {
      for (const waiter of bootWaiters) waiter();
      bootWaiters.clear();
    };
    try {
      recordSuccessorClaimHolder(registry, desired, successorClaim, ownerSeed, { env: options.env });
      rpcServer = await createRpcServer({
        socketPath: ownerSeed.socketPath,
        handleRequest: async (request) => {
          if (daemon) return daemon.handleRpcRequest(request);
          return handleBootRequest(
            request,
            ownerSeed,
            () => owner,
            bootWaiters,
            () => daemon,
            () => bootFailed,
          );
        },
        onConnectionClosed: (requestIds) => {
          if (!daemon) return;
          for (const requestId of requestIds) {
            daemon.cancelRequest(requestId);
          }
        },
      });
      const supersessionStartedAtMs = Date.now();
      const supersessionId = `${ownerSeed.incarnationId}:${crypto.randomUUID()}`;
      const predecessors = prepareSupersessionTargets(
        registry,
        desired,
        ownerSeed,
        options.env,
        supersessionId,
        supersessionStartedAtMs,
      );
      await preSignalSameProtocolWedgedTargets(predecessors);
      assertSuccessorPublicationStillSafe(registry, desired, options.env);
      owner = createOwnerRecord(
        desired,
        ownerSeed.socketPath,
        nextOwnerEpoch(registry),
        ownerSeed.incarnationId,
        process.pid,
        ownerSeed.startedAt,
      );
      publishOwnerAndInitialPulse(registry, owner);
      writeSupersessionSentinel(
        registry.runtimeDir,
        desired,
        owner,
        predecessors.map((target): SupersessionSentinelPredecessor => ({
          owner: target.owner,
          reapedMarkerPath: target.markerPath,
        })),
        supersessionId,
        supersessionStartedAtMs,
      );
      resetSuccessorBreaker(registry, successorClaim);
      if (!successorClaim.release()) {
        throw Object.assign(new Error('search daemon successor claim could not be consumed after publication'), {
          code: 'SEARCH_DAEMON_UNAVAILABLE',
        });
      }
      const reapingBarrier =
        predecessors.length > 0 ? reapSupersessionTargets(predecessors, options.env) : Promise.resolve();
      const settings = readOptsidianSettings(process.cwd(), options.env);
      embedScheduler = createEmbedScheduler({
        env: options.env,
        settings,
        modelLoadBarrier: () => reapingBarrier,
      });
      const tenancyFence = createBindBackedTenancyFenceProvider(registry, owner, tenancyFenceClaimId, processToken);
      profiles = new ProfileManager(options.env, embedScheduler, {
        tenancyFence,
      });
      daemon = new SearchDaemon(
        registry,
        owner,
        rpcServer,
        embedScheduler,
        profiles,
        daemonIdleMs(options.env, settings),
        options.env,
      );
      daemon.initialize();
      if (predecessors.length > 0) {
        superviseBackground('predecessor-reaping', () =>
          reapingBarrier.catch((error: unknown) => {
            logSearchDaemonProcessError('predecessor reaping failed', error);
          }),
        );
      }
      wakeBootWaiters();
      return daemon;
    } catch (error) {
      bootFailed = true;
      try {
        await rpcServer?.relinquish();
      } catch (cleanupError) {
        logSearchDaemonProcessError('socket relinquish cleanup failed', cleanupError);
      }
      try {
        // Only unlink the socket if we actually bound it (rpcServer is set only after a successful
        // listen). If the bind itself failed — e.g. EADDRINUSE against a live incumbent on the
        // fallback deterministic path — the path is not ours to remove.
        if (rpcServer) removeSocketPath(ownerSeed.socketPath);
      } catch (cleanupError) {
        logSearchDaemonProcessError('socket unlink cleanup failed', cleanupError);
      }
      try {
        if (owner) registry.removeOwner(owner);
      } catch (cleanupError) {
        logSearchDaemonProcessError('owner cleanup failed', cleanupError);
      }
      try {
        successorClaim.release();
      } catch (cleanupError) {
        logSearchDaemonProcessError('successor claim cleanup failed', cleanupError);
      }
      try {
        await rpcServer?.drain();
      } catch (cleanupError) {
        logSearchDaemonProcessError('request drain cleanup failed', cleanupError);
      }
      try {
        await profiles?.close();
      } catch (cleanupError) {
        logSearchDaemonProcessError('profile cleanup failed', cleanupError);
      }
      try {
        await embedScheduler?.close();
      } catch (cleanupError) {
        logSearchDaemonProcessError('embed scheduler cleanup failed', cleanupError);
      }
      wakeBootWaiters();
      throw error;
    }
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  initialize(): void {
    // Sweep orphan staging/tmp BEFORE unblocking clients, so a client that boots a build the moment
    // the daemon is ready cannot have its fresh staging deleted by this best-effort recovery sweep.
    try {
      recoverRetrievalStartupState({ env: this.env });
    } catch (error) {
      logSearchDaemonProcessError('retrieval startup recovery failed', error);
    }
    this.phase = 'ready';
    this.wakeReadyWaiters();
    this.armPulseTimer();
    this.armIdleTimer();
    this.armOwnershipPoll();
    void sweepStaleDaemonSockets(
      this.registry.runtimeDir,
      desiredFromOwner(this.owner),
      this.owner.socketPath,
      probeSocketPath,
    ).catch((error: unknown) => {
      logSearchDaemonProcessError('stale daemon socket sweep failed', error);
    });
  }

  private async handleRpcRequest(request: RpcRequestLike): Promise<unknown> {
    if (request.method === 'Heartbeat') return this.handleHeartbeatRequest(request);
    return this.handleRequest(request, this.dispatchServer(request));
  }

  private handleHeartbeatRequest(request: RpcRequestLike): HeartbeatResult {
    validateHeartbeatRequest(request, this.owner, { requireIncarnation: true });
    return heartbeatResult(this.owner, this.phase, this.pulseSeq, this.progressSeq, this.pulseUpdatedAt);
  }

  private async handleRequest(request: RpcRequestLike, capabilityServer: CapabilityDispatchServer): Promise<unknown> {
    this.clearIdleTimer();
    this.metrics.beginRequest();
    let failed = false;
    try {
      this.validateRequest(request, capabilityServer);
      this.activeCancellationIds.set(request.requestId, this.requestCancellationId(request));
      return await this.scheduler.run(
        {
          deadline: request.deadline,
          cancellationId: this.requestCancellationId(request),
          snapshotId:
            isRecord(request.payload) && typeof request.payload.snapshotId === 'string'
              ? request.payload.snapshotId
              : undefined,
        },
        () => capabilityServer.handleRequest(request),
      );
    } catch (error) {
      failed = true;
      throw reclassifyVaultResolutionError(error);
    } finally {
      this.activeCancellationIds.delete(request.requestId);
      this.metrics.finishRequest(failed);
      this.armIdleTimer();
    }
  }

  private dispatchServer(request: RpcRequestLike): CapabilityDispatchServer {
    if (this.queryServer.methods.includes(request.method)) return this.queryServer;
    return this.controlServer;
  }

  private cancelRequest(requestId: string): void {
    const cancellationIds = new Set([requestId]);
    const activeCancellationId = this.activeCancellationIds.get(requestId);
    if (activeCancellationId) cancellationIds.add(activeCancellationId);
    for (const cancellationId of cancellationIds) {
      try {
        this.scheduler.cancel(cancellationId);
      } catch (error) {
        logSearchDaemonProcessError(`request cancellation "${cancellationId}" scheduler cancel failed`, error);
      }
      try {
        this.profiles.cancel(cancellationId);
      } catch (error) {
        logSearchDaemonProcessError(`request cancellation "${cancellationId}" profile cancel failed`, error);
      }
    }
  }

  private validateRequest(request: RpcRequestLike, capabilityServer: CapabilityDispatchServer): void {
    if (request.protocolVersion !== SEARCH_DAEMON_PROTOCOL_VERSION) {
      throw Object.assign(new Error('search daemon protocol version mismatch'), { code: 'BAD_REQUEST' });
    }
    if (!capabilityServer.methods.includes(request.method)) {
      throw Object.assign(new Error(`unknown ${capabilityLabel(capabilityServer)} method`), { code: 'BAD_REQUEST' });
    }
    if (!Number.isFinite(request.deadline)) {
      throw Object.assign(new Error('request deadline must be a finite number'), { code: 'BAD_REQUEST' });
    }
    if (Date.now() >= request.deadline) {
      throw Object.assign(new Error('request deadline expired before admission'), { code: 'DEADLINE_EXCEEDED' });
    }
    if (request.payload === null || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      throw Object.assign(new Error('request payload must be an object'), { code: 'BAD_REQUEST' });
    }
    if (this.phase === 'draining' && request.method !== 'Status') {
      throw Object.assign(new Error('search daemon is draining'), { code: 'DAEMON_DRAINING' });
    }
    if (!incarnationOptionalMethod(request.method) && request.incarnation !== this.owner.incarnationId) {
      throw Object.assign(new Error('search daemon incarnation is stale'), { code: 'STALE_INCARNATION' });
    }
  }

  async dispatchQuery(request: QueryDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case 'Status':
        return this.status(request);
      case 'WaitReady':
        return this.waitReady(request);
      case 'Heartbeat':
        return this.handleHeartbeatRequest(request);
      case 'Search': {
        return this.profiles.withRuntimeFor(
          request.payload,
          async (runtime) => {
            const result = await runtime.searchStore.search(request.payload, this.requestContext(request));
            if (result.status === undefined || result.status === 'ready') {
              runtime.vaults.transition(request.payload.vault, 'ready', { snapshotId: result.snapshotId });
              runtime.startSaveWatcherForVault(request.payload.vault);
            }
            return result;
          },
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Retrieve': {
        return this.profiles.withRuntimeFor(
          request.payload,
          async (runtime) => {
            const result = await runtime.searchStore.retrieve(request.payload, this.requestContext(request));
            if (result.status === 'ready') {
              runtime.vaults.transition(request.payload.vault, 'ready', { snapshotId: result.snapshotId });
              runtime.startSaveWatcherForVault(request.payload.vault);
            }
            return result;
          },
          { cancellationId: this.requestCancellationId(request) },
        );
      }
    }
  }

  async dispatchControl(request: ControlDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case 'Status':
        return this.status(request);
      case 'WaitReady':
        return this.waitReady(request);
      case 'Heartbeat':
        return this.handleHeartbeatRequest(request);
      case 'LoadVault': {
        return this.profiles.withRuntimeFor(
          request.payload,
          async (runtime) => {
            const progress = this.progressReporter(runtime, request.payload.vault, 'loading');
            runtime.vaults.transition(request.payload.vault, 'loading');
            try {
              const result = await runtime.searchStore.loadVault(
                request.payload.vault,
                this.requestContext(request, progress),
              );
              const failed = result.vaults.find((vault) => vault.status === 'failed');
              if (failed) {
                runtime.vaults.transition(request.payload.vault, 'unloaded', { error: failed.error });
                runtime.stopSaveWatcherForVault(request.payload.vault);
                return result;
              }
              const readyVault = result.vaults.find((vault) => vault.status === 'ready');
              const readyVaultRoot = readyVault?.vaultRoot ?? request.payload.vault;
              runtime.vaults.transition(readyVaultRoot, 'ready', {
                snapshotId: 'snapshotId' in result ? result.snapshotId : undefined,
              });
              runtime.startSaveWatcherForVault(readyVaultRoot);
              return result;
            } catch (error) {
              runtime.vaults.transition(request.payload.vault, 'unloaded', { error: errorMessage(error) });
              runtime.stopSaveWatcherForVault(request.payload.vault);
              throw error;
            }
          },
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Rebuild': {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) =>
            this.updating(runtime, request.payload.vault, (progress) =>
              runtime.searchStore.rebuild(request.payload.vault, this.requestContext(request, progress)),
            ),
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Refresh': {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) =>
            this.updating(runtime, request.payload.vault, (progress) =>
              runtime.searchStore.refresh(request.payload.vault, this.requestContext(request, progress)),
            ),
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Compact': {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) =>
            this.updating(runtime, request.payload.vault, (progress) =>
              runtime.searchStore.compact(request.payload.vault, this.requestContext(request, progress)),
            ),
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Clear': {
        return this.profiles.withRuntimeFor(
          request.payload,
          async (runtime) => {
            runtime.vaults.transition(request.payload.vault, 'updating');
            try {
              const result = await runtime.searchStore.clear(request.payload.vault);
              runtime.vaults.transition(request.payload.vault, 'ready', { snapshotId: undefined });
              return result;
            } catch (error) {
              runtime.vaults.transition(request.payload.vault, 'ready', { error: errorMessage(error) });
              throw error;
            }
          },
          { cancellationId: this.requestCancellationId(request) },
        );
      }
      case 'Prune':
        return this.profiles.pruneSearchCaches(request.payload);
      case 'Shutdown': {
        const supersession = shutdownSupersessionPayload(request.payload);
        if (supersession) this.reapedMarker = supersession;
        setTimeout(() => {
          void this.drain('draining', Boolean(supersession), supersession).catch(() => {});
        }, 0).unref();
        return { ok: true, shuttingDown: true };
      }
    }
  }

  private async updating<T>(
    runtime: ProfileRuntime,
    vault: string,
    fn: (progress: (progress: SearchIndexProgressUpdate) => void) => Promise<T>,
    snapshotId?: string,
  ): Promise<T> {
    const progress = this.progressReporter(runtime, vault, 'updating');
    runtime.vaults.transition(vault, 'updating');
    try {
      const result = await fn(progress);
      const resultSnapshotId = snapshotId ?? snapshotIdFromResult(result);
      runtime.vaults.transition(vault, 'ready', resultSnapshotId ? { snapshotId: resultSnapshotId } : {});
      runtime.startSaveWatcherForVault(vault);
      return result;
    } catch (error) {
      runtime.vaults.transition(vault, 'ready', { error: errorMessage(error) });
      throw error;
    }
  }

  private async status(
    request: Extract<QueryDaemonRequest | ControlDaemonRequest, { method: 'Status' | 'WaitReady' }>,
  ): Promise<StatusResult> {
    const context = this.requestContext(request);
    const profiles = await this.profiles.status(context);
    return {
      ...statusBase(this.owner, this.phase),
      metrics: this.metrics.snapshot(),
      pools: Object.fromEntries(Object.entries(profiles).map(([hash, profile]) => [hash, profile.pools])),
      searchStore: Object.fromEntries(Object.entries(profiles).map(([hash, profile]) => [hash, profile.searchStore])),
      profiles,
      concurrency: buildConcurrency(profiles),
      vaults: this.profiles.listVaults(),
    };
  }

  private async waitReady(
    request: Extract<QueryDaemonRequest | ControlDaemonRequest, { method: 'WaitReady' }>,
  ): Promise<StatusResult> {
    if (this.phase === 'ready') return this.status(request);
    if (this.phase === 'draining') {
      throw Object.assign(new Error('search daemon is draining'), { code: 'DAEMON_DRAINING' });
    }
    await this.waitForReadyPhase(request.deadline);
    return this.status(request);
  }

  private waitForReadyPhase(deadline: number): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve();
    if (this.phase === 'draining') {
      return Promise.reject(Object.assign(new Error('search daemon is draining'), { code: 'DAEMON_DRAINING' }));
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return Promise.reject(Object.assign(new Error('wait-ready deadline expired'), { code: 'DEADLINE_EXCEEDED' }));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        if (this.phase === 'ready') resolve();
        else reject(Object.assign(new Error('search daemon is draining'), { code: 'DAEMON_DRAINING' }));
      };
      const timer = setTimeout(finish, remainingMs);
      timer.unref();
      this.readyWaiters.add(finish);
    });
  }

  async closeForTests(): Promise<void> {
    await this.drain('draining');
  }

  private async drain(
    phase: Extract<SearchDaemonPhase, 'draining'>,
    bounded = false,
    reapedMarker?: ShutdownSupersessionPayload,
  ): Promise<void> {
    if (this.phase === 'draining') return;
    this.phase = phase;
    const marker = reapedMarker ?? this.reapedMarker;
    this.clearIdleTimer();
    this.clearPulseTimer();
    this.clearOwnershipTimer();
    this.wakeReadyWaiters();
    if (bounded) this.cancelActiveRequestsForSupersession();
    try {
      await this.rpcServer.relinquish();
    } catch {
      // Best-effort shutdown step.
    }
    try {
      // Each incarnation binds its own unique socket path, so this only ever removes this daemon's
      // own file — never a successor's. `registry.removeOwner` is incarnation-guarded separately.
      removeSocketPath(this.owner.socketPath);
    } catch {
      // Best-effort shutdown step.
    }
    try {
      this.registry.removeOwner(this.owner);
    } catch {
      // Best-effort shutdown step.
    }
    try {
      // Bound only the supersession self-drain path: a superseded daemon's remaining work is doomed
      // because its writer lease is gone. Normal Shutdown/idle drains wait for legitimate in-flight
      // Rebuild/Refresh/Compact work to finish.
      await (bounded ? withDeadline(this.rpcServer.drain(), DRAIN_DEADLINE_MS) : this.rpcServer.drain());
    } catch {
      // Best-effort shutdown step.
    }
    let profilesClosed = false;
    try {
      profilesClosed = bounded
        ? await withDeadlineSettled(this.profiles.close(), DRAIN_DEADLINE_MS)
        : await this.profiles.close().then(() => true);
    } catch {
      // Best-effort shutdown step.
    }
    let embedSchedulerClosed = false;
    try {
      if (bounded) {
        await withDeadline(this.embedScheduler.drain({ cancel: true }), DRAIN_DEADLINE_MS);
      }
      embedSchedulerClosed = bounded
        ? await withDeadlineSettled(this.embedScheduler.close(), DRAIN_DEADLINE_MS)
        : await this.embedScheduler.close().then(() => true);
    } catch {
      // Best-effort shutdown step.
    }
    if (marker && profilesClosed && embedSchedulerClosed) {
      try {
        writeReapedMarker(marker.reapedMarkerPath, marker);
      } catch {
        // The marker is proof for a successor, not a reason to keep this process alive.
      }
    }
    this.resolveShutdown();
  }

  private cancelActiveRequestsForSupersession(): void {
    const cancellationIds = new Set<string>();
    for (const [requestId, cancellationId] of this.activeCancellationIds.entries()) {
      cancellationIds.add(requestId);
      cancellationIds.add(cancellationId);
    }
    cancellationIds.add('supersession-drain');
    for (const cancellationId of cancellationIds) {
      try {
        this.scheduler.cancel(cancellationId);
      } catch {
        // Best-effort supersession cancellation.
      }
      try {
        this.profiles.cancel(cancellationId);
      } catch {
        // Best-effort supersession cancellation.
      }
      try {
        this.embedScheduler.cancel(cancellationId);
      } catch {
        // Best-effort supersession cancellation.
      }
    }
  }

  private wakeReadyWaiters(): void {
    for (const waiter of this.readyWaiters) waiter();
    this.readyWaiters.clear();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.phase !== 'ready') return;
    if (this.metrics.snapshot().activeRequests > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.drain('draining').catch((error: unknown) => {
        logSearchDaemonProcessError('idle shutdown failed', error);
      });
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armOwnershipPoll(): void {
    this.clearOwnershipTimer();
    const check = () => {
      if (this.phase !== 'ready') return;
      const marker = this.supersessionReapedMarker();
      if (!marker && !this.superseded()) return;
      // A newer incarnation now owns the registry slot. This daemon's writer lease is gone, so its
      // commits are fenced out as not-current, but it would otherwise keep a full worker pool and
      // Kiwi WASM resident while still answering requests until the idle timer finally fires.
      void this.drain('draining', true, marker).catch((error: unknown) => {
        logSearchDaemonProcessError('supersession shutdown failed', error);
      });
    };
    try {
      const ownerFileName = path.basename(this.registry.ownerPath);
      const sentinelFileName = path.basename(
        supersessionSentinelPath(this.registry.runtimeDir, desiredFromOwner(this.owner)),
      );
      this.ownershipWatcher = fs.watch(this.registry.runtimeDir, (_event, fileName) => {
        if (fileName !== ownerFileName && fileName !== sentinelFileName) return;
        setTimeout(check, 0).unref();
      });
      this.ownershipWatcher.unref();
    } catch {
      // Slow polling below is the compatibility path for WSL/network filesystems and watch failures.
    }
    this.ownershipTimer = setInterval(check, ownershipPollMs(this.env));
    this.ownershipTimer.unref();
  }

  private clearOwnershipTimer(): void {
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    this.ownershipTimer = undefined;
    this.ownershipWatcher?.close();
    this.ownershipWatcher = undefined;
  }

  private armPulseTimer(): void {
    this.clearPulseTimer();
    this.pulseTimer = setInterval(() => {
      this.bumpPulse();
    }, SEARCH_DAEMON_PULSE_TICK_MS);
    this.pulseTimer.unref();
  }

  private clearPulseTimer(): void {
    if (!this.pulseTimer) return;
    clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
  }

  private superseded(): boolean {
    let current: OwnerRecord | undefined;
    try {
      current = this.registry.readOwner();
    } catch {
      // A transient read failure is not proof of supersession; keep serving and re-check next tick.
      return false;
    }
    // The owner file is the sole arbiter now that unique socket paths no longer serialize ownership.
    // Step down for a present, different incarnation at an epoch >= ours: `>=` (not `>`) reaps the
    // loser of an equal-epoch cold-start race — exactly the tie the shared socket bind used to break.
    // A missing/older/identical record never triggers a step-down, so a healthy sole owner stays.
    return current !== undefined && current.epoch >= this.owner.epoch && !sameOwnerIncarnation(current, this.owner);
  }

  private supersessionReapedMarker(): ShutdownSupersessionPayload | undefined {
    let sentinel: ReturnType<typeof readSupersessionSentinel> | undefined;
    try {
      sentinel = readSupersessionSentinel(this.registry.runtimeDir, desiredFromOwner(this.owner));
    } catch {
      return undefined;
    }
    if (!sentinel) return undefined;
    const predecessor = sentinel.predecessors.find((candidate) => sameOwnerIncarnation(candidate.owner, this.owner));
    if (!predecessor) return undefined;
    return {
      id: sentinel.supersessionId,
      predecessor: {
        uid: this.owner.slot.uid,
        epoch: this.owner.epoch,
        incarnationId: this.owner.incarnationId,
        pid: this.owner.pid,
      },
      reapedMarkerPath: predecessor.reapedMarkerPath,
      startedAtMs: sentinel.startedAtMs,
    };
  }

  private requestContext(
    request: DaemonRequestBase<string, unknown>,
    progress?: (progress: SearchIndexProgressUpdate) => void,
  ) {
    return {
      deadline: request.deadline,
      cancellationId: this.requestCancellationId(request),
      requestId: request.requestId,
      progress,
    };
  }

  private requestCancellationId(request: DaemonRequestBase<string, unknown>): string {
    return request.cancellationId ?? request.requestId;
  }

  private progressReporter(
    runtime: ProfileRuntime,
    vault: string,
    state: 'loading' | 'updating',
  ): (progress: SearchIndexProgressUpdate) => void {
    const startedAt = new Date().toISOString();
    return (progress) => {
      const updatedAt = this.bumpProgressPulse();
      runtime.vaults.transition(vault, state, {
        progress: {
          ...progress,
          startedAt,
          updatedAt,
        },
      });
    };
  }

  private bumpPulse(updatedAt = new Date().toISOString()): string {
    this.pulseSeq += 1;
    this.pulseUpdatedAt = updatedAt;
    this.writeOwnerPulseBestEffort();
    return updatedAt;
  }

  private bumpProgressPulse(): string {
    const updatedAt = new Date().toISOString();
    this.progressSeq += 1;
    return this.bumpPulse(updatedAt);
  }

  private ownerPulse(): OwnerPulse {
    return {
      epoch: this.owner.epoch,
      incarnationId: this.owner.incarnationId,
      socket: this.owner.socketPath,
      phase: this.phase,
      pulseSeq: this.pulseSeq,
      progressSeq: this.progressSeq,
      updatedAt: this.pulseUpdatedAt,
    };
  }

  private writeOwnerPulseBestEffort(): void {
    try {
      this.registry.writeOwnerPulse(this.ownerPulse());
    } catch {
      // The pulse sidecar is advisory liveness evidence; write failures must not take down the daemon.
    }
  }
}

export function createSearchDaemonIdleIsolationHarnessForTests(options: {
  idleMs: number;
  env?: NodeJS.ProcessEnv;
  embedScheduler: EmbedScheduler;
  rpcServer?: RpcServer;
  profiles?: ProfileManager;
}): {
  waitForShutdown(): Promise<void>;
  close(): Promise<void>;
  handle(request: RpcRequestLike): Promise<unknown>;
  metrics(): ReturnType<DaemonMetrics['snapshot']>;
  ownerRemoved(): boolean;
  owner: OwnerRecord;
  replaceOwner(record: OwnerRecord | undefined): void;
  socketPath: string;
} {
  const env = options.env ?? process.env;
  const owner: OwnerRecord = {
    slot: {
      uid: currentUid(),
      runtimeHash: 'test-runtime',
      protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    },
    epoch: 1,
    incarnationId: randomIncarnationId(),
    binaryVersion: 'test-binary',
    pid: process.pid,
    socketPath: `/tmp/optsidian-search-daemon-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`,
    startedAt: new Date().toISOString(),
  };
  let currentOwner: OwnerRecord | undefined = owner;
  let currentPulse: OwnerPulse | undefined;
  let removed = false;
  const registry: OwnerRegistry = {
    runtimeDir: '/tmp',
    ownerPath: '/tmp/optsidian-search-daemon-test.owner',
    readOwner: () => currentOwner,
    writeOwner: (record) => {
      currentOwner = record;
    },
    readOwnerPulse: () => currentPulse,
    writeOwnerPulse: (pulse) => {
      currentPulse = pulse;
    },
    removeOwner: (record) => {
      if (record && currentOwner && !sameOwnerIncarnation(currentOwner, record)) return;
      currentOwner = undefined;
      removed = true;
    },
  };
  const rpcServer: RpcServer = options.rpcServer ?? {
    relinquish: async () => undefined,
    drain: async () => undefined,
    close: async () => undefined,
  };
  const profiles = options.profiles ?? new ProfileManager(env, options.embedScheduler);
  const daemon = new SearchDaemon(registry, owner, rpcServer, options.embedScheduler, profiles, options.idleMs, env);
  daemon.initialize();
  return {
    waitForShutdown: () => daemon.waitForShutdown(),
    close: () => daemon.closeForTests(),
    handle: (request) =>
      (daemon as unknown as { handleRpcRequest(request: RpcRequestLike): Promise<unknown> }).handleRpcRequest(request),
    metrics: () => (daemon as unknown as { metrics: DaemonMetrics }).metrics.snapshot(),
    ownerRemoved: () => removed,
    owner,
    replaceOwner(record) {
      currentOwner = record;
    },
    socketPath: owner.socketPath,
  };
}

export function hasReapingProofForTests(input: {
  markerPath: string;
  supersession: ShutdownSupersessionPayload;
  token: ProcessToken;
}): boolean {
  return hasReapingProof(input as SupersessionTarget);
}

export function reapingSignalPlanForTests(input: {
  kind: SupersessionTargetKind;
  initialProof?: boolean;
  recoveredBeforeSignal?: boolean;
  authoritativeStartId?: boolean;
  sigtermAlreadySent?: boolean;
  identityBeforeTerm?: boolean;
  proofAfterTerm?: boolean;
  identityBeforeKill?: boolean;
  proofAfterKill?: boolean;
}): { outcome: 'reaped' | 'abort-recovered' | 'unavailable'; signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  if (input.initialProof) return { outcome: 'reaped', signals };
  if (input.kind === 'same-protocol-wedged' && input.recoveredBeforeSignal) {
    return { outcome: 'abort-recovered', signals };
  }
  if (!input.authoritativeStartId) return { outcome: 'unavailable', signals };
  if (!input.sigtermAlreadySent) {
    if (input.identityBeforeTerm === false) return { outcome: 'unavailable', signals };
    signals.push('SIGTERM');
  }
  if (input.proofAfterTerm) return { outcome: 'reaped', signals };
  if (input.identityBeforeKill === false) return { outcome: 'unavailable', signals };
  signals.push('SIGKILL');
  return { outcome: input.proofAfterKill ? 'reaped' : 'unavailable', signals };
}

export async function handleBootRequestForTests(
  request: RpcRequestLike,
  ownerSeed: OwnerRecord,
  owner?: OwnerRecord,
): Promise<StatusResult | HeartbeatResult> {
  return handleBootRequest(
    request,
    ownerSeed,
    () => owner,
    new Set(),
    () => undefined,
    () => false,
  );
}

async function bindSuccessorClaimOrExit(
  registry: OwnerRegistry,
  env: NodeJS.ProcessEnv,
  processToken: ReturnType<typeof createProcessToken>,
): Promise<ExclusiveClaim> {
  const expectedClaimId = env.OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_CLAIM_ID?.trim();
  if (!expectedClaimId) {
    // Standalone boot: no client pre-acquired the lease, so self-acquire the exclusive successor
    // claim. It still arbitrates a single owner (a competing boot fails to acquire and exits), and
    // it is released after owner publication exactly like the client-provided path.
    return ExclusiveClaim.acquire(successorClaimDir(registry.ownerPath), {
      claimId: randomIncarnationId(),
      token: processToken,
    });
  }
  const claim = ExclusiveClaim.rebindToken(successorClaimDir(registry.ownerPath), expectedClaimId, {
    token: processToken,
  });
  if (!claim) {
    throw Object.assign(new Error('search daemon successor claim was lost before boot'), {
      code: 'SEARCH_DAEMON_UNAVAILABLE',
    });
  }
  return claim;
}

function assertSuccessorPublicationStillSafe(
  registry: OwnerRegistry,
  desired: DesiredOwnerIdentity,
  env: NodeJS.ProcessEnv,
): void {
  const current = registry.readOwner();
  if (!current) return;

  const observed = observedOwnerFromEnv(env);
  if (observed) {
    if (
      current.epoch !== observed.epoch ||
      current.incarnationId !== observed.incarnationId ||
      (observed.socketPath !== undefined && current.socketPath !== observed.socketPath)
    ) {
      throw Object.assign(new Error('search daemon successor incumbent changed before publication'), {
        code: 'SEARCH_DAEMON_UNAVAILABLE',
      });
    }
  } else if (ownerMatchesDesired(current, desired)) {
    throw Object.assign(new Error('search daemon owner recovered before successor publication'), {
      code: 'SEARCH_DAEMON_UNAVAILABLE',
    });
  }

  if (!ownerMatchesDesired(current, desired)) return;

  let pulse: OwnerPulse | undefined;
  try {
    pulse = registry.readOwnerPulse();
  } catch {
    pulse = undefined;
  }
  if (pulse && pulseMatchesOwner(pulse, current)) {
    if (pulse.phase === 'draining') return;
    const updatedAtMs = Date.parse(pulse.updatedAt);
    if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= SEARCH_DAEMON_PULSE_STALENESS_MS) {
      throw Object.assign(new Error('search daemon owner recovered before successor publication'), {
        code: 'SEARCH_DAEMON_UNAVAILABLE',
      });
    }
  }

  if (ownerWithinStartupGrace(current, Date.now(), startupGraceMs(env))) {
    throw Object.assign(new Error('search daemon owner remains within startup grace'), {
      code: 'SEARCH_DAEMON_UNAVAILABLE',
    });
  }
}

function observedOwnerFromEnv(
  env: NodeJS.ProcessEnv,
): { epoch: number; incarnationId: string; socketPath?: string } | undefined {
  const rawEpoch = env.OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_EPOCH?.trim();
  const incarnationId = env.OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_INCARNATION?.trim();
  if (!rawEpoch || !incarnationId) return undefined;
  const epoch = Number(rawEpoch);
  if (!Number.isInteger(epoch)) return undefined;
  const socketPath = env.OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_SOCKET?.trim();
  return {
    epoch,
    incarnationId,
    ...(socketPath ? { socketPath } : {}),
  };
}

function successorHealthKindFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_HEALTH_KIND?.trim();
  return raw ? raw : undefined;
}

function prepareSupersessionTargets(
  registry: OwnerRegistry,
  desired: DesiredOwnerIdentity,
  ownerSeed: OwnerRecord,
  env: NodeJS.ProcessEnv,
  supersessionId: string,
  supersessionStartedAtMs: number,
): SupersessionTarget[] {
  const observed = observedOwnerFromEnv(env);
  const healthKind = successorHealthKindFromEnv(env);
  const predecessors = registry.discoverPredecessors
    ? registry.discoverPredecessors(desired, ownerSeed)
    : discoverDaemonPredecessors(registry.runtimeDir, desired, ownerSeed);
  const targets = new Map<string, SupersessionTarget>();
  for (const predecessor of predecessors) {
    const owner = predecessor.owner;
    const sameProtocol = owner.slot.protocolVersion === desired.protocolVersion;
    const sameBinary = owner.binaryVersion === desired.binaryVersion;
    const observedMatch = Boolean(
      observed &&
      owner.epoch === observed.epoch &&
      owner.incarnationId === observed.incarnationId &&
      (!observed.socketPath || owner.socketPath === observed.socketPath),
    );
    const kind: SupersessionTargetKind | undefined =
      !sameProtocol || !sameBinary
        ? 'upgrade'
        : healthKind === 'wedged' && observedMatch
          ? 'same-protocol-wedged'
          : undefined;
    if (!kind) continue;
    const markerPath = reapedMarkerPath(registry.runtimeDir, owner);
    const key = `${owner.slot.protocolVersion}:${owner.epoch}:${owner.incarnationId}:${owner.pid}`;
    targets.set(key, {
      ...predecessor,
      kind,
      markerPath,
      supersession: {
        id: supersessionId,
        predecessor: {
          uid: owner.slot.uid,
          epoch: owner.epoch,
          incarnationId: owner.incarnationId,
          pid: owner.pid,
        },
        reapedMarkerPath: markerPath,
        startedAtMs: supersessionStartedAtMs,
      },
    });
  }
  return [...targets.values()];
}

async function preSignalSameProtocolWedgedTargets(targets: SupersessionTarget[]): Promise<void> {
  for (const target of targets) {
    if (target.kind !== 'same-protocol-wedged') continue;
    if (await sameProtocolPredecessorRecovered(target)) {
      throw Object.assign(new Error('search daemon predecessor recovered before supersession termination'), {
        code: 'SEARCH_DAEMON_UNAVAILABLE',
      });
    }
    if (!processStartIdIsAuthoritative(target.token.startId)) continue;
    if (!predecessorIdentityStillMatches(target)) continue;
    signalProcess(target.token, 'SIGTERM');
    target.sigtermSent = true;
  }
}

async function sameProtocolPredecessorRecovered(target: SupersessionTarget): Promise<boolean> {
  if (freshPulseForOwner(target.ownerPath, target.owner)) return true;
  try {
    const heartbeat = await heartbeatPredecessor(target.owner);
    if (!sameOwnerIncarnation(heartbeat.owner, target.owner)) return false;
    if (heartbeat.phase === 'draining') return false;
    const updatedAtMs = Date.parse(heartbeat.updatedAt);
    return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= SEARCH_DAEMON_PULSE_STALENESS_MS;
  } catch {
    return freshPulseForOwner(target.ownerPath, target.owner);
  }
}

function freshPulseForOwner(ownerPath: string, owner: OwnerRecord): boolean {
  let pulse: OwnerPulse | undefined;
  try {
    pulse = readOwnerPulse(ownerPath);
  } catch {
    return false;
  }
  if (!pulse || !pulseMatchesOwner(pulse, owner) || pulse.phase === 'draining') return false;
  const updatedAtMs = Date.parse(pulse.updatedAt);
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= SEARCH_DAEMON_PULSE_STALENESS_MS;
}

async function reapSupersessionTargets(targets: readonly SupersessionTarget[], env: NodeJS.ProcessEnv): Promise<void> {
  await Promise.all(targets.map((target) => reapSupersessionTarget(target, env)));
}

async function reapSupersessionTarget(target: SupersessionTarget, env: NodeJS.ProcessEnv): Promise<void> {
  if (await waitForReapingProof(target, 0, env)) return;
  if (target.kind === 'upgrade') {
    const shutdownAccepted = await sendCourtesyShutdown(target.owner, target.supersession).then(
      () => true,
      () => false,
    );
    if (shutdownAccepted && (await waitForReapingProof(target, reapingRpcGraceMs(env), env))) return;
  }
  await terminateWithVerifiedProof(target, env);
}

async function terminateWithVerifiedProof(target: SupersessionTarget, env: NodeJS.ProcessEnv): Promise<void> {
  if (await waitForReapingProof(target, 0, env)) return;
  if (!processStartIdIsAuthoritative(target.token.startId)) {
    if (await waitForReapingProof(target, reapingRpcGraceMs(env), env)) return;
    throw Object.assign(new Error('cannot terminate predecessor with unverified process start identity'), {
      code: 'SEARCH_DAEMON_UNAVAILABLE',
    });
  }
  if (!target.sigtermSent) {
    if (!predecessorIdentityStillMatches(target)) {
      if (await waitForReapingProof(target, 0, env)) return;
      throw Object.assign(new Error('predecessor process identity changed before SIGTERM'), {
        code: 'SEARCH_DAEMON_UNAVAILABLE',
      });
    }
    signalProcess(target.token, 'SIGTERM');
    target.sigtermSent = true;
  }
  if (await waitForReapingProof(target, reapingTermWaitMs(env), env)) return;
  if (!predecessorIdentityStillMatches(target)) {
    if (await waitForReapingProof(target, 0, env)) return;
    throw Object.assign(new Error('predecessor process identity changed before SIGKILL'), {
      code: 'SEARCH_DAEMON_UNAVAILABLE',
    });
  }
  signalProcess(target.token, 'SIGKILL');
  if (await waitForReapingProof(target, reapingKillWaitMs(env), env)) return;
  throw Object.assign(new Error('predecessor did not provide verified reaping proof before deadline'), {
    code: 'SEARCH_DAEMON_UNAVAILABLE',
  });
}

function predecessorIdentityStillMatches(target: SupersessionTarget): boolean {
  const current = readOwnerRecordAtPath(target.ownerPath);
  if (
    target.kind === 'upgrade' &&
    current &&
    (!sameOwnerIncarnation(current, target.owner) || current.pid !== target.owner.pid)
  ) {
    return false;
  }
  return isAlive(target.token);
}

async function waitForReapingProof(
  target: SupersessionTarget,
  waitMs: number,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    if (hasReapingProof(target)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(reapingPollMs(env), Math.max(1, deadline - Date.now())));
  }
}

function hasReapingProof(target: SupersessionTarget): boolean {
  try {
    if (reapedMarkerMatchesSupersession(readReapedMarker(target.markerPath), target.supersession)) return true;
  } catch {
    // A marker read failure is not teardown proof.
  }
  return processStartIdIsAuthoritative(target.token.startId) && !isAlive(target.token);
}

function signalProcess(token: ProcessToken, signal: NodeJS.Signals): void {
  if (!processStartIdIsAuthoritative(token.startId)) return;
  if (!isAlive(token)) return;
  try {
    process.kill(token.pid, signal);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return;
    throw error;
  }
}

async function heartbeatPredecessor(owner: OwnerRecord): Promise<HeartbeatResult> {
  const connection = await connectRpc<Extract<QueryDaemonRequest, { method: 'Heartbeat' }>>(owner.socketPath);
  try {
    return (await connection.request({
      protocolVersion: owner.slot.protocolVersion,
      requestId: crypto.randomUUID(),
      method: 'Heartbeat',
      deadline: Date.now() + Math.min(SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS, SEARCH_DAEMON_PULSE_STALENESS_MS),
      incarnation: owner.incarnationId,
      payload: {},
    })) as HeartbeatResult;
  } finally {
    await connection.close();
  }
}

function pulseMatchesOwner(pulse: OwnerPulse, owner: OwnerRecord): boolean {
  return (
    pulse.epoch === owner.epoch && pulse.incarnationId === owner.incarnationId && pulse.socket === owner.socketPath
  );
}

function ownerWithinStartupGrace(owner: OwnerRecord, nowMs: number, graceMs: number): boolean {
  const startedAtMs = Date.parse(owner.startedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs <= graceMs;
}

function resolveOwnerFromEnv(env: NodeJS.ProcessEnv): OwnerRecord {
  const runtimeDir = defaultSearchDaemonRuntimeDir(env);
  const binaryPath = defaultSearchDaemonBinaryPath(env);
  const runtimeHash = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH?.trim();
  const runtimeScopeHash = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_SCOPE_HASH?.trim();
  const binaryVersion = env.OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION?.trim();
  const socketPathOverride = env.OPTSIDIAN_SEARCH_DAEMON_SOCKET?.trim();
  const incarnation = env.OPTSIDIAN_SEARCH_DAEMON_INCARNATION?.trim();
  const uid = env.OPTSIDIAN_SEARCH_DAEMON_UID ? Number(env.OPTSIDIAN_SEARCH_DAEMON_UID) : currentUid();
  const desired: DesiredOwnerIdentity = {
    uid,
    runtimeHash: runtimeHash ? runtimeHash : computeRuntimeHash(binaryPath),
    runtimeScopeHash: runtimeScopeHash ? runtimeScopeHash : computeRuntimeScopeHash(binaryPath, uid, env),
    binaryVersion: binaryVersion ? binaryVersion : computeBinaryVersion(binaryPath),
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
  };
  const socketPath = socketPathOverride ? socketPathOverride : socketPathForOwner(runtimeDir, desired);
  return createOwnerRecord(
    desired,
    socketPath,
    0,
    incarnation ? incarnation : 'pending',
    process.pid,
    new Date().toISOString(),
  );
}

function removeSocketPath(socketPath: string): void {
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    throw new Error(`Cannot remove stale search daemon socket at ${socketPath}`);
  }
}

function desiredFromOwner(owner: OwnerRecord): DesiredOwnerIdentity {
  return {
    uid: owner.slot.uid,
    runtimeHash: owner.slot.runtimeHash,
    runtimeScopeHash: owner.slot.runtimeScopeHash ?? owner.slot.runtimeHash,
    binaryVersion: owner.binaryVersion,
    protocolVersion: owner.slot.protocolVersion,
  };
}

async function sendCourtesyShutdown(
  predecessor: OwnerRecord,
  supersession: ShutdownSupersessionPayload,
): Promise<void> {
  const connection = await connectRpc<Extract<ControlDaemonRequest, { method: 'Shutdown' }>>(predecessor.socketPath);
  try {
    await connection.request({
      protocolVersion: predecessor.slot.protocolVersion,
      requestId: crypto.randomUUID(),
      method: 'Shutdown',
      deadline: Date.now() + SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS,
      incarnation: predecessor.incarnationId,
      payload: { supersession },
    });
  } finally {
    await connection.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installSearchDaemonProcessErrorHandlers(): void {
  if (searchDaemonProcessErrorHandlersInstalled) return;
  searchDaemonProcessErrorHandlersInstalled = true;
  process.on('uncaughtException', (error) => {
    logSearchDaemonProcessError('uncaughtException', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logSearchDaemonProcessError('unhandledRejection', reason);
    process.exit(1);
  });
}

function snapshotIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('snapshotId' in result)) return undefined;
  const snapshotId = (result as { snapshotId?: unknown }).snapshotId;
  return typeof snapshotId === 'string' ? snapshotId : undefined;
}

function daemonIdleMs(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_IDLE_MS, settings.search?.daemonIdleMs) ?? 6 * 60 * 60 * 1000;
}

function ownershipPollMs(env: NodeJS.ProcessEnv): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS, undefined) ?? 30_000;
}

function reapingRpcGraceMs(env: NodeJS.ProcessEnv): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_REAP_RPC_GRACE_MS, undefined) ?? 1_000;
}

function reapingTermWaitMs(env: NodeJS.ProcessEnv): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_REAP_TERM_WAIT_MS, undefined) ?? 1_000;
}

function reapingKillWaitMs(env: NodeJS.ProcessEnv): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_REAP_KILL_WAIT_MS, undefined) ?? 1_000;
}

function reapingPollMs(env: NodeJS.ProcessEnv): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_REAP_POLL_MS, undefined) ?? 50;
}

const DRAIN_DEADLINE_MS = 5_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => {
        resolve(undefined);
      }, ms);
      timer.unref();
    }),
  ]);
}

function withDeadlineSettled<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      timer.unref();
    }),
  ]);
}

function shutdownSupersessionPayload(payload: unknown): ShutdownSupersessionPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const supersession = (payload as { supersession?: unknown }).supersession;
  if (!supersession || typeof supersession !== 'object') return undefined;
  const candidate = supersession as Partial<ShutdownSupersessionPayload>;
  const predecessor = candidate.predecessor;
  if (
    typeof candidate.id !== 'string' ||
    !predecessor ||
    typeof predecessor !== 'object' ||
    !Number.isInteger(predecessor.uid) ||
    !Number.isInteger(predecessor.epoch) ||
    typeof predecessor.incarnationId !== 'string' ||
    !Number.isInteger(predecessor.pid) ||
    typeof candidate.reapedMarkerPath !== 'string' ||
    typeof candidate.startedAtMs !== 'number' ||
    !Number.isFinite(candidate.startedAtMs)
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    predecessor: {
      uid: predecessor.uid,
      epoch: predecessor.epoch,
      incarnationId: predecessor.incarnationId,
      pid: predecessor.pid,
    },
    reapedMarkerPath: candidate.reapedMarkerPath,
    startedAtMs: candidate.startedAtMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function settingNumber(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw !== undefined && raw.trim() !== '' && /^\d+$/.test(raw.trim())) return Number(raw);
  return fallback;
}

function queryRegistry(): Record<QueryDaemonRequest['method'], RegistryHandler<QueryRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    WaitReady: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Heartbeat: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Search: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Retrieve: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
  };
}

function controlRegistry(): Record<ControlDaemonRequest['method'], RegistryHandler<ControlRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    WaitReady: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Heartbeat: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    LoadVault: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Rebuild: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Refresh: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Compact: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Clear: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Prune: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Shutdown: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
  };
}

function createCapabilityDispatchServer<R>(
  registry: Record<string, RegistryHandler<R>>,
  runtime: R,
  label: string,
): CapabilityDispatchServer {
  const methods = Object.keys(registry).sort();
  return {
    methods,
    async handleRequest(request) {
      const handler = registry[request.method];
      if (!handler) throw Object.assign(new Error(`unknown ${label} method`), { code: 'BAD_REQUEST' });
      return handler(request, runtime);
    },
  };
}

function capabilityLabel(server: CapabilityDispatchServer): string {
  return server.methods.includes('Retrieve') ? 'query daemon' : 'control daemon';
}

async function handleBootRequest(
  request: RpcRequestLike,
  ownerSeed: OwnerRecord,
  getOwner: () => OwnerRecord | undefined,
  bootWaiters: Set<() => void>,
  getDaemon: () => SearchDaemon | undefined,
  bootFailed: () => boolean,
): Promise<StatusResult | HeartbeatResult> {
  validateBootRequest(request);
  const realOwner = getOwner();
  const owner = realOwner ?? ownerSeed;
  if (request.method === 'Heartbeat') {
    validateBootHeartbeatIncarnation(request, ownerSeed, realOwner);
    return heartbeatResult(owner, 'starting', 0, 0, owner.startedAt || new Date().toISOString());
  }
  if (request.method === 'Status') return emptyStatus(owner, 'starting');
  if (request.method !== 'WaitReady') {
    throw Object.assign(new Error('search daemon is starting'), { code: 'DAEMON_STARTING' });
  }
  await waitForBootReady(request.deadline, bootWaiters);
  if (bootFailed()) {
    throw Object.assign(new Error('search daemon failed before becoming ready'), { code: 'SEARCH_DAEMON_UNAVAILABLE' });
  }
  return emptyStatus(owner, getDaemon() ? 'ready' : 'starting');
}

function validateBootRequest(request: RpcRequestLike): void {
  if (request.protocolVersion !== SEARCH_DAEMON_PROTOCOL_VERSION) {
    throw Object.assign(new Error('search daemon protocol version mismatch'), { code: 'BAD_REQUEST' });
  }
  if (!Number.isFinite(request.deadline)) {
    throw Object.assign(new Error('request deadline must be a finite number'), { code: 'BAD_REQUEST' });
  }
  if (Date.now() >= request.deadline) {
    throw Object.assign(new Error('request deadline expired before admission'), { code: 'DEADLINE_EXCEEDED' });
  }
  if (request.payload === null || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
    throw Object.assign(new Error('request payload must be an object'), { code: 'BAD_REQUEST' });
  }
}

function validateHeartbeatRequest(
  request: RpcRequestLike,
  owner: OwnerRecord,
  options: { requireIncarnation: boolean },
): void {
  validateBootRequest(request);
  if (request.method !== 'Heartbeat') {
    throw Object.assign(new Error('request is not a Heartbeat'), { code: 'BAD_REQUEST' });
  }
  if (options.requireIncarnation && request.incarnation !== owner.incarnationId) {
    throw Object.assign(new Error('search daemon incarnation is stale'), { code: 'STALE_INCARNATION' });
  }
}

function validateBootHeartbeatIncarnation(
  request: RpcRequestLike,
  ownerSeed: OwnerRecord,
  owner: OwnerRecord | undefined,
): void {
  if (request.method !== 'Heartbeat') return;
  const expectedIncarnation =
    owner?.incarnationId ?? (ownerSeed.incarnationId !== 'pending' ? ownerSeed.incarnationId : undefined);
  if (expectedIncarnation !== undefined && request.incarnation !== expectedIncarnation) {
    throw Object.assign(new Error('search daemon incarnation is stale'), { code: 'STALE_INCARNATION' });
  }
}

function waitForBootReady(deadline: number, bootWaiters: Set<() => void>): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(Object.assign(new Error('wait-ready deadline expired'), { code: 'DEADLINE_EXCEEDED' }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bootWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, remainingMs);
    timer.unref();
    bootWaiters.add(finish);
  });
}

function statusBase(owner: OwnerRecord, phase: SearchDaemonPhase) {
  return {
    ok: true as const,
    ready: phase === 'ready',
    phase,
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    binaryVersion: owner.binaryVersion,
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    pid: owner.pid,
    socketPath: owner.socketPath,
    startedAt: owner.startedAt,
    owner,
  };
}

function heartbeatResult(
  owner: OwnerRecord,
  phase: SearchDaemonPhase,
  pulseSeq: number,
  progressSeq: number,
  updatedAt: string,
): HeartbeatResult {
  return {
    owner,
    phase,
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    incarnationId: owner.incarnationId,
    pulseSeq,
    progressSeq,
    updatedAt,
  };
}

function emptyStatus(owner: OwnerRecord, phase: SearchDaemonPhase): StatusResult {
  return {
    ...statusBase(owner, phase),
    metrics: {
      requests: 0,
      failures: 0,
      activeRequests: 0,
      startedAt: owner.startedAt,
    },
    pools: {},
    searchStore: {},
    profiles: {},
    concurrency: { pools: [], embedLanes: [], caches: [] },
    vaults: [],
  };
}

export function buildConcurrency(profiles: Record<string, ProfileRuntimeStatus>): DaemonConcurrencyStatus {
  const pools: DaemonPoolConcurrency[] = [];
  const embedLanes: EmbedLaneConcurrency[] = [];
  const caches: CacheConcurrency[] = [];
  let processRssBytes: number | undefined;
  for (const [profileHash, profile] of Object.entries(profiles)) {
    for (const [pool, stats] of Object.entries(profile.pools)) {
      // Worker threads share the daemon's process RSS, so a single honest reading — not a
      // per-worker sum — is the memory signal worth surfacing.
      processRssBytes ??= stats.processMemory.rss;
      pools.push({
        profileHash,
        pool,
        workers: stats.workers,
        queued: stats.queued,
        active: stats.active,
        slots: stats.slots.map((slot) => ({
          id: slot.id,
          ready: slot.ready,
          busy: slot.busy,
          ...('job' in slot && slot.job ? { job: slot.job } : {}),
        })),
      });
    }
    embedLanes.push({
      profileHash,
      runningLane: profile.embedScheduler.runningLane ?? null,
      lanes: profile.embedScheduler.lanes,
      activeLaneScopes: profile.embedScheduler.activeLaneScopes,
      querySingleFlights: profile.embedScheduler.querySingleFlights,
    });
    const searchExecution = searchExecutionCacheSummary(profile.pools.searchExecution.cache);
    caches.push({
      profileHash,
      queryAnalysis: {
        entries: profile.searchStore.queryAnalysisCache.entries,
        hits: profile.searchStore.queryAnalysisCache.hits,
        misses: profile.searchStore.queryAnalysisCache.misses,
        evictions: profile.searchStore.queryAnalysisCache.evictions,
      },
      ...(searchExecution ? { searchExecution } : {}),
    });
  }
  return { ...(processRssBytes !== undefined ? { processRssBytes } : {}), pools, embedLanes, caches };
}

export function searchExecutionCacheSummary(
  cache: SearchExecutionCacheStats[] | { error: string },
): CacheConcurrency['searchExecution'] | undefined {
  if (!Array.isArray(cache) || cache.length === 0) return undefined;
  return cache.reduce(
    (acc, slot) => ({
      entries: acc.entries + slot.entries,
      hits: acc.hits + slot.hits,
      misses: acc.misses + slot.misses,
      evictions: acc.evictions + slot.evictions,
      preloads: acc.preloads + slot.preloads,
    }),
    { entries: 0, hits: 0, misses: 0, evictions: 0, preloads: 0 },
  );
}

function incarnationOptionalMethod(method: string): boolean {
  switch (method) {
    case 'Status':
    case 'WaitReady':
      return true;
    case 'Heartbeat':
      return false;
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A bad request vault path escapes as a raw filesystem error from vaultRealpath/resolveVaultPath.
// Recode it to the semantic BAD_REQUEST class so the client fails fast: bare ENOENT is otherwise in
// the client's retryable-lifecycle set (it must be, for the "daemon socket vanished, respawn" path),
// which would retry an invalid vault for the whole deadline instead of surfacing it immediately. The
// daemon never assigns these filesystem codes itself, so this only reclassifies path-resolution
// failures, not daemon-internal lifecycle errors.
function reclassifyVaultResolutionError(error: unknown): unknown {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'BAD_REQUEST' });
  }
  return error;
}
