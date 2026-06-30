import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../core/private-path.js";
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer, type SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../core/search/analysis/index.js";
import {
  canonicalBm25GlobalStatsHash,
  corpusSnapshotIdFromManifest,
  decodeCanonicalSegment,
  canonicalValueBytes,
  reduceCanonicalBm25GlobalStats,
  snapshotIdFromManifest,
  type CanonicalBm25FieldStats
} from "../../core/search/segments/index.js";
import type { PositionalBm25GlobalStats } from "../../core/search/retrieval/positional/index.js";
import type {
  EmbeddingSetId,
  LinkGraphId,
  LinkGraphView,
  PinnedSnapshot,
  RetrieverIdentity,
  RetrievalSnapshotId,
  SnapshotManifestView,
  SnapshotStore,
  SnapshotView
} from "../../core/search/contracts.js";
import {
  buildEmbeddingSetFromVectors,
  DeterministicHashProvider,
  createLocalOnnxProviderFromConfig,
  embeddingRecipeIdentityForProvider,
  type EmbeddingProviderIdentity,
  type BuiltEmbeddingSet,
  type EmbeddingProvider,
  type EmbeddingRecipeIdentity,
  type EmbeddingSetDocumentInput,
  type EmbeddingSetRecord,
  type EmbeddingVector
} from "../../core/search/dense/index.js";
import { DENSE_RETRIEVER_VERSION } from "../../core/search/dense/retriever.js";
import { computeRetrieverPlanIdentity, DEFAULT_RRF_K, type FusionParameters } from "../../core/search/retrieval/fusion.js";
import {
  LINK_ADJACENCY_DIRECT_SCORE,
  LINK_ADJACENCY_RETRIEVER_VERSION,
  LINK_ADJACENCY_SCORING_VERSION
} from "../../core/search/retrieval/link.js";
import { POSITIONAL_RETRIEVER_IDENTITY } from "../../core/search/retrieval/positional/retriever.js";
import { recordVaultAccess, recentVaultAccessRoots } from "../../core/vault-access.js";
import { vaultRelative, walkFiles } from "../../core/path.js";
import { readOptsidianSettings, searchNgramEnabled, type OptsidianSettings } from "../../core/settings.js";
import {
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../../core/search/index-settings.js";
import {
  SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
  type ModelProviderPayload,
  type SearchIndexProgressUpdate
} from "../protocol.js";
import type { EmbeddingWorkerPool } from "../pools.js";
import { buildCanonicalSearchSnapshot, DEFAULT_PARTITION_BITS, snapshotIdentityTuple, snapshotIdentityTupleForAnalyzerIdentity } from "./builder.js";
import { searchStoreCachePaths, type SearchStoreCachePaths } from "./cache-paths.js";
import type { SearchExecutionSnapshotHandle, SharedBytesHandle } from "../search-execution.js";
import {
  durableRename,
  fsyncDirSync,
  fsyncFileSync,
  type DurableRename
} from "./publication.js";
import {
  buildLinkGraphSidecar,
  LINK_GRAPH_RESOLVER_VERSION,
  linkGraphSidecarExists,
  loadLinkGraphView,
  storeLinkGraphSidecar,
  sweepLinkGraphSidecars
} from "./link-graph.js";
import {
  RetrievalFreshnessStore,
  readActiveVectorPointer,
  storeVectorGenerationMetadata,
  VectorGenerationPool,
  vectorStoreCachePaths,
  writeActiveVectorPointer,
  type CoralEmbeddingSpec,
  type VectorStoreCachePaths,
  type VectorGenerationMetadata
} from "../vector-store/index.js";
import type { CoralChunkRecord, VectorStoreKey } from "../vector-store/types.js";
import {
  SNAPSHOT_PERSISTENCE_VERSION,
  type ActivePointer,
  type BuiltSnapshot,
  type PersistedDocumentRecord,
  type RetrievalActivePointer,
  type RetrievalEmbeddingSetEnvelope,
  type RetrievalSnapshotEnvelope,
  type SnapshotEnvelope
} from "./types.js";
import { SearchCacheCatalog, type SearchCachePruneOptions } from "./cache-catalog.js";
import type { SearchIndexPruneResult } from "../../core/types.js";

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
  durableRenameActivePointer?: DurableRename;
  durableRenameRetrievalPointer?: DurableRename;
  durableRenameLinkGraph?: DurableRename;
  vectorPool?: VectorGenerationPool;
  embeddingSetBuilder?: RetrievalEmbeddingSetBuilder;
};

export type LoadVaultResult = {
  ok: true;
  command: "index";
  action: "warm";
  vaults: Array<{ vaultRoot: string; status: "ready" | "failed"; error?: string }>;
  snapshotId?: string;
};

export type SnapshotMutationResult = {
  ok: true;
  command: "index";
  action: "rebuild" | "clear";
  snapshotId?: string;
};

