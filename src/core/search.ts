import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { count, create, insertMultiple, load, remove, save, search as oramaSearch } from "@orama/orama";
import type { AnyOrama, RawData, Results } from "@orama/orama";
import { OPTSIDIAN_VERSION } from "../version.js";
import { UsageError } from "../errors.js";
import { resolveVaultPath, vaultRealpath, vaultRelative, walkFiles } from "./path.js";
import {
  analyzerCacheKey,
  analyzerIdentityKey,
  createServedSearchAnalyzer,
  resolveSearchAnalyzer,
  tokensToSearchText,
  withSearchAnalyzerLease,
  type SearchAnalyzer,
  type SearchAnalyzerIdentity
} from "./search-analyzer.js";
import { parseMarkdownNote, type ParsedMarkdownNote, type SearchDocument } from "./search-parse.js";
import { decodeUtf8, splitText } from "./text.js";
import type {
  SearchField,
  SearchIndexMutationResult,
  SearchIndexReconcileStatus,
  SearchIndexStatusResult,
  SearchMatch,
  SearchParams,
  SearchReconcileReason,
  SearchResult,
  SearchSnippet
} from "./types.js";
import { assertOptionalPositiveInteger } from "./validation.js";

const SEARCH_SCHEMA_VERSION = 3;
const SEARCH_IDENTITY_SCHEMA_VERSION = 1;
const SEARCH_ANALYSIS_CACHE_SCHEMA_VERSION = 2;
const SEARCH_ENGINE = "orama";
const SEARCH_INDEX_FILE = "search.orama";
const SEARCH_MANIFEST_FILE = "manifest.json";
const SEARCH_ANALYSIS_CACHE_FILE = "analysis-cache.json";
const SEARCH_RECONCILE_COMMAND = "__search-reconcile";
const SEARCH_RECONCILE_LOCK_DIR = "reconcile.lock";
const SEARCH_INDEX_STALE_TIER_WARNING = "fts_index_stale_tier";
const SEARCH_RECONCILE_LOCK_STALE_MS = 30 * 60 * 1000;
const SEARCH_PROPERTIES = ["title", "aliases", "tags", "headings", "path", "body"] as const satisfies readonly SearchField[];
const SEARCH_DB_SCHEMA = {
  path: "string",
  title: "string",
  aliases: "string[]",
  tags: "string[]",
  headings: "string[]",
  body: "string",
  pathTokens: "string",
  titleTokens: "string",
  aliasesTokens: "string",
  tagsTokens: "string",
  headingsTokens: "string",
  bodyTokens: "string"
} as const;
const SEARCH_SCHEMA_DIGEST = sha256(JSON.stringify(SEARCH_DB_SCHEMA));
const SEARCH_FIELD_INDEX_PROPERTY: Record<SearchField, keyof SearchDocument> = {
  title: "titleTokens",
  aliases: "aliasesTokens",
  tags: "tagsTokens",
  headings: "headingsTokens",
  path: "pathTokens",
  body: "bodyTokens"
};
const SEARCH_BOOST = {
  title: 8,
  tags: 7,
  aliases: 6,
  headings: 4,
  path: 2,
  body: 1
};

type FileManifest = {
  mtimeMs: number;
  size: number;
};

type SearchTokenizerTier = "intl" | "kiwi";
type SearchManifestMismatch = "match" | "tier-only-upgrade" | "incompatible";

type SearchManifest = {
  identitySchemaVersion: number;
  schemaVersion: number;
  schemaDigest: string;
  engine: string;
  optsidianVersion: string;
  builtAt: string;
  documents: number;
  tokenizerTier: SearchTokenizerTier;
  tokenizerIdentity: string;
  declaredAnalyzers: string[];
  activeAnalyzers: string[];
  nodeVersion: string;
  icuVersion: string | null;
  analyzer: SearchAnalyzerIdentity;
  files: Record<string, FileManifest>;
};

type CachePaths = {
  cacheDir: string;
  indexPath: string;
  manifestPath: string;
  analysisPath: string;
};

type LoadedIndex = {
  db: AnyOrama;
  manifest: SearchManifest;
  analyzer: SearchAnalyzer;
  warnings: string[];
};

export type SearchReconcileRequester = (vaultRoot: string, analyzer: SearchAnalyzer, reason: SearchReconcileReason) => void;

type SearchReconcileChildSpawner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

type ActiveSearchReconcile = {
  reasons: Set<SearchReconcileReason>;
};

type SearchReconcileLock = {
  release(): void;
};

type SearchReconcileLockOwner = {
  reason?: SearchReconcileReason;
  startedAt?: string;
  pid?: number;
};

type PathFilter = {
  rel: string;
  directory: boolean;
};

type NormalizedSearchParams = {
  query?: string;
  path?: string;
  tags?: string[];
  fields?: SearchField[];
  limit: number;
};

type ManifestDiff = {
  added: string[];
  changed: string[];
  deleted: string[];
};

type SearchTokenFields = Pick<SearchDocument, "pathTokens" | "titleTokens" | "aliasesTokens" | "tagsTokens" | "headingsTokens" | "bodyTokens">;

type AnalysisCacheEntry = FileManifest & {
  tokens: SearchTokenFields;
};

