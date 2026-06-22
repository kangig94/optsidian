import crypto from "node:crypto";
import fs from "node:fs";
import { count, create, insertMultiple, load, remove, save } from "@orama/orama";
import type { AnyOrama, RawData } from "@orama/orama";
import {
  createServedSearchAnalyzer,
  type SearchAnalyzer
} from "./analyzer.js";
import { atomicWriteFile } from "../write-file.js";
import { SEARCH_CACHE_VERSION, SEARCH_INDEX_STALE_TIER_WARNING } from "./constants.js";
import {
  buildDocuments,
  currentFileManifest,
  readAnalysisCache,
  writeAnalysisCache
} from "./documents.js";
import type {
  CachePaths,
  FileManifest,
  LoadedIndex,
  ManifestDiff,
  PersistedIndex,
  SearchIndexCommit,
  SearchIndexWriteOptions,
  SearchManifest,
  SearchReconcileRequester
} from "./internal-types.js";
import {
  classifySearchManifestMismatch,
  createSearchManifest,
  diffManifestFiles,
  hasManifestDiff,
  readManifestRaw
} from "./manifest.js";
import {
  isSearchIndexWriterLockActive,
  waitForSearchIndexWriterIdle
} from "./locks.js";
import { SEARCH_DB_SCHEMA } from "./schema.js";

export function createSearchDb(): AnyOrama {
  return create({
    schema: SEARCH_DB_SCHEMA,
    components: {
      tokenizer: {
        language: "optsidian-analyzed",
        normalizationCache: new Map<string, string>(),
        tokenize: (raw: string) => String(raw).split(/\s+/).map((token) => token.trim()).filter(Boolean)
      }
    }
  });
}

export function persistIndexPair(db: AnyOrama, manifest: SearchManifest, paths: CachePaths): void {
  const indexRaw = writeJsonFile(paths.indexPath, save(db));
  const manifestRaw = writeJsonFile(paths.manifestPath, manifest, 2);
  writeJsonFile(paths.commitPath, createSearchIndexCommit(indexRaw, manifestRaw), 2);
}

export function restoreDb(indexPath: string): AnyOrama {
  return restoreDbFromRaw(fs.readFileSync(indexPath, "utf8"));
}

export function restoreDbFromRaw(raw: string): AnyOrama {
  const db = createSearchDb();
  load(db, JSON.parse(raw) as RawData);
  return db;
}

export function readPersistedIndex(paths: CachePaths): PersistedIndex | undefined {
  if (!fs.existsSync(paths.indexPath)) return undefined;
  const manifestRead = readManifestRaw(paths);
  if (!manifestRead) return undefined;
  let indexRaw: string;
  try {
    indexRaw = fs.readFileSync(paths.indexPath, "utf8");
  } catch {
    return undefined;
  }
  if (!indexCommitMatches(paths, indexRaw, manifestRead.raw)) return undefined;
  try {
    return { db: restoreDbFromRaw(indexRaw), manifest: manifestRead.manifest };
  } catch {
    return undefined;
  }
}

export async function loadOrBuildIndexForWrite(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester,
  paths: CachePaths,
  options: SearchIndexWriteOptions
): Promise<LoadedIndex> {
  const currentFiles = currentFileManifest(vaultRoot);
  const persisted = readPersistedIndex(paths);
  if (options.fastNoop) {
    if (persisted) {
      const mismatch = classifySearchManifestMismatch(persisted.manifest, analyzer.identity);
      const diff = diffManifestFiles(persisted.manifest.files, currentFiles);
      if (mismatch === "match" && !hasManifestDiff(diff)) {
        return { db: createSearchDb(), manifest: persisted.manifest, analyzer, warnings: [] };
      }
    }
  }
  if (persisted) {
    const mismatch = classifySearchManifestMismatch(persisted.manifest, analyzer.identity);
    const diff = diffManifestFiles(persisted.manifest.files, currentFiles);
    if (mismatch === "match") {
      if (!hasManifestDiff(diff)) {
        return { db: persisted.db, manifest: persisted.manifest, analyzer, warnings: [] };
      }
      let updated: SearchManifest;
      try {
        updated = await applyIncrementalIndexUnlocked(vaultRoot, persisted.db, currentFiles, diff, paths, analyzer);
      } catch {
        const rebuilt = await buildAndPersistIndexUnlocked(vaultRoot, currentFiles, paths, analyzer);
        const db = restoreDb(paths.indexPath);
        return { db, manifest: rebuilt, analyzer, warnings: [] };
      }
      return { db: persisted.db, manifest: updated, analyzer, warnings: [] };
    }

    if (options.serveStaleTier && mismatch === "tier-only-upgrade" && !hasManifestDiff(diff)) {
      const servedAnalyzer = createServedSearchAnalyzer(persisted.manifest.analyzer);
      if (servedAnalyzer) {
        requestReconcile(vaultRoot, analyzer, "stale-tier");
        return { db: persisted.db, manifest: persisted.manifest, analyzer: servedAnalyzer, warnings: [SEARCH_INDEX_STALE_TIER_WARNING] };
      }
    }
  }

  const rebuilt = await buildAndPersistIndexUnlocked(vaultRoot, currentFiles, paths, analyzer);
  const db = restoreDb(paths.indexPath);
  return { db, manifest: rebuilt, analyzer, warnings: [] };
}