export type SnapshotRequestContext = {
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

type SnapshotBuilderInput = {
  vaultRoot: string;
  partitionBits: number;
  searchSettings: IndexAffectingSearchSettings;
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type RetrievalEmbeddingSetBuilderInput = {
  vaultRoot: string;
  documents: readonly EmbeddingSetDocumentInput[];
  deadline?: number;
  cancellationId?: string;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type RetrievalEmbeddingSetBuilder = {
  readonly providerIdentity: EmbeddingProviderIdentity;
  build(input: RetrievalEmbeddingSetBuilderInput): Promise<BuiltEmbeddingSet>;
};

type RetrievalSnapshotSource = Pick<
  BuiltSnapshot,
  "snapshotId" | "corpusSnapshotId" | "identityTuple" | "documents" | "linkGraphId"
>;

type RetrievalSnapshotPublication = {
  envelope: RetrievalSnapshotEnvelope;
  active: RetrievalActivePointer;
  vectorPaths: VectorStoreCachePaths;
};

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
  retrieverPlanIdentity: string;
  rankingFeatureVersion: string;
  embeddingSet: RetrievalEmbeddingSetEnvelope;
  vector: RetrievalSnapshotEnvelope["vector"];
  vectorKey: VectorStoreKey;
};

export type RetrievalPinNotReadyReason =
  | "no-active-retrieval-snapshot"
  | "retrieval-envelope-missing"
  | "retrieval-state-dirty"
  | "retrieval-state-building"
  | "retrieval-state-failed"
  | "retrieval-state-stale"
  | "corpus-missing"
  | "link-graph-missing"
  | "vector-active-spec-missing"
  | "vector-active-spec-mismatched"
  | "embedding-set-mismatched"
  | "retrieval-snapshot-mismatched";

export type RetrievalPinResult =
  | { status: "ready"; pin: PinnedRetrievalSnapshot }
  | { status: "index-not-ready"; reason: RetrievalPinNotReadyReason };

type GcRoots = {
  snapshotIds: Set<string>;
  segmentHashes: Set<string>;
  linkGraphIds: Set<LinkGraphId>;
  retrievalSnapshotIds: Set<RetrievalSnapshotId>;
};

const DEFAULT_COUNT_CAP = 8;
const DEFAULT_BYTE_CAP = 128 * 1024 * 1024;
const DEFAULT_RETENTION_COUNT = 8;
const TMP_STALE_MS = 5 * 60 * 1000;

export class DaemonSnapshotStore implements SnapshotStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly countCap: number;
  private readonly byteCap: number;
  private readonly retentionCount: number;
  private readonly profileHash: string;
  private readonly partitionBits: number;
  private readonly analyzer: SearchAnalyzer | undefined;
  private readonly analyzerIdentity: SearchAnalyzerIdentity;
  private readonly searchSettings: IndexAffectingSearchSettings;
  private readonly snapshotBuilder: ((input: SnapshotBuilderInput) => Promise<BuiltSnapshot>) | undefined;
  private readonly cacheCatalog: SearchCacheCatalog;
  private readonly renameSegment: DurableRename;
  private readonly renameManifest: DurableRename;
  private readonly renameActive: DurableRename;
  private readonly renameRetrieval: DurableRename;
  private readonly renameLinkGraph: DurableRename;
  private readonly vectorPool: VectorGenerationPool | undefined;
  private readonly embeddingSetBuilder: RetrievalEmbeddingSetBuilder;
  private readonly loaded = new Map<string, LoadedSnapshot>();
  private readonly activeByVault = new Map<string, string>();
  private readonly inFlightPublishManifests = new Map<string, SnapshotEnvelope>();
  private readonly inFlightPublishLinkGraphs = new Set<LinkGraphId>();
  private readonly lifecycleStoreRefs = new Map<string, number>();
  private readonly vaultAccessMs = new Map<string, number>();

  constructor(options: DaemonSnapshotStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.countCap = positiveCap(
      options.countCap ??
      envNumber(this.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_COUNT) ??
      envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_COUNT_CAP) ??
      DEFAULT_COUNT_CAP
    );
    this.byteCap = positiveCap(
      options.byteCap ??
      envNumber(this.env.OPTSIDIAN_SEARCH_MEMORY_BUDGET_BYTES) ??
      envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_BYTE_CAP) ??
      DEFAULT_BYTE_CAP
    );
    this.retentionCount = positiveCap(
      options.retentionCount ??
      envNumber(this.env.OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT) ??
      DEFAULT_RETENTION_COUNT
    );
    this.profileHash = options.profileHash ?? "default";
    this.partitionBits = options.partitionBits ?? DEFAULT_PARTITION_BITS;
    const settings = readOptsidianSettings(process.cwd(), this.env);
    this.searchSettings = normalizeIndexAffectingSearchSettings(
      options.searchSettings ?? { ngram: searchNgramEnabled(this.env, settings) }
    );
    const runtime = searchAnalyzerRuntimeFromProcess();
    this.analyzer = options.analyzer ?? (options.snapshotBuilder ? undefined : resolveSearchAnalyzer(this.env, settings, runtime));
    this.analyzerIdentity = options.analyzerIdentity ?? options.analyzer?.identity ?? this.analyzer?.identity ?? resolveSearchAnalyzer(this.env, settings, runtime).identity;
    this.snapshotBuilder = options.snapshotBuilder;
    this.cacheCatalog = options.cacheCatalog ?? new SearchCacheCatalog({ env: this.env });
    this.renameSegment = options.durableRenameSegment ?? durableRename;
    this.renameManifest = options.durableRenameManifest ?? durableRename;
    this.renameActive = options.durableRenameActivePointer ?? durableRename;
    this.renameRetrieval = options.durableRenameRetrievalPointer ?? durableRename;
    this.renameLinkGraph = options.durableRenameLinkGraph ?? durableRename;
    this.vectorPool = options.vectorPool;
    this.embeddingSetBuilder = options.embeddingSetBuilder ??
      createConfiguredEmbeddingSetBuilder(settings, this.env);
  }

  searchAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.analyzerIdentity;
  }

  async loadVault(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<LoadVaultResult> {
    try {
      const paths = this.paths(vaultRoot);
      const snapshotId = await this.withLifecycleStore(paths, () => this.ensureIndexedSnapshot(paths, context));
      return {
        ok: true,
        command: "index",
        action: "warm",
        vaults: [{ vaultRoot: paths.vaultRoot, status: "ready" }],
        snapshotId
      };
    } catch (error) {
      return {
        ok: true,
        command: "index",
        action: "warm",
        vaults: [{ vaultRoot, status: "failed", error: errorMessage(error) }]
      };
    }
  }

  async rebuild(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<SnapshotMutationResult> {
    const paths = this.paths(vaultRoot);
    const snapshotId = await this.withLifecycleStore(paths, async () => {
      return this.publishFreshSnapshot(paths.vaultRoot, context, { prepareRetrieval: true });
    });
    return {
      ok: true,
      command: "index",
      action: "rebuild",
      snapshotId
    };
  }

  async refresh(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<{ ok: true; command: "index"; action: "refresh"; rebuilt: boolean; snapshotId?: string }> {
    const paths = this.paths(vaultRoot);
    const refreshed = await this.withLifecycleStore(paths, () => this.refreshIndexedSnapshot(paths, context));
    return {
      ok: true,
      command: "index",
      action: "refresh",
      rebuilt: refreshed.rebuilt,
      snapshotId: refreshed.snapshotId
    };
  }

  async compact(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<{ ok: true; command: "index"; action: "compact"; rebuilt: boolean; snapshotId?: string }> {
    const paths = this.paths(vaultRoot);
    const snapshotId = await this.withLifecycleStore(paths, async () => {
      const activeSnapshotId = await this.ensureActiveSnapshot(paths.vaultRoot, context);
      await this.recoverVault(paths);
      this.markSweepGc(paths);
      return activeSnapshotId;
    });
    return {
      ok: true,
      command: "index",
      action: "compact",
      rebuilt: false,
      snapshotId
    };
  }

  async clear(vaultRoot: string): Promise<SnapshotMutationResult> {
    const paths = this.paths(vaultRoot);
    await this.withLifecycleStore(paths, async () => {
      await this.recoverVault(paths);
      fs.rmSync(paths.activePointerPath, { force: true });
      fs.rmSync(paths.retrievalActivePointerPath, { force: true });
      fsyncDirSync(paths.activeDir);
      const pinned = new Set(
        [...this.loaded.values()]
          .filter((snapshot) => snapshot.vaultKey === paths.vaultStateHash && snapshot.refCount > 0)
          .map((snapshot) => snapshot.snapshotId)
      );
      for (const file of safeReadDir(paths.snapshotsDir)) {
        const snapshotId = file;
        if (!isValidSnapshotId(snapshotId)) continue;
        if (!pinned.has(snapshotId)) fs.rmSync(path.join(paths.snapshotsDir, file), { force: true });
      }
      this.activeByVault.delete(paths.vaultStateHash);
      this.markSweepGc(paths);
      this.cacheCatalog.recordCleared(paths);
    });
    return {
      ok: true,
      command: "index",
      action: "clear"
    };
  }

  async prune(options: SearchCachePruneOptions = {}): Promise<SearchIndexPruneResult> {
    return this.cacheCatalog.prune({
      ...options,
      protectedStoreIds: protectedStoreIdsForPrune(this.loaded, this.lifecycleStoreRefs, options.protectedStoreIds)
    });
  }

  async pin(vaultRoot: string, snapshotId?: string, context: SnapshotRequestContext = {}): Promise<PinnedSnapshot> {
    const paths = this.paths(vaultRoot);
    if (snapshotId !== undefined) assertValidSnapshotId(snapshotId);
    const pinned = await this.withLifecycleStore(paths, async () => {
      const activeSnapshotId = snapshotId ?? await this.ensureActiveSnapshot(paths.vaultRoot, context);
      const loaded = await this.ensureLoaded(paths, activeSnapshotId);
      loaded.refCount += 1;
      loaded.lastAccessMs = Date.now();
      this.vaultAccessMs.set(paths.vaultStateHash, loaded.lastAccessMs);
      recordVaultAccess(paths.vaultRoot, { env: this.env, nowMs: loaded.lastAccessMs });
      const pinToken = `${paths.vaultStateHash}:${activeSnapshotId}:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      loaded.pinTokens.add(pinToken);
      return { activeSnapshotId, loaded, pinToken };
    });
    this.enforceBudget();
    return {
      snapshotId: pinned.activeSnapshotId,
      view: pinned.loaded.view,
      pinToken: pinned.pinToken
    };
  }

  async pinActiveOnly(vaultRoot: string): Promise<PinnedRetrievalSnapshot> {
    const result = await this.tryPinActiveRetrievalSnapshot(vaultRoot);
    if (result.status !== "ready") {
      throw Object.assign(new Error(`retrieval index is not ready: ${result.reason}`), {
        code: "SEARCH_DAEMON_NOT_READY",
        reason: result.reason
      });
    }
    return result.pin;
  }

  async ensureActiveRetrievalSnapshot(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<RetrievalPinResult> {
    const paths = this.paths(vaultRoot);
    return await this.withLifecycleStore(paths, async () => {
      const snapshotId = await this.ensureActiveSnapshot(paths.vaultRoot, context);
      const loaded = await this.ensureLoaded(paths, snapshotId);
      const current = await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
      if (
        current.status === "ready" &&
        current.pin.snapshotId === snapshotId &&
        current.pin.corpusSnapshotId === loaded.envelope.corpusSnapshotId
      ) {
        return current;
      }
      if (current.status === "ready") this.release(current.pin);
      await this.publishRetrievalSnapshot(
        paths,
        retrievalSnapshotSourceFromEnvelope(loaded.envelope),
        loaded.envelope,
        context
      );
      return await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
    });
  }

  private async prepareRetrievalSnapshotForSnapshot(
    paths: SearchStoreCachePaths,
    snapshotId: string,
    context: SnapshotRequestContext
  ): Promise<boolean> {
    const loadedBefore = new Set(this.loaded.keys());
    const releasePreparedPin = (pin: PinnedRetrievalSnapshot): void => {
      const key = loadedKey(paths.vaultStateHash, pin.snapshotId);
      this.release(pin);
      const loaded = this.loaded.get(key);
      if (!loadedBefore.has(key) && loaded?.refCount === 0) this.loaded.delete(key);
    };
    const loaded = await this.ensureLoaded(paths, snapshotId);
    const current = await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
    if (
      current.status === "ready" &&
      current.pin.snapshotId === snapshotId &&
      current.pin.corpusSnapshotId === loaded.envelope.corpusSnapshotId
    ) {
      releasePreparedPin(current.pin);
      return false;
    }
    if (current.status === "ready") releasePreparedPin(current.pin);
    await this.publishRetrievalSnapshot(
      paths,
      retrievalSnapshotSourceFromEnvelope(loaded.envelope),
      loaded.envelope,
      context
    );
    const result = await this.tryPinActiveRetrievalSnapshot(paths.vaultRoot);
    if (result.status !== "ready") throw new Error(`retrieval snapshot is not ready after indexing: ${result.reason}`);
    releasePreparedPin(result.pin);
    return true;
  }

  async tryPinActiveRetrievalSnapshot(vaultRoot: string): Promise<RetrievalPinResult> {
    const paths = this.paths(vaultRoot);
    const active = this.readRetrievalActivePointer(paths);
    if (!active) return { status: "index-not-ready", reason: "no-active-retrieval-snapshot" };
    const retrieval = this.readRetrievalSnapshotEnvelope(paths, active.retrievalSnapshotId);
    if (!retrieval) return { status: "index-not-ready", reason: "retrieval-envelope-missing" };
    if (!retrievalEnvelopeMatchesPointer(retrieval, active)) {
      return { status: "index-not-ready", reason: "retrieval-snapshot-mismatched" };
    }
    const envelope = this.readSnapshotEnvelope(paths, retrieval.snapshotId);
    if (!envelope || envelope.corpusSnapshotId !== retrieval.corpusSnapshotId) {
      return { status: "index-not-ready", reason: "corpus-missing" };
    }
    const currentIdentity = currentRetrievalIdentity({
      linkGraphId: retrieval.linkGraphId,
      rankingFeatureVersion: String(envelope.manifest.identityTuple.rankingFeatureVersion),
      provider: this.embeddingSetBuilder.providerIdentity
    });
    if (
      retrieval.retrieverPlanIdentity !== currentIdentity.retrieverPlanIdentity ||
      retrieval.rankingFeatureVersion !== currentIdentity.rankingFeatureVersion
    ) {
      return { status: "index-not-ready", reason: "retrieval-snapshot-mismatched" };
    }
    if (
      retrieval.embeddingSet.model !== currentIdentity.provider.model ||
      retrieval.embeddingSet.dim !== currentIdentity.provider.dim ||
      retrieval.embeddingSet.recipe.provider.id !== currentIdentity.provider.id ||
      retrieval.embeddingSet.recipe.provider.model !== currentIdentity.provider.model ||
      retrieval.embeddingSet.recipe.provider.dim !== currentIdentity.provider.dim ||
      retrieval.embeddingSet.recipe.provider.version !== currentIdentity.provider.version
    ) {
      return { status: "index-not-ready", reason: "embedding-set-mismatched" };
    }
    const expectedCurrentRetrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: retrieval.corpusSnapshotId,
      linkGraphId: retrieval.linkGraphId,
      embeddingSetId: retrieval.embeddingSetId,
      retrieverPlanIdentity: currentIdentity.retrieverPlanIdentity,
      rankingFeatureVersion: currentIdentity.rankingFeatureVersion
    });
    if (expectedCurrentRetrievalSnapshotId !== retrieval.retrievalSnapshotId) {
      return { status: "index-not-ready", reason: "retrieval-snapshot-mismatched" };
    }
    const freshness = new RetrievalFreshnessStore({
      paths: vectorStoreCachePaths({
        vaultRoot: paths.vaultRoot,
        profileHash: this.profileHash,
        embeddingSetId: retrieval.embeddingSetId,
        env: this.env
      })
    }).read();
    if (freshness.state !== "fresh") {
      return { status: "index-not-ready", reason: freshnessStateReason(freshness.state) };
    }
    if (
      freshness.published?.retrievalSnapshotId !== retrieval.retrievalSnapshotId ||
      freshness.published?.embeddingSetId !== retrieval.embeddingSetId ||
      freshness.published?.linkGraphId !== retrieval.linkGraphId ||
      freshness.published?.corpusSnapshotId !== retrieval.corpusSnapshotId ||
      freshness.published?.vectorGenerationId !== retrieval.vector.generationId ||
      freshness.corpusRevision !== retrieval.freshness.corpusRevision
    ) {
      return { status: "index-not-ready", reason: "retrieval-state-stale" };
    }
    if (envelope.linkGraphId !== retrieval.linkGraphId || !linkGraphSidecarExists(paths, retrieval.linkGraphId)) {
      return { status: "index-not-ready", reason: "link-graph-missing" };
    }
    const vectorPaths = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: retrieval.embeddingSetId,
      env: this.env
    });
    const activeVector = readActiveVectorPointer(vectorPaths);
    if (!activeVector) return { status: "index-not-ready", reason: "vector-active-spec-missing" };
    if (
      activeVector.generationId !== retrieval.vector.generationId ||
      activeVector.embeddingSetId !== retrieval.embeddingSetId ||
      activeVector.specId !== retrieval.vector.specId ||
      activeVector.dbPath !== retrieval.vector.dbPath
    ) {
      return { status: "index-not-ready", reason: "vector-active-spec-mismatched" };
    }
    if (retrieval.embeddingSet.embeddingSetId !== retrieval.embeddingSetId) {
      return { status: "index-not-ready", reason: "embedding-set-mismatched" };
    }
    const expectedRetrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: retrieval.corpusSnapshotId,
      linkGraphId: retrieval.linkGraphId,
      embeddingSetId: retrieval.embeddingSetId,
      retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
      rankingFeatureVersion: retrieval.rankingFeatureVersion
    });
    if (expectedRetrievalSnapshotId !== retrieval.retrievalSnapshotId) {
      return { status: "index-not-ready", reason: "retrieval-snapshot-mismatched" };
    }

    const loaded = await this.ensureLoaded(paths, retrieval.snapshotId, { touchCache: false });
    loaded.refCount += 1;
    loaded.lastAccessMs = Date.now();
    const pinToken = `${paths.vaultStateHash}:${retrieval.retrievalSnapshotId}:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    loaded.pinTokens.add(pinToken);
    return {
      status: "ready",
      pin: {
        snapshotId: retrieval.snapshotId,
        view: loaded.view,
        pinToken,
        retrievalSnapshotId: retrieval.retrievalSnapshotId,
        corpusSnapshotId: retrieval.corpusSnapshotId,
        linkGraphId: retrieval.linkGraphId,
        embeddingSetId: retrieval.embeddingSetId,
        retrieverPlanIdentity: retrieval.retrieverPlanIdentity,
        rankingFeatureVersion: retrieval.rankingFeatureVersion,
        embeddingSet: retrieval.embeddingSet,
        vector: retrieval.vector,
        vectorKey: vectorPaths.key
      }
    };
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
    snapshot.pinTokens.delete(pin.pinToken);
    snapshot.refCount = Math.max(0, snapshot.refCount - 1);
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
          bytes: sharedHandle(bytes)
        };
      })
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
      active: Object.fromEntries(this.activeByVault)
    };
  }

  protectedStoreIdsForPrune(): Set<string> {
    return protectedStoreIdsForPrune(this.loaded, this.lifecycleStoreRefs);
  }

  private async ensureIndexedSnapshot(paths: SearchStoreCachePaths, context: SnapshotRequestContext = {}): Promise<string> {
    return (await this.refreshIndexedSnapshot(paths, context)).snapshotId;
  }

  private async refreshIndexedSnapshot(
    paths: SearchStoreCachePaths,
    context: SnapshotRequestContext = {}
  ): Promise<{ snapshotId: string; rebuilt: boolean }> {
    await this.recoverVault(paths);
    const active = this.readActivePointer(paths);
    if (active && this.snapshotIdentityMatches(paths, active.snapshotId)) {
      const delta = this.snapshotContentDelta(paths, active.snapshotId);
      if (delta?.changedCount === 0) {
        try {
          await this.ensureLoaded(paths, active.snapshotId);
        } catch {
          this.loaded.delete(loadedKey(paths.vaultStateHash, active.snapshotId));
          return {
            snapshotId: await this.publishFreshSnapshot(paths.vaultRoot, context, { prepareRetrieval: true }),
            rebuilt: true
          };
        }
        this.activeByVault.set(paths.vaultStateHash, active.snapshotId);
        const retrievalPrepared = await this.prepareRetrievalSnapshotForSnapshot(paths, active.snapshotId, context);
        if (!retrievalPrepared) {
          context.progress?.({
            phase: "scanning",
            total: 0,
            completed: 0,
            message: "already fresh"
          });
        }
        return { snapshotId: active.snapshotId, rebuilt: false };
      }
      if (delta) reportRefreshDelta(context, delta);
    }
    return {
      snapshotId: await this.publishFreshSnapshot(paths.vaultRoot, context, { prepareRetrieval: true }),
      rebuilt: true
    };
  }

  private async ensureActiveSnapshot(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<string> {
    const paths = this.paths(vaultRoot);
    await this.recoverVault(paths);
    const active = this.readActivePointer(paths);
    if (active && this.snapshotIsFresh(paths, active.snapshotId) && this.snapshotIdentityMatches(paths, active.snapshotId)) {
      try {
        await this.ensureLoaded(paths, active.snapshotId);
        this.activeByVault.set(paths.vaultStateHash, active.snapshotId);
        return active.snapshotId;
      } catch {
        this.loaded.delete(loadedKey(paths.vaultStateHash, active.snapshotId));
      }
    }
    return this.publishFreshSnapshot(vaultRoot, context);
  }

  private async publishFreshSnapshot(
    vaultRoot: string,
    context: SnapshotRequestContext = {},
    options: { prepareRetrieval?: boolean } = {}
  ): Promise<string> {
    const paths = this.paths(vaultRoot);
    await this.recoverVault(paths);
    const built = this.snapshotBuilder
      ? await this.snapshotBuilder({
          vaultRoot: paths.vaultRoot,
          partitionBits: this.partitionBits,
          searchSettings: this.searchSettings,
          deadline: context.deadline,
          cancellationId: context.cancellationId,
          progress: context.progress
        })
      : await this.buildSnapshotInProcess(paths.vaultRoot, context.progress);
    const envelope = snapshotEnvelope(built);
    const retrievalPublicationPromise = options.prepareRetrieval
      ? this.buildRetrievalSnapshotPublication(
          paths,
          retrievalSnapshotSourceFromEnvelope(envelope),
          envelope,
          context
        )
      : undefined;
    retrievalPublicationPromise?.catch(() => undefined);
    context.progress?.({
      phase: "publishing",
      total: built.segments.length,
      completed: 0
    });
    await this.publishBuiltSnapshot(paths, built, context, envelope);
    this.cacheCatalog.recordIndexed(paths, {
      snapshotId: built.snapshotId,
      documentCount: built.documents.length
    });
    this.activeByVault.set(paths.vaultStateHash, built.snapshotId);
    if (retrievalPublicationPromise) {
      await this.publishRetrievalSnapshotPublication(paths, await retrievalPublicationPromise);
    }
    context.progress?.({
      phase: "publishing",
      total: built.segments.length,
      completed: built.segments.length
    });
    this.enforceBudget();
    return built.snapshotId;
  }

  private async buildSnapshotInProcess(
    vaultRoot: string,
    progress?: (progress: SearchIndexProgressUpdate) => void
  ): Promise<BuiltSnapshot> {
    if (!this.analyzer) throw new Error("snapshot builder is not configured");
    return withSearchAnalyzerLease(this.analyzer, (leasedAnalyzer) =>
      buildCanonicalSearchSnapshot({
        vaultRoot,
        analyzer: leasedAnalyzer,
        searchSettings: this.searchSettings,
        partitionBits: this.partitionBits,
        progress
      })
    );
  }

  private async publishBuiltSnapshot(
    paths: SearchStoreCachePaths,
    built: BuiltSnapshot,
    context: SnapshotRequestContext = {},
    envelope: SnapshotEnvelope = snapshotEnvelope(built)
  ): Promise<void> {
    this.ensureDirs(paths);
    this.inFlightPublishManifests.set(built.snapshotId, envelope);
    this.inFlightPublishLinkGraphs.add(built.linkGraphId);
    try {
      const linkGraphSidecar = buildLinkGraphSidecar({
        corpusSnapshotId: built.corpusSnapshotId,
        edges: built.linkEdges
      });
      if (linkGraphSidecar.linkGraphId !== built.linkGraphId) {
        throw new Error(`built snapshot linkGraphId mismatch for ${built.snapshotId}`);
      }
      await storeLinkGraphSidecar(
        paths,
        linkGraphSidecar,
        { durableRenameLinkGraph: this.renameLinkGraph }
      );

      for (const [index, segment] of built.segments.entries()) {
        const target = path.join(paths.segmentsDir, segment.hash);
        let published = false;
        if (fs.existsSync(target)) {
          const existingHash = sha256(fs.readFileSync(target));
          if (existingHash === segment.hash) published = true;
          else fs.rmSync(target, { force: true });
        }
        if (!published) {
          const tmp = path.join(paths.tmpDir, `${segment.hash}.${process.pid}.segment.tmp`);
          writePrivateFileSync(tmp, segment.bytes, "Optsidian search segment");
          fsyncFileSync(tmp);
          fsyncDirSync(paths.tmpDir);
          const actual = sha256(fs.readFileSync(tmp));
          if (actual !== segment.hash) throw new Error(`segment hash verification failed for ${segment.hash}`);
          await this.renameSegment(tmp, target);
          fsyncDirSync(paths.segmentsDir);
        }
        context.progress?.({
          phase: "publishing",
          total: built.segments.length,
          completed: index + 1,
          current: segment.hash
        });
      }

      const manifestPath = path.join(paths.snapshotsDir, built.snapshotId);
      const manifestTmp = path.join(paths.tmpDir, `${built.snapshotId}.${process.pid}.manifest.tmp`);
      writePrivateFileSync(manifestTmp, `${JSON.stringify(envelope)}\n`, "Optsidian search snapshot manifest");
      fsyncFileSync(manifestTmp);
      await this.renameManifest(manifestTmp, manifestPath);
      fsyncDirSync(paths.snapshotsDir);

      const activePointer: ActivePointer = {
        schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
        snapshotId: built.snapshotId,
        canonicalManifestSha256: built.canonicalManifestSha256
      };
      const activeTmp = path.join(paths.tmpDir, `${built.snapshotId}.${process.pid}.active.tmp`);
      writePrivateFileSync(activeTmp, `${JSON.stringify(activePointer)}\n`, "Optsidian search active pointer");
      fsyncFileSync(activeTmp);
      await this.renameActive(activeTmp, paths.activePointerPath);
      fsyncDirSync(paths.activeDir);

      await this.recoverVault(paths);
      this.markSweepGc(paths);
    } finally {
      this.inFlightPublishManifests.delete(built.snapshotId);
      this.inFlightPublishLinkGraphs.delete(built.linkGraphId);
    }
  }

  private async publishRetrievalSnapshot(
    paths: SearchStoreCachePaths,
    source: RetrievalSnapshotSource,
    envelope: SnapshotEnvelope,
    context: SnapshotRequestContext = {}
  ): Promise<void> {
    await this.publishRetrievalSnapshotPublication(
      paths,
      await this.buildRetrievalSnapshotPublication(paths, source, envelope, context)
    );
  }

  private async buildRetrievalSnapshotPublication(
    paths: SearchStoreCachePaths,
    source: RetrievalSnapshotSource,
    envelope: SnapshotEnvelope,
    context: SnapshotRequestContext = {}
  ): Promise<RetrievalSnapshotPublication> {
    const embeddingSet = await this.embeddingSetBuilder.build({
      vaultRoot: paths.vaultRoot,
      documents: denseDocumentsForRetrievalSource(source),
      deadline: context.deadline,
      cancellationId: context.cancellationId,
      progress: context.progress
    });
    assertProviderIdentityMatches(embeddingSet.recipe.provider, this.embeddingSetBuilder.providerIdentity);
    const provider = embeddingSet.recipe.provider;
    const vectorPaths = vectorStoreCachePaths({
      vaultRoot: paths.vaultRoot,
      profileHash: this.profileHash,
      embeddingSetId: embeddingSet.embeddingSetId,
      env: this.env
    });
    const spec: CoralEmbeddingSpec = {
      specId: embeddingSpecId(embeddingSet.embeddingSetId, provider.model, provider.dim),
      provider: provider.id,
      model: provider.model,
      dims: provider.dim,
      normalization: "l2",
      createdAt: new Date(0).toISOString()
    };
    const generationId = `gen-${embeddingSet.embeddingSetId.slice(0, 24)}`;
    const generation: VectorGenerationMetadata = {
      schemaVersion: 1,
      key: vectorPaths.key,
      generationId,
      dbPath: path.join(vectorPaths.generationsDir, generationId, "vectors.duckdb"),
      spec,
      chunkCount: embeddingSet.records.length,
      builtEngine: "auto",
      createdAt: new Date(0).toISOString(),
      embeddingSetId: embeddingSet.embeddingSetId
    };
    if (this.vectorPool) {
      const builtGeneration = await this.vectorPool.buildStagingGeneration({
        paths: vectorPaths,
        spec,
        chunks: vectorChunksForEmbeddingSet(embeddingSet.records, spec),
        generationId,
        progress: context.progress
      });
      await this.vectorPool.promoteBuiltGeneration(vectorPaths, builtGeneration.metadata);
      generation.dbPath = builtGeneration.metadata.dbPath;
      generation.chunkCount = builtGeneration.metadata.chunkCount;
      generation.builtEngine = builtGeneration.metadata.builtEngine;
      generation.createdAt = builtGeneration.metadata.createdAt;
    } else {
      context.progress?.({
        phase: "vector-indexing",
        total: embeddingSet.records.length,
        completed: 0,
        current: generationId
      });
      await storeVectorGenerationMetadata(vectorPaths, generation);
      await writeActiveVectorPointer(vectorPaths, generation);
      context.progress?.({
        phase: "vector-indexing",
        total: embeddingSet.records.length,
        completed: embeddingSet.records.length,
        current: generationId,
        message: "stored"
      });
    }

    const { retrieverPlanIdentity, rankingFeatureVersion } = currentRetrievalIdentity({
      linkGraphId: source.linkGraphId,
      rankingFeatureVersion: String(source.identityTuple.rankingFeatureVersion),
      provider
    });
    const retrievalSnapshotId = computeRetrievalSnapshotId({
      corpusSnapshotId: source.corpusSnapshotId,
      linkGraphId: source.linkGraphId,
      embeddingSetId: embeddingSet.embeddingSetId,
      retrieverPlanIdentity,
      rankingFeatureVersion
    });
    const retrievalEnvelope: RetrievalSnapshotEnvelope = {
      schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
      retrievalSnapshotId,
      snapshotId: source.snapshotId,
      corpusSnapshotId: source.corpusSnapshotId,
      linkGraphId: source.linkGraphId,
      embeddingSetId: embeddingSet.embeddingSetId,
      retrieverPlanIdentity,
      rankingFeatureVersion,
      canonicalManifestSha256: envelope.canonicalManifestSha256,
      embeddingSet: retrievalEmbeddingSetEnvelope(embeddingSet),
      vector: {
        embeddingSetId: embeddingSet.embeddingSetId,
        generationId,
        specId: spec.specId,
        dbPath: generation.dbPath,
        key: vectorPaths.key
      },
      freshness: {
        state: "fresh",
        corpusRevision: source.corpusSnapshotId
      }
    };
    const active: RetrievalActivePointer = {
      schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
      retrievalSnapshotId,
      snapshotId: source.snapshotId,
      corpusSnapshotId: source.corpusSnapshotId,
      linkGraphId: source.linkGraphId,
      embeddingSetId: embeddingSet.embeddingSetId,
      vectorGenerationId: generationId
    };
    return { envelope: retrievalEnvelope, active, vectorPaths };
  }

  private async publishRetrievalSnapshotPublication(
    paths: SearchStoreCachePaths,
    publication: RetrievalSnapshotPublication
  ): Promise<void> {
    await storeRetrievalSnapshotEnvelope(paths, publication.envelope);
    await new RetrievalFreshnessStore({ paths: publication.vectorPaths }).markFresh({
      corpusRevision: publication.envelope.corpusSnapshotId,
      corpusSnapshotId: publication.envelope.corpusSnapshotId,
      linkGraphId: publication.envelope.linkGraphId,
      embeddingSetId: publication.envelope.embeddingSetId,
      retrievalSnapshotId: publication.envelope.retrievalSnapshotId,
      vectorGenerationId: publication.active.vectorGenerationId
    });
    const activeTmp = path.join(paths.tmpDir, `${publication.active.retrievalSnapshotId}.${process.pid}.retrieval-active.tmp`);
    writePrivateFileSync(activeTmp, `${JSON.stringify(publication.active)}\n`, "Optsidian retrieval active pointer");
    fsyncFileSync(activeTmp);
    await this.renameRetrieval(activeTmp, paths.retrievalActivePointerPath);
    fsyncDirSync(paths.activeDir);
  }

  private async ensureLoaded(
    paths: SearchStoreCachePaths,
    snapshotId: string,
    options: { touchCache?: boolean } = {}
  ): Promise<LoadedSnapshot> {
    const touchCache = options.touchCache !== false;
    assertValidSnapshotId(snapshotId);
    const key = loadedKey(paths.vaultStateHash, snapshotId);
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
      const segmentPath = path.join(paths.segmentsDir, partition.segmentHash);
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
    if (!linkGraph) throw new Error(`link graph sidecar is missing for snapshot ${envelope.snapshotId}: ${envelope.linkGraphId}`);
    const view = this.createSnapshotView(envelope, segmentBytes, linkGraph);
    return {
      vaultRoot: paths.vaultRoot,
      vaultKey: paths.vaultStateHash,
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
      lastAccessMs: Date.now()
    };
  }

  private createSnapshotView(
    envelope: SnapshotEnvelope,
    segmentBytes: Map<string, Uint8Array>,
    linkGraph: LinkGraphView
  ): SnapshotView {
    const manifest: SnapshotManifestView = {
      snapshotId: envelope.snapshotId,
      identityTuple: envelope.manifest.identityTuple,
      liveDocumentManifestHash: envelope.manifest.liveDocumentManifestHash,
      tombstoneHash: envelope.manifest.tombstoneHash,
      partitions: envelope.manifest.partitions
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
      neighbors: (documentId) => linkGraph.neighbors(documentId)
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
    const roots = this.gcRoots(paths);
    for (const file of safeReadDir(paths.retrievalsDir)) {
      if (!roots.retrievalSnapshotIds.has(file)) fs.rmSync(path.join(paths.retrievalsDir, file), { force: true });
    }
    for (const file of safeReadDir(paths.snapshotsDir)) {
      if (!roots.snapshotIds.has(file)) fs.rmSync(path.join(paths.snapshotsDir, file), { force: true });
    }
    for (const file of safeReadDir(paths.segmentsDir)) {
      if (!roots.segmentHashes.has(file)) fs.rmSync(path.join(paths.segmentsDir, file), { force: true });
    }
    sweepLinkGraphSidecars(paths, roots.linkGraphIds);
    sweepStaleTmpDir(paths.tmpDir);
  }

  private gcRoots(paths: SearchStoreCachePaths): GcRoots {
    const snapshotIds = new Set<string>();
    const segmentHashes = new Set<string>();
    const linkGraphIds = new Set<LinkGraphId>();
    const retrievalSnapshotIds = new Set<RetrievalSnapshotId>();
    const activeRetrieval = this.readRetrievalActivePointer(paths);
    if (activeRetrieval) {
      retrievalSnapshotIds.add(activeRetrieval.retrievalSnapshotId);
      const retrieval = this.readRetrievalSnapshotEnvelope(paths, activeRetrieval.retrievalSnapshotId);
      if (retrieval) {
        snapshotIds.add(retrieval.snapshotId);
        linkGraphIds.add(retrieval.linkGraphId);
      }
    }
    const active = this.readActivePointer(paths);
    if (active) {
      snapshotIds.add(active.snapshotId);
      const envelope = this.readSnapshotEnvelope(paths, active.snapshotId);
      if (envelope) {
        linkGraphIds.add(envelope.linkGraphId);
        for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
      }
    }
    for (const [snapshotId, envelope] of this.inFlightPublishManifests) {
      snapshotIds.add(snapshotId);
      linkGraphIds.add(envelope.linkGraphId);
      for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const linkGraphId of this.inFlightPublishLinkGraphs) linkGraphIds.add(linkGraphId);
    for (const snapshot of this.loaded.values()) {
      if (snapshot.vaultKey !== paths.vaultStateHash) continue;
      linkGraphIds.add(snapshot.linkGraph.linkGraphId);
      if (snapshot.refCount <= 0) continue;
      snapshotIds.add(snapshot.snapshotId);
      for (const partition of snapshot.envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const file of retainedSnapshotFiles(paths.snapshotsDir, this.retentionCount)) {
      const envelope = this.readSnapshotEnvelope(paths, file);
      if (!envelope) continue;
      snapshotIds.add(envelope.snapshotId);
      linkGraphIds.add(envelope.linkGraphId);
      for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const file of retainedSnapshotFiles(paths.retrievalsDir, this.retentionCount)) {
      const retrieval = this.readRetrievalSnapshotEnvelope(paths, file);
      if (!retrieval) continue;
      retrievalSnapshotIds.add(retrieval.retrievalSnapshotId);
      snapshotIds.add(retrieval.snapshotId);
      linkGraphIds.add(retrieval.linkGraphId);
    }
    return { snapshotIds, segmentHashes, linkGraphIds, retrievalSnapshotIds };
  }

  private async recoverVault(paths: SearchStoreCachePaths): Promise<void> {
    this.ensureDirs(paths);
    sweepStaleTmpDir(paths.tmpDir);
    const active = this.readActivePointer(paths);
    if (active && !this.readSnapshotEnvelope(paths, active.snapshotId)) {
      fs.rmSync(paths.activePointerPath, { force: true });
      fsyncDirSync(paths.activeDir);
    }
    this.markSweepGc(paths);
  }

  private readActivePointer(paths: SearchStoreCachePaths): ActivePointer | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.activePointerPath, "utf8")) as unknown;
      if (!isActivePointer(parsed)) return undefined;
      if (!this.readSnapshotEnvelope(paths, parsed.snapshotId)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private readRetrievalActivePointer(paths: SearchStoreCachePaths): RetrievalActivePointer | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.retrievalActivePointerPath, "utf8")) as unknown;
      if (!isRetrievalActivePointer(parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private readSnapshotEnvelope(paths: SearchStoreCachePaths, snapshotId: string): SnapshotEnvelope | undefined {
    if (!isValidSnapshotId(snapshotId)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.snapshotsDir, snapshotId), "utf8")) as unknown;
      if (!isSnapshotEnvelope(parsed)) return undefined;
      const actual = snapshotIdFromManifest(parsed.manifest);
      if (actual !== parsed.snapshotId || parsed.snapshotId !== snapshotId) return undefined;
      if (!linkGraphSidecarExists(paths, parsed.linkGraphId)) return undefined;
      for (const partition of parsed.manifest.partitions) {
        if (!fs.existsSync(path.join(paths.segmentsDir, partition.segmentHash))) return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private readRetrievalSnapshotEnvelope(
    paths: SearchStoreCachePaths,
    retrievalSnapshotId: string
  ): RetrievalSnapshotEnvelope | undefined {
    if (!isValidSnapshotId(retrievalSnapshotId)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.retrievalsDir, retrievalSnapshotId), "utf8")) as unknown;
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
      changedCount: added.length + modified.length + deleted.length
    };
  }

  private snapshotIdentityMatches(paths: SearchStoreCachePaths, snapshotId: string): boolean {
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) return false;
    const expected = this.analyzer
      ? snapshotIdentityTuple(this.analyzer, this.partitionBits, this.searchSettings)
      : snapshotIdentityTupleForAnalyzerIdentity(this.analyzerIdentity, this.partitionBits, this.searchSettings);
    return Buffer.compare(Buffer.from(canonicalValueBytes(envelope.manifest.identityTuple)), Buffer.from(canonicalValueBytes(expected))) === 0;
  }

  private ensureDirs(paths: SearchStoreCachePaths): void {
    ensurePrivateDirSync(paths.cacheRootDir, "Optsidian cache directory");
    ensurePrivateDirSync(paths.searchRootDir, "Optsidian search cache directory");
    ensurePrivateDirSync(paths.storesDir, "Optsidian search cache stores directory");
    ensurePrivateDirSync(paths.rootDir, "Optsidian search store directory");
    ensurePrivateDirSync(paths.segmentsDir, "Optsidian search segments directory");
    ensurePrivateDirSync(paths.snapshotsDir, "Optsidian search snapshots directory");
    ensurePrivateDirSync(paths.retrievalsDir, "Optsidian retrieval snapshot directory");
    ensurePrivateDirSync(paths.linkGraphsDir, "Optsidian search link graph directory");
    ensurePrivateDirSync(paths.activeDir, "Optsidian search active directory");
    ensurePrivateDirSync(paths.tmpDir, "Optsidian search tmp directory");
  }

  private paths(vaultRoot: string): SearchStoreCachePaths {
    return searchStoreCachePaths(vaultRoot, this.env);
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
        this.vaultAccessMs.set(paths.vaultStateHash, now - index);
      } catch {
        // Missing vault recency entries are ignored by eviction.
      }
    });
  }

  private async withLifecycleStore<T>(paths: SearchStoreCachePaths, fn: () => Promise<T>): Promise<T> {
    retainLifecycleStore(this.lifecycleStoreRefs, paths.vaultStateHash);
    try {
      return await fn();
    } finally {
      releaseLifecycleStore(this.lifecycleStoreRefs, paths.vaultStateHash);
    }
  }
}

