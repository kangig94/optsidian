import { pack, unpack } from "msgpackr";
import type {
  SearchIndexMutationResult,
  SearchIndexPruneResult,
  SearchIndexWarmResult,
  RetrieveResult,
  RetrieveOrigin,
  SearchParams,
  SearchResult
} from "../core/types.js";
import type { ExplainTrace } from "../core/search/contracts.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import type { EmbeddingInputKind, EmbeddingVector } from "../core/search/dense/index.js";
import type { LocalOnnxModelKey, OnnxExecutionProviderPreference } from "../core/search/dense/index.js";
import type { IndexAffectingSearchSettings } from "../core/search/index-settings.js";
import type { SearchRuntimeProfile } from "./runtime-profile.js";
import type {
  SearchExecutionCacheStats,
  SearchExecutionJob,
  SearchExecutionPreloadResult,
  SearchExecutionResult,
  SearchExecutionSnapshotHandle,
  SearchShardExecutionJob,
  SearchShardExecutionResult
} from "./search-execution.js";
import type { BuiltSegment, BuiltSnapshot, ParsedBuildDocument } from "./search-store/types.js";
import type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralSearchResult,
  CoralStoreStats,
  VectorStoreKey
} from "./vector-store/types.js";

export const SEARCH_DAEMON_PROTOCOL_VERSION = 4;
export const QUERY_DAEMON_METHODS = [
  "Status",
  "WaitReady",
  "Search",
  "Retrieve"
] as const;

export const CONTROL_DAEMON_METHODS = [
  "Status",
  "WaitReady",
  "LoadVault",
  "Rebuild",
  "Refresh",
  "Compact",
  "Clear",
  "Prune",
  "Shutdown"
] as const;

export const QUERY_DAEMON_CAPABILITY = "query" as const;
export const CONTROL_DAEMON_CAPABILITY = "control" as const;
export const SEARCH_DAEMON_CAPABILITIES = [QUERY_DAEMON_CAPABILITY, CONTROL_DAEMON_CAPABILITY] as const;

export const SEARCH_DAEMON_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS = 15000;
export const SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS = 1000;
export const SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS = 3000;
export const SEARCH_DAEMON_DEFAULT_EXPLAIN_DEADLINE_MS = 5000;
export const SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS = 60_000;
export const SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS = 750;
export const SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_MIB_DEADLINE_MS = 5000;
export const SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS = SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS;

export type SearchDaemonCapability = (typeof SEARCH_DAEMON_CAPABILITIES)[number];
export type QueryDaemonMethod = (typeof QUERY_DAEMON_METHODS)[number];
export type ControlDaemonMethod = (typeof CONTROL_DAEMON_METHODS)[number];
export type MutatingControlDaemonMethod = Exclude<ControlDaemonMethod, "Status" | "WaitReady">;
export type AnyDaemonMethod = QueryDaemonMethod | ControlDaemonMethod;

export type SearchDaemonErrorCode =
  | "BAD_REQUEST"
  | "SEARCH_DAEMON_UNAVAILABLE"
  | "STALE_INCARNATION"
  | "DAEMON_STARTING"
  | "DAEMON_DRAINING"
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

export type DaemonRequestBase<M extends string, P> = {
  protocolVersion: number;
  requestId: string;
  method: M;
  deadline: number;
  cancellationId?: string;
  traceId?: string;
  incarnation?: string;
  payload: P;
};

export type ProfiledPayload = {
  profile?: SearchRuntimeProfile;
};

export type WorkerWarmupResult = {
  ready?: true;
  analyzerIdentity?: SearchAnalyzerIdentity;
};

export type AnalyzeQueryWorkerPayload = {
  rawQuery: string;
  options?: import("../core/search/analysis/index.js").SearchTextAnalysisOptions;
};

export type AnalyzeQueryWorkerResult = {
  analyzerIdentity: SearchAnalyzerIdentity;
  analysis: import("../core/search/analysis/index.js").SearchTextAnalysis;
};

export type TokenizeBatchWorkerPayload = {
  texts: readonly string[];
};

export type TokenizeBatchWorkerResult = {
  analyzerIdentity: SearchAnalyzerIdentity;
  tokens: string[][];
};

