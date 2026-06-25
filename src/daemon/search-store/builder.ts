import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { vaultRelative, vaultRealpath, walkFiles } from "../../core/path.js";
import type { SearchAnalyzer } from "../../core/search/analyzer.js";
import {
  BODY_INDEX_BUDGET_IDENTITY,
  SEARCH_TOKEN_CHANNELS,
  SNIPPET_LINE_MORPH_MAX_TERMS,
  SNIPPET_LINE_NGRAM_MAX_TERMS,
  SNIPPET_LINE_SURFACE_MAX_TERMS,
  bodyIndexBudgetForText,
  searchFieldTokenTexts,
  type BodyIndexBudget
} from "../../core/search/analysis/index.js";
import { MIN_NGRAM, MAX_NGRAM } from "../../core/search/analysis/korean.js";
import { RANKING_CONSTANTS } from "../../core/search/constants.js";
import { parseMarkdownNote, type SearchDocument } from "../../core/search/markdown.js";
import {
  canonicalSegmentHash,
  canonicalSnapshotManifestBytes,
  canonicalValueBytes,
  encodeCanonicalSegment,
  partitionIdForDocument,
  type CanonicalDocumentRecord,
  type CanonicalFieldText,
  type CanonicalPartitionDescriptor,
  type CanonicalPosting,
  type CanonicalSegment,
  type SnapshotIdentityTuple
} from "../../core/search/segments/index.js";
import { SEARCH_FIELD_CHANNEL_INDEX_PROPERTY, SEARCH_PROPERTIES, SEARCH_SCHEMA_DIGEST } from "../../core/search/schema.js";
import { decodeUtf8 } from "../../core/text.js";
import type { SearchField, SearchSnippet } from "../../core/types.js";
import { POSITIONAL_FIELD_ID } from "../../core/search/retrieval/positional/index.js";
import { POSITIONAL_RETRIEVER_IDENTITY } from "../../core/search/retrieval/positional/retriever.js";
import type { SearchIndexProgressUpdate } from "../protocol.js";
import {
  SNAPSHOT_PERSISTENCE_VERSION,
  type BuiltSegment,
  type BuiltSnapshot,
  type PersistedDocumentRecord,
  type SnapshotSnippetLine
} from "./types.js";

export const DEFAULT_PARTITION_BITS = 4;

// INDEX_BUILD_VERSION — the single manual lever for index identity (domain A).
// It folds the snapshot-tuple shape, the partition scheme, the segment-encoding
// builder, the engine family, and the identity-phrase normalizer into one knob.
// Bump it when any of those change in a way the auto-derived digests
// (fieldSetVersion = sha256(schema), rankingFeatureVersion = sha256(RANKING_CONSTANTS))
// do not already capture. NEVER derive it from the binary hash: index identity is
// deliberately decoupled from the build so unrelated code changes don't force a reindex.
export const INDEX_BUILD_VERSION = "daemon-positional-build-v2";

// No index-affecting search settings exist yet; the empty object makes that explicit.
// When one is added, put it here and the hash — the shared invalidation key between
// the snapshot identity and the query-analysis cache — falls out automatically.
const INDEX_AFFECTING_SETTINGS = {} as const;
export const INDEX_AFFECTING_SEARCH_SETTINGS_HASH = sha256(canonicalValueBytes({ indexAffectingSettings: INDEX_AFFECTING_SETTINGS }));

