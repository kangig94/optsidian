import crypto from 'node:crypto';
import fs from 'node:fs';
import { ensurePrivateDirSync } from '../core/private-path.js';
import { createProcessToken } from '../core/lifecycle/process-token.js';
import {
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type ControlDaemonRequest,
  type MutatingControlDaemonMethod,
  type QueryDaemonRequest,
  type SearchIndexProgressUpdate,
  type SearchDaemonPhase,
  type DaemonRequestBase,
  type StatusResult,
} from './protocol.js';
import { createRpcServer, type RpcRequestLike, type RpcServer } from './transport.js';
import { DaemonMetrics } from './metrics.js';
import {
  computeBinaryVersion,
  computeRuntimeHash,
  createBindBackedTenancyFenceProvider,
  createOwnerRecord,
  createOwnerRegistry,
  currentUid,
  defaultSearchDaemonBinaryPath,
  defaultSearchDaemonRuntimeDir,
  nextOwnerEpoch,
  randomIncarnationId,
  socketPathForOwner,
  type DesiredOwnerIdentity,
  type OwnerRecord,
  type OwnerRegistry,
} from './owner-registry.js';
import { createRequestScheduler } from './scheduler.js';
import { ProfileManager, type ProfileRuntime } from './profile-manager.js';
import { readOptsidianSettings, type OptsidianSettings } from '../core/settings.js';
import { recoverRetrievalStartupState } from './vector-store/freshness.js';
import { createEmbedScheduler, type EmbedScheduler } from './embed-scheduler.js';

export type RunSearchDaemonOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

type QueryRuntime = SearchDaemon;
type ControlRuntime = SearchDaemon;
type RegistryHandler<R> = (request: RpcRequestLike, runtime: R) => unknown | Promise<unknown>;
type RejectMutatingKeys<T> = Extract<keyof T, MutatingControlDaemonMethod> extends never ? T : never;

export type QueryMethodRegistry<R> = Partial<{
  [M in QueryDaemonRequest['method']]: (
    request: Extract<QueryDaemonRequest, { method: M }>,
    runtime: R,
  ) => unknown | Promise<unknown>;
}> & {
  [M in MutatingControlDaemonMethod]?: never;
};

export type ControlMethodRegistry<R> = Partial<{
  [M in ControlDaemonRequest['method']]: (
    request: Extract<ControlDaemonRequest, { method: M }>,
    runtime: R,
  ) => unknown | Promise<unknown>;
}>;

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

