import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type {
  CompactResult,
  ExplainRequestPayload,
  ExplainResult,
  RefreshResult,
  SearchDaemonMethod,
  SearchDaemonRequest,
  SearchRequestPayload,
  ShutdownResult,
  StatusResult,
  VaultRequestPayload
} from "./protocol.js";
import {
  deadlineFromNow,
  SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS,
  SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  vaultLifecycleDeadlineMs,
  type SearchDaemonResultByMethod
} from "./protocol.js";
import { connectRpc, type RpcConnection } from "./transport.js";
import {
  createOwnerRecord,
  createOwnerRegistry,
  defaultSearchDaemonBinaryPath,
  desiredOwnerIdentity,
  ownerMatchesDesired,
  ownerPidIsLive,
  randomNonce,
  socketOwnershipMatches,
  socketPathForOwner,
  SearchDaemonOwnerError,
  type DesiredOwnerIdentity,
  type OwnerRecord,
  type OwnerRegistry
} from "./owner-registry.js";
import type {
  SearchIndexMutationResult,
  SearchIndexWarmResult,
  SearchResult
} from "../core/types.js";
import { vaultRealpath, walkFiles } from "../core/path.js";

export type SearchDaemonClient = {
  search(request: SearchClientRequest): Promise<SearchResult & { snapshotId?: string }>;
  explain(request: ExplainClientRequest): Promise<ExplainResult>;
  status(options?: ClientRequestOptions): Promise<StatusResult>;
  loadVault(request: VaultClientRequest): Promise<SearchIndexWarmResult>;
  rebuild(request: VaultClientRequest): Promise<SearchIndexMutationResult>;
  refresh(request: VaultClientRequest): Promise<RefreshResult>;
  compact(request: VaultClientRequest): Promise<CompactResult>;
  clear(request: VaultClientRequest): Promise<SearchIndexMutationResult>;
  shutdown(options?: ClientRequestOptions): Promise<ShutdownResult>;
};

export type ClientRequestOptions = {
  deadlineMs?: number;
  cancellationId?: string;
  traceId?: string;
};

export type SearchClientRequest = SearchRequestPayload & ClientRequestOptions;
export type ExplainClientRequest = ExplainRequestPayload & ClientRequestOptions;
export type VaultClientRequest = VaultRequestPayload & ClientRequestOptions;

export type SearchDaemonClientOptions = {
  runtimeDir?: string;
  binaryPath?: string;
  readyTimeoutMs?: number;
  ownerLockTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  registry?: OwnerRegistry;
  spawnDaemon?(record: OwnerRecord): Promise<{ pid?: number } | void> | { pid?: number } | void;
  connect?(record: OwnerRecord): Promise<RpcConnection> | RpcConnection;
};

