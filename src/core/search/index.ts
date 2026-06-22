import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../errors.js";
import { resolveVaultPath } from "../path.js";
import {
  analyzerCacheKey,
  resolveSearchAnalyzer,
  searchAnalyzerRuntimeStatus,
  withSearchAnalyzerLease,
  type SearchAnalyzer,
  type SearchAnalyzerIdentity,
  type SearchAnalyzerLeaseOptions
} from "./analyzer.js";
import { indexWarmScheduleStatus } from "./warm-schedule-state.js";
import { readOptsidianSettings, type OptsidianSettings } from "../settings.js";
import { vaultAccessStatus } from "../vault-access.js";
import type {
  SearchDebugInfo,
  SearchIndexMutationResult,
  SearchIndexStatusResult,
  SearchMatch,
  SearchParams,
  SearchReconcileReason,
  SearchResult
} from "../types.js";
import {
  SEARCH_ANALYZER_LOAD_TIMEOUT_ENV,
  SEARCH_ANALYZER_LOAD_TIMEOUT_MS_DEFAULT,
  SEARCH_INDEX_STALE_TIER_WARNING
} from "./constants.js";
import {
  cachePaths,
  searchIndexWriterLockPath,
  searchReconcileLockPath,
  searchReconcileStatusPath
} from "./cache-paths.js";
import {
  currentFileManifest
} from "./documents.js";
import {
  classifySearchManifestMismatch,
  hasManifestDiff,
  isManifestUsableForRead,
  readManifest
} from "./manifest.js";
import {
  normalizeSearchParams,
  resolvePathFilter
} from "./params.js";
import {
  firstQueryTerms,
  mergeProjectionHits,
  searchProjection,
  staleResultPaths
} from "./projection.js";
import {
  compareTagOnlyMatches,
  isRankedCandidate,
  rerankCandidates
} from "./ranking/index.js";
import { snippetsForDocument } from "./snippets.js";
import { searchDebugInfo, searchMatchDebug } from "./debug.js";
import {
  buildAndPersistIndexUnlocked,
  readStablePersistedIndex
} from "./persistence.js";
import { buildSearchOverlay } from "./overlay.js";
import { searchIndexProjectionStatuses, searchIndexStatus } from "./status.js";
import {
  acquireSearchReconcileLock,
  readSearchReconcileStatus,
  setSearchIndexWriterLockStaleMsForTests,
  setSearchIndexWriterLockWaitMsForTests,
  setSearchReconcileLockStaleMsForTests,
  withSearchIndexWriterLock
} from "./locks.js";
import {
  readSearchReconcileSnapshot,
  requestSearchReconcile,
  truncateSearchReconcileError,
  writeSearchReconcileSnapshot
} from "./reconcile.js";
import {
  baselineAnalyzerForSearch,
  loadSearchPlan
} from "./planner.js";
import { ensureSearchIndexWithAnalyzer } from "./warm.js";
import type {
  NormalizedSearchParams,
  SearchReconcileRequester
} from "./internal-types.js";

export type { SearchReconcileRequester } from "./internal-types.js";
export {
  cachePaths,
  searchIndexWriterLockPath,
  searchReconcileLockPath,
  searchReconcileStatusPath
} from "./cache-paths.js";
export { classifySearchManifestMismatch } from "./manifest.js";
export {
  parseSearchReconcileReason,
  searchReconcileCommand
} from "./reconcile.js";
export {
  setSearchReconcileChildSpawnerForTests as __setSearchReconcileChildSpawnerForTests
} from "./reconcile.js";
export { warmSearchIndexes } from "./warm.js";

export async function searchVault(vaultRoot: string, params: SearchParams): Promise<SearchResult> {
  return searchVaultWithAnalyzer(vaultRoot, params, resolveSearchAnalyzer());
}

export async function searchVaultWithAnalyzer(
  vaultRoot: string,
  params: SearchParams,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester = requestSearchReconcile
): Promise<SearchResult> {
  const leaseOptions = await foregroundSearchAnalyzerLeaseOptions(vaultRoot, analyzer);
  return withSearchAnalyzerLease(
    analyzer,
    (leasedAnalyzer) => searchVaultWithLeasedAnalyzer(vaultRoot, params, leasedAnalyzer, requestReconcile),
    (event) => requestReconcile(vaultRoot, event.degradedAnalyzer, "terminal-analyzer-failure"),
    leaseOptions
  );
}