type AnalysisCache = {
  schemaVersion: number;
  analyzer: SearchAnalyzerIdentity;
  files: Record<string, AnalysisCacheEntry>;
};

type RankedCandidate = {
  path: string;
  title: string;
  tags: string[];
  bucket: number;
  score: number;
  baseRank: number;
  exactPriority: number;
  phrasePriority: number;
  coverageTerms: number;
  coverageFieldScore: number;
};

type QueryContext = {
  phrase: string;
  terms: string[];
  allowed: Set<SearchField>;
};

type CoverageField = "title" | "aliases" | "tags" | "headings" | "path";

const CANDIDATE_LIMIT_MIN = 50;
const CANDIDATE_LIMIT_MULTIPLIER = 10;
const RRF_K = 10;
const RRF_WEIGHTS = {
  identity: 4,
  phrase: 3,
  coverage: 2,
  base: 1
} as const;
const RANK_BUCKET = {
  exact: 0,
  phrase: 1,
  coverage: 2,
  base: 3
} as const;
const EXACT_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2
} as const;
const PHRASE_PRIORITY = {
  title: 0,
  alias: 1,
  filenameStem: 2,
  heading: 3,
  pathSegment: 4
} as const;
const COVERAGE_FIELD_WEIGHT: Record<CoverageField, number> = {
  title: 5,
  aliases: 4,
  tags: 3,
  headings: 2,
  path: 1
};

const activeSearchReconciles = new Map<string, ActiveSearchReconcile>();
let spawnSearchReconcileChild: SearchReconcileChildSpawner = spawnDetachedSearchReconcileChild;
let searchReconcileLockStaleMs = SEARCH_RECONCILE_LOCK_STALE_MS;

export async function searchVault(vaultRoot: string, params: SearchParams): Promise<SearchResult> {
  return searchVaultWithAnalyzer(vaultRoot, params, resolveSearchAnalyzer());
}

export async function searchVaultWithAnalyzer(
  vaultRoot: string,
  params: SearchParams,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester = requestSearchReconcile
): Promise<SearchResult> {
  return withSearchAnalyzerLease(
    analyzer,
    (leasedAnalyzer) => searchVaultWithLeasedAnalyzer(vaultRoot, params, leasedAnalyzer, requestReconcile),
    (event) => requestReconcile(vaultRoot, event.degradedAnalyzer, "terminal-analyzer-failure")
  );
}

