import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type {
  CompactResult,
  ControlDaemonMethod,
  ControlDaemonRequest,
  ExplainRequestPayload,
  ExplainResult,
  PruneRequestPayload,
  RefreshResult,
  QueryDaemonMethod,
  QueryDaemonRequest,
  RetrieveRequestPayload,
  SearchRequestPayload,
  ShutdownResult,
  StatusResult,
  VaultRequestPayload
} from "./protocol.js";
import {
  controlDeadlineFromNow,
  queryDeadlineFromNow,
  SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS,
  SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  vaultLifecycleDeadlineMs,
  type ControlDaemonResultByMethod,
  type QueryDaemonResultByMethod
} from "./protocol.js";
import { connectRpc, type RpcConnection } from "./transport.js";
import {
  createOwnerRecord,
  createOwnerRegistry,
  defaultSearchDaemonBinaryPath,
  desiredOwnerIdentity,
  ownerMatchesDesired,
  ownerPidIsLive,
  ownerSharesDesiredSlot,
  randomNonce,
  socketOwnershipMatches,
  socketPathsForOwner,
  SearchDaemonOwnerError,
  type DesiredOwnerIdentity,
  type OwnerRecord,
  type OwnerRegistry
} from "./owner-registry.js";
import type {
  SearchIndexMutationResult,
  SearchIndexPruneResult,
  SearchIndexWarmResult,
  RetrieveResult,
  SearchResult
} from "../core/types.js";
import { vaultRealpath, walkFiles } from "../core/path.js";
import {
  effectiveSearchRuntimeProfile,
  type SearchRuntimeProfile
} from "./runtime-profile.js";

export type SearchDaemonClient = {
  retrieve(request: RetrieveClientRequest): Promise<RetrieveResult>;
  search(request: SearchClientRequest): Promise<SearchResult & { snapshotId?: string }>;
  explain(request: ExplainClientRequest): Promise<ExplainResult>;
  status(options?: ClientRequestOptions): Promise<StatusResult>;
  loadVault(request: VaultClientRequest): Promise<SearchIndexWarmResult>;
  rebuild(request: VaultClientRequest): Promise<SearchIndexMutationResult>;
  refresh(request: VaultClientRequest): Promise<RefreshResult>;
  compact(request: VaultClientRequest): Promise<CompactResult>;
  clear(request: VaultClientRequest): Promise<SearchIndexMutationResult>;
  prune(request?: PruneClientRequest): Promise<SearchIndexPruneResult>;
  shutdown(options?: ClientRequestOptions): Promise<ShutdownResult>;
};

export type ClientRequestOptions = {
  deadlineMs?: number;
  cancellationId?: string;
  traceId?: string;
};

export type SearchClientRequest = SearchRequestPayload & ClientRequestOptions;
export type ExplainClientRequest = ExplainRequestPayload & ClientRequestOptions;
export type RetrieveClientRequest = RetrieveRequestPayload & ClientRequestOptions;
export type VaultClientRequest = VaultRequestPayload & ClientRequestOptions;
export type PruneClientRequest = PruneRequestPayload & ClientRequestOptions;

export type SearchDaemonClientOptions = {
  runtimeDir?: string;
  binaryPath?: string;
  readyTimeoutMs?: number;
  ownerLockTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  registry?: OwnerRegistry;
  runtimeProfile?: SearchRuntimeProfile;
  spawnDaemon?(record: OwnerRecord): Promise<{ pid?: number } | void> | { pid?: number } | void;
  connect?(record: OwnerRecord, capability: "query" | "control"): Promise<RpcConnection> | RpcConnection;
};

