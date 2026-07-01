import fs from "node:fs";
import path from "node:path";
import { optsidianCacheRoot } from "../../core/cache-root.js";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../core/private-path.js";
import { durableRename, fsyncDirSync, fsyncFileSync, type DurableRename } from "../search-store/publication.js";
import type { VectorStoreCachePaths } from "./cache-paths.js";
import { sweepVectorStaging } from "./pool.js";

export type RetrievalFreshnessState = "fresh" | "dirty" | "building" | "failed";

export type RetrievalPublishedSnapshot = {
  corpusRevision: string;
  corpusSnapshotId?: string;
  linkGraphId?: string;
  embeddingSetId?: string;
  retrievalSnapshotId?: string;
  vectorGenerationId?: string;
};

export type RetrievalFreshnessRecord = {
  schemaVersion: 1;
  state: RetrievalFreshnessState;
  corpusRevision: string | null;
  published?: RetrievalPublishedSnapshot;
  rollback?: RetrievalPublishedSnapshot;
  error?: string;
  updatedAt: string;
};

export type RetrievalFreshnessStoreOptions = {
  paths: VectorStoreCachePaths;
  durableRenameState?: DurableRename;
  now?: () => number;
};

export class RetrievalFreshnessStore {
  private readonly paths: VectorStoreCachePaths;
  private readonly renameState: DurableRename;
  private readonly now: () => number;
  private cached: RetrievalFreshnessRecord | undefined;

  constructor(options: RetrievalFreshnessStoreOptions) {
    this.paths = options.paths;
    this.renameState = options.durableRenameState ?? durableRename;
    this.now = options.now ?? Date.now;
  }