export function createDaemonSnapshotStore(options: DaemonSnapshotStoreOptions = {}): DaemonSnapshotStore {
  return new DaemonSnapshotStore(options);
}

export function createProviderEmbeddingSetBuilder(provider: EmbeddingProvider): RetrievalEmbeddingSetBuilder {
  return {
    providerIdentity: provider.identity,
    async build(input) {
      const recipe = embeddingRecipeIdentityForProvider(provider);
      const total = input.documents.length;
      const interval = progressReportInterval(total);
      let completed = 0;
      input.progress?.({ phase: "embedding", total, completed: 0 });
      const vectors: EmbeddingVector[] = new Array(total);
      await Promise.all(input.documents.map(async (document, index) => {
        vectors[index] = await provider.embed(document.text, { inputKind: "document" });
        completed += 1;
        if (completed === total || completed % interval === 0) {
          input.progress?.({
            phase: "embedding",
            total,
            completed,
            current: document.path,
            message: `${completed} vectors`
          });
        }
      }));
      return buildEmbeddingSetFromVectors({
        provider: provider.identity,
        recipe,
        documents: input.documents,
        vectors
      });
    }
  };
}

export function createWorkerEmbeddingSetBuilder(input: {
  provider: EmbeddingProvider;
  providerPayload: ModelProviderPayload;
  embedding: Pick<EmbeddingWorkerPool, "encode">;
  batchSize?: number;
}): RetrievalEmbeddingSetBuilder {
  const batchSize = positiveCap(input.batchSize ?? 32);
  const recipe = embeddingRecipeIdentityForProvider(input.provider);
  return {
    providerIdentity: input.provider.identity,
    async build(builderInput) {
      const vectors: EmbeddingVector[] = [];
      const total = builderInput.documents.length;
      builderInput.progress?.({ phase: "embedding", total, completed: 0 });
      for (let offset = 0; offset < builderInput.documents.length; offset += batchSize) {
        const batch = builderInput.documents.slice(offset, offset + batchSize);
        const encoded = await input.embedding.encode({
          texts: batch.map((document) => document.text),
          inputKind: "document",
          provider: input.providerPayload
        }, {
          deadline: builderInput.deadline ?? Date.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS,
          cancellationId: builderInput.cancellationId ?? `${builderInput.vaultRoot}:embedding-build`,
          vault: builderInput.vaultRoot,
          onProgress: builderInput.progress
        });
        assertProviderIdentityMatches(encoded.provider, input.provider.identity);
        if (encoded.vectors.length !== batch.length) {
          throw new Error(`embedding worker returned ${encoded.vectors.length} vectors for ${batch.length} documents`);
        }
        vectors.push(...encoded.vectors);
        builderInput.progress?.({
          phase: "embedding",
          total,
          completed: Math.min(total, offset + batch.length),
          current: batch[batch.length - 1]?.path,
          message: `${vectors.length} vectors`
        });
      }
      return buildEmbeddingSetFromVectors({
        provider: input.provider.identity,
        recipe,
        documents: builderInput.documents,
        vectors
      });
    }
  };
}

