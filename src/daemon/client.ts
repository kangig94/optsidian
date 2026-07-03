import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
  VaultRequestPayload,
} from './protocol.js';
import {
  controlDeadlineFromNow,
  queryDeadlineFromNow,
  SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS,
  SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  vaultLifecycleDeadlineMs,
  type ControlDaemonResultByMethod,
  type QueryDaemonResultByMethod,
} from './protocol.js';
import { connectRpc, type RpcConnection } from './transport.js';
import {
  createOwnerRecord,
  createOwnerRegistry,
  defaultSearchDaemonBinaryPath,
  desiredOwnerIdentity,
  ownerMatchesDesired,
  ownerSharesDesiredSlot,
  randomIncarnationId,
  socketPathForOwner,
  type OwnerRecord,
  type OwnerRegistry,
} from './owner-registry.js';
import type {
  SearchIndexMutationResult,
  SearchIndexPruneResult,
  SearchIndexWarmResult,
  RetrieveResult,
  SearchResult,
} from '../core/types.js';
import { vaultRealpath, walkFiles } from '../core/path.js';
import { effectiveSearchRuntimeProfile, type SearchRuntimeProfile } from './runtime-profile.js';

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

type ClientRequestOptions = {
  deadlineMs?: number;
  cancellationId?: string;
  traceId?: string;
};

type SearchClientRequest = SearchRequestPayload & ClientRequestOptions;
type ExplainClientRequest = ExplainRequestPayload & ClientRequestOptions;
type RetrieveClientRequest = RetrieveRequestPayload & ClientRequestOptions;
type VaultClientRequest = VaultRequestPayload & ClientRequestOptions;
type PruneClientRequest = PruneRequestPayload & ClientRequestOptions;

export type SearchDaemonClientOptions = {
  runtimeDir?: string;
  binaryPath?: string;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  registry?: OwnerRegistry;
  runtimeProfile?: SearchRuntimeProfile;
  spawnDaemon?(record: OwnerRecord): Promise<{ pid?: number } | void> | { pid?: number } | void;
  connect?(record: OwnerRecord): Promise<RpcConnection> | RpcConnection;
};

