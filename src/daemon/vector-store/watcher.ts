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
  private fallbackTimer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<readonly VaultDirtyMark[]> | undefined;
  private started = false;
  private closed = false;

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
      this.watchDirectoryTree(this.vaultRoot);
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
    return this.fallbackTimer !== undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) {
      this.clearTimer(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.fallbackTimer) {
      this.clearIntervalFn(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
    this.closeWatchers();
    this.pending.clear();
  }

  private handleWatchEvent(dir: string, eventType: fs.WatchEventType, filename: string | Buffer | null): void {
    if (this.closed || this.fallbackTimer || !filename) return;
    if (eventType !== "change" && eventType !== "rename") return;
    const safe = this.resolveChangedPath(path.join(dir, filename.toString()));
    if (!safe) return;
    if (this.watchRuntimeDirectoryIfNeeded(safe)) return;
    this.queueResolvedMarkdownPath(safe);
  }

  private watchRuntimeDirectoryIfNeeded(safe: SafePath): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(safe.abs);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
    if (pathContainsSkippedDirectory(safe.rel, "dir")) return true;
    try {
      this.watchDirectoryTree(safe.abs);
    } catch (error) {
      this.startFallbackScan(error);
    }
    return true;
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

  private watchDirectoryTree(start: string): void {
    for (const dir of enumerateWatchDirs(this.vaultRoot, start)) {
      const safe = resolveVaultPath(this.vaultRoot, dir, { mustExist: true });
      if (!pathContainsSkippedDirectory(safe.rel, "dir")) this.watchDir(safe.abs);
    }
  }

  private watchDir(dir: string): void {
    if (this.closed || this.fallbackTimer || this.watched.has(dir)) return;
    const watcher = this.watchDirectory(dir, (eventType, filename) => {
      this.handleWatchEvent(dir, eventType, filename);
    });
    watcher.unref?.();
    this.watched.set(dir, watcher);
  }

  private startFallbackScan(_reason: unknown): void {
    if (this.closed || this.fallbackTimer) return;
    this.closeWatchers();
    this.ensureContentHashBaseline();
    this.fallbackTimer = this.setIntervalFn(() => {
      this.scanForContentDeltas();
    }, this.fallbackPollMs);
    this.fallbackTimer.unref?.();
  }

  private scanForContentDeltas(): void {
    if (this.closed) return;
    const next = this.scanMarkdownContentHashes();
    for (const relPath of this.knownContentHashes.keys()) {
      if (!next.has(relPath)) {
        const safe = this.resolveChangedPath(relPath);
        if (safe) this.queueResolvedMarkdownPath(safe);
      }
    }
    for (const [relPath, contentHash] of next) {
      if (this.knownContentHashes.get(relPath) !== contentHash) {
        const safe = this.resolveChangedPath(relPath);
        if (safe) this.queueResolvedMarkdownPath(safe);
      }
    }
    this.knownContentHashes = next;
  }

  private scanMarkdownContentHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    let files: string[];
    try {
      files = walkFiles(this.vaultRoot, this.vaultRoot, { includeHidden: false, all: false });
    } catch {
      return hashes;
    }
    for (const file of files) {
      const safe = this.resolveChangedPath(file);
      if (!safe || pathContainsSkippedDirectory(safe.rel, "file")) continue;
      try {
        const read = readVaultFileHardened(this.vaultRoot, safe.rel);
        if (read.stat.isFile()) hashes.set(read.safe.rel, sha256(read.bytes));
      } catch {}
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
