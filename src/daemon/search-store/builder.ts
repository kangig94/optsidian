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
  type BodyIndexBudget,
  type SearchTokenChannel
} from "../../core/search/analysis/index.js";
import { MIN_NGRAM, MAX_NGRAM } from "../../core/search/analysis/korean.js";
import { RANKING_CONSTANTS, SEARCH_SCORING_LAMBDAS } from "../../core/search/constants.js";
import {
  INDEX_AFFECTING_SEARCH_SETTINGS_HASH,
  indexAffectingSearchSettingsHash,
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../../core/search/index-settings.js";
import { parseMarkdownNote, type SearchDocument } from "../../core/search/markdown.js";
import {
  CANONICAL_BM25_STATS_SCHEMA_ID,
  CANONICAL_DOC_PROJECTION_SCHEMA_ID,
  CANONICAL_SEGMENT_SECTION,
  CANONICAL_SEGMENT_VERSION,
  CANONICAL_TERM_DICTIONARY_SCHEMA_ID,
  CANONICAL_VECTOR_BLOCK_SCHEMA_ID,
  canonicalSegmentHash,
  canonicalSnapshotManifestBytes,
  canonicalValueBytes,
  encodeCanonicalSegment,
  partitionIdForDocument,
  reduceCanonicalBm25GlobalStats,
  type CanonicalBm25FieldStats,
  type CanonicalDocumentRecord,
  type CanonicalFieldText,
  type CanonicalPartitionDescriptor,
  type CanonicalPosting,
  type CanonicalSegment,
  type SearchModelIdentity,
  type SearchSnapshotAnalyzerIdentity,
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
  type ParsedBuildDocument,
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
export const INDEX_BUILD_VERSION = "daemon-positional-build-v5";
export { INDEX_AFFECTING_SEARCH_SETTINGS_HASH, indexAffectingSearchSettingsHash };

type BuildInput = {
  vaultRoot: string;
  analyzer: SearchAnalyzer;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  partitionBits?: number;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type BuildDocumentScan = {
  root: string;
  files: readonly string[];
};

export type ParseBuildDocumentBatchInput = {
  vaultRoot: string;
  relPaths: readonly string[];
  partitionBits: number;
  searchSettings: IndexAffectingSearchSettings;
};

export type ParseBuildDocumentBatchResult = {
  analyzerIdentity: SearchAnalyzer["identity"];
  documents: ParsedBuildDocument[];
};

export type ReduceBuildSegmentInput = {
  partitionId: number;
  documents: readonly ParsedBuildDocument[];
};

export type BuildSnapshotFromSegmentsInput = {
  analyzerIdentity: SearchAnalyzer["identity"];
  partitionBits?: number;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  documents: readonly ParsedBuildDocument[];
  segments: readonly BuiltSegment[];
};

export async function buildCanonicalSearchSnapshot(input: BuildInput): Promise<BuiltSnapshot> {
  const partitionBits = input.partitionBits ?? DEFAULT_PARTITION_BITS;
  const searchSettings = normalizeIndexAffectingSearchSettings(input.searchSettings);
  input.progress?.({ phase: "scanning", completed: 0 });
  const scan = scanBuildDocuments(input.vaultRoot);
  const documents = await parseVaultDocuments(scan, input.analyzer, partitionBits, searchSettings, input.progress);
  const partitionEntries = shuffleParsedBuildDocumentsByPartition(documents);
  const builtSegments = reduceBuildSegments(partitionEntries, input.progress);
  return buildCanonicalSearchSnapshotFromSegments({
    analyzerIdentity: input.analyzer.identity,
    partitionBits,
    searchSettings,
    documents,
    segments: builtSegments
  });
}

export function buildCanonicalSearchSnapshotFromSegments(input: BuildSnapshotFromSegmentsInput): BuiltSnapshot {
  const partitionBits = input.partitionBits ?? DEFAULT_PARTITION_BITS;
  const searchSettings = normalizeIndexAffectingSearchSettings(input.searchSettings);
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity(input.analyzerIdentity, partitionBits, searchSettings);
  const documents = input.documents;
  const builtSegments = input.segments;
  assertParsedDocumentsSortedByDocumentId(documents);
  assertBuiltSegmentsSortedByPartitionId(builtSegments);
  const bm25GlobalStats = reduceBuiltSegmentBm25Stats(builtSegments);
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
    bm25StatsSchemaId: bm25GlobalStats.bm25StatsSchemaId,
    corpusStats: bm25GlobalStats.corpusStats,
    bm25GlobalStatsRows: bm25GlobalStats.bm25GlobalStatsRows,
    bm25GlobalStatsHash: bm25GlobalStats.bm25GlobalStatsHash,
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
      analyzer: input.analyzerIdentity,
      documents: persistedDocuments
    }
  };
}

export function snapshotIdentityTuple(
  analyzer: SearchAnalyzer,
  partitionBits = DEFAULT_PARTITION_BITS,
  searchSettings?: Partial<IndexAffectingSearchSettings>
): SnapshotIdentityTuple {
  return snapshotIdentityTupleForAnalyzerIdentity(analyzer.identity, partitionBits, searchSettings);
}

export function snapshotIdentityTupleForAnalyzerIdentity(
  analyzerIdentity: SearchAnalyzer["identity"],
  partitionBits = DEFAULT_PARTITION_BITS,
  searchSettings?: Partial<IndexAffectingSearchSettings>
): SnapshotIdentityTuple {
  const normalizedSearchSettings = normalizeIndexAffectingSearchSettings(searchSettings);
  const snapshotAnalyzerIdentity = snapshotAnalyzerIdentityFor(analyzerIdentity, normalizedSearchSettings);
  const rankingFeatureVersion = sha256(canonicalValueBytes(RANKING_CONSTANTS));
  return {
    buildVersion: INDEX_BUILD_VERSION,
    fieldSetVersion: SEARCH_SCHEMA_DIGEST,
    partitionBits,
    analyzerIdentity: snapshotAnalyzerIdentity,
    searchSettingsHash: indexAffectingSearchSettingsHash(normalizedSearchSettings),
    rankingFeatureVersion,
    searchModelIdentity: searchModelIdentity(snapshotAnalyzerIdentity, rankingFeatureVersion)
  };
}

function snapshotAnalyzerIdentityFor(
  analyzerIdentity: SearchAnalyzer["identity"],
  searchSettings: IndexAffectingSearchSettings
): SearchSnapshotAnalyzerIdentity {
  return {
    analyzer: analyzerIdentity,
    channels: [...SEARCH_TOKEN_CHANNELS],
    ngram: {
      enabled: searchSettings.ngram,
      min: MIN_NGRAM,
      max: MAX_NGRAM,
      bodyBudget: BODY_INDEX_BUDGET_IDENTITY
    }
  };
}

function searchModelIdentity(
  analyzerIdentity: SearchSnapshotAnalyzerIdentity,
  rankingFeatureVersion: string
): SearchModelIdentity {
  return {
    schemaVersion: 1,
    analyzerIdentity,
    segmentSchema: {
      format: "canonical-segment",
      version: CANONICAL_SEGMENT_VERSION,
      sections: [
        { name: "postings", id: CANONICAL_SEGMENT_SECTION.postings },
        { name: "documents", id: CANONICAL_SEGMENT_SECTION.documents },
        { name: "fieldTexts", id: CANONICAL_SEGMENT_SECTION.fieldTexts },
        { name: "bm25", id: CANONICAL_SEGMENT_SECTION.bm25, schemaId: CANONICAL_BM25_STATS_SCHEMA_ID },
        { name: "docProjection", id: CANONICAL_SEGMENT_SECTION.docProjection, schemaId: CANONICAL_DOC_PROJECTION_SCHEMA_ID },
        { name: "termDictionary", id: CANONICAL_SEGMENT_SECTION.termDictionary, schemaId: CANONICAL_TERM_DICTIONARY_SCHEMA_ID },
        {
          name: "vectorBlock",
          id: CANONICAL_SEGMENT_SECTION.vectorBlock,
          schemaId: CANONICAL_VECTOR_BLOCK_SCHEMA_ID,
          reserved: true
        }
      ]
    },
    corpusStatsSchema: {
      id: "bm25-global-stats",
      schemaId: CANONICAL_BM25_STATS_SCHEMA_ID
    },
    scoringModel: {
      id: "unified-scalar-ac4-v1",
      rankingFeatureVersion,
      retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
      weights: {
        lambdas: {
          phrase: SEARCH_SCORING_LAMBDAS.phrase,
          exact: SEARCH_SCORING_LAMBDAS.exact,
          dense: SEARCH_SCORING_LAMBDAS.dense
        }
      }
    },
    embeddingModel: analyzerIdentity.analyzer.embeddingModel ?? null
  };
}

export function scanBuildDocuments(vaultRoot: string): BuildDocumentScan {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false })
    .map((abs) => vaultRelative(root, abs))
    .sort((left, right) => compareUtf8(left, right));
  return { root, files };
}

