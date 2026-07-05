import { pack, unpack } from 'msgpackr';
import type {
  SearchIndexBuildTiming,
  SearchIndexMutationResult,
  SearchIndexPruneResult,
  SearchIndexProgressPhase,
  SearchIndexWarmResult,
  RetrieveResult,
  RetrieveOrigin,
  SearchParams,
  SearchResult,
} from '../core/types.js';
import type { ExplainTrace } from '../core/search/contracts.js';
import type { SearchAnalyzerIdentity } from '../core/search/analyzer.js';
import type { EmbeddingInputKind, EmbeddingVector } from '../core/search/dense/provider.js';
import type { LocalOnnxModelKey } from '../core/search/dense/artifacts.js';
import type { OnnxExecutionPolicy, OnnxExecutionProviderPreference } from '../core/search/dense/local-onnx.js';
import type { SearchRuntimeProfile } from './runtime-profile.js';
import type { BuiltSegment, ParsedBuildDocument } from './search-store/types.js';
import type { CoralChunkRecord, CoralEmbeddingSpec, VectorStoreKey } from './vector-store/types.js';

export const SEARCH_DAEMON_PROTOCOL_VERSION = 5;

export const QUERY_DAEMON_METHODS = ['Status', 'WaitReady', 'Heartbeat', 'Search', 'Retrieve'] as const;

export const CONTROL_DAEMON_METHODS = [
  'Status',
  'WaitReady',
  'Heartbeat',
  'LoadVault',
  'Rebuild',
  'Refresh',
  'Compact',
  'Clear',
  'Prune',
  'Shutdown',
] as const;

export const SEARCH_DAEMON_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const SEARCH_DAEMON_DEFAULT_READY_TIMEOUT_MS = 15000;
export const SEARCH_DAEMON_HEARTBEAT_DEADLINE_MS = 1000;
export const SEARCH_DAEMON_PULSE_STALENESS_MS = 1000; // P = H by design
export const SEARCH_DAEMON_PULSE_TICK_MS = 250;
export const SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS = 1000; // = H (snappy liveness probe)
export const SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS = 3000;
const SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS = 60_000;
const SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS = 750;
const SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_MIB_DEADLINE_MS = 5000;
export const SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS = SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS;
export type QueryDaemonMethod = 'Status' | 'WaitReady' | 'Heartbeat' | 'Search' | 'Retrieve';
export type ControlDaemonMethod =
  | 'Status'
  | 'WaitReady'
  | 'Heartbeat'
  | 'LoadVault'
  | 'Rebuild'
  | 'Refresh'
  | 'Compact'
  | 'Clear'
  | 'Prune'
  | 'Shutdown';
export type MutatingControlDaemonMethod = Exclude<ControlDaemonMethod, 'Status' | 'WaitReady' | 'Heartbeat'>;

export type SearchDaemonErrorCode =
  | 'BAD_REQUEST'
  | 'SEARCH_DAEMON_UNAVAILABLE'
  | 'STALE_INCARNATION'
  | 'DAEMON_STARTING'
  | 'DAEMON_DRAINING'
  | 'SEARCH_DAEMON_NOT_READY'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'BACKPRESSURE'
  | 'INTERNAL';

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

type ProfiledPayload = {
  profile?: SearchRuntimeProfile;
};

export type ParseBuildDocumentsWorkerResult = {
  analyzerIdentity: SearchAnalyzerIdentity;
  documents: ParsedBuildDocument[];
};

export type ReduceBuildSegmentWorkerResult = BuiltSegment;

type DeterministicHashModelProviderPayload = {
  kind: 'deterministic-hash';
  model?: string;
  dim?: number;
  fixtures?: readonly [string, EmbeddingVector][];
};