export function createControlServer<R>(
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
  private idleTimer: NodeJS.Timeout | undefined;

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
    this.queryServer = createQueryServer(queryRegistry(), this);
    this.controlServer = createControlServer(controlRegistry(), this);
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  static async start(options: StartOptions): Promise<SearchDaemon> {
    const ownerSeed = resolveOwnerFromEnv(options.env);
    const desired = desiredFromOwner(ownerSeed);
    const registry = createOwnerRegistry({
      env: options.env,
      desired,
    });
    ensurePrivateDirSync(registry.runtimeDir, 'Optsidian search daemon runtime directory');
    const processToken = createProcessToken();
    const claimId = crypto.randomUUID();
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
      rpcServer = await createRpcServer({
        socketPath: ownerSeed.socketPath,
        handleRequest: async (request) => {
          if (daemon) return daemon.handleRpcRequest(request);
          return handleBootRequest(
            request,
            owner ?? ownerSeed,
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
      owner = createOwnerRecord(
        desired,
        ownerSeed.socketPath,
        nextOwnerEpoch(registry),
        randomIncarnationId(),
        process.pid,
        ownerSeed.startedAt,
      );
      registry.writeOwner(owner);
      const settings = readOptsidianSettings(process.cwd(), options.env);
      embedScheduler = createEmbedScheduler({ env: options.env, settings });
      const tenancyFence = createBindBackedTenancyFenceProvider(registry, owner, claimId, processToken);
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
        removeSocketPath(ownerSeed.socketPath);
      } catch (cleanupError) {
        logSearchDaemonProcessError('socket unlink cleanup failed', cleanupError);
      }
      try {
        if (owner) registry.removeOwner(owner);
      } catch (cleanupError) {
        logSearchDaemonProcessError('owner cleanup failed', cleanupError);
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
    this.armIdleTimer();
  }

  private async handleRpcRequest(request: RpcRequestLike): Promise<unknown> {
    return this.handleRequest(request, this.dispatchServer(request));
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
      this.scheduler.cancel(cancellationId);
      this.profiles.cancel(cancellationId);
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
      case 'Shutdown':
        setTimeout(() => {
          void this.drain('draining').catch(() => {});
        }, 0).unref();
        return { ok: true, shuttingDown: true };
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

  private async drain(phase: Extract<SearchDaemonPhase, 'draining'>): Promise<void> {
    if (this.phase === 'draining') return;
    this.phase = phase;
    this.clearIdleTimer();
    this.wakeReadyWaiters();
    try {
      await this.rpcServer.relinquish();
    } catch {
      // Best-effort shutdown step.
    }
    try {
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
      await this.rpcServer.drain();
    } catch {
      // Best-effort shutdown step.
    }
    try {
      await this.profiles.close();
    } catch {
      // Best-effort shutdown step.
    }
    try {
      await this.embedScheduler.close();
    } catch {
      // Best-effort shutdown step.
    }
    this.resolveShutdown();
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
      runtime.vaults.transition(vault, state, {
        progress: {
          ...progress,
          startedAt,
          updatedAt: new Date().toISOString(),
        },
      });
    };
  }
}

export function createSearchDaemonIdleIsolationHarnessForTests(options: {
  idleMs: number;
  env?: NodeJS.ProcessEnv;
  embedScheduler: EmbedScheduler;
}): {
  waitForShutdown(): Promise<void>;
  close(): Promise<void>;
  ownerRemoved(): boolean;
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
  let removed = false;
  const registry: OwnerRegistry = {
    runtimeDir: '/tmp',
    ownerPath: '/tmp/optsidian-search-daemon-test.owner',
    readOwner: () => owner,
    writeOwner: () => undefined,
    removeOwner: () => {
      removed = true;
    },
  };
  const rpcServer: RpcServer = {
    relinquish: async () => undefined,
    drain: async () => undefined,
    close: async () => undefined,
  };
  const profiles = new ProfileManager(env, options.embedScheduler);
  const daemon = new SearchDaemon(registry, owner, rpcServer, options.embedScheduler, profiles, options.idleMs, env);
  daemon.initialize();
  return {
    waitForShutdown: () => daemon.waitForShutdown(),
    close: () => daemon.closeForTests(),
    ownerRemoved: () => removed,
    socketPath: owner.socketPath,
  };
}

function resolveOwnerFromEnv(env: NodeJS.ProcessEnv): OwnerRecord {
  const runtimeDir = defaultSearchDaemonRuntimeDir(env);
  const binaryPath = defaultSearchDaemonBinaryPath(env);
  const runtimeHash = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH?.trim();
  const binaryVersion = env.OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION?.trim();
  const socketPathOverride = env.OPTSIDIAN_SEARCH_DAEMON_SOCKET?.trim();
  const incarnation = env.OPTSIDIAN_SEARCH_DAEMON_INCARNATION?.trim();
  const desired: DesiredOwnerIdentity = {
    uid: env.OPTSIDIAN_SEARCH_DAEMON_UID ? Number(env.OPTSIDIAN_SEARCH_DAEMON_UID) : currentUid(),
    runtimeHash: runtimeHash ? runtimeHash : computeRuntimeHash(binaryPath),
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
    binaryVersion: owner.binaryVersion,
    protocolVersion: owner.slot.protocolVersion,
  };
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

function logSearchDaemonProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error && error.stack ? error.stack : errorMessage(error);
  try {
    process.stderr.write(`[optsidian search daemon] ${kind}: ${message}\n`);
  } catch {
    // Ignore stderr failures while reporting process-level errors.
  }
}

function snapshotIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('snapshotId' in result)) return undefined;
  const snapshotId = (result as { snapshotId?: unknown }).snapshotId;
  return typeof snapshotId === 'string' ? snapshotId : undefined;
}

function daemonIdleMs(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_IDLE_MS, settings.search?.daemonIdleMs) ?? 6 * 60 * 60 * 1000;
}

function settingNumber(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw !== undefined && raw.trim() !== '' && /^\d+$/.test(raw.trim())) return Number(raw);
  return fallback;
}

function queryRegistry(): Record<QueryDaemonRequest['method'], RegistryHandler<QueryRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    WaitReady: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Search: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Retrieve: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
  };
}

function controlRegistry(): Record<ControlDaemonRequest['method'], RegistryHandler<ControlRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    WaitReady: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
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
  owner: OwnerRecord,
  bootWaiters: Set<() => void>,
  getDaemon: () => SearchDaemon | undefined,
  bootFailed: () => boolean,
): Promise<StatusResult> {
  validateBootRequest(request);
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
    vaults: [],
  };
}

function incarnationOptionalMethod(method: string): boolean {
  return method === 'Status' || method === 'WaitReady';
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