async function searchVaultWithLeasedAnalyzer(
  vaultRoot: string,
  params: SearchParams,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester
): Promise<SearchResult> {
  const search = normalizeSearchParams(params);
  const pathFilter = search.path ? resolvePathFilter(vaultRoot, search.path) : undefined;
  const loaded = await loadOrBuildIndex(vaultRoot, analyzer, requestReconcile);
  const servedAnalyzer = loaded.analyzer;
  const analyzedQuery = search.query ? tokensToSearchText(await servedAnalyzer.tokenize(search.query)) : undefined;
  const queryTerms = analyzedQuery ? analyzedQuery.split(" ").filter(Boolean) : [];
  if (search.query && queryTerms.length === 0) {
    return searchResult([], loaded.warnings);
  }
  const rawLimit = search.query
    ? Math.min(loaded.manifest.documents, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : pathFilter || search.tags
      ? loaded.manifest.documents
      : search.limit;
  const properties = searchFields(search.fields).map((field) => SEARCH_FIELD_INDEX_PROPERTY[field]);
  const results = (await oramaSearch(loaded.db, {
    limit: rawLimit,
    ...(analyzedQuery
      ? {
          term: analyzedQuery,
          properties,
          boost: boostForFields(search.fields),
          tolerance: 0
        }
      : {})
  })) as Results<SearchDocument>;

  const filteredHits = results.hits.filter(
    (hit) => (!pathFilter || matchesPathFilter(hit.document.path, pathFilter)) && matchesTagFilter(hit.document.tags, search.tags)
  );
  const matches = search.query
    ? rerankCandidates(search.query, queryTerms, filteredHits, search.fields).slice(0, search.limit)
    : filteredHits
        .map((hit) => ({
          path: hit.document.path,
          title: hit.document.title,
          tags: hit.document.tags
        }))
        .sort(compareTagOnlyMatches)
        .slice(0, search.limit);

  const withSnippets = await Promise.all(matches.map(async (match) => ({
    path: match.path,
    title: match.title,
    tags: match.tags,
    snippets: await snippetsForDocument(vaultRoot, match.path, search.query, queryTerms, servedAnalyzer)
  })));

  return searchResult(withSnippets, loaded.warnings);
}

function searchResult(matches: SearchMatch[], warnings: string[] = []): SearchResult {
  return {
    ok: true,
    command: "search",
    matches,
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export function getSearchIndexStatus(vaultRoot: string): SearchIndexStatusResult {
  const analyzer = resolveSearchAnalyzer();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const reconcile = readSearchReconcileStatus(paths.cacheDir);
  const manifest = readManifest(paths);
  if (!fs.existsSync(paths.indexPath) || !manifest) {
    return searchIndexStatus(false, false, reconcile);
  }
  const mismatch = classifySearchManifestMismatch(manifest, analyzer.identity);
  if (mismatch !== "match" && mismatch !== "tier-only-upgrade") {
    return searchIndexStatus(false, false, reconcile);
  }
  try {
    restoreDb(paths.indexPath);
  } catch {
    return searchIndexStatus(false, false, reconcile);
  }
  return searchIndexStatus(true, mismatch === "tier-only-upgrade", reconcile);
}

function searchIndexStatus(
  ready: boolean,
  staleTier: boolean,
  reconcile: SearchIndexReconcileStatus | undefined
): SearchIndexStatusResult {
  return {
    ok: true,
    command: "index",
    action: "status",
    ready,
    ...(staleTier ? { staleTier: true } : {}),
    ...(reconcile ? { reconcile } : {})
  };
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
  });
}

async function rebuildSearchIndexWithLeasedAnalyzer(vaultRoot: string, analyzer: SearchAnalyzer): Promise<void> {
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const currentFiles = currentFileManifest(vaultRoot);
  await buildAndPersistIndex(vaultRoot, currentFiles, paths, analyzer);
}

export async function reconcileSearchIndex(vaultRoot: string, reason: SearchReconcileReason = "manual"): Promise<void> {
  const analyzer = resolveSearchAnalyzer();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const reconcileLock = acquireSearchReconcileLock(paths.cacheDir, vaultRoot, analyzer, reason);
  if (!reconcileLock) return;

  try {
    await rebuildSearchIndexWithAnalyzer(vaultRoot, analyzer);
  } finally {
    reconcileLock.release();
  }
}

export function clearSearchIndex(vaultRoot: string): SearchIndexMutationResult {
  const analyzer = resolveSearchAnalyzer();
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  fs.rmSync(paths.indexPath, { force: true });
  fs.rmSync(paths.manifestPath, { force: true });
  fs.rmSync(paths.analysisPath, { force: true });
  return {
    ok: true,
    command: "index",
    action: "clear"
  };
}

export function cachePaths(vaultRoot: string, analyzerKey = "intl"): CachePaths {
  const root = vaultRealpath(vaultRoot);
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheDir = path.join(base, "optsidian", hash);
  const indexFile = analyzerKey === "intl" ? SEARCH_INDEX_FILE : `search-${analyzerKey}.orama`;
  const manifestFile = analyzerKey === "intl" ? SEARCH_MANIFEST_FILE : `manifest-${analyzerKey}.json`;
  const analysisFile = analyzerKey === "intl" ? SEARCH_ANALYSIS_CACHE_FILE : `analysis-${analyzerKey}.json`;
  return {
    cacheDir,
    indexPath: path.join(cacheDir, indexFile),
    manifestPath: path.join(cacheDir, manifestFile),
    analysisPath: path.join(cacheDir, analysisFile)
  };
}

export function searchReconcileCommand(): string {
  return SEARCH_RECONCILE_COMMAND;
}

export function searchReconcileLockPath(vaultRoot: string): string {
  return path.join(cachePaths(vaultRoot).cacheDir, SEARCH_RECONCILE_LOCK_DIR);
}

export function parseSearchReconcileReason(raw: string | undefined): SearchReconcileReason {
  if (raw === undefined || raw.trim() === "") return "manual";
  const value = raw.startsWith("reason=") ? raw.slice("reason=".length) : raw;
  if (isSearchReconcileReason(value)) return value;
  throw new UsageError(`search reconcile reason must be one of: ${SEARCH_RECONCILE_REASONS.join(", ")}`);
}

export function __setSearchReconcileChildSpawnerForTests(spawner: SearchReconcileChildSpawner | undefined): void {
  spawnSearchReconcileChild = spawner ?? spawnDetachedSearchReconcileChild;
  activeSearchReconciles.clear();
}

export function __setSearchReconcileLockStaleMsForTests(value: number | undefined): void {
  searchReconcileLockStaleMs = value ?? SEARCH_RECONCILE_LOCK_STALE_MS;
}

function requestSearchReconcile(vaultRoot: string, analyzer: SearchAnalyzer, reason: SearchReconcileReason): void {
  const bin = process.argv[1];
  if (!bin) return;

  const root = vaultRealpath(vaultRoot);
  const key = `${root}\0${analyzerIdentityKey(analyzer.identity)}`;
  const active = activeSearchReconciles.get(key);
  if (active) {
    active.reasons.add(reason);
    return;
  }

  const request: ActiveSearchReconcile = { reasons: new Set([reason]) };
  activeSearchReconciles.set(key, request);

  try {
    const child = spawnSearchReconcileChild(bin, [SEARCH_RECONCILE_COMMAND, root, `reason=${reason}`], process.env);
    const clear = () => {
      if (activeSearchReconciles.get(key) === request) activeSearchReconciles.delete(key);
    };
    child.once("error", clear);
    child.once("exit", clear);
    child.once("close", clear);
    child.unref();
  } catch {
    activeSearchReconciles.delete(key);
  }
}

const SEARCH_RECONCILE_REASONS = ["stale-tier", "incompatible", "terminal-analyzer-failure", "manual"] as const satisfies readonly SearchReconcileReason[];

function isSearchReconcileReason(value: string): value is SearchReconcileReason {
  return (SEARCH_RECONCILE_REASONS as readonly string[]).includes(value);
}

function spawnDetachedSearchReconcileChild(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: "ignore",
    env
  });
}