export function createLocalOnnxEmbeddingSetBuilder(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env
): RetrievalEmbeddingSetBuilder {
  return createProviderEmbeddingSetBuilder(createLocalOnnxProviderFromConfig(settings, env));
}

export function createConfiguredEmbeddingSetBuilder(
  settings: OptsidianSettings = {},
  env: NodeJS.ProcessEnv = process.env
): RetrievalEmbeddingSetBuilder {
  const provider = env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (provider === "deterministic-hash" || provider === "deterministic") {
    return createProviderEmbeddingSetBuilder(new DeterministicHashProvider());
  }
  return createLocalOnnxEmbeddingSetBuilder(settings, env);
}

function snapshotEnvelope(built: BuiltSnapshot): SnapshotEnvelope {
  return {
    schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
    snapshotId: built.snapshotId,
    corpusSnapshotId: built.corpusSnapshotId,
    linkGraphId: built.linkGraphId,
    manifest: built.manifest,
    canonicalManifestSha256: built.canonicalManifestSha256,
    documents: built.documents,
    diagnostics: built.diagnostics
  };
}

export function computeRetrievalSnapshotId(input: {
  corpusSnapshotId: string;
  linkGraphId: string;
  embeddingSetId: string;
  retrieverPlanIdentity: string;
  rankingFeatureVersion: string;
}): RetrievalSnapshotId {
  return sha256(canonicalValueBytes({
    schemaVersion: 1,
    corpusSnapshotId: input.corpusSnapshotId,
    linkGraphId: input.linkGraphId,
    embeddingSetId: input.embeddingSetId,
    retrieverPlanIdentity: input.retrieverPlanIdentity,
    rankingFeatureVersion: input.rankingFeatureVersion
  }));
}

