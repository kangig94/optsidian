import fs from "node:fs";
import path from "node:path";
import { vaultRealpath, vaultRelative, walkFiles } from "../path.js";
import { analyzerIdentityKey, type SearchAnalyzer, type SearchAnalyzerIdentity } from "./analyzer.js";
import { parseMarkdownNote, type ParsedMarkdownNote, type SearchDocument } from "./markdown.js";
import { decodeUtf8 } from "../text.js";
import { atomicWriteFile } from "../write-file.js";
import { searchFieldTokenTexts } from "./analysis/index.js";
import { SEARCH_ANALYSIS_CACHE_SCHEMA_VERSION } from "./constants.js";
import type {
  AnalysisCache,
  AnalysisCacheEntry,
  BuildDocumentsOptions,
  CachePaths,
  FileManifest,
  SearchTokenFields
} from "./internal-types.js";

export async function buildDocuments(
  vaultRoot: string,
  files: Record<string, FileManifest>,
  relPaths: string[],
  analyzer: SearchAnalyzer,
  analysisCache: AnalysisCache | undefined,
  options: BuildDocumentsOptions = {}
): Promise<SearchDocument[]> {
  const docs: SearchDocument[] = [];
  for (const rel of relPaths.sort((a, b) => a.localeCompare(b))) {
    const doc = await parseDocument(vaultRoot, rel, files[rel], analyzer, analysisCache, options);
    if (doc) docs.push(doc);
  }
  return docs;
}

export function currentFileManifest(vaultRoot: string): Record<string, FileManifest> {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false });
  const manifest: Record<string, FileManifest> = {};
  for (const abs of files) {
    const stat = fs.statSync(abs);
    manifest[vaultRelative(root, abs)] = { mtimeMs: stat.mtimeMs, size: stat.size };
  }
  return manifest;
}

export function readAnalysisCache(paths: CachePaths, analyzer: SearchAnalyzerIdentity): AnalysisCache | undefined {
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

export function writeAnalysisCache(
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
  writeJsonFile(paths.analysisPath, cache);
}

async function parseDocument(
  vaultRoot: string,
  relPath: string,
  manifest: FileManifest | undefined,
  analyzer: SearchAnalyzer,
  analysisCache: AnalysisCache | undefined,
  options: BuildDocumentsOptions = {}
): Promise<SearchDocument | undefined> {
  const abs = path.join(vaultRoot, relPath);
  let note: ParsedMarkdownNote;
  try {
    const text = decodeUtf8(fs.readFileSync(abs), relPath);
    note = parseMarkdownNote(relPath, text);
    const cached = manifest ? cachedTokenFields(analysisCache, relPath, manifest) : undefined;
    if (cached) return { ...note, ...cached };
  } catch {
    return undefined;
  }
  try {
    return await analyzeDocument(note, analyzer);
  } catch (error) {
    if (options.strictAnalyzerErrors) throw error;
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
  const pathField = searchFieldTokenTexts(note.path, pathTokens ?? []);
  const titleField = searchFieldTokenTexts(note.title, titleTokens ?? []);
  const aliasesField = searchFieldTokenTexts(note.aliases.join(" "), aliasesTokens ?? []);
  const tagsField = searchFieldTokenTexts(note.tags.join(" "), tagsTokens ?? []);
  const headingsField = searchFieldTokenTexts(note.headings.join(" "), headingsTokens ?? []);
  const bodyField = searchFieldTokenTexts(note.body, bodyTokens ?? []);
  return {
    ...note,
    pathTokens: pathField.morph,
    titleTokens: titleField.morph,
    aliasesTokens: aliasesField.morph,
    tagsTokens: tagsField.morph,
    headingsTokens: headingsField.morph,
    bodyTokens: bodyField.morph,
    pathSurfaceTokens: pathField.surface,
    titleSurfaceTokens: titleField.surface,
    aliasesSurfaceTokens: aliasesField.surface,
    tagsSurfaceTokens: tagsField.surface,
    headingsSurfaceTokens: headingsField.surface,
    bodySurfaceTokens: bodyField.surface,
    pathNgramTokens: pathField.ngram,
    titleNgramTokens: titleField.ngram,
    aliasesNgramTokens: aliasesField.ngram,
    tagsNgramTokens: tagsField.ngram,
    headingsNgramTokens: headingsField.ngram,
    bodyNgramTokens: bodyField.ngram
  };
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
    bodyTokens: doc.bodyTokens,
    pathSurfaceTokens: doc.pathSurfaceTokens,
    titleSurfaceTokens: doc.titleSurfaceTokens,
    aliasesSurfaceTokens: doc.aliasesSurfaceTokens,
    tagsSurfaceTokens: doc.tagsSurfaceTokens,
    headingsSurfaceTokens: doc.headingsSurfaceTokens,
    bodySurfaceTokens: doc.bodySurfaceTokens,
    pathNgramTokens: doc.pathNgramTokens,
    titleNgramTokens: doc.titleNgramTokens,
    aliasesNgramTokens: doc.aliasesNgramTokens,
    tagsNgramTokens: doc.tagsNgramTokens,
    headingsNgramTokens: doc.headingsNgramTokens,
    bodyNgramTokens: doc.bodyNgramTokens
  };
}

function writeJsonFile(filePath: string, value: unknown): string {
  const raw = `${JSON.stringify(value)}\n`;
  atomicWriteFile(filePath, raw);
  return raw;
}
