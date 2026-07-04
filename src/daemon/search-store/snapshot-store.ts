import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, writePrivateFileSync } from '../../core/private-path.js';
import {
  resolveSearchAnalyzer,
  withSearchAnalyzerLease,
  type SearchAnalyzer,
  type SearchAnalyzerIdentity,
} from '../../core/search/analyzer.js';
import { SEARCH_TOKEN_CHANNELS } from '../../core/search/analysis/channels.js';
import type { SearchTokenChannel } from '../../core/search/analysis/channels.js';
import {
  canonicalBm25GlobalStatsHash,
  corpusSnapshotIdFromManifest,
  decodeCanonicalSegment,
  canonicalValueBytes,
  partitionIdForDocument,
  reduceCanonicalBm25GlobalStats,
  snapshotIdFromManifest,
} from '../../core/search/segments/canonical.js';
import type { CanonicalBm25FieldStats, CanonicalDocumentRecord } from '../../core/search/segments/canonical.js';
import type { PositionalBm25GlobalStats } from '../../core/search/retrieval/positional/snapshot.js';
import type {
  EmbeddingSetId,
  LinkGraphId,
  LinkGraphView,
  PinnedSnapshot,
  RetrieverIdentity,
  RetrievalSnapshotId,
  SnapshotManifestView,
  SnapshotStore,
  SnapshotView,
} from '../../core/search/contracts.js';
import {
  buildEmbeddingSetFromVectors,
  deterministicHashEmbeddingRecipeIdentity,
  embeddingRecipeFreshnessId as computeEmbeddingRecipeFreshnessId,
  embeddingRecipeIdentityForProvider,
  embeddingSpaceIdForRecipe,
  vectorGenerationIdForManifest,
} from '../../core/search/dense/embedding-set.js';
import type {
  BuiltEmbeddingSet,
  EmbeddingRecipeFreshnessId,
  EmbeddingRecipeIdentity,
  EmbeddingSetDocumentInput,
  EmbeddingSetRecord,
  EmbeddingSpaceId,
} from '../../core/search/dense/embedding-set.js';
import { createLocalOnnxProviderFromConfig } from '../../core/search/dense/local-onnx.js';
import { DeterministicHashProvider } from '../../core/search/dense/provider.js';
import type {
  EmbeddingProviderIdentity,
  EmbeddingProvider,
  EmbeddingVector,
} from '../../core/search/dense/provider.js';
import { DENSE_RETRIEVER_VERSION } from '../../core/search/dense/retriever.js';
import {
  computeRetrieverPlanIdentity,
  DEFAULT_RRF_K,
  type FusionParameters,
} from '../../core/search/retrieval/fusion.js';
import {
  LINK_ADJACENCY_DIRECT_SCORE,
  LINK_ADJACENCY_RETRIEVER_VERSION,
  LINK_ADJACENCY_SCORING_VERSION,
} from '../../core/search/retrieval/link.js';
import { POSITIONAL_RETRIEVER_IDENTITY } from '../../core/search/retrieval/positional/retriever.js';
import { recordVaultAccess, recentVaultAccessRoots } from '../../core/vault-access.js';
import { vaultRelative, walkFiles } from '../../core/path.js';
import { readOptsidianSettings, searchNgramEnabled, type OptsidianSettings } from '../../core/settings.js';
import {
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings,
} from '../../core/search/index-settings.js';
import {
  SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
  type ModelProviderPayload,
  type SearchIndexProgressUpdate,
} from '../protocol.js';
import type { EmbeddingWorkerPool } from '../pools.js';
import type { EmbedSchedulerLane } from '../embed-scheduler.js';
import {
  buildCanonicalSearchSnapshot,
  DEFAULT_PARTITION_BITS,
  snapshotIdentityTuple,
  snapshotIdentityTupleForAnalyzerIdentity,
  scanBuildDocuments,
  type BuildSnapshotBase,
} from './builder.js';
import { computeBaseReuseImplementationIdentity, type BaseReuseImplementationIdentity } from './base-reuse-identity.js';
import { assertValidContentHash, safeSegmentPath } from './content-hash.js';
import {
  safeStoreFileName,
  searchStoreCachePaths,
  searchStoreLedgerRootDir,
  type SearchStoreCachePaths,
} from './cache-paths.js';
import type { SearchExecutionSnapshotHandle, SharedBytesHandle } from '../search-execution.js';
import {
  durableRename,
  fsyncDirSync,
  fsyncFileSync,
  metadataSha256,
  retrievalIdentityKey,
  type DenseEdition,
  type EditionRecord,
  type DurableRename,
} from './publication.js';
import {
  createLocalTenancyFenceProvider,
  editionCoverageFromCorpus,
  liveEditionsForGcUnder,
  SharedReclamationAuthority,
  VaultPublisher,
  VaultPublisherRegistry,
  type BuildReservation,
  type EditionCandidate,
  type VaultPublisherEffects,
  type VaultPublisherIntentResult,
  type VaultPublisherLease,
} from './publisher.js';
import {
  currentWriterTokensEqual,
  type CurrentWriterToken,
  type TenancyFenceProvider,
} from '../../core/lifecycle/conditional-commit.js';
import {
  buildLinkGraphSidecar,
  LINK_GRAPH_RESOLVER_VERSION,
  linkGraphSidecarExists,
  loadLinkGraphView,
  storeLinkGraphSidecar,
} from './link-graph.js';
import { VectorCacheCatalog, vectorStoreId } from '../vector-store/cache-catalog.js';
import { vectorGenerationDbPath, vectorStoreCachePaths } from '../vector-store/cache-paths.js';
import type { VectorStoreCachePaths } from '../vector-store/cache-paths.js';
import {
  loadVectorGenerationMetadata,
  storeVectorGenerationMetadata,
  vectorGenerationManifestHash,
} from '../vector-store/pool.js';
import type { VectorGenerationPool, ReadableVectorGenerationLease } from '../vector-store/pool.js';
import type { CoralEmbeddingSpec, VectorGenerationMetadata } from '../vector-store/types.js';
import type { CoralChunkRecord, VectorStoreKey } from '../vector-store/types.js';
import {
  SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
  type BuiltSnapshot,
  type PersistedDocumentRecord,
  type RetrievalEmbeddingSetEnvelope,
  type RetrievalSnapshotEnvelope,
  type SnapshotEnvelope,
} from './types.js';
import { SearchCacheCatalog, type SearchCachePruneOptions } from './cache-catalog.js';
import type { RetrieveDenseSignal, SearchIndexPruneResult } from '../../core/types.js';

export type DaemonSnapshotStoreOptions = {
  env?: NodeJS.ProcessEnv;
  countCap?: number;
  byteCap?: number;
  retentionCount?: number;
  profileHash?: string;
  analyzer?: SearchAnalyzer;
  analyzerIdentity?: SearchAnalyzerIdentity;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  snapshotBuilder?: (input: SnapshotBuilderInput) => Promise<BuiltSnapshot>;
  partitionBits?: number;
  cacheCatalog?: SearchCacheCatalog;
  durableRenameSegment?: DurableRename;
  durableRenameManifest?: DurableRename;
  durableRenameLinkGraph?: DurableRename;
  vectorPool?: VectorGenerationPool;
  embeddingSetBuilder?: RetrievalEmbeddingSetBuilder;
  lexicalIdentityHash?: string;
  publisherRegistry?: VaultPublisherRegistry;
  reclamationAuthority?: SharedReclamationAuthority;
  tenancyFence?: TenancyFenceProvider & { writerToken?: CurrentWriterToken };
  publisherLaneCancellation?: {
    cancelSnapshotEffects?(cancellationId: string): void;
    cancelEmbedScheduler?(cancellationId: string): void;
    cancelWorkerPools?(cancellationId: string): void;
  };
};

export type LoadVaultResult = {
  ok: true;
  command: 'index';
  action: 'warm';
  vaults: Array<{ vaultRoot: string; status: 'ready' | 'failed'; error?: string }>;
  snapshotId?: string;
};

export type SnapshotMutationResult = {
  ok: true;
  command: 'index';
  action: 'rebuild' | 'clear';
  snapshotId?: string;
};

export type SnapshotRequestContext = {
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
  embeddingLane?: EmbedSchedulerLane;
};

export type SnapshotDirtyMark = {
  docId: string;
  path: string;
  contentHash?: string;
};

export type SnapshotDirtyFoldResult = {
  requested: number;
  folded: RetrievalEmbeddingBuildFoldResult[];
  skipped: SnapshotDirtyMark[];
};

