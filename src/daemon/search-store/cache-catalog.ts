import fs from 'node:fs';
import path from 'node:path';
import { optsidianCacheRoot } from '../../core/cache-root.js';
import {
  ensureExistingPrivateFileSync,
  ensurePrivateDirSync,
  writePrivateFileAtomicSync,
} from '../../core/private-path.js';
import type { SearchIndexPruneResult, SearchIndexPruneSkippedStore, SearchIndexPrunedStore } from '../../core/types.js';
import type { SearchStoreCachePaths } from './cache-paths.js';

const SEARCH_CACHE_CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_SEARCH_CACHE_UNUSED_DAYS = 30;
const SEARCH_CACHE_TOUCH_THROTTLE_MS = 24 * 60 * 60 * 1000;

type SearchCacheState = 'active' | 'cold' | 'pruning' | 'corrupt';

export type SearchCacheRecord = {
  schemaVersion: typeof SEARCH_CACHE_CATALOG_SCHEMA_VERSION;
  storeId: string;
  kind: 'search-store';
  createdAtMs: number;
  lastUsedAtMs: number;
  lastIndexedAtMs?: number;
  lastVerifiedAtMs?: number;
  activeSnapshotId?: string;
  bytes?: number;
  documentCount?: number;
  state: SearchCacheState;
};

export type SearchCacheCatalogFile = {
  schemaVersion: typeof SEARCH_CACHE_CATALOG_SCHEMA_VERSION;
  updatedAtMs: number;
  records: SearchCacheRecord[];
};

export type SearchCacheCatalogOptions = {
  env?: NodeJS.ProcessEnv;
};

export type SearchCacheTouchOptions = {
  nowMs?: number;
  throttleMs?: number;
  snapshotId?: string;
};

export type SearchCacheIndexedOptions = {
  nowMs?: number;
  snapshotId: string;
  documentCount?: number;
};

export type SearchCachePruneOptions = {
  unusedDays?: number;
  dryRun?: boolean;
  nowMs?: number;
  protectedStoreIds?: ReadonlySet<string>;
};

export class SearchCacheCatalog {
  private readonly env: NodeJS.ProcessEnv;
  private readonly recentTouches = new Map<string, { lastUsedAtMs: number; activeSnapshotId?: string }>();

  constructor(options: SearchCacheCatalogOptions = {}) {
    this.env = options.env ?? process.env;
  }

  touchUsed(paths: SearchStoreCachePaths, options: SearchCacheTouchOptions = {}): void {
    const nowMs = options.nowMs ?? Date.now();
    const throttleMs = options.throttleMs ?? SEARCH_CACHE_TOUCH_THROTTLE_MS;
    const memo = this.recentTouches.get(paths.storeId);
    const memoSnapshotChanged = options.snapshotId !== undefined && memo?.activeSnapshotId !== options.snapshotId;
    if (memo && !memoSnapshotChanged && nowMs - memo.lastUsedAtMs < throttleMs) return;

    const existing = this.readRecordForPaths(paths);
    const localExists = fs.existsSync(paths.storeStatePath);
    const snapshotChanged = options.snapshotId !== undefined && existing?.activeSnapshotId !== options.snapshotId;
    if (existing && localExists && !snapshotChanged && nowMs - existing.lastUsedAtMs < throttleMs) {
      if (!this.catalogHasRecord(paths.storeId)) {
        this.upsert(paths, existing);
        return;
      }
      this.recentTouches.set(paths.storeId, {
        lastUsedAtMs: existing.lastUsedAtMs,
        ...(existing.activeSnapshotId ? { activeSnapshotId: existing.activeSnapshotId } : {}),
      });
      return;
    }

    this.upsert(paths, {
      ...baseRecord(paths.storeId, existing, nowMs),
      lastUsedAtMs: nowMs,
      ...(options.snapshotId ? { activeSnapshotId: options.snapshotId } : {}),
      state: 'active',
    });
  }

  recordIndexed(paths: SearchStoreCachePaths, options: SearchCacheIndexedOptions): void {
    const nowMs = options.nowMs ?? Date.now();
    const existing = this.readRecordForPaths(paths);
    this.upsert(paths, {
      ...baseRecord(paths.storeId, existing, nowMs),
      lastUsedAtMs: nowMs,
      lastIndexedAtMs: nowMs,
      activeSnapshotId: options.snapshotId,
      ...(options.documentCount === undefined ? {} : { documentCount: options.documentCount }),
      state: 'active',
    });
  }