type BuildInput = {
  vaultRoot: string;
  analyzer: SearchAnalyzer;
  partitionBits?: number;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

type ParsedBuildDocument = {
  documentId: string;
  path: string;
  contentHash: string;
  searchDocument: SearchDocument;
  positionTokens: Record<"morph" | "surface" | "ngram", Record<SearchField, readonly string[]>>;
  canonicalRecord: CanonicalDocumentRecord;
  lineSnippets: SearchSnippet[];
  snippetLines: Omit<SnapshotSnippetLine, "segmentId">[];
  partitionId: number;
};

export async function buildCanonicalSearchSnapshot(input: BuildInput): Promise<BuiltSnapshot> {
  const partitionBits = input.partitionBits ?? DEFAULT_PARTITION_BITS;
  const identityTuple = snapshotIdentityTuple(input.analyzer, partitionBits);
  input.progress?.({ phase: "scanning", completed: 0 });
  const documents = await parseVaultDocuments(input.vaultRoot, input.analyzer, partitionBits, input.progress);
  const partitions = new Map<number, ParsedBuildDocument[]>();
  for (const document of documents) {
    const partition = partitions.get(document.partitionId) ?? [];
    partition.push(document);
    partitions.set(document.partitionId, partition);
  }

  const partitionEntries = [...partitions.entries()].sort(([left], [right]) => left - right);
  const builtSegments: BuiltSegment[] = [];
  input.progress?.({ phase: "segmenting", total: partitionEntries.length, completed: 0 });
  for (const [index, [partitionId, partitionDocuments]] of partitionEntries.entries()) {
    builtSegments.push(buildSegment(partitionId, partitionDocuments));
    input.progress?.({
      phase: "segmenting",
      total: partitionEntries.length,
      completed: index + 1,
      current: String(partitionId)
    });
  }
  const liveRecords = documents.map((document) => ({
    documentId: document.documentId,
    path: document.path,
    contentHash: document.contentHash,
    parsedFieldHashes: document.canonicalRecord.parsedFieldHashes,
    snippetLineSpanHash: document.canonicalRecord.snippetLineSpanHash,
    deleted: false
  }));
  const manifest = {
    identityTuple,
    liveDocumentManifestHash: sha256(canonicalValueBytes(liveRecords)),
    tombstoneHash: sha256(canonicalValueBytes([])),
    partitions: builtSegments.map((segment): CanonicalPartitionDescriptor => ({
      partitionId: segment.partitionId,
      documentIdStart: segment.documentIds[0] ?? "",
      documentIdEnd: segment.documentIds[segment.documentIds.length - 1] ?? "",
      segmentHash: segment.hash,
      documentCount: segment.documentIds.length,
      byteLength: segment.bytes.length
    }))
  };
  const canonicalManifestBytes = canonicalSnapshotManifestBytes(manifest);
  const snapshotId = sha256(canonicalManifestBytes);
  const segmentByDocumentId = new Map<string, string>();
  for (const segment of builtSegments) {
    for (const documentId of segment.documentIds) segmentByDocumentId.set(documentId, segment.hash);
  }
  const persistedDocuments: PersistedDocumentRecord[] = documents.map((document) => ({
    documentId: document.documentId,
    path: document.path,
    contentHash: document.contentHash,
    partitionId: document.partitionId,
    searchDocument: document.searchDocument,
    lineSnippets: document.lineSnippets,
    snippetLines: document.snippetLines.map((line) => ({
      ...line,
      segmentId: segmentByDocumentId.get(document.documentId) ?? ""
    }))
  }));

  return {
    snapshotId,
    identityTuple,
    manifest,
    canonicalManifestBytes,
    canonicalManifestSha256: snapshotId,
    segments: builtSegments,
    diagnostics: {
      schemaVersion: SNAPSHOT_PERSISTENCE_VERSION,
      analyzer: input.analyzer.identity,
      documents: persistedDocuments
    }
  };
}

export function snapshotIdentityTuple(analyzer: SearchAnalyzer, partitionBits = DEFAULT_PARTITION_BITS): SnapshotIdentityTuple {
  return snapshotIdentityTupleForAnalyzerIdentity(analyzer.identity, partitionBits);
}

export function snapshotIdentityTupleForAnalyzerIdentity(
  analyzerIdentity: SearchAnalyzer["identity"],
  partitionBits = DEFAULT_PARTITION_BITS
): SnapshotIdentityTuple {
  return {
    buildVersion: INDEX_BUILD_VERSION,
    fieldSetVersion: SEARCH_SCHEMA_DIGEST,
    partitionBits,
    analyzerIdentity: {
      analyzer: analyzerIdentity,
      channels: [...SEARCH_TOKEN_CHANNELS],
      ngram: { min: MIN_NGRAM, max: MAX_NGRAM, bodyBudget: BODY_INDEX_BUDGET_IDENTITY }
    },
    searchSettingsHash: INDEX_AFFECTING_SEARCH_SETTINGS_HASH,
    rankingFeatureVersion: sha256(canonicalValueBytes(RANKING_CONSTANTS)),
    retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY
  };
}

async function parseVaultDocuments(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  partitionBits: number,
  progress?: (progress: SearchIndexProgressUpdate) => void
): Promise<ParsedBuildDocument[]> {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false })
    .map((abs) => vaultRelative(root, abs))
    .sort((left, right) => compareUtf8(left, right));
  progress?.({ phase: "parsing", total: files.length, completed: 0 });
  const documents: ParsedBuildDocument[] = [];
  const interval = progressInterval(files.length);
  for (const [index, rel] of files.entries()) {
    const parsed = await parseBuildDocument(root, rel, analyzer, partitionBits);
    if (parsed) documents.push(parsed);
    const completed = index + 1;
    if (completed === files.length || completed % interval === 0) {
      progress?.({
        phase: "parsing",
        total: files.length,
        completed,
        current: rel,
        message: `${documents.length} indexed`
      });
    }
  }
  return documents.sort((left, right) => compareUtf8(left.documentId, right.documentId));
}

