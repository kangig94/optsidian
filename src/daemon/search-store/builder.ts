import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { vaultRelative, vaultRealpath, walkFiles } from "../../core/path.js";
import type { SearchAnalyzer } from "../../core/search/analyzer.js";
import { SEARCH_TOKEN_CHANNELS, searchFieldTokenTexts } from "../../core/search/analysis/index.js";
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
import { SEARCH_ENGINE, SEARCH_FIELD_CHANNEL_INDEX_PROPERTY, SEARCH_PROPERTIES, SEARCH_SCHEMA_DIGEST } from "../../core/search/schema.js";
import { decodeUtf8 } from "../../core/text.js";
import type { SearchField, SearchSnippet } from "../../core/types.js";
import { POSITIONAL_FIELD_ID } from "../../core/search/retrieval/positional/index.js";
import { POSITIONAL_RETRIEVER_IDENTITY } from "../../core/search/retrieval/positional/retriever.js";
import {
  SNAPSHOT_ENVELOPE_SCHEMA_VERSION,
  type BuiltSegment,
  type BuiltSnapshot,
  type PersistedDocumentRecord,
  type SnapshotSnippetLine
} from "./types.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const PARTITION_VERSION = 1;
export const DEFAULT_PARTITION_BITS = 4;
export const INDEX_BUILDER_VERSION = "daemon-positional-builder-b5-v1";
export const INDEX_AFFECTING_SEARCH_SETTINGS_HASH = sha256(canonicalValueBytes({ indexAffectingSettings: {} }));

type BuildInput = {
  vaultRoot: string;
  analyzer: SearchAnalyzer;
  partitionBits?: number;
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
  const documents = await parseVaultDocuments(input.vaultRoot, input.analyzer, partitionBits);
  const partitions = new Map<number, ParsedBuildDocument[]>();
  for (const document of documents) {
    const partition = partitions.get(document.partitionId) ?? [];
    partition.push(document);
    partitions.set(document.partitionId, partition);
  }

  const builtSegments = [...partitions.entries()]
    .sort(([left], [right]) => left - right)
    .map(([partitionId, partitionDocuments]) => buildSegment(partitionId, partitionDocuments));
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
      schemaVersion: SNAPSHOT_ENVELOPE_SCHEMA_VERSION,
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
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fieldSetVersion: SEARCH_SCHEMA_DIGEST,
    partitionVersion: PARTITION_VERSION,
    partitionBits,
    analyzerIdentity: {
      analyzer: analyzerIdentity,
      channels: [...SEARCH_TOKEN_CHANNELS],
      ngram: { min: MIN_NGRAM, max: MAX_NGRAM },
      identityNormalizer: "identityPhraseCandidates-v1"
    },
    searchSettingsHash: INDEX_AFFECTING_SEARCH_SETTINGS_HASH,
    indexBuilderVersion: sha256(canonicalValueBytes({ engine: SEARCH_ENGINE, builder: INDEX_BUILDER_VERSION })),
    rankingFeatureVersion: sha256(canonicalValueBytes(RANKING_CONSTANTS)),
    retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY
  };
}

async function parseVaultDocuments(vaultRoot: string, analyzer: SearchAnalyzer, partitionBits: number): Promise<ParsedBuildDocument[]> {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false })
    .map((abs) => vaultRelative(root, abs))
    .sort((left, right) => compareUtf8(left, right));
  const documents: ParsedBuildDocument[] = [];
  for (const rel of files) {
    const parsed = await parseBuildDocument(root, rel, analyzer, partitionBits);
    if (parsed) documents.push(parsed);
  }
  return documents.sort((left, right) => compareUtf8(left.documentId, right.documentId));
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
  const tokenized = await analyzer.tokenizeBatch([
    note.path,
    note.title,
    note.aliases.join(" "),
    note.tags.join(" "),
    note.headings.join(" "),
    note.body,
    ...lineSpans.map((line) => line.text)
  ]);
  const fields = {
    path: searchFieldTokenTexts(note.path, tokenized[0] ?? []),
    title: searchFieldTokenTexts(note.title, tokenized[1] ?? []),
    aliases: searchFieldTokenTexts(note.aliases.join(" "), tokenized[2] ?? []),
    tags: searchFieldTokenTexts(note.tags.join(" "), tokenized[3] ?? []),
    headings: searchFieldTokenTexts(note.headings.join(" "), tokenized[4] ?? []),
    body: searchFieldTokenTexts(note.body, tokenized[5] ?? [])
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
      body: normalizeTokenSequence(tokenized[5] ?? [])
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
    snippetLines: lineSnippetEntries(documentId, lineSpans, tokenized.slice(6))
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
  lines: readonly LineSpanEntry[],
  tokenizedLines: readonly string[][]
): Omit<SnapshotSnippetLine, "segmentId">[] {
  return lines.map((line, index) => {
    const channels = searchFieldTokenTexts(line.text, tokenizedLines[index] ?? []);
    return {
      snippetId: `${documentId}:${line.line}`,
      documentId,
      line: line.line,
      text: line.text,
      byteStart: line.byteStart,
      byteEnd: line.byteEnd,
      channels: {
        morph: channelTerms(channels.morph),
        surface: channelTerms(channels.surface),
        ngram: channelTerms(channels.ngram)
      }
    };
  });
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