function retrievalSnapshotSourceFromEnvelope(envelope: SnapshotEnvelope): RetrievalSnapshotSource {
  return {
    snapshotId: envelope.snapshotId,
    corpusSnapshotId: envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(envelope.manifest),
    identityTuple: envelope.manifest.identityTuple,
    documents: envelope.documents,
    linkGraphId: envelope.linkGraphId
  };
}

function denseDocumentsForRetrievalSource(source: RetrievalSnapshotSource): EmbeddingSetDocumentInput[] {
  return source.documents.map((document) => ({
    documentId: document.documentId,
    shardDocRef: {
      segmentId: "",
      partitionId: document.partitionId,
      localDocId: 0,
      documentId: document.documentId
    },
    path: document.path,
    text: denseTextForDocument(document),
    contentHash: document.contentHash
  }));
}

function denseTextForDocument(document: PersistedDocumentRecord): string {
  const snippets = document.snippetCorpus.lines.map((line) => line.text).join("\n");
  const tags = document.tags.length > 0 ? `\n${document.tags.join(" ")}` : "";
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
    schemaVersion: 1,
    embeddingSetId: embeddingSet.embeddingSetId,
    recipe: embeddingSet.recipe,
    model: embeddingSet.model,
    dim: embeddingSet.dim,
    records: embeddingSet.records.map(({ shardDocRef: _shardDocRef, ...record }) => record)
  };
}

