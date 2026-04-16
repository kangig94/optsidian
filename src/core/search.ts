import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create, insertMultiple, load, save, search as oramaSearch } from "@orama/orama";
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
  status: SearchResult["index"]["status"];
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

type RankedCandidate = Omit<SearchMatch, "snippets">;

export async function searchVault(vaultRoot: string, params: SearchParams): Promise<SearchResult> {
  const search = normalizeSearchParams(params);
  const pathFilter = search.path ? resolvePathFilter(vaultRoot, search.path) : undefined;
  const loaded = await loadOrBuildIndex(vaultRoot);
  const rawLimit = pathFilter || search.tags ? Math.max(loaded.manifest.documents, search.limit) : search.limit;
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

  const matches = results.hits
    .filter((hit) => (!pathFilter || matchesPathFilter(hit.document.path, pathFilter)) && matchesTagFilter(hit.document.tags, search.tags))
    .map((hit) => rankedCandidate(search.query, hit.document, hit.score, search.fields))
    .sort(search.query ? compareRankedMatches : compareTagOnlyMatches)
    .slice(0, search.limit);

  const withSnippets = matches.map((match) => ({
    ...match,
    snippets: snippetsForDocument(vaultRoot, match.path, search.query)
  }));

  return {
    ok: true,
    command: "search",
    query: search.query,
    count: matches.length,
    scope: pathFilter?.rel || undefined,
    filters: search.tags || search.fields ? { tags: search.tags, fields: search.fields } : undefined,
    index: {
      status: loaded.status,
      documents: loaded.manifest.documents,
      builtAt: loaded.manifest.builtAt
    },
    matches: withSnippets
  };
}

export function getSearchIndexStatus(vaultRoot: string): SearchIndexStatusResult {
  const paths = cachePaths(vaultRoot);
  const currentFiles = currentFileManifest(vaultRoot);
  const manifest = readManifest(paths);
  if (!fs.existsSync(paths.indexPath) || !manifest) {
    return {
      ok: true,
      command: "index",
      action: "status",
      ready: false,
      stale: true,
      cacheDir: paths.cacheDir,
      documents: 0,
      reason: "index missing"
    };
  }
  const staleReason = manifestStaleReason(manifest, currentFiles);
  return {
    ok: true,
    command: "index",
    action: "status",
    ready: true,
    stale: staleReason !== undefined,
    cacheDir: paths.cacheDir,
    documents: manifest.documents,
    builtAt: manifest.builtAt,
    reason: staleReason
  };
}

export async function rebuildSearchIndex(vaultRoot: string): Promise<SearchIndexMutationResult> {
  const paths = cachePaths(vaultRoot);
  const currentFiles = currentFileManifest(vaultRoot);
  const manifest = await buildAndPersistIndex(vaultRoot, currentFiles, paths);
  return {
    ok: true,
    command: "index",
    action: "rebuild",
    cacheDir: paths.cacheDir,
    documents: manifest.documents,
    builtAt: manifest.builtAt
  };
}