export async function buildAndPersistIndexUnlocked(
  vaultRoot: string,
  files: Record<string, FileManifest>,
  paths: CachePaths,
  analyzer: SearchAnalyzer
): Promise<SearchManifest> {
  fs.mkdirSync(paths.indexDir, { recursive: true });
  const db = createSearchDb();
  const analysisCache = readAnalysisCache(paths, analyzer.identity);
  const docs = await buildDocuments(vaultRoot, files, Object.keys(files), analyzer, analysisCache);
  await insertMultiple(db, docs, 500);
  const manifest = createSearchManifest(docs.length, analyzer.identity, files);
  persistIndexPair(db, manifest, paths);
  writeAnalysisCache(paths, analyzer.identity, files, docs);
  return manifest;
}

async function applyIncrementalIndexUnlocked(
  vaultRoot: string,
  db: AnyOrama,
  files: Record<string, FileManifest>,
  diff: ManifestDiff,
  paths: CachePaths,
  analyzer: SearchAnalyzer
): Promise<SearchManifest> {
  fs.mkdirSync(paths.indexDir, { recursive: true });

  for (const rel of [...diff.deleted, ...diff.changed]) {
    await remove(db, rel);
  }

  const analysisCache = readAnalysisCache(paths, analyzer.identity);
  const docs = await buildDocuments(vaultRoot, files, [...diff.added, ...diff.changed], analyzer, analysisCache);

  if (docs.length > 0) {
    await insertMultiple(db, docs, 500);
  }

  const manifest = createSearchManifest(await count(db), analyzer.identity, files);
  persistIndexPair(db, manifest, paths);
  writeAnalysisCache(paths, analyzer.identity, files, docs, analysisCache, new Set([...diff.deleted, ...diff.changed]));
  return manifest;
}

export async function readStablePersistedIndex(paths: CachePaths, options: { waitForWriter?: boolean } = {}): Promise<PersistedIndex | undefined> {
  const waitForWriter = options.waitForWriter !== false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (waitForWriter) {
      await waitForSearchIndexWriterIdle(paths.cacheDir);
    }
    if (!fs.existsSync(paths.indexPath)) return undefined;
    const first = readManifestRaw(paths);
    if (!first) return undefined;
    let indexRaw: string;
    try {
      indexRaw = fs.readFileSync(paths.indexPath, "utf8");
    } catch {
      return undefined;
    }
    const second = readManifestRaw(paths);
    const writerActiveAfter = isSearchIndexWriterLockActive(paths.cacheDir);
    if (second?.raw === first.raw && (!waitForWriter || !writerActiveAfter)) {
      if (!indexCommitMatches(paths, indexRaw, first.raw)) {
        return undefined;
      }
      let db: AnyOrama;
      try {
        db = restoreDbFromRaw(indexRaw);
      } catch {
        return undefined;
      }
      return { db, manifest: first.manifest };
    }
    if (!waitForWriter) return undefined;
  }
  return undefined;
}

export function indexCommitMatches(paths: CachePaths, indexRaw: string, manifestRaw: string): boolean {
  const commit = readSearchIndexCommit(paths);
  return Boolean(commit && commit.indexSha256 === sha256(indexRaw) && commit.manifestSha256 === sha256(manifestRaw));
}

function writeJsonFile(filePath: string, value: unknown, spaces?: number): string {
  const raw = `${JSON.stringify(value, null, spaces)}\n`;
  atomicWriteFile(filePath, raw);
  return raw;
}

function createSearchIndexCommit(indexRaw: string, manifestRaw: string): SearchIndexCommit {
  return {
    cacheVersion: SEARCH_CACHE_VERSION,
    indexSha256: sha256(indexRaw),
    manifestSha256: sha256(manifestRaw),
    writtenAt: new Date().toISOString()
  };
}

function readSearchIndexCommit(paths: CachePaths): SearchIndexCommit | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.commitPath, "utf8")) as unknown;
    return isSearchIndexCommit(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isSearchIndexCommit(value: unknown): value is SearchIndexCommit {
  return (
    isRecord(value) &&
    value.cacheVersion === SEARCH_CACHE_VERSION &&
    typeof value.indexSha256 === "string" &&
    typeof value.manifestSha256 === "string" &&
    typeof value.writtenAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