function progressInterval(total: number): number {
  if (total <= 200) return 1;
  return Math.max(1, Math.floor(total / 100));
}

async function parseBuildDocument(
  vaultRoot: string,
  relPath: string,
  analyzer: SearchAnalyzer,
  partitionBits: number
): Promise<ParsedBuildDocument | undefined> {
  const abs = path.join(vaultRoot, relPath);
  let bytes: Buffer;
  let text: string;
  try {
    bytes = fs.readFileSync(abs);
    text = decodeUtf8(bytes, relPath);
  } catch {
    return undefined;
  }
  const note = parseMarkdownNote(relPath, text);
  const lineSpans = lineSpanEntries(text);
  const bodyBudget = bodyIndexBudgetForText(note.body);
  const snippetLineInputs = snippetLineAnalysisInputs(lineSpans, bodyBudget);
  const tokenized = await analyzer.tokenizeBatch([
    note.path,
    note.title,
    note.aliases.join(" "),
    note.tags.join(" "),
    note.headings.join(" "),
    bodyBudget.bodyLexicalText,
    ...snippetLineInputs.map((line) => line.analysisText)
  ]);
  const bodyMorphTokens = normalizeTokenSequence(tokenized[5] ?? []).slice(0, bodyBudget.bodyMorphMaxTokens);
  const fields = {
    path: searchFieldTokenTexts(note.path, tokenized[0] ?? []),
    title: searchFieldTokenTexts(note.title, tokenized[1] ?? []),
    aliases: searchFieldTokenTexts(note.aliases.join(" "), tokenized[2] ?? []),
    tags: searchFieldTokenTexts(note.tags.join(" "), tokenized[3] ?? []),
    headings: searchFieldTokenTexts(note.headings.join(" "), tokenized[4] ?? []),
    body: searchFieldTokenTexts(bodyBudget.bodyLexicalText, bodyMorphTokens, {
      morphMaxTerms: bodyBudget.bodyMorphMaxTokens,
      surfaceMaxTerms: bodyBudget.bodySurfaceMaxTerms,
      ngramMaxTerms: bodyBudget.bodyNgramMaxTerms,
      ngramRaw: bodyBudget.bodyNgramText
    })
  };
  const searchDocument: SearchDocument = {
    ...note,
    pathTokens: fields.path.morph,
    titleTokens: fields.title.morph,
    aliasesTokens: fields.aliases.morph,
    tagsTokens: fields.tags.morph,
    headingsTokens: fields.headings.morph,
    bodyTokens: fields.body.morph,
    pathSurfaceTokens: fields.path.surface,
    titleSurfaceTokens: fields.title.surface,
    aliasesSurfaceTokens: fields.aliases.surface,
    tagsSurfaceTokens: fields.tags.surface,
    headingsSurfaceTokens: fields.headings.surface,
    bodySurfaceTokens: fields.body.surface,
    pathNgramTokens: fields.path.ngram,
    titleNgramTokens: fields.title.ngram,
    aliasesNgramTokens: fields.aliases.ngram,
    tagsNgramTokens: fields.tags.ngram,
    headingsNgramTokens: fields.headings.ngram,
    bodyNgramTokens: fields.body.ngram
  };
  const positionTokens = {
    morph: {
      path: normalizeTokenSequence(tokenized[0] ?? []),
      title: normalizeTokenSequence(tokenized[1] ?? []),
      aliases: normalizeTokenSequence(tokenized[2] ?? []),
      tags: normalizeTokenSequence(tokenized[3] ?? []),
      headings: normalizeTokenSequence(tokenized[4] ?? []),
      body: bodyMorphTokens
    },
    surface: channelPositionTokens(searchDocument, "surface"),
    ngram: channelPositionTokens(searchDocument, "ngram")
  };
  const normalizedPath = normalizeVaultRelativePath(relPath);
  const documentId = sha256(utf8(normalizedPath));
  const partitionId = partitionIdForDocument(documentId, partitionBits);
  const canonicalRecord: CanonicalDocumentRecord = {
    documentId,
    path: normalizedPath,
    contentHash: sha256(bytes),
    parsedFieldHashes: parsedFieldHashes(searchDocument),
    snippetLineSpanHash: sha256(utf8(lineSpanSource(text))),
    deleted: false
  };
  return {
    documentId,
    path: normalizedPath,
    contentHash: canonicalRecord.contentHash,
    searchDocument,
    positionTokens,
    canonicalRecord,
    partitionId,
    lineSnippets: lineSpans.map((line) => ({ line: line.line, text: line.text })),
    snippetLines: lineSnippetEntries(documentId, snippetLineInputs, tokenized.slice(6))
  };
}

