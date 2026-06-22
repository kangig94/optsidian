import {
  analyzerCacheKey,
  analyzerIdentityKey,
  createServedSearchAnalyzer,
  type SearchAnalyzer
} from "./analyzer.js";
import {
  SEARCH_INDEX_BUILDING_WARNING,
  SEARCH_INDEX_STALE_TIER_WARNING
} from "./constants.js";
import { cachePaths } from "./cache-paths.js";
import { currentFileManifest } from "./documents.js";
import type {
  FileManifest,
  PersistedIndex,
  SearchPlan,
  SearchReconcileRequester
} from "./internal-types.js";
import {
  classifySearchManifestMismatch,
  createSearchManifest,
  diffManifestFiles,
  searchTokenizerTier
} from "./manifest.js";
import {
  createSearchDb,
  loadOrBuildIndexForWrite,
  readStablePersistedIndex
} from "./persistence.js";
import {
  isSearchIndexWriterLockActive,
  withSearchIndexWriterLock
} from "./locks.js";

export async function loadSearchPlan(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester
): Promise<SearchPlan> {
  const currentFiles = currentFileManifest(vaultRoot);

  const targetPaths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const target = await readStablePersistedIndex(targetPaths, { waitForWriter: false });
  const targetPlan = target ? searchPlanFromPersisted(target, analyzer, currentFiles, []) : undefined;
  if (targetPlan) {
    if (targetPlan.warnings.includes(SEARCH_INDEX_STALE_TIER_WARNING)) requestReconcile(vaultRoot, analyzer, "stale-tier");
    return targetPlan;
  }
  if (target) requestReconcile(vaultRoot, analyzer, "incompatible");

  const baselineAnalyzer = baselineAnalyzerForSearch(analyzer);
  if (baselineAnalyzer && analyzerIdentityKey(baselineAnalyzer.identity) !== analyzerIdentityKey(analyzer.identity)) {
    const baselinePaths = cachePaths(vaultRoot, analyzerCacheKey(baselineAnalyzer.identity));
    const baseline = await readStablePersistedIndex(baselinePaths, { waitForWriter: false });
    const baselinePlan = baseline ? searchPlanFromPersisted(baseline, analyzer, currentFiles, [SEARCH_INDEX_STALE_TIER_WARNING]) : undefined;
    if (baselinePlan) {
      requestReconcile(vaultRoot, analyzer, "stale-tier");
      return baselinePlan;
    }
  }

  const buildAnalyzer = baselineAnalyzer ?? analyzer;
  const buildPaths = cachePaths(vaultRoot, analyzerCacheKey(buildAnalyzer.identity));
  if (isSearchIndexWriterLockActive(buildPaths.cacheDir)) {
    requestReconcile(vaultRoot, analyzer, "stale-manifest");
    return emptySearchPlan(currentFiles, buildAnalyzer, [SEARCH_INDEX_BUILDING_WARNING]);
  }
  const loaded = await withSearchIndexWriterLock(buildPaths.cacheDir, vaultRoot, buildAnalyzer, "full-build", () =>
    loadOrBuildIndexForWrite(vaultRoot, buildAnalyzer, requestReconcile, buildPaths, { serveStaleTier: false })
  );
  const warnings = analyzerIdentityKey(buildAnalyzer.identity) === analyzerIdentityKey(analyzer.identity) ? [] : [SEARCH_INDEX_STALE_TIER_WARNING];
  if (warnings.length > 0) requestReconcile(vaultRoot, analyzer, "stale-tier");
  return {
    projection: { db: loaded.db, manifest: loaded.manifest, analyzer: loaded.analyzer, source: "persisted" },
    diff: diffManifestFiles(loaded.manifest.files, currentFiles),
    currentFiles,
    warnings
  };
}

function emptySearchPlan(
  currentFiles: Record<string, FileManifest>,
  analyzer: SearchAnalyzer,
  warnings: string[]
): SearchPlan {
  return {
    projection: {
      db: createSearchDb(),
      manifest: createSearchManifest(0, analyzer.identity, {}),
      analyzer,
      source: "persisted"
    },
    diff: { added: Object.keys(currentFiles), changed: [], deleted: [] },
    currentFiles,
    warnings: uniqueWarnings(warnings)
  };
}

function searchPlanFromPersisted(
  persisted: PersistedIndex,
  analyzer: SearchAnalyzer,
  currentFiles: Record<string, FileManifest>,
  warnings: string[]
): SearchPlan | undefined {
  const mismatch = classifySearchManifestMismatch(persisted.manifest, analyzer.identity);
  const diff = diffManifestFiles(persisted.manifest.files, currentFiles);
  if (mismatch === "match") {
    return {
      projection: { db: persisted.db, manifest: persisted.manifest, analyzer, source: "persisted" },
      diff,
      currentFiles,
      warnings: uniqueWarnings(warnings)
    };
  }

  if (mismatch === "tier-only-upgrade") {
    const servedAnalyzer = createServedSearchAnalyzer(persisted.manifest.analyzer);
    if (servedAnalyzer) {
      return {
        projection: { db: persisted.db, manifest: persisted.manifest, analyzer: servedAnalyzer, source: "persisted" },
        diff,
        currentFiles,
        warnings: uniqueWarnings([...warnings, SEARCH_INDEX_STALE_TIER_WARNING])
      };
    }
  }

  return undefined;
}

export function baselineAnalyzerForSearch(analyzer: SearchAnalyzer): SearchAnalyzer | undefined {
  if (searchTokenizerTier(analyzer.identity) === "intl") return analyzer;
  return createServedSearchAnalyzer({ ...analyzer.identity, activeAnalyzers: [] });
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}