export function createSearchDaemonClient(options: SearchDaemonClientOptions = {}): SearchDaemonClient {
  const env = options.env ?? process.env;
  const binaryPath = options.binaryPath ?? defaultSearchDaemonBinaryPath(env);
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = options.registry ?? createOwnerRegistry({ runtimeDir: options.runtimeDir, env, desired });
  const runtimeProfile = options.runtimeProfile ?? effectiveSearchRuntimeProfile(process.cwd(), env);
  const readyTimeoutMs = options.readyTimeoutMs ?? SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS;
  const ownerLockTimeoutMs = options.ownerLockTimeoutMs ?? SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS;
  const connect = options.connect ?? ((owner: OwnerRecord, capability: "query" | "control" = "query") =>
    connectRpc(capability === "query" ? owner.querySocketPath : owner.controlSocketPath));
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
      if ((fs.existsSync(owner.querySocketPath) || fs.existsSync(owner.controlSocketPath)) && !socketOwnershipMatches(owner)) return false;
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
    if (!ownerSharesDesiredSlot(owner, desired)) {
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
      await requestOnce(owner, "control", "Shutdown", { nonce: owner.nonce }, { deadlineMs: 1000 });
      registry.removeOwner(owner);
    } catch (error) {
      if (isAuthError(error)) throw error;
      throw daemonUnavailable(`search daemon owner is stale or incompatible and could not be fenced: ${errorMessage(error)}`);
    }
  }

  async function spawnOwner(): Promise<OwnerRecord> {
    const intended = createOwnerRecord(
      desired,
      socketPathsForOwner(registry.runtimeDir, desired),
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
    return requestOnce(owner, "query", "Status", { nonce: owner.nonce }, { deadlineMs }) as Promise<StatusResult>;
  }

  async function requestOnce<M extends QueryDaemonMethod>(
    owner: OwnerRecord,
    capability: "query",
    method: M,
    payload: Extract<QueryDaemonRequest, { method: M }>["payload"],
    options?: ClientRequestOptions
  ): Promise<QueryDaemonResultByMethod[M]>;
  async function requestOnce<M extends ControlDaemonMethod>(
    owner: OwnerRecord,
    capability: "control",
    method: M,
    payload: Extract<ControlDaemonRequest, { method: M }>["payload"],
    options?: ClientRequestOptions
  ): Promise<ControlDaemonResultByMethod[M]>;
  async function requestOnce(
    owner: OwnerRecord,
    capability: "query" | "control",
    method: QueryDaemonMethod | ControlDaemonMethod,
    payload: QueryDaemonRequest["payload"] | ControlDaemonRequest["payload"],
    options: ClientRequestOptions = {}
  ): Promise<unknown> {
    const connection = await connect(owner, capability);
    try {
      const request = makeRpcRequest(owner, capability, method, payload, options);
      return await connection.request(request);
    } finally {
      await connection.close();
    }
  }

  async function queryReady<M extends QueryDaemonMethod>(
    method: M,
    payload: Extract<QueryDaemonRequest, { method: M }>["payload"],
    options: ClientRequestOptions = {}
  ): Promise<QueryDaemonResultByMethod[M]> {
    const owner = await ensureReady();
    try {
      return (await requestOnce(
        owner,
        "query",
        method as QueryDaemonMethod,
        payload as Extract<QueryDaemonRequest, { method: QueryDaemonMethod }>["payload"],
        options
      )) as QueryDaemonResultByMethod[M];
    } catch (error) {
      if (isAuthError(error)) registry.removeOwner(owner);
      throw error;
    }
  }

  async function controlReady<M extends ControlDaemonMethod>(
    method: M,
    payload: Extract<ControlDaemonRequest, { method: M }>["payload"],
    options: ClientRequestOptions = {}
  ): Promise<ControlDaemonResultByMethod[M]> {
    const owner = await ensureReady();
    try {
      return (await requestOnce(
        owner,
        "control",
        method as ControlDaemonMethod,
        payload as Extract<ControlDaemonRequest, { method: ControlDaemonMethod }>["payload"],
        options
      )) as ControlDaemonResultByMethod[M];
    } catch (error) {
      if (isAuthError(error)) registry.removeOwner(owner);
      throw error;
    }
  }

  return {
    retrieve(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return queryReady("Retrieve", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId });
    },
    search(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      if (payload.retrieval === "vector" || payload.retrieval === "hybrid") {
        return queryReady("Retrieve", withRuntimeProfile(searchPayloadToRetrieve(payload), runtimeProfile), { deadlineMs, cancellationId, traceId })
          .then(searchResultFromRetrieve);
      }
      return queryReady("Search", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId });
    },
    explain(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return queryReady("Retrieve", withRuntimeProfile({ ...searchPayloadToRetrieve(payload), debug: true, explain: true }, runtimeProfile), { deadlineMs, cancellationId, traceId })
        .then((result): ExplainResult => {
          if (result.status !== "ready" || !result.explainTrace) {
            throw Object.assign(new Error("explain requires a ready retrieve result with explain trace"), { code: "SEARCH_DAEMON_NOT_READY" });
          }
          return {
            ok: true,
            command: "explain",
            snapshotId: result.snapshotId,
            search: searchResultFromRetrieve(result),
            trace: result.explainTrace
          };
        });
    },
    status(options = {}) {
      return ensureReady().then((owner) => requestOnce(owner, "query", "Status", { nonce: owner.nonce }, options) as Promise<StatusResult>);
    },
    loadVault(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("LoadVault", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexWarmResult>;
    },
    rebuild(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("Rebuild", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexMutationResult>;
    },
    refresh(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("Refresh", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId }) as Promise<RefreshResult>;
    },
    compact(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("Compact", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId }) as Promise<CompactResult>;
    },
    clear(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("Clear", withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexMutationResult>;
    },
    prune(request = {}) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady("Prune", payload, { deadlineMs, cancellationId, traceId }) as Promise<SearchIndexPruneResult>;
    },
    shutdown(options = {}) {
      return ensureReady().then((owner) => requestOnce(owner, "control", "Shutdown", { nonce: owner.nonce }, options) as Promise<ShutdownResult>);
    }
  };
}

