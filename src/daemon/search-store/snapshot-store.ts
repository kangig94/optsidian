import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer, type SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../core/search/analysis/index.js";
import {
  canonicalBm25GlobalStatsHash,
  decodeCanonicalSegment,
  canonicalValueBytes,
  reduceCanonicalBm25GlobalStats,
  snapshotIdFromManifest,
  type CanonicalBm25FieldStats
} from "../../core/search/segments/index.js";
import type { PositionalBm25GlobalStats } from "../../core/search/retrieval/positional/index.js";
import type { PinnedSnapshot, SnapshotManifestView, SnapshotStore, SnapshotView } from "../../core/search/contracts.js";
import { recordVaultAccess, recentVaultAccessRoots } from "../../core/vault-access.js";
import { vaultRelative, walkFiles } from "../../core/path.js";
import { readOptsidianSettings, searchNgramEnabled } from "../../core/settings.js";
import {
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../../core/search/index-settings.js";
import type { SearchIndexProgressUpdate } from "../protocol.js";
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
  SNAPSHOT_PERSISTENCE_VERSION,
  type ActivePointer,
  type BuiltSnapshot,
  type PersistedDocumentRecord,
  type SnapshotEnvelope
} from "./types.js";

export type DaemonSnapshotStoreOptions = {
  env?: NodeJS.ProcessEnv;
  countCap?: number;
  byteCap?: number;
  retentionCount?: number;
  analyzer?: SearchAnalyzer;
  analyzerIdentity?: SearchAnalyzerIdentity;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  snapshotBuilder?: (input: SnapshotBuilderInput) => Promise<BuiltSnapshot>;
  partitionBits?: number;
  durableRenameSegment?: DurableRename;
  durableRenameManifest?: DurableRename;
  durableRenameActivePointer?: DurableRename;
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

type LoadedSnapshot = {
  vaultRoot: string;
  vaultKey: string;
  snapshotId: string;
  envelope: SnapshotEnvelope;
  view: SnapshotView;
  documentsByDocumentId: Map<string, PersistedDocumentRecord>;
  documentBytes: Uint8Array;
  segmentBytes: Map<string, Uint8Array>;
  bm25Stats: PositionalBm25GlobalStats;
  byteLength: number;
  refCount: number;
  pinTokens: Set<string>;
  lastAccessMs: number;
};

type GcRoots = {
  snapshotIds: Set<string>;
  segmentHashes: Set<string>;
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
  private readonly partitionBits: number;
  private readonly analyzer: SearchAnalyzer | undefined;
  private readonly analyzerIdentity: SearchAnalyzerIdentity;
  private readonly searchSettings: IndexAffectingSearchSettings;
  private readonly snapshotBuilder: ((input: SnapshotBuilderInput) => Promise<BuiltSnapshot>) | undefined;
  private readonly renameSegment: DurableRename;
  private readonly renameManifest: DurableRename;
  private readonly renameActive: DurableRename;
  private readonly loaded = new Map<string, LoadedSnapshot>();
  private readonly activeByVault = new Map<string, string>();
  private readonly inFlightPublishManifests = new Map<string, SnapshotEnvelope>();
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
    this.partitionBits = options.partitionBits ?? DEFAULT_PARTITION_BITS;
    const settings = readOptsidianSettings(process.cwd(), this.env);
    this.searchSettings = normalizeIndexAffectingSearchSettings(
      options.searchSettings ?? { ngram: searchNgramEnabled(this.env, settings) }
    );
    const runtime = searchAnalyzerRuntimeFromProcess();
    this.analyzer = options.analyzer ?? (options.snapshotBuilder ? undefined : resolveSearchAnalyzer(this.env, settings, runtime));
    this.analyzerIdentity = options.analyzerIdentity ?? options.analyzer?.identity ?? this.analyzer?.identity ?? resolveSearchAnalyzer(this.env, settings, runtime).identity;
    this.snapshotBuilder = options.snapshotBuilder;
    this.renameSegment = options.durableRenameSegment ?? durableRename;
    this.renameManifest = options.durableRenameManifest ?? durableRename;
    this.renameActive = options.durableRenameActivePointer ?? durableRename;
  }

  searchAnalyzerIdentity(): SearchAnalyzerIdentity {
    return this.analyzerIdentity;
  }

  async loadVault(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<LoadVaultResult> {
    try {
      const snapshotId = await this.ensureActiveSnapshot(vaultRoot, context);
      return {
        ok: true,
        command: "index",
        action: "warm",
        vaults: [{ vaultRoot: this.paths(vaultRoot).vaultRoot, status: "ready" }],
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
    const snapshotId = await this.publishFreshSnapshot(vaultRoot, context);
    return {
      ok: true,
      command: "index",
      action: "rebuild",
      snapshotId
    };
  }

  async refresh(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<{ ok: true; command: "index"; action: "refresh"; rebuilt: boolean; snapshotId?: string }> {
    const before = this.readActivePointer(this.paths(vaultRoot))?.snapshotId;
    const snapshotId = await this.publishFreshSnapshot(vaultRoot, context);
    return {
      ok: true,
      command: "index",
      action: "refresh",
      rebuilt: before !== snapshotId,
      snapshotId
    };
  }

  async compact(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<{ ok: true; command: "index"; action: "compact"; rebuilt: boolean; snapshotId?: string }> {
    const snapshotId = await this.ensureActiveSnapshot(vaultRoot, context);
    const paths = this.paths(vaultRoot);
    await this.recoverVault(paths);
    this.markSweepGc(paths);
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
    await this.recoverVault(paths);
    fs.rmSync(paths.activePointerPath, { force: true });
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
    return {
      ok: true,
      command: "index",
      action: "clear"
    };
  }

  async pin(vaultRoot: string, snapshotId?: string, context: SnapshotRequestContext = {}): Promise<PinnedSnapshot> {
    const paths = this.paths(vaultRoot);
    if (snapshotId !== undefined) assertValidSnapshotId(snapshotId);
    const activeSnapshotId = snapshotId ?? await this.ensureActiveSnapshot(vaultRoot, context);
    const loaded = await this.ensureLoaded(paths, activeSnapshotId);
    loaded.refCount += 1;
    loaded.lastAccessMs = Date.now();
    this.vaultAccessMs.set(paths.vaultStateHash, loaded.lastAccessMs);
    recordVaultAccess(paths.vaultRoot, { env: this.env, nowMs: loaded.lastAccessMs });
    const pinToken = `${paths.vaultStateHash}:${activeSnapshotId}:${loaded.refCount}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    loaded.pinTokens.add(pinToken);
    this.enforceBudget();
    return {
      snapshotId: activeSnapshotId,
      view: loaded.view,
      pinToken
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
    this.markSweepGc(this.paths(snapshot.vaultRoot));
  }

  snapshotHandleForPin(pin: PinnedSnapshot): SearchExecutionSnapshotHandle {
    const snapshot = this.loadedForPin(pin);
    return {
      snapshotId: snapshot.snapshotId,
      pinToken: pin.pinToken,
      bm25Stats: snapshot.bm25Stats,
      documents: sharedHandle(snapshot.documentBytes),
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

  private async publishFreshSnapshot(vaultRoot: string, context: SnapshotRequestContext = {}): Promise<string> {
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
    context.progress?.({
      phase: "publishing",
      total: built.segments.length,
      completed: 0
    });
    await this.publishBuiltSnapshot(paths, built);
    context.progress?.({
      phase: "publishing",
      total: built.segments.length,
      completed: built.segments.length
    });
    this.activeByVault.set(paths.vaultStateHash, built.snapshotId);
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

  private async publishBuiltSnapshot(paths: SearchStoreCachePaths, built: BuiltSnapshot): Promise<void> {
    this.ensureDirs(paths);
    const envelope = snapshotEnvelope(built);
    this.inFlightPublishManifests.set(built.snapshotId, envelope);
    try {
      for (const segment of built.segments) {
        const target = path.join(paths.segmentsDir, segment.hash);
        if (fs.existsSync(target)) {
          const existingHash = sha256(fs.readFileSync(target));
          if (existingHash === segment.hash) continue;
          fs.rmSync(target, { force: true });
        }
        const tmp = path.join(paths.tmpDir, `${segment.hash}.${process.pid}.segment.tmp`);
        fs.writeFileSync(tmp, segment.bytes);
        fsyncFileSync(tmp);
        fsyncDirSync(paths.tmpDir);
        const actual = sha256(fs.readFileSync(tmp));
        if (actual !== segment.hash) throw new Error(`segment hash verification failed for ${segment.hash}`);
        await this.renameSegment(tmp, target);
        fsyncDirSync(paths.segmentsDir);
      }

      const manifestPath = path.join(paths.snapshotsDir, built.snapshotId);
      const manifestTmp = path.join(paths.tmpDir, `${built.snapshotId}.${process.pid}.manifest.tmp`);
      fs.writeFileSync(manifestTmp, `${JSON.stringify(envelope)}\n`);
      fsyncFileSync(manifestTmp);
      await this.renameManifest(manifestTmp, manifestPath);
      fsyncDirSync(paths.snapshotsDir);

      const activePointer: ActivePointer = {
        schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
        snapshotId: built.snapshotId,
        canonicalManifestSha256: built.canonicalManifestSha256
      };
      const activeTmp = path.join(paths.tmpDir, `${built.snapshotId}.${process.pid}.active.tmp`);
      fs.writeFileSync(activeTmp, `${JSON.stringify(activePointer)}\n`);
      fsyncFileSync(activeTmp);
      await this.renameActive(activeTmp, paths.activePointerPath);
      fsyncDirSync(paths.activeDir);

      await this.recoverVault(paths);
      this.markSweepGc(paths);
    } finally {
      this.inFlightPublishManifests.delete(built.snapshotId);
    }
  }

  private async ensureLoaded(paths: SearchStoreCachePaths, snapshotId: string): Promise<LoadedSnapshot> {
    assertValidSnapshotId(snapshotId);
    const key = loadedKey(paths.vaultStateHash, snapshotId);
    const existing = this.loaded.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      return existing;
    }
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) throw new Error(`snapshot ${snapshotId} is not available for vault ${paths.vaultRoot}`);
    const loaded = this.loadEnvelope(paths, envelope);
    this.loaded.set(key, loaded);
    return loaded;
  }

  private loadEnvelope(paths: SearchStoreCachePaths, envelope: SnapshotEnvelope): LoadedSnapshot {
    const documentsByDocumentId = new Map(envelope.diagnostics.documents.map((document) => [document.documentId, document]));
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
    const view = this.createSnapshotView(envelope, segmentBytes, documentsByDocumentId);
    return {
      vaultRoot: paths.vaultRoot,
      vaultKey: paths.vaultStateHash,
      snapshotId: envelope.snapshotId,
      envelope,
      view,
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
    documents: Map<string, PersistedDocumentRecord>
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
      segmentBytes: (segmentId) => segmentBytes.get(segmentId),
      segmentManifest: (segmentId) => {
        const bytes = segmentBytes.get(segmentId);
        return bytes ? decodeCanonicalSegment(bytes) : undefined;
      },
      document: (documentId) => documents.get(documentId)?.searchDocument,
      canonicalFieldText: (documentId, field) => {
        const document = documents.get(documentId)?.searchDocument;
        if (!document) return undefined;
        if (field === "path") return [document.path];
        if (field === "title") return [document.title];
        if (field === "aliases") return document.aliases;
        if (field === "tags") return document.tags;
        if (field === "headings") return document.headings;
        return [document.body];
      },
      snippets: (request) => documents.get(request.documentId)?.lineSnippets.slice(0, request.maxSnippets ?? 3) ?? [],
      snippetBytes: (snippetId) => {
        const encoded = new TextEncoder().encode(snippetId);
        return sharedBytes(encoded);
      }
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
    for (const file of safeReadDir(paths.snapshotsDir)) {
      if (!roots.snapshotIds.has(file)) fs.rmSync(path.join(paths.snapshotsDir, file), { force: true });
    }
    for (const file of safeReadDir(paths.segmentsDir)) {
      if (!roots.segmentHashes.has(file)) fs.rmSync(path.join(paths.segmentsDir, file), { force: true });
    }
    sweepStaleTmpDir(paths.tmpDir);
  }

  private gcRoots(paths: SearchStoreCachePaths): GcRoots {
    const snapshotIds = new Set<string>();
    const segmentHashes = new Set<string>();
    const active = this.readActivePointer(paths);
    if (active) {
      snapshotIds.add(active.snapshotId);
      const envelope = this.readSnapshotEnvelope(paths, active.snapshotId);
      if (envelope) {
        for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
      }
    }
    for (const [snapshotId, envelope] of this.inFlightPublishManifests) {
      snapshotIds.add(snapshotId);
      for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const snapshot of this.loaded.values()) {
      if (snapshot.vaultKey !== paths.vaultStateHash || snapshot.refCount <= 0) continue;
      snapshotIds.add(snapshot.snapshotId);
      for (const partition of snapshot.envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    for (const file of retainedSnapshotFiles(paths.snapshotsDir, this.retentionCount)) {
      const envelope = this.readSnapshotEnvelope(paths, file);
      if (!envelope) continue;
      snapshotIds.add(envelope.snapshotId);
      for (const partition of envelope.manifest.partitions) segmentHashes.add(partition.segmentHash);
    }
    return { snapshotIds, segmentHashes };
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

  private readSnapshotEnvelope(paths: SearchStoreCachePaths, snapshotId: string): SnapshotEnvelope | undefined {
    if (!isValidSnapshotId(snapshotId)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.snapshotsDir, snapshotId), "utf8")) as unknown;
      if (!isSnapshotEnvelope(parsed)) return undefined;
      const actual = snapshotIdFromManifest(parsed.manifest);
      if (actual !== parsed.snapshotId || parsed.snapshotId !== snapshotId) return undefined;
      for (const partition of parsed.manifest.partitions) {
        if (!fs.existsSync(path.join(paths.segmentsDir, partition.segmentHash))) return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private snapshotIsFresh(paths: SearchStoreCachePaths, snapshotId: string): boolean {
    const envelope = this.readSnapshotEnvelope(paths, snapshotId);
    if (!envelope) return false;
    const current = currentContentHashes(paths.vaultRoot);
    if (current.size !== envelope.diagnostics.documents.length) return false;
    for (const document of envelope.diagnostics.documents) {
      if (current.get(document.path) !== document.contentHash) return false;
    }
    return true;
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
    fs.mkdirSync(paths.segmentsDir, { recursive: true });
    fs.mkdirSync(paths.snapshotsDir, { recursive: true });
    fs.mkdirSync(paths.activeDir, { recursive: true });
    fs.mkdirSync(paths.tmpDir, { recursive: true });
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
}

export function createDaemonSnapshotStore(options: DaemonSnapshotStoreOptions = {}): DaemonSnapshotStore {
  return new DaemonSnapshotStore(options);
}

function snapshotEnvelope(built: BuiltSnapshot): SnapshotEnvelope {
  return {
    schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
    snapshotId: built.snapshotId,
    manifest: built.manifest,
    canonicalManifestSha256: built.canonicalManifestSha256,
    diagnostics: built.diagnostics
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

function positiveCap(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.MAX_SAFE_INTEGER;
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
    isRecord(value.manifest) &&
    typeof value.canonicalManifestSha256 === "string" &&
    isRecord(value.diagnostics) &&
    value.diagnostics.schemaVersion === SNAPSHOT_PERSISTENCE_VERSION &&
    Array.isArray(value.diagnostics.documents)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