  recordCleared(paths: SearchStoreCachePaths, nowMs = Date.now()): void {
    const existing = this.readRecordForPaths(paths);
    const {
      activeSnapshotId: _activeSnapshotId,
      documentCount: _documentCount,
      ...record
    } = {
      ...baseRecord(paths.storeId, existing, nowMs),
      lastUsedAtMs: nowMs,
      state: 'cold' as const,
    };
    this.upsert(paths, record);
  }

  prune(options: SearchCachePruneOptions = {}): SearchIndexPruneResult {
    const nowMs = normalizeNowMs(options.nowMs);
    const unusedDays = normalizeUnusedDays(options.unusedDays);
    const dryRun = normalizeDryRun(options.dryRun);
    const protectedStoreIds = options.protectedStoreIds ?? new Set<string>();
    const cutoffMs = nowMs - unusedDays * 24 * 60 * 60 * 1000;
    this.ensureCatalogDirs();

    const catalog = this.readCatalog();
    const catalogRecords = new Map(catalog.records.map((record) => [record.storeId, record]));
    const storeIds = this.listKnownStoreIds(catalogRecords);
    const removedStores: SearchIndexPrunedStore[] = [];
    const skippedStores: SearchIndexPruneSkippedStore[] = [];
    const removedIds = new Set<string>();

    for (const storeId of storeIds) {
      if (!isStoreId(storeId)) {
        skippedStores.push({ storeId, reason: 'invalid-store-id' });
        continue;
      }
      if (protectedStoreIds.has(storeId)) {
        skippedStores.push({ storeId, reason: 'protected' });
        continue;
      }
      const rootDir = this.storeRootDir(storeId);
      const rootStat = lstatIfExists(rootDir);
      if (!rootStat) {
        removedIds.add(storeId);
        continue;
      }
      if (rootStat.isSymbolicLink()) {
        skippedStores.push({ storeId, reason: 'unsafe-symlink' });
        continue;
      }
      if (!rootStat.isDirectory()) {
        skippedStores.push({ storeId, reason: 'not-a-directory' });
        continue;
      }

      const record = this.readStoreRecord(rootDir, storeId) ?? catalogRecords.get(storeId);
      const lastUsedAtMs = record?.lastUsedAtMs ?? fallbackLastUsedAtMs(rootDir, storeId);
      if (!isUsableTimestamp(lastUsedAtMs)) {
        skippedStores.push({ storeId, reason: 'unknown-last-used' });
        continue;
      }
      if (lastUsedAtMs >= cutoffMs) continue;

      const removed: SearchIndexPrunedStore = {
        storeId,
        lastUsedAtMs,
        ...(record?.lastIndexedAtMs === undefined ? {} : { lastIndexedAtMs: record.lastIndexedAtMs }),
        bytes: directorySizeSync(rootDir),
      };
      removedStores.push(removed);
      removedIds.add(storeId);
      if (!dryRun) fs.rmSync(rootDir, { recursive: true, force: true });
    }

    if (!dryRun) {
      for (const storeId of removedIds) this.recentTouches.delete(storeId);
      const records = catalog.records
        .filter((record) => !removedIds.has(record.storeId))
        .filter((record) => fs.existsSync(this.storeRootDir(record.storeId)))
        .sort(compareRecordStoreId);
      this.writeCatalog({ schemaVersion: SEARCH_CACHE_CATALOG_SCHEMA_VERSION, updatedAtMs: nowMs, records });
    }

    return {
      ok: true,
      command: 'index',
      action: 'prune',
      dryRun,
      unusedDays,
      cutoffAt: new Date(cutoffMs).toISOString(),
      removedStores,
      skippedStores,
      removedBytes: removedStores.reduce((sum, store) => sum + store.bytes, 0),
    };
  }

