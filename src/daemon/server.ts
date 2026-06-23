import fs from "node:fs";
import {
  deadlineFromNow,
  isSearchDaemonMethod,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type OwnerStatus,
  type SearchDaemonPhase,
  type SearchDaemonRequest
} from "./protocol.js";
import { createRpcServer, type RpcServer } from "./transport.js";
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
  socketPathForOwner,
  type DesiredOwnerIdentity,
  type OwnerRecord,
  type OwnerRegistry
} from "./owner-registry.js";
import { createRequestScheduler } from "./scheduler.js";
import { createDaemonSnapshotStore, DaemonSearchStoreService } from "./search-store/index.js";
import { createDaemonPools, type DaemonPools } from "./pools.js";
import { VaultRegistry } from "./vault-registry.js";
import { readOptsidianSettings, type OptsidianSettings } from "../core/settings.js";

export type RunSearchDaemonOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

export async function runSearchDaemon(options: RunSearchDaemonOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  if (argv.includes("--print-info")) {
    const owner = resolveOwnerFromEnv(env);
    process.stdout.write(`${JSON.stringify({
      protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
      socketPath: owner.socketPath,
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
  private readonly vaults = new VaultRegistry();
  private readonly scheduler = createRequestScheduler();
  private readonly searchStore: DaemonSearchStoreService;
  private readonly pools: DaemonPools;
  private readonly shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private readonly registry: OwnerRegistry;
  private readonly owner: OwnerRecord;
  private readonly server: RpcServer;
  private readonly idleMs: number;
  private idleTimer: NodeJS.Timeout | undefined;

  private constructor(
    registry: OwnerRegistry,
    owner: OwnerRecord,
    server: RpcServer,
    searchStore: DaemonSearchStoreService,
    pools: DaemonPools,
    idleMs: number
  ) {
    this.registry = registry;
    this.owner = owner;
    this.server = server;
    this.searchStore = searchStore;
    this.pools = pools;
    this.idleMs = idleMs;
    this.shutdownPromise = new Promise((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  static async start(options: StartOptions): Promise<SearchDaemon> {
    const owner = resolveOwnerFromEnv(options.env);
    const registry = createOwnerRegistry({ runtimeDir: options.env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR });
    fs.mkdirSync(registry.runtimeDir, { recursive: true, mode: 0o700 });
    removeOrphanSocket(owner.socketPath);
    registry.writeOwner(owner);
    const settings = readOptsidianSettings(process.cwd(), options.env);
    const pools = await createDaemonPools(options.env, settings);

    let daemon: SearchDaemon | undefined;
    const server = await createRpcServer({
      socketPath: owner.socketPath,
      handleRequest: (request) => {
        if (!daemon) {
          throw Object.assign(new Error("search daemon is not ready"), { code: "SEARCH_DAEMON_NOT_READY" });
        }
        return daemon.handleRequest(request);
      },
      onConnectionClosed: (requestIds) => {
        if (!daemon) return;
        for (const requestId of requestIds) {
          daemon.scheduler.cancel(requestId);
          daemon.pools.cancel(requestId);
        }
      }
    });
    const throughputIdentity = pools.throughputAnalyzer.analyzerIdentity;
    if (!throughputIdentity) throw new Error("throughput analyzer pool did not warm up");
    const snapshotStore = createDaemonSnapshotStore({
      env: options.env,
      analyzerIdentity: throughputIdentity,
      countCap: settingNumber(options.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_COUNT, settings.search?.memoryBudgetCount),
      byteCap: settingNumber(options.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_BYTES, settings.search?.memoryBudgetBytes),
      retentionCount: settingNumber(options.env.OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT, settings.search?.snapshotRetentionCount),
      snapshotBuilder: (input) => pools.throughputAnalyzer.buildSnapshot(input.vaultRoot, input.partitionBits, {
        deadline: input.deadline ?? Date.now() + 30_000,
        cancellationId: input.cancellationId ?? `${input.vaultRoot}:snapshot-build`,
        vault: input.vaultRoot
      })
    });
    const searchStore = new DaemonSearchStoreService(snapshotStore, pools.latencyAnalyzer, pools.searchExecution, {
      queryCacheSize: settingNumber(options.env.OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE, settings.search?.queryCacheSize)
    });
    daemon = new SearchDaemon(registry, owner, server, searchStore, pools, daemonIdleMs(options.env, settings));
    daemon.initialize();
    return daemon;
  }

  waitForShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  private initialize(): void {
    this.phase = "ready";
    this.armIdleTimer();
  }

  private async handleRequest(request: SearchDaemonRequest): Promise<unknown> {
    this.clearIdleTimer();
    this.metrics.beginRequest();
    let failed = false;
    try {
      this.validateRequest(request);
      return await this.scheduler.run(
        {
          deadline: request.deadline,
          cancellationId: request.cancellationId ?? request.requestId,
          snapshotId: "snapshotId" in request.payload && typeof request.payload.snapshotId === "string"
            ? request.payload.snapshotId
            : undefined
        },
        () => this.dispatch(request)
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.metrics.finishRequest(failed);
      this.armIdleTimer();
    }
  }

  private validateRequest(request: SearchDaemonRequest): void {
    if (request.protocolVersion !== SEARCH_DAEMON_PROTOCOL_VERSION) {
      throw Object.assign(new Error("search daemon protocol version mismatch"), { code: "BAD_REQUEST" });
    }
    if (!isSearchDaemonMethod(request.method)) {
      throw Object.assign(new Error("unknown search daemon method"), { code: "BAD_REQUEST" });
    }
    if (Date.now() >= request.deadline) {
      throw Object.assign(new Error("request deadline expired before admission"), { code: "DEADLINE_EXCEEDED" });
    }
    if (request.method !== "Status" && request.nonce !== this.owner.nonce) {
      throw Object.assign(new Error("search daemon nonce authentication failed"), { code: "SEARCH_DAEMON_AUTH_FAILED" });
    }
  }

  private async dispatch(request: SearchDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case "Status":
        return this.status();
      case "Search": {
        const result = await this.searchStore.search(request.payload, this.requestContext(request));
        this.vaults.transition(request.payload.vault, "ready", { snapshotId: result.snapshotId });
        return result;
      }
      case "Explain": {
        const result = await this.searchStore.explain(request.payload, this.requestContext(request));
        this.vaults.transition(request.payload.vault, "ready", { snapshotId: result.snapshotId });
        return result;
      }
      case "LoadVault":
        this.vaults.transition(request.payload.vault, "loading");
        try {
          const result = await this.searchStore.loadVault(request.payload.vault, this.requestContext(request));
          this.vaults.transition(request.payload.vault, "ready", { snapshotId: "snapshotId" in result ? result.snapshotId : undefined });
          return result;
        } catch (error) {
          this.vaults.transition(request.payload.vault, "unloaded", { error: errorMessage(error) });
          throw error;
        }
      case "Rebuild":
        return this.updating(request.payload.vault, () => this.searchStore.rebuild(request.payload.vault, this.requestContext(request)));
      case "Refresh":
        return this.updating(request.payload.vault, () => this.searchStore.refresh(request.payload.vault, this.requestContext(request)));
      case "Compact":
        return this.updating(request.payload.vault, () => this.searchStore.compact(request.payload.vault, this.requestContext(request)));
      case "Clear": {
        this.vaults.transition(request.payload.vault, "updating");
        try {
          const result = await this.searchStore.clear(request.payload.vault);
          this.vaults.transition(request.payload.vault, "ready", { snapshotId: undefined });
          return result;
        } catch (error) {
          this.vaults.transition(request.payload.vault, "ready", { error: errorMessage(error) });
          throw error;
        }
      }
      case "Shutdown":
        if (request.payload.nonce !== this.owner.nonce) {
          throw Object.assign(new Error("search daemon shutdown nonce authentication failed"), {
            code: "SEARCH_DAEMON_AUTH_FAILED"
          });
        }
        setTimeout(() => {
          void this.shutdown();
        }, 0).unref();
        return { ok: true, shuttingDown: true };
    }
  }

  private async updating<T>(vault: string, fn: () => Promise<T>, snapshotId?: string): Promise<T> {
    this.vaults.transition(vault, "updating");
    try {
      const result = await fn();
      const resultSnapshotId = snapshotId ?? snapshotIdFromResult(result);
      this.vaults.transition(vault, "ready", resultSnapshotId ? { snapshotId: resultSnapshotId } : {});
      return result;
    } catch (error) {
      this.vaults.transition(vault, "ready", { error: errorMessage(error) });
      throw error;
    }
  }

  private status() {
    return {
      ok: true,
      ready: this.phase === "ready",
      phase: this.phase,
      nonce: this.owner.nonce,
      protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
              owner: this.owner satisfies OwnerStatus,
      metrics: this.metrics.snapshot(),
      pools: this.pools.stats(),
      searchStore: this.searchStore.stats(),
      vaults: this.vaults.list()
    };
  }

  private async shutdown(): Promise<void> {
    if (this.phase === "shutting-down") return;
    this.phase = "shutting-down";
    this.clearIdleTimer();
    this.registry.removeOwner(this.owner);
    await this.server.close();
    await this.pools.close();
    removeOrphanSocket(this.owner.socketPath);
    this.resolveShutdown();
  }

  private armIdleTimer(): void {
    if (this.phase !== "ready" || this.idleMs <= 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.shutdown();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private requestContext(request: SearchDaemonRequest) {
    return {
      deadline: request.deadline,
      cancellationId: request.cancellationId ?? request.requestId,
      requestId: request.requestId
    };
  }
}

function resolveOwnerFromEnv(env: NodeJS.ProcessEnv): OwnerRecord {
  const runtimeDir = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR?.trim() || defaultSearchDaemonRuntimeDir(env);
  const binaryPath = env.OPTSIDIAN_SEARCH_DAEMON_BINARY?.trim() || defaultSearchDaemonBinaryPath(env);
  const desired: DesiredOwnerIdentity = {
    uid: env.OPTSIDIAN_SEARCH_DAEMON_UID ? Number(env.OPTSIDIAN_SEARCH_DAEMON_UID) : currentUid(),
    runtimeHash: env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH?.trim() || computeRuntimeHash(binaryPath),
    binaryVersion: env.OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION?.trim() || computeBinaryVersion(binaryPath),
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION
  };
  const socketPath = env.OPTSIDIAN_SEARCH_DAEMON_SOCKET?.trim() || socketPathForOwner(runtimeDir, desired);
  return createOwnerRecord(
    desired,
    socketPath,
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

function snapshotIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("snapshotId" in result)) return undefined;
  const snapshotId = (result as { snapshotId?: unknown }).snapshotId;
  return typeof snapshotId === "string" ? snapshotId : undefined;
}

function daemonIdleMs(env: NodeJS.ProcessEnv, settings: OptsidianSettings): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_IDLE_MS, settings.search?.daemonIdleMs) ?? 5 * 60 * 1000;
}

function settingNumber(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw !== undefined && raw.trim() !== "" && /^\d+$/.test(raw.trim())) return Number(raw);
  return fallback;
}
