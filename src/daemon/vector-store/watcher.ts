import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readVaultFileHardened, resolveVaultPath, shouldSkipDir, walkFiles, type SafePath } from "../../core/path.js";

export type VaultDirtyMark = {
  docId: string;
  path: string;
  contentHash?: string;
};

export type VaultDirtyMarkConsumer = (marks: readonly VaultDirtyMark[]) => void | Promise<void>;

export type RetrievalSaveWatcher = {
  close(): void;
  flushNow?(): Promise<readonly VaultDirtyMark[]>;
  unref?(): void;
};

export type WatchDirectory = (
  dir: string,
  listener: (eventType: fs.WatchEventType, filename: string | Buffer | null) => void
) => RetrievalSaveWatcher;

export type VaultChangeProducerOptions = {
  vaultRoot: string;
  onDirtyMarks?: VaultDirtyMarkConsumer;
  debounceMs?: number;
  fallbackPollMs?: number;
  autoStart?: boolean;
  watchDirectory?: WatchDirectory;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  setInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
};

type PendingDirtyPath = {
  docId: string;
  path: string;
};

export class VaultChangeProducer implements RetrievalSaveWatcher {
  private readonly vaultRoot: string;
  private readonly onDirtyMarks: VaultDirtyMarkConsumer | undefined;
  private readonly debounceMs: number;
  private readonly fallbackPollMs: number;
  private readonly watchDirectory: WatchDirectory;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (timer: NodeJS.Timeout) => void;
  private readonly watched = new Map<string, RetrievalSaveWatcher>();
  private readonly pending = new Map<string, PendingDirtyPath>();
  private knownContentHashes = new Map<string, string>();
  private contentHashBaselineReady = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<readonly VaultDirtyMark[]> | undefined;
  private started = false;
  private closed = false;
  private fallbackScanActive = false;

  constructor(options: VaultChangeProducerOptions) {
    this.vaultRoot = fs.realpathSync(options.vaultRoot);
    this.onDirtyMarks = options.onDirtyMarks;
    this.debounceMs = options.debounceMs ?? 250;
    this.fallbackPollMs = options.fallbackPollMs ?? 5000;
    this.watchDirectory = options.watchDirectory ?? ((dir, listener) => {
      const watcher = fs.watch(dir, listener);
      // An unhandled 'error' event on an fs.watch handle would throw as an uncaughtException and
      // exit the daemon. Route it to the periodic-scan fallback instead, matching how synchronous
      // watch-registration failures are already handled.
      watcher.on("error", (error) => this.startFallbackScan(error));
      return watcher;
    });
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
    if (options.autoStart !== false) this.start();
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.ensureContentHashBaseline();
    try {
      this.reconcile(this.vaultRoot);
      this.ensurePeriodicScan();
    } catch (error) {
      this.startFallbackScan(error);
    }
  }