  private upsert(paths: SearchStoreCachePaths, record: SearchCacheRecord): void {
    this.ensureStoreDirs(paths);
    const normalized = normalizeRecord(record);
    writePrivateFileAtomicSync(
      paths.storeStatePath,
      `${JSON.stringify(normalized)}\n`,
      'Optsidian search cache store metadata',
    );
    this.recentTouches.set(normalized.storeId, {
      lastUsedAtMs: normalized.lastUsedAtMs,
      ...(normalized.activeSnapshotId ? { activeSnapshotId: normalized.activeSnapshotId } : {}),
    });

    const catalog = this.readCatalog();
    const records = new Map(catalog.records.map((candidate) => [candidate.storeId, candidate]));
    records.set(normalized.storeId, normalized);
    this.writeCatalog({
      schemaVersion: SEARCH_CACHE_CATALOG_SCHEMA_VERSION,
      updatedAtMs: Date.now(),
      records: [...records.values()].sort(compareRecordStoreId),
    });
  }

  private readRecordForPaths(paths: SearchStoreCachePaths): SearchCacheRecord | undefined {
    return (
      this.readStoreRecord(paths.rootDir, paths.storeId) ??
      this.readCatalog().records.find((record) => record.storeId === paths.storeId)
    );
  }

  private catalogHasRecord(storeId: string): boolean {
    return this.readCatalog().records.some((record) => record.storeId === storeId);
  }

  private readCatalog(): SearchCacheCatalogFile {
    this.ensureCatalogDirs();
    const catalogPath = this.catalogPath();
    try {
      ensureExistingPrivateFileSync(catalogPath, 'Optsidian search cache catalog');
      const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown;
      if (!isCatalog(parsed)) return emptyCatalog();
      return {
        ...parsed,
        records: dedupeRecords(parsed.records.filter(isRecord)),
      };
    } catch (error) {
      if (isNoEntryError(error)) return emptyCatalog();
      if (isJsonParseError(error)) return emptyCatalog();
      throw error;
    }
  }

  private writeCatalog(catalog: SearchCacheCatalogFile): void {
    this.ensureCatalogDirs();
    writePrivateFileAtomicSync(this.catalogPath(), `${JSON.stringify(catalog)}\n`, 'Optsidian search cache catalog');
  }

  private readStoreRecord(rootDir: string, storeId: string): SearchCacheRecord | undefined {
    const storePath = path.join(rootDir, 'store.json');
    try {
      ensureExistingPrivateFileSync(storePath, 'Optsidian search cache store metadata');
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.storeId !== storeId) return undefined;
      return parsed;
    } catch (error) {
      if (isNoEntryError(error)) return undefined;
      if (isJsonParseError(error)) return undefined;
      throw error;
    }
  }

  private listKnownStoreIds(catalogRecords: ReadonlyMap<string, SearchCacheRecord>): string[] {
    const ids = new Set(catalogRecords.keys());
    for (const vaultEntry of safeReadDir(this.storesRootDir())) {
      const vaultDir = path.join(this.storesRootDir(), vaultEntry);
      for (const lexicalEntry of safeReadDir(vaultDir)) {
        ids.add(`${vaultEntry}:${lexicalEntry}`);
      }
    }
    return [...ids].sort();
  }

  private ensureCatalogDirs(): void {
    ensurePrivateDirSync(this.cacheRootDir(), 'Optsidian cache directory');
    ensurePrivateDirSync(this.searchRootDir(), 'Optsidian search cache directory');
    ensurePrivateDirSync(this.storesRootDir(), 'Optsidian search cache stores directory');
  }

  private ensureStoreDirs(paths: SearchStoreCachePaths): void {
    this.ensureCatalogDirs();
    ensurePrivateDirSync(paths.rootDir, 'Optsidian search cache store directory');
  }

  private cacheRootDir(): string {
    return optsidianCacheRoot(this.env);
  }

  private searchRootDir(): string {
    return path.join(this.cacheRootDir(), 'search');
  }

  private storesRootDir(): string {
    return path.join(this.searchRootDir(), 'stores');
  }

  private storeRootDir(storeId: string): string {
    const [vaultStateHash, lexicalIdentityHash] = storeId.split(':');
    if (vaultStateHash && lexicalIdentityHash) {
      return path.join(this.storesRootDir(), vaultStateHash, lexicalIdentityHash);
    }
    return path.join(this.storesRootDir(), storeId);
  }

  private catalogPath(): string {
    return path.join(this.searchRootDir(), 'catalog.json');
  }
}

