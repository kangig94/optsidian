import fs from "node:fs";
import { ensurePrivateDirSync } from "../core/private-path.js";
import {
  CONTROL_DAEMON_CAPABILITY,
  QUERY_DAEMON_CAPABILITY,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type ControlDaemonRequest,
  type MutatingControlDaemonMethod,
  type OwnerStatus,
  type PublicStatusResult,
  type QueryDaemonRequest,
  type SearchIndexProgressUpdate,
  type SearchDaemonPhase,
  type DaemonRequestBase,
  type StatusResult
} from "./protocol.js";
import { createRpcServer, type RpcRequestLike, type RpcServer } from "./transport.js";
import { DaemonMetrics } from "./metrics.js";
import {
  computeBinaryVersion,
  computeRuntimeHash,
  createOwnerRecord,
  createOwnerRegistry,
  currentUid,
  defaultSearchDaemonBinaryPath,
  defaultSearchDaemonRuntimeDir,
  randomNonce,
  socketPathsForOwner,
  type DesiredOwnerIdentity,
  type OwnerRecord,
  type OwnerRegistry
} from "./owner-registry.js";
import { createRequestScheduler } from "./scheduler.js";
import { ProfileManager, type ProfileRuntime } from "./profile-manager.js";
import { readOptsidianSettings, type OptsidianSettings } from "../core/settings.js";
import { recoverRetrievalStartupState } from "./vector-store/freshness.js";
import { createEmbedScheduler, type EmbedScheduler } from "./embed-scheduler.js";

export type RunSearchDaemonOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

type QueryRuntime = SearchDaemon;
type ControlRuntime = SearchDaemon;
type RegistryHandler<R> = (request: RpcRequestLike, runtime: R) => unknown | Promise<unknown>;
type RejectMutatingKeys<T> = Extract<keyof T, MutatingControlDaemonMethod> extends never ? T : never;

export type QueryMethodRegistry<R> = Partial<{
  [M in QueryDaemonRequest["method"]]: (request: Extract<QueryDaemonRequest, { method: M }>, runtime: R) => unknown | Promise<unknown>;
}> & {
  [M in MutatingControlDaemonMethod]?: never;
};

export type ControlMethodRegistry<R> = Partial<{
  [M in ControlDaemonRequest["method"]]: (request: Extract<ControlDaemonRequest, { method: M }>, runtime: R) => unknown | Promise<unknown>;
}>;

export type CapabilityDispatchServer = {
  readonly methods: readonly string[];
  handleRequest(request: RpcRequestLike): Promise<unknown>;
};

export function createQueryServer<R, Registry extends Record<string, RegistryHandler<R>>>(
  readRegistry: RejectMutatingKeys<Registry> & Registry,
  runtime: R
): CapabilityDispatchServer {
  return createCapabilityDispatchServer(readRegistry, runtime, "query daemon");
}

export function createControlServer<R, Registry extends Record<string, RegistryHandler<R>>>(
  controlRegistry: Registry,
  runtime: R
): CapabilityDispatchServer {
  return createCapabilityDispatchServer(controlRegistry, runtime, "control daemon");
}

let searchDaemonProcessErrorHandlersInstalled = false;

export async function runSearchDaemon(options: RunSearchDaemonOptions = {}): Promise<void> {
  installSearchDaemonProcessErrorHandlers();
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  if (argv.includes("--print-info")) {
    const owner = resolveOwnerFromEnv(env);
    process.stdout.write(`${JSON.stringify({
      protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
      querySocketPath: owner.querySocketPath,
      controlSocketPath: owner.controlSocketPath,
      runtimeHash: owner.runtimeHash,
      binaryVersion: owner.binaryVersion
    })}\n`);
    return;
  }

  const daemon = await SearchDaemon.start({ env });
  await daemon.waitForShutdown();
}

type StartOptions = {
  env: NodeJS.ProcessEnv;
};

