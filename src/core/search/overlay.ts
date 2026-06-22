import { insertMultiple } from "@orama/orama";
import { UsageError } from "../../errors.js";
import type { SearchAnalyzer } from "./analyzer.js";
import { readOptsidianSettings, type OptsidianSettings } from "../settings.js";
import {
  SEARCH_INDEX_STALE_MANIFEST_WARNING,
  SEARCH_OVERLAY_MAX_BYTES_DEFAULT,
  SEARCH_OVERLAY_MAX_BYTES_ENV,
  SEARCH_OVERLAY_MAX_FILES_DEFAULT,
  SEARCH_OVERLAY_MAX_FILES_ENV
} from "./constants.js";
import { buildDocuments } from "./documents.js";
import type { FileManifest, ManifestDiff, SearchOverlayLimits, SearchProjection } from "./internal-types.js";
import { createSearchManifest } from "./manifest.js";
import { createSearchDb } from "./persistence.js";

export async function buildSearchOverlay(
  vaultRoot: string,
  currentFiles: Record<string, FileManifest>,
  diff: ManifestDiff,
  analyzer: SearchAnalyzer,
  warnings: string[]
): Promise<SearchProjection | undefined> {
  const relPaths = [...diff.added, ...diff.changed];
  if (relPaths.length === 0) return undefined;

  const limits = searchOverlayLimits();
  if (!overlayWithinLimits(currentFiles, relPaths, limits)) {
    addWarning(warnings, SEARCH_INDEX_STALE_MANIFEST_WARNING);
    return undefined;
  }

  try {
    return await buildSearchOverlayUnlocked(vaultRoot, currentFiles, relPaths, analyzer, warnings);
  } catch {
    try {
      return await buildSearchOverlayUnlocked(vaultRoot, currentFiles, relPaths, analyzer, warnings);
    } catch {
      addWarning(warnings, SEARCH_INDEX_STALE_MANIFEST_WARNING);
      return undefined;
    }
  }
}

async function buildSearchOverlayUnlocked(
  vaultRoot: string,
  currentFiles: Record<string, FileManifest>,
  relPaths: string[],
  analyzer: SearchAnalyzer,
  warnings: string[]
): Promise<SearchProjection | undefined> {
  const db = createSearchDb();
  const docs = await buildDocuments(vaultRoot, currentFiles, relPaths, analyzer, undefined, { strictAnalyzerErrors: true });
  if (docs.length === 0) {
    addWarning(warnings, SEARCH_INDEX_STALE_MANIFEST_WARNING);
    return undefined;
  }
  if (docs.length < relPaths.length) addWarning(warnings, SEARCH_INDEX_STALE_MANIFEST_WARNING);
  await insertMultiple(db, docs, 100);
  const files = Object.fromEntries(
    relPaths
      .map((rel) => [rel, currentFiles[rel]])
      .filter((entry): entry is [string, FileManifest] => Boolean(entry[1]))
  );
  return {
    db,
    manifest: createSearchManifest(docs.length, analyzer.identity, files),
    analyzer,
    source: "overlay"
  };
}

function overlayWithinLimits(files: Record<string, FileManifest>, relPaths: readonly string[], limits: SearchOverlayLimits): boolean {
  if (relPaths.length > limits.maxFiles) return false;
  let bytes = 0;
  for (const rel of relPaths) {
    bytes += files[rel]?.size ?? 0;
    if (bytes > limits.maxBytes) return false;
  }
  return true;
}

function searchOverlayLimits(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env)
): SearchOverlayLimits {
  return {
    maxFiles: parseNonNegativeIntegerEnv(
      env[SEARCH_OVERLAY_MAX_FILES_ENV],
      settings.search?.overlayMaxFiles ?? SEARCH_OVERLAY_MAX_FILES_DEFAULT,
      SEARCH_OVERLAY_MAX_FILES_ENV
    ),
    maxBytes: parseNonNegativeIntegerEnv(
      env[SEARCH_OVERLAY_MAX_BYTES_ENV],
      settings.search?.overlayMaxBytes ?? SEARCH_OVERLAY_MAX_BYTES_DEFAULT,
      SEARCH_OVERLAY_MAX_BYTES_ENV
    )
  };
}

function parseNonNegativeIntegerEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(raw);
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}