async function foregroundSearchAnalyzerLeaseOptions(
  vaultRoot: string,
  analyzer: SearchAnalyzer
): Promise<SearchAnalyzerLeaseOptions> {
  if (!analyzer.withLease) return {};
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const persisted = await readStablePersistedIndex(paths, { waitForWriter: false });
  if (!persisted) return { wait: false };
  if (classifySearchManifestMismatch(persisted.manifest, analyzer.identity) !== "match") {
    return { wait: false };
  }
  return { wait: true, installIfMissing: true, loadTimeoutMs: searchAnalyzerLoadTimeoutMs() };
}

function searchAnalyzerLoadTimeoutMs(
  settings: OptsidianSettings = readOptsidianSettings(),
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[SEARCH_ANALYZER_LOAD_TIMEOUT_ENV];
  if (raw !== undefined) return parseSearchAnalyzerLoadTimeoutMs(raw);
  return settings.search?.analyzerLoadTimeoutMs ?? SEARCH_ANALYZER_LOAD_TIMEOUT_MS_DEFAULT;
}

function parseSearchAnalyzerLoadTimeoutMs(raw: string): number {
  if (raw.trim() === "") return SEARCH_ANALYZER_LOAD_TIMEOUT_MS_DEFAULT;
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`${SEARCH_ANALYZER_LOAD_TIMEOUT_ENV} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`${SEARCH_ANALYZER_LOAD_TIMEOUT_ENV} must be a positive integer`);
  }
  return parsed;
}

async function searchVaultWithLeasedAnalyzer(
  vaultRoot: string,
  params: SearchParams,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester
): Promise<SearchResult> {
  const search = normalizeSearchParams(params);
  const pathFilter = search.path ? resolvePathFilter(vaultRoot, search.path) : undefined;
  const plan = await loadSearchPlan(vaultRoot, analyzer, requestReconcile);
  if (analyzer.reconcileTargetAnalyzer) {
    addWarning(plan.warnings, SEARCH_INDEX_STALE_TIER_WARNING);
    try {
      requestReconcile(vaultRoot, analyzer.reconcileTargetAnalyzer, "stale-tier");
    } catch {
      // Background reconcile is best-effort from the read path.
    }
  }
  const stalePaths = staleResultPaths(plan.diff);
  const overlayAnalyzer = baselineAnalyzerForSearch(analyzer) ?? plan.projection.analyzer;
  const overlay = await buildSearchOverlay(vaultRoot, plan.currentFiles, plan.diff, overlayAnalyzer, plan.warnings);
  if (hasManifestDiff(plan.diff)) requestReconcile(vaultRoot, analyzer, "stale-manifest");

  const projectionSearches = [
    searchProjection(plan.projection, search, pathFilter, stalePaths),
    ...(overlay ? [searchProjection(overlay, search, pathFilter, new Set<string>())] : [])
  ];
  const projectionResults = await Promise.all(projectionSearches);
  const mergedHits = mergeProjectionHits(projectionResults.flat());
  if (search.query && mergedHits.length === 0 && projectionResults.every((hits) => hits.length === 0)) {
    return searchResult([], plan.warnings, search.debug ? searchDebugInfo(search, plan.projection, mergedHits) : undefined);
  }

  const sourceByPath = new Map(mergedHits.map((hit) => [hit.document.path, hit]));
  const rankingQueryTerms = firstQueryTerms(mergedHits);
  const matches = search.query
    ? rerankCandidates(search.query, rankingQueryTerms, mergedHits, search.fields).slice(0, search.limit)
    : mergedHits
        .map((hit) => ({
          path: hit.document.path,
          title: hit.document.title,
          tags: hit.document.tags
        }))
        .sort(compareTagOnlyMatches)
        .slice(0, search.limit);

  const withSnippets = await Promise.all(matches.map(async (match) => {
    const source = sourceByPath.get(match.path);
    const matchDebug = search.debug && source ? searchMatchDebug(source, isRankedCandidate(match) ? match : undefined) : undefined;
    return {
      path: match.path,
      title: match.title,
      tags: match.tags,
      snippets: await snippetsForDocument(
        vaultRoot,
        match.path,
        search.query,
        source?.queryTerms ?? rankingQueryTerms,
        source?.queryChannels,
        source?.analyzer ?? plan.projection.analyzer
      ),
      ...(matchDebug ? { debug: matchDebug } : {})
    };
  }));

  return searchResult(withSnippets, plan.warnings, search.debug ? searchDebugInfo(search, plan.projection, mergedHits) : undefined);
}

function searchResult(matches: SearchMatch[], warnings: string[] = [], debug?: SearchDebugInfo): SearchResult {
  return {
    ok: true,
    command: "search",
    matches,
    ...(debug ? { debug } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export function getSearchIndexStatus(vaultRoot: string): SearchIndexStatusResult {
  const analyzer = resolveSearchAnalyzer();
  const settings = readOptsidianSettings();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const reconcile = readSearchReconcileStatus(paths.cacheDir);
  const reconcileStatus = readSearchReconcileSnapshot(paths.cacheDir);
  const projections = searchIndexProjectionStatuses(vaultRoot, analyzer, baselineAnalyzerForSearch(analyzer));
  const served = projections.find((projection) => projection.compatible);
  return searchIndexStatus(
    Boolean(served),
    served?.staleTier === true,
    searchAnalyzerRuntimeStatus(analyzer),
    projections,
    vaultAccessStatus(vaultRoot, { settings }),
    indexWarmScheduleStatus({ settings }),
    reconcile,
    reconcileStatus
  );
}

export async function rebuildSearchIndex(vaultRoot: string): Promise<SearchIndexMutationResult> {
  const analyzer = resolveSearchAnalyzer();
  return rebuildSearchIndexWithAnalyzer(vaultRoot, analyzer);
}

async function rebuildSearchIndexWithAnalyzer(vaultRoot: string, analyzer: SearchAnalyzer): Promise<SearchIndexMutationResult> {
  return withSearchAnalyzerLease(analyzer, async (leasedAnalyzer) => {
    await rebuildSearchIndexWithLeasedAnalyzer(vaultRoot, leasedAnalyzer);
    return {
      ok: true,
      command: "index",
      action: "rebuild"
    };
  }, undefined, { wait: true, installIfMissing: true });
}

async function rebuildSearchIndexWithLeasedAnalyzer(vaultRoot: string, analyzer: SearchAnalyzer): Promise<void> {
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  await withSearchIndexWriterLock(paths.cacheDir, vaultRoot, analyzer, "rebuild", async () => {
    const currentFiles = currentFileManifest(vaultRoot);
    await buildAndPersistIndexUnlocked(vaultRoot, currentFiles, paths, analyzer);
  });
}

export async function reconcileSearchIndex(vaultRoot: string, reason: SearchReconcileReason = "manual"): Promise<void> {
  const analyzer = resolveSearchAnalyzer();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const reconcileLock = acquireSearchReconcileLock(paths.cacheDir, vaultRoot, analyzer, reason);
  if (!reconcileLock) return;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  writeSearchReconcileSnapshot(paths.cacheDir, {
    state: "running",
    reason,
    startedAt
  });

  try {
    await ensureSearchIndexWithAnalyzer(vaultRoot, analyzer);
    writeSearchReconcileSnapshot(paths.cacheDir, {
      state: "success",
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs
    });
  } catch (error) {
    writeSearchReconcileSnapshot(paths.cacheDir, {
      state: "failure",
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      error: truncateSearchReconcileError(errorMessage(error))
    });
    throw error;
  } finally {
    reconcileLock.release();
  }
}

export async function clearSearchIndex(vaultRoot: string): Promise<SearchIndexMutationResult> {
  const analyzer = resolveSearchAnalyzer();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  await withSearchIndexWriterLock(paths.cacheDir, vaultRoot, analyzer, "clear", async () => {
    fs.rmSync(path.join(paths.cacheDir, "indexes"), { recursive: true, force: true });
  });
  return {
    ok: true,
    command: "index",
    action: "clear"
  };
}

export function __setSearchReconcileLockStaleMsForTests(value: number | undefined): void {
  setSearchReconcileLockStaleMsForTests(value);
}

export function __setSearchIndexWriterLockStaleMsForTests(value: number | undefined): void {
  setSearchIndexWriterLockStaleMsForTests(value);
}

export function __setSearchIndexWriterLockWaitMsForTests(value: number | undefined): void {
  setSearchIndexWriterLockWaitMsForTests(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}