export function clearSearchIndex(vaultRoot: string): SearchIndexMutationResult {
  const paths = cachePaths(vaultRoot);
  fs.rmSync(paths.cacheDir, { recursive: true, force: true });
  return {
    ok: true,
    command: "index",
    action: "clear",
    cacheDir: paths.cacheDir,
    documents: 0
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
  if (manifest && fs.existsSync(paths.indexPath) && manifestStaleReason(manifest, currentFiles) === undefined) {
    try {
      const db = restoreDb(paths.indexPath);
      return { db, manifest, status: "fresh" };
    } catch {
      const rebuilt = await buildAndPersistIndex(vaultRoot, currentFiles, paths);
      const db = restoreDb(paths.indexPath);
      return { db, manifest: rebuilt, status: "rebuilt" };
    }
  }

  const rebuilt = await buildAndPersistIndex(vaultRoot, currentFiles, paths);
  const db = restoreDb(paths.indexPath);
  return { db, manifest: rebuilt, status: "rebuilt" };
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
    const abs = path.join(vaultRoot, rel);
    try {
      const text = decodeUtf8(fs.readFileSync(abs), rel);
      docs.push(parseMarkdownNote(rel, text));
    } catch {
      continue;
    }
  }
  return docs;
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

function manifestStaleReason(manifest: SearchManifest, currentFiles: Record<string, FileManifest>): string | undefined {
  if (manifest.schemaVersion !== SEARCH_SCHEMA_VERSION) return "schema changed";
  if (manifest.engine !== SEARCH_ENGINE) return "engine changed";
  if (manifest.optsidianVersion !== OPTSIDIAN_VERSION) return "optsidian version changed";
  const currentKeys = Object.keys(currentFiles).sort();
  const manifestKeys = Object.keys(manifest.files).sort();
  if (currentKeys.length !== manifestKeys.length) return "file set changed";
  for (let index = 0; index < currentKeys.length; index += 1) {
    const key = currentKeys[index];
    if (key !== manifestKeys[index]) return "file set changed";
    const current = currentFiles[key];
    const stored = manifest.files[key];
    if (!stored || current.size !== stored.size || current.mtimeMs !== stored.mtimeMs) return `file changed: ${key}`;
  }
  return undefined;
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

function rankedCandidate(query: string | undefined, doc: SearchDocument, baseScore: number, fields?: SearchField[]): RankedCandidate {
  const fieldMatches = matchedSearchFields(query, doc, fields);
  return {
    path: doc.path,
    score: roundScore(query ? baseScore + postBoost(query, doc, fields) : 0),
    title: doc.title,
    aliases: doc.aliases,
    tags: doc.tags,
    matchedFields: Object.keys(fieldMatches),
    fieldMatches
  };
}

function matchedSearchFields(query: string | undefined, doc: SearchDocument, fields?: SearchField[]): Record<string, string[]> {
  if (!query) return {};
  const allowed = new Set(searchFields(fields));
  const candidates: Array<[SearchField, string | string[]]> = [];
  if (allowed.has("title")) candidates.push(["title", doc.title]);
  if (allowed.has("aliases")) candidates.push(["aliases", doc.aliases]);
  if (allowed.has("tags")) candidates.push(["tags", doc.tags]);
  if (allowed.has("headings")) candidates.push(["headings", doc.headings]);
  if (allowed.has("path")) candidates.push(["path", doc.path]);
  if (allowed.has("body")) candidates.push(["body", doc.body]);
  const queryTokens = queryTerms(query);
  const result: Record<string, string[]> = {};
  for (const [name, value] of candidates) {
    const values = Array.isArray(value) ? value : [value];
    const matches = queryTokens.filter((term) => values.some((item) => normalizeText(item).includes(term)));
    if (matches.length > 0) result[name] = matches;
  }
  return result;
}

function postBoost(query: string, doc: SearchDocument, fields?: SearchField[]): number {
  const allowed = new Set(searchFields(fields));
  const terms = queryTerms(query);
  const phrase = normalizeText(query).replace(/^#/, "");
  let score = 0;
  if (allowed.has("tags") && doc.tags.some((tag) => terms.includes(normalizeText(tag)))) score += 8;
  if (allowed.has("title") && normalizeText(doc.title) === phrase) score += 6;
  if (allowed.has("path") && normalizeText(path.basename(doc.path, path.extname(doc.path))) === phrase) score += 4;
  if (allowed.has("title") && doc.title && normalizeText(doc.title).includes(phrase)) score += 4;
  if (allowed.has("headings") && doc.headings.some((heading) => normalizeText(heading).includes(phrase))) score += 3;
  return score;
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
  const terms = normalizeQueryForOrama(query).match(/[\p{L}\p{N}_/-]+/gu) ?? [];
  return [...new Set(terms.map(normalizeText).filter(Boolean))];
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
  if (right.score !== left.score) return right.score - left.score;
  return left.path.localeCompare(right.path);
}

function compareTagOnlyMatches(left: RankedCandidate, right: RankedCandidate): number {
  return left.path.localeCompare(right.path);
}

function normalizeQueryForOrama(query: string): string {
  return query.replace(/#/g, " ").trim();
}

function textMatchesTerms(value: string, terms: string[]): boolean {
  const normalized = normalizeText(value);
  return terms.some((term) => normalized.includes(term));
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