export function createSearchDaemonClient(options: SearchDaemonClientOptions = {}): SearchDaemonClient {
  const env = options.env ?? process.env;
  const binaryPath = options.binaryPath ?? defaultSearchDaemonBinaryPath(env);
  const registry = options.registry ?? createOwnerRegistry({ runtimeDir: options.runtimeDir, env });
  const desired = desiredOwnerIdentity(binaryPath);
  const readyTimeoutMs = options.readyTimeoutMs ?? SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS;
  const ownerLockTimeoutMs = options.ownerLockTimeoutMs ?? SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS;
  const connect = options.connect ?? ((owner: OwnerRecord) => connectRpc(owner.socketPath));
  const spawnDaemon = options.spawnDaemon ?? ((record: OwnerRecord) => spawnDefaultDaemon(binaryPath, record, registry.runtimeDir, env));
  const strictOwnerChecks = options.connect === undefined;

  async function ensureReady(): Promise<OwnerRecord> {
    const current = registry.readOwner();
    if (current && await ownerCanBeUsed(current)) {
      return waitUntilReady(current);
    }

    let owner = current;
    await registry.withControlLock(ownerLockTimeoutMs, async () => {
      const locked = registry.readOwner();
      if (locked && await ownerCanBeUsed(locked)) {
        owner = locked;
        return;
      }
      if (locked) await fenceOrRemoveOwner(locked);
      owner = await spawnOwner();
    });

    if (!owner) {
      throw daemonUnavailable("search daemon could not be started or found ready");
    }
    return waitUntilReady(owner);
  }

  async function ownerCanBeUsed(owner: OwnerRecord): Promise<boolean> {
    if (!ownerMatchesDesired(owner, desired)) return false;
    if (strictOwnerChecks) {
      if (!ownerPidIsLive(owner)) return false;
      if (fs.existsSync(owner.socketPath) && !socketOwnershipMatches(owner)) return false;
    }
    try {
      const status = await statusOnce(owner, 500);
      if (status.ready && status.nonce !== owner.nonce) {
        throw new SearchDaemonOwnerError("SEARCH_DAEMON_AUTH_FAILED", "search daemon owner nonce authentication failed");
      }
      return status.nonce === undefined || status.nonce === owner.nonce;
    } catch (error) {
      if (isAuthError(error)) throw error;
      return strictOwnerChecks && ownerPidIsLive(owner);
    }
  }

  async function fenceOrRemoveOwner(owner: OwnerRecord): Promise<void> {
    if (!strictOwnerChecks) {
      registry.removeOwner(owner);
      return;
    }
    if (!ownerPidIsLive(owner)) {
      registry.removeOwner(owner);
      return;
    }
    try {
      const status = await statusOnce(owner, 500);
      if (status.nonce !== owner.nonce) {
        throw new SearchDaemonOwnerError("SEARCH_DAEMON_AUTH_FAILED", "search daemon owner nonce authentication failed");
      }
      await requestOnce(owner, "Shutdown", { nonce: owner.nonce }, { deadlineMs: 1000 });
      registry.removeOwner(owner);
    } catch (error) {
      if (isAuthError(error)) throw error;
      throw daemonUnavailable(`search daemon owner is stale or incompatible and could not be fenced: ${errorMessage(error)}`);
    }
  }

  async function spawnOwner(): Promise<OwnerRecord> {
    const intended = createOwnerRecord(
      desired,
      socketPathForOwner(registry.runtimeDir, desired),
      randomNonce(),
      0
    );
    try {
      const spawned = await spawnDaemon(intended);
      const owner = {
        ...intended,
        pid: spawned?.pid ?? intended.pid
      };
      registry.writeOwner(owner);
      return owner;
    } catch (error) {
      throw daemonUnavailable(`search daemon could not start or become ready: ${errorMessage(error)}`);
    }
  }

  async function waitUntilReady(owner: OwnerRecord): Promise<OwnerRecord> {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const status = await statusOnce(owner, Math.max(1, Math.min(500, deadline - Date.now())));
        if (status.ready) {
          if (status.nonce !== owner.nonce) {
            throw new SearchDaemonOwnerError("SEARCH_DAEMON_AUTH_FAILED", "search daemon owner nonce authentication failed");
          }
          return owner;
        }
      } catch (error) {
        if (isAuthError(error)) throw error;
        lastError = error;
      }
      await delay(50);
    }
    throw daemonUnavailable(`search daemon did not become ready before deadline${lastError ? `: ${errorMessage(lastError)}` : ""}`);
  }

  async function statusOnce(owner: OwnerRecord, deadlineMs: number): Promise<StatusResult> {
    return requestOnce(owner, "Status", { nonce: owner.nonce }, { deadlineMs }) as Promise<StatusResult>;
  }

  async function requestOnce<M extends SearchDaemonMethod>(
    owner: OwnerRecord,
    method: M,
    payload: SearchDaemonRequest["payload"],
    options: ClientRequestOptions = {}
  ): Promise<SearchDaemonResultByMethod[M]> {
    const connection = await connect(owner);
    try {
      const request = makeRpcRequest(owner, method, payload, options);
      return await connection.request(request) as SearchDaemonResultByMethod[M];
    } finally {
      await connection.close();
    }
  }

  async function requestReady<M extends SearchDaemonMethod>(
    method: M,
    payload: SearchDaemonRequest["payload"],
    options: ClientRequestOptions = {}
  ): Promise<SearchDaemonResultByMethod[M]> {
    const owner = await ensureReady();
    try {
      return await requestOnce(owner, method, payload, options);
    } catch (error) {
      if (isAuthError(error)) registry.removeOwner(owner);
      throw error;
    }
  }

  return {
    search(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Search", payload, { deadlineMs, cancellationId, traceId }) as Promise<SearchResult & { snapshotId?: string }>;
    },
    explain(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Explain", payload, { deadlineMs, cancellationId, traceId }) as Promise<ExplainResult>;
    },
    status(options = {}) {
      return ensureReady().then((owner) => requestOnce(owner, "Status", { nonce: owner.nonce }, options) as Promise<StatusResult>);
    },
    loadVault(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("LoadVault", payload, { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexWarmResult>;
    },
    rebuild(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Rebuild", payload, { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexMutationResult>;
    },
    refresh(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Refresh", payload, { deadlineMs, cancellationId, traceId }) as Promise<RefreshResult>;
    },
    compact(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Compact", payload, { deadlineMs, cancellationId, traceId }) as Promise<CompactResult>;
    },
    clear(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return requestReady("Clear", payload, { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexMutationResult>;
    },
    shutdown(options = {}) {
      return ensureReady().then((owner) => requestOnce(owner, "Shutdown", { nonce: owner.nonce }, options) as Promise<ShutdownResult>);
    }
  };
}

function makeRpcRequest(
  owner: OwnerRecord,
  method: SearchDaemonMethod,
  payload: SearchDaemonRequest["payload"],
  options: ClientRequestOptions
): SearchDaemonRequest {
  return {
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    method,
    deadline: deadlineFromNow(method, requestDeadlineMs(method, payload, options)),
    ...(options.cancellationId ? { cancellationId: options.cancellationId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    nonce: owner.nonce,
    payload
  } as SearchDaemonRequest;
}

function requestDeadlineMs(
  method: SearchDaemonMethod,
  payload: SearchDaemonRequest["payload"],
  options: ClientRequestOptions
): number | undefined {
  if (options.deadlineMs !== undefined) return options.deadlineMs;
  if ((method === "Search" || method === "Explain") && "vault" in payload && typeof payload.vault === "string") {
    const stats = vaultMarkdownStats(payload.vault);
    if (stats !== undefined) return Math.max(vaultLifecycleDeadlineMs(stats.fileCount, stats.byteCount), SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS);
  }
  if (isVaultLifecycleMethod(method) && "vault" in payload && typeof payload.vault === "string") {
    const stats = vaultMarkdownStats(payload.vault);
    if (stats !== undefined) return vaultLifecycleDeadlineMs(stats.fileCount, stats.byteCount);
  }
  return undefined;
}

function isVaultLifecycleMethod(method: SearchDaemonMethod): boolean {
  return method === "LoadVault" ||
    method === "Rebuild" ||
    method === "Refresh" ||
    method === "Compact" ||
    method === "Clear";
}

function vaultMarkdownStats(vault: string): { fileCount: number; byteCount: number } | undefined {
  try {
    const root = vaultRealpath(vault);
    const files = walkFiles(root, root, { includeHidden: false, all: false });
    let byteCount = 0;
    for (const file of files) byteCount += fs.statSync(file).size;
    return { fileCount: files.length, byteCount };
  } catch {
    return undefined;
  }
}

function spawnDefaultDaemon(
  binaryPath: string,
  record: OwnerRecord,
  runtimeDir: string,
  env: NodeJS.ProcessEnv
): Promise<{ pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["__search-daemon"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
        OPTSIDIAN_SEARCH_DAEMON_BINARY: binaryPath,
        OPTSIDIAN_SEARCH_DAEMON_UID: String(record.uid),
        OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH: record.runtimeHash,
        OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION: record.binaryVersion,
        OPTSIDIAN_SEARCH_DAEMON_SOCKET: record.socketPath,
        OPTSIDIAN_SEARCH_DAEMON_NONCE: record.nonce
      }
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

function daemonUnavailable(message: string): Error {
  const error = new Error(`${message}. Search daemon is required; direct in-process search is unavailable.`) as Error & { code?: string };
  error.code = "SEARCH_DAEMON_UNAVAILABLE";
  return error;
}

function isAuthError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "SEARCH_DAEMON_AUTH_FAILED");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