function acquireSearchReconcileLock(
  cacheDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: SearchReconcileReason
): SearchReconcileLock | undefined {
  fs.mkdirSync(cacheDir, { recursive: true });
  const lockDir = path.join(cacheDir, SEARCH_RECONCILE_LOCK_DIR);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      writeSearchReconcileLockOwner(lockDir, vaultRoot, analyzer, reason);
      return {
        release() {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (!isPathExistsError(error)) throw error;
      if (attempt === 0 && removeStaleSearchReconcileLock(lockDir)) continue;
      return undefined;
    }
  }
  return undefined;
}

function writeSearchReconcileLockOwner(
  lockDir: string,
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  reason: SearchReconcileReason
): void {
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    reason,
    vaultRoot: vaultRealpath(vaultRoot),
    analyzer: analyzer.identity
  };
  try {
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
  } catch {
    // The lock itself is the directory; owner metadata is best-effort diagnostics.
  }
}

function readSearchReconcileStatus(cacheDir: string): SearchIndexReconcileStatus | undefined {
  const lockDir = path.join(cacheDir, SEARCH_RECONCILE_LOCK_DIR);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }

  const owner = readSearchReconcileLockOwner(lockDir);
  return {
    active: true,
    stale: isSearchReconcileLockStale(stat),
    ...(owner?.reason ? { reason: owner.reason } : {}),
    ...(owner?.startedAt ? { startedAt: owner.startedAt } : {}),
    ...(owner?.pid !== undefined ? { pid: owner.pid } : {})
  };
}

function readSearchReconcileLockOwner(lockDir: string): SearchReconcileLockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      ...(typeof parsed.reason === "string" && isSearchReconcileReason(parsed.reason) ? { reason: parsed.reason } : {}),
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) ? { pid: parsed.pid } : {})
    };
  } catch {
    return undefined;
  }
}

function removeStaleSearchReconcileLock(lockDir: string): boolean {
  if (searchReconcileLockStaleMs < 1) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if (isNoEntryError(error)) return true;
    throw error;
  }
  if (!isSearchReconcileLockStale(stat)) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function isSearchReconcileLockStale(stat: fs.Stats): boolean {
  return searchReconcileLockStaleMs >= 1 && Date.now() - stat.mtimeMs >= searchReconcileLockStaleMs;
}

function isPathExistsError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "ENOENT";
}

async function loadOrBuildIndex(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  requestReconcile: SearchReconcileRequester
): Promise<LoadedIndex> {
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  const currentFiles = currentFileManifest(vaultRoot);
  const manifest = readManifest(paths);
  if (manifest && fs.existsSync(paths.indexPath)) {
    const mismatch = classifySearchManifestMismatch(manifest, analyzer.identity);
    try {
      const db = restoreDb(paths.indexPath);
      const diff = diffManifestFiles(manifest.files, currentFiles);
      if (mismatch === "match") {
        if (!hasManifestDiff(diff)) {
          return { db, manifest, analyzer, warnings: [] };
        }
        const updated = await applyIncrementalIndex(vaultRoot, db, currentFiles, diff, paths, analyzer);
        return { db, manifest: updated, analyzer, warnings: [] };
      }

      if (mismatch === "tier-only-upgrade" && !hasManifestDiff(diff)) {
        const servedAnalyzer = createServedSearchAnalyzer(manifest.analyzer);
        if (servedAnalyzer) {
          requestReconcile(vaultRoot, analyzer, "stale-tier");
          return { db, manifest, analyzer: servedAnalyzer, warnings: [SEARCH_INDEX_STALE_TIER_WARNING] };
        }
      }
    } catch {
      // Fall through to a full rebuild on any restore or incremental failure.
    }
  }

  const rebuilt = await buildAndPersistIndex(vaultRoot, currentFiles, paths, analyzer);
  const db = restoreDb(paths.indexPath);
  return { db, manifest: rebuilt, analyzer, warnings: [] };
}

async function buildAndPersistIndex(
  vaultRoot: string,
  files: Record<string, FileManifest>,
  paths: CachePaths,
  analyzer: SearchAnalyzer
): Promise<SearchManifest> {
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  const db = createSearchDb();
  const analysisCache = readAnalysisCache(paths, analyzer.identity);
  const docs = await buildDocuments(vaultRoot, files, Object.keys(files), analyzer, analysisCache);
  await insertMultiple(db, docs, 500);
  persistDb(db, paths.indexPath);
  const manifest = createSearchManifest(docs.length, analyzer.identity, files);
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeAnalysisCache(paths, analyzer.identity, files, docs);
  return manifest;
}