function buildSegment(partitionId: number, documents: readonly ParsedBuildDocument[]): BuiltSegment {
  const sorted = [...documents].sort((left, right) => compareUtf8(left.documentId, right.documentId));
  const postings: CanonicalPosting[] = [];
  const canonicalDocuments: CanonicalDocumentRecord[] = [];
  const fieldTexts: CanonicalFieldText[] = [];
  sorted.forEach((document, index) => {
    const docId = index + 1;
    canonicalDocuments.push(document.canonicalRecord);
    for (const field of SEARCH_PROPERTIES) {
      fieldTexts.push({
        docId,
        fieldId: POSITIONAL_FIELD_ID[field],
        text: canonicalFieldText(document.searchDocument, field)
      });
    }
    for (const channel of SEARCH_TOKEN_CHANNELS) {
      for (const field of SEARCH_PROPERTIES) {
        const fieldId = POSITIONAL_FIELD_ID[field];
        const tokens = document.positionTokens[channel][field];
        const positionsByTerm = new Map<string, number[]>();
        tokens.forEach((token, position) => {
          const normalized = token.normalize("NFC").trim();
          if (!normalized) return;
          const positions = positionsByTerm.get(normalized) ?? [];
          positions.push(position);
          positionsByTerm.set(normalized, positions);
        });
        for (const [term, positions] of positionsByTerm) {
          postings.push({
            term: `${channel}\u0000${term}`,
            fieldId,
            docId,
            positions
          });
        }
      }
    }
  });
  const segment: CanonicalSegment = {
    postings,
    documents: canonicalDocuments,
    fieldTexts
  };
  const bytes = encodeCanonicalSegment(segment);
  return {
    partitionId,
    hash: canonicalSegmentHash(bytes),
    bytes,
    documentIds: sorted.map((document) => document.documentId)
  };
}

function parsedFieldHashes(document: SearchDocument): Record<string, string> {
  return Object.fromEntries(
    SEARCH_PROPERTIES.map((field) => [field, sha256(utf8(canonicalFieldText(document, field)))])
  );
}

function canonicalFieldText(document: SearchDocument, field: SearchField): string {
  if (field === "path") return document.path;
  if (field === "title") return document.title;
  if (field === "aliases") return document.aliases.join("\n");
  if (field === "tags") return document.tags.join("\n");
  if (field === "headings") return document.headings.join("\n");
  return document.body;
}

function tokenText(document: SearchDocument, channel: "surface" | "ngram", field: SearchField): string[] {
  const value = document[SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]];
  return typeof value === "string" ? value.split(" ").filter(Boolean) : [];
}

function channelPositionTokens(document: SearchDocument, channel: "surface" | "ngram"): Record<SearchField, readonly string[]> {
  const output = {} as Record<SearchField, readonly string[]>;
  for (const field of SEARCH_PROPERTIES) output[field] = tokenText(document, channel, field);
  return output;
}

function normalizeTokenSequence(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.normalize("NFC").trim()).filter(Boolean);
}

type LineSpanEntry = SearchSnippet & {
  byteStart: number;
  byteEnd: number;
};

type SnippetLineAnalysisInput = {
  source: LineSpanEntry;
  analysisText: string;
};

function lineSpanEntries(content: string): LineSpanEntry[] {
  const parts = content.split(/(\r?\n)/u);
  const lines: LineSpanEntry[] = [];
  let line = 1;
  let byteOffset = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? "";
    const newline = parts[index + 1] ?? "";
    if (index === parts.length - 1 && text === "" && newline === "") continue;
    const byteStart = byteOffset;
    const byteEnd = byteStart + utf8(text).length;
    lines.push({ line, text, byteStart, byteEnd });
    byteOffset = byteEnd + utf8(newline).length;
    line += 1;
  }
  if (lines.length === 0) lines.push({ line: 1, text: "", byteStart: 0, byteEnd: 0 });
  return lines;
}