export type BuildSnapshotWorkerPayload = {
  vaultRoot: string;
  partitionBits?: number;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
};

export type ParseBuildDocumentsWorkerPayload = {
  vaultRoot: string;
  relPaths: readonly string[];
  partitionBits: number;
  searchSettings: IndexAffectingSearchSettings;
};

export type ParseBuildDocumentsWorkerResult = {
  analyzerIdentity: SearchAnalyzerIdentity;
  documents: ParsedBuildDocument[];
};

export type ReduceBuildSegmentWorkerPayload = {
  partitionId: number;
  documents: readonly ParsedBuildDocument[];
};

export type ReduceBuildSegmentWorkerResult = BuiltSegment;

export type DeterministicHashModelProviderPayload = {
  kind: "deterministic-hash";
  model?: string;
  dim?: number;
  fixtures?: readonly [string, EmbeddingVector][];
};

export type LocalOnnxModelProviderPayload = {
  kind: "local-onnx";
  model?: LocalOnnxModelKey;
  executionProvider?: OnnxExecutionProviderPreference;
};

export type ModelProviderPayload = DeterministicHashModelProviderPayload | LocalOnnxModelProviderPayload;

export type ModelEncodeWorkerPayload = {
  texts: readonly string[];
  provider: ModelProviderPayload;
  inputKind?: EmbeddingInputKind;
  suppressCpuPromotion?: boolean;
};

export type ModelEncodeWorkerResult = {
  provider: {
    id: string;
    model: string;
    dim: number;
    version: string;
  };
  vectors: EmbeddingVector[];
};

export type ModelUnloadWorkerResult = {
  unloaded: true;
};

export type ModelStatsWorkerResult = {
  loaded: boolean;
};

export type VectorWorkerBasePayload = {
  key: VectorStoreKey;
  generationId: string;
  dbPath: string;
};

export type VectorUpsertWorkerPayload = VectorWorkerBasePayload & {
  spec: CoralEmbeddingSpec;
  chunks: readonly CoralChunkRecord[];
};

export type VectorBuildWorkerPayload = VectorWorkerBasePayload & {
  spec: CoralEmbeddingSpec;
  chunks?: readonly CoralChunkRecord[];
  engineName?: "auto" | string;
};

export type VectorPrewarmWorkerPayload = VectorWorkerBasePayload & {
  spec: CoralEmbeddingSpec;
  engineName?: "auto" | string;
};

export type VectorSearchActiveBuiltIndexWorkerPayload = VectorWorkerBasePayload & {
  spec: CoralEmbeddingSpec;
  queryVector: EmbeddingVector;
  candidateK: number;
};

export type VectorCloseWorkerPayload = Partial<VectorWorkerBasePayload>;

export type VectorWorkerResult = {
  ok: true;
  generationId: string;
};

export type VectorSearchActiveBuiltIndexWorkerResult = {
  generationId: string;
  results: CoralSearchResult[];
};

export type SearchDaemonWorkerJob =
  | { type: "warmup" }
  | { type: "analyzeQuery"; payload: AnalyzeQueryWorkerPayload }
  | { type: "tokenizeBatch"; payload: TokenizeBatchWorkerPayload }
  | { type: "buildSnapshot"; payload: BuildSnapshotWorkerPayload }
  | { type: "parseBuildDocuments"; payload: ParseBuildDocumentsWorkerPayload }
  | { type: "reduceBuildSegment"; payload: ReduceBuildSegmentWorkerPayload }
  | { type: "search"; payload: SearchExecutionJob }
  | { type: "searchShard"; payload: SearchShardExecutionJob }
  | { type: "preloadSnapshot"; payload: SearchExecutionSnapshotHandle }
  | { type: "searchExecutionStats" }
  | { type: "modelEncode"; payload: ModelEncodeWorkerPayload }
  | { type: "modelUnload" }
  | { type: "modelStats" }
  | { type: "vectorUpsert"; payload: VectorUpsertWorkerPayload }
  | { type: "vectorBuild"; payload: VectorBuildWorkerPayload }
  | { type: "vectorPrewarm"; payload: VectorPrewarmWorkerPayload }
  | { type: "vectorSearchActiveBuiltIndex"; payload: VectorSearchActiveBuiltIndexWorkerPayload }
  | { type: "vectorClose"; payload?: VectorCloseWorkerPayload }
  | { type: "vectorStats"; payload?: VectorCloseWorkerPayload };