  read(): RetrievalFreshnessRecord {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths.freshnessStatePath, "utf8")) as unknown;
      if (isRetrievalFreshnessRecord(parsed)) {
        this.cached = parsed;
        return parsed;
      }
    } catch {}
    this.cached = this.defaultDirtyUnknown();
    return this.cached;
  }

  async markDirty(corpusRevision: string): Promise<RetrievalFreshnessRecord> {
    const current = this.read();
    return this.write({
      schemaVersion: 1,
      state: "dirty",
      corpusRevision,
      ...(current.published ? { published: current.published, rollback: current.rollback ?? current.published } : {}),
      updatedAt: this.timestamp()
    });
  }

  async markBuilding(corpusRevision: string): Promise<RetrievalFreshnessRecord> {
    const current = this.read();
    return this.write({
      schemaVersion: 1,
      state: "building",
      corpusRevision,
      ...(current.published ? { published: current.published, rollback: current.rollback ?? current.published } : {}),
      updatedAt: this.timestamp()
    });
  }

  async markFresh(published: RetrievalPublishedSnapshot): Promise<RetrievalFreshnessRecord> {
    return this.write({
      schemaVersion: 1,
      state: "fresh",
      corpusRevision: published.corpusRevision,
      published,
      updatedAt: this.timestamp()
    });
  }

  async markFailed(corpusRevision: string, error: unknown): Promise<RetrievalFreshnessRecord> {
    const current = this.read();
    return this.write({
      schemaVersion: 1,
      state: "failed",
      corpusRevision,
      ...(current.published ? { published: current.published, rollback: current.rollback ?? current.published } : {}),
      error: error instanceof Error ? error.message : String(error),
      updatedAt: this.timestamp()
    });
  }

  async startupReconcile(input: {
    onDiskCorpusRevision: string;
    published?: RetrievalPublishedSnapshot;
  }): Promise<RetrievalFreshnessRecord> {
    const current = this.read();
    if (current.state === "building") {
      return this.write({
        ...current,
        state: "dirty",
        corpusRevision: input.onDiskCorpusRevision,
        updatedAt: this.timestamp()
      });
    }
    const published = input.published ?? this.read().published;
    if (published?.corpusRevision === input.onDiskCorpusRevision) {
      return this.markFresh(published);
    }
    return this.write({
      schemaVersion: 1,
      state: "dirty",
      corpusRevision: input.onDiskCorpusRevision,
      ...(published ? { published, rollback: published } : {}),
      updatedAt: this.timestamp()
    });
  }

  async resetBuildingToDirty(): Promise<RetrievalFreshnessRecord> {
    const current = this.read();
    if (current.state !== "building") return current;
    return this.write({
      ...current,
      state: "dirty",
      updatedAt: this.timestamp()
    });
  }

  isPubliclyServable(expectedCorpusRevision?: string): boolean {
    const current = this.read();
    if (current.state !== "fresh" || !current.published) return false;
    return expectedCorpusRevision === undefined || current.published.corpusRevision === expectedCorpusRevision;
  }

  async write(record: RetrievalFreshnessRecord): Promise<RetrievalFreshnessRecord> {
    ensurePrivateDirSync(path.dirname(this.paths.freshnessStatePath), "Optsidian retrieval freshness directory");
    ensurePrivateDirSync(this.paths.tmpDir, "Optsidian vector tmp directory");
    const tmp = path.join(this.paths.tmpDir, `freshness.${process.pid}.${Date.now()}.tmp`);
    writePrivateFileSync(tmp, `${JSON.stringify(record)}\n`, "Optsidian retrieval freshness state");
    fsyncFileSync(tmp);
    await this.renameState(tmp, this.paths.freshnessStatePath);
    fsyncDirSync(path.dirname(this.paths.freshnessStatePath));
    this.cached = record;
    return record;
  }

  private defaultDirtyUnknown(): RetrievalFreshnessRecord {
    return {
      schemaVersion: 1,
      state: "dirty",
      corpusRevision: null,
      updatedAt: this.timestamp()
    };
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

export async function recoverRetrievalStaging(input: {
  vectorPaths: VectorStoreCachePaths;
  lexicalTmpDir?: string;
  linkGraphTmpDir?: string;
  freshness: RetrievalFreshnessStore;
}): Promise<void> {
  await input.freshness.resetBuildingToDirty();
  sweepVectorStaging(input.vectorPaths);
  sweepTmpDir(input.lexicalTmpDir);
  sweepTmpDir(input.linkGraphTmpDir);
}

export async function recoverRetrievalStartupState(input: {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
} = {}): Promise<void> {
  const env = input.env ?? process.env;
  const cacheRoot = optsidianCacheRoot(env);
  const searchStores = readSearchStoreRecoveryState(path.join(cacheRoot, "search", "stores"));
  const vectorStoresRoot = path.join(cacheRoot, "vectors", "stores");
  for (const profileHash of safeReadDir(vectorStoresRoot)) {
    const profileDir = path.join(vectorStoresRoot, profileHash);
    if (!isDirectory(profileDir)) continue;
    for (const vaultStateHash of safeReadDir(profileDir)) {
      const vaultDir = path.join(profileDir, vaultStateHash);
      if (!isDirectory(vaultDir)) continue;
      const search = searchStores.get(vaultStateHash);
      const candidates = vectorEmbeddingSetCandidates(vaultDir);
      for (const embeddingSetId of candidates) {
        const vectorPaths = vectorPathsFromCacheParts({
          cacheRoot,
          profileHash,
          vaultStateHash,
          embeddingSetId
        });
        const freshness = new RetrievalFreshnessStore({ paths: vectorPaths, now: input.now });
        const current = freshness.read();
        const onDiskCorpusRevision = search?.onDiskCorpusRevision ??
          current.corpusRevision ??
          current.published?.corpusRevision ??
          current.rollback?.corpusRevision;
        if (onDiskCorpusRevision) {
          await freshness.startupReconcile({
            onDiskCorpusRevision,
            ...(search?.published ? { published: search.published } : {})
          });
        } else {
          await freshness.resetBuildingToDirty();
        }
        await recoverRetrievalStaging({
          vectorPaths,
          lexicalTmpDir: search?.tmpDir,
          linkGraphTmpDir: search?.tmpDir,
          freshness
        });
      }
    }
  }
}

function sweepTmpDir(dir: string | undefined): void {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

type SearchStoreRecoveryState = {
  tmpDir: string;
  onDiskCorpusRevision?: string;
  published?: RetrievalPublishedSnapshot;
};

function readSearchStoreRecoveryState(storesDir: string): Map<string, SearchStoreRecoveryState> {
  const stores = new Map<string, SearchStoreRecoveryState>();
  for (const vaultStateHash of safeReadDir(storesDir)) {
    const rootDir = path.join(storesDir, vaultStateHash);
    if (!isDirectory(rootDir)) continue;
    const tmpDir = path.join(rootDir, "tmp");
    const activeRetrieval = readJson(path.join(rootDir, "active", `${vaultStateHash}.retrieval`));
    const retrievalSnapshotId = isRecord(activeRetrieval) && typeof activeRetrieval.retrievalSnapshotId === "string"
      ? activeRetrieval.retrievalSnapshotId
      : undefined;
    const retrieval = retrievalSnapshotId
      ? readJson(path.join(rootDir, "retrievals", retrievalSnapshotId))
      : undefined;
    const activeCorpus = readJson(path.join(rootDir, "active", vaultStateHash));
    const activeSnapshotId = isRecord(activeCorpus) && typeof activeCorpus.snapshotId === "string"
      ? activeCorpus.snapshotId
      : undefined;
    const snapshot = activeSnapshotId ? readJson(path.join(rootDir, "snapshots", activeSnapshotId)) : undefined;
    stores.set(vaultStateHash, {
      tmpDir,
      ...(corpusRevisionFromSnapshot(snapshot) ?? corpusRevisionFromRetrieval(retrieval)
        ? { onDiskCorpusRevision: corpusRevisionFromSnapshot(snapshot) ?? corpusRevisionFromRetrieval(retrieval) }
        : {}),
      ...(publishedFromRetrieval(retrieval) ? { published: publishedFromRetrieval(retrieval) } : {})
    });
  }
  return stores;
}

function vectorEmbeddingSetCandidates(vaultDir: string): string[] {
  const candidates = new Set<string>();
  const state = readJson(path.join(vaultDir, "retrieval-freshness.json"));
  if (isRecord(state)) {
    const published = isRecord(state.published) ? state.published : undefined;
    const rollback = isRecord(state.rollback) ? state.rollback : undefined;
    if (typeof published?.embeddingSetId === "string") candidates.add(published.embeddingSetId);
    if (typeof rollback?.embeddingSetId === "string") candidates.add(rollback.embeddingSetId);
  }
  for (const entry of safeReadDir(vaultDir)) {
    const candidate = path.join(vaultDir, entry);
    if (isDirectory(candidate)) candidates.add(entry);
  }
  return [...candidates].sort();
}

function vectorPathsFromCacheParts(input: {
  cacheRoot: string;
  profileHash: string;
  vaultStateHash: string;
  embeddingSetId: string;
}): VectorStoreCachePaths {
  const vectorsRootDir = path.join(input.cacheRoot, "vectors");
  const storesDir = path.join(vectorsRootDir, "stores");
  const profileDir = path.join(storesDir, input.profileHash);
  const vaultDir = path.join(profileDir, input.vaultStateHash);
  const rootDir = path.join(vaultDir, input.embeddingSetId);
  const activeDir = path.join(rootDir, "active");
  return {
    vaultRoot: "",
    key: {
      profileHash: input.profileHash,
      vaultStateHash: input.vaultStateHash,
      embeddingSetId: input.embeddingSetId
    },
    cacheRootDir: input.cacheRoot,
    vectorsRootDir,
    storesDir,
    profileDir,
    vaultDir,
    rootDir,
    storeStatePath: path.join(rootDir, "store.json"),
    generationsDir: path.join(rootDir, "generations"),
    stagingDir: path.join(rootDir, "staging"),
    activeDir,
    tmpDir: path.join(rootDir, "tmp"),
    freshnessStatePath: path.join(vaultDir, "retrieval-freshness.json"),
    activePointerPath: path.join(activeDir, input.embeddingSetId)
  };
}

function corpusRevisionFromSnapshot(snapshot: unknown): string | undefined {
  return isRecord(snapshot) && typeof snapshot.corpusSnapshotId === "string" ? snapshot.corpusSnapshotId : undefined;
}

function corpusRevisionFromRetrieval(retrieval: unknown): string | undefined {
  if (!isRecord(retrieval)) return undefined;
  if (isRecord(retrieval.freshness) && typeof retrieval.freshness.corpusRevision === "string") {
    return retrieval.freshness.corpusRevision;
  }
  return typeof retrieval.corpusSnapshotId === "string" ? retrieval.corpusSnapshotId : undefined;
}

function publishedFromRetrieval(retrieval: unknown): RetrievalPublishedSnapshot | undefined {
  if (!isRecord(retrieval)) return undefined;
  const corpusRevision = corpusRevisionFromRetrieval(retrieval);
  const vector = isRecord(retrieval.vector) ? retrieval.vector : undefined;
  if (!corpusRevision) return undefined;
  return {
    corpusRevision,
    ...(typeof retrieval.corpusSnapshotId === "string" ? { corpusSnapshotId: retrieval.corpusSnapshotId } : {}),
    ...(typeof retrieval.linkGraphId === "string" ? { linkGraphId: retrieval.linkGraphId } : {}),
    ...(typeof retrieval.embeddingSetId === "string" ? { embeddingSetId: retrieval.embeddingSetId } : {}),
    ...(typeof retrieval.retrievalSnapshotId === "string" ? { retrievalSnapshotId: retrieval.retrievalSnapshotId } : {}),
    ...(typeof vector?.generationId === "string" ? { vectorGenerationId: vector.generationId } : {})
  };
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRetrievalFreshnessRecord(value: unknown): value is RetrievalFreshnessRecord {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.state === "fresh" || value.state === "dirty" || value.state === "building" || value.state === "failed") &&
    (typeof value.corpusRevision === "string" || value.corpusRevision === null) &&
    typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