async function parseVaultDocuments(
  scan: BuildDocumentScan,
  analyzer: SearchAnalyzer,
  partitionBits: number,
  searchSettings: IndexAffectingSearchSettings,
  progress?: (progress: SearchIndexProgressUpdate) => void
): Promise<ParsedBuildDocument[]> {
  const { root, files } = scan;
  progress?.({ phase: "parsing", total: files.length, completed: 0 });
  const documents: ParsedBuildDocument[] = [];
  const interval = progressInterval(files.length);
  for (const [index, rel] of files.entries()) {
    const parsed = await parseBuildDocument(root, rel, analyzer, partitionBits, searchSettings);
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
  return sortParsedBuildDocuments(documents);
}

export async function parseBuildDocumentBatch(
  input: ParseBuildDocumentBatchInput,
  analyzer: SearchAnalyzer
): Promise<ParseBuildDocumentBatchResult> {
  const documents: ParsedBuildDocument[] = [];
  for (const relPath of input.relPaths) {
    const parsed = await parseBuildDocument(input.vaultRoot, relPath, analyzer, input.partitionBits, input.searchSettings);
    if (parsed) documents.push(parsed);
  }
  return {
    analyzerIdentity: analyzer.identity,
    documents
  };
}

export function sortParsedBuildDocuments(documents: readonly ParsedBuildDocument[]): ParsedBuildDocument[] {
  const sorted = [...documents].sort((left, right) => compareUtf8(left.documentId, right.documentId));
  assertParsedDocumentsSortedByDocumentId(sorted);
  return sorted;
}

export function shuffleParsedBuildDocumentsByPartition(
  documents: readonly ParsedBuildDocument[]
): Array<readonly [partitionId: number, documents: readonly ParsedBuildDocument[]]> {
  assertParsedDocumentsSortedByDocumentId(documents);
  const partitions = new Map<number, ParsedBuildDocument[]>();
  for (const document of documents) {
    const partition = partitions.get(document.partitionId) ?? [];
    partition.push(document);
    partitions.set(document.partitionId, partition);
  }
  return [...partitions.entries()].sort(([left], [right]) => left - right);
}

export function reduceBuildSegment(input: ReduceBuildSegmentInput): BuiltSegment {
  return buildSegment(input.partitionId, input.documents);
}

function reduceBuildSegments(
  partitionEntries: readonly (readonly [partitionId: number, documents: readonly ParsedBuildDocument[]])[],
  progress?: (progress: SearchIndexProgressUpdate) => void
): BuiltSegment[] {
  const builtSegments: BuiltSegment[] = [];
  progress?.({ phase: "segmenting", total: partitionEntries.length, completed: 0 });
  for (const [index, [partitionId, partitionDocuments]] of partitionEntries.entries()) {
    builtSegments.push(buildSegment(partitionId, partitionDocuments));
    progress?.({
      phase: "segmenting",
      total: partitionEntries.length,
      completed: index + 1,
      current: String(partitionId)
    });
  }
  assertBuiltSegmentsSortedByPartitionId(builtSegments);
  return builtSegments;
}

function progressInterval(total: number): number {
  if (total <= 200) return 1;
  return Math.max(1, Math.floor(total / 100));
}

async function parseBuildDocument(
  vaultRoot: string,
  relPath: string,
  analyzer: SearchAnalyzer,
  partitionBits: number,
  searchSettings: IndexAffectingSearchSettings
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
    path: searchFieldTokenTexts(note.path, tokenized[0] ?? [], { ngram: searchSettings.ngram }),
    title: searchFieldTokenTexts(note.title, tokenized[1] ?? [], { ngram: searchSettings.ngram }),
    aliases: searchFieldTokenTexts(note.aliases.join(" "), tokenized[2] ?? [], { ngram: searchSettings.ngram }),
    tags: searchFieldTokenTexts(note.tags.join(" "), tokenized[3] ?? [], { ngram: searchSettings.ngram }),
    headings: searchFieldTokenTexts(note.headings.join(" "), tokenized[4] ?? [], { ngram: searchSettings.ngram }),
    body: searchFieldTokenTexts(bodyBudget.bodyLexicalText, bodyMorphTokens, {
      morphMaxTerms: bodyBudget.bodyMorphMaxTokens,
      surfaceMaxTerms: bodyBudget.bodySurfaceMaxTerms,
      ngram: searchSettings.ngram,
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
    snippetLines: lineSnippetEntries(documentId, snippetLineInputs, tokenized.slice(6), searchSettings)
  };
}

function buildSegment(partitionId: number, documents: readonly ParsedBuildDocument[]): BuiltSegment {
  const sorted = [...documents].sort((left, right) => compareUtf8(left.documentId, right.documentId));
  const postings: CanonicalPosting[] = [];
  const canonicalDocuments: CanonicalDocumentRecord[] = [];
  const fieldTexts: CanonicalFieldText[] = [];
  const bm25 = new Map<string, MutableBuildBm25Stats>();
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
        const normalizedTokens: string[] = [];
        tokens.forEach((token, position) => {
          const normalized = token.normalize("NFC").trim();
          if (!normalized) return;
          normalizedTokens.push(normalized);
          const positions = positionsByTerm.get(normalized) ?? [];
          positions.push(position);
          positionsByTerm.set(normalized, positions);
        });
        recordBuildBm25Stats(bm25, channel, fieldId, docId, normalizedTokens);
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
    fieldTexts,
    bm25: buildBm25StatsRows(bm25)
  };
  const bytes = encodeCanonicalSegment(segment);
  return {
    partitionId,
    hash: canonicalSegmentHash(bytes),
    bytes,
    documentIds: sorted.map((document) => document.documentId),
    bm25Stats: segment.bm25 ?? []
  };
}

function reduceBuiltSegmentBm25Stats(segments: readonly BuiltSegment[]) {
  for (const segment of segments) {
    for (const field of segment.bm25Stats) assertBm25FieldStatsUseIntegers(field);
  }
  const reduced = reduceCanonicalBm25GlobalStats(
    segments.map((segment) => segment.bm25Stats),
    SEARCH_TOKEN_CHANNELS
  );
  for (const field of reduced.corpusStats) {
    assertUnsignedInteger(field.documentCount, "BM25 global corpus documentCount");
    assertUnsignedInteger(field.totalFieldLength, "BM25 global corpus totalFieldLength");
  }
  for (const row of reduced.bm25GlobalStatsRows) {
    assertUnsignedInteger(row[3], "BM25 global row documentFrequency");
  }
  return reduced;
}

function assertParsedDocumentsSortedByDocumentId(documents: readonly ParsedBuildDocument[]): void {
  for (let index = 1; index < documents.length; index += 1) {
    const previous = documents[index - 1];
    const current = documents[index];
    const order = compareUtf8(previous.documentId, current.documentId);
    if (order === 0) throw new Error(`parallel build determinism assertion failed: duplicate documentId ${current.documentId}`);
    if (order > 0) {
      throw new Error("parallel build determinism assertion failed: parsed documents must be sorted by documentId");
    }
  }
}

function assertBuiltSegmentsSortedByPartitionId(segments: readonly BuiltSegment[]): void {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous.partitionId === current.partitionId) {
      throw new Error(`parallel build determinism assertion failed: duplicate partitionId ${current.partitionId}`);
    }
    if (previous.partitionId > current.partitionId) {
      throw new Error("parallel build determinism assertion failed: segments must be sorted by partitionId");
    }
  }
}

