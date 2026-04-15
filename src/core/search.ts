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
import type { SearchIndexMutationResult, SearchIndexStatusResult, SearchMatch, SearchParams, SearchResult, SearchSnippet } from "./types.js";
import { assertOptionalPositiveInteger } from "./validation.js";

const SEARCH_SCHEMA_VERSION = 1;
const SEARCH_ENGINE = "orama";
const SEARCH_INDEX_FILE = "search.orama";
const SEARCH_MANIFEST_FILE = "manifest.json";
const SEARCH_PROPERTIES = ["title", "aliases", "tags", "headings", "path", "body"] as const;
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

export async function searchVault(vaultRoot: string, params: SearchParams): Promise<SearchResult> {
  validateSearchParams(params);
  const limit = params.limit ?? 10;
  const pathFilter = params.path ? resolvePathFilter(vaultRoot, params.path) : undefined;
  const loaded = await loadOrBuildIndex(vaultRoot);
  const rawLimit = pathFilter ? Math.max(loaded.manifest.documents, limit) : limit;
  const results = (await oramaSearch(loaded.db, {
    term: normalizeQueryForOrama(params.query),
    properties: [...SEARCH_PROPERTIES],
    boost: SEARCH_BOOST,
    tolerance: 0,
    limit: rawLimit
  })) as Results<SearchDocument>;

  const matches = results.hits
    .map((hit) => rankedMatch(vaultRoot, params.query, hit.document, hit.score))
    .filter((match) => !pathFilter || matchesPathFilter(match.path, pathFilter))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    ok: true,
    command: "search",
    query: params.query,
    count: matches.length,
    index: {
      status: loaded.status,
      documents: loaded.manifest.documents,
      builtAt: loaded.manifest.builtAt
    },
    matches
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

function validateSearchParams(params: SearchParams): void {
  if (!params.query.trim()) {
    throw new UsageError("query must not be empty");
  }
  assertOptionalPositiveInteger(params.limit, "limit");
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

function rankedMatch(vaultRoot: string, query: string, doc: SearchDocument, baseScore: number): SearchMatch {
  const matchedFields = matchedSearchFields(query, doc);
  return {
    path: doc.path,
    score: roundScore(baseScore + postBoost(query, doc)),
    title: doc.title,
    tags: doc.tags,
    matchedFields,
    snippets: snippetsForDocument(vaultRoot, doc.path, query)
  };
}

function matchedSearchFields(query: string, doc: SearchDocument): string[] {
  const fields: Array<[string, string | string[]]> = [
    ["title", doc.title],
    ["aliases", doc.aliases],
    ["tags", doc.tags],
    ["headings", doc.headings],
    ["path", doc.path],
    ["body", doc.body]
  ];
  const queryTokens = queryTerms(query);
  const result: string[] = [];
  for (const [name, value] of fields) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => textMatchesTerms(item, queryTokens))) result.push(name);
  }
  return result;
}

function postBoost(query: string, doc: SearchDocument): number {
  const terms = queryTerms(query);
  const phrase = normalizeText(query).replace(/^#/, "");
  let score = 0;
  if (doc.tags.some((tag) => terms.includes(normalizeText(tag)))) score += 8;
  if (normalizeText(doc.title) === phrase) score += 6;
  if (normalizeText(path.basename(doc.path, path.extname(doc.path))) === phrase) score += 4;
  if (doc.title && normalizeText(doc.title).includes(phrase)) score += 4;
  if (doc.headings.some((heading) => normalizeText(heading).includes(phrase))) score += 3;
  return score;
}

function snippetsForDocument(vaultRoot: string, relPath: string, query: string): SearchSnippet[] {
  try {
    const abs = resolveVaultPath(vaultRoot, relPath, { mustExist: true }).abs;
    const lines = splitText(decodeUtf8(fs.readFileSync(abs), relPath)).lines;
    const terms = queryTerms(query);
    const snippets: SearchSnippet[] = [];
    for (let index = 0; index < lines.length && snippets.length < 3; index += 1) {
      if (textMatchesTerms(lines[index], terms)) snippets.push({ line: index + 1, text: lines[index] });
    }
    if (snippets.length > 0) return snippets;
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line));
    if (headingIndex >= 0) return [{ line: headingIndex + 1, text: lines[headingIndex] }];
    const nonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
    return nonEmptyIndex >= 0 ? [{ line: nonEmptyIndex + 1, text: lines[nonEmptyIndex] }] : [];
  } catch {
    return [];
  }
}

function queryTerms(query: string): string[] {
  const terms = normalizeQueryForOrama(query).match(/[\p{L}\p{N}_/-]+/gu) ?? [];
  return [...new Set(terms.map(normalizeText).filter(Boolean))];
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