function vectorChunksForEmbeddingSet(
  records: readonly EmbeddingSetRecord[],
  spec: CoralEmbeddingSpec
): CoralChunkRecord[] {
  return records.map((record) => ({
    id: `${record.documentId}:0`,
    entryId: record.documentId,
    entryKind: "note",
    chunkIndex: 0,
    text: record.text,
    contentHash: record.contentHash,
    vector: record.vector,
    specId: spec.specId
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
      `got ${actual.id}/${actual.model}/${actual.dim}/${actual.version}`
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
      denseModel: provider.model
    }),
    rankingFeatureVersion: input.rankingFeatureVersion
  };
}

function retrievalPlanIdentityFor(input: { linkGraphId: LinkGraphId; denseModel: string }): string {
  const retrievers: RetrieverIdentity[] = [
    POSITIONAL_RETRIEVER_IDENTITY,
    {
      id: "dense",
      version: DENSE_RETRIEVER_VERSION,
      parameters: { model: input.denseModel, metric: "cosine" }
    },
    {
      id: "link-adjacency",
      version: LINK_ADJACENCY_RETRIEVER_VERSION,
      parameters: {
        linkGraphId: input.linkGraphId,
        resolverVersion: LINK_GRAPH_RESOLVER_VERSION,
        scoring: LINK_ADJACENCY_SCORING_VERSION,
        directScore: LINK_ADJACENCY_DIRECT_SCORE
      }
    }
  ];
  const parameters: FusionParameters = {
    algorithm: "rrf",
    k: DEFAULT_RRF_K,
    weights: retrievers.map((identity) => ({ retrieverId: identity.id, weight: 1 }))
  };
  return computeRetrieverPlanIdentity(retrievers, parameters);
}