type LocalOnnxModelProviderPayload = {
  kind: 'local-onnx';
  model?: LocalOnnxModelKey;
  executionProvider?: OnnxExecutionProviderPreference;
  executionPolicy: OnnxExecutionPolicy;
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

type VectorWorkerBasePayload = {
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
  engineName?: 'auto' | string;
};

export type VectorPrewarmWorkerPayload = VectorWorkerBasePayload & {
  spec: CoralEmbeddingSpec;
  engineName?: 'auto' | string;
};

export type VectorCloseWorkerPayload = Partial<VectorWorkerBasePayload>;

export type VectorWorkerResult = {
  ok: true;
  generationId: string;
};

export type SearchRequestPayload = SearchParams &
  ProfiledPayload & {
    vault: string;
    snapshotId?: string;
  };

export type ExplainRequestPayload = SearchRequestPayload;

type RetrieveReference = {
  path?: string;
  text?: string;
  id?: string;
};

export type RetrieveRequestPayload = SearchParams &
  ProfiledPayload & {
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

type StatusRequestPayload = Record<string, never>;

type WaitReadyRequestPayload = Record<string, never>;

type HeartbeatRequestPayload = Record<string, never>;

export type ShutdownSupersessionPayload = {
  id: string;
  predecessor: {
    uid: number;
    epoch: number;
    incarnationId: string;
    pid: number;
  };
  reapedMarkerPath: string;
  startedAtMs: number;
};

type ShutdownRequestPayload = {
  supersession?: ShutdownSupersessionPayload;
};

export type QueryDaemonRequest =
  | DaemonRequestBase<'Status', StatusRequestPayload>
  | DaemonRequestBase<'WaitReady', WaitReadyRequestPayload>
  | DaemonRequestBase<'Heartbeat', HeartbeatRequestPayload>
  | DaemonRequestBase<'Search', SearchRequestPayload>
  | DaemonRequestBase<'Retrieve', RetrieveRequestPayload>;

export type ControlDaemonRequest =
  | DaemonRequestBase<'Status', StatusRequestPayload>
  | DaemonRequestBase<'WaitReady', WaitReadyRequestPayload>
  | DaemonRequestBase<'Heartbeat', HeartbeatRequestPayload>
  | DaemonRequestBase<'LoadVault', VaultRequestPayload>
  | DaemonRequestBase<'Rebuild', VaultRequestPayload>
  | DaemonRequestBase<'Refresh', VaultRequestPayload>
  | DaemonRequestBase<'Compact', VaultRequestPayload>
  | DaemonRequestBase<'Clear', VaultRequestPayload>
  | DaemonRequestBase<'Prune', PruneRequestPayload>
  | DaemonRequestBase<'Shutdown', ShutdownRequestPayload>;

export type TenancySlot = {
  uid: number;
  runtimeHash: string;
  runtimeScopeHash?: string;
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

export type SearchDaemonPhase = 'starting' | 'ready' | 'draining';

export type VaultState = 'unloaded' | 'loading' | 'ready' | 'updating';

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

type DaemonWorkerJob = {
  type: string;
  vault?: string;
};

export type DaemonPoolConcurrency = {
  profileHash: string;
  pool: string;
  workers: number;
  queued: number;
  active: number;
  slots: Array<{ id: number; ready: boolean; busy: boolean; job?: DaemonWorkerJob }>;
};

export type EmbedLaneConcurrency = {
  profileHash: string;
  runningLane: string | null;
  lanes: Record<string, number>;
  activeLaneScopes: Record<string, number>;
  querySingleFlights: number;
};

export type CacheConcurrency = {
  profileHash: string;
  queryAnalysis: { entries: number; hits: number; misses: number; evictions: number };
  searchExecution?: { entries: number; hits: number; misses: number; evictions: number; preloads: number };
};

export type DaemonConcurrencyStatus = {
  processRssBytes?: number;
  pools: DaemonPoolConcurrency[];
  embedLanes: EmbedLaneConcurrency[];
  caches: CacheConcurrency[];
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
  concurrency: DaemonConcurrencyStatus;
  vaults: Array<{
    vault: string;
    state: VaultState;
    snapshotId?: string;
    updatedAt?: string;
    error?: string;
    progress?: SearchIndexProgress;
  }>;
};

export type HeartbeatResult = {
  owner: TenancyRecord;
  phase: SearchDaemonPhase;
  protocolVersion: number;
  incarnationId: string;
  pulseSeq: number;
  progressSeq: number;
  updatedAt: string;
};

export type ExplainResult = {
  ok: true;
  command: 'explain';
  snapshotId: string;
  search: SearchResult;
  trace: ExplainTrace;
  warnings?: string[];
};

export type RefreshResult = {
  ok: true;
  command: 'index';
  action: 'refresh';
  rebuilt: boolean;
  snapshotId?: string;
  buildTiming?: SearchIndexBuildTiming;
};

export type CompactResult = {
  ok: true;
  command: 'index';
  action: 'compact';
  rebuilt: boolean;
  buildTiming?: SearchIndexBuildTiming;
};

export type ShutdownResult = {
  ok: true;
  shuttingDown: true;
};

export type QueryDaemonResultByMethod = {
  Status: StatusResult;
  WaitReady: StatusResult;
  Heartbeat: HeartbeatResult;
  Search: SearchResult;
  Retrieve: RetrieveResult;
};

export type ControlDaemonResultByMethod = {
  Status: StatusResult;
  WaitReady: StatusResult;
  Heartbeat: HeartbeatResult;
  LoadVault: SearchIndexWarmResult;
  Rebuild: SearchIndexMutationResult;
  Refresh: RefreshResult;
  Compact: CompactResult;
  Clear: SearchIndexMutationResult;
  Prune: SearchIndexPruneResult;
  Shutdown: ShutdownResult;
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

function queryMethodDefaultDeadlineMs(method: QueryDaemonMethod): number {
  if (method === 'Retrieve') return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
  if (method === 'Status' || method === 'WaitReady') return SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS;
  if (method === 'Heartbeat') return SEARCH_DAEMON_HEARTBEAT_DEADLINE_MS;
  return SEARCH_DAEMON_DEFAULT_SEARCH_DEADLINE_MS;
}

function controlMethodDefaultDeadlineMs(method: ControlDaemonMethod): number {
  if (method === 'Status' || method === 'WaitReady') return SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS;
  if (method === 'Heartbeat') return SEARCH_DAEMON_HEARTBEAT_DEADLINE_MS;
  return SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS;
}

export function vaultLifecycleDeadlineMs(fileCount: number, byteCount = 0): number {
  const safeCount = Number.isFinite(fileCount) ? Math.max(0, Math.floor(fileCount)) : 0;
  const safeBytes = Number.isFinite(byteCount) ? Math.max(0, Math.floor(byteCount)) : 0;
  return (
    SEARCH_DAEMON_DEFAULT_LIFECYCLE_BASE_DEADLINE_MS +
    safeCount * SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_FILE_DEADLINE_MS +
    Math.ceil((safeBytes / (1024 * 1024)) * SEARCH_DAEMON_DEFAULT_LIFECYCLE_PER_MIB_DEADLINE_MS)
  );
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

export function rpcError(code: SearchDaemonErrorCode, message: string, details?: unknown): SearchDaemonRpcError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}