export function createSearchDaemonClient(options: SearchDaemonClientOptions = {}): SearchDaemonClient {
  const env = options.env ?? process.env;
  const binaryPath = options.binaryPath ?? defaultSearchDaemonBinaryPath(env);
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = options.registry ?? createOwnerRegistry({ runtimeDir: options.runtimeDir, env, desired });
  const runtimeProfile = options.runtimeProfile ?? effectiveSearchRuntimeProfile(process.cwd(), env);
  const readyTimeoutMs = options.readyTimeoutMs ?? SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS;
  const connect = options.connect ?? ((owner: OwnerRecord) => connectRpc(owner.socketPath));
  const spawnDaemon =
    options.spawnDaemon ?? ((record: OwnerRecord) => spawnDefaultDaemon(binaryPath, record, registry.runtimeDir, env));

  async function ensureReady(deadline: number): Promise<OwnerRecord> {
    let spawnedForThisPass = false;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const current = registry.readOwner();
      if (current && ownerSharesDesiredSlot(current, desired)) {
        const verdict = await ownerVerdict(current, deadline);
        if (verdict.kind === 'use') return verdict.owner;
        if (verdict.kind === 'wait') {
          lastError = verdict.error;
          await waitForRegistryChange(deadline);
          continue;
        }
        if (verdict.kind === 'replace') {
          lastError = verdict.error;
        }
      } else if (current) {
        registry.removeOwner(current);
      }

      if (!spawnedForThisPass) {
        await spawnOwner();
        spawnedForThisPass = true;
      } else {
        await waitForRegistryChange(deadline);
      }
    }
    throw daemonUnavailable(
      `search daemon did not become ready before deadline${lastError ? `: ${errorMessage(lastError)}` : ''}`,
    );
  }

  async function ownerVerdict(
    owner: OwnerRecord,
    deadline: number,
  ): Promise<
    { kind: 'use'; owner: OwnerRecord } | { kind: 'wait'; error?: unknown } | { kind: 'replace'; error?: unknown }
  > {
    if (!ownerMatchesDesired(owner, desired)) return { kind: 'replace' };
    try {
      const status = await statusOnce(owner, Math.max(1, deadline - Date.now()));
      const statusOwner = status.owner;
      if (!statusOwner || !ownerMatchesDesired(statusOwner, desired)) return { kind: 'replace' };
      if (status.phase === 'ready' && status.ready) return { kind: 'use', owner: statusOwner };
      if (status.phase === 'draining') return { kind: 'replace' };
      const ready = await waitReadyOnce(statusOwner, Math.max(1, deadline - Date.now()));
      if (ready.phase === 'ready' && ready.ready) return { kind: 'use', owner: ready.owner };
      if (ready.phase === 'draining') return { kind: 'replace' };
      return { kind: 'wait' };
    } catch (error) {
      if (isSemanticError(error)) throw error;
      if (errorCode(error) === 'DAEMON_STARTING' || errorCode(error) === 'SEARCH_DAEMON_NOT_READY') {
        return { kind: 'wait', error };
      }
      return { kind: 'replace', error };
    }
  }

  async function spawnOwner(): Promise<void> {
    const intended = createOwnerRecord(
      desired,
      socketPathForOwner(registry.runtimeDir, desired),
      0,
      randomIncarnationId(),
      process.pid,
    );
    try {
      await spawnDaemon(intended);
    } catch (error) {
      throw daemonUnavailable(`search daemon could not start or become ready: ${errorMessage(error)}`);
    }
  }

  async function statusOnce(owner: OwnerRecord, deadlineMs: number): Promise<StatusResult> {
    return requestOnce(owner, 'query', 'Status', {}, { deadlineMs });
  }

  async function waitReadyOnce(owner: OwnerRecord, deadlineMs: number): Promise<StatusResult> {
    return requestOnce(owner, 'query', 'WaitReady', {}, { deadlineMs });
  }

  async function requestOnce<M extends QueryDaemonMethod>(
    owner: OwnerRecord,
    capability: 'query',
    method: M,
    payload: Extract<QueryDaemonRequest, { method: M }>['payload'],
    options?: ClientRequestOptions,
  ): Promise<QueryDaemonResultByMethod[M]>;
  async function requestOnce<M extends ControlDaemonMethod>(
    owner: OwnerRecord,
    capability: 'control',
    method: M,
    payload: Extract<ControlDaemonRequest, { method: M }>['payload'],
    options?: ClientRequestOptions,
  ): Promise<ControlDaemonResultByMethod[M]>;
  async function requestOnce(
    owner: OwnerRecord,
    capability: 'query' | 'control',
    method: QueryDaemonMethod | ControlDaemonMethod,
    payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
    options: ClientRequestOptions = {},
  ): Promise<unknown> {
    const connection = await connect(owner);
    try {
      const request = makeRpcRequest(owner, capability, method, payload, options);
      return await connection.request(request);
    } finally {
      await connection.close();
    }
  }

  async function withDaemon<M extends QueryDaemonMethod>(
    capability: 'query',
    method: M,
    payload: Extract<QueryDaemonRequest, { method: M }>['payload'],
    options?: ClientRequestOptions,
  ): Promise<QueryDaemonResultByMethod[M]>;
  async function withDaemon<M extends ControlDaemonMethod>(
    capability: 'control',
    method: M,
    payload: Extract<ControlDaemonRequest, { method: M }>['payload'],
    options?: ClientRequestOptions,
  ): Promise<ControlDaemonResultByMethod[M]>;
  async function withDaemon(
    capability: 'query' | 'control',
    method: QueryDaemonMethod | ControlDaemonMethod,
    payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
    options: ClientRequestOptions = {},
  ): Promise<unknown> {
    const deadline = Date.now() + lifecycleDeadlineMs(capability, method, payload, options, readyTimeoutMs);
    let lastError: unknown;
    const send = requestOnce as (
      owner: OwnerRecord,
      capability: 'query' | 'control',
      method: QueryDaemonMethod | ControlDaemonMethod,
      payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
      options?: ClientRequestOptions,
    ) => Promise<unknown>;
    while (Date.now() < deadline) {
      const owner = await ensureReady(deadline);
      try {
        return await send(owner, capability, method, payload, options);
      } catch (error) {
        if (!isLifecycleError(error)) throw error;
        lastError = error;
      }
    }
    throw daemonUnavailable(
      `search daemon request did not complete before deadline${lastError ? `: ${errorMessage(lastError)}` : ''}`,
    );
  }

  async function queryReady<M extends QueryDaemonMethod>(
    method: M,
    payload: Extract<QueryDaemonRequest, { method: M }>['payload'],
    options: ClientRequestOptions = {},
  ): Promise<QueryDaemonResultByMethod[M]> {
    return (await callWithDaemon('query', method, payload, options)) as QueryDaemonResultByMethod[M];
  }

  async function controlReady<M extends ControlDaemonMethod>(
    method: M,
    payload: Extract<ControlDaemonRequest, { method: M }>['payload'],
    options: ClientRequestOptions = {},
  ): Promise<ControlDaemonResultByMethod[M]> {
    return (await callWithDaemon('control', method, payload, options)) as ControlDaemonResultByMethod[M];
  }

  const callWithDaemon = withDaemon as (
    capability: 'query' | 'control',
    method: QueryDaemonMethod | ControlDaemonMethod,
    payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
    options?: ClientRequestOptions,
  ) => Promise<unknown>;

  return {
    retrieve(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return queryReady('Retrieve', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    search(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      if (payload.retrieval === 'vector' || payload.retrieval === 'hybrid') {
        return queryReady('Retrieve', withRuntimeProfile(searchPayloadToRetrieve(payload), runtimeProfile), {
          deadlineMs,
          cancellationId,
          traceId,
        }).then(searchResultFromRetrieve);
      }
      return queryReady('Search', withRuntimeProfile(payload, runtimeProfile), { deadlineMs, cancellationId, traceId });
    },
    explain(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return queryReady(
        'Retrieve',
        withRuntimeProfile({ ...searchPayloadToRetrieve(payload), debug: true, explain: true }, runtimeProfile),
        { deadlineMs, cancellationId, traceId },
      ).then((result): ExplainResult => {
        if (result.status !== 'ready' || !result.explainTrace) {
          throw Object.assign(new Error('explain requires a ready retrieve result with explain trace'), {
            code: 'SEARCH_DAEMON_NOT_READY',
          });
        }
        return {
          ok: true,
          command: 'explain',
          snapshotId: result.snapshotId,
          search: searchResultFromRetrieve(result),
          trace: result.explainTrace,
        };
      });
    },
    status(options = {}) {
      return withDaemon('query', 'Status', {}, options);
    },
    loadVault(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('LoadVault', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    rebuild(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('Rebuild', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    refresh(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('Refresh', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    compact(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('Compact', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    clear(request) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('Clear', withRuntimeProfile(payload, runtimeProfile), {
        deadlineMs,
        cancellationId,
        traceId,
      });
    },
    prune(request = {}) {
      const { deadlineMs, cancellationId, traceId, ...payload } = request;
      return controlReady('Prune', payload, { deadlineMs, cancellationId, traceId });
    },
    shutdown(options = {}) {
      return withDaemon('control', 'Shutdown', {}, options);
    },
  };
}

function withRuntimeProfile<T extends { profile?: SearchRuntimeProfile }>(
  payload: T,
  profile: SearchRuntimeProfile,
): T {
  return {
    ...payload,
    profile: payload.profile ?? profile,
  };
}

function makeRpcRequest(
  owner: OwnerRecord,
  capability: 'query' | 'control',
  method: QueryDaemonMethod | ControlDaemonMethod,
  payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
  options: ClientRequestOptions,
): QueryDaemonRequest | ControlDaemonRequest {
  const deadline =
    capability === 'query'
      ? queryDeadlineFromNow(method as QueryDaemonMethod, requestDeadlineMs(capability, method, payload, options))
      : controlDeadlineFromNow(method as ControlDaemonMethod, requestDeadlineMs(capability, method, payload, options));
  return {
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    method,
    deadline,
    ...(options.cancellationId ? { cancellationId: options.cancellationId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...incarnationField(method, owner),
    payload,
  } as QueryDaemonRequest | ControlDaemonRequest;
}

function requestDeadlineMs(
  capability: 'query' | 'control',
  method: QueryDaemonMethod | ControlDaemonMethod,
  payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
  options: ClientRequestOptions,
): number | undefined {
  if (options.deadlineMs !== undefined) return options.deadlineMs;
  if (capability === 'query' && method === 'Retrieve') {
    return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
  }
  if (
    capability === 'control' &&
    isVaultLifecycleMethod(method as ControlDaemonMethod) &&
    'vault' in payload &&
    typeof payload.vault === 'string'
  ) {
    const stats = vaultMarkdownStats(payload.vault);
    if (stats !== undefined) return vaultLifecycleDeadlineMs(stats.fileCount, stats.byteCount);
  }
  return undefined;
}

function lifecycleDeadlineMs(
  capability: 'query' | 'control',
  method: QueryDaemonMethod | ControlDaemonMethod,
  payload: QueryDaemonRequest['payload'] | ControlDaemonRequest['payload'],
  options: ClientRequestOptions,
  readyTimeoutMs: number,
): number {
  if (options.deadlineMs !== undefined) return options.deadlineMs;
  const requestMs = requestDeadlineMs(capability, method, payload, options);
  if (requestMs !== undefined) return Math.max(requestMs, readyTimeoutMs);
  const defaultMs =
    capability === 'query'
      ? queryDeadlineFromNow(method as QueryDaemonMethod, undefined, 0)
      : controlDeadlineFromNow(method as ControlDaemonMethod, undefined, 0);
  return Math.max(defaultMs, readyTimeoutMs);
}

function incarnationField(
  method: QueryDaemonMethod | ControlDaemonMethod,
  owner: OwnerRecord,
): { incarnation?: string } {
  return method === 'Status' || method === 'WaitReady' ? {} : { incarnation: owner.incarnationId };
}

function isVaultLifecycleMethod(method: ControlDaemonMethod): boolean {
  return (
    method === 'LoadVault' || method === 'Rebuild' || method === 'Refresh' || method === 'Compact' || method === 'Clear'
  );
}

function searchPayloadToRetrieve(payload: SearchRequestPayload): RetrieveRequestPayload {
  return {
    ...payload,
    origin: 'text',
    text: payload.query,
    query: payload.query,
  };
}

function searchResultFromRetrieve(result: RetrieveResult): SearchResult & { snapshotId?: string } {
  return {
    ok: true,
    command: 'search',
    schemaVersion: 1,
    available: result.available,
    status: result.status,
    origin: result.origin,
    matches: result.matches,
    results: result.results,
    dense: result.dense,
    ...(result.status === 'ready'
      ? {
          snapshotId: result.snapshotId,
          ...(result.retrievalSnapshotId ? { retrievalSnapshotId: result.retrievalSnapshotId } : {}),
          ...(result.debug ? { debug: result.debug } : {}),
        }
      : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
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
  env: NodeJS.ProcessEnv,
): Promise<{ pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['__search-daemon'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...env,
        OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
        OPTSIDIAN_SEARCH_DAEMON_BINARY: binaryPath,
        OPTSIDIAN_SEARCH_DAEMON_UID: String(record.slot.uid),
        OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH: record.slot.runtimeHash,
        OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION: record.binaryVersion,
        OPTSIDIAN_SEARCH_DAEMON_SOCKET: record.socketPath,
      },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
  });
}

function daemonUnavailable(message: string): Error {
  const error = new Error(
    `${message}. Search daemon is required; direct in-process search is unavailable.`,
  ) as Error & { code?: string };
  error.code = 'SEARCH_DAEMON_UNAVAILABLE';
  return error;
}

function isLifecycleError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'STALE_INCARNATION' ||
    code === 'SEARCH_DAEMON_UNAVAILABLE' ||
    code === 'SEARCH_DAEMON_NOT_READY' ||
    code === 'DAEMON_STARTING' ||
    code === 'DAEMON_DRAINING' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOENT' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT'
  );
}

function isSemanticError(error: unknown): boolean {
  return errorCode(error) === 'BAD_REQUEST';
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForRegistryChange(deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
}
