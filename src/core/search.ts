import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { count, create, insertMultiple, load, remove, save, search as oramaSearch } from "@orama/orama";
import type { AnyOrama, RawData, Results } from "@orama/orama";
import { OPTSIDIAN_VERSION } from "../version.js";
import { UsageError } from "../errors.js";
import { resolveVaultPath, vaultRealpath, vaultRelative, walkFiles } from "./path.js";
import { parseMarkdownNote, SearchDocument } from "./search-parse.js";
import { decodeUtf8, splitText } from "./text.js";
import type {
  SearchField,
  SearchIndexMutationResult,
  SearchIndexStatusResult,
  SearchMatch,
  SearchParams,
  SearchResult,
  SearchSnippet
} from "./types.js";
import { assertOptionalPositiveInteger } from "./validation.js";

const SEARCH_SCHEMA_VERSION = 1;
const SEARCH_ENGINE = "orama";
const SEARCH_INDEX_FILE = "search.orama";
const SEARCH_MANIFEST_FILE = "manifest.json";
const SEARCH_PROPERTIES = ["title", "aliases", "tags", "headings", "path", "body"] as const satisfies readonly SearchField[];
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

type SearchManifest = {
  schemaVersion: number;
  engine: string;
  optsidianVersion: string;
  builtAt: string;
  documents: number;
  files: Record<string, FileManifest>;
};

type CachePaths = {
  cacheDir: string;
  indexPath: string;
  manifestPath: string;
};

