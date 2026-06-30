import fs from "node:fs";
import path from "node:path";
import { resolveVaultPath, walkFiles } from "../../core/path.js";
import type { EmbeddingProvider } from "../../core/search/dense/index.js";
import { normalizeEmbeddingVector } from "../../core/search/dense/index.js";
import type { CoralChunkRecord, CoralEmbeddingSpec, VectorGenerationMetadata } from "./types.js";
import type { VectorStoreCachePaths } from "./cache-paths.js";
import { RetrievalFreshnessStore, type RetrievalPublishedSnapshot } from "./freshness.js";
import { VectorGenerationPool } from "./pool.js";

export type SavedNoteChange = {
  path: string;
  documentId: string;
  text: string;
  contentHash: string;
  corpusRevision: string;
};

export type EmbedOnSaveIndexPlaneOptions = {
  paths: VectorStoreCachePaths;
  freshness: RetrievalFreshnessStore;
  vectorPool: VectorGenerationPool;
  provider: EmbeddingProvider;
  spec: CoralEmbeddingSpec;
  initialChunks: readonly CoralChunkRecord[];
  debounceMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export class EmbedOnSaveIndexPlane {
  private readonly paths: VectorStoreCachePaths;
  private readonly freshness: RetrievalFreshnessStore;
  private readonly vectorPool: VectorGenerationPool;
  private readonly provider: EmbeddingProvider;
  private readonly spec: CoralEmbeddingSpec;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly chunksByEntryId = new Map<string, CoralChunkRecord>();
  private readonly pending = new Map<string, SavedNoteChange>();
  private timer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<void> | undefined;
  private lastPublished: RetrievalPublishedSnapshot | undefined;

  constructor(options: EmbedOnSaveIndexPlaneOptions) {
    this.paths = options.paths;
    this.freshness = options.freshness;
    this.vectorPool = options.vectorPool;
    this.provider = options.provider;
    this.spec = options.spec;
    this.debounceMs = options.debounceMs ?? 250;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    for (const chunk of options.initialChunks) this.chunksByEntryId.set(chunk.entryId, chunk);
    this.lastPublished = this.freshness.read().published;
  }

  async noteSaved(change: SavedNoteChange): Promise<void> {
    const safe = resolveVaultPath(this.paths.vaultRoot, change.path, { mustExist: false });
    const normalizedChange = {
      ...change,
      path: safe.rel
    };
    await this.freshness.markDirty(change.corpusRevision);
    this.pending.set(normalizedChange.documentId, normalizedChange);
    this.armDebounce();
  }

  async flushNow(): Promise<void> {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  changedEntryIdsForTests(): string[] {
    return [...this.pending.keys()].sort();
  }

  chunkForTests(entryId: string): CoralChunkRecord | undefined {
    return this.chunksByEntryId.get(entryId);
  }

  private armDebounce(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flushNow().catch(() => undefined);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async flushPending(): Promise<void> {
    const changes = [...this.pending.values()].sort((left, right) => left.documentId.localeCompare(right.documentId));
    if (changes.length === 0) return;
    this.pending.clear();
    const corpusRevision = changes[changes.length - 1].corpusRevision;
    await this.freshness.markBuilding(corpusRevision);
    const previousChunks = new Map(this.chunksByEntryId);
    try {
      for (const change of changes) {
        const vector = normalizeEmbeddingVector(await this.provider.embed(change.text, { inputKind: "document" }), this.provider.identity.dim);
        this.chunksByEntryId.set(change.documentId, {
          id: `${change.documentId}:0`,
          entryId: change.documentId,
          entryKind: "note",
          chunkIndex: 0,
          text: change.text,
          contentHash: change.contentHash,
          vector,
          specId: this.spec.specId
        });
      }
      const built = await this.vectorPool.buildStagingGeneration({
        paths: this.paths,
        spec: this.spec,
        chunks: [...this.chunksByEntryId.values()],
        engineName: "auto",
        generationId: `save-${this.now().toString(36)}`
      });
      await this.vectorPool.promoteBuiltGeneration(this.paths, built.metadata);
      const published = publishedFromGeneration(corpusRevision, built.metadata);
      this.lastPublished = published;
      await this.freshness.markFresh(published);
    } catch (error) {
      this.chunksByEntryId.clear();
      for (const [entryId, chunk] of previousChunks) this.chunksByEntryId.set(entryId, chunk);
      await this.freshness.markFailed(corpusRevision, error);
      throw error;
    }
  }
}

export type RetrievalSaveWatcher = {
  close(): void;
};

export function startRetrievalSaveWatcher(input: {
  vaultRoot: string;
  onMarkdownChange(path: string): void | Promise<void>;
}): RetrievalSaveWatcher {
  const root = fs.realpathSync(input.vaultRoot);
  const watched = new Map<string, fs.FSWatcher>();
  const watchDir = (dir: string) => {
    if (watched.has(dir)) return;
    const watcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || (eventType !== "change" && eventType !== "rename")) return;
      const abs = path.join(dir, filename.toString());
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          watchDir(abs);
          return;
        }
      } catch {}
      if (path.extname(abs).toLowerCase() === ".md") void input.onMarkdownChange(abs);
    });
    watcher.unref?.();
    watched.set(dir, watcher);
  };
  for (const file of walkFiles(root, root, { includeHidden: false, all: true })) {
    const dir = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    watchDir(dir);
  }
  watchDir(root);
  return {
    close() {
      for (const watcher of watched.values()) watcher.close();
      watched.clear();
    }
  };
}

function publishedFromGeneration(corpusRevision: string, metadata: VectorGenerationMetadata): RetrievalPublishedSnapshot {
  return {
    corpusRevision,
    embeddingSetId: metadata.embeddingSetId,
    vectorGenerationId: metadata.generationId
  };
}