class SearchDaemon {
  private phase: SearchDaemonPhase = "starting";
  private readonly metrics = new DaemonMetrics();
  private readonly scheduler = createRequestScheduler();
  private readonly embedScheduler: EmbedScheduler;
  private readonly profiles: ProfileManager;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private readonly registry: OwnerRegistry;
  private readonly owner: OwnerRecord;
  private readonly queryRpcServer: RpcServer;
  private readonly controlRpcServer: RpcServer;
  private readonly queryServer: CapabilityDispatchServer;
  private readonly controlServer: CapabilityDispatchServer;
  private readonly idleMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly activeCancellationIds = new Map<string, string>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    registry: OwnerRegistry,
    owner: OwnerRecord,
    queryRpcServer: RpcServer,
    controlRpcServer: RpcServer,
    embedScheduler: EmbedScheduler,
    profiles: ProfileManager,
    idleMs: number,
    env: NodeJS.ProcessEnv
  ) {
    this.registry = registry;
    this.owner = owner;
    this.queryRpcServer = queryRpcServer;
    this.controlRpcServer = controlRpcServer;
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
    const owner = resolveOwnerFromEnv(options.env);
    const registry = createOwnerRegistry({
      env: options.env,
      desired: owner
    });
    ensurePrivateDirSync(registry.runtimeDir, "Optsidian search daemon runtime directory");
    removeOrphanSocket(owner.querySocketPath);
    removeOrphanSocket(owner.controlSocketPath);
    let queryRpcServer: RpcServer | undefined;
    let controlRpcServer: RpcServer | undefined;
    let embedScheduler: EmbedScheduler | undefined;
    try {
      registry.writeOwner(owner);
      const settings = readOptsidianSettings(process.cwd(), options.env);
      embedScheduler = createEmbedScheduler({ env: options.env, settings });
      const profiles = new ProfileManager(options.env, embedScheduler);

      let daemon: SearchDaemon | undefined;
      queryRpcServer = await createRpcServer({
        socketPath: owner.querySocketPath,
        capability: QUERY_DAEMON_CAPABILITY,
        handleRequest: (request) => {
          if (!daemon) {
            throw Object.assign(new Error("search daemon is not ready"), { code: "SEARCH_DAEMON_NOT_READY" });
          }
          return daemon.handleQueryRequest(request);
        },
        onConnectionClosed: (requestIds) => {
          if (!daemon) return;
          for (const requestId of requestIds) {
            daemon.cancelRequest(requestId);
          }
        }
      });
      controlRpcServer = await createRpcServer({
        socketPath: owner.controlSocketPath,
        capability: CONTROL_DAEMON_CAPABILITY,
        handleRequest: (request) => {
          if (!daemon) {
            throw Object.assign(new Error("search daemon is not ready"), { code: "SEARCH_DAEMON_NOT_READY" });
          }
          return daemon.handleControlRequest(request);
        },
        onConnectionClosed: (requestIds) => {
          if (!daemon) return;
          for (const requestId of requestIds) {
            daemon.cancelRequest(requestId);
          }
        }
      });
      daemon = new SearchDaemon(registry, owner, queryRpcServer, controlRpcServer, embedScheduler, profiles, daemonIdleMs(options.env, settings), options.env);
      daemon.initialize();
      return daemon;
    } catch (error) {
      try {
        await queryRpcServer?.close();
      } catch (cleanupError) {
        logSearchDaemonProcessError("query socket cleanup failed", cleanupError);
      }
      try {
        await controlRpcServer?.close();
      } catch (cleanupError) {
        logSearchDaemonProcessError("control socket cleanup failed", cleanupError);
      }
      try {
        removeOrphanSocket(owner.querySocketPath);
        removeOrphanSocket(owner.controlSocketPath);
      } catch (cleanupError) {
        logSearchDaemonProcessError("socket unlink cleanup failed", cleanupError);
      }
      // Release the owner slot BEFORE the slow embed-scheduler teardown, mirroring shutdown()'s
      // ordering (commit 2fe1f70). Otherwise the registry keeps advertising a dead-end owner (live
      // pid, sockets already gone) for the whole duration of embedScheduler.close(), and a client
      // arriving in that window cannot promptly spawn a fresh daemon.
      try {
        registry.removeOwner(owner);
      } catch (cleanupError) {
        logSearchDaemonProcessError("owner cleanup failed", cleanupError);
      }
      try {
        await embedScheduler?.close();
      } catch (cleanupError) {
        logSearchDaemonProcessError("embed scheduler cleanup failed", cleanupError);
      }
      throw error;
    }
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  initialize(): void {
    this.phase = "ready";
    this.armIdleTimer();
    const recovery = setTimeout(() => {
      void recoverRetrievalStartupState({ env: this.env }).catch((error: unknown) => {
        logSearchDaemonProcessError("retrieval startup recovery failed", error);
      });
    }, 0);
    recovery.unref();
  }

  private async handleQueryRequest(request: RpcRequestLike): Promise<unknown> {
    return this.handleRequest(request, this.queryServer);
  }

  private async handleControlRequest(request: RpcRequestLike): Promise<unknown> {
    return this.handleRequest(request, this.controlServer);
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
          snapshotId: isRecord(request.payload) && typeof request.payload.snapshotId === "string"
            ? request.payload.snapshotId
            : undefined
        },
        () => capabilityServer.handleRequest(request)
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.activeCancellationIds.delete(request.requestId);
      this.metrics.finishRequest(failed);
      this.armIdleTimer();
    }
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
      throw Object.assign(new Error("search daemon protocol version mismatch"), { code: "BAD_REQUEST" });
    }
    if (!capabilityServer.methods.includes(request.method)) {
      throw Object.assign(new Error(`unknown ${capabilityLabel(capabilityServer)} method`), { code: "BAD_REQUEST" });
    }
    if (!Number.isFinite(request.deadline)) {
      throw Object.assign(new Error("request deadline must be a finite number"), { code: "BAD_REQUEST" });
    }
    if (Date.now() >= request.deadline) {
      throw Object.assign(new Error("request deadline expired before admission"), { code: "DEADLINE_EXCEEDED" });
    }
    if (request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) {
      throw Object.assign(new Error("request payload must be an object"), { code: "BAD_REQUEST" });
    }
    if (request.method !== "Status" && request.nonce !== this.owner.nonce) {
      throw Object.assign(new Error("search daemon nonce authentication failed"), { code: "SEARCH_DAEMON_AUTH_FAILED" });
    }
  }

  async dispatchQuery(request: QueryDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case "Status":
        return this.status(request);
      case "Search": {
        return this.profiles.withRuntimeFor(request.payload, async (runtime) => {
          const result = await runtime.searchStore.search(request.payload, this.requestContext(request));
          if (result.status === undefined || result.status === "ready") {
            runtime.vaults.transition(request.payload.vault, "ready", { snapshotId: result.snapshotId });
            runtime.startSaveWatcherForVault(request.payload.vault);
          }
          return result;
        }, { cancellationId: this.requestCancellationId(request) });
      }
      case "Retrieve": {
        return this.profiles.withRuntimeFor(request.payload, async (runtime) => {
          const result = await runtime.searchStore.retrieve(request.payload, this.requestContext(request));
          if (result.status === "ready") {
            runtime.vaults.transition(request.payload.vault, "ready", { snapshotId: result.snapshotId });
            runtime.startSaveWatcherForVault(request.payload.vault);
          }
          return result;
        }, { cancellationId: this.requestCancellationId(request) });
      }
    }
  }

  async dispatchControl(request: ControlDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case "Status":
        return this.status(request);
      case "LoadVault": {
        return this.profiles.withRuntimeFor(request.payload, async (runtime) => {
          const progress = this.progressReporter(runtime, request.payload.vault, "loading");
          runtime.vaults.transition(request.payload.vault, "loading");
          try {
            const result = await runtime.searchStore.loadVault(request.payload.vault, this.requestContext(request, progress));
            const failed = result.vaults.find((vault) => vault.status === "failed");
            if (failed) {
              runtime.vaults.transition(request.payload.vault, "unloaded", { error: failed.error });
              runtime.stopSaveWatcherForVault(request.payload.vault);
              return result;
            }
            const readyVault = result.vaults.find((vault) => vault.status === "ready");
            const readyVaultRoot = readyVault?.vaultRoot ?? request.payload.vault;
            runtime.vaults.transition(readyVaultRoot, "ready", { snapshotId: "snapshotId" in result ? result.snapshotId : undefined });
            runtime.startSaveWatcherForVault(readyVaultRoot);
            return result;
          } catch (error) {
            runtime.vaults.transition(request.payload.vault, "unloaded", { error: errorMessage(error) });
            runtime.stopSaveWatcherForVault(request.payload.vault);
            throw error;
          }
        }, { cancellationId: this.requestCancellationId(request) });
      }
      case "Rebuild": {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) => this.updating(
            runtime,
            request.payload.vault,
            (progress) => runtime.searchStore.rebuild(request.payload.vault, this.requestContext(request, progress))
          ),
          { cancellationId: this.requestCancellationId(request) }
        );
      }
      case "Refresh": {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) => this.updating(
            runtime,
            request.payload.vault,
            (progress) => runtime.searchStore.refresh(request.payload.vault, this.requestContext(request, progress))
          ),
          { cancellationId: this.requestCancellationId(request) }
        );
      }
      case "Compact": {
        return this.profiles.withRuntimeFor(
          request.payload,
          (runtime) => this.updating(
            runtime,
            request.payload.vault,
            (progress) => runtime.searchStore.compact(request.payload.vault, this.requestContext(request, progress))
          ),
          { cancellationId: this.requestCancellationId(request) }
        );
      }
      case "Clear": {
        return this.profiles.withRuntimeFor(request.payload, async (runtime) => {
          runtime.vaults.transition(request.payload.vault, "updating");
          try {
            const result = await runtime.searchStore.clear(request.payload.vault);
            runtime.vaults.transition(request.payload.vault, "ready", { snapshotId: undefined });
            return result;
          } catch (error) {
            runtime.vaults.transition(request.payload.vault, "ready", { error: errorMessage(error) });
            throw error;
          }
        }, { cancellationId: this.requestCancellationId(request) });
      }
      case "Prune":
        return this.profiles.pruneSearchCaches(request.payload);
      case "Shutdown":
        if (request.payload.nonce !== this.owner.nonce) {
          throw Object.assign(new Error("search daemon shutdown nonce authentication failed"), {
            code: "SEARCH_DAEMON_AUTH_FAILED"
          });
        }
        setTimeout(() => {
          void this.shutdown().catch(() => {});
        }, 0).unref();
        return { ok: true, shuttingDown: true };
    }
  }

  private async updating<T>(
    runtime: ProfileRuntime,
    vault: string,
    fn: (progress: (progress: SearchIndexProgressUpdate) => void) => Promise<T>,
    snapshotId?: string
  ): Promise<T> {
    const progress = this.progressReporter(runtime, vault, "updating");
    runtime.vaults.transition(vault, "updating");
    try {
      const result = await fn(progress);
      const resultSnapshotId = snapshotId ?? snapshotIdFromResult(result);
      runtime.vaults.transition(vault, "ready", resultSnapshotId ? { snapshotId: resultSnapshotId } : {});
      runtime.startSaveWatcherForVault(vault);
      return result;
    } catch (error) {
      runtime.vaults.transition(vault, "ready", { error: errorMessage(error) });
      throw error;
    }
  }

  private async status(request: Extract<QueryDaemonRequest | ControlDaemonRequest, { method: "Status" }>): Promise<PublicStatusResult | StatusResult> {
    const publicStatus: PublicStatusResult = {
      ok: true,
      ready: this.phase === "ready",
      phase: this.phase,
      protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION
    };
    if (!this.statusAuthenticated(request)) return publicStatus;

    const context = this.requestContext(request);
    const profiles = await this.profiles.status(context);
    return {
      ...publicStatus,
      nonce: this.owner.nonce,
      owner: this.owner satisfies OwnerStatus,
      metrics: this.metrics.snapshot(),
      pools: Object.fromEntries(Object.entries(profiles).map(([hash, profile]) => [hash, profile.pools])),
      searchStore: Object.fromEntries(Object.entries(profiles).map(([hash, profile]) => [hash, profile.searchStore])),
      profiles,
      vaults: this.profiles.listVaults()
    };
  }

  private statusAuthenticated(request: Extract<QueryDaemonRequest | ControlDaemonRequest, { method: "Status" }>): boolean {
    return request.nonce === this.owner.nonce || request.payload.nonce === this.owner.nonce;
  }

  async closeForTests(): Promise<void> {
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.phase === "shutting-down") return;
    this.phase = "shutting-down";
    this.clearIdleTimer();
    // Fully relinquish the socket path — stop listening AND unlink the socket files — BEFORE
    // releasing the owner registry slot. A successor daemon only boots once `removeOwner` leaves
    // the registry empty; by then this daemon has stopped touching the socket path, so the slow
    // teardown below (profiles / embed scheduler close) can never unlink a socket that the
    // successor has since bound at the same path. Doing the unlink after a slow embed-scheduler
    // close (its previous position) let an auto-booted successor's live socket get deleted here,
    // which surfaced as a client `connect ENOENT` that never recovered before the ready deadline.
    try {
      await this.queryRpcServer.close();
    } catch {}
    try {
      await this.controlRpcServer.close();
    } catch {}
    try {
      removeOrphanSocket(this.owner.querySocketPath);
      removeOrphanSocket(this.owner.controlSocketPath);
    } catch {}
    try {
      this.registry.removeOwner(this.owner);
    } catch {}
    try {
      await this.profiles.close();
    } catch {}
    try {
      await this.embedScheduler.close();
    } catch {}
    this.resolveShutdown();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.phase !== "ready") return;
    if (this.metrics.snapshot().activeRequests > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.shutdown().catch((error: unknown) => {
        logSearchDaemonProcessError("idle shutdown failed", error);
      });
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private requestContext(request: DaemonRequestBase<string, unknown>, progress?: (progress: SearchIndexProgressUpdate) => void) {
    return {
      deadline: request.deadline,
      cancellationId: this.requestCancellationId(request),
      requestId: request.requestId,
      progress
    };
  }

  private requestCancellationId(request: DaemonRequestBase<string, unknown>): string {
    return request.cancellationId ?? request.requestId;
  }

  private progressReporter(runtime: ProfileRuntime, vault: string, state: "loading" | "updating"): (progress: SearchIndexProgressUpdate) => void {
    const startedAt = new Date().toISOString();
    return (progress) => {
      runtime.vaults.transition(vault, state, {
        progress: {
          ...progress,
          startedAt,
          updatedAt: new Date().toISOString()
        }
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
  querySocketPath: string;
  controlSocketPath: string;
} {
  const env = options.env ?? process.env;
  const owner: OwnerRecord = {
    uid: currentUid(),
    runtimeHash: "test-runtime",
    binaryVersion: "test-binary",
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    nonce: "test-nonce",
    pid: process.pid,
    querySocketPath: `/tmp/optsidian-search-daemon-test-query-${process.pid}-${Math.random().toString(16).slice(2)}.sock`,
    controlSocketPath: `/tmp/optsidian-search-daemon-test-control-${process.pid}-${Math.random().toString(16).slice(2)}.sock`,
    startedAt: new Date().toISOString()
  };
  let removed = false;
  const registry: OwnerRegistry = {
    runtimeDir: "/tmp",
    ownerPath: "/tmp/optsidian-search-daemon-test.owner",
    lockPath: "/tmp/optsidian-search-daemon-test.lock",
    readOwner: () => owner,
    writeOwner: () => undefined,
    removeOwner: () => {
      removed = true;
    },
    withControlLock: async (_deadlineMs, fn) => fn()
  };
  const queryRpcServer: RpcServer = { close: async () => undefined };
  const controlRpcServer: RpcServer = { close: async () => undefined };
  const profiles = new ProfileManager(env, options.embedScheduler);
  const daemon = new SearchDaemon(
    registry,
    owner,
    queryRpcServer,
    controlRpcServer,
    options.embedScheduler,
    profiles,
    options.idleMs,
    env
  );
  daemon.initialize();
  return {
    waitForShutdown: () => daemon.waitForShutdown(),
    close: () => daemon.closeForTests(),
    ownerRemoved: () => removed,
    querySocketPath: owner.querySocketPath,
    controlSocketPath: owner.controlSocketPath
  };
}

function resolveOwnerFromEnv(env: NodeJS.ProcessEnv): OwnerRecord {
  const runtimeDir = defaultSearchDaemonRuntimeDir(env);
  const binaryPath = defaultSearchDaemonBinaryPath(env);
  const desired: DesiredOwnerIdentity = {
    uid: env.OPTSIDIAN_SEARCH_DAEMON_UID ? Number(env.OPTSIDIAN_SEARCH_DAEMON_UID) : currentUid(),
    runtimeHash: env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH?.trim() || computeRuntimeHash(binaryPath),
    binaryVersion: env.OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION?.trim() || computeBinaryVersion(binaryPath),
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION
  };
  const sockets = {
    querySocketPath: env.OPTSIDIAN_SEARCH_DAEMON_QUERY_SOCKET?.trim() ||
      env.OPTSIDIAN_SEARCH_DAEMON_SOCKET?.trim() ||
      socketPathsForOwner(runtimeDir, desired).querySocketPath,
    controlSocketPath: env.OPTSIDIAN_SEARCH_DAEMON_CONTROL_SOCKET?.trim() ||
      socketPathsForOwner(runtimeDir, desired).controlSocketPath
  };
  return createOwnerRecord(
    desired,
    sockets,
    env.OPTSIDIAN_SEARCH_DAEMON_NONCE?.trim() || randomNonce(),
    process.pid,
    new Date().toISOString()
  );
}

function removeOrphanSocket(socketPath: string): void {
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    throw new Error(`Cannot remove stale search daemon socket at ${socketPath}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installSearchDaemonProcessErrorHandlers(): void {
  if (searchDaemonProcessErrorHandlersInstalled) return;
  searchDaemonProcessErrorHandlersInstalled = true;
  process.on("uncaughtException", (error) => {
    logSearchDaemonProcessError("uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logSearchDaemonProcessError("unhandledRejection", reason);
    process.exit(1);
  });
}

function logSearchDaemonProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error && error.stack ? error.stack : errorMessage(error);
  try {
    process.stderr.write(`[optsidian search daemon] ${kind}: ${message}\n`);
  } catch {}
}

function snapshotIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("snapshotId" in result)) return undefined;
  const snapshotId = (result as { snapshotId?: unknown }).snapshotId;
  return typeof snapshotId === "string" ? snapshotId : undefined;
}

function daemonIdleMs(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_IDLE_MS, settings.search?.daemonIdleMs) ?? 6 * 60 * 60 * 1000;
}

function settingNumber(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw !== undefined && raw.trim() !== "" && /^\d+$/.test(raw.trim())) return Number(raw);
  return fallback;
}

function queryRegistry(): Record<QueryDaemonRequest["method"], RegistryHandler<QueryRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Search: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest),
    Retrieve: (request, runtime) => runtime.dispatchQuery(request as QueryDaemonRequest)
  };
}

function controlRegistry(): Record<ControlDaemonRequest["method"], RegistryHandler<ControlRuntime>> {
  return {
    Status: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    LoadVault: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Rebuild: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Refresh: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Compact: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Clear: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Prune: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest),
    Shutdown: (request, runtime) => runtime.dispatchControl(request as ControlDaemonRequest)
  };
}

function createCapabilityDispatchServer<R>(
  registry: Record<string, RegistryHandler<R>>,
  runtime: R,
  label: string
): CapabilityDispatchServer {
  const methods = Object.keys(registry).sort();
  return {
    methods,
    async handleRequest(request) {
      const handler = registry[request.method];
      if (!handler) throw Object.assign(new Error(`unknown ${label} method`), { code: "BAD_REQUEST" });
      return handler(request, runtime);
    }
  };
}

function capabilityLabel(server: CapabilityDispatchServer): string {
  return server.methods.includes("Retrieve") ? "query daemon" : "control daemon";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
