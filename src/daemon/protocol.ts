import { pack, unpack } from "msgpackr";
import type {
  SearchIndexMutationResult,
  SearchIndexStatusResult,
  SearchIndexWarmResult,
  SearchParams,
  SearchResult
} from "../core/types.js";
import type { ExplainTrace } from "../core/search/contracts.js";

export const SEARCH_DAEMON_PROTOCOL_VERSION = 1;
export const SEARCH_DAEMON_METHODS = [
  "Search",
  "Explain",
  "Status",
  "LoadVault",
  "Rebuild",
  "Refresh",
  "Compact",
  "Clear",
  "Shutdown"
] as const;

export const SEARCH_DAEMON_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS = 15000;
export const SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS = 1000;
export const SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS = 3000;
export const SEARCH_DAEMON_DEFAULT_EXPLAIN_DEADLINE_MS = 5000;
export const SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS = 30_000;
export const SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS = 750;
export const SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS = SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS;

export type SearchDaemonMethod = (typeof SEARCH_DAEMON_METHODS)[number];

export type SearchDaemonErrorCode =
  | "BAD_REQUEST"
  | "SEARCH_DAEMON_UNAVAILABLE"
  | "SEARCH_DAEMON_AUTH_FAILED"
  | "SEARCH_DAEMON_NOT_READY"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "BACKPRESSURE"
  | "INTERNAL";

export type SearchDaemonRpcError = {
  code: SearchDaemonErrorCode;
  message: string;
  details?: unknown;
};

export type SearchDaemonRequestBase<M extends SearchDaemonMethod, P> = {
  protocolVersion: number;
  requestId: string;
  method: M;
  deadline: number;
  cancellationId?: string;
  traceId?: string;
  nonce?: string;
  payload: P;
};

export type SearchRequestPayload = SearchParams & {
  vault: string;
  snapshotId?: string;
};

export type ExplainRequestPayload = SearchRequestPayload;

export type VaultRequestPayload = {
  vault: string;
};

export type StatusRequestPayload = {
  nonce?: string;
};

export type ShutdownRequestPayload = {
  nonce: string;
};

export type SearchDaemonRequest =
  | SearchDaemonRequestBase<"Search", SearchRequestPayload>
  | SearchDaemonRequestBase<"Explain", ExplainRequestPayload>
  | SearchDaemonRequestBase<"Status", StatusRequestPayload>
  | SearchDaemonRequestBase<"LoadVault", VaultRequestPayload>
  | SearchDaemonRequestBase<"Rebuild", VaultRequestPayload>
  | SearchDaemonRequestBase<"Refresh", VaultRequestPayload>
  | SearchDaemonRequestBase<"Compact", VaultRequestPayload>
  | SearchDaemonRequestBase<"Clear", VaultRequestPayload>
  | SearchDaemonRequestBase<"Shutdown", ShutdownRequestPayload>;

export type OwnerStatus = {
  pid: number;
  uid: number;
  runtimeHash: string;
  binaryVersion: string;
  protocolVersion: number;
  nonce: string;
  socketPath: string;
  startedAt: string;
};

export type SearchDaemonPhase = "starting" | "ready" | "shutting-down";

export type VaultState = "unloaded" | "loading" | "ready" | "updating";

export type SearchIndexProgressPhase = "scanning" | "parsing" | "segmenting" | "publishing";

export type SearchIndexProgressUpdate = {
  phase: SearchIndexProgressPhase;
  total?: number;
  completed?: number;
  current?: string;
  message?: string;
};

export type SearchIndexProgress = SearchIndexProgressUpdate & {
  startedAt: string;
  updatedAt: string;
};

export type StatusResult = {
  ok: true;
  ready: boolean;
  phase: SearchDaemonPhase;
  nonce: string;
  protocolVersion: number;
  owner: OwnerStatus;
  metrics: {
    requests: number;
    failures: number;
    activeRequests: number;
    startedAt: string;
  };
  pools: unknown;
  searchStore: unknown;
  vaults: Array<{
    vault: string;
    state: VaultState;
    snapshotId?: string;
    updatedAt?: string;
    error?: string;
    progress?: SearchIndexProgress;
  }>;
};

export type ExplainResult = {
  ok: true;
  command: "explain";
  snapshotId: string;
  search: SearchResult;
  trace: ExplainTrace;
};

export type RefreshResult = {
  ok: true;
  command: "index";
  action: "refresh";
  rebuilt: boolean;
};

export type CompactResult = {
  ok: true;
  command: "index";
  action: "compact";
  rebuilt: boolean;
};

export type ShutdownResult = {
  ok: true;
  shuttingDown: true;
};

export type SearchDaemonResultByMethod = {
  Search: SearchResult & { snapshotId?: string };
  Explain: ExplainResult;
  Status: StatusResult;
  LoadVault: SearchIndexWarmResult;
  Rebuild: SearchIndexMutationResult;
  Refresh: RefreshResult;
  Compact: CompactResult;
  Clear: SearchIndexMutationResult;
  Shutdown: ShutdownResult;
};

export type SearchDaemonResponse =
  | {
      requestId: string;
      ok: true;
      result: SearchDaemonResultByMethod[SearchDaemonMethod];
    }
  | {
      requestId: string;
      ok: false;
      error: SearchDaemonRpcError;
    };

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > SEARCH_DAEMON_MAX_FRAME_BYTES) {
        throw new Error(`RPC frame exceeds ${SEARCH_DAEMON_MAX_FRAME_BYTES} bytes`);
      }
      if (this.buffer.length < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      messages.push(unpack(payload));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

export function encodeFrame(message: unknown): Buffer {
  const encoded = Buffer.from(pack(message));
  if (encoded.length > SEARCH_DAEMON_MAX_FRAME_BYTES) {
    throw new Error(`RPC frame exceeds ${SEARCH_DAEMON_MAX_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + encoded.length);
  frame.writeUInt32BE(encoded.length, 0);
  encoded.copy(frame, 4);
  return frame;
}

export function methodDefaultDeadlineMs(method: SearchDaemonMethod): number {
  if (method === "Search") return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
  if (method === "Explain") return SEARCH_DAEMON_DEFAULT_EXPLAIN_DEADLINE_MS;
  if (method === "Status") return SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS;
  return SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS;
}

export function vaultLifecycleDeadlineMs(fileCount: number): number {
  const safeCount = Number.isFinite(fileCount) ? Math.max(0, Math.floor(fileCount)) : 0;
  return SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS +
    safeCount * SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS;
}

export function deadlineFromNow(method: SearchDaemonMethod, deadlineMs?: number, now = Date.now()): number {
  return now + Math.max(0, deadlineMs ?? methodDefaultDeadlineMs(method));
}

export function remainingDeadlineMs(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}

export function isSearchDaemonMethod(value: unknown): value is SearchDaemonMethod {
  return typeof value === "string" && SEARCH_DAEMON_METHODS.includes(value as SearchDaemonMethod);
}

export function rpcError(code: SearchDaemonErrorCode, message: string, details?: unknown): SearchDaemonRpcError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}