export type SearchDaemonWorkerResultByType = {
  warmup: WorkerWarmupResult;
  analyzeQuery: AnalyzeQueryWorkerResult;
  tokenizeBatch: TokenizeBatchWorkerResult;
  buildSnapshot: BuiltSnapshot;
  parseBuildDocuments: ParseBuildDocumentsWorkerResult;
  reduceBuildSegment: ReduceBuildSegmentWorkerResult;
  search: SearchExecutionResult;
  searchShard: SearchShardExecutionResult;
  preloadSnapshot: SearchExecutionPreloadResult;
  searchExecutionStats: SearchExecutionCacheStats;
  modelEncode: ModelEncodeWorkerResult;
  modelUnload: ModelUnloadWorkerResult;
  modelStats: ModelStatsWorkerResult;
  vectorUpsert: VectorWorkerResult;
  vectorBuild: VectorWorkerResult;
  vectorPrewarm: VectorWorkerResult;
  vectorSearchActiveBuiltIndex: VectorSearchActiveBuiltIndexWorkerResult;
  vectorClose: VectorWorkerResult;
  vectorStats: CoralStoreStats;
};

export type SearchRequestPayload = SearchParams & ProfiledPayload & {
  vault: string;
  snapshotId?: string;
};

export type ExplainRequestPayload = SearchRequestPayload;

export type RetrieveReference = {
  path?: string;
  text?: string;
  id?: string;
};

export type RetrieveRequestPayload = SearchParams & ProfiledPayload & {
  vault: string;
  origin: RetrieveOrigin;
  text?: string;
  sourcePath?: string;
  left?: RetrieveReference;
  right?: RetrieveReference;
  topK?: number;
  minScore?: number;
  providerModel?: string;
  explain?: boolean;
  snapshotId?: string;
};

export type VaultRequestPayload = ProfiledPayload & {
  vault: string;
};

export type PruneRequestPayload = {
  unusedDays?: number;
  dryRun?: boolean;
};

export type StatusRequestPayload = Record<string, never>;

export type WaitReadyRequestPayload = Record<string, never>;

export type ShutdownRequestPayload = Record<string, never>;

export type QueryDaemonRequest =
  | DaemonRequestBase<"Status", StatusRequestPayload>
  | DaemonRequestBase<"WaitReady", WaitReadyRequestPayload>
  | DaemonRequestBase<"Search", SearchRequestPayload>
  | DaemonRequestBase<"Retrieve", RetrieveRequestPayload>;

export type ControlDaemonRequest =
  | DaemonRequestBase<"Status", StatusRequestPayload>
  | DaemonRequestBase<"WaitReady", WaitReadyRequestPayload>
  | DaemonRequestBase<"LoadVault", VaultRequestPayload>
  | DaemonRequestBase<"Rebuild", VaultRequestPayload>
  | DaemonRequestBase<"Refresh", VaultRequestPayload>
  | DaemonRequestBase<"Compact", VaultRequestPayload>
  | DaemonRequestBase<"Clear", VaultRequestPayload>
  | DaemonRequestBase<"Prune", PruneRequestPayload>
  | DaemonRequestBase<"Shutdown", ShutdownRequestPayload>;

export type DaemonRequestByCapability = {
  query: QueryDaemonRequest;
  control: ControlDaemonRequest;
};

export type TenancySlot = {
  uid: number;
  runtimeHash: string;
  protocolVersion: number;
};

export type TenancyRecord = {
  slot: TenancySlot;
  epoch: number;
  incarnationId: string;
  binaryVersion: string;
  pid: number;
  socketPath: string;
  startedAt: string;
};

export type OwnerStatus = TenancyRecord;

export type SearchDaemonPhase = "starting" | "ready" | "draining";

export type VaultState = "unloaded" | "loading" | "ready" | "updating";