type LoadedIndex = {
  db: AnyOrama;
  manifest: SearchManifest;
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

export async function searchVault(vaultRoot: string, params: SearchParams): Promise<SearchResult> {
  const search = normalizeSearchParams(params);
  const pathFilter = search.path ? resolvePathFilter(vaultRoot, search.path) : undefined;
  const loaded = await loadOrBuildIndex(vaultRoot);
  const rawLimit = search.query
    ? Math.min(loaded.manifest.documents, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : pathFilter || search.tags
      ? loaded.manifest.documents
      : search.limit;
  const properties = search.fields ? [...search.fields] : [...SEARCH_PROPERTIES];
  const results = (await oramaSearch(loaded.db, {
    limit: rawLimit,
    ...(search.query
      ? {
          term: normalizeQueryForOrama(search.query),
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
    ? rerankCandidates(search.query, filteredHits, search.fields).slice(0, search.limit)
    : filteredHits
        .map((hit) => ({
          path: hit.document.path,
          title: hit.document.title,
          tags: hit.document.tags
        }))
        .sort(compareTagOnlyMatches)
        .slice(0, search.limit);

  const withSnippets = matches.map((match) => ({
    path: match.path,
    title: match.title,
    tags: match.tags,
    snippets: snippetsForDocument(vaultRoot, match.path, search.query)
  }));

  return {
    ok: true,
    command: "search",
    matches: withSnippets
  };
}

export function getSearchIndexStatus(vaultRoot: string): SearchIndexStatusResult {
  const paths = cachePaths(vaultRoot);
  const manifest = readManifest(paths);
  if (!fs.existsSync(paths.indexPath) || !manifest) {
    return {
      ok: true,
      command: "index",
      action: "status",
      ready: false
    };
  }
  try {
    restoreDb(paths.indexPath);
  } catch {
    return {
      ok: true,
      command: "index",
      action: "status",
      ready: false
    };
  }
  return {
    ok: true,
    command: "index",
    action: "status",
    ready: true
  };
}

export async function rebuildSearchIndex(vaultRoot: string): Promise<SearchIndexMutationResult> {
  const paths = cachePaths(vaultRoot);
  const currentFiles = currentFileManifest(vaultRoot);
  await buildAndPersistIndex(vaultRoot, currentFiles, paths);
  return {
    ok: true,
    command: "index",
    action: "rebuild"
  };
}

export function clearSearchIndex(vaultRoot: string): SearchIndexMutationResult {
  const paths = cachePaths(vaultRoot);
  fs.rmSync(paths.cacheDir, { recursive: true, force: true });
  return {
    ok: true,
    command: "index",
    action: "clear"
  };
}

export function cachePaths(vaultRoot: string): CachePaths {
  const root = vaultRealpath(vaultRoot);
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheDir = path.join(base, "optsidian", hash);
  return {
    cacheDir,
    indexPath: path.join(cacheDir, SEARCH_INDEX_FILE),
    manifestPath: path.join(cacheDir, SEARCH_MANIFEST_FILE)
  };
}

async function loadOrBuildIndex(vaultRoot: string): Promise<LoadedIndex> {
  const paths = cachePaths(vaultRoot);
  const currentFiles = currentFileManifest(vaultRoot);
  const manifest = readManifest(paths);
  if (manifest && fs.existsSync(paths.indexPath) && hardRebuildReason(manifest) === undefined) {
    try {
      const db = restoreDb(paths.indexPath);
      const diff = diffManifestFiles(manifest.files, currentFiles);
      if (!hasManifestDiff(diff)) {
        return { db, manifest };
      }
      const updated = await applyIncrementalIndex(vaultRoot, db, currentFiles, diff, paths);
      return { db, manifest: updated };
    } catch {
      // Fall through to a full rebuild on any restore or incremental failure.
    }
  }

  const rebuilt = await buildAndPersistIndex(vaultRoot, currentFiles, paths);
  const db = restoreDb(paths.indexPath);
  return { db, manifest: rebuilt };
}

async function buildAndPersistIndex(vaultRoot: string, files: Record<string, FileManifest>, paths: CachePaths): Promise<SearchManifest> {
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  const db = createSearchDb();
  const docs = buildDocuments(vaultRoot, Object.keys(files));
  await insertMultiple(db, docs, 500);
  persistDb(db, paths.indexPath);
  const manifest: SearchManifest = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    engine: SEARCH_ENGINE,
    optsidianVersion: OPTSIDIAN_VERSION,
    builtAt: new Date().toISOString(),
    documents: docs.length,
    files
  };
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function applyIncrementalIndex(
  vaultRoot: string,
  db: AnyOrama,
  files: Record<string, FileManifest>,
  diff: ManifestDiff,
  paths: CachePaths
): Promise<SearchManifest> {
  fs.mkdirSync(paths.cacheDir, { recursive: true });

  for (const rel of [...diff.deleted, ...diff.changed]) {
    await remove(db, rel);
  }

  const toInsert = [...diff.added, ...diff.changed]
    .map((rel) => parseDocument(vaultRoot, rel))
    .filter((doc): doc is SearchDocument => Boolean(doc));

  if (toInsert.length > 0) {
    await insertMultiple(db, toInsert, 500);
  }

  persistDb(db, paths.indexPath);
  const manifest: SearchManifest = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    engine: SEARCH_ENGINE,
    optsidianVersion: OPTSIDIAN_VERSION,
    builtAt: new Date().toISOString(),
    documents: await count(db),
    files
  };
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function createSearchDb(): AnyOrama {
  return create({
    schema: {
      path: "string",
      title: "string",
      aliases: "string[]",
      tags: "string[]",
      headings: "string[]",
      body: "string"
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

function buildDocuments(vaultRoot: string, relPaths: string[]): SearchDocument[] {
  const docs: SearchDocument[] = [];
  for (const rel of relPaths.sort((a, b) => a.localeCompare(b))) {
    const doc = parseDocument(vaultRoot, rel);
    if (doc) docs.push(doc);
  }
  return docs;
}

function parseDocument(vaultRoot: string, relPath: string): SearchDocument | undefined {
  const abs = path.join(vaultRoot, relPath);
  try {
    const text = decodeUtf8(fs.readFileSync(abs), relPath);
    return parseMarkdownNote(relPath, text);
  } catch {
    return undefined;
  }
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
    return JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as SearchManifest;
  } catch {
    return undefined;
  }
}

function hardRebuildReason(manifest: SearchManifest): string | undefined {
  if (manifest.schemaVersion !== SEARCH_SCHEMA_VERSION) return "schema changed";
  if (manifest.engine !== SEARCH_ENGINE) return "engine changed";
  if (manifest.optsidianVersion !== OPTSIDIAN_VERSION) return "optsidian version changed";
  return undefined;
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
  hits: Array<{ document: SearchDocument; score: number }>,
  fields?: SearchField[]
): RankedCandidate[] {
  const context = queryContext(query, fields);
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

function snippetsForDocument(vaultRoot: string, relPath: string, query: string | undefined): SearchSnippet[] {
  try {
    const abs = resolveVaultPath(vaultRoot, relPath, { mustExist: true }).abs;
    const lines = splitText(decodeUtf8(fs.readFileSync(abs), relPath)).lines;
    const terms = query ? queryTerms(query) : [];
    const bodyStart = bodyStartLine(lines);
    const headingSnippets = matchingSnippets(lines, terms, bodyStart, (line) => /^#{1,6}\s+/.test(line));
    const bodySnippets = matchingSnippets(lines, terms, bodyStart, (line) => !/^#{1,6}\s+/.test(line));
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

function matchingSnippets(lines: string[], terms: string[], start: number, predicate: (line: string) => boolean): SearchSnippet[] {
  const snippets: SearchSnippet[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (predicate(line) && textMatchesTerms(line, terms)) {
      snippets.push({ line: index + 1, text: line });
    }
  }
  return snippets;
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

function queryTerms(query: string): string[] {
  const normalized = normalizeIdentityText(query);
  if (!normalized) return [];
  return [...new Set(normalized.split(" ").filter(Boolean))];
}

function searchFields(fields: SearchField[] | undefined): SearchField[] {
  return fields ?? [...SEARCH_PROPERTIES];
}

function boostForFields(fields: SearchField[] | undefined): Record<SearchField, number> {
  const allowed = new Set(searchFields(fields));
  return Object.fromEntries(
    SEARCH_PROPERTIES.filter((field) => allowed.has(field)).map((field) => [field, SEARCH_BOOST[field]])
  ) as Record<SearchField, number>;
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

function normalizeQueryForOrama(query: string): string {
  return query.replace(/#/g, " ").trim();
}

function textMatchesTerms(value: string, terms: string[]): boolean {
  const normalized = normalizeText(value);
  return terms.some((term) => normalized.includes(term));
}

function queryContext(query: string, fields?: SearchField[]): QueryContext {
  return {
    phrase: normalizeIdentityText(query),
    terms: queryTerms(query),
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
    ["title", context.allowed.has("title") ? [doc.title] : []],
    ["aliases", context.allowed.has("aliases") ? doc.aliases : []],
    ["tags", context.allowed.has("tags") ? doc.tags : []],
    ["headings", context.allowed.has("headings") ? doc.headings : []],
    ["path", context.allowed.has("path") ? [filenameStem(doc.path), ...pathSegments(doc.path)] : []]
  ];
  const normalized = new Map<CoverageField, string[]>(
    values.map(([field, entries]) => [field, entries.map(normalizeIdentityText).filter(Boolean)])
  );

  let matchedTerms = 0;
  let fieldScore = 0;
  for (const term of context.terms) {
    let matched = false;
    for (const [field, entries] of normalized) {
      if (entries.some((entry) => entry.includes(term))) {
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field];
      }
    }
    if (matched) matchedTerms += 1;
  }

  return { terms: matchedTerms, fieldScore };
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