function assertBm25FieldStatsUseIntegers(field: CanonicalBm25FieldStats): void {
  assertUnsignedInteger(field.documentCount, "BM25 segment documentCount");
  assertUnsignedInteger(field.totalFieldLength, "BM25 segment totalFieldLength");
  for (const length of field.documentLengths) {
    assertUnsignedInteger(length.docId, "BM25 segment document length docId");
    assertUnsignedInteger(length.length, "BM25 segment document length");
  }
  for (const frequency of field.documentFrequencies) {
    assertUnsignedInteger(frequency.frequency, "BM25 segment documentFrequency");
  }
}

function assertUnsignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`parallel build determinism assertion failed: ${label} must be a safe unsigned integer`);
  }
}

type MutableBuildBm25Stats = {
  channel: SearchTokenChannel;
  fieldId: number;
  documentCount: number;
  totalFieldLength: number;
  documentLengths: { docId: number; length: number }[];
  documentFrequencies: Map<string, number>;
};

function recordBuildBm25Stats(
  stats: Map<string, MutableBuildBm25Stats>,
  channel: SearchTokenChannel,
  fieldId: number,
  docId: number,
  terms: readonly string[]
): void {
  const key = `${channel}\u0000${fieldId}`;
  const entry = stats.get(key) ?? {
    channel,
    fieldId,
    documentCount: 0,
    totalFieldLength: 0,
    documentLengths: [],
    documentFrequencies: new Map<string, number>()
  };
  entry.documentCount += 1;
  entry.totalFieldLength += terms.length;
  entry.documentLengths.push({ docId, length: terms.length });
  for (const term of new Set(terms)) {
    entry.documentFrequencies.set(term, (entry.documentFrequencies.get(term) ?? 0) + 1);
  }
  stats.set(key, entry);
}