type SnapshotBuilderInput = {
  vaultRoot: string;
  partitionBits: number;
  searchSettings: IndexAffectingSearchSettings;
  base?: BuildSnapshotBase;
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

type PublishFreshSnapshotOptions = {
  intentKind?: 'rebuild' | 'refresh' | 'save';
  prepareRetrieval?: boolean;
  awaitDense?: boolean;
  useActiveBase?: boolean;
  base?: BuildSnapshotBase;
  incrementalFallbackReason?: string;
};

type ReusableBaseCandidate = { ok: true; base: BuildSnapshotBase } | { ok: false; reason: string };

type RetrievalEmbeddingSetBuilderInput = {
  vaultRoot: string;
  documents: readonly EmbeddingSetDocumentInput[];
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
  embeddingLane?: EmbedSchedulerLane;
};

type RetrievalEmbeddingBuildLane = Exclude<EmbedSchedulerLane, 'query'>;

type RetrievalEmbeddingBuildFoldResult = {
  target: 'current' | 'next';
  lane: RetrievalEmbeddingBuildLane;
  reason: 'queued' | 'in-flight' | 'embedded' | 'not-active';
  pendingCount: number;
};

export type RetrievalEmbeddingSetBuilder = {
  readonly providerIdentity: EmbeddingProviderIdentity;
  readonly recipeIdentity?: EmbeddingRecipeIdentity;
  build(input: RetrievalEmbeddingSetBuilderInput): Promise<BuiltEmbeddingSet>;
  foldQueuedDocument?(
    lane: RetrievalEmbeddingBuildLane,
    document: EmbeddingSetDocumentInput,
  ): RetrievalEmbeddingBuildFoldResult;
  drainNextIncrementalDocuments?(lane: RetrievalEmbeddingBuildLane): EmbeddingSetDocumentInput[];
};

type ScheduledEmbeddingEncoder = {
  encode(
    payload: Parameters<EmbeddingWorkerPool['encode']>[0],
    options: Parameters<EmbeddingWorkerPool['encode']>[1],
    lane?: EmbedSchedulerLane,
  ): ReturnType<EmbeddingWorkerPool['encode']>;
  withLaneScope?<T>(lane: EmbedSchedulerLane, fn: () => Promise<T>): Promise<T>;
};

type RetrievalSnapshotSource = Pick<
  BuiltSnapshot,
  'snapshotId' | 'corpusSnapshotId' | 'identityTuple' | 'documents' | 'linkGraphId'
>;

type RetrievalSnapshotPublication = {
  envelope: RetrievalSnapshotEnvelope;
  vectorPaths: VectorStoreCachePaths;
  dense: Extract<DenseEdition, { state: 'fresh' }>;
  // Held from before the generation dir becomes sweeper-visible until the naming edition commits, so
  // a concurrent cross-ledger sweep cannot reclaim a built-but-uncommitted generation. The consumer
  // that commits the edition releases it (on success or failure).
  reservation?: BuildReservation;
};

type DenseUnavailableResult = {
  status: 'unavailable' | 'unreadable' | 'space-mismatch';
  reason: string;
  usability: DenseUsability;
  signal: DenseSignal;
};

type DenseGenerationAttachCandidate = {
  retrieval: RetrievalSnapshotEnvelope;
  vectorPaths: VectorStoreCachePaths;
  metadata: VectorGenerationMetadata;
  gcPin: DenseGenerationPin['gcPin'];
};

type DenseGenerationAttachCandidateResult =
  { status: 'ready'; candidate: DenseGenerationAttachCandidate } | DenseUnavailableResult;

type SnapshotContentDelta = {
  added: string[];
  modified: string[];
  deleted: string[];
  changedCount: number;
};

type LoadedSnapshot = {
  vaultRoot: string;
  vaultKey: string;
  snapshotId: string;
  envelope: SnapshotEnvelope;
  view: SnapshotView;
  linkGraph: LinkGraphView;
  documentsByDocumentId: Map<string, PersistedDocumentRecord>;
  documentBytes: Uint8Array;
  segmentBytes: Map<string, Uint8Array>;
  bm25Stats: PositionalBm25GlobalStats;
  byteLength: number;
  refCount: number;
  pinTokens: Set<string>;
  lastAccessMs: number;
};

export type PinnedRetrievalSnapshot = PinnedSnapshot & {
  retrievalSnapshotId: RetrievalSnapshotId;
  corpusSnapshotId: string;
  linkGraphId: LinkGraphId;
  embeddingSetId: EmbeddingSetId;
  embeddingSpaceId: EmbeddingSpaceId;
  embeddingRecipeFreshnessId: EmbeddingRecipeFreshnessId;
  retrieverPlanIdentity: string;
  rankingFeatureVersion: string;
  embeddingSet: RetrievalEmbeddingSetEnvelope;
  vector: RetrievalSnapshotEnvelope['vector'];
  vectorKey: VectorStoreKey;
};

type RetrievalPinNotReadyReason =
  | 'no-active-retrieval-snapshot'
  | 'retrieval-envelope-missing'
  | 'retrieval-state-dirty'
  | 'retrieval-state-building'
  | 'retrieval-state-failed'
  | 'retrieval-state-stale'
  | 'corpus-missing'
  | 'link-graph-missing'
  | 'vector-active-spec-missing'
  | 'vector-active-spec-mismatched'
  | 'embedding-set-mismatched'
  | 'retrieval-snapshot-mismatched';

export type RetrievalPinResult =
  { status: 'ready'; pin: PinnedRetrievalSnapshot } | { status: 'index-not-ready'; reason: RetrievalPinNotReadyReason };

export type DenseSignal = RetrieveDenseSignal;

type DenseUsability = {
  spaceMatch: boolean;
  usableDocumentIds: ReadonlySet<string>;
  pendingDocumentIds: ReadonlySet<string>;
};

type PinnedLexicalReadPin = PinnedSnapshot & {
  corpusSnapshotId: string;
  linkGraphId: LinkGraphId;
};

export type DenseGenerationPin = {
  retrieval: RetrievalSnapshotEnvelope;
  embeddingSet: RetrievalEmbeddingSetEnvelope;
  recordsByDocumentId: ReadonlyMap<string, RetrievalEmbeddingSetEnvelope['records'][number]>;
  embeddingSpaceId: EmbeddingSpaceId;
  vectorGeneration: VectorGenerationMetadata;
  vectorKey: VectorStoreKey;
  vectorLease: ReadableVectorGenerationLease;
  gcPin: {
    vectorKey: VectorStoreKey;
    generationId: string;
  };
};

export type PinnedRetrievalReadContext = {
  lexicalPin: PinnedLexicalReadPin;
  liveDocuments: ReadonlyMap<string, PersistedDocumentRecord>;
  liveContentHashes: ReadonlyMap<string, string>;
  desiredEmbeddingSpace?: EmbeddingSpaceId;
  densePin?: DenseGenerationPin;
  denseUsability: DenseUsability;
  denseSignal: DenseSignal;
};

export type LexicalReadContextResult =
  | { status: 'ready'; readContext: PinnedRetrievalReadContext }
  | { status: 'index-not-ready'; reason: 'lexical-snapshot-unavailable' };

export type DenseAttachmentResult =
  | { status: 'attached'; densePin: DenseGenerationPin; usability: DenseUsability; signal: DenseSignal }
  | {
      status: 'unavailable' | 'unreadable' | 'space-mismatch';
      reason: string;
      usability: DenseUsability;
      signal: DenseSignal;
    };

type GcRoots = {
  snapshotIds: Set<string>;
  segmentHashes: Set<string>;
  linkGraphIds: Set<LinkGraphId>;
  retrievalSnapshotIds: Set<RetrievalSnapshotId>;
  vectorGenerationKeys: Set<string>;
};

type InFlightSearchArtifactRoots = {
  snapshotIds: Map<string, number>;
  segmentHashes: Map<string, number>;
  linkGraphIds: Map<LinkGraphId, number>;
  retrievalSnapshotIds: Map<RetrievalSnapshotId, number>;
};

type SearchArtifactGcReservation = {
  release(): void;
};

const DEFAULT_COUNT_CAP = 8;
const DEFAULT_BYTE_CAP = 128 * 1024 * 1024;
const DEFAULT_RETENTION_COUNT = 8;
const TMP_STALE_MS = 5 * 60 * 1000;
const EMBEDDING_DOCUMENT_SLICE_SIZE = 32;
const BACKGROUND_EMBEDDING_BUILD_LANES: readonly RetrievalEmbeddingBuildLane[] = ['save', 'refresh', 'rebuild'];

export class DaemonSnapshotStore implements SnapshotStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly countCap: number;
  private readonly byteCap: number;
  private readonly retentionCount: number;
  private readonly profileHash: string;
  private readonly lexicalIdentityHash: string;
  private readonly partitionBits: number;
  private readonly analyzer: SearchAnalyzer | undefined;
  private readonly analyzerIdentity: SearchAnalyzerIdentity;
  private readonly baseReuseImplementationIdentity: BaseReuseImplementationIdentity;
  private readonly searchSettings: IndexAffectingSearchSettings;
  private readonly snapshotBuilder: ((input: SnapshotBuilderInput) => Promise<BuiltSnapshot>) | undefined;
  private readonly cacheCatalog: SearchCacheCatalog;
  private readonly renameSegment: DurableRename;
  private readonly renameManifest: DurableRename;
  private readonly renameLinkGraph: DurableRename;
  private readonly vectorPool: VectorGenerationPool | undefined;
  private readonly embeddingSetBuilder: RetrievalEmbeddingSetBuilder;
  private readonly publisherRegistry: VaultPublisherRegistry;
  private readonly reclamationAuthority: SharedReclamationAuthority;
  private readonly tenancyFence: TenancyFenceProvider & { writerToken?: CurrentWriterToken };
  private readonly publisherLaneCancellation: NonNullable<DaemonSnapshotStoreOptions['publisherLaneCancellation']>;
  private readonly loaded = new Map<string, LoadedSnapshot>();
  private readonly activeByVault = new Map<string, string>();
  private readonly queuedGcVaults = new Set<string>();
  private readonly gcChains = new Map<string, Promise<void>>();
  private readonly gcImmediateHandles = new Set<NodeJS.Immediate>();
  private readonly gcRetryHandles = new Set<NodeJS.Timeout>();
  private gcClosed = false;
  private readonly lifecycleStoreRefs = new Map<string, number>();
  private readonly pinnedVectorGenerations = new Map<string, number>();
  private readonly vaultAccessMs = new Map<string, number>();
  private readonly releasedReadContexts = new WeakSet<PinnedRetrievalReadContext>();
  private readonly publisherLeases = new Map<string, VaultPublisherLease>();
  private readonly inFlightSearchArtifactRoots = new Map<string, InFlightSearchArtifactRoots>();

  constructor(options: DaemonSnapshotStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.countCap = positiveCap(
      options.countCap ??
        envNumber(this.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_COUNT) ??
        envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_COUNT_CAP) ??
        DEFAULT_COUNT_CAP,
    );
    this.byteCap = positiveCap(
      options.byteCap ??
        envNumber(this.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_BYTES) ??
        envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_BYTE_CAP) ??
        DEFAULT_BYTE_CAP,
    );
    this.retentionCount = positiveCap(
      options.retentionCount ??
        envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT) ??
        DEFAULT_RETENTION_COUNT,
    );
    this.profileHash = options.profileHash ?? 'default';
    this.partitionBits = options.partitionBits ?? DEFAULT_PARTITION_BITS;
    const settings = readOptsidianSettings(process.cwd(), this.env);
    this.searchSettings = normalizeIndexAffectingSearchSettings(
      options.searchSettings ?? { ngram: searchNgramEnabled(this.env, settings) },
    );
    const runtime = searchAnalyzerRuntimeFromProcess();
    this.analyzer =
      options.analyzer ?? (options.snapshotBuilder ? undefined : resolveSearchAnalyzer(this.env, settings, runtime));
    this.analyzerIdentity =
      options.analyzerIdentity ??
      options.analyzer?.identity ??
      this.analyzer?.identity ??
      resolveSearchAnalyzer(this.env, settings, runtime).identity;
    this.baseReuseImplementationIdentity = computeBaseReuseImplementationIdentity({
      analyzerIdentity: this.analyzerIdentity,
      env: this.env,
      cwd: process.cwd(),
    });
    this.lexicalIdentityHash = options.lexicalIdentityHash ?? 'default-lexical';
    this.snapshotBuilder = options.snapshotBuilder;
    this.cacheCatalog = options.cacheCatalog ?? new SearchCacheCatalog({ env: this.env });
    this.renameSegment = options.durableRenameSegment ?? durableRename;
    this.renameManifest = options.durableRenameManifest ?? durableRename;
    this.renameLinkGraph = options.durableRenameLinkGraph ?? durableRename;
    this.vectorPool = options.vectorPool;
    this.embeddingSetBuilder = options.embeddingSetBuilder ?? createConfiguredEmbeddingSetBuilder(settings, this.env);
    this.publisherRegistry = options.publisherRegistry ?? new VaultPublisherRegistry();
    this.reclamationAuthority = options.reclamationAuthority ?? new SharedReclamationAuthority();
    this.tenancyFence = options.tenancyFence ?? createLocalTenancyFenceProvider();
    this.publisherLaneCancellation = options.publisherLaneCancellation ?? {};
  }

  searchAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.analyzerIdentity;
  }

  currentEmbeddingRecipeIdentity(): EmbeddingRecipeIdentity {
    return (
      this.embeddingSetBuilder.recipeIdentity ??
      deterministicHashEmbeddingRecipeIdentity(this.embeddingSetBuilder.providerIdentity)
    );
  }

  currentEmbeddingSpaceId(): EmbeddingSpaceId {
    return embeddingSpaceIdForRecipe(this.currentEmbeddingRecipeIdentity());
  }

  async loadVault(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<LoadVaultResult> {
    try {
      const paths = this.paths(vaultRoot);
      const snapshotId = await this.withLifecycleStore(paths, () => this.ensureIndexedSnapshot(paths, context));
      if (!context.embeddingLane) {
        const loadedBefore = new Set(this.loaded.keys());
        try {
          const retrieval = await this.ensureActiveRetrievalSnapshot(paths.vaultRoot, context);
          if (retrieval.status === 'ready') {
            const key = loadedKey(paths.storeId, retrieval.pin.snapshotId);
            this.release(retrieval.pin);
            const loaded = this.loaded.get(key);
            if (!loadedBefore.has(key) && loaded?.refCount === 0) this.loaded.delete(key);
          }
        } catch {
          // Lexical warmup can succeed while dense publication remains unavailable.
        }
      }
      return {
        ok: true,
        command: 'index',
        action: 'warm',
        vaults: [{ vaultRoot: paths.vaultRoot, status: 'ready' }],
        snapshotId,
      };
    } catch (error) {
      // A superseded writer token (STALE_INCARNATION) is a retryable stale-incarnation lifecycle
      // condition, not a vault-load failure: rethrow so it reaches the RPC error path and the
      // client resyncs and retries against the current daemon — the same handling Rebuild/Refresh/
      // Compact already get. A genuine load failure still downgrades to a per-vault status:'failed'.
      if (isStaleIncarnation(error)) throw error;
      return {
        ok: true,
        command: 'index',
        action: 'warm',
        vaults: [{ vaultRoot, status: 'failed', error: errorMessage(error) }],
      };
    }
  }

  async rebuild(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<SnapshotMutationResult> {
    const paths = this.paths(vaultRoot);
    const snapshotId = await this.withLifecycleStore(paths, async () => {
      return this.publishFreshSnapshot(paths.vaultRoot, context, { intentKind: 'rebuild', prepareRetrieval: true });
    });
    return {
      ok: true,
      command: 'index',
      action: 'rebuild',
      snapshotId,
    };
  }

  async publishSaveSnapshot(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<string> {
    const paths = this.paths(vaultRoot);
    return this.withLifecycleStore(paths, async () => {
      const awaitDense = context.embeddingLane === undefined;
      return this.publishFreshSnapshot(
        paths.vaultRoot,
        { ...context, embeddingLane: 'save' },
        { intentKind: 'save', prepareRetrieval: true, awaitDense, useActiveBase: true },
      );
    });
  }

  async journalSaveDirtyMarks(vaultRoot: string, dirtyMarks: readonly SnapshotDirtyMark[]): Promise<number[]> {
    if (dirtyMarks.length === 0) return [];
    const paths = this.paths(vaultRoot);
    const operations = await this.publisherFor(paths).enqueueDirtyMarks(dirtyMarks);
    return operations.map((operation) => operation.journalSeq);
  }

  journalPendingDebounce(vaultRoot: string, dirtyMarks: readonly SnapshotDirtyMark[]): void {
    if (dirtyMarks.length === 0) return;
    const paths = this.paths(vaultRoot);
    this.publisherFor(paths).enqueueDebouncedDirtyMarks(dirtyMarks);
  }

  async drainPublishers(): Promise<void> {
    await Promise.all([...this.publisherLeases.values()].map((lease) => lease.publisher.drain()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.allSettled([...this.gcChains.values()]);
  }

  async recordSaveFailure(vaultRoot: string, journalSeqs: readonly number[], error: unknown): Promise<void> {
    const paths = this.paths(vaultRoot);
    await this.publisherFor(paths).persistFailureDiagnostic({
      journalSeqs,
      vaultRoot: paths.vaultRoot,
      error,
      writerToken: this.currentWriterToken(),
    });
  }

  async foldSaveDirtyMarks(
    vaultRoot: string,
    dirtyMarks: readonly SnapshotDirtyMark[],
    context: SnapshotRequestContext = {},
  ): Promise<SnapshotDirtyFoldResult> {
    const foldQueuedDocument = this.embeddingSetBuilder.foldQueuedDocument?.bind(this.embeddingSetBuilder);
    if (dirtyMarks.length === 0 || !foldQueuedDocument) {
      return { requested: dirtyMarks.length, folded: [], skipped: [...dirtyMarks] };
    }
    const paths = this.paths(vaultRoot);
    return this.withLifecycleStore(paths, async () => {
      const built = this.snapshotBuilder
        ? await this.snapshotBuilder({
            vaultRoot: paths.vaultRoot,
            partitionBits: this.partitionBits,
            searchSettings: this.searchSettings,
            deadline: context.deadline,
            cancellationId: context.cancellationId,
            progress: context.progress,
          })
        : await this.buildSnapshotInProcess(paths.vaultRoot, context.progress);
      const documents = denseDocumentsForRetrievalSource(retrievalSnapshotSourceFromEnvelope(snapshotEnvelope(built)));
      const documentsByDocId = new Map(documents.map((document) => [document.documentId, document]));
      const documentsByPath = new Map(documents.map((document) => [document.path, document]));
      const folded: RetrievalEmbeddingBuildFoldResult[] = [];
      const skipped: SnapshotDirtyMark[] = [];
      for (const mark of dirtyMarks) {
        const document = documentsByDocId.get(mark.docId) ?? documentsByPath.get(mark.path);
        if (!document || (mark.contentHash !== undefined && document.contentHash !== mark.contentHash)) {
          skipped.push(mark);
          continue;
        }
        folded.push(foldQueuedDocument('save', document));
      }
      return {
        requested: dirtyMarks.length,
        folded,
        skipped,
      };
    });
  }

  async refresh(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
  ): Promise<{ ok: true; command: 'index'; action: 'refresh'; rebuilt: boolean; snapshotId?: string }> {
    const paths = this.paths(vaultRoot);
    const refreshed = await this.withLifecycleStore(paths, () => this.refreshIndexedSnapshot(paths, context));
    return {
      ok: true,
      command: 'index',
      action: 'refresh',
      rebuilt: refreshed.rebuilt,
      snapshotId: refreshed.snapshotId,
    };
  }

  async compact(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
  ): Promise<{ ok: true; command: 'index'; action: 'compact'; rebuilt: boolean; snapshotId?: string }> {
    const paths = this.paths(vaultRoot);
    const snapshotId = await this.withLifecycleStore(paths, async () => {
      const activeSnapshotId = await this.ensureActiveSnapshot(paths.vaultRoot, context);
      await this.recoverVault(paths);
      this.markSweepGc(paths);
      return activeSnapshotId;
    });
    return {
      ok: true,
      command: 'index',
      action: 'compact',
      rebuilt: false,
      snapshotId,
    };
  }

  async clear(vaultRoot: string): Promise<SnapshotMutationResult> {
    const paths = this.paths(vaultRoot);
    await this.withLifecycleStore(paths, async () => {
      const publisher = this.publisherFor(paths);
      await this.releasePublisherLeasesForStore(paths, publisher);
      const result = await publisher.enqueue({ kind: 'clear' });
      if (result.status !== 'completed') {
        throw new Error(
          result.status === 'dropped' ? result.reason : `clear intent did not complete: ${result.status}`,
        );
      }
      await this.releasePublisherLeasesForStore(paths);
    });
    return {
      ok: true,
      command: 'index',
      action: 'clear',
    };
  }

  async prune(options: SearchCachePruneOptions = {}): Promise<SearchIndexPruneResult> {
    return this.cacheCatalog.prune({
      ...options,
      protectedStoreIds: protectedStoreIdsForPrune(this.loaded, this.lifecycleStoreRefs, options.protectedStoreIds),
    });
  }

  async pin(vaultRoot: string, snapshotId?: string, context: SnapshotRequestContext = {}): Promise<PinnedSnapshot> {
    const paths = this.paths(vaultRoot);
    if (snapshotId !== undefined) assertValidSnapshotId(snapshotId);
    const pinned = await this.withLifecycleStore(paths, async () => {
      const activeSnapshotId = snapshotId ?? (await this.ensureActiveSnapshot(paths.vaultRoot, context));
      const reservation = this.reserveSnapshotPinArtifacts(paths, activeSnapshotId);
      try {
        const loaded = await this.ensureLoaded(paths, activeSnapshotId);
        loaded.refCount += 1;
        loaded.lastAccessMs = Date.now();
        this.vaultAccessMs.set(paths.storeId, loaded.lastAccessMs);
        recordVaultAccess(paths.vaultRoot, { env: this.env, nowMs: loaded.lastAccessMs });
        const pinToken = `${paths.storeId}:${activeSnapshotId}:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        loaded.pinTokens.add(pinToken);
        return { activeSnapshotId, loaded, pinToken };
      } finally {
        reservation?.release();
      }
    });
    this.enforceBudget();
    return {
      snapshotId: pinned.activeSnapshotId,
      view: pinned.loaded.view,
      pinToken: pinned.pinToken,
    };
  }

  async ensureActiveRetrievalSnapshot(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
  ): Promise<RetrievalPinResult> {
    const paths = this.paths(vaultRoot);
    return await this.withLifecycleStore(paths, async () => {
      const snapshotId = await this.ensureActiveSnapshot(paths.vaultRoot, context);
      const loaded = await this.ensureLoaded(paths, snapshotId);
      const current = await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
      if (
        current.status === 'ready' &&
        current.pin.snapshotId === snapshotId &&
        current.pin.corpusSnapshotId === loaded.envelope.corpusSnapshotId
      ) {
        return current;
      }
      if (current.status === 'ready') this.release(current.pin);
      await this.publishRetrievalSnapshot(
        paths,
        retrievalSnapshotSourceFromEnvelope(loaded.envelope),
        loaded.envelope,
        context,
      );
      return await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
    });
  }

  async pinLexicalReadContext(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
  ): Promise<LexicalReadContextResult> {
    const paths = this.paths(vaultRoot);
    let pinned: { loaded: LoadedSnapshot; pinToken: string } | undefined;
    try {
      pinned = await this.withLifecycleStore(paths, async () => {
        const snapshotId = await this.ensureActiveSnapshot(paths.vaultRoot, context);
        const reservation = this.reserveSnapshotPinArtifacts(paths, snapshotId);
        try {
          const loaded = await this.ensureLoaded(paths, snapshotId, { touchCache: false });
          loaded.refCount += 1;
          loaded.lastAccessMs = Date.now();
          this.vaultAccessMs.set(paths.storeId, loaded.lastAccessMs);
          const pinToken = `${paths.storeId}:${snapshotId}:lexical:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
          loaded.pinTokens.add(pinToken);
          return { loaded, pinToken };
        } finally {
          reservation?.release();
        }
      });
      const liveDocuments = pinned.loaded.documentsByDocumentId;
      const liveContentHashes = new Map(
        [...liveDocuments.values()].map((document) => [document.documentId, document.contentHash]),
      );
      const denseUsability = denseUsabilityForLiveDocuments(liveDocuments);
      return {
        status: 'ready',
        readContext: {
          lexicalPin: {
            snapshotId: pinned.loaded.snapshotId,
            view: pinned.loaded.view,
            pinToken: pinned.pinToken,
            corpusSnapshotId:
              pinned.loaded.envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(pinned.loaded.envelope.manifest),
            linkGraphId: pinned.loaded.envelope.linkGraphId,
          },
          liveDocuments,
          liveContentHashes,
          denseUsability,
          denseSignal: coldDenseSignal(liveDocuments.size),
        },
      };
    } catch {
      // The pin is committed inside withLifecycleStore, but post-pin work (content-hash map, corpus
      // id fallback) runs after it. If that throws, release the pin here — otherwise its refCount
      // stays > 0 forever and the snapshot becomes permanently exempt from GC.
      if (pinned) {
        this.release({ snapshotId: pinned.loaded.snapshotId, view: pinned.loaded.view, pinToken: pinned.pinToken });
      }
      return { status: 'index-not-ready', reason: 'lexical-snapshot-unavailable' };
    }
  }

  async tryAttachDenseGeneration(
    readContext: PinnedRetrievalReadContext,
    desiredEmbeddingSpace: EmbeddingSpaceId,
  ): Promise<DenseAttachmentResult> {
    readContext.desiredEmbeddingSpace = desiredEmbeddingSpace;
    const lexicalLoaded = this.loadedForPin(readContext.lexicalPin);
    const paths = this.paths(lexicalLoaded.vaultRoot);
    const candidate = await this.resolveDenseGenerationAttachCandidate(readContext, paths, desiredEmbeddingSpace);
    if (candidate.status !== 'ready') return candidate;
    if (!this.vectorPool) return this.denseUnavailable(readContext, 'unreadable', 'vector-manager-unavailable');
    const gcPin = candidate.candidate.gcPin;
    this.retainDenseGenerationGcPin(gcPin);
    try {
      const lease = await this.vectorPool.pinReadableGeneration({
        paths: candidate.candidate.vectorPaths,
        key: candidate.candidate.vectorPaths.key,
        expectedGenerationId: candidate.candidate.metadata.generationId,
        expectedManifestHash: candidate.candidate.metadata.manifestHash,
        expectedDbPath: candidate.candidate.metadata.dbPath,
        expectedSpec: candidate.candidate.metadata.spec,
      });
      if (lease.status !== 'ready') {
        this.releaseDenseGenerationGcPin(gcPin);
        return this.denseUnavailable(readContext, 'unreadable', lease.reason);
      }
      try {
        return this.attachDenseGenerationLease(readContext, candidate.candidate, lease.lease);
      } catch (error) {
        lease.lease.release();
        throw error;
      }
    } catch (error) {
      // A thrown lazy-open (e.g. pinReadableGeneration hitting a close race via assertOpen) or a
      // thrown attach must not leak the retained vector GC pin. The not-ready return path above
      // releases it explicitly; every throw releases it here exactly once.
      this.releaseDenseGenerationGcPin(gcPin);
      throw error;
    }
  }

  densePinnedGenerationCountForTests(): number {
    let total = 0;
    for (const count of this.pinnedVectorGenerations.values()) total += count;
    return total;
  }

  private async resolveDenseGenerationAttachCandidate(
    readContext: PinnedRetrievalReadContext,
    paths: SearchStoreCachePaths,
    desiredEmbeddingSpace: EmbeddingSpaceId,
  ): Promise<DenseGenerationAttachCandidateResult> {
    const retrieval = await this.resolveDenseRetrievalEnvelope(readContext, paths);
    if (retrieval.status !== 'ready') return retrieval;
    return this.resolveDenseVectorGeneration(readContext, paths, retrieval.retrieval, desiredEmbeddingSpace);
  }

  private async resolveDenseRetrievalEnvelope(
    readContext: PinnedRetrievalReadContext,
    paths: SearchStoreCachePaths,
  ): Promise<{ status: 'ready'; retrieval: RetrievalSnapshotEnvelope } | DenseUnavailableResult> {
    // Attach the head edition's dense generation when it is fresh; otherwise fall back to the most
    // recent fresh edition in the ledger. After a lexical-only rebuild the head is dense-unavailable,
    // but the last fresh generation is still attachable — attachDenseGenerationLease masks per-doc by
    // contentHash, so documents unchanged since that generation stay dense-enriched while edited/new
    // docs ride lexical-only. The generation is kept servable by GC (latestFreshEditionsUnder root).
    const head = this.currentEdition(paths);
    const edition =
      head && head.dense.state === 'fresh' && head.identity.retrievalSnapshotId ? head : this.latestFreshEdition(paths);
    if (!edition || edition.dense.state !== 'fresh' || !edition.identity.retrievalSnapshotId) {
      if (!head) return this.denseUnavailable(readContext, 'unavailable', 'no-active-retrieval-snapshot');
      return this.denseUnavailable(
        readContext,
        head.dense.state === 'failed' ? 'unreadable' : 'unavailable',
        denseEditionUnavailableMessage(head.dense),
      );
    }
    const retrieval = this.readRetrievalSnapshotEnvelope(paths, edition.identity.retrievalSnapshotId);
    if (!retrieval) return this.denseUnavailable(readContext, 'unreadable', 'retrieval-envelope-missing');
    if (!retrievalEnvelopeMatchesEdition(retrieval, edition)) {
      return this.denseUnavailable(readContext, 'unreadable', 'retrieval-snapshot-mismatched');
    }
    const envelope = this.readSnapshotEnvelope(paths, retrieval.snapshotId);
    if (!envelope || envelope.corpusSnapshotId !== retrieval.corpusSnapshotId) {
      return this.denseUnavailable(readContext, 'unreadable', 'corpus-missing');
    }
    try {
      await this.ensureLoaded(paths, retrieval.snapshotId, { touchCache: false });
    } catch {
      return this.denseUnavailable(readContext, 'unreadable', 'corpus-missing');
    }
    if (envelope.linkGraphId !== retrieval.linkGraphId || !linkGraphSidecarExists(paths, retrieval.linkGraphId)) {
      return this.denseUnavailable(readContext, 'unreadable', 'link-graph-missing');
    }
    if (retrieval.embeddingSet.embeddingSetId !== retrieval.embeddingSetId) {
      return this.denseUnavailable(readContext, 'unreadable', 'embedding-set-mismatched');
    }
    const expectedRetrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: retrieval.corpusSnapshotId,
      linkGraphId: retrieval.linkGraphId,
      embeddingSetId: retrieval.embeddingSetId,
      retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
      rankingFeatureVersion: retrieval.rankingFeatureVersion,
    });
    if (expectedRetrievalSnapshotId !== retrieval.retrievalSnapshotId) {
      return this.denseUnavailable(readContext, 'unreadable', 'retrieval-snapshot-mismatched');
    }
    return { status: 'ready', retrieval };
  }

  private resolveDenseVectorGeneration(
    readContext: PinnedRetrievalReadContext,
    paths: SearchStoreCachePaths,
    retrieval: RetrievalSnapshotEnvelope,
    desiredEmbeddingSpace: EmbeddingSpaceId,
  ): DenseGenerationAttachCandidateResult {
    const vectorPaths = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: retrieval.embeddingSetId,
      env: this.env,
    });
    const metadata = loadVectorGenerationMetadata(vectorPaths, retrieval.vector.generationId);
    if (!metadata) return this.denseUnavailable(readContext, 'unreadable', 'vector-generation-metadata-missing');
    if (
      metadata.generationId !== retrieval.vector.generationId ||
      metadata.embeddingSetId !== retrieval.embeddingSetId ||
      metadata.dbPath !== retrieval.vector.dbPath ||
      metadata.spec.specId !== retrieval.vector.specId ||
      metadata.manifestHash !== retrieval.vector.manifestHash ||
      metadataSha256(metadata) !== retrieval.vector.metadataSha256
    ) {
      return this.denseUnavailable(readContext, 'unreadable', 'vector-generation-metadata-mismatched');
    }
    if (metadata.embeddingSpaceId && metadata.embeddingSpaceId !== retrieval.embeddingSpaceId) {
      return this.denseUnavailable(readContext, 'unreadable', 'embedding-space-mismatched');
    }
    const metadataSpace = metadata.embeddingSpaceId;
    if (retrieval.embeddingSpaceId !== desiredEmbeddingSpace || metadataSpace !== desiredEmbeddingSpace) {
      return this.denseUnavailable(readContext, 'space-mismatch', 'embedding-space-mismatched', {
        state: 'rebuilding',
        pendingCount: readContext.liveDocuments.size,
        generationAgeMs: generationAgeMs(metadata),
      });
    }
    return {
      status: 'ready',
      candidate: {
        retrieval,
        vectorPaths,
        metadata,
        gcPin: {
          vectorKey: vectorPaths.key,
          generationId: metadata.manifestHash ?? metadata.generationId,
        },
      },
    };
  }

  private attachDenseGenerationLease(
    readContext: PinnedRetrievalReadContext,
    candidate: DenseGenerationAttachCandidate,
    vectorLease: ReadableVectorGenerationLease,
  ): Extract<DenseAttachmentResult, { status: 'attached' }> {
    const recordsByDocumentId = new Map(
      candidate.retrieval.embeddingSet.records.map((record) => [record.documentId, record]),
    );
    const denseUsability = denseUsabilityForRecords(readContext.liveDocuments, recordsByDocumentId, true);
    const denseSignal = denseSignalForUsability({
      retrieval: candidate.retrieval,
      metadata: candidate.metadata,
      usability: denseUsability,
    });
    const densePin: DenseGenerationPin = {
      retrieval: candidate.retrieval,
      embeddingSet: candidate.retrieval.embeddingSet,
      recordsByDocumentId,
      embeddingSpaceId: candidate.retrieval.embeddingSpaceId,
      vectorGeneration: candidate.metadata,
      vectorKey: candidate.vectorPaths.key,
      vectorLease,
      gcPin: candidate.gcPin,
    };
    readContext.densePin = densePin;
    readContext.denseUsability = denseUsability;
    readContext.denseSignal = denseSignal;
    return { status: 'attached', densePin, usability: denseUsability, signal: denseSignal };
  }

  private denseUnavailable(
    readContext: PinnedRetrievalReadContext,
    status: DenseUnavailableResult['status'],
    reason: string,
    signal?: DenseSignal,
  ): DenseUnavailableResult {
    const denseUsability = denseUsabilityForLiveDocuments(readContext.liveDocuments);
    const denseSignal = signal ?? coldDenseSignal(readContext.liveDocuments.size);
    readContext.denseUsability = denseUsability;
    readContext.denseSignal = denseSignal;
    return { status, reason, usability: denseUsability, signal: denseSignal };
  }

  releaseReadContext(readContext: PinnedRetrievalReadContext): void {
    if (this.releasedReadContexts.has(readContext)) return;
    this.releasedReadContexts.add(readContext);
    const densePin = readContext.densePin;
    if (densePin) {
      densePin.vectorLease.release();
      this.releaseDenseGenerationGcPin(densePin.gcPin);
    }
    this.release(readContext.lexicalPin);
  }

  async tryPinActiveRetrievalSnapshot(vaultRoot: string): Promise<RetrievalPinResult> {
    const paths = this.paths(vaultRoot);
    const edition = this.currentEdition(paths);
    if (!edition) return { status: 'index-not-ready', reason: 'no-active-retrieval-snapshot' };
    if (edition.dense.state !== 'fresh' || !edition.identity.retrievalSnapshotId) {
      return { status: 'index-not-ready', reason: denseEditionNotReadyReason(edition.dense) };
    }
    const retrieval = this.readRetrievalSnapshotEnvelope(paths, edition.identity.retrievalSnapshotId);
    if (!retrieval) return { status: 'index-not-ready', reason: 'retrieval-envelope-missing' };
    if (!retrievalEnvelopeMatchesEdition(retrieval, edition)) {
      return { status: 'index-not-ready', reason: 'retrieval-snapshot-mismatched' };
    }
    const envelope = this.readSnapshotEnvelope(paths, retrieval.snapshotId);
    if (!envelope || envelope.corpusSnapshotId !== retrieval.corpusSnapshotId) {
      return { status: 'index-not-ready', reason: 'corpus-missing' };
    }
    if (envelope.linkGraphId !== retrieval.linkGraphId || !linkGraphSidecarExists(paths, retrieval.linkGraphId)) {
      return { status: 'index-not-ready', reason: 'link-graph-missing' };
    }
    const vectorPaths = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: retrieval.embeddingSetId,
      env: this.env,
    });
    if (
      edition.dense.generationId !== retrieval.vector.generationId ||
      edition.dense.embeddingSetId !== retrieval.embeddingSetId ||
      edition.dense.specId !== retrieval.vector.specId ||
      edition.dense.dbPath !== retrieval.vector.dbPath ||
      edition.dense.manifestHash !== retrieval.vector.manifestHash
    ) {
      return { status: 'index-not-ready', reason: 'vector-active-spec-mismatched' };
    }
    if (retrieval.embeddingSet.embeddingSetId !== retrieval.embeddingSetId) {
      return { status: 'index-not-ready', reason: 'embedding-set-mismatched' };
    }
    const expectedRetrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: retrieval.corpusSnapshotId,
      linkGraphId: retrieval.linkGraphId,
      embeddingSetId: retrieval.embeddingSetId,
      retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
      rankingFeatureVersion: retrieval.rankingFeatureVersion,
    });
    if (expectedRetrievalSnapshotId !== retrieval.retrievalSnapshotId) {
      return { status: 'index-not-ready', reason: 'retrieval-snapshot-mismatched' };
    }

    const reservation = this.reserveInFlightSearchArtifacts(paths, { snapshot: envelope, retrieval });
    try {
      const loaded = await this.ensureLoaded(paths, retrieval.snapshotId, { touchCache: false });
      loaded.refCount += 1;
      loaded.lastAccessMs = Date.now();
      const pinToken = `${paths.vaultStateHash}:${retrieval.retrievalSnapshotId}:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      loaded.pinTokens.add(pinToken);
      const pin: PinnedRetrievalSnapshot = {
        snapshotId: retrieval.snapshotId,
        view: loaded.view,
        pinToken,
        retrievalSnapshotId: retrieval.retrievalSnapshotId,
        corpusSnapshotId: retrieval.corpusSnapshotId,
        linkGraphId: retrieval.linkGraphId,
        embeddingSetId: retrieval.embeddingSetId,
        embeddingSpaceId: retrieval.embeddingSpaceId,
        embeddingRecipeFreshnessId: retrieval.embeddingRecipeFreshnessId,
        retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
        rankingFeatureVersion: retrieval.rankingFeatureVersion,
        embeddingSet: retrieval.embeddingSet,
        vector: retrieval.vector,
        vectorKey: vectorPaths.key,
      };
      this.retainPinnedVectorGeneration(pin);
      return {
        status: 'ready',
        pin,
      };
    } finally {
      reservation.release();
    }
  }

  async load(snapshotId: string): Promise<SnapshotView | undefined> {
    assertValidSnapshotId(snapshotId);
    for (const snapshot of this.loaded.values()) {
      if (snapshot.snapshotId === snapshotId) return snapshot.view;
    }
    return undefined;
  }

  release(pin: PinnedSnapshot): void {
    const snapshot = this.loadedForPin(pin);
    if (snapshot.pinTokens.delete(pin.pinToken)) {
      if (isPinnedRetrievalSnapshot(pin)) this.releasePinnedVectorGeneration(pin);
      snapshot.refCount = Math.max(0, snapshot.refCount - 1);
    }
    snapshot.lastAccessMs = Date.now();
    this.enforceBudget();
  }

  snapshotHandleForPin(pin: PinnedSnapshot): SearchExecutionSnapshotHandle {
    const snapshot = this.loadedForPin(pin);
    return {
      snapshotId: snapshot.snapshotId,
      pinToken: pin.pinToken,
      bm25Stats: snapshot.bm25Stats,
      documents: sharedHandle(snapshot.documentBytes),
      linkGraph: linkGraphData(snapshot.linkGraph),
      segments: envelopePartitionsBySegmentId(snapshot.envelope).map((partition) => {
        const bytes = snapshot.segmentBytes.get(partition.segmentHash);
        if (!bytes) throw new Error(`loaded snapshot is missing segment bytes for ${partition.segmentHash}`);
        return {
          segmentId: partition.segmentHash,
          partitionId: partition.partitionId,
          bytes: sharedHandle(bytes),
        };
      }),
    };
  }

  documentsForPin(pin: PinnedSnapshot): ReadonlyMap<string, PersistedDocumentRecord> {
    return this.loadedForPin(pin).documentsByDocumentId;
  }

  statsForTests(): {
    loadedSnapshots: number;
    loadedBytes: number;
    refCounts: Record<string, number>;
    active: Record<string, string>;
  } {
    const refCounts: Record<string, number> = {};
    let loadedBytes = 0;
    for (const snapshot of this.loaded.values()) {
      refCounts[`${snapshot.vaultKey}:${snapshot.snapshotId}`] = snapshot.refCount;
      loadedBytes += snapshot.byteLength;
    }
    return {
      loadedSnapshots: this.loaded.size,
      loadedBytes,
      refCounts,
      active: Object.fromEntries(this.activeByVault),
    };
  }

  protectedStoreIdsForPrune(): Set<string> {
    return protectedStoreIdsForPrune(this.loaded, this.lifecycleStoreRefs);
  }

  private async ensureIndexedSnapshot(
    paths: SearchStoreCachePaths,
    context: SnapshotRequestContext = {},
  ): Promise<string> {
    return (await this.refreshIndexedSnapshot(paths, context)).snapshotId;
  }

  private async refreshIndexedSnapshot(
    paths: SearchStoreCachePaths,
    context: SnapshotRequestContext = {},
  ): Promise<{ snapshotId: string; rebuilt: boolean }> {
    await this.recoverVault(paths);
    this.markSweepGc(paths);
    const active = this.currentEdition(paths);
    if (active && this.snapshotIdentityMatches(paths, active.corpus.snapshotId)) {
      const delta = this.snapshotContentDelta(paths, active.corpus.snapshotId);
      if (delta?.changedCount === 0) {
        try {
          await this.ensureLoaded(paths, active.corpus.snapshotId);
        } catch {
          this.loaded.delete(loadedKey(paths.storeId, active.corpus.snapshotId));
          return {
            snapshotId: await this.publishFreshSnapshot(paths.vaultRoot, context, { prepareRetrieval: true }),
            rebuilt: true,
          };
        }
        this.activeByVault.set(paths.storeId, active.corpus.snapshotId);
        if (!this.retrievalReadyForEdition(paths, active)) {
          void this.enqueueDensePublication(paths, active, context, { force: true }).catch(() => undefined);
        }
        context.progress?.({
          phase: 'scanning',
          total: 0,
          completed: 0,
          message: 'already fresh',
        });
        return { snapshotId: active.corpus.snapshotId, rebuilt: false };
      }
      if (delta) reportRefreshDelta(context, delta);
      return {
        snapshotId: await this.publishFreshSnapshot(paths.vaultRoot, context, {
          intentKind: 'refresh',
          prepareRetrieval: true,
          useActiveBase: true,
        }),
        rebuilt: true,
      };
    }
    const fallbackCandidate = active ? this.reusableBaseForSnapshot(paths, active.corpus.snapshotId) : undefined;
    const fallbackReason = fallbackCandidate && !fallbackCandidate.ok ? fallbackCandidate.reason : undefined;
    return {
      snapshotId: await this.publishFreshSnapshot(paths.vaultRoot, context, {
        intentKind: 'refresh',
        prepareRetrieval: true,
        ...(fallbackReason ? { incrementalFallbackReason: fallbackReason } : {}),
      }),
      rebuilt: true,
    };
  }

  private async ensureActiveSnapshot(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<string> {
    const paths = this.paths(vaultRoot);
    await this.recoverVault(paths);
    const active = this.currentEdition(paths);
    if (
      active &&
      this.snapshotIsFresh(paths, active.corpus.snapshotId) &&
      this.snapshotIdentityMatches(paths, active.corpus.snapshotId)
    ) {
      try {
        await this.ensureLoaded(paths, active.corpus.snapshotId);
        this.activeByVault.set(paths.storeId, active.corpus.snapshotId);
        return active.corpus.snapshotId;
      } catch {
        this.loaded.delete(loadedKey(paths.storeId, active.corpus.snapshotId));
      }
    }
    return this.publishFreshSnapshot(vaultRoot, context, {
      intentKind: 'refresh',
      useActiveBase: active !== undefined,
    });
  }

  private async publishFreshSnapshot(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
    options: PublishFreshSnapshotOptions = {},
  ): Promise<string> {
    const paths = this.paths(vaultRoot);
    await this.recoverVault(paths);
    this.markSweepGc(paths);
    const publisher = this.publisherFor(paths);
    const scanBoundary = publisher.recordScanBoundary();
    const result = await publisher.enqueue({
      kind: options.intentKind ?? 'refresh',
      scanBoundary,
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      requestContext: context,
      prepareRetrieval: options.prepareRetrieval,
      useActiveBase: options.useActiveBase,
      incrementalFallbackReason: options.incrementalFallbackReason,
    });
    const edition = lexicalEditionFromPublisherResult(result);
    this.activeByVault.set(paths.storeId, edition.corpus.snapshotId);
    // Attach the rejection handler at creation so the fire-and-forget branch (background embedding
    // lane, not awaited below) can never surface a STALE_INCARNATION reject as an unhandledRejection
    // during a lease handoff; the awaited branch simply awaits the already-guarded promise.
    const densePublication = options.prepareRetrieval
      ? this.enqueueDensePublication(paths, edition, context).catch(() => undefined)
      : undefined;
    if (densePublication && (options.awaitDense || !context.embeddingLane)) {
      await densePublication;
    }
    this.markSweepGc(paths);
    this.enforceBudget();
    return edition.corpus.snapshotId;
  }

  private async buildSnapshotWithIncrementalFallback(
    paths: SearchStoreCachePaths,
    context: SnapshotRequestContext,
    options: PublishFreshSnapshotOptions,
  ): Promise<BuiltSnapshot> {
    let fallbackWarning = options.incrementalFallbackReason
      ? reportIncrementalFallback(context, options.incrementalFallbackReason)
      : undefined;
    if (!options.base) {
      const built = await this.buildSnapshotOnce(paths, context, undefined);
      return fallbackWarning ? builtSnapshotWithWarning(built, fallbackWarning) : built;
    }
    try {
      return await this.buildSnapshotOnce(paths, context, options.base);
    } catch (error) {
      fallbackWarning = reportIncrementalFallback(context, `incremental build aborted: ${errorMessage(error)}`);
      const built = await this.buildSnapshotOnce(paths, context, undefined);
      return builtSnapshotWithWarning(built, fallbackWarning);
    }
  }

  private buildSnapshotOnce(
    paths: SearchStoreCachePaths,
    context: SnapshotRequestContext,
    base: BuildSnapshotBase | undefined,
  ): Promise<BuiltSnapshot> {
    return this.snapshotBuilder
      ? this.snapshotBuilder({
          vaultRoot: paths.vaultRoot,
          partitionBits: this.partitionBits,
          searchSettings: this.searchSettings,
          base,
          deadline: context.deadline,
          cancellationId: context.cancellationId,
          progress: context.progress,
        })
      : this.buildSnapshotInProcess(paths.vaultRoot, context.progress, base);
  }

  private async buildSnapshotInProcess(
    vaultRoot: string,
    progress?: (progress: SearchIndexProgressUpdate) => void,
    base?: BuildSnapshotBase,
  ): Promise<BuiltSnapshot> {
    if (!this.analyzer) throw new Error('snapshot builder is not configured');
    return withSearchAnalyzerLease(this.analyzer, (leasedAnalyzer) =>
      buildCanonicalSearchSnapshot({
        vaultRoot,
        analyzer: leasedAnalyzer,
        searchSettings: this.searchSettings,
        partitionBits: this.partitionBits,
        base,
        progress,
      }),
    );
  }

  private async publishBuiltSnapshot(
    paths: SearchStoreCachePaths,
    built: BuiltSnapshot,
    context: SnapshotRequestContext = {},
    envelope: SnapshotEnvelope = snapshotEnvelope(built),
  ): Promise<void> {
    this.ensureDirs(paths);
    const linkGraphSidecar = buildLinkGraphSidecar({
      corpusSnapshotId: built.corpusSnapshotId,
      edges: built.linkEdges,
    });
    if (linkGraphSidecar.linkGraphId !== built.linkGraphId) {
      throw new Error(`built snapshot linkGraphId mismatch for ${built.snapshotId}`);
    }
    await storeLinkGraphSidecar(paths, linkGraphSidecar, { durableRenameLinkGraph: this.renameLinkGraph });

    for (const [index, segment] of built.segments.entries()) {
      assertValidContentHash(segment.hash, 'segment hash');
      const target = safeSegmentPath(paths.segmentsDir, segment.hash);
      let published = false;
      if (fs.existsSync(target)) {
        const existingHash = sha256(fs.readFileSync(target));
        if (existingHash === segment.hash) published = true;
        else fs.rmSync(target, { force: true });
      }
      if (!published) {
        const tmp = path.join(paths.tmpDir, `${segment.hash}.${process.pid}.${randomTmpSuffix()}.segment.tmp`);
        writePrivateFileSync(tmp, segment.bytes, 'Optsidian search segment');
        fsyncFileSync(tmp);
        fsyncDirSync(paths.tmpDir);
        const actual = sha256(fs.readFileSync(tmp));
        if (actual !== segment.hash) throw new Error(`segment hash verification failed for ${segment.hash}`);
        await this.renameSegment(tmp, target);
        fsyncDirSync(paths.segmentsDir);
      }
      context.progress?.({
        phase: 'publishing',
        total: built.segments.length,
        completed: index + 1,
        current: segment.hash,
      });
    }

    const manifestPath = path.join(paths.snapshotsDir, built.snapshotId);
    const manifestTmp = path.join(paths.tmpDir, `${built.snapshotId}.${process.pid}.${randomTmpSuffix()}.manifest.tmp`);
    writePrivateFileSync(manifestTmp, `${JSON.stringify(envelope)}\n`, 'Optsidian search snapshot manifest');
    fsyncFileSync(manifestTmp);
    await this.renameManifest(manifestTmp, manifestPath);
    fsyncDirSync(paths.snapshotsDir);

    await this.recoverVault(paths);
  }

  private async publishRetrievalSnapshot(
    paths: SearchStoreCachePaths,
    _source: RetrievalSnapshotSource,
    envelope: SnapshotEnvelope,
    context: SnapshotRequestContext = {},
  ): Promise<void> {
    const targetCorpusSnapshotId = envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(envelope.manifest);
    const result = await this.enqueueDensePublication(paths, this.currentEdition(paths), context, {
      targetCorpusSnapshotId,
      targetLinkGraphId: envelope.linkGraphId,
      force: true,
    });
    if (result.status === 'dropped') throw new Error(`dense publication dropped: ${result.reason}`);
    if (result.status === 'not-ready') throw new Error(`retrieval snapshot is not ready: ${result.reason}`);
  }

  private enqueueDensePublication(
    paths: SearchStoreCachePaths,
    target: EditionRecord | undefined,
    context: SnapshotRequestContext = {},
    options: { targetCorpusSnapshotId?: string; targetLinkGraphId?: LinkGraphId; force?: boolean } = {},
  ): Promise<VaultPublisherIntentResult> {
    const publisher = this.publisherFor(paths);
    return publisher.enqueue({
      kind: 'dense-publication',
      ...(options.force ? { force: true } : {}),
      ...(target
        ? {
            scanBoundary: {
              frontierSeq: target.frontierSeq,
              scanBoundaryJournalSeq: target.scanBoundaryJournalSeq ?? 0,
            },
            targetEditionSeq: target.editionSeq,
            targetCorpusSnapshotId: options.targetCorpusSnapshotId ?? target.corpus.corpusSnapshotId,
            targetLinkGraphId: options.targetLinkGraphId ?? target.linkGraphId,
            ...(target.identity.retrievalSnapshotId
              ? { targetRetrievalSnapshotId: target.identity.retrievalSnapshotId }
              : {}),
          }
        : {}),
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      requestContext: context,
    });
  }

  private retrievalReadyForEdition(paths: SearchStoreCachePaths, edition: EditionRecord): boolean {
    if (edition.dense.state !== 'fresh' || !edition.identity.retrievalSnapshotId) return false;
    const retrieval = this.readRetrievalSnapshotEnvelope(paths, edition.identity.retrievalSnapshotId);
    if (!retrieval || !retrievalEnvelopeMatchesEdition(retrieval, edition)) return false;
    const envelope = this.readSnapshotEnvelope(paths, retrieval.snapshotId);
    if (!envelope || envelope.corpusSnapshotId !== retrieval.corpusSnapshotId) return false;
    if (envelope.linkGraphId !== retrieval.linkGraphId || !linkGraphSidecarExists(paths, retrieval.linkGraphId)) {
      return false;
    }
    if (
      edition.dense.generationId !== retrieval.vector.generationId ||
      edition.dense.embeddingSetId !== retrieval.embeddingSetId ||
      edition.dense.specId !== retrieval.vector.specId ||
      edition.dense.dbPath !== retrieval.vector.dbPath ||
      edition.dense.manifestHash !== retrieval.vector.manifestHash
    ) {
      return false;
    }
    if (retrieval.embeddingSet.embeddingSetId !== retrieval.embeddingSetId) return false;
    const expectedRetrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: retrieval.corpusSnapshotId,
      linkGraphId: retrieval.linkGraphId,
      embeddingSetId: retrieval.embeddingSetId,
      retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
      rankingFeatureVersion: retrieval.rankingFeatureVersion,
    });
    return expectedRetrievalSnapshotId === retrieval.retrievalSnapshotId;
  }

  private async buildRetrievalSnapshotPublication(
    paths: SearchStoreCachePaths,
    source: RetrievalSnapshotSource,
    envelope: SnapshotEnvelope,
    context: SnapshotRequestContext = {},
  ): Promise<RetrievalSnapshotPublication> {
    const lane = backgroundEmbeddingLane(context.embeddingLane);
    const documents = mergeEmbeddingDocuments(
      denseDocumentsForRetrievalSource(source),
      lane ? (this.embeddingSetBuilder.drainNextIncrementalDocuments?.(lane) ?? []) : [],
    );
    const embeddingSet = await this.embeddingSetBuilder.build({
      vaultRoot: paths.vaultRoot,
      documents,
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      progress: context.progress,
      embeddingLane: context.embeddingLane,
    });
    assertProviderIdentityMatches(embeddingSet.recipe.provider, this.embeddingSetBuilder.providerIdentity);
    const provider = embeddingSet.recipe.provider;
    const embeddingSpaceId = embeddingSpaceIdForRecipe(embeddingSet.recipe);
    const recipeFreshnessId = computeEmbeddingRecipeFreshnessId(embeddingSet.recipe);
    const vectorPaths = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: embeddingSet.embeddingSetId,
      env: this.env,
    });
    const spec: CoralEmbeddingSpec = {
      specId: embeddingSpecId(embeddingSet.embeddingSetId, provider.model, provider.dim),
      provider: provider.id,
      model: provider.model,
      dims: provider.dim,
      normalization: 'l2',
      createdAt: new Date(0).toISOString(),
    };
    const generationId = vectorGenerationIdForManifest({
      embeddingSpaceId,
      embeddingRecipeFreshnessId: recipeFreshnessId,
      corpusRevision: source.corpusSnapshotId,
      records: embeddingSet.records,
    });
    const vectorChunks = vectorChunksForEmbeddingSet(embeddingSet.records, spec);
    const manifestHash = vectorGenerationManifestHash({
      spec,
      chunks: vectorChunks,
      embeddingSpaceId,
      embeddingRecipeFreshnessId: recipeFreshnessId,
    });
    const generation: VectorGenerationMetadata = {
      schemaVersion: 1,
      key: vectorPaths.key,
      generationId,
      dbPath: vectorGenerationDbPath(vectorPaths, manifestHash),
      spec,
      chunkCount: embeddingSet.records.length,
      builtEngine: 'auto',
      createdAt: new Date(0).toISOString(),
      embeddingSetId: embeddingSet.embeddingSetId,
      embeddingSpaceId,
      embeddingRecipeFreshnessId: recipeFreshnessId,
      manifestHash,
    };
    // Reserve the generation (by manifest hash) BEFORE the staging build makes its dir visible, and
    // hold it until the naming edition commits — otherwise a concurrent sibling-ledger sweep could
    // reclaim this generation in the build→commit window (the deleted inFlightVectorGenerations root
    // replacement). The committing consumer releases it via `publication.reservation`.
    const reservation = this.vectorPool
      ? await this.reclamationAuthority.acquireBuildReservation({
          reservationsDir: vectorPaths.reservationsDir,
          manifestHash,
        })
      : undefined;
    try {
      if (this.vectorPool) {
        const builtGeneration = await this.vectorPool.buildStagingGeneration({
          paths: vectorPaths,
          spec,
          chunks: vectorChunks,
          generationId,
          embeddingSpaceId,
          embeddingRecipeFreshnessId: recipeFreshnessId,
          progress: context.progress,
        });
        await this.vectorPool.promoteBuiltGeneration(vectorPaths, builtGeneration.metadata);
        generation.dbPath = builtGeneration.metadata.dbPath;
        generation.chunkCount = builtGeneration.metadata.chunkCount;
        generation.builtEngine = builtGeneration.metadata.builtEngine;
        generation.createdAt = builtGeneration.metadata.createdAt;
        generation.embeddingSpaceId = builtGeneration.metadata.embeddingSpaceId ?? embeddingSpaceId;
        generation.embeddingRecipeFreshnessId =
          builtGeneration.metadata.embeddingRecipeFreshnessId ?? recipeFreshnessId;
        generation.manifestHash = builtGeneration.metadata.manifestHash ?? generation.manifestHash;
      } else {
        context.progress?.({
          phase: 'vector-indexing',
          total: embeddingSet.records.length,
          completed: 0,
          current: generationId,
        });
        await storeVectorGenerationMetadata(vectorPaths, generation);
        context.progress?.({
          phase: 'vector-indexing',
          total: embeddingSet.records.length,
          completed: embeddingSet.records.length,
          current: generationId,
          message: 'stored',
        });
      }

      const { retrieverPlanIdentity, rankingFeatureVersion } = currentRetrievalIdentity({
        linkGraphId: source.linkGraphId,
        rankingFeatureVersion: String(source.identityTuple.rankingFeatureVersion),
        provider,
      });
      const retrievalSnapshotId = computeRetrievalSnapshotId({
        corpusSnapshotId: source.corpusSnapshotId,
        linkGraphId: source.linkGraphId,
        embeddingSetId: embeddingSet.embeddingSetId,
        retrieverPlanIdentity,
        rankingFeatureVersion,
      });
      const retrievalEnvelope: RetrievalSnapshotEnvelope = {
        schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
        retrievalSnapshotId,
        snapshotId: source.snapshotId,
        corpusSnapshotId: source.corpusSnapshotId,
        linkGraphId: source.linkGraphId,
        embeddingSetId: embeddingSet.embeddingSetId,
        embeddingSpaceId,
        embeddingRecipeFreshnessId: recipeFreshnessId,
        retrieverPlanIdentity,
        rankingFeatureVersion,
        canonicalManifestSha256: envelope.canonicalManifestSha256,
        embeddingSet: retrievalEmbeddingSetEnvelope(embeddingSet),
        vector: {
          embeddingSetId: embeddingSet.embeddingSetId,
          generationId,
          specId: spec.specId,
          dbPath: generation.dbPath,
          manifestHash: generation.manifestHash ?? manifestHash,
          metadataSha256: metadataSha256(generation),
          key: vectorPaths.key,
        },
        freshness: {
          state: 'fresh',
          corpusRevision: source.corpusSnapshotId,
        },
      };
      return {
        envelope: retrievalEnvelope,
        vectorPaths,
        reservation,
        dense: {
          state: 'fresh',
          generationId,
          embeddingSetId: embeddingSet.embeddingSetId,
          embeddingSpaceId,
          embeddingRecipeFreshnessId: recipeFreshnessId,
          specId: spec.specId,
          dbPath: generation.dbPath,
          manifestHash: generation.manifestHash ?? manifestHash,
          metadataSha256: metadataSha256(generation),
        },
      };
    } catch (error) {
      reservation?.release();
      throw error;
    }
  }

  private editionCandidateForSnapshot(input: {
    paths: SearchStoreCachePaths;
    envelope: SnapshotEnvelope;
    dense: DenseEdition;
    retrieval?: RetrievalSnapshotEnvelope;
    scanBoundary: { frontierSeq: number; scanBoundaryJournalSeq: number };
    head: EditionRecord | undefined;
  }): EditionCandidate {
    const publisher = this.publisherFor(
      input.paths,
      denseEmbeddingSpaceForEdition(input.dense, this.currentEmbeddingSpaceId()),
    );
    const identityTuple = input.envelope.manifest.identityTuple;
    return {
      ...(input.head ? { baseEditionSeq: input.head.editionSeq } : {}),
      frontierSeq: input.scanBoundary.frontierSeq,
      scanBoundaryJournalSeq: input.scanBoundary.scanBoundaryJournalSeq,
      corpus: {
        snapshotId: input.envelope.snapshotId,
        corpusSnapshotId: input.envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(input.envelope.manifest),
        canonicalManifestSha256: input.envelope.canonicalManifestSha256,
      },
      linkGraphId: input.envelope.linkGraphId,
      dense: input.dense,
      identity: {
        retrievalIdentity: {
          vaultStateHash: input.paths.vaultStateHash,
          lexicalIdentityHash: input.paths.lexicalIdentityHash,
          embeddingSpaceId: denseEmbeddingSpaceForEdition(input.dense, this.currentEmbeddingSpaceId()),
        },
        vaultStateHash: input.paths.vaultStateHash,
        lexicalIdentityHash: input.paths.lexicalIdentityHash,
        embeddingSpaceId: denseEmbeddingSpaceForEdition(input.dense, this.currentEmbeddingSpaceId()),
        ...(input.retrieval?.embeddingSetId ? { embeddingSetId: input.retrieval.embeddingSetId } : {}),
        ...(input.retrieval?.retrievalSnapshotId ? { retrievalSnapshotId: input.retrieval.retrievalSnapshotId } : {}),
        ...(input.retrieval?.retrieverPlanIdentity
          ? { retrieverPlanIdentity: input.retrieval.retrieverPlanIdentity }
          : {}),
        rankingFeatureVersion: String(identityTuple.rankingFeatureVersion),
        analyzerIdentity: this.analyzerIdentity,
      },
      coverage: editionCoverageFromCorpus({
        documents: input.envelope.documents,
        tombstones: publisher.frontierJournal
          .operations()
          .filter(
            (operation) =>
              operation.op === 'delete' &&
              operation.journalSeq <= input.scanBoundary.scanBoundaryJournalSeq &&
              !input.envelope.documents.some(
                (document) => document.documentId === operation.docId && document.path === operation.path,
              ),
          )
          .map((operation) => ({
            docId: operation.docId,
            path: operation.path,
            tombstoneSeq: operation.op === 'delete' ? operation.tombstoneSeq : undefined,
          })),
      }),
    };
  }

  private async ensureLoaded(
    paths: SearchStoreCachePaths,
    snapshotId: string,
    options: { touchCache?: boolean } = {},
  ): Promise<LoadedSnapshot> {
    const touchCache = options.touchCache !== false;
    assertValidSnapshotId(snapshotId);
    const key = loadedKey(paths.storeId, snapshotId);
    const existing = this.loaded.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      if (touchCache) this.cacheCatalog.touchUsed(paths, { snapshotId });
      return existing;
    }
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) throw new Error(`snapshot ${snapshotId} is not available for vault ${paths.vaultRoot}`);
    const loaded = this.loadEnvelope(paths, envelope);
    this.loaded.set(key, loaded);
    if (touchCache) this.cacheCatalog.touchUsed(paths, { snapshotId });
    return loaded;
  }

  private loadEnvelope(paths: SearchStoreCachePaths, envelope: SnapshotEnvelope): LoadedSnapshot {
    const documentsByDocumentId = new Map(envelope.documents.map((document) => [document.documentId, document]));
    const segmentBytes = new Map<string, Uint8Array>();
    const segmentStats: Array<readonly CanonicalBm25FieldStats[]> = [];
    const documentBytes = sharedBytes(new TextEncoder().encode(JSON.stringify([...documentsByDocumentId.values()])));
    let byteLength = 0;
    byteLength += documentBytes.byteLength;

    for (const partition of envelope.manifest.partitions) {
      const segmentPath = safeSegmentPath(paths.segmentsDir, partition.segmentHash);
      const bytes = fs.readFileSync(segmentPath);
      const actualHash = sha256(bytes);
      if (actualHash !== partition.segmentHash) throw new Error(`segment hash mismatch for ${partition.segmentHash}`);
      const decoded = decodeCanonicalSegment(bytes);
      segmentStats.push(decoded.bm25 ?? []);
      const shared = sharedBytes(bytes);
      byteLength += shared.byteLength;
      segmentBytes.set(partition.segmentHash, shared);
    }
    const bm25Stats = verifyBm25StatsFromVerifiedSegments(envelope.manifest, segmentStats);
    const linkGraph = loadLinkGraphView(paths, envelope.linkGraphId);
    if (!linkGraph)
      throw new Error(`link graph sidecar is missing for snapshot ${envelope.snapshotId}: ${envelope.linkGraphId}`);
    const view = this.createSnapshotView(envelope, segmentBytes, linkGraph);
    return {
      vaultRoot: paths.vaultRoot,
      vaultKey: paths.storeId,
      snapshotId: envelope.snapshotId,
      envelope,
      view,
      linkGraph,
      documentsByDocumentId,
      documentBytes,
      segmentBytes,
      bm25Stats,
      byteLength,
      refCount: 0,
      pinTokens: new Set(),
      lastAccessMs: Date.now(),
    };
  }

  private createSnapshotView(
    envelope: SnapshotEnvelope,
    segmentBytes: Map<string, Uint8Array>,
    linkGraph: LinkGraphView,
  ): SnapshotView {
    const manifest: SnapshotManifestView = {
      snapshotId: envelope.snapshotId,
      identityTuple: envelope.manifest.identityTuple,
      liveDocumentManifestHash: envelope.manifest.liveDocumentManifestHash,
      tombstoneHash: envelope.manifest.tombstoneHash,
      partitions: envelope.manifest.partitions,
    };
    return {
      snapshotId: envelope.snapshotId,
      manifest,
      linkGraphId: linkGraph.linkGraphId,
      linkGraph,
      segmentBytes: (segmentId) => segmentBytes.get(segmentId),
      segmentManifest: (segmentId) => {
        const bytes = segmentBytes.get(segmentId);
        return bytes ? decodeCanonicalSegment(bytes) : undefined;
      },
      outlinks: (documentId) => linkGraph.outlinks(documentId),
      inlinks: (documentId) => linkGraph.inlinks(documentId),
      neighbors: (documentId) => linkGraph.neighbors(documentId),
    };
  }

  private enforceBudget(): void {
    this.applyVaultAccessRecency();
    let snapshots = [...this.loaded.values()];
    let bytes = snapshots.reduce((sum, snapshot) => sum + snapshot.byteLength, 0);
    const coldSnapshots = () =>
      snapshots
        .filter((snapshot) => snapshot.refCount === 0)
        .sort((left, right) => accessTime(left, this.vaultAccessMs) - accessTime(right, this.vaultAccessMs));
    while ((snapshots.length > this.countCap || bytes > this.byteCap) && coldSnapshots().length > 0) {
      const evict = coldSnapshots()[0];
      this.loaded.delete(loadedKey(evict.vaultKey, evict.snapshotId));
      bytes -= evict.byteLength;
      snapshots = [...this.loaded.values()];
    }
  }

  private markSweepGc(paths: SearchStoreCachePaths): void {
    this.ensureDirs(paths);
    this.queueGc(paths);
  }

  private async gcRootsAsync(paths: SearchStoreCachePaths): Promise<GcRoots> {
    const snapshotIds = new Set<string>();
    const segmentHashes = new Set<string>();
    const linkGraphIds = new Set<LinkGraphId>();
    const retrievalSnapshotIds = new Set<RetrievalSnapshotId>();
    const vectorGenerationKeys = new Set<string>();
    const roots: GcRoots = { snapshotIds, segmentHashes, linkGraphIds, retrievalSnapshotIds, vectorGenerationKeys };
    // Root each ledger's head edition AND its latest fresh edition. The latest-fresh may be an
    // ancestor of the head after a lexical-only rebuild; it must stay fully servable (lexical
    // snapshot + link graph + retrieval envelope + vector generation) because readers attach it for
    // per-doc dense masking until a new dense generation is built.
    for (const edition of liveEditionsForGcUnder(paths.rootDir)) {
      snapshotIds.add(edition.corpus.snapshotId);
      linkGraphIds.add(edition.linkGraphId);
      const envelope = await this.readSnapshotEnvelopeAsync(paths, edition.corpus.snapshotId);
      if (envelope) addSnapshotEnvelopeGcRoots(roots, envelope);
      if (edition.identity.retrievalSnapshotId) {
        const retrieval = await this.readRetrievalSnapshotEnvelopeAsync(paths, edition.identity.retrievalSnapshotId);
        if (retrieval) await this.addRetrievalSnapshotGcRoots(roots, paths, retrieval);
      }
    }
    for (const snapshot of this.loaded.values()) {
      if (snapshot.vaultKey !== paths.storeId) continue;
      linkGraphIds.add(snapshot.linkGraph.linkGraphId);
      if (snapshot.refCount <= 0) continue;
      snapshotIds.add(snapshot.snapshotId);
      for (const partition of snapshot.envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const file of await retainedSnapshotFilesAsync(paths.snapshotsDir, this.retentionCount)) {
      const envelope = await this.readSnapshotEnvelopeAsync(paths, file);
      if (!envelope) continue;
      addSnapshotEnvelopeGcRoots(roots, envelope);
    }
    for (const file of await retainedSnapshotFilesAsync(paths.retrievalsDir, this.retentionCount)) {
      const retrieval = await this.readRetrievalSnapshotEnvelopeAsync(paths, file);
      if (!retrieval) continue;
      await this.addRetrievalSnapshotGcRoots(roots, paths, retrieval);
    }
    this.addInFlightSearchArtifactGcRoots(paths, roots);
    const vaultVectorPrefix = vectorGenerationGcPrefix(this.profileHash, paths.vaultStateHash);
    for (const key of this.pinnedVectorGenerations.keys()) {
      if (key.startsWith(vaultVectorPrefix)) vectorGenerationKeys.add(key);
    }
    return roots;
  }

  private reserveInFlightSearchArtifacts(
    paths: SearchStoreCachePaths,
    input: { snapshot?: SnapshotEnvelope; retrieval?: RetrievalSnapshotEnvelope },
  ): SearchArtifactGcReservation {
    const snapshotIds = new Set<string>();
    const segmentHashes = new Set<string>();
    const linkGraphIds = new Set<LinkGraphId>();
    const retrievalSnapshotIds = new Set<RetrievalSnapshotId>();
    const addSnapshot = (envelope: SnapshotEnvelope) => {
      snapshotIds.add(envelope.snapshotId);
      linkGraphIds.add(envelope.linkGraphId);
      for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    };
    if (input.snapshot) addSnapshot(input.snapshot);
    if (input.retrieval) {
      retrievalSnapshotIds.add(input.retrieval.retrievalSnapshotId);
      snapshotIds.add(input.retrieval.snapshotId);
      linkGraphIds.add(input.retrieval.linkGraphId);
    }
    const roots = this.inFlightSearchArtifactRootsFor(paths.storeId);
    for (const value of snapshotIds) retainCountedRoot(roots.snapshotIds, value);
    for (const value of segmentHashes) retainCountedRoot(roots.segmentHashes, value);
    for (const value of linkGraphIds) retainCountedRoot(roots.linkGraphIds, value);
    for (const value of retrievalSnapshotIds) retainCountedRoot(roots.retrievalSnapshotIds, value);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const value of snapshotIds) releaseCountedRoot(roots.snapshotIds, value);
        for (const value of segmentHashes) releaseCountedRoot(roots.segmentHashes, value);
        for (const value of linkGraphIds) releaseCountedRoot(roots.linkGraphIds, value);
        for (const value of retrievalSnapshotIds) releaseCountedRoot(roots.retrievalSnapshotIds, value);
        if (inFlightSearchArtifactRootsEmpty(roots)) this.inFlightSearchArtifactRoots.delete(paths.storeId);
      },
    };
  }

  private reserveSnapshotPinArtifacts(
    paths: SearchStoreCachePaths,
    snapshotId: string,
  ): SearchArtifactGcReservation | undefined {
    const loaded = this.loaded.get(loadedKey(paths.storeId, snapshotId));
    const envelope = loaded?.envelope ?? this.readSnapshotEnvelope(paths, snapshotId);
    return envelope ? this.reserveInFlightSearchArtifacts(paths, { snapshot: envelope }) : undefined;
  }

  private addInFlightSearchArtifactGcRoots(paths: SearchStoreCachePaths, roots: GcRoots): void {
    const inFlight = this.inFlightSearchArtifactRoots.get(paths.storeId);
    if (!inFlight) return;
    for (const value of inFlight.snapshotIds.keys()) roots.snapshotIds.add(value);
    for (const value of inFlight.segmentHashes.keys()) roots.segmentHashes.add(value);
    for (const value of inFlight.linkGraphIds.keys()) roots.linkGraphIds.add(value);
    for (const value of inFlight.retrievalSnapshotIds.keys()) roots.retrievalSnapshotIds.add(value);
  }

  private inFlightSearchArtifactRootsFor(storeId: string): InFlightSearchArtifactRoots {
    let roots = this.inFlightSearchArtifactRoots.get(storeId);
    if (!roots) {
      roots = {
        snapshotIds: new Map(),
        segmentHashes: new Map(),
        linkGraphIds: new Map(),
        retrievalSnapshotIds: new Map(),
      };
      this.inFlightSearchArtifactRoots.set(storeId, roots);
    }
    return roots;
  }

  private async addRetrievalSnapshotGcRoots(
    roots: GcRoots,
    paths: SearchStoreCachePaths,
    retrieval: RetrievalSnapshotEnvelope,
  ): Promise<void> {
    roots.retrievalSnapshotIds.add(retrieval.retrievalSnapshotId);
    roots.snapshotIds.add(retrieval.snapshotId);
    roots.linkGraphIds.add(retrieval.linkGraphId);
    const envelope = await this.readSnapshotEnvelopeAsync(paths, retrieval.snapshotId);
    if (envelope) addSnapshotEnvelopeGcRoots(roots, envelope);
    addRetrievalVectorGcRoot(roots.vectorGenerationKeys, paths, this.profileHash, retrieval);
  }

  private queueGc(paths: SearchStoreCachePaths): void {
    if (this.gcClosed) return;
    const vaultKey = paths.vaultStateHash;
    if (this.queuedGcVaults.has(vaultKey)) return;
    this.queuedGcVaults.add(vaultKey);
    const scheduled = setImmediate(() => {
      this.gcImmediateHandles.delete(scheduled);
      if (this.gcClosed) {
        this.queuedGcVaults.delete(vaultKey);
        return;
      }
      void this.requestGc(paths).catch(() => undefined);
    });
    this.gcImmediateHandles.add(scheduled);
    scheduled.unref?.();
  }

  private async requestGc(paths: SearchStoreCachePaths): Promise<void> {
    this.ensureDirs(paths);
    const vaultKey = paths.vaultStateHash;
    if (this.gcClosed) {
      this.queuedGcVaults.delete(vaultKey);
      return;
    }
    const previous = this.gcChains.get(vaultKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.gcClosed) {
          this.queuedGcVaults.delete(vaultKey);
          return;
        }
        if ((this.lifecycleStoreRefs.get(paths.storeId) ?? 0) > 0) {
          const retry = setTimeout(() => {
            this.gcRetryHandles.delete(retry);
            if (this.gcClosed) {
              this.queuedGcVaults.delete(vaultKey);
              return;
            }
            void this.requestGc(paths).catch(() => undefined);
          }, 10);
          this.gcRetryHandles.add(retry);
          retry.unref?.();
          return;
        }
        this.queuedGcVaults.delete(vaultKey);
        // GC is best-effort cleanup, not part of the edition publication contract. Keep it on a
        // coalesced per-vault chain so publisher-lane drains and save/dense intents cannot wedge
        // behind sweeping. Safety still comes from per-candidate root recompute plus writer-token
        // validation immediately before each search-artifact unlink.
        if (this.gcClosed) return;
        await this.runBackgroundGc(paths);
      })
      .finally(() => {
        if (this.gcChains.get(vaultKey) === current) this.gcChains.delete(vaultKey);
      });
    this.gcChains.set(vaultKey, current);
    await current;
  }

  private async runBackgroundGc(paths: SearchStoreCachePaths): Promise<void> {
    this.ensureDirs(paths);
    await this.markSweepSearchGc(paths);
    await this.markSweepVectorGc(paths);
    await sweepStaleTmpDirAsync(paths.tmpDir);
  }

  private async markSweepSearchGc(paths: SearchStoreCachePaths): Promise<void> {
    for (const file of await safeReadDirAsync(paths.retrievalsDir)) {
      if (await this.retrievalSnapshotIsProtected(paths, file)) continue;
      await this.unlinkSearchGcCandidate(path.join(paths.retrievalsDir, file), { force: true });
    }
    for (const file of await safeReadDirAsync(paths.snapshotsDir)) {
      if (await this.snapshotIsProtectedForGc(paths, file)) continue;
      await this.unlinkSearchGcCandidate(path.join(paths.snapshotsDir, file), { force: true });
    }
    for (const file of await safeReadDirAsync(paths.segmentsDir)) {
      if (await this.segmentIsProtectedForGc(paths, file)) continue;
      await this.unlinkSearchGcCandidate(path.join(paths.segmentsDir, file), { force: true });
    }
    for (const file of await safeReadDirAsync(paths.linkGraphsDir)) {
      if (!isValidSnapshotId(file)) continue;
      if (await this.linkGraphIsProtectedForGc(paths, file)) continue;
      await this.unlinkSearchGcCandidate(path.join(paths.linkGraphsDir, file), { force: true });
    }
  }

  private async unlinkSearchGcCandidate(
    target: string,
    options: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    await this.assertCurrentWriterForSearchGcUnlink();
    await rmBestEffort(target, options);
  }

  private async assertCurrentWriterForSearchGcUnlink(): Promise<void> {
    const writerToken = this.tenancyFence.writerToken;
    if (!writerToken) throw new Error('search GC deletion rejected: writer token is unavailable');
    const current = await this.tenancyFence.currentWriterToken();
    if (!current || !currentWriterTokensEqual(current, writerToken)) {
      throw new Error('search GC deletion rejected: writer token is no longer current');
    }
  }

  private async retrievalSnapshotIsProtected(
    paths: SearchStoreCachePaths,
    retrievalSnapshotId: string,
  ): Promise<boolean> {
    return (await this.gcRootsAsync(paths)).retrievalSnapshotIds.has(retrievalSnapshotId);
  }

  private async snapshotIsProtectedForGc(paths: SearchStoreCachePaths, snapshotId: string): Promise<boolean> {
    return (await this.gcRootsAsync(paths)).snapshotIds.has(snapshotId);
  }

  private async segmentIsProtectedForGc(paths: SearchStoreCachePaths, segmentHash: string): Promise<boolean> {
    return (await this.gcRootsAsync(paths)).segmentHashes.has(segmentHash);
  }

  private async linkGraphIsProtectedForGc(paths: SearchStoreCachePaths, linkGraphId: LinkGraphId): Promise<boolean> {
    return (await this.gcRootsAsync(paths)).linkGraphIds.has(linkGraphId);
  }

  private async markSweepVectorGc(paths: SearchStoreCachePaths): Promise<void> {
    const probe = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: '__gc_probe__',
      env: this.env,
    });
    const removedStoreIds: string[] = [];
    // The vector store directory is shared across every ledger (profile / lexical variant) with the
    // same (vaultStateHash, embeddingSetId) — the redesign dropped the profileHash partition. So
    // reclamation MUST NOT use this runtime's per-lexicalIdentityHash GC roots (they would delete a
    // generation another ledger still names fresh, or an in-flight build). Route each embedding
    // set through the daemon-wide SharedReclamationAuthority: it computes the live-manifest set from
    // the ON-DISK edition heads of ALL ledgers sharing the store, honors build reservations and this
    // pool's in-memory pins, and serializes the sweep per shared-artifact key under an ExclusiveClaim.
    const pinnedManifests = this.vectorPool?.pinnedManifestHashes() ?? new Set<string>();
    for (const embeddingSetDir of await safeReadDirAsync(probe.vaultDir)) {
      const storeRoot = path.join(probe.vaultDir, embeddingSetDir);
      if (!(await isDirectoryPathAsync(storeRoot))) continue;
      const vectorPaths = vectorStoreCachePaths({
        vaultRoot: paths.vaultRoot,
        profileHash: this.profileHash,
        embeddingSetId: embeddingSetDir,
        env: this.env,
      });
      await this.reclamationAuthority.sweepVectorGenerations({
        sharedKey: `${paths.vaultStateHash}:vector:${embeddingSetDir}`,
        searchStoresDir: paths.storesDir,
        generationsDir: vectorPaths.generationsDir,
        reservationsDir: vectorPaths.reservationsDir,
        claimDir: path.join(vectorPaths.rootDir, 'gc.claim'),
        vaultStateHash: paths.vaultStateHash,
        embeddingSetId: embeddingSetDir,
        // A generation is also protected by this runtime's in-memory retrieval GC pins
        // (`pinnedVectorGenerations`, keyed by manifest hash) — this covers a generation held by an
        // in-flight retrieve whose lazy-open has not yet produced a pool handle, and by a reader
        // pinning a non-head generation the on-disk edition union no longer names.
        refCountForManifest: (manifestHash) => {
          if (pinnedManifests.has(manifestHash)) return 1;
          const pinKey = vectorGenerationGcKeyForVectorKey(vectorPaths.key, manifestHash);
          return (this.pinnedVectorGenerations.get(pinKey) ?? 0) > 0 ? 1 : 0;
        },
      });
      let hasGenerations = false;
      for (const entry of await safeReadDirAsync(vectorPaths.generationsDir)) {
        if (await isDirectoryPathAsync(path.join(vectorPaths.generationsDir, entry))) {
          hasGenerations = true;
          break;
        }
      }
      // The store root is only removable when the authority left zero generation dirs AND no ledger
      // (across the whole vault) still names this embedding set fresh — otherwise a sibling ledger's
      // live store would be dropped from disk and the catalog.
      const liveManifests = this.reclamationAuthority.liveVectorManifestHashes({
        searchStoresDir: paths.storesDir,
        vaultStateHash: paths.vaultStateHash,
        embeddingSetId: embeddingSetDir,
      });
      if (!hasGenerations && liveManifests.size === 0) {
        // Only record the store as removed if the directory actually went away; otherwise the
        // catalog would drop a store whose files still exist on disk.
        try {
          await fs.promises.rm(vectorPaths.rootDir, { recursive: true, force: true });
          removedStoreIds.push(vectorStoreId(vectorPaths));
        } catch {
          // Best-effort GC; the catalog only records removal after the directory is gone.
        }
      }
    }
    if (removedStoreIds.length > 0) {
      new VectorCacheCatalog({ env: this.env }).removeStoreIds(removedStoreIds);
    }
  }

  private async vectorGenerationIsProtected(paths: SearchStoreCachePaths, key: string): Promise<boolean> {
    return (await this.gcRootsAsync(paths)).vectorGenerationKeys.has(key);
  }

  private async vectorStoreHasProtectedGeneration(
    paths: SearchStoreCachePaths,
    embeddingSetId: string,
  ): Promise<boolean> {
    return hasProtectedVectorStoreGeneration(
      (await this.gcRootsAsync(paths)).vectorGenerationKeys,
      this.profileHash,
      paths.vaultStateHash,
      embeddingSetId,
    );
  }

  private retainPinnedVectorGeneration(pin: PinnedRetrievalSnapshot): void {
    const key = vectorGenerationGcKeyForVectorKey(pin.vectorKey, pin.vector.manifestHash);
    this.pinnedVectorGenerations.set(key, (this.pinnedVectorGenerations.get(key) ?? 0) + 1);
  }

  private releasePinnedVectorGeneration(pin: PinnedRetrievalSnapshot): void {
    const key = vectorGenerationGcKeyForVectorKey(pin.vectorKey, pin.vector.manifestHash);
    this.releaseVectorGenerationGcKey(key);
  }

  private retainDenseGenerationGcPin(pin: DenseGenerationPin['gcPin']): void {
    const key = vectorGenerationGcKeyForVectorKey(pin.vectorKey, pin.generationId);
    this.pinnedVectorGenerations.set(key, (this.pinnedVectorGenerations.get(key) ?? 0) + 1);
  }

  private releaseDenseGenerationGcPin(pin: DenseGenerationPin['gcPin']): void {
    this.releaseVectorGenerationGcKey(vectorGenerationGcKeyForVectorKey(pin.vectorKey, pin.generationId));
  }

  private releaseVectorGenerationGcKey(key: string): void {
    const next = (this.pinnedVectorGenerations.get(key) ?? 1) - 1;
    if (next > 0) this.pinnedVectorGenerations.set(key, next);
    else this.pinnedVectorGenerations.delete(key);
  }

  private async recoverVault(paths: SearchStoreCachePaths): Promise<void> {
    this.ensureDirs(paths);
  }

  private reusableBaseForSnapshot(paths: SearchStoreCachePaths, snapshotId: string): ReusableBaseCandidate {
    try {
      const envelope = this.readSnapshotEnvelope(paths, snapshotId);
      if (!envelope) return { ok: false, reason: 'invalid or absent base envelope' };
      const expected = this.analyzer
        ? snapshotIdentityTuple(this.analyzer, this.partitionBits, this.searchSettings)
        : snapshotIdentityTupleForAnalyzerIdentity(this.analyzerIdentity, this.partitionBits, this.searchSettings);
      if (!snapshotIdentityTupleEquals(envelope.manifest.identityTuple, expected)) {
        return { ok: false, reason: 'identity tuple mismatch' };
      }
      const runningBaseReuseIdentity = this.baseReuseImplementationIdentity.identity;
      if (!runningBaseReuseIdentity) {
        return {
          ok: false,
          reason: this.baseReuseImplementationIdentity.warning ?? 'base-reuse implementation identity unavailable',
        };
      }
      if (!envelope.baseReuseImplementationIdentity) {
        return { ok: false, reason: 'base envelope is missing base-reuse implementation identity' };
      }
      if (envelope.baseReuseImplementationIdentity !== runningBaseReuseIdentity) {
        return { ok: false, reason: 'base-reuse implementation identity mismatch' };
      }
      validateReusableBaseEnvelope(paths, envelope, this.partitionBits);
      return {
        ok: true,
        base: {
          envelope,
          segmentsDir: paths.segmentsDir,
          baseReuseImplementationIdentity: envelope.baseReuseImplementationIdentity,
        },
      };
    } catch (error) {
      return { ok: false, reason: `invalid base envelope: ${errorMessage(error)}` };
    }
  }

  private readSnapshotEnvelope(paths: SearchStoreCachePaths, snapshotId: string): SnapshotEnvelope | undefined {
    if (!isValidSnapshotId(snapshotId)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.snapshotsDir, snapshotId), 'utf8')) as unknown;
      if (!isSnapshotEnvelope(parsed)) return undefined;
      const actual = snapshotIdFromManifest(parsed.manifest);
      if (actual !== parsed.snapshotId || parsed.snapshotId !== snapshotId) return undefined;
      if (!linkGraphSidecarExists(paths, parsed.linkGraphId)) return undefined;
      for (const partition of parsed.manifest.partitions) {
        if (!fs.existsSync(safeSegmentPath(paths.segmentsDir, partition.segmentHash))) return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async readSnapshotEnvelopeAsync(
    paths: SearchStoreCachePaths,
    snapshotId: string,
  ): Promise<SnapshotEnvelope | undefined> {
    if (!isValidSnapshotId(snapshotId)) return undefined;
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(path.join(paths.snapshotsDir, snapshotId), 'utf8'),
      ) as unknown;
      if (!isSnapshotEnvelope(parsed)) return undefined;
      const actual = snapshotIdFromManifest(parsed.manifest);
      if (actual !== parsed.snapshotId || parsed.snapshotId !== snapshotId) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private readRetrievalSnapshotEnvelope(
    paths: SearchStoreCachePaths,
    retrievalSnapshotId: string,
  ): RetrievalSnapshotEnvelope | undefined {
    if (!isValidSnapshotId(retrievalSnapshotId)) return undefined;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(paths.retrievalsDir, retrievalSnapshotId), 'utf8'),
      ) as unknown;
      if (!isRetrievalSnapshotEnvelope(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async readRetrievalSnapshotEnvelopeAsync(
    paths: SearchStoreCachePaths,
    retrievalSnapshotId: string,
  ): Promise<RetrievalSnapshotEnvelope | undefined> {
    if (!isValidSnapshotId(retrievalSnapshotId)) return undefined;
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(path.join(paths.retrievalsDir, retrievalSnapshotId), 'utf8'),
      ) as unknown;
      if (!isRetrievalSnapshotEnvelope(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private snapshotIsFresh(paths: SearchStoreCachePaths, snapshotId: string): boolean {
    const delta = this.snapshotContentDelta(paths, snapshotId);
    return delta !== undefined && delta.changedCount === 0;
  }

  private snapshotContentDelta(paths: SearchStoreCachePaths, snapshotId: string): SnapshotContentDelta | undefined {
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) return undefined;
    const current = currentContentHashes(paths.vaultRoot);
    const previous = new Map(envelope.documents.map((document) => [document.path, document.contentHash]));
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [rel, hash] of current) {
      const before = previous.get(rel);
      if (before === undefined) added.push(rel);
      else if (before !== hash) modified.push(rel);
    }
    for (const document of envelope.documents) {
      if (!current.has(document.path)) deleted.push(document.path);
    }
    added.sort(compareCodePoint);
    modified.sort(compareCodePoint);
    deleted.sort(compareCodePoint);
    return {
      added,
      modified,
      deleted,
      changedCount: added.length + modified.length + deleted.length,
    };
  }

  private snapshotIdentityMatches(paths: SearchStoreCachePaths, snapshotId: string): boolean {
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) return false;
    const expected = this.analyzer
      ? snapshotIdentityTuple(this.analyzer, this.partitionBits, this.searchSettings)
      : snapshotIdentityTupleForAnalyzerIdentity(this.analyzerIdentity, this.partitionBits, this.searchSettings);
    return (
      Buffer.compare(
        Buffer.from(canonicalValueBytes(envelope.manifest.identityTuple)),
        Buffer.from(canonicalValueBytes(expected)),
      ) === 0
    );
  }

  private ensureDirs(paths: SearchStoreCachePaths): void {
    ensurePrivateDirSync(paths.cacheRootDir, 'Optsidian cache directory');
    ensurePrivateDirSync(paths.searchRootDir, 'Optsidian search cache directory');
    ensurePrivateDirSync(paths.storesDir, 'Optsidian search cache stores directory');
    ensurePrivateDirSync(paths.rootDir, 'Optsidian search store directory');
    ensurePrivateDirSync(paths.segmentsDir, 'Optsidian search segments directory');
    ensurePrivateDirSync(paths.snapshotsDir, 'Optsidian search snapshots directory');
    ensurePrivateDirSync(paths.retrievalsDir, 'Optsidian retrieval snapshot directory');
    ensurePrivateDirSync(paths.linkGraphsDir, 'Optsidian search link graph directory');
    ensurePrivateDirSync(paths.tmpDir, 'Optsidian search tmp directory');
  }

  private paths(vaultRoot: string): SearchStoreCachePaths {
    return searchStoreCachePaths(vaultRoot, this.env, { lexicalIdentityHash: this.lexicalIdentityHash });
  }

  private publisherFor(
    paths: SearchStoreCachePaths,
    embeddingSpaceId: EmbeddingSpaceId = this.currentEmbeddingSpaceId(),
  ): VaultPublisher {
    const retrievalIdentity = {
      vaultStateHash: paths.vaultStateHash,
      lexicalIdentityHash: paths.lexicalIdentityHash,
      embeddingSpaceId,
    };
    const key = retrievalIdentityKey(retrievalIdentity);
    const existing = this.publisherLeases.get(key);
    if (existing) return existing.publisher;
    const lease = this.publisherRegistry.acquire({
      paths: VaultPublisher.pathsFor(searchStoreLedgerRootDir(paths, embeddingSpaceId)),
      retrievalIdentity,
      tenancyFence: this.tenancyFence,
      effects: this.publisherLaneEffects(paths),
    });
    this.publisherLeases.set(key, lease);
    return lease.publisher;
  }

  private async releasePublisherLeasesForStore(paths: SearchStoreCachePaths, except?: VaultPublisher): Promise<void> {
    const leases: VaultPublisherLease[] = [];
    for (const [key, lease] of this.publisherLeases) {
      const identity = lease.publisher.retrievalIdentity;
      if (identity.vaultStateHash !== paths.vaultStateHash) continue;
      if (identity.lexicalIdentityHash !== paths.lexicalIdentityHash) continue;
      if (except && lease.publisher === except) continue;
      this.publisherLeases.delete(key);
      leases.push(lease);
    }
    await Promise.all(leases.map((lease) => lease.release()));
  }

  private publisherLaneEffects(paths: SearchStoreCachePaths): VaultPublisherEffects {
    return {
      buildSnapshot: async (input) => {
        throwIfAborted(input.signal);
        const context = publisherLaneSnapshotContext(input.intent.requestContext, input.deadline, input.cancellationId);
        const options = this.publisherLaneSnapshotOptions(paths, input.intent, input.head);
        const built = await this.buildSnapshotWithIncrementalFallback(paths, context, options);
        throwIfAborted(input.signal);
        const envelope = snapshotEnvelope(built, this.baseReuseImplementationIdentity.identity);
        context.progress?.({
          phase: 'publishing',
          total: built.segments.length,
          completed: 0,
        });
        const reservation = this.reserveInFlightSearchArtifacts(paths, { snapshot: envelope });
        try {
          await this.publishBuiltSnapshot(paths, built, context, envelope);
          this.cacheCatalog.recordIndexed(paths, {
            snapshotId: built.snapshotId,
            documentCount: built.documents.length,
          });
          context.progress?.({
            phase: 'publishing',
            total: built.segments.length,
            completed: built.segments.length,
          });
          const dense: DenseEdition = {
            state: 'unavailable',
            reason: input.intent.prepareRetrieval ? 'dense-publication-pending' : 'dense-publication-not-requested',
          };
          return {
            kind: 'candidate',
            candidate: this.editionCandidateForSnapshot({
              paths,
              envelope,
              dense,
              scanBoundary: input.intent.scanBoundary,
              head: input.head,
            }),
            cleanup: () => {
              reservation.release();
            },
          };
        } catch (error) {
          reservation.release();
          throw error;
        }
      },
      buildDense: async (input) => {
        throwIfAborted(input.signal);
        const head = input.head;
        if (!head) return { kind: 'drop', reason: 'cannot publish dense edition without a committed lexical edition' };
        const envelope = this.readSnapshotEnvelope(paths, head.corpus.snapshotId);
        if (!envelope) return { kind: 'drop', reason: 'dense target corpus is missing' };
        if (envelope.linkGraphId !== head.linkGraphId || !linkGraphSidecarExists(paths, head.linkGraphId)) {
          return { kind: 'drop', reason: 'dense target link graph is missing' };
        }
        const context = publisherLaneSnapshotContext(input.intent.requestContext, input.deadline, input.cancellationId);
        let publication: RetrievalSnapshotPublication;
        try {
          publication = await this.buildRetrievalSnapshotPublication(
            paths,
            retrievalSnapshotSourceFromEnvelope(envelope),
            envelope,
            context,
          );
        } catch (error) {
          const dense: DenseEdition = {
            state: 'failed',
            buildId: `${head.corpus.snapshotId}:dense`,
            cause: errorMessage(error),
            diagnosticId: `${head.corpus.snapshotId}:dense-failed`,
          };
          return {
            kind: 'candidate',
            candidate: this.editionCandidateForSnapshot({
              paths,
              envelope,
              dense,
              scanBoundary: {
                frontierSeq: head.frontierSeq,
                scanBoundaryJournalSeq: head.scanBoundaryJournalSeq ?? 0,
              },
              head,
            }),
          };
        }
        const searchReservation = this.reserveInFlightSearchArtifacts(paths, { retrieval: publication.envelope });
        try {
          await storeRetrievalSnapshotEnvelope(paths, publication.envelope);
          return {
            kind: 'candidate',
            candidate: this.editionCandidateForSnapshot({
              paths,
              envelope,
              dense: publication.dense,
              retrieval: publication.envelope,
              scanBoundary: {
                frontierSeq: head.frontierSeq,
                scanBoundaryJournalSeq: head.scanBoundaryJournalSeq ?? 0,
              },
              head,
            }),
            cleanup: () => {
              searchReservation.release();
              publication.reservation?.release();
            },
          };
        } catch (error) {
          searchReservation.release();
          publication.reservation?.release();
          throw error;
        }
      },
      clear: async ({ signal }) => {
        throwIfAborted(signal);
        await this.recoverVault(paths);
        throwIfAborted(signal);
        fs.rmSync(paths.ledgersDir, { recursive: true, force: true });
        fsyncDirSync(paths.rootDir);
        this.activeByVault.delete(paths.storeId);
        this.markSweepGc(paths);
        this.cacheCatalog.recordCleared(paths);
      },
      cancelSnapshotEffects: ({ cancellationId }) => {
        this.publisherLaneCancellation.cancelSnapshotEffects?.(cancellationId);
      },
      cancelEmbedScheduler: ({ cancellationId }) => {
        this.publisherLaneCancellation.cancelEmbedScheduler?.(cancellationId);
      },
      cancelWorkerPools: ({ cancellationId }) => {
        this.publisherLaneCancellation.cancelWorkerPools?.(cancellationId);
      },
    };
  }

  private publisherLaneSnapshotOptions(
    paths: SearchStoreCachePaths,
    intent: {
      useActiveBase?: boolean;
      incrementalFallbackReason?: string;
    },
    head: EditionRecord | undefined,
  ): PublishFreshSnapshotOptions {
    if (intent.useActiveBase && head) {
      const baseCandidate = this.reusableBaseForSnapshot(paths, head.corpus.snapshotId);
      if (baseCandidate.ok) return { base: baseCandidate.base };
      return { incrementalFallbackReason: baseCandidate.reason };
    }
    return intent.incrementalFallbackReason ? { incrementalFallbackReason: intent.incrementalFallbackReason } : {};
  }

  private currentEdition(
    paths: SearchStoreCachePaths,
    embeddingSpaceId: EmbeddingSpaceId = this.currentEmbeddingSpaceId(),
  ): EditionRecord | undefined {
    return this.publisherFor(paths, embeddingSpaceId).ledger.current();
  }

  private latestFreshEdition(
    paths: SearchStoreCachePaths,
    embeddingSpaceId: EmbeddingSpaceId = this.currentEmbeddingSpaceId(),
  ): EditionRecord | undefined {
    return this.publisherFor(paths, embeddingSpaceId).ledger.latestFresh();
  }

  private currentWriterToken(): CurrentWriterToken {
    const token = this.tenancyFence.writerToken;
    if (!token) throw new Error('snapshot store tenancy fence does not expose a writer token');
    return token;
  }

  async close(): Promise<void> {
    this.gcClosed = true;
    for (const scheduled of this.gcImmediateHandles) clearImmediate(scheduled);
    this.gcImmediateHandles.clear();
    for (const retry of this.gcRetryHandles) clearTimeout(retry);
    this.gcRetryHandles.clear();
    this.queuedGcVaults.clear();
    await Promise.allSettled([...this.gcChains.values()]);
    const leases = [...this.publisherLeases.values()];
    this.publisherLeases.clear();
    await Promise.all(leases.map((lease) => lease.release()));
  }

  private loadedForPin(pin: PinnedSnapshot): LoadedSnapshot {
    for (const snapshot of this.loaded.values()) {
      if (snapshot.snapshotId === pin.snapshotId && snapshot.pinTokens.has(pin.pinToken)) return snapshot;
    }
    throw new Error(`snapshot pin is not active: ${pin.snapshotId}`);
  }

  private applyVaultAccessRecency(): void {
    const now = Date.now();
    recentVaultAccessRoots({ env: this.env, nowMs: now }).forEach((vaultRoot, index) => {
      try {
        const paths = this.paths(vaultRoot);
        this.vaultAccessMs.set(paths.storeId, now - index);
      } catch {
        // Missing vault recency entries are ignored by eviction.
      }
    });
  }

  private async withLifecycleStore<T>(paths: SearchStoreCachePaths, fn: () => Promise<T>): Promise<T> {
    retainLifecycleStore(this.lifecycleStoreRefs, paths.storeId);
    try {
      return await fn();
    } finally {
      releaseLifecycleStore(this.lifecycleStoreRefs, paths.storeId);
    }
  }
}

export function createDaemonSnapshotStore(options: DaemonSnapshotStoreOptions = {}): DaemonSnapshotStore {
  return new DaemonSnapshotStore(options);
}

export function createProviderEmbeddingSetBuilder(provider: EmbeddingProvider): RetrievalEmbeddingSetBuilder {
  const recipe = embeddingRecipeIdentityForProvider(provider);
  return {
    providerIdentity: provider.identity,
    recipeIdentity: recipe,
    async build(input) {
      const total = input.documents.length;
      const interval = progressReportInterval(total);
      let completed = 0;
      input.progress?.({ phase: 'embedding', total, completed: 0 });
      const vectors = new Array<EmbeddingVector>(total);
      await Promise.all(
        input.documents.map(async (document, index) => {
          vectors[index] = await provider.embed(document.text, { inputKind: 'document' });
          completed += 1;
          if (completed === total || completed % interval === 0) {
            input.progress?.({
              phase: 'embedding',
              total,
              completed,
              current: document.path,
              message: `${completed} vectors`,
            });
          }
        }),
      );
      return buildEmbeddingSetFromVectors({
        provider: provider.identity,
        recipe,
        documents: input.documents,
        vectors,
      });
    },
  };
}

export function createWorkerEmbeddingSetBuilder(input: {
  provider: EmbeddingProvider;
  providerPayload: ModelProviderPayload;
  embedding: ScheduledEmbeddingEncoder;
  batchSize?: number;
}): RetrievalEmbeddingSetBuilder {
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? EMBEDDING_DOCUMENT_SLICE_SIZE));
  const recipe = embeddingRecipeIdentityForProvider(input.provider);
  const activeWorkSets = new Map<RetrievalEmbeddingBuildLane, DocIdKeyedEmbeddingWorkSet>();
  const nextIncremental = new Map<RetrievalEmbeddingBuildLane, DocIdKeyedDocumentSet>();
  const enqueueNextIncremental = (
    lane: RetrievalEmbeddingBuildLane,
    document: EmbeddingSetDocumentInput,
    reason: RetrievalEmbeddingBuildFoldResult['reason'],
  ): RetrievalEmbeddingBuildFoldResult => {
    let pending = nextIncremental.get(lane);
    if (!pending) {
      pending = new DocIdKeyedDocumentSet();
      nextIncremental.set(lane, pending);
    }
    pending.upsert(document);
    return {
      target: 'next',
      lane,
      reason,
      pendingCount: pending.size,
    };
  };
  return {
    providerIdentity: input.provider.identity,
    recipeIdentity: recipe,
    foldQueuedDocument(lane, document) {
      const nextLane = embeddingBuildLane(lane);
      for (const activeLane of BACKGROUND_EMBEDDING_BUILD_LANES) {
        const workSet = activeWorkSets.get(activeLane);
        if (!workSet) continue;
        const state = workSet.stateFor(document.documentId);
        if (state === 'queued' && workSet.replaceQueued(document)) {
          return {
            target: 'current',
            lane: activeLane,
            reason: 'queued',
            pendingCount: workSet.pendingCount,
          };
        }
        if (state === 'in-flight' || state === 'embedded') {
          return enqueueNextIncremental(nextLane, document, state);
        }
      }
      return enqueueNextIncremental(nextLane, document, 'not-active');
    },
    drainNextIncrementalDocuments(lane) {
      const pending = nextIncremental.get(lane);
      if (!pending) return [];
      nextIncremental.delete(lane);
      return pending.documents();
    },
    async build(builderInput) {
      const lane = embeddingBuildLane(builderInput.embeddingLane);
      if (activeWorkSets.has(lane)) {
        throw new Error(`embedding build lane ${lane} already has an active docId work set`);
      }
      const workSet = new DocIdKeyedEmbeddingWorkSet(builderInput.documents);
      activeWorkSets.set(lane, workSet);
      const build = async () => {
        const total = workSet.totalCount;
        builderInput.progress?.({ phase: 'embedding', total, completed: 0 });
        while (workSet.hasQueuedDocuments()) {
          const batch = workSet.takeBatch(batchSize);
          const encoded = await input.embedding.encode(
            {
              texts: batch.map((document) => document.text),
              inputKind: 'document',
              provider: input.providerPayload,
            },
            {
              deadline: builderInput.deadline ?? Date.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
              cancellationId: builderInput.cancellationId ?? `${builderInput.vaultRoot}:embedding-build`,
              vault: builderInput.vaultRoot,
              onProgress: builderInput.progress,
            },
            lane,
          );
          assertProviderIdentityMatches(encoded.provider, input.provider.identity);
          if (encoded.vectors.length !== batch.length) {
            throw new Error(
              `embedding worker returned ${encoded.vectors.length} vectors for ${batch.length} documents`,
            );
          }
          workSet.completeBatch(batch, encoded.vectors);
          builderInput.progress?.({
            phase: 'embedding',
            total,
            completed: workSet.completedCount,
            current: batch[batch.length - 1]?.path,
            message: `${workSet.completedCount} vectors`,
          });
        }
        return buildEmbeddingSetFromVectors({
          provider: input.provider.identity,
          recipe,
          documents: workSet.completedDocuments,
          vectors: workSet.completedVectors,
        });
      };
      try {
        return await (input.embedding.withLaneScope ? input.embedding.withLaneScope(lane, build) : build());
      } finally {
        if (activeWorkSets.get(lane) === workSet) activeWorkSets.delete(lane);
      }
    },
  };
}

// Per-write random suffix so two concurrent builds in the same process (e.g. a manual Rebuild
// racing a save-lane publish) never target an identical tmp path — otherwise the first rename moves
// the shared tmp away and the second fails with a spurious ENOENT. Leftover tmps are still swept by
// mtime in sweepStaleTmpDir.
function randomTmpSuffix(): string {
  return crypto.randomBytes(8).toString('hex');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = 'reason' in signal ? (signal as { readonly reason?: unknown }).reason : undefined;
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error(typeof reason === 'string' ? reason : 'operation aborted'), { code: 'CANCELLED' });
}

function embeddingBuildLane(lane: EmbedSchedulerLane | undefined): RetrievalEmbeddingBuildLane {
  if (lane === 'save' || lane === 'refresh' || lane === 'rebuild') return lane;
  return 'rebuild';
}

class DocIdKeyedDocumentSet {
  private readonly order: string[] = [];
  private readonly byDocId = new Map<string, EmbeddingSetDocumentInput>();

  constructor(documents: readonly EmbeddingSetDocumentInput[] = []) {
    for (const document of documents) this.upsert(document);
  }

  get size(): number {
    return this.byDocId.size;
  }

  upsert(document: EmbeddingSetDocumentInput): void {
    if (!this.byDocId.has(document.documentId)) this.order.push(document.documentId);
    this.byDocId.set(document.documentId, { ...document });
  }

  replace(document: EmbeddingSetDocumentInput): boolean {
    if (!this.byDocId.has(document.documentId)) return false;
    this.byDocId.set(document.documentId, { ...document });
    return true;
  }

  takeBatch(limit: number): EmbeddingSetDocumentInput[] {
    const batch: EmbeddingSetDocumentInput[] = [];
    while (batch.length < limit && this.order.length > 0) {
      const documentId = this.order.shift();
      if (!documentId) continue;
      const document = this.byDocId.get(documentId);
      if (!document) continue;
      this.byDocId.delete(documentId);
      batch.push(document);
    }
    return batch;
  }

  has(documentId: string): boolean {
    return this.byDocId.has(documentId);
  }

  documents(): EmbeddingSetDocumentInput[] {
    const documents: EmbeddingSetDocumentInput[] = [];
    for (const documentId of this.order) {
      const document = this.byDocId.get(documentId);
      if (document) documents.push(document);
    }
    return documents;
  }
}

class DocIdKeyedEmbeddingWorkSet {
  private readonly queued: DocIdKeyedDocumentSet;
  private readonly inFlight = new Set<string>();
  private readonly embedded = new Set<string>();
  private readonly documents: EmbeddingSetDocumentInput[] = [];
  private readonly vectors: EmbeddingVector[] = [];
  readonly totalCount: number;

  constructor(documents: readonly EmbeddingSetDocumentInput[]) {
    this.queued = new DocIdKeyedDocumentSet(documents);
    this.totalCount = this.queued.size;
  }

  get pendingCount(): number {
    return this.queued.size;
  }

  get completedCount(): number {
    return this.documents.length;
  }

  get completedDocuments(): readonly EmbeddingSetDocumentInput[] {
    return this.documents;
  }

  get completedVectors(): readonly EmbeddingVector[] {
    return this.vectors;
  }

  hasQueuedDocuments(): boolean {
    return this.queued.size > 0;
  }

  takeBatch(limit: number): EmbeddingSetDocumentInput[] {
    const batch = this.queued.takeBatch(limit);
    for (const document of batch) this.inFlight.add(document.documentId);
    return batch;
  }

  completeBatch(batch: readonly EmbeddingSetDocumentInput[], vectors: readonly EmbeddingVector[]): void {
    if (batch.length !== vectors.length) {
      throw new Error(
        `embedding work-set vector count ${vectors.length} does not match document count ${batch.length}`,
      );
    }
    for (let index = 0; index < batch.length; index += 1) {
      const document = batch[index];
      const vector = vectors[index];
      if (!document || !vector) continue;
      this.inFlight.delete(document.documentId);
      this.embedded.add(document.documentId);
      this.documents.push(document);
      this.vectors.push(vector);
    }
  }

  replaceQueued(document: EmbeddingSetDocumentInput): boolean {
    return this.queued.replace(document);
  }

  stateFor(documentId: string): RetrievalEmbeddingBuildFoldResult['reason'] {
    if (this.queued.has(documentId)) return 'queued';
    if (this.inFlight.has(documentId)) return 'in-flight';
    if (this.embedded.has(documentId)) return 'embedded';
    return 'not-active';
  }
}

function createLocalOnnxEmbeddingSetBuilder(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): RetrievalEmbeddingSetBuilder {
  return createProviderEmbeddingSetBuilder(createLocalOnnxProviderFromConfig(settings, env));
}

function createConfiguredEmbeddingSetBuilder(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): RetrievalEmbeddingSetBuilder {
  const provider = env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (provider === 'deterministic-hash' || provider === 'deterministic') {
    return createProviderEmbeddingSetBuilder(new DeterministicHashProvider());
  }
  return createLocalOnnxEmbeddingSetBuilder(settings, env);
}

function snapshotEnvelope(built: BuiltSnapshot, baseReuseImplementationIdentity?: string): SnapshotEnvelope {
  return {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    snapshotId: built.snapshotId,
    corpusSnapshotId: built.corpusSnapshotId,
    linkGraphId: built.linkGraphId,
    ...(baseReuseImplementationIdentity ? { baseReuseImplementationIdentity } : {}),
    manifest: built.manifest,
    canonicalManifestSha256: built.canonicalManifestSha256,
    documents: built.documents,
    diagnostics: built.diagnostics,
  };
}

export function computeRetrievalSnapshotId(input: {
  corpusSnapshotId: string;
  linkGraphId: string;
  embeddingSetId: string;
  retrieverPlanIdentity: string;
  rankingFeatureVersion: string;
}): RetrievalSnapshotId {
  return sha256(
    canonicalValueBytes({
      corpusSnapshotId: input.corpusSnapshotId,
      linkGraphId: input.linkGraphId,
      embeddingSetId: input.embeddingSetId,
      retrieverPlanIdentity: input.retrieverPlanIdentity,
      rankingFeatureVersion: input.rankingFeatureVersion,
    }),
  );
}

function retrievalSnapshotSourceFromEnvelope(envelope: SnapshotEnvelope): RetrievalSnapshotSource {
  return {
    snapshotId: envelope.snapshotId,
    corpusSnapshotId: envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(envelope.manifest),
    identityTuple: envelope.manifest.identityTuple,
    documents: envelope.documents,
    linkGraphId: envelope.linkGraphId,
  };
}

function denseEmbeddingSpaceForEdition(dense: DenseEdition, fallback: EmbeddingSpaceId): EmbeddingSpaceId {
  return dense.state === 'fresh' ? dense.embeddingSpaceId : fallback;
}

function denseDocumentsForRetrievalSource(source: RetrievalSnapshotSource): EmbeddingSetDocumentInput[] {
  return source.documents.map((document) => ({
    documentId: document.documentId,
    shardDocRef: {
      segmentId: '',
      partitionId: document.partitionId,
      localDocId: 0,
      documentId: document.documentId,
    },
    path: document.path,
    text: denseTextForDocument(document),
    contentHash: document.contentHash,
  }));
}

function backgroundEmbeddingLane(lane: EmbedSchedulerLane | undefined): RetrievalEmbeddingBuildLane | undefined {
  if (lane === 'save' || lane === 'refresh' || lane === 'rebuild') return lane;
  return undefined;
}

function mergeEmbeddingDocuments(
  base: readonly EmbeddingSetDocumentInput[],
  replacements: readonly EmbeddingSetDocumentInput[],
): EmbeddingSetDocumentInput[] {
  if (replacements.length === 0) return [...base];
  const order = base.map((document) => document.documentId);
  const byDocId = new Map(base.map((document) => [document.documentId, document]));
  for (const replacement of replacements) {
    if (byDocId.has(replacement.documentId)) byDocId.set(replacement.documentId, replacement);
  }
  return order.flatMap((documentId) => {
    const document = byDocId.get(documentId);
    return document ? [document] : [];
  });
}

function denseTextForDocument(document: PersistedDocumentRecord): string {
  const snippets = document.snippetCorpus.lines.map((line) => line.text).join('\n');
  const tags = document.tags.length > 0 ? `\n${document.tags.join(' ')}` : '';
  return `${document.title}\n${document.path}\n${snippets}${tags}`.trim();
}

function retrievalEmbeddingSetEnvelope(embeddingSet: {
  embeddingSetId: EmbeddingSetId;
  recipe: EmbeddingRecipeIdentity;
  model: string;
  dim: number;
  records: readonly EmbeddingSetRecord[];
}): RetrievalEmbeddingSetEnvelope {
  return {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    embeddingSetId: embeddingSet.embeddingSetId,
    recipe: embeddingSet.recipe,
    model: embeddingSet.model,
    dim: embeddingSet.dim,
    records: embeddingSet.records.map(({ shardDocRef: _shardDocRef, ...record }) => record),
  };
}

function vectorChunksForEmbeddingSet(
  records: readonly EmbeddingSetRecord[],
  spec: CoralEmbeddingSpec,
): CoralChunkRecord[] {
  return records.map((record) => ({
    id: `${record.documentId}:0`,
    entryId: record.documentId,
    entryKind: 'note',
    chunkIndex: 0,
    text: record.text,
    contentHash: record.contentHash,
    vector: record.vector,
    specId: spec.specId,
  }));
}

function assertProviderIdentityMatches(actual: EmbeddingProviderIdentity, expected: EmbeddingProviderIdentity): void {
  if (
    actual.id !== expected.id ||
    actual.model !== expected.model ||
    actual.dim !== expected.dim ||
    actual.version !== expected.version
  ) {
    throw new Error(
      `embedding provider identity mismatch: expected ${expected.id}/${expected.model}/${expected.dim}/${expected.version}, ` +
        `got ${actual.id}/${actual.model}/${actual.dim}/${actual.version}`,
    );
  }
}

function currentRetrievalIdentity(input: {
  linkGraphId: LinkGraphId;
  rankingFeatureVersion: string;
  provider: EmbeddingProviderIdentity;
}): {
  provider: EmbeddingProviderIdentity;
  retrieverPlanIdentity: string;
  rankingFeatureVersion: string;
} {
  const provider = input.provider;
  return {
    provider,
    retrieverPlanIdentity: retrievalPlanIdentityFor({
      linkGraphId: input.linkGraphId,
      denseModel: provider.model,
    }),
    rankingFeatureVersion: input.rankingFeatureVersion,
  };
}

function denseUsabilityForLiveDocuments(liveDocuments: ReadonlyMap<string, PersistedDocumentRecord>): DenseUsability {
  return {
    spaceMatch: false,
    usableDocumentIds: new Set(),
    pendingDocumentIds: new Set(liveDocuments.keys()),
  };
}

function denseUsabilityForRecords(
  liveDocuments: ReadonlyMap<string, PersistedDocumentRecord>,
  recordsByDocumentId: ReadonlyMap<string, Pick<RetrievalEmbeddingSetEnvelope['records'][number], 'contentHash'>>,
  spaceMatch: boolean,
): DenseUsability {
  const usableDocumentIds = new Set<string>();
  const pendingDocumentIds = new Set<string>();
  for (const document of liveDocuments.values()) {
    const record = recordsByDocumentId.get(document.documentId);
    if (spaceMatch && record?.contentHash === document.contentHash) {
      usableDocumentIds.add(document.documentId);
    } else {
      pendingDocumentIds.add(document.documentId);
    }
  }
  return { spaceMatch, usableDocumentIds, pendingDocumentIds };
}

function coldDenseSignal(pendingCount: number): DenseSignal {
  return {
    state: 'cold',
    pendingCount,
    generationAgeMs: null,
  };
}

function denseSignalForUsability(input: {
  retrieval: RetrievalSnapshotEnvelope;
  metadata: VectorGenerationMetadata;
  usability: DenseUsability;
}): DenseSignal {
  const pendingCount = input.usability.pendingDocumentIds.size;
  const ageMs = generationAgeMs(input.metadata);
  if (!input.usability.spaceMatch) {
    return { state: 'rebuilding', pendingCount, generationAgeMs: ageMs };
  }
  if (pendingCount > 0) {
    return { state: 'stale', pendingCount, generationAgeMs: ageMs };
  }
  return { state: 'fresh', pendingCount, generationAgeMs: ageMs };
}

function generationAgeMs(metadata: VectorGenerationMetadata): number | null {
  const created = Date.parse(metadata.createdAt);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, Date.now() - created);
}

function retrievalPlanIdentityFor(input: { linkGraphId: LinkGraphId; denseModel: string }): string {
  const retrievers: RetrieverIdentity[] = [
    POSITIONAL_RETRIEVER_IDENTITY,
    {
      id: 'dense',
      version: DENSE_RETRIEVER_VERSION,
      parameters: { model: input.denseModel, metric: 'cosine' },
    },
    {
      id: 'link-adjacency',
      version: LINK_ADJACENCY_RETRIEVER_VERSION,
      parameters: {
        linkGraphId: input.linkGraphId,
        resolverVersion: LINK_GRAPH_RESOLVER_VERSION,
        scoring: LINK_ADJACENCY_SCORING_VERSION,
        directScore: LINK_ADJACENCY_DIRECT_SCORE,
      },
    },
  ];
  const parameters: FusionParameters = {
    algorithm: 'rrf',
    k: DEFAULT_RRF_K,
    weights: retrievers.map((identity) => ({ retrieverId: identity.id, weight: 1 })),
  };
  return computeRetrieverPlanIdentity(retrievers, parameters);
}

async function storeRetrievalSnapshotEnvelope(
  paths: SearchStoreCachePaths,
  envelope: RetrievalSnapshotEnvelope,
): Promise<void> {
  ensurePrivateDirSync(paths.retrievalsDir, 'Optsidian retrieval snapshot directory');
  ensurePrivateDirSync(paths.tmpDir, 'Optsidian search tmp directory');
  const target = path.join(paths.retrievalsDir, envelope.retrievalSnapshotId);
  const tmp = path.join(
    paths.tmpDir,
    `${envelope.retrievalSnapshotId}.${process.pid}.${randomTmpSuffix()}.retrieval.tmp`,
  );
  writePrivateFileSync(tmp, `${JSON.stringify(envelope)}\n`, 'Optsidian retrieval snapshot envelope');
  fsyncFileSync(tmp);
  await durableRename(tmp, target);
  fsyncDirSync(paths.retrievalsDir);
}

function embeddingSpecId(embeddingSetId: EmbeddingSetId, model: string, dim: number): string {
  return sha256(
    canonicalValueBytes({
      embeddingSetId,
      model,
      dim,
      ann: 'derived',
    }),
  );
}

function linkGraphData(linkGraph: LinkGraphView) {
  return {
    schemaVersion: linkGraph.schemaVersion,
    linkGraphId: linkGraph.linkGraphId,
    corpusSnapshotId: linkGraph.corpusSnapshotId,
    resolverVersion: linkGraph.resolverVersion,
    edges: linkGraph.edges,
    backlinks: linkGraph.backlinks,
  };
}

function envelopePartitionsBySegmentId(envelope: SnapshotEnvelope): SnapshotEnvelope['manifest']['partitions'] {
  return [...envelope.manifest.partitions].sort(
    (left, right) => left.partitionId - right.partitionId || compareCodePoint(left.segmentHash, right.segmentHash),
  );
}

function sharedBytes(bytes: Uint8Array): Uint8Array {
  const shared = new SharedArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(shared);
  view.set(bytes);
  return view;
}

function sharedHandle(bytes: Uint8Array): SharedBytesHandle {
  if (!(bytes.buffer instanceof SharedArrayBuffer)) throw new Error('snapshot bytes are not shared');
  return {
    buffer: bytes.buffer,
    byteOffset: bytes.byteOffset,
    byteLength: bytes.byteLength,
  };
}

function verifyBm25StatsFromVerifiedSegments(
  manifest: SnapshotEnvelope['manifest'],
  segmentStats: readonly (readonly CanonicalBm25FieldStats[])[],
): PositionalBm25GlobalStats {
  const persistedStats = {
    bm25StatsSchemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats,
    bm25GlobalStatsRows: manifest.bm25GlobalStatsRows,
  };
  const persistedHash = canonicalBm25GlobalStatsHash(persistedStats);
  if (persistedHash !== manifest.bm25GlobalStatsHash) {
    throw new Error('BM25 global stats hash mismatch in snapshot manifest');
  }
  const recomputed = reduceCanonicalBm25GlobalStats(segmentStats, SEARCH_TOKEN_CHANNELS);
  if (recomputed.bm25GlobalStatsHash !== manifest.bm25GlobalStatsHash) {
    throw new Error('BM25 global stats mismatch between manifest and verified segment bytes');
  }
  return positionalBm25GlobalStatsFromManifest(manifest);
}

function positionalBm25GlobalStatsFromManifest(manifest: SnapshotEnvelope['manifest']): PositionalBm25GlobalStats {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: searchTokenChannel(entry.channel, 'BM25 corpus stats channel'),
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0,
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: searchTokenChannel(row[0], 'BM25 global stats row channel'),
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3],
    })),
    hash: manifest.bm25GlobalStatsHash,
  };
}

function searchTokenChannel(value: string, label: string): SearchTokenChannel {
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    if (channel === value) return channel;
  }
  throw new Error(`${label} is unsupported: ${value}`);
}

function loadedKey(vaultKey: string, snapshotId: string): string {
  return `${vaultKey}:${snapshotId}`;
}

function addRetrievalVectorGcRoot(
  roots: Set<string>,
  paths: SearchStoreCachePaths,
  _profileHash: string,
  retrieval: RetrievalSnapshotEnvelope,
): void {
  const vectorKey = retrieval.vector.key;
  roots.add(
    vectorGenerationGcKey({
      vaultStateHash: vectorKey?.vaultStateHash ?? paths.vaultStateHash,
      embeddingSetId: vectorKey?.embeddingSetId ?? retrieval.vector.embeddingSetId,
      generationId: retrieval.vector.manifestHash,
    }),
  );
}

function addSnapshotEnvelopeGcRoots(
  roots: Pick<GcRoots, 'snapshotIds' | 'segmentHashes' | 'linkGraphIds'>,
  envelope: SnapshotEnvelope,
): void {
  roots.snapshotIds.add(envelope.snapshotId);
  roots.linkGraphIds.add(envelope.linkGraphId);
  for (const partition of envelope.manifest.partitions) roots.segmentHashes.add(partition.segmentHash);
}

function retainCountedRoot<T>(roots: Map<T, number>, value: T): void {
  roots.set(value, (roots.get(value) ?? 0) + 1);
}

function releaseCountedRoot<T>(roots: Map<T, number>, value: T): void {
  const count = roots.get(value) ?? 0;
  if (count <= 1) roots.delete(value);
  else roots.set(value, count - 1);
}

function inFlightSearchArtifactRootsEmpty(roots: InFlightSearchArtifactRoots): boolean {
  return (
    roots.snapshotIds.size === 0 &&
    roots.segmentHashes.size === 0 &&
    roots.linkGraphIds.size === 0 &&
    roots.retrievalSnapshotIds.size === 0
  );
}

function vectorGenerationGcKey(input: {
  vaultStateHash: string;
  embeddingSetId: string;
  generationId: string;
}): string {
  return [
    safeStoreFileName(input.vaultStateHash),
    safeStoreFileName(input.embeddingSetId),
    safeStoreFileName(input.generationId),
  ].join(':');
}

function vectorGenerationGcKeyForVectorKey(key: VectorStoreKey, generationId: string): string {
  return vectorGenerationGcKey({
    vaultStateHash: key.vaultStateHash,
    embeddingSetId: key.embeddingSetId,
    generationId,
  });
}

function vectorGenerationGcPrefix(_profileHash: string, vaultStateHash: string): string {
  return [safeStoreFileName(vaultStateHash), ''].join(':');
}

function vectorStoreGenerationGcPrefix(_profileHash: string, vaultStateHash: string, embeddingSetId: string): string {
  return [safeStoreFileName(vaultStateHash), safeStoreFileName(embeddingSetId), ''].join(':');
}

function hasProtectedVectorStoreGeneration(
  roots: ReadonlySet<string>,
  profileHash: string,
  vaultStateHash: string,
  embeddingSetId: string,
): boolean {
  const prefix = vectorStoreGenerationGcPrefix(profileHash, vaultStateHash, embeddingSetId);
  for (const key of roots) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function isPinnedRetrievalSnapshot(pin: PinnedSnapshot): pin is PinnedRetrievalSnapshot {
  return (
    'retrievalSnapshotId' in pin &&
    'vector' in pin &&
    'vectorKey' in pin &&
    isRecord((pin as { vector?: unknown }).vector) &&
    isRecord((pin as { vectorKey?: unknown }).vectorKey)
  );
}

function protectedStoreIdsForPrune(
  loaded: ReadonlyMap<string, LoadedSnapshot>,
  lifecycleStoreRefs: ReadonlyMap<string, number>,
  extra: ReadonlySet<string> = new Set(),
): Set<string> {
  return new Set([
    ...[...loaded.values()].map((snapshot) => snapshot.vaultKey),
    ...lifecycleStoreRefs.keys(),
    ...extra,
  ]);
}

function retainLifecycleStore(refs: Map<string, number>, storeId: string): void {
  refs.set(storeId, (refs.get(storeId) ?? 0) + 1);
}

function releaseLifecycleStore(refs: Map<string, number>, storeId: string): void {
  const next = (refs.get(storeId) ?? 1) - 1;
  if (next > 0) refs.set(storeId, next);
  else refs.delete(storeId);
}

function accessTime(snapshot: LoadedSnapshot, vaultAccessMs: Map<string, number>): number {
  return Math.max(snapshot.lastAccessMs, vaultAccessMs.get(snapshot.vaultKey) ?? 0);
}

async function safeReadDirAsync(dirPath: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dirPath)).sort(compareCodePoint);
  } catch {
    return [];
  }
}

async function isDirectoryPathAsync(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function sweepStaleTmpDirAsync(dirPath: string, nowMs = Date.now()): Promise<void> {
  for (const file of await safeReadDirAsync(dirPath)) {
    const filePath = path.join(dirPath, file);
    if (!(await isStaleTmpPathAsync(filePath, nowMs))) continue;
    await fs.promises.rm(filePath, { recursive: true, force: true });
  }
}

async function isStaleTmpPathAsync(filePath: string, nowMs: number): Promise<boolean> {
  try {
    return nowMs - (await fs.promises.stat(filePath)).mtimeMs >= TMP_STALE_MS;
  } catch {
    return false;
  }
}

async function rmBestEffort(target: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
  // Best-effort GC deletion: a single undeletable entry (e.g. a file held open on Windows) must not
  // abort the whole mark-sweep pass and stall the vault's GC. Undeleted entries retry next pass.
  try {
    await fs.promises.rm(target, options);
  } catch {
    // Best-effort deletion; leftovers are retried by later GC passes.
  }
}

async function retainedSnapshotFilesAsync(dirPath: string, count: number): Promise<string[]> {
  // "Newest N" must mean most-recently-built, not lexically-highest hash. Snapshot ids are SHA-256
  // digests with no temporal component, so sorting them by code point would retain arbitrary files
  // and could GC a snapshot that was just published (breaking explicit-snapshotId pin replay).
  const files = (await safeReadDirAsync(dirPath)).filter(isValidSnapshotId);
  const withMtime = await Promise.all(
    files.map(async (name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.promises.stat(path.join(dirPath, name))).mtimeMs;
      } catch {
        // Missing or unreadable files sort oldest and are eligible for GC.
      }
      return { name, mtimeMs };
    }),
  );
  return withMtime
    .sort((left, right) => right.mtimeMs - left.mtimeMs || compareCodePoint(right.name, left.name))
    .slice(0, count)
    .map((entry) => entry.name);
}

function currentContentHashes(vaultRoot: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const abs of walkFiles(vaultRoot, vaultRoot, { includeHidden: false, all: false })) {
    const rel = vaultRelative(vaultRoot, abs);
    hashes.set(rel, sha256(fs.readFileSync(abs)));
  }
  return hashes;
}

function lexicalEditionFromPublisherResult(result: VaultPublisherIntentResult): EditionRecord {
  if (result.status === 'covered') return result.head;
  if (result.status === 'committed') return result.edition;
  if (result.status === 'dropped') throw new Error(result.reason);
  if (result.status === 'not-ready')
    throw new Error(`lexical publication did not produce a ready head: ${result.reason}`);
  throw new Error(`unexpected publisher result for lexical publication: ${result.intentKind}`);
}

function publisherLaneSnapshotContext(
  value: unknown,
  deadline: number,
  cancellationId: string,
): SnapshotRequestContext {
  const context: SnapshotRequestContext = {
    deadline,
    cancellationId,
  };
  if (!isRecord(value)) return context;
  const progress = value.progress;
  if (typeof progress === 'function') context.progress = progress as SnapshotRequestContext['progress'];
  if (isEmbedSchedulerLane(value.embeddingLane)) context.embeddingLane = value.embeddingLane;
  return context;
}

function isEmbedSchedulerLane(value: unknown): value is EmbedSchedulerLane {
  return value === 'query' || value === 'save' || value === 'refresh' || value === 'rebuild';
}

function reportIncrementalFallback(context: SnapshotRequestContext, reason: string): string {
  const warning = `incremental fallback-to-full: ${reason}`;
  context.progress?.({
    phase: 'scanning',
    total: 0,
    completed: 0,
    message: warning,
  });
  return warning;
}

function builtSnapshotWithWarning(built: BuiltSnapshot, warning: string): BuiltSnapshot {
  return {
    ...built,
    diagnostics: {
      ...built.diagnostics,
      warnings: [...new Set([...(built.diagnostics.warnings ?? []), warning])],
    },
  };
}

function validateReusableBaseEnvelope(
  paths: SearchStoreCachePaths,
  envelope: SnapshotEnvelope,
  partitionBits: number,
): void {
  if (envelope.snapshotId !== snapshotIdFromManifest(envelope.manifest)) {
    throw new Error('snapshotId does not match manifest');
  }
  if (envelope.canonicalManifestSha256 !== envelope.snapshotId) {
    throw new Error('canonical manifest hash mismatch');
  }
  if (
    envelope.corpusSnapshotId !== undefined &&
    envelope.corpusSnapshotId !== corpusSnapshotIdFromManifest(envelope.manifest)
  ) {
    throw new Error('corpus snapshot id mismatch');
  }
  if (!linkGraphSidecarExists(paths, envelope.linkGraphId)) {
    throw new Error('base link sidecar is missing');
  }

  const persistedDocuments = persistedDocumentsByDocumentId(envelope.documents, partitionBits);
  const decodedDocuments = decodedCanonicalDocumentsByDocumentId(paths, envelope, partitionBits);
  if (decodedDocuments.size !== persistedDocuments.size) {
    throw new Error('base persisted/canonical document count mismatch');
  }
  const currentDocuments = currentScanDocumentsByDocumentId(paths.vaultRoot, partitionBits);
  const liveRecords = [...decodedDocuments.values()]
    .sort((left, right) => compareCodePoint(left.documentId, right.documentId))
    .map((canonicalDocument) => {
      const persisted = persistedDocuments.get(canonicalDocument.documentId);
      if (!persisted)
        throw new Error(`base canonical document ${canonicalDocument.documentId} has no persisted record`);
      const current = currentDocuments.get(canonicalDocument.documentId);
      if (current && current.path !== persisted.path) {
        throw new Error(`base document ${canonicalDocument.documentId} path disagrees with current scan`);
      }
      if (current && current.contentHash === persisted.contentHash && current.partitionId !== persisted.partitionId) {
        throw new Error(`base document ${canonicalDocument.documentId} partition disagrees with current scan`);
      }
      return {
        documentId: canonicalDocument.documentId,
        path: persisted.path,
        contentHash: persisted.contentHash,
        parsedFieldHashes: canonicalDocument.parsedFieldHashes,
        snippetLineSpanHash: canonicalDocument.snippetLineSpanHash,
        deleted: false,
      };
    });
  for (const persisted of persistedDocuments.values()) {
    if (!decodedDocuments.has(persisted.documentId)) {
      throw new Error(`base persisted document ${persisted.documentId} has no canonical record`);
    }
  }
  const liveDocumentManifestHash = sha256(canonicalValueBytes(liveRecords));
  if (liveDocumentManifestHash !== envelope.manifest.liveDocumentManifestHash) {
    throw new Error('semantic document manifest hash mismatch');
  }
}

function persistedDocumentsByDocumentId(
  documents: readonly PersistedDocumentRecord[],
  partitionBits: number,
): Map<string, PersistedDocumentRecord> {
  const byDocumentId = new Map<string, PersistedDocumentRecord>();
  for (const document of documents) {
    const normalizedPath = normalizeVaultRelativePathForSnapshot(document.path);
    if (document.path !== normalizedPath)
      throw new Error(`base document ${document.documentId} path is not normalized`);
    const expectedDocumentId = sha256(utf8ForSnapshot(normalizedPath));
    if (document.documentId !== expectedDocumentId)
      throw new Error(`base document ${document.path} documentId mismatch`);
    const expectedPartitionId = partitionIdForDocument(document.documentId, partitionBits);
    if (document.partitionId !== expectedPartitionId)
      throw new Error(`base document ${document.documentId} partition mismatch`);
    if (byDocumentId.has(document.documentId))
      throw new Error(`duplicate base persisted document ${document.documentId}`);
    byDocumentId.set(document.documentId, document);
  }
  return byDocumentId;
}

function decodedCanonicalDocumentsByDocumentId(
  paths: SearchStoreCachePaths,
  envelope: SnapshotEnvelope,
  partitionBits: number,
): Map<string, CanonicalDocumentRecord> {
  const byDocumentId = new Map<string, CanonicalDocumentRecord>();
  for (const partition of envelope.manifest.partitions) {
    const segmentPath = safeSegmentPath(paths.segmentsDir, partition.segmentHash);
    if (!fs.existsSync(segmentPath)) throw new Error(`base segment ${partition.segmentHash} is missing`);
    const bytes = fs.readFileSync(segmentPath);
    if (bytes.length !== partition.byteLength)
      throw new Error(`base segment ${partition.segmentHash} byte length mismatch`);
    const actualHash = sha256(bytes);
    if (actualHash !== partition.segmentHash) throw new Error(`base segment ${partition.segmentHash} hash mismatch`);
    const decoded = decodeCanonicalSegment(bytes);
    const documents = decoded.documents ?? [];
    const documentIds = documents.map((document) => document.documentId);
    if (documentIds.length !== partition.documentCount) {
      throw new Error(`base partition ${partition.partitionId} document count mismatch`);
    }
    if (
      (documentIds[0] ?? '') !== partition.documentIdStart ||
      (documentIds[documentIds.length - 1] ?? '') !== partition.documentIdEnd
    ) {
      throw new Error(`base partition ${partition.partitionId} document bounds mismatch`);
    }
    for (const document of documents) {
      const expectedPartitionId = partitionIdForDocument(document.documentId, partitionBits);
      if (expectedPartitionId !== partition.partitionId) {
        throw new Error(`base canonical document ${document.documentId} partition mismatch`);
      }
      if (byDocumentId.has(document.documentId))
        throw new Error(`duplicate base canonical document ${document.documentId}`);
      byDocumentId.set(document.documentId, document);
    }
  }
  return byDocumentId;
}

function currentScanDocumentsByDocumentId(
  vaultRoot: string,
  partitionBits: number,
): Map<
  string,
  {
    path: string;
    contentHash: string;
    partitionId: number;
  }
> {
  const byDocumentId = new Map<string, { path: string; contentHash: string; partitionId: number }>();
  for (const record of scanBuildDocuments(vaultRoot).documents) {
    const normalizedPath = normalizeVaultRelativePathForSnapshot(record.path);
    const documentId = sha256(utf8ForSnapshot(normalizedPath));
    if (byDocumentId.has(documentId)) throw new Error(`duplicate current documentId ${documentId}`);
    byDocumentId.set(documentId, {
      path: normalizedPath,
      contentHash: record.contentHash,
      partitionId: partitionIdForDocument(documentId, partitionBits),
    });
  }
  return byDocumentId;
}

function snapshotIdentityTupleEquals(left: unknown, right: unknown): boolean {
  return Buffer.compare(Buffer.from(canonicalValueBytes(left)), Buffer.from(canonicalValueBytes(right))) === 0;
}

function reportRefreshDelta(context: SnapshotRequestContext, delta: SnapshotContentDelta): void {
  context.progress?.({
    phase: 'scanning',
    total: delta.changedCount,
    completed: 0,
    current: firstRefreshDeltaPath(delta),
    message: refreshDeltaMessage(delta),
  });
}

function firstRefreshDeltaPath(delta: SnapshotContentDelta): string | undefined {
  return delta.added[0] ?? delta.modified[0] ?? delta.deleted[0];
}

function refreshDeltaMessage(delta: SnapshotContentDelta): string {
  const parts = [
    countLabel(delta.added.length, 'added'),
    countLabel(delta.modified.length, 'modified'),
    countLabel(delta.deleted.length, 'deleted'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'already fresh';
}

function countLabel(count: number, label: string): string | undefined {
  return count > 0 ? `${count} ${label}` : undefined;
}

function positiveCap(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.MAX_SAFE_INTEGER;
}

function progressReportInterval(total: number): number {
  if (total <= 200) return 1;
  return Math.max(1, Math.floor(total / 100));
}

function envNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeVaultRelativePathForSnapshot(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part.normalize('NFC'));
  }
  return parts.join('/');
}

function utf8ForSnapshot(value: string): Uint8Array {
  return new TextEncoder().encode(value.normalize('NFC'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleIncarnation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'STALE_INCARNATION'
  );
}

function searchAnalyzerRuntimeFromProcess(): { node: string; icu?: string } {
  return {
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {}),
  };
}

function isValidSnapshotId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function assertValidSnapshotId(value: string): void {
  if (!isValidSnapshotId(value)) {
    throw Object.assign(new Error('snapshotId must be a 64-character lowercase hex string'), { code: 'BAD_REQUEST' });
  }
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  return (
    isRecord(value) &&
    value.schemaHash === SNAPSHOT_PERSISTENCE_SCHEMA_HASH &&
    typeof value.snapshotId === 'string' &&
    typeof value.linkGraphId === 'string' &&
    (!('baseReuseImplementationIdentity' in value) || typeof value.baseReuseImplementationIdentity === 'string') &&
    isRecord(value.manifest) &&
    typeof value.canonicalManifestSha256 === 'string' &&
    Array.isArray(value.documents) &&
    isRecord(value.diagnostics) &&
    value.diagnostics.schemaHash === SNAPSHOT_PERSISTENCE_SCHEMA_HASH &&
    !('documents' in value.diagnostics)
  );
}

function isRetrievalSnapshotEnvelope(value: unknown): value is RetrievalSnapshotEnvelope {
  return (
    isRecord(value) &&
    value.schemaHash === SNAPSHOT_PERSISTENCE_SCHEMA_HASH &&
    typeof value.retrievalSnapshotId === 'string' &&
    typeof value.snapshotId === 'string' &&
    typeof value.corpusSnapshotId === 'string' &&
    typeof value.linkGraphId === 'string' &&
    typeof value.embeddingSetId === 'string' &&
    typeof value.embeddingSpaceId === 'string' &&
    typeof value.embeddingRecipeFreshnessId === 'string' &&
    typeof value.retrieverPlanIdentity === 'string' &&
    typeof value.rankingFeatureVersion === 'string' &&
    typeof value.canonicalManifestSha256 === 'string' &&
    isRecord(value.embeddingSet) &&
    value.embeddingSet.schemaHash === SNAPSHOT_PERSISTENCE_SCHEMA_HASH &&
    isRecord(value.vector) &&
    typeof value.vector.manifestHash === 'string' &&
    typeof value.vector.metadataSha256 === 'string' &&
    isRecord(value.freshness)
  );
}

function retrievalEnvelopeMatchesEdition(envelope: RetrievalSnapshotEnvelope, edition: EditionRecord): boolean {
  return (
    edition.dense.state === 'fresh' &&
    envelope.retrievalSnapshotId === edition.identity.retrievalSnapshotId &&
    envelope.snapshotId === edition.corpus.snapshotId &&
    envelope.corpusSnapshotId === edition.corpus.corpusSnapshotId &&
    envelope.linkGraphId === edition.linkGraphId &&
    envelope.embeddingSetId === edition.dense.embeddingSetId &&
    envelope.vector.generationId === edition.dense.generationId &&
    envelope.vector.manifestHash === edition.dense.manifestHash
  );
}

function denseEditionNotReadyReason(dense: DenseEdition): RetrievalPinNotReadyReason {
  if (dense.state === 'building') return 'retrieval-state-building';
  if (dense.state === 'failed') return 'retrieval-state-failed';
  if (dense.state === 'unavailable') return 'retrieval-state-stale';
  return 'retrieval-state-stale';
}

function denseEditionUnavailableMessage(dense: DenseEdition): string {
  if (dense.state === 'failed') return dense.cause;
  if (dense.state === 'building') return 'dense-generation-building';
  if (dense.state === 'unavailable') return dense.reason;
  return 'dense-generation-unavailable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