export type SearchIndexProgressPhase =
  | "scanning"
  | "parsing"
  | "segmenting"
  | "embedding"
  | "vector-indexing"
  | "publishing"
  | "preloading";

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
  protocolVersion: number;
  binaryVersion: string;
  epoch: number;
  incarnationId: string;
  pid: number;
  socketPath: string;
  startedAt: string;
  owner: TenancyRecord;
  metrics: {
    requests: number;
    failures: number;
    activeRequests: number;
    startedAt: string;
  };
  pools: unknown;
  searchStore: unknown;
  profiles?: unknown;
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
  warnings?: string[];
};

export type RefreshResult = {
  ok: true;
  command: "index";
  action: "refresh";
  rebuilt: boolean;
  snapshotId?: string;
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

export type QueryDaemonResultByMethod = {
  Status: StatusResult;
  WaitReady: StatusResult;
  Search: SearchResult;
  Retrieve: RetrieveResult;
};

export type ControlDaemonResultByMethod = {
  Status: StatusResult;
  WaitReady: StatusResult;
  LoadVault: SearchIndexWarmResult;
  Rebuild: SearchIndexMutationResult;
  Refresh: RefreshResult;
  Compact: CompactResult;
  Clear: SearchIndexMutationResult;
  Prune: SearchIndexPruneResult;
  Shutdown: ShutdownResult;
};

export type DaemonResultByCapability = {
  query: QueryDaemonResultByMethod;
  control: ControlDaemonResultByMethod;
};

export type QueryDaemonResponse =
  | {
      requestId: string;
      ok: true;
      result: QueryDaemonResultByMethod[QueryDaemonMethod];
    }
  | {
      requestId: string;
      ok: false;
      error: SearchDaemonRpcError;
    };

export type ControlDaemonResponse =
  | {
      requestId: string;
      ok: true;
      result: ControlDaemonResultByMethod[ControlDaemonMethod];
    }
  | {
      requestId: string;
      ok: false;
      error: SearchDaemonRpcError;
    };

export type SearchDaemonResponse =
  | {
      requestId: string;
      ok: true;
      result: QueryDaemonResultByMethod[QueryDaemonMethod] | ControlDaemonResultByMethod[ControlDaemonMethod];
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

export function queryMethodDefaultDeadlineMs(method: QueryDaemonMethod): number {
  if (method === "Retrieve") return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
  if (method === "Status" || method === "WaitReady") return SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS;
  return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
}

export function controlMethodDefaultDeadlineMs(method: ControlDaemonMethod): number {
  if (method === "Status" || method === "WaitReady") return SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS;
  return SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS;
}

export function vaultLifecycleDeadlineMs(fileCount: number, byteCount = 0): number {
  const safeCount = Number.isFinite(fileCount) ? Math.max(0, Math.floor(fileCount)) : 0;
  const safeBytes = Number.isFinite(byteCount) ? Math.max(0, Math.floor(byteCount)) : 0;
  return SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS +
    safeCount * SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS +
    Math.ceil((safeBytes / (1024 * 1024)) * SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_MIB_DEADLINE_MS);
}

export function queryDeadlineFromNow(method: QueryDaemonMethod, deadlineMs?: number, now = Date.now()): number {
  return now + Math.max(0, deadlineMs ?? queryMethodDefaultDeadlineMs(method));
}

export function controlDeadlineFromNow(method: ControlDaemonMethod, deadlineMs?: number, now = Date.now()): number {
  return now + Math.max(0, deadlineMs ?? controlMethodDefaultDeadlineMs(method));
}

export function remainingDeadlineMs(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}

export function isQueryDaemonMethod(value: unknown): value is QueryDaemonMethod {
  return typeof value === "string" && QUERY_DAEMON_METHODS.includes(value as QueryDaemonMethod);
}

export function isControlDaemonMethod(value: unknown): value is ControlDaemonMethod {
  return typeof value === "string" && CONTROL_DAEMON_METHODS.includes(value as ControlDaemonMethod);
}

export function rpcError(code: SearchDaemonErrorCode, message: string, details?: unknown): SearchDaemonRpcError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}