function buildBm25StatsRows(stats: ReadonlyMap<string, MutableBuildBm25Stats>): CanonicalBm25FieldStats[] {
  const channelRank = new Map(SEARCH_TOKEN_CHANNELS.map((channel, index) => [channel, index]));
  return [...stats.values()]
    .sort((left, right) => {
      const channelOrder = (channelRank.get(left.channel) ?? Number.MAX_SAFE_INTEGER) - (channelRank.get(right.channel) ?? Number.MAX_SAFE_INTEGER);
      if (channelOrder !== 0) return channelOrder;
      const channelNameOrder = compareUtf8(left.channel, right.channel);
      if (channelNameOrder !== 0) return channelNameOrder;
      return left.fieldId - right.fieldId;
    })
    .map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      documentLengths: entry.documentLengths.sort((left, right) => left.docId - right.docId),
      documentFrequencies: [...entry.documentFrequencies.entries()]
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([term, frequency]) => ({ term, frequency }))
    }));
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
  tokenizedLines: readonly string[][],
  searchSettings: IndexAffectingSearchSettings
): Omit<SnapshotSnippetLine, "segmentId">[] {
  return lines.map((line, index) => {
    const morphTokens = normalizeTokenSequence(tokenizedLines[index] ?? []).slice(0, SNIPPET_LINE_MORPH_MAX_TERMS);
    const channels = searchFieldTokenTexts(line.analysisText, morphTokens, {
      morphMaxTerms: SNIPPET_LINE_MORPH_MAX_TERMS,
      surfaceMaxTerms: SNIPPET_LINE_SURFACE_MAX_TERMS,
      ngram: searchSettings.ngram,
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
