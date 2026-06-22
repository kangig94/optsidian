import fs from "node:fs";
import { OPTSIDIAN_VERSION } from "../../version.js";
import { analyzerIdentityKey, type SearchAnalyzerIdentity } from "./analyzer.js";
import { SEARCH_CACHE_VERSION } from "./constants.js";
import type {
  CachePaths,
  FileManifest,
  ManifestDiff,
  ManifestRead,
  SearchManifest,
  SearchManifestMismatch,
  SearchTokenizerTier
} from "./internal-types.js";
import {
  SEARCH_ENGINE,
  SEARCH_SCHEMA_DIGEST
} from "./schema.js";

export function createSearchManifest(
  documents: number,
  analyzer: SearchAnalyzerIdentity,
  files: Record<string, FileManifest>
): SearchManifest {
  return {
    ...searchManifestIdentity(analyzer),
    builtAt: new Date().toISOString(),
    documents,
    analyzer,
    files
  };
}

export function readManifest(paths: CachePaths): SearchManifest | undefined {
  return readManifestRaw(paths)?.manifest;
}

export function readManifestRaw(paths: CachePaths): ManifestRead | undefined {
  try {
    const raw = fs.readFileSync(paths.manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isSearchManifest(parsed) ? { raw, manifest: parsed } : undefined;
  } catch {
    return undefined;
  }
}

export function classifySearchManifestMismatch(
  manifest: Partial<SearchManifest> | undefined,
  analyzer: SearchAnalyzerIdentity
): SearchManifestMismatch {
  if (!hasCompleteSearchManifestIdentity(manifest)) return "incompatible";
  const expected = searchManifestIdentity(analyzer);
  const structurallyCompatible =
    manifest.cacheVersion === expected.cacheVersion &&
    manifest.schemaDigest === expected.schemaDigest &&
    manifest.engine === expected.engine &&
    manifest.optsidianVersion === expected.optsidianVersion &&
    manifest.nodeVersion === expected.nodeVersion &&
    manifest.icuVersion === expected.icuVersion;

  if (!structurallyCompatible) return "incompatible";

  const tokenizerMatches = manifest.tokenizerIdentity === expected.tokenizerIdentity;
  const tierMatches = manifest.tokenizerTier === expected.tokenizerTier;
  const declaredAnalyzersMatch = stringArraysEqual(manifest.declaredAnalyzers, expected.declaredAnalyzers);
  const activeAnalyzersMatch = stringArraysEqual(manifest.activeAnalyzers, expected.activeAnalyzers);
  if (
    tokenizerMatches &&
    tierMatches &&
    declaredAnalyzersMatch &&
    activeAnalyzersMatch &&
    analyzerIdentityKey(manifest.analyzer) === analyzerIdentityKey(analyzer)
  ) {
    return "match";
  }

  if (manifest.tokenizerTier === "intl" && expected.tokenizerTier === "kiwi") {
    return "tier-only-upgrade";
  }

  return "incompatible";
}

export function isManifestUsableForRead(manifest: SearchManifest, analyzer: SearchAnalyzerIdentity): boolean {
  const mismatch = classifySearchManifestMismatch(manifest, analyzer);
  return mismatch === "match" || mismatch === "tier-only-upgrade";
}

export function diffManifestFiles(previous: Record<string, FileManifest>, current: Record<string, FileManifest>): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);

  for (const rel of [...paths].sort((left, right) => left.localeCompare(right))) {
    const before = previous[rel];
    const after = current[rel];
    if (!before && after) {
      added.push(rel);
      continue;
    }
    if (before && !after) {
      deleted.push(rel);
      continue;
    }
    if (before && after && (before.size !== after.size || before.mtimeMs !== after.mtimeMs)) {
      changed.push(rel);
    }
  }

  return { added, changed, deleted };
}

export function hasManifestDiff(diff: ManifestDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.deleted.length > 0;
}

export function searchTokenizerTier(analyzer: SearchAnalyzerIdentity): SearchTokenizerTier {
  return normalizeAnalyzerList(analyzer.activeAnalyzers ?? []).includes("ko") ? "kiwi" : "intl";
}

function searchManifestIdentity(analyzer: SearchAnalyzerIdentity): Omit<SearchManifest, "builtAt" | "documents" | "analyzer" | "files"> {
  const activeAnalyzers = normalizeAnalyzerList(analyzer.activeAnalyzers ?? []);
  return {
    cacheVersion: SEARCH_CACHE_VERSION,
    schemaDigest: SEARCH_SCHEMA_DIGEST,
    engine: SEARCH_ENGINE,
    optsidianVersion: OPTSIDIAN_VERSION,
    tokenizerTier: searchTokenizerTier(analyzer),
    tokenizerIdentity: searchTokenizerIdentity(analyzer),
    declaredAnalyzers: normalizeAnalyzerList(analyzer.declaredAnalyzers ?? []),
    activeAnalyzers,
    nodeVersion: process.versions.node,
    icuVersion: process.versions.icu ?? null
  };
}

function searchTokenizerIdentity(analyzer: SearchAnalyzerIdentity): string {
  return JSON.stringify({
    name: analyzer.name,
    version: analyzer.version,
    baseline: analyzer.baseline,
    tier: searchTokenizerTier(analyzer),
    activeAnalyzers: normalizeAnalyzerList(analyzer.activeAnalyzers ?? []),
    model: analyzer.model,
    optionsHash: analyzer.optionsHash
  });
}

function isSearchManifest(value: unknown): value is SearchManifest {
  return (
    hasCompleteSearchManifestIdentity(value) &&
    typeof value.builtAt === "string" &&
    typeof value.documents === "number" &&
    Number.isSafeInteger(value.documents) &&
    value.documents >= 0 &&
    isFileManifestRecord(value.files)
  );
}

function hasCompleteSearchManifestIdentity(value: unknown): value is SearchManifest {
  return (
    isRecord(value) &&
    value.cacheVersion === SEARCH_CACHE_VERSION &&
    typeof value.schemaDigest === "string" &&
    typeof value.engine === "string" &&
    typeof value.optsidianVersion === "string" &&
    isSearchTokenizerTier(value.tokenizerTier) &&
    typeof value.tokenizerIdentity === "string" &&
    isStringArray(value.declaredAnalyzers) &&
    isStringArray(value.activeAnalyzers) &&
    typeof value.nodeVersion === "string" &&
    (typeof value.icuVersion === "string" || value.icuVersion === null) &&
    isSearchAnalyzerIdentity(value.analyzer)
  );
}

function isSearchTokenizerTier(value: unknown): value is SearchTokenizerTier {
  return value === "intl" || value === "kiwi";
}

function isSearchAnalyzerIdentity(value: unknown): value is SearchAnalyzerIdentity {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.node === "string" &&
    (value.baseline === undefined || typeof value.baseline === "string") &&
    (value.runtime === undefined || typeof value.runtime === "string") &&
    (value.icu === undefined || typeof value.icu === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.optionsHash === undefined || typeof value.optionsHash === "string") &&
    (value.declaredAnalyzers === undefined || isStringArray(value.declaredAnalyzers)) &&
    (value.activeAnalyzers === undefined || isStringArray(value.activeAnalyzers))
  );
}

function isFileManifestRecord(value: unknown): value is Record<string, FileManifest> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.mtimeMs === "number" &&
      Number.isFinite(entry.mtimeMs) &&
      typeof entry.size === "number" &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAnalyzerList(analyzers: readonly string[]): string[] {
  return [...new Set(analyzers.map((analyzer) => analyzer.trim().toLowerCase()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
