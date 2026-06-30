import fs from "node:fs";
import path from "node:path";
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
      await this.write({
        ...current,
        state: "dirty",
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

function sweepTmpDir(dir: string | undefined): void {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
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