function baseRecord(storeId: string, existing: SearchCacheRecord | undefined, nowMs: number): SearchCacheRecord {
  return {
    schemaVersion: SEARCH_CACHE_CATALOG_SCHEMA_VERSION,
    storeId,
    kind: 'search-store',
    createdAtMs: existing?.createdAtMs ?? nowMs,
    lastUsedAtMs: existing?.lastUsedAtMs ?? nowMs,
    ...(existing?.lastIndexedAtMs === undefined ? {} : { lastIndexedAtMs: existing.lastIndexedAtMs }),
    ...(existing?.lastVerifiedAtMs === undefined ? {} : { lastVerifiedAtMs: existing.lastVerifiedAtMs }),
    ...(existing?.activeSnapshotId === undefined ? {} : { activeSnapshotId: existing.activeSnapshotId }),
    ...(existing?.bytes === undefined ? {} : { bytes: existing.bytes }),
    ...(existing?.documentCount === undefined ? {} : { documentCount: existing.documentCount }),
    state: existing?.state ?? 'active',
  };
}

function normalizeRecord(record: SearchCacheRecord): SearchCacheRecord {
  return {
    ...record,
    schemaVersion: SEARCH_CACHE_CATALOG_SCHEMA_VERSION,
    kind: 'search-store',
    state: record.state,
  };
}

function emptyCatalog(): SearchCacheCatalogFile {
  return {
    schemaVersion: SEARCH_CACHE_CATALOG_SCHEMA_VERSION,
    updatedAtMs: 0,
    records: [],
  };
}

function isCatalog(value: unknown): value is SearchCacheCatalogFile {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === SEARCH_CACHE_CATALOG_SCHEMA_VERSION &&
    Number.isFinite((value as { updatedAtMs?: unknown }).updatedAtMs) &&
    Array.isArray((value as { records?: unknown }).records)
  );
}

function isRecord(value: unknown): value is SearchCacheRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as SearchCacheRecord;
  return (
    record.schemaVersion === SEARCH_CACHE_CATALOG_SCHEMA_VERSION &&
    record.kind === 'search-store' &&
    isStoreId(record.storeId) &&
    isUsableTimestamp(record.createdAtMs) &&
    isUsableTimestamp(record.lastUsedAtMs) &&
    (record.lastIndexedAtMs === undefined || isUsableTimestamp(record.lastIndexedAtMs)) &&
    (record.lastVerifiedAtMs === undefined || isUsableTimestamp(record.lastVerifiedAtMs)) &&
    (record.activeSnapshotId === undefined || typeof record.activeSnapshotId === 'string') &&
    (record.bytes === undefined || isNonNegativeSafeInteger(record.bytes)) &&
    (record.documentCount === undefined || isNonNegativeSafeInteger(record.documentCount)) &&
    (record.state === 'active' || record.state === 'cold' || record.state === 'pruning' || record.state === 'corrupt')
  );
}

function dedupeRecords(records: SearchCacheRecord[]): SearchCacheRecord[] {
  const byStore = new Map<string, SearchCacheRecord>();
  for (const record of records) byStore.set(record.storeId, record);
  return [...byStore.values()].sort(compareRecordStoreId);
}

function compareRecordStoreId(left: SearchCacheRecord, right: SearchCacheRecord): number {
  return left.storeId.localeCompare(right.storeId);
}

function normalizeUnusedDays(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SEARCH_CACHE_UNUSED_DAYS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error('unusedDays must be a positive integer'), { code: 'BAD_REQUEST' });
  }
  return value;
}

function normalizeDryRun(value: boolean | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw Object.assign(new Error('dryRun must be a boolean'), { code: 'BAD_REQUEST' });
  }
  return value;
}

function normalizeNowMs(value: number | undefined): number {
  const nowMs = value ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw Object.assign(new Error('nowMs must be a non-negative finite number'), { code: 'BAD_REQUEST' });
  }
  return nowMs;
}

function fallbackLastUsedAtMs(rootDir: string, storeId: string): number | undefined {
  const activePointer = path.join(rootDir, 'active', storeId);
  const activeStat = lstatIfExists(activePointer);
  if (activeStat?.isFile()) return activeStat.mtimeMs;
  const rootStat = lstatIfExists(rootDir);
  return rootStat?.mtimeMs;
}

function directorySizeSync(root: string): number {
  const stat = lstatIfExists(root);
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  for (const entry of safeReadDir(root)) {
    total += directorySizeSync(path.join(root, entry));
  }
  return total;
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function lstatIfExists(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

function isStoreId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}:[A-Za-z0-9_.-]+$/.test(value);
}

function isUsableTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNoEntryError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