  async flushNow(): Promise<readonly VaultDirtyMark[]> {
    if (this.debounceTimer) {
      this.clearTimer(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  usingFallbackScan(): boolean {
    return this.fallbackScanActive;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) {
      this.clearTimer(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.periodicTimer) {
      this.clearIntervalFn(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    this.fallbackScanActive = false;
    this.closeWatchers();
    this.pending.clear();
  }

  private handleWatchEvent(dir: string, eventType: fs.WatchEventType, filename: string | Buffer | null): void {
    if (this.closed || this.fallbackScanActive || !filename) return;
    if (eventType !== "change" && eventType !== "rename") return;
    const safe = this.resolveChangedPath(path.join(dir, filename.toString()));
    if (!safe) return;
    try {
      this.reconcile(safe.abs);
    } catch (error) {
      this.startFallbackScan(error);
    }
  }

  private queueResolvedMarkdownPath(safe: SafePath): void {
    if (!isMarkdownPath(safe.rel) || pathContainsSkippedDirectory(safe.rel, "file")) return;
    const docId = docIdForVaultPath(safe.rel);
    this.pending.set(docId, { docId, path: safe.rel });
    this.armDebounce();
  }

  private armDebounce(): void {
    if (this.closed) return;
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = undefined;
      void this.flushNow().catch(() => undefined);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async flushPending(): Promise<readonly VaultDirtyMark[]> {
    const pending = [...this.pending.values()].sort((left, right) => {
      return left.docId.localeCompare(right.docId) || left.path.localeCompare(right.path);
    });
    this.pending.clear();
    if (pending.length === 0) return [];
    const marks: VaultDirtyMark[] = [];
    for (const item of pending) {
      const mark = this.dirtyMarkForPath(item.path);
      if (mark) marks.push(mark);
    }
    if (marks.length === 0) return [];
    await this.onDirtyMarks?.(marks);
    return marks;
  }

  private dirtyMarkForPath(inputPath: string): VaultDirtyMark | undefined {
    const safe = this.resolveChangedPath(inputPath);
    if (!safe || !isMarkdownPath(safe.rel) || pathContainsSkippedDirectory(safe.rel, "file")) return undefined;
    try {
      const read = readVaultFileHardened(this.vaultRoot, safe.rel);
      if (!read.stat.isFile()) return undefined;
      const mark = {
        docId: docIdForVaultPath(read.safe.rel),
        path: read.safe.rel,
        contentHash: sha256(read.bytes)
      };
      this.knownContentHashes.set(mark.path, mark.contentHash);
      return mark;
    } catch {
      this.knownContentHashes.delete(safe.rel);
      return {
        docId: docIdForVaultPath(safe.rel),
        path: safe.rel
      };
    }
  }

  private resolveChangedPath(inputPath: string): SafePath | undefined {
    try {
      return resolveVaultPath(this.vaultRoot, inputPath, { mustExist: false });
    } catch {
      return undefined;
    }
  }

  private reconcile(subtree: string): void {
    if (this.closed) return;
    const safe = this.resolveChangedPath(subtree);
    if (!safe) return;
    const stat = lstatIfExists(safe.abs);
    this.dropMissingWatchers(safe.abs);

    if (!stat) {
      this.reconcileMissing(safe);
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (pathContainsSkippedDirectory(safe.rel, "dir")) return;
      this.reconcileExistingDirectory(safe.abs);
      return;
    }
    this.reconcileExistingFile(safe);
  }

  private reconcileExistingDirectory(dir: string): void {
    const watchDirs = new Set<string>();
    for (const watchDir of enumerateWatchDirs(this.vaultRoot, dir)) {
      const safe = resolveVaultPath(this.vaultRoot, watchDir, { mustExist: true });
      if (pathContainsSkippedDirectory(safe.rel, "dir")) continue;
      watchDirs.add(safe.abs);
      this.reopenWatchDir(safe.abs);
    }
    for (const watchedDir of [...this.watched.keys()]) {
      if (isPathWithinOrEqual(watchedDir, dir) && !watchDirs.has(watchedDir)) this.closeWatchedDir(watchedDir);
    }

    const next = new Map(this.knownContentHashes);
    const hashes = this.scanMarkdownContentHashes(dir);
    const safe = resolveVaultPath(this.vaultRoot, dir, { mustExist: true });
    const prefix = safe.rel ? `${normalizeVaultRelativePath(safe.rel)}/` : "";
    for (const relPath of this.knownContentHashes.keys()) {
      if (!pathIsInSubtree(relPath, safe.rel, prefix)) continue;
      if (hashes.has(relPath)) continue;
      next.delete(relPath);
      this.queueResolvedMarkdownPath(resolveVaultPath(this.vaultRoot, relPath, { mustExist: false }));
    }
    for (const [relPath, contentHash] of hashes) {
      if (this.knownContentHashes.get(relPath) === contentHash) continue;
      next.set(relPath, contentHash);
      this.queueResolvedMarkdownPath(resolveVaultPath(this.vaultRoot, relPath, { mustExist: false }));
    }
    this.knownContentHashes = next;
  }

  private reconcileExistingFile(safe: SafePath): void {
    if (!isMarkdownPath(safe.rel) || pathContainsSkippedDirectory(safe.rel, "file")) return;
    const next = new Map(this.knownContentHashes);
    try {
      const read = readVaultFileHardened(this.vaultRoot, safe.rel);
      if (!read.stat.isFile()) return;
      const contentHash = sha256(read.bytes);
      if (this.knownContentHashes.get(read.safe.rel) !== contentHash) {
        next.set(read.safe.rel, contentHash);
        this.queueResolvedMarkdownPath(read.safe);
      }
    } catch {
      next.delete(safe.rel);
      this.queueResolvedMarkdownPath(safe);
    }
    this.knownContentHashes = next;
  }

  private reconcileMissing(safe: SafePath): void {
    this.closeWatchedSubtree(safe.abs);
    if (isMarkdownPath(safe.rel) && !pathContainsSkippedDirectory(safe.rel, "file")) {
      if (this.knownContentHashes.has(safe.rel)) {
        this.knownContentHashes.delete(safe.rel);
        this.queueResolvedMarkdownPath(safe);
      }
      return;
    }

    const prefix = safe.rel ? `${normalizeVaultRelativePath(safe.rel)}/` : "";
    for (const relPath of [...this.knownContentHashes.keys()]) {
      if (!pathIsInSubtree(relPath, safe.rel, prefix)) continue;
      this.knownContentHashes.delete(relPath);
      this.queueResolvedMarkdownPath(resolveVaultPath(this.vaultRoot, relPath, { mustExist: false }));
    }
  }

  private reopenWatchDir(dir: string): void {
    if (this.closed || this.fallbackScanActive) return;
    this.closeWatchedDir(dir);
    const watcher = this.watchDirectory(dir, (eventType, filename) => {
      this.handleWatchEvent(dir, eventType, filename);
    });
    watcher.unref?.();
    this.watched.set(dir, watcher);
  }

  private startFallbackScan(_reason: unknown): void {
    if (this.closed || this.fallbackScanActive) return;
    this.fallbackScanActive = true;
    this.closeWatchers();
    this.ensureContentHashBaseline();
    this.ensurePeriodicScan();
  }

  private ensurePeriodicScan(): void {
    if (this.closed || this.periodicTimer) return;
    this.periodicTimer = this.setIntervalFn(() => {
      if (this.fallbackScanActive) this.reconcile(this.vaultRoot);
      else this.dropMissingWatchers();
    }, this.fallbackPollMs);
    this.periodicTimer.unref?.();
  }

  private scanMarkdownContentHashes(start: string = this.vaultRoot): Map<string, string> {
    const hashes = new Map<string, string>();
    let files: string[];
    try {
      files = walkFiles(this.vaultRoot, start, { includeHidden: false, all: false });
    } catch {
      return hashes;
    }
    for (const file of files) {
      const safe = this.resolveChangedPath(file);
      if (!safe || pathContainsSkippedDirectory(safe.rel, "file")) continue;
      try {
        const read = readVaultFileHardened(this.vaultRoot, safe.rel);
        if (read.stat.isFile()) hashes.set(read.safe.rel, sha256(read.bytes));
      } catch {
        // Unreadable files are ignored until the next content scan.
      }
    }
    return hashes;
  }

  private ensureContentHashBaseline(): void {
    if (this.contentHashBaselineReady) return;
    this.knownContentHashes = this.scanMarkdownContentHashes();
    this.contentHashBaselineReady = true;
  }

  private closeWatchers(): void {
    for (const watcher of this.watched.values()) watcher.close();
    this.watched.clear();
  }

  private closeWatchedSubtree(dir: string): void {
    for (const watchedDir of [...this.watched.keys()]) {
      if (isPathWithinOrEqual(watchedDir, dir)) this.closeWatchedDir(watchedDir);
    }
  }

  private closeWatchedDir(dir: string): void {
    const watcher = this.watched.get(dir);
    if (!watcher) return;
    watcher.close();
    this.watched.delete(dir);
  }

  private dropMissingWatchers(subtree?: string): void {
    for (const dir of [...this.watched.keys()]) {
      if (subtree && !isPathWithinOrEqual(dir, subtree)) continue;
      const stat = lstatIfExists(dir);
      if (!stat?.isDirectory()) this.closeWatchedDir(dir);
    }
  }
}

export function startRetrievalSaveWatcher(options: VaultChangeProducerOptions): VaultChangeProducer {
  return new VaultChangeProducer(options);
}

export function docIdForVaultPath(relPath: string): string {
  return sha256(Buffer.from(normalizeVaultRelativePath(relPath), "utf8"));
}

function enumerateWatchDirs(vaultRoot: string, start: string): string[] {
  const rootSafe = resolveVaultPath(vaultRoot, start, { mustExist: true });
  const output: string[] = [];
  const visit = (dir: string) => {
    output.push(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name, false)) continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(rootSafe.abs);
  return output;
}

function pathContainsSkippedDirectory(relPath: string, kind: "file" | "dir"): boolean {
  const parts = normalizeVaultRelativePath(relPath).split("/").filter((part) => part && part !== ".");
  const dirs = kind === "file" ? parts.slice(0, -1) : parts;
  return dirs.some((part) => shouldSkipDir(part, false));
}

function pathIsInSubtree(relPath: string, subtreeRel: string, subtreePrefix: string): boolean {
  const normalized = normalizeVaultRelativePath(relPath);
  const subtree = normalizeVaultRelativePath(subtreeRel);
  if (!subtree) return true;
  return normalized === subtree || normalized.startsWith(subtreePrefix);
}

function isPathWithinOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isMarkdownPath(relPath: string): boolean {
  return path.posix.extname(normalizeVaultRelativePath(relPath)).toLowerCase() === ".md";
}

function normalizeVaultRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