function lineSnippetEntries(
  documentId: string,
  lines: readonly SnippetLineAnalysisInput[],
  tokenizedLines: readonly string[][]
): Omit<SnapshotSnippetLine, "segmentId">[] {
  return lines.map((line, index) => {
    const morphTokens = normalizeTokenSequence(tokenizedLines[index] ?? []).slice(0, SNIPPET_LINE_MORPH_MAX_TERMS);
    const channels = searchFieldTokenTexts(line.analysisText, morphTokens, {
      morphMaxTerms: SNIPPET_LINE_MORPH_MAX_TERMS,
      surfaceMaxTerms: SNIPPET_LINE_SURFACE_MAX_TERMS,
      ngramMaxTerms: SNIPPET_LINE_NGRAM_MAX_TERMS
    });
    return {
      snippetId: `${documentId}:${line.source.line}`,
      documentId,
      line: line.source.line,
      text: line.source.text,
      byteStart: line.source.byteStart,
      byteEnd: line.source.byteEnd,
      channels: {
        morph: channelTerms(channels.morph),
        surface: channelTerms(channels.surface),
        ngram: channelTerms(channels.ngram)
      }
    };
  });
}

function snippetLineAnalysisInputs(
  lines: readonly LineSpanEntry[],
  budget: BodyIndexBudget
): SnippetLineAnalysisInput[] {
  const maxLines = budget.snippetDocMaxAnalyzedLines ?? lines.length;
  const initialSelected = lines.length <= maxLines ? lines.map((_, index) => index) : evenSampledIndices(lines.length, maxLines);
  const maxChars = budget.snippetDocMaxAnalyzedChars ?? Number.POSITIVE_INFINITY;
  const selected = fitSnippetLineIndicesToCharBudget(
    lines,
    initialSelected,
    maxChars,
    budget.snippetLineAnalysisMaxChars
  );
  const output: SnippetLineAnalysisInput[] = [];
  let usedChars = 0;
  for (const index of selected) {
    const line = lines[index];
    if (!line) continue;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    const analysisText = line.text.slice(0, Math.min(budget.snippetLineAnalysisMaxChars, remaining));
    usedChars += analysisText.length;
    output.push({ source: line, analysisText });
  }
  return output;
}

function fitSnippetLineIndicesToCharBudget(
  lines: readonly LineSpanEntry[],
  selected: readonly number[],
  maxChars: number,
  maxLineChars: number
): number[] {
  if (!Number.isFinite(maxChars)) return [...selected];
  const safeMaxChars = Math.max(0, Math.trunc(maxChars));
  if (safeMaxChars === 0) return [];
  let limit = selected.length;
  let output = [...selected];
  let total = snippetAnalysisCharTotal(lines, output, maxLineChars);
  while (limit > 1 && total > safeMaxChars) {
    const nextLimit = Math.max(1, Math.min(limit - 1, Math.floor((limit * safeMaxChars) / Math.max(total, 1))));
    output = evenSampledIndices(lines.length, nextLimit);
    limit = output.length;
    total = snippetAnalysisCharTotal(lines, output, maxLineChars);
  }
  return output;
}

function snippetAnalysisCharTotal(lines: readonly LineSpanEntry[], indices: readonly number[], maxLineChars: number): number {
  const lineLimit = Number.isFinite(maxLineChars) ? Math.max(0, Math.trunc(maxLineChars)) : Number.POSITIVE_INFINITY;
  return indices.reduce((sum, index) => sum + Math.min(lines[index]?.text.length ?? 0, lineLimit), 0);
}

function evenSampledIndices(length: number, maxCount: number): number[] {
  const limit = Number.isFinite(maxCount) ? Math.max(0, Math.trunc(maxCount)) : length;
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  if (limit === 0) return [];
  if (limit === 1) return [0];
  const indices = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    indices.add(Math.round(((length - 1) * index) / (limit - 1)));
  }
  return [...indices].sort((left, right) => left - right);
}

function channelTerms(value: string): string[] {
  return value.split(" ").map((term) => term.trim()).filter(Boolean);
}

function lineSpanSource(content: string): string {
  return content.split(/\r?\n/u).map((line, index) => `${index + 1}:${utf8(line).length}`).join("\n");
}

function normalizeVaultRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part.normalize("NFC"));
  }
  return parts.join("/");
}

function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value.normalize("NFC"));
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