function withRuntimeProfile<T extends { profile?: SearchRuntimeProfile }>(payload: T, profile: SearchRuntimeProfile): T {
  return {
    ...payload,
    profile: payload.profile ?? profile
  };
}

function makeRpcRequest(
  owner: OwnerRecord,
  capability: "query" | "control",
  method: QueryDaemonMethod | ControlDaemonMethod,
  payload: QueryDaemonRequest["payload"] | ControlDaemonRequest["payload"],
  options: ClientRequestOptions
): QueryDaemonRequest | ControlDaemonRequest {
  const deadline = capability === "query"
    ? queryDeadlineFromNow(method as QueryDaemonMethod, requestDeadlineMs(capability, method, payload, options))
    : controlDeadlineFromNow(method as ControlDaemonMethod, requestDeadlineMs(capability, method, payload, options));
  return {
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    method,
    deadline,
    ...(options.cancellationId ? { cancellationId: options.cancellationId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    nonce: owner.nonce,
    payload
  } as QueryDaemonRequest | ControlDaemonRequest;
}

function requestDeadlineMs(
  capability: "query" | "control",
  method: QueryDaemonMethod | ControlDaemonMethod,
  payload: QueryDaemonRequest["payload"] | ControlDaemonRequest["payload"],
  options: ClientRequestOptions
): number | undefined {
  if (options.deadlineMs !== undefined) return options.deadlineMs;
  if (capability === "query" && method === "Retrieve") {
    return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
  }
  if (capability === "control" && isVaultLifecycleMethod(method as ControlDaemonMethod) && "vault" in payload && typeof payload.vault === "string") {
    const stats = vaultMarkdownStats(payload.vault);
    if (stats !== undefined) return vaultLifecycleDeadlineMs(stats.fileCount, stats.byteCount);
  }
  return undefined;
}

function isVaultLifecycleMethod(method: ControlDaemonMethod): boolean {
  return method === "LoadVault" ||
    method === "Rebuild" ||
    method === "Refresh" ||
    method === "Compact" ||
    method === "Clear";
}

function searchPayloadToRetrieve(payload: SearchRequestPayload): RetrieveRequestPayload {
  return {
    ...payload,
    origin: "text",
    text: payload.query,
    query: payload.query
  };
}

function searchResultFromRetrieve(result: RetrieveResult): SearchResult & { snapshotId?: string } {
  return {
    ok: true,
    command: "search",
    schemaVersion: 1,
    available: result.available,
    status: result.status,
    origin: result.origin,
    matches: result.matches,
    results: result.results,
    dense: result.dense,
    ...(result.status === "ready"
      ? {
          snapshotId: result.snapshotId,
          ...(result.retrievalSnapshotId ? { retrievalSnapshotId: result.retrievalSnapshotId } : {}),
          ...(result.debug ? { debug: result.debug } : {})
        }
      : {}),
    ...(result.warnings ? { warnings: result.warnings } : {})
  };
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
        OPTSIDIAN_SEARCH_DAEMON_QUERY_SOCKET: record.querySocketPath,
        OPTSIDIAN_SEARCH_DAEMON_CONTROL_SOCKET: record.controlSocketPath,
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
