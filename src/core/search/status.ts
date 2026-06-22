import fs from "node:fs";
import path from "node:path";
import { analyzerCacheKey, type SearchAnalyzer } from "./analyzer.js";
import type {
  SearchAnalyzerRuntimeStatus,
  SearchIndexProjectionStatus,
  SearchIndexReconcileSnapshot,
  SearchIndexReconcileStatus,
  SearchIndexStatusResult,
  SearchIndexWarmAccessStatus,
  SearchIndexWarmScheduleStatus
} from "../types.js";
import { cachePaths } from "./cache-paths.js";
import type { SearchTokenizerTier } from "./internal-types.js";
import { classifySearchManifestMismatch, readManifest } from "./manifest.js";
import { readPersistedIndex } from "./persistence.js";

export function searchIndexStatus(
  ready: boolean,
  staleTier: boolean,
  analyzer: SearchAnalyzerRuntimeStatus,
  projections: SearchIndexProjectionStatus[],
  warmAccess: SearchIndexWarmAccessStatus,
  warmSchedule: SearchIndexWarmScheduleStatus,
  reconcile: SearchIndexReconcileStatus | undefined,
  reconcileStatus: SearchIndexReconcileSnapshot | undefined
): SearchIndexStatusResult {
  return {
    ok: true,
    command: "index",
    action: "status",
    ready,
    ...(staleTier ? { staleTier: true } : {}),
    analyzer,
    projections,
    warmAccess,
    warmSchedule,
    ...(reconcile ? { reconcile } : {}),
    ...(reconcileStatus ? { reconcileStatus } : {})
  };
}

export function searchIndexProjectionStatuses(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  baselineAnalyzer: SearchAnalyzer | undefined
): SearchIndexProjectionStatus[] {
  const activeKey = analyzerCacheKey(analyzer.identity);
  const keys = new Set<string>([activeKey]);
  const roles = new Map<string, Set<SearchIndexProjectionStatus["roles"][number]>>();
  addProjectionRole(roles, activeKey, "active");

  if (baselineAnalyzer) {
    const baselineKey = analyzerCacheKey(baselineAnalyzer.identity);
    keys.add(baselineKey);
    addProjectionRole(roles, baselineKey, "baseline");
  }

  const rootPaths = cachePaths(vaultRoot);
  for (const key of cachedProjectionKeys(rootPaths.cacheDir)) {
    keys.add(key);
    addProjectionRole(roles, key, "cached");
  }

  return [...keys]
    .sort(compareProjectionKeys(activeKey, analyzerCacheKey((baselineAnalyzer ?? analyzer).identity)))
    .map((key) => readProjectionStatus(vaultRoot, key, analyzer, [...(roles.get(key) ?? new Set())]));
}

function addProjectionRole(
  roles: Map<string, Set<SearchIndexProjectionStatus["roles"][number]>>,
  key: string,
  role: SearchIndexProjectionStatus["roles"][number]
): void {
  const set = roles.get(key) ?? new Set<SearchIndexProjectionStatus["roles"][number]>();
  set.add(role);
  roles.set(key, set);
}

function cachedProjectionKeys(cacheDir: string): string[] {
  const indexesDir = path.join(cacheDir, "indexes");
  try {
    return fs.readdirSync(indexesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

function readProjectionStatus(
  vaultRoot: string,
  key: string,
  analyzer: SearchAnalyzer,
  roles: SearchIndexProjectionStatus["roles"]
): SearchIndexProjectionStatus {
  const paths = cachePaths(vaultRoot, key);
  if (!fs.existsSync(paths.indexPath) || !fs.existsSync(paths.manifestPath)) {
    return {
      key,
      tier: projectionTierForKey(key),
      roles,
      state: "missing",
      compatible: false
    };
  }

  const manifest = readManifest(paths);
  if (!manifest) {
    return {
      key,
      tier: projectionTierForKey(key),
      roles,
      state: "unreadable",
      compatible: false
    };
  }

  const persisted = readPersistedIndex(paths);
  if (!persisted) {
    return {
      key,
      tier: manifest.tokenizerTier,
      roles,
      state: "unreadable",
      compatible: false,
      documents: manifest.documents,
      files: Object.keys(manifest.files).length,
      builtAt: manifest.builtAt
    };
  }

  const mismatch = classifySearchManifestMismatch(manifest, analyzer.identity);
  const compatible = mismatch === "match" || mismatch === "tier-only-upgrade";
  return {
    key,
    tier: manifest.tokenizerTier,
    roles,
    state: "ready",
    compatible,
    ...(mismatch === "tier-only-upgrade" ? { staleTier: true } : {}),
    documents: manifest.documents,
    files: Object.keys(manifest.files).length,
    builtAt: manifest.builtAt
  };
}

function projectionTierForKey(key: string): SearchTokenizerTier {
  return key.startsWith("kiwi") ? "kiwi" : "intl";
}

function compareProjectionKeys(activeKey: string, baselineKey: string): (left: string, right: string) => number {
  return (left, right) => {
    const leftRank = projectionKeyRank(left, activeKey, baselineKey);
    const rightRank = projectionKeyRank(right, activeKey, baselineKey);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  };
}

function projectionKeyRank(key: string, activeKey: string, baselineKey: string): number {
  if (key === activeKey) return 0;
  if (key === baselineKey) return 1;
  return 2;
}

function isNoEntryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