async function storeRetrievalSnapshotEnvelope(
  paths: SearchStoreCachePaths,
  envelope: RetrievalSnapshotEnvelope
): Promise<void> {
  ensurePrivateDirSync(paths.retrievalsDir, "Optsidian retrieval snapshot directory");
  ensurePrivateDirSync(paths.tmpDir, "Optsidian search tmp directory");
  const target = path.join(paths.retrievalsDir, envelope.retrievalSnapshotId);
  const tmp = path.join(paths.tmpDir, `${envelope.retrievalSnapshotId}.${process.pid}.retrieval.tmp`);
  writePrivateFileSync(tmp, `${JSON.stringify(envelope)}\n`, "Optsidian retrieval snapshot envelope");
  fsyncFileSync(tmp);
  await durableRename(tmp, target);
  fsyncDirSync(paths.retrievalsDir);
}

function embeddingSpecId(embeddingSetId: EmbeddingSetId, model: string, dim: number): string {
  return sha256(canonicalValueBytes({
    schemaVersion: 1,
    embeddingSetId,
    model,
    dim,
    ann: "derived"
  }));
}

function linkGraphData(linkGraph: LinkGraphView) {
  return {
    schemaVersion: linkGraph.schemaVersion,
    linkGraphId: linkGraph.linkGraphId,
    corpusSnapshotId: linkGraph.corpusSnapshotId,
    resolverVersion: linkGraph.resolverVersion,
    edges: linkGraph.edges,
    backlinks: linkGraph.backlinks
  };
}