async function applyIncrementalIndex(
  vaultRoot: string,
  db: AnyOrama,
  files: Record<string, FileManifest>,
  diff: ManifestDiff,
  paths: CachePaths,
  analyzer: SearchAnalyzer
): Promise<SearchManifest> {
  fs.mkdirSync(paths.cacheDir, { recursive: true });

  for (const rel of [...diff.deleted, ...diff.changed]) {
    await remove(db, rel);
  }

  const analysisCache = readAnalysisCache(paths, analyzer.identity);
  const toInsert = [...diff.added, ...diff.changed]
    .map((rel) => parseDocument(vaultRoot, rel, files[rel], analyzer, analysisCache));
  const resolved = await Promise.all(toInsert);
  const docs = resolved
    .filter((doc): doc is SearchDocument => Boolean(doc));

  if (docs.length > 0) {
    await insertMultiple(db, docs, 500);
  }

  persistDb(db, paths.indexPath);
  const manifest = createSearchManifest(await count(db), analyzer.identity, files);
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeAnalysisCache(paths, analyzer.identity, files, docs, analysisCache, new Set([...diff.deleted, ...diff.changed]));
  return manifest;
}

function createSearchDb(): AnyOrama {
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

function persistDb(db: AnyOrama, indexPath: string): void {
  fs.writeFileSync(indexPath, `${JSON.stringify(save(db))}\n`);
}

function restoreDb(indexPath: string): AnyOrama {
  const db = createSearchDb();
  load(db, JSON.parse(fs.readFileSync(indexPath, "utf8")) as RawData);
  return db;
}

function createSearchManifest(
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

function searchManifestIdentity(analyzer: SearchAnalyzerIdentity): Omit<SearchManifest, "builtAt" | "documents" | "analyzer" | "files"> {
  const activeAnalyzers = normalizeAnalyzerList(analyzer.activeAnalyzers ?? []);
  return {
    identitySchemaVersion: SEARCH_IDENTITY_SCHEMA_VERSION,
    schemaVersion: SEARCH_SCHEMA_VERSION,
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

function searchTokenizerTier(analyzer: SearchAnalyzerIdentity): SearchTokenizerTier {
  return normalizeAnalyzerList(analyzer.activeAnalyzers ?? []).includes("ko") ? "kiwi" : "intl";
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

async function buildDocuments(
  vaultRoot: string,
  files: Record<string, FileManifest>,
  relPaths: string[],
  analyzer: SearchAnalyzer,
  analysisCache: AnalysisCache | undefined
): Promise<SearchDocument[]> {
  const docs: SearchDocument[] = [];
  for (const rel of relPaths.sort((a, b) => a.localeCompare(b))) {
    const doc = await parseDocument(vaultRoot, rel, files[rel], analyzer, analysisCache);
    if (doc) docs.push(doc);
  }
  return docs;
}

async function parseDocument(
  vaultRoot: string,
  relPath: string,
  manifest: FileManifest | undefined,
  analyzer: SearchAnalyzer,
  analysisCache: AnalysisCache | undefined
): Promise<SearchDocument | undefined> {
  const abs = path.join(vaultRoot, relPath);
  try {
    const text = decodeUtf8(fs.readFileSync(abs), relPath);
    const note = parseMarkdownNote(relPath, text);
    const cached = manifest ? cachedTokenFields(analysisCache, relPath, manifest) : undefined;
    if (cached) return { ...note, ...cached };
    return analyzeDocument(note, analyzer);
  } catch {
    return undefined;
  }
}

async function analyzeDocument(note: ParsedMarkdownNote, analyzer: SearchAnalyzer): Promise<SearchDocument> {
  const [pathTokens, titleTokens, aliasesTokens, tagsTokens, headingsTokens, bodyTokens] = await analyzer.tokenizeBatch([
    note.path,
    note.title,
    note.aliases.join(" "),
    note.tags.join(" "),
    note.headings.join(" "),
    note.body
  ]);
  return {
    ...note,
    pathTokens: tokensToSearchText(pathTokens ?? []),
    titleTokens: tokensToSearchText(titleTokens ?? []),
    aliasesTokens: tokensToSearchText(aliasesTokens ?? []),
    tagsTokens: tokensToSearchText(tagsTokens ?? []),
    headingsTokens: tokensToSearchText(headingsTokens ?? []),
    bodyTokens: tokensToSearchText(bodyTokens ?? [])
  };
}

function currentFileManifest(vaultRoot: string): Record<string, FileManifest> {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false });
  const manifest: Record<string, FileManifest> = {};
  for (const abs of files) {
    const stat = fs.statSync(abs);
    manifest[vaultRelative(root, abs)] = { mtimeMs: stat.mtimeMs, size: stat.size };
  }
  return manifest;
}

function readManifest(paths: CachePaths): SearchManifest | undefined {
  if (!fs.existsSync(paths.manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as unknown;
    return isSearchManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    value.identitySchemaVersion === SEARCH_IDENTITY_SCHEMA_VERSION &&
    typeof value.schemaVersion === "number" &&
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

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function readAnalysisCache(paths: CachePaths, analyzer: SearchAnalyzerIdentity): AnalysisCache | undefined {
  if (!fs.existsSync(paths.analysisPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.analysisPath, "utf8")) as AnalysisCache;
    if (parsed.schemaVersion !== SEARCH_ANALYSIS_CACHE_SCHEMA_VERSION) return undefined;
    if (analyzerIdentityKey(parsed.analyzer) !== analyzerIdentityKey(analyzer)) return undefined;
    if (!parsed.files || typeof parsed.files !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeAnalysisCache(
  paths: CachePaths,
  analyzer: SearchAnalyzerIdentity,
  files: Record<string, FileManifest>,
  docs: SearchDocument[],
  previous?: AnalysisCache,
  dropPaths: Set<string> = new Set()
): void {
  const nextFiles: Record<string, AnalysisCacheEntry> = {};
  for (const [rel, entry] of Object.entries(previous?.files ?? {})) {
    const current = files[rel];
    if (!current || dropPaths.has(rel) || !sameFileManifest(entry, current)) continue;
    nextFiles[rel] = entry;
  }
  for (const doc of docs) {
    const manifest = files[doc.path];
    if (!manifest) continue;
    nextFiles[doc.path] = {
      ...manifest,
      tokens: tokenFields(doc)
    };
  }
  const cache: AnalysisCache = {
    schemaVersion: SEARCH_ANALYSIS_CACHE_SCHEMA_VERSION,
    analyzer,
    files: nextFiles
  };
  fs.writeFileSync(paths.analysisPath, `${JSON.stringify(cache)}\n`);
}

function cachedTokenFields(cache: AnalysisCache | undefined, relPath: string, manifest: FileManifest): SearchTokenFields | undefined {
  const entry = cache?.files[relPath];
  if (!entry || !sameFileManifest(entry, manifest)) return undefined;
  return entry.tokens;
}

function sameFileManifest(left: FileManifest, right: FileManifest): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function tokenFields(doc: SearchDocument): SearchTokenFields {
  return {
    pathTokens: doc.pathTokens,
    titleTokens: doc.titleTokens,
    aliasesTokens: doc.aliasesTokens,
    tagsTokens: doc.tagsTokens,
    headingsTokens: doc.headingsTokens,
    bodyTokens: doc.bodyTokens
  };
}

export function classifySearchManifestMismatch(
  manifest: Partial<SearchManifest> | undefined,
  analyzer: SearchAnalyzerIdentity
): SearchManifestMismatch {
  if (!hasCompleteSearchManifestIdentity(manifest)) return "incompatible";
  const expected = searchManifestIdentity(analyzer);
  const structurallyCompatible =
    manifest.identitySchemaVersion === expected.identitySchemaVersion &&
    manifest.schemaVersion === expected.schemaVersion &&
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

function isManifestUsableForRead(manifest: SearchManifest, analyzer: SearchAnalyzerIdentity): boolean {
  const mismatch = classifySearchManifestMismatch(manifest, analyzer);
  return mismatch === "match" || mismatch === "tier-only-upgrade";
}

function diffManifestFiles(previous: Record<string, FileManifest>, current: Record<string, FileManifest>): ManifestDiff {
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

function hasManifestDiff(diff: ManifestDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.deleted.length > 0;
}

function normalizeSearchParams(params: SearchParams): NormalizedSearchParams {
  assertOptionalPositiveInteger(params.limit, "limit");
  const query = params.query?.trim();
  if (params.query !== undefined && !query) {
    throw new UsageError("query must not be empty");
  }
  const tags = normalizeTagFilters(params.tags);
  const fields = normalizeSearchFields(params.fields);
  if (fields && !query) {
    throw new UsageError("field=<field> requires query=<text>");
  }
  if (!query && !tags) {
    throw new UsageError("search requires query=<text> or tag=<tag>");
  }
  return {
    query: query || undefined,
    path: params.path,
    tags,
    fields,
    limit: params.limit ?? 10
  };
}

function resolvePathFilter(vaultRoot: string, input: string): PathFilter {
  const resolved = resolveVaultPath(vaultRoot, input, { mustExist: true });
  const stat = fs.statSync(resolved.abs);
  return { rel: resolved.rel === "." ? "" : resolved.rel, directory: stat.isDirectory() };
}

function matchesPathFilter(relPath: string, filter: PathFilter): boolean {
  if (!filter.rel) return true;
  if (!filter.directory) return relPath === filter.rel;
  return relPath === filter.rel || relPath.startsWith(`${filter.rel}/`);
}

function rerankCandidates(
  query: string,
  queryTerms: string[],
  hits: Array<{ document: SearchDocument; score: number }>,
  fields?: SearchField[]
): RankedCandidate[] {
  const context = queryContext(query, queryTerms, fields);
  const candidates = hits.map((hit, index) => rankedCandidate(hit.document, index + 1, context));
  const identityRanks = rankMap(candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.exact), compareIdentityRank);
  const phraseRanks = rankMap(
    candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.phrase),
    comparePhraseRank
  );
  const coverageRanks = rankMap(
    candidates.filter((candidate) => candidate.bucket === RANK_BUCKET.phrase || candidate.bucket === RANK_BUCKET.coverage),
    compareCoverageRank
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: rerankScore(candidate, identityRanks, phraseRanks, coverageRanks)
    }))
    .sort(compareRankedMatches);
}

function rankedCandidate(doc: SearchDocument, baseRank: number, context: QueryContext): RankedCandidate {
  const exactPriority = bestExactPriority(doc, context);
  const phrasePriority = bestPhrasePriority(doc, context);
  const coverage = metadataCoverage(doc, context);
  return {
    path: doc.path,
    title: doc.title,
    tags: doc.tags,
    bucket: rankBucket(exactPriority, phrasePriority, coverage.terms),
    score: 0,
    baseRank,
    exactPriority,
    phrasePriority,
    coverageTerms: coverage.terms,
    coverageFieldScore: coverage.fieldScore
  };
}

async function snippetsForDocument(
  vaultRoot: string,
  relPath: string,
  query: string | undefined,
  queryTerms: string[],
  analyzer: SearchAnalyzer
): Promise<SearchSnippet[]> {
  try {
    const abs = resolveVaultPath(vaultRoot, relPath, { mustExist: true }).abs;
    const lines = splitText(decodeUtf8(fs.readFileSync(abs), relPath)).lines;
    const bodyStart = bodyStartLine(lines);
    const terms = query ? queryTerms : [];
    const headingSnippets = await matchingSnippets(lines, terms, bodyStart, analyzer, (line) => /^#{1,6}\s+/.test(line));
    const bodySnippets = await matchingSnippets(lines, terms, bodyStart, analyzer, (line) => !/^#{1,6}\s+/.test(line));
    const snippets = uniqueSnippets(bodySnippets.length > 0 ? [...headingSnippets.slice(0, 1), ...bodySnippets] : headingSnippets).slice(
      0,
      3
    );
    if (snippets.length > 0) return snippets;
    const headingIndex = lines.findIndex((line, index) => index >= bodyStart && /^#{1,6}\s+/.test(line));
    if (headingIndex >= 0) return [{ line: headingIndex + 1, text: lines[headingIndex] }];
    const nonEmptyIndex = lines.findIndex((line, index) => index >= bodyStart && line.trim().length > 0);
    if (nonEmptyIndex >= 0) return [{ line: nonEmptyIndex + 1, text: lines[nonEmptyIndex] }];
    return [];
  } catch {
    return [];
  }
}

function bodyStartLine(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---" || trimmed === "...") return index + 1;
  }
  return 0;
}

async function matchingSnippets(
  lines: string[],
  terms: string[],
  start: number,
  analyzer: SearchAnalyzer,
  predicate: (line: string) => boolean
): Promise<SearchSnippet[]> {
  const candidates: SearchSnippet[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (predicate(line)) {
      candidates.push({ line: index + 1, text: line });
    }
  }
  if (terms.length === 0 || candidates.length === 0) return [];
  const tokenized = await analyzer.tokenizeBatch(candidates.map((candidate) => candidate.text));
  return candidates.filter((_, index) => tokensMatchTerms(tokenized[index] ?? [], terms));
}

function uniqueSnippets(snippets: SearchSnippet[]): SearchSnippet[] {
  const seen = new Set<number>();
  const result: SearchSnippet[] = [];
  for (const snippet of snippets) {
    if (seen.has(snippet.line)) continue;
    seen.add(snippet.line);
    result.push(snippet);
  }
  return result;
}

function searchFields(fields: SearchField[] | undefined): SearchField[] {
  return fields ?? [...SEARCH_PROPERTIES];
}

function boostForFields(fields: SearchField[] | undefined): Record<string, number> {
  const allowed = new Set(searchFields(fields));
  return Object.fromEntries(
    SEARCH_PROPERTIES.filter((field) => allowed.has(field)).map((field) => [SEARCH_FIELD_INDEX_PROPERTY[field], SEARCH_BOOST[field]])
  ) as Record<string, number>;
}

function normalizeTagFilters(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  const normalized = [...new Set(tags.map((tag) => tag.replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new UsageError("tag must include at least one non-empty tag");
  }
  return normalized;
}

function normalizeSearchFields(fields: string[] | undefined): SearchField[] | undefined {
  if (fields === undefined) return undefined;
  const normalized = [...new Set(fields.map((field) => field.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new UsageError(`field must include at least one of: ${SEARCH_PROPERTIES.join(", ")}`);
  }
  for (const field of normalized) {
    if (!SEARCH_PROPERTIES.includes(field as SearchField)) {
      throw new UsageError(`field must be one of: ${SEARCH_PROPERTIES.join(", ")}`);
    }
  }
  return normalized as SearchField[];
}

function matchesTagFilter(docTags: string[], tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  const available = new Set(docTags.map((tag) => normalizeText(tag)));
  return tags.every((tag) => available.has(normalizeText(tag)));
}

function compareRankedMatches(left: RankedCandidate, right: RankedCandidate): number {
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
}

function compareTagOnlyMatches(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

function tokensMatchTerms(tokens: readonly string[], terms: readonly string[]): boolean {
  const available = new Set(tokens);
  return terms.some((term) => available.has(term));
}

function queryContext(query: string, queryTerms: string[], fields?: SearchField[]): QueryContext {
  return {
    phrase: normalizeIdentityText(query),
    terms: queryTerms,
    allowed: new Set(searchFields(fields))
  };
}

function bestExactPriority(doc: SearchDocument, context: QueryContext): number {
  const priorities: number[] = [];
  if (context.allowed.has("title") && normalizeIdentityText(doc.title) === context.phrase) priorities.push(EXACT_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => normalizeIdentityText(alias) === context.phrase)) {
    priorities.push(EXACT_PRIORITY.alias);
  }
  if (context.allowed.has("path") && normalizeIdentityText(filenameStem(doc.path)) === context.phrase) {
    priorities.push(EXACT_PRIORITY.filenameStem);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

function bestPhrasePriority(doc: SearchDocument, context: QueryContext): number {
  if (!context.phrase) return Number.POSITIVE_INFINITY;
  const priorities: number[] = [];
  if (context.allowed.has("title") && containsNormalizedPhrase(doc.title, context.phrase)) priorities.push(PHRASE_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => containsNormalizedPhrase(alias, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.alias);
  }
  if (context.allowed.has("path") && containsNormalizedPhrase(filenameStem(doc.path), context.phrase)) {
    priorities.push(PHRASE_PRIORITY.filenameStem);
  }
  if (context.allowed.has("path") && pathSegments(doc.path).some((segment) => containsNormalizedPhrase(segment, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.pathSegment);
  }
  if (context.allowed.has("headings") && doc.headings.some((heading) => containsNormalizedPhrase(heading, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.heading);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

function metadataCoverage(doc: SearchDocument, context: QueryContext): { terms: number; fieldScore: number } {
  if (context.terms.length === 0) return { terms: 0, fieldScore: 0 };
  const values: Array<[CoverageField, string[]]> = [
    ["title", context.allowed.has("title") ? fieldTokens(doc.titleTokens) : []],
    ["aliases", context.allowed.has("aliases") ? fieldTokens(doc.aliasesTokens) : []],
    ["tags", context.allowed.has("tags") ? fieldTokens(doc.tagsTokens) : []],
    ["headings", context.allowed.has("headings") ? fieldTokens(doc.headingsTokens) : []],
    ["path", context.allowed.has("path") ? fieldTokens(doc.pathTokens) : []]
  ];

  let matchedTerms = 0;
  let fieldScore = 0;
  for (const term of context.terms) {
    let matched = false;
    for (const [field, entries] of values) {
      if (entries.includes(term)) {
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field];
      }
    }
    if (matched) matchedTerms += 1;
  }

  return { terms: matchedTerms, fieldScore };
}

function fieldTokens(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function rankBucket(exactPriority: number, phrasePriority: number, coverageTerms: number): number {
  if (Number.isFinite(exactPriority)) return RANK_BUCKET.exact;
  if (Number.isFinite(phrasePriority)) return RANK_BUCKET.phrase;
  if (coverageTerms > 0) return RANK_BUCKET.coverage;
  return RANK_BUCKET.base;
}

function rankMap(candidates: RankedCandidate[], comparator: (left: RankedCandidate, right: RankedCandidate) => number): Map<string, number> {
  const sorted = [...candidates].sort(comparator);
  return new Map(sorted.map((candidate, index) => [candidate.path, index + 1]));
}

function rerankScore(
  candidate: RankedCandidate,
  identityRanks: Map<string, number>,
  phraseRanks: Map<string, number>,
  coverageRanks: Map<string, number>
): number {
  let score = rrfContribution(candidate.baseRank, RRF_WEIGHTS.base);
  if (candidate.bucket === RANK_BUCKET.exact) {
    const rank = identityRanks.get(candidate.path);
    if (rank) score += rrfContribution(rank, RRF_WEIGHTS.identity);
  } else if (candidate.bucket === RANK_BUCKET.phrase) {
    const phraseRank = phraseRanks.get(candidate.path);
    if (phraseRank) score += rrfContribution(phraseRank, RRF_WEIGHTS.phrase);
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, RRF_WEIGHTS.coverage);
  } else if (candidate.bucket === RANK_BUCKET.coverage) {
    const coverageRank = coverageRanks.get(candidate.path);
    if (coverageRank) score += rrfContribution(coverageRank, RRF_WEIGHTS.coverage);
  }
  return score;
}

function compareIdentityRank(left: RankedCandidate, right: RankedCandidate): number {
  if (left.exactPriority !== right.exactPriority) return left.exactPriority - right.exactPriority;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function comparePhraseRank(left: RankedCandidate, right: RankedCandidate): number {
  if (left.phrasePriority !== right.phrasePriority) return left.phrasePriority - right.phrasePriority;
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function compareCoverageRank(left: RankedCandidate, right: RankedCandidate): number {
  if (right.coverageTerms !== left.coverageTerms) return right.coverageTerms - left.coverageTerms;
  if (right.coverageFieldScore !== left.coverageFieldScore) return right.coverageFieldScore - left.coverageFieldScore;
  if (left.baseRank !== right.baseRank) return left.baseRank - right.baseRank;
  return left.path.localeCompare(right.path);
}

function rrfContribution(rank: number, weight: number): number {
  return weight / (RRF_K + rank);
}

function containsNormalizedPhrase(value: string, phrase: string): boolean {
  const normalized = normalizeIdentityText(value);
  return normalized.length > 0 && normalized.includes(phrase);
}

function filenameStem(relPath: string): string {
  return path.basename(relPath, path.extname(relPath));
}

function pathSegments(relPath: string): string[] {
  const dirname = path.dirname(relPath);
  if (!dirname || dirname === ".") return [];
  return dirname.split(/[\\/]+/).filter(Boolean);
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function normalizeIdentityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/#/g, " ")
    .replace(/[._/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