function envelopePartitionsBySegmentId(envelope: SnapshotEnvelope): SnapshotEnvelope["manifest"]["partitions"] {
  return [...envelope.manifest.partitions].sort((left, right) => left.partitionId - right.partitionId || compareCodePoint(left.segmentHash, right.segmentHash));
}

function sharedBytes(bytes: Uint8Array): Uint8Array {
  const shared = new SharedArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(shared);
  view.set(bytes);
  return view;
}

function sharedHandle(bytes: Uint8Array): SharedBytesHandle {
  if (!(bytes.buffer instanceof SharedArrayBuffer)) throw new Error("snapshot bytes are not shared");
  return {
    buffer: bytes.buffer,
    byteOffset: bytes.byteOffset,
    byteLength: bytes.byteLength
  };
}

function verifyBm25StatsFromVerifiedSegments(
  manifest: SnapshotEnvelope["manifest"],
  segmentStats: readonly (readonly CanonicalBm25FieldStats[])[]
): PositionalBm25GlobalStats {
  const persistedStats = {
    bm25StatsSchemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats,
    bm25GlobalStatsRows: manifest.bm25GlobalStatsRows
  };
  const persistedHash = canonicalBm25GlobalStatsHash(persistedStats);
  if (persistedHash !== manifest.bm25GlobalStatsHash) {
    throw new Error("BM25 global stats hash mismatch in snapshot manifest");
  }
  const recomputed = reduceCanonicalBm25GlobalStats(segmentStats, SEARCH_TOKEN_CHANNELS);
  if (recomputed.bm25GlobalStatsHash !== manifest.bm25GlobalStatsHash) {
    throw new Error("BM25 global stats mismatch between manifest and verified segment bytes");
  }
  return positionalBm25GlobalStatsFromManifest(manifest);
}

function positionalBm25GlobalStatsFromManifest(manifest: SnapshotEnvelope["manifest"]): PositionalBm25GlobalStats {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: searchTokenChannel(entry.channel, "BM25 corpus stats channel"),
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: searchTokenChannel(row[0], "BM25 global stats row channel"),
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3]
    })),
    hash: manifest.bm25GlobalStatsHash
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

function protectedStoreIdsForPrune(
  loaded: ReadonlyMap<string, LoadedSnapshot>,
  lifecycleStoreRefs: ReadonlyMap<string, number>,
  extra: ReadonlySet<string> = new Set()
): Set<string> {
  return new Set([
    ...[...loaded.values()].map((snapshot) => snapshot.vaultKey),
    ...lifecycleStoreRefs.keys(),
    ...extra
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

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).sort(compareCodePoint);
  } catch {
    return [];
  }
}

function sweepStaleTmpDir(dirPath: string, nowMs = Date.now()): void {
  for (const file of safeReadDir(dirPath)) {
    const filePath = path.join(dirPath, file);
    if (!isStaleTmpPath(filePath, nowMs)) continue;
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

function isStaleTmpPath(filePath: string, nowMs: number): boolean {
  try {
    return nowMs - fs.statSync(filePath).mtimeMs >= TMP_STALE_MS;
  } catch {
    return false;
  }
}

function retainedSnapshotFiles(dirPath: string, count: number): string[] {
  return safeReadDir(dirPath)
    .filter(isValidSnapshotId)
    .sort((left, right) => compareCodePoint(right, left))
    .slice(0, count)
}

function currentContentHashes(vaultRoot: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const abs of walkFiles(vaultRoot, vaultRoot, { includeHidden: false, all: false })) {
    const rel = vaultRelative(vaultRoot, abs);
    hashes.set(rel, sha256(fs.readFileSync(abs)));
  }
  return hashes;
}

function reportRefreshDelta(context: SnapshotRequestContext, delta: SnapshotContentDelta): void {
  context.progress?.({
    phase: "scanning",
    total: delta.changedCount,
    completed: 0,
    current: firstRefreshDeltaPath(delta),
    message: refreshDeltaMessage(delta)
  });
}

function firstRefreshDeltaPath(delta: SnapshotContentDelta): string | undefined {
  return delta.added[0] ?? delta.modified[0] ?? delta.deleted[0];
}

function refreshDeltaMessage(delta: SnapshotContentDelta): string {
  const parts = [
    countLabel(delta.added.length, "added"),
    countLabel(delta.modified.length, "modified"),
    countLabel(delta.deleted.length, "deleted")
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "already fresh";
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
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function searchAnalyzerRuntimeFromProcess(): { node: string; icu?: string } {
  return {
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {})
  };
}

function isValidSnapshotId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function assertValidSnapshotId(value: string): void {
  if (!isValidSnapshotId(value)) {
    throw Object.assign(new Error("snapshotId must be a 64-character lowercase hex string"), { code: "BAD_REQUEST" });
  }
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  return (
    isRecord(value) &&
    value.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    typeof value.snapshotId === "string" &&
    typeof value.linkGraphId === "string" &&
    isRecord(value.manifest) &&
    typeof value.canonicalManifestSha256 === "string" &&
    Array.isArray(value.documents) &&
    isRecord(value.diagnostics) &&
    value.diagnostics.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    !("documents" in value.diagnostics)
  );
}

function isActivePointer(value: unknown): value is ActivePointer {
  return (
    isRecord(value) &&
    value.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    typeof value.snapshotId === "string" &&
    typeof value.canonicalManifestSha256 === "string"
  );
}

function isRetrievalActivePointer(value: unknown): value is RetrievalActivePointer {
  return (
    isRecord(value) &&
    value.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    typeof value.retrievalSnapshotId === "string" &&
    typeof value.snapshotId === "string" &&
    typeof value.corpusSnapshotId === "string" &&
    typeof value.linkGraphId === "string" &&
    typeof value.embeddingSetId === "string" &&
    typeof value.vectorGenerationId === "string"
  );
}

function isRetrievalSnapshotEnvelope(value: unknown): value is RetrievalSnapshotEnvelope {
  return (
    isRecord(value) &&
    value.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    typeof value.retrievalSnapshotId === "string" &&
    typeof value.snapshotId === "string" &&
    typeof value.corpusSnapshotId === "string" &&
    typeof value.linkGraphId === "string" &&
    typeof value.embeddingSetId === "string" &&
    typeof value.retrieverPlanIdentity === "string" &&
    typeof value.rankingFeatureVersion === "string" &&
    typeof value.canonicalManifestSha256 === "string" &&
    isRecord(value.embeddingSet) &&
    isRecord(value.vector) &&
    isRecord(value.freshness)
  );
}

function retrievalEnvelopeMatchesPointer(
  envelope: RetrievalSnapshotEnvelope,
  pointer: RetrievalActivePointer
): boolean {
  return envelope.retrievalSnapshotId === pointer.retrievalSnapshotId &&
    envelope.snapshotId === pointer.snapshotId &&
    envelope.corpusSnapshotId === pointer.corpusSnapshotId &&
    envelope.linkGraphId === pointer.linkGraphId &&
    envelope.embeddingSetId === pointer.embeddingSetId &&
    envelope.vector.generationId === pointer.vectorGenerationId;
}

function freshnessStateReason(state: string): RetrievalPinNotReadyReason {
  if (state === "dirty") return "retrieval-state-dirty";
  if (state === "building") return "retrieval-state-building";
  if (state === "failed") return "retrieval-state-failed";
  return "retrieval-state-stale";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
