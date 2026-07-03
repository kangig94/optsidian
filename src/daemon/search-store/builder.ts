import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveVaultPath, vaultRelative, vaultRealpath, walkFiles } from "../../core/path.js";
import type { SearchAnalyzer } from "../../core/search/analyzer.js";
import {
  BODY_INDEX_BUDGET_IDENTITY,
  SEARCH_TOKEN_CHANNELS,
  SNIPPET_LINE_MORPH_MAX_TERMS,
  SNIPPET_LINE_NGRAM_MAX_TERMS,
  SNIPPET_LINE_SURFACE_MAX_TERMS,
  bodyIndexBudgetForText,
  emptySearchTokenChannels,
  searchFieldTokenTexts,
  type BodyIndexBudget,
  type SearchTokenChannel
} from "../../core/search/analysis/index.js";
import { parseNoteLinks, type ParsedNoteLinks, type UnresolvedNoteLink } from "../../core/search/analysis/links.js";
import { MIN_NGRAM, MAX_NGRAM } from "../../core/search/analysis/korean.js";
import { RANKING_CONSTANTS, SEARCH_SCORING_LAMBDAS } from "../../core/search/constants.js";
import {
  INDEX_AFFECTING_SEARCH_SETTINGS_HASH,
  indexAffectingSearchSettingsHash,
  normalizeIndexAffectingSearchSettings,
  type IndexAffectingSearchSettings
} from "../../core/search/index-settings.js";
import { parseMarkdownNote, type SearchBuildDocument } from "../../core/search/markdown.js";
import {
  CANONICAL_BM25_STATS_SCHEMA_ID,
  CANONICAL_DOC_PROJECTION_SCHEMA_ID,
  CANONICAL_SEGMENT_SECTION,
  CANONICAL_SEGMENT_VERSION,
  CANONICAL_TERM_DICTIONARY_SCHEMA_ID,
  canonicalSegmentSectionBytes,
  canonicalSegmentHash,
  canonicalSnapshotManifestBytes,
  canonicalValueBytes,
  corpusSnapshotIdFromManifest,
  decodeCanonicalBm25Section,
  decodeCanonicalSegment,
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
import { buildLinkGraphSidecar } from "./link-graph.js";
import { safeSegmentPath } from "./content-hash.js";
import {
  SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
  type BuiltSegment,
  type BuiltSnapshot,
  type ParsedBuildDocument,
  type ParsedSnippetCorpus,
  type PersistedDocumentRecord,
  type ResolvedLinkEdge,
  type SnapshotEnvelope,
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
// The daemon's binary hash is folded only into baseReuseImplementationIdentity,
// a separate reuse fence that can force a full recompute without changing any
// content-addressed snapshot or corpus identity.
export const INDEX_BUILD_VERSION = "daemon-positional-build-v7";
export { INDEX_AFFECTING_SEARCH_SETTINGS_HASH, indexAffectingSearchSettingsHash };

type BuildInput = {
  vaultRoot: string;
  analyzer: SearchAnalyzer;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  partitionBits?: number;
  base?: BuildSnapshotBase;
  reduceSegments?: ReduceBuildSegmentInputs;
  progress?: (progress: SearchIndexProgressUpdate) => void;
};

export type BuildSnapshotBase = {
  envelope: SnapshotEnvelope;
  segmentsDir: string;
  baseReuseImplementationIdentity?: string;
};

export type BuildDocumentScan = {
  root: string;
  files: readonly string[];
  documents: readonly BuildDocumentScanRecord[];
};

export type BuildDocumentScanRecord = {
  relPath: string;
  path: string;
  contentHash: string;
  unresolvedLinks: readonly UnresolvedNoteLink[];
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

export type ReduceBuildSegmentInput = ReduceBuildSegmentFullInput | ReduceBuildSegmentBaseVariantInput;

export type ReduceBuildSegmentFullInput = {
  mode: "full";
  partitionId: number;
  documents: readonly ParsedBuildDocument[];
  freshDocuments?: never;
  base?: never;
};

export type ReduceBuildSegmentBaseVariantInput = {
  mode: "base";
  partitionId: number;
  freshDocuments: readonly ParsedBuildDocument[];
  base: ReduceBuildSegmentBaseInput;
  documents?: never;
};

export type ReduceBuildSegmentBaseInput = {
  segmentsDir: string;
  segmentHash: string;
  retainedDocumentIds: readonly string[];
};

export type BuildSnapshotLiveDocumentProjection = {
  documentId: string;
  path: string;
  contentHash: string;
  parsedFieldHashes?: Record<string, string>;
  snippetLineSpanHash?: string;
};

export type BuildSnapshotPersistedDocumentProjection = {
  partitionId: number;
  title: string;
  tags: readonly string[];
  snippetCorpus: ParsedSnippetCorpus;
};

export type BuildSnapshotDocumentLinkProjection = {
  documentId: string;
  path: string;
  unresolvedLinks: readonly UnresolvedNoteLink[];
};

export type BuildSnapshotDocumentProjection = {
  liveManifest: BuildSnapshotLiveDocumentProjection;
  persisted: BuildSnapshotPersistedDocumentProjection;
  links: BuildSnapshotDocumentLinkProjection;
};

export type BuildSnapshotFromSegmentsInput = {
  vaultRoot?: string;
  scannedPaths?: readonly string[];
  analyzerIdentity: SearchAnalyzer["identity"];
  partitionBits?: number;
  searchSettings?: Partial<IndexAffectingSearchSettings>;
  documents: readonly BuildSnapshotDocumentProjection[];
  segments: readonly BuiltSegment[];
};

export type DocumentSegmentPostingContribution = Omit<CanonicalPosting, "docId">;

export type DocumentSegmentFieldTextContribution = Omit<CanonicalFieldText, "docId">;

export type DocumentSegmentFieldLengthContribution = {
  channel: SearchTokenChannel;
  fieldId: number;
  length: number;
};

export type DocumentSegmentContribution = {
  documentId: string;
  document: CanonicalDocumentRecord;
  postings: readonly DocumentSegmentPostingContribution[];
  fieldLengths: readonly DocumentSegmentFieldLengthContribution[];
  fieldTexts: readonly DocumentSegmentFieldTextContribution[];
};

export type ReduceBuildSegmentInputs = (
  inputs: readonly ReduceBuildSegmentInput[],
  progress?: (progress: SearchIndexProgressUpdate) => void
) => BuiltSegment[] | Promise<BuiltSegment[]>;

export async function buildCanonicalSearchSnapshot(input: BuildInput): Promise<BuiltSnapshot> {
  const partitionBits = input.partitionBits ?? DEFAULT_PARTITION_BITS;
  const searchSettings = normalizeIndexAffectingSearchSettings(input.searchSettings);
  input.progress?.({ phase: "scanning", completed: 0 });
  const scan = scanBuildDocuments(input.vaultRoot);
  input.progress?.({ phase: "scanning", total: scan.files.length, completed: scan.files.length });
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity(input.analyzer.identity, partitionBits, searchSettings);
  if (input.base) {
    if (!baseSnapshotIdentityMatches(input.base, identityTuple)) {
      throw new Error("incremental build base identity tuple mismatch");
    }
    return buildCanonicalSearchSnapshotIncremental(input, input.base, scan, partitionBits, searchSettings);
  }
  const documents = await parseVaultDocuments(scan, input.analyzer, partitionBits, searchSettings, input.progress);
  const partitionEntries = shuffleParsedBuildDocumentsByPartition(documents);
  const builtSegments = await reduceBuildSegments(partitionEntries, input.progress, input.reduceSegments);
  return buildCanonicalSearchSnapshotFromSegments({
    vaultRoot: scan.root,
    scannedPaths: scan.files,
    analyzerIdentity: input.analyzer.identity,
    partitionBits,
    searchSettings,
    documents: documentProjectionsFromParses(documents, scan.documents),
    segments: builtSegments
  });
}

async function buildCanonicalSearchSnapshotIncremental(
  input: BuildInput,
  base: BuildSnapshotBase,
  scan: BuildDocumentScan,
  partitionBits: number,
  searchSettings: IndexAffectingSearchSettings
): Promise<BuiltSnapshot> {
  const liveRecords = liveDocumentRecordsFromScan(scan.documents, partitionBits);
  const baseDocuments = new Map(base.envelope.documents.map((document) => [document.documentId, document]));
  const basePartitions = new Map(base.envelope.manifest.partitions.map((partition) => [partition.partitionId, partition]));
  const affectedPartitions = affectedPartitionsForBase(liveRecords, baseDocuments, basePartitions);
  const reusedPartitionIds = reusedPartitionIdsForLiveRecords(liveRecords, affectedPartitions);
  const affectedPlans = affectedPartitionPlansForBase(liveRecords, affectedPartitions, baseDocuments, basePartitions);
  const retainedProjectionPartitionIds = sortedUniqueNumbers([
    ...reusedPartitionIds,
    ...affectedPlans
      .filter((plan) => plan.retainedDocumentIds.length > 0)
      .map((plan) => plan.partitionId)
  ]);
  const baseProjectionPartitions = readReusableBasePartitions(base, retainedProjectionPartitionIds);
  const freshPaths = affectedPlans.flatMap((plan) => plan.freshPaths);
  const freshPathSet = new Set(freshPaths);
  const affectedScan: BuildDocumentScan = {
    root: scan.root,
    files: freshPaths,
    documents: scan.documents.filter((record) => freshPathSet.has(record.relPath))
  };
  const affectedDocuments = await parseVaultDocuments(affectedScan, input.analyzer, partitionBits, searchSettings, input.progress);
  const affectedSegments = await reduceBuildSegmentPlans(
    affectedPlans,
    affectedDocuments,
    base,
    basePartitions,
    input.progress,
    input.reduceSegments
  );
  const retainedDocumentIds = retainedDocumentIdsForProjection(liveRecords, reusedPartitionIds, affectedPlans);
  const documents = sortBuildSnapshotDocumentProjections([
    ...documentProjectionsFromParses(affectedDocuments, scan.documents),
    ...documentProjectionsFromRetainedBase(liveRecords, retainedDocumentIds, baseDocuments, baseProjectionPartitions)
  ]);
  const segments = sortBuiltSegmentsByPartitionId([
    ...reusedPartitionIds.map((partitionId) => {
      const partition = baseProjectionPartitions.get(partitionId);
      if (!partition) throw new Error(`incremental build base is missing reused partition ${partitionId}`);
      return partition.segment;
    }),
    ...affectedSegments
  ]);
  return buildCanonicalSearchSnapshotFromSegments({
    vaultRoot: scan.root,
    scannedPaths: scan.files,
    analyzerIdentity: input.analyzer.identity,
    partitionBits,
    searchSettings,
    documents,
    segments
  });
}

export function buildCanonicalSearchSnapshotFromSegments(input: BuildSnapshotFromSegmentsInput): BuiltSnapshot {
  const partitionBits = input.partitionBits ?? DEFAULT_PARTITION_BITS;
  const searchSettings = normalizeIndexAffectingSearchSettings(input.searchSettings);
  const identityTuple = snapshotIdentityTupleForAnalyzerIdentity(input.analyzerIdentity, partitionBits, searchSettings);
  const documents = input.documents;
  const builtSegments = input.segments;
  assertBuildSnapshotDocumentProjectionsSortedByDocumentId(documents);
  assertBuiltSegmentsSortedByPartitionId(builtSegments);
  const linkEdges = input.vaultRoot
    ? resolveParsedDocumentLinkEdges(input.vaultRoot, documents.map((document) => document.links), input.scannedPaths ?? documents.map((document) => document.liveManifest.path))
    : [];
  const bm25GlobalStats = reduceBuiltSegmentBm25Stats(builtSegments);
  const liveRecords = documents.map((document) => ({
    documentId: document.liveManifest.documentId,
    path: document.liveManifest.path,
    contentHash: document.liveManifest.contentHash,
    parsedFieldHashes: document.liveManifest.parsedFieldHashes,
    snippetLineSpanHash: document.liveManifest.snippetLineSpanHash,
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
  const corpusSnapshotId = corpusSnapshotIdFromManifest(manifest);
  const linkGraphId = buildLinkGraphSidecar({ corpusSnapshotId, edges: linkEdges }).linkGraphId;
  const segmentByDocumentId = new Map<string, string>();
  for (const segment of builtSegments) {
    for (const documentId of segment.documentIds) segmentByDocumentId.set(documentId, segment.hash);
  }
  const persistedDocuments: PersistedDocumentRecord[] = documents.map((document) => ({
    documentId: document.liveManifest.documentId,
    path: document.liveManifest.path,
    contentHash: document.liveManifest.contentHash,
    partitionId: document.persisted.partitionId,
    title: document.persisted.title,
    tags: [...document.persisted.tags],
    snippetCorpus: {
      bodyStartLine: document.persisted.snippetCorpus.bodyStartLine,
      fallback: document.persisted.snippetCorpus.fallback,
      lines: document.persisted.snippetCorpus.lines.map((line) => ({
        ...line,
        segmentId: segmentByDocumentId.get(document.liveManifest.documentId) ?? ""
      }))
    }
  }));

  return {
    snapshotId,
    corpusSnapshotId,
    identityTuple,
    manifest,
    canonicalManifestBytes,
    canonicalManifestSha256: snapshotId,
    segments: builtSegments,
    documents: persistedDocuments,
    linkGraphId,
    linkEdges,
    diagnostics: {
      schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
      analyzer: input.analyzerIdentity
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
  const { embeddingModel: _embeddingModel, ...lexicalAnalyzerIdentity } = analyzerIdentity;
  return {
    analyzer: lexicalAnalyzerIdentity,
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
        { name: "termDictionary", id: CANONICAL_SEGMENT_SECTION.termDictionary, schemaId: CANONICAL_TERM_DICTIONARY_SCHEMA_ID }
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
          dense: SEARCH_SCORING_LAMBDAS.dense,
          link: SEARCH_SCORING_LAMBDAS.link
        }
      }
    }
  };
}

export function scanBuildDocuments(vaultRoot: string): BuildDocumentScan {
  const root = vaultRealpath(vaultRoot);
  const files = walkFiles(root, root, { includeHidden: false, all: false })
    .map((abs) => vaultRelative(root, abs))
    .sort((left, right) => compareUtf8(left, right));
  const documents = files
    .map((relPath) => scanBuildDocument(root, relPath))
    .filter((document): document is BuildDocumentScanRecord => document !== undefined);
  return { root, files, documents };
}

function scanBuildDocument(vaultRoot: string, relPath: string): BuildDocumentScanRecord | undefined {
  const abs = path.join(vaultRoot, relPath);
  let bytes: Buffer;
  let text: string;
  try {
    bytes = fs.readFileSync(abs);
    text = decodeUtf8(bytes, relPath);
  } catch {
    return undefined;
  }
  const { parsedLinks } = parseMarkdownNoteLinks(relPath, text);
  return {
    relPath,
    path: normalizeVaultRelativePath(relPath),
    contentHash: sha256(bytes),
    unresolvedLinks: parsedLinks.unresolvedLinks
  };
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

export function resolveParsedDocumentLinkEdges(
  vaultRoot: string,
  documents: readonly BuildSnapshotDocumentLinkProjection[],
  scannedPaths: readonly string[]
): ResolvedLinkEdge[] {
  const targetIndex = buildLinkTargetIndex(scannedPaths);
  const edges = new Map<string, ResolvedLinkEdge>();
  const sortedDocuments = [...documents].sort((left, right) => compareUtf8(left.path, right.path));
  for (const document of sortedDocuments) {
    for (const link of document.unresolvedLinks) {
      const targetPath = resolveLinkTarget(vaultRoot, document.path, link.targetPath, targetIndex);
      if (!targetPath) continue;
      const key = `${document.path}\u0000${targetPath}`;
      if (edges.has(key)) continue;
      edges.set(key, {
        sourcePath: document.path,
        targetPath,
        sourceDocumentId: document.documentId,
        targetDocumentId: sha256(utf8(targetPath))
      });
    }
  }
  return [...edges.values()].sort(compareResolvedLinkEdges);
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
  if (input.mode === "base") {
    if ("documents" in input) {
      throw new Error("reduceBuildSegment base input must not include documents");
    }
    return reduceBuildSegmentWithBase(input.partitionId, input.freshDocuments, input.base);
  }
  if (input.mode !== "full") {
    throw new Error("reduceBuildSegment input mode must be full or base");
  }
  if ("freshDocuments" in input || "base" in input) {
    throw new Error("reduceBuildSegment full input must not include freshDocuments or base");
  }
  return buildSegment(input.partitionId, input.documents);
}

async function reduceBuildSegments(
  partitionEntries: readonly (readonly [partitionId: number, documents: readonly ParsedBuildDocument[]])[],
  progress?: (progress: SearchIndexProgressUpdate) => void,
  reducer: ReduceBuildSegmentInputs = reduceBuildSegmentInputs
): Promise<BuiltSegment[]> {
  return reducer(
    partitionEntries.map(([partitionId, documents]) => ({ mode: "full", partitionId, documents })),
    progress
  );
}

function reduceBuildSegmentInputs(
  inputs: readonly ReduceBuildSegmentInput[],
  progress?: (progress: SearchIndexProgressUpdate) => void
): BuiltSegment[] {
  const builtSegments: BuiltSegment[] = [];
  progress?.({ phase: "segmenting", total: inputs.length, completed: 0 });
  for (const [index, input] of inputs.entries()) {
    builtSegments.push(reduceBuildSegment(input));
    progress?.({
      phase: "segmenting",
      total: inputs.length,
      completed: index + 1,
      current: String(input.partitionId)
    });
  }
  assertBuiltSegmentsSortedByPartitionId(builtSegments);
  return builtSegments;
}

function reduceBuildSegmentWithBase(
  partitionId: number,
  freshDocuments: readonly ParsedBuildDocument[],
  base: ReduceBuildSegmentBaseInput
): BuiltSegment {
  const bytes = fs.readFileSync(safeSegmentPath(base.segmentsDir, base.segmentHash));
  const actualHash = sha256(bytes);
  if (actualHash !== base.segmentHash) {
    throw new Error(`incremental build base segment hash mismatch for ${base.segmentHash}`);
  }
  const extracted = contributionsFromSegment(decodeCanonicalSegment(bytes));
  const retained = retainedContributionsFromSegment(extracted, base.retainedDocumentIds, base.segmentHash);
  const retainedIds = new Set(retained.map((contribution) => contribution.documentId));
  const fresh = freshDocuments.map((document) => {
    if (document.partitionId !== partitionId) {
      throw new Error(`incremental build fresh document ${document.documentId} belongs to partition ${document.partitionId}, not ${partitionId}`);
    }
    if (retainedIds.has(document.documentId)) {
      throw new Error(`incremental build duplicate retained/fresh document ${document.documentId}`);
    }
    return contributionFromParse(document);
  });
  return foldSegment(partitionId, [...retained, ...fresh]);
}

function retainedContributionsFromSegment(
  contributions: readonly DocumentSegmentContribution[],
  retainedDocumentIds: readonly string[],
  segmentHash: string
): DocumentSegmentContribution[] {
  const byDocumentId = new Map(contributions.map((contribution) => [contribution.documentId, contribution]));
  const retained: DocumentSegmentContribution[] = [];
  const seen = new Set<string>();
  for (const documentId of retainedDocumentIds) {
    if (seen.has(documentId)) {
      throw new Error(`incremental build retained document ${documentId} is duplicated for base segment ${segmentHash}`);
    }
    seen.add(documentId);
    const contribution = byDocumentId.get(documentId);
    if (!contribution) {
      throw new Error(`incremental build base segment ${segmentHash} is missing retained document ${documentId}`);
    }
    retained.push(contribution);
  }
  return retained;
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
  const { note, parsedLinks } = parseMarkdownNoteLinks(relPath, text);
  const renderedNote = {
    ...note,
    body: parsedLinks.renderedText
  };
  const lineSpans = lineSpanEntries(text);
  const renderedLineSpans = renderedLineSpanEntries(lineSpans);
  const bodyBudget = bodyIndexBudgetForText(renderedNote.body);
  const snippetLineInputs = snippetLineAnalysisInputs(lineSpans, bodyBudget, renderedLineSpans);
  const tokenized = await analyzer.tokenizeBatch([
    renderedNote.path,
    renderedNote.title,
    renderedNote.aliases.join(" "),
    renderedNote.tags.join(" "),
    renderedNote.headings.join(" "),
    bodyBudget.bodyLexicalText,
    ...snippetLineInputs.map((line) => line.analysisText)
  ]);
  const bodyMorphTokens = normalizeTokenSequence(tokenized[5] ?? []).slice(0, bodyBudget.bodyMorphMaxTokens);
  const fields = {
    path: searchFieldTokenTexts(renderedNote.path, tokenized[0] ?? [], { ngram: searchSettings.ngram }),
    title: searchFieldTokenTexts(renderedNote.title, tokenized[1] ?? [], { ngram: searchSettings.ngram }),
    aliases: searchFieldTokenTexts(renderedNote.aliases.join(" "), tokenized[2] ?? [], { ngram: searchSettings.ngram }),
    tags: searchFieldTokenTexts(renderedNote.tags.join(" "), tokenized[3] ?? [], { ngram: searchSettings.ngram }),
    headings: searchFieldTokenTexts(renderedNote.headings.join(" "), tokenized[4] ?? [], { ngram: searchSettings.ngram }),
    body: searchFieldTokenTexts(bodyBudget.bodyLexicalText, bodyMorphTokens, {
      morphMaxTerms: bodyBudget.bodyMorphMaxTokens,
      surfaceMaxTerms: bodyBudget.bodySurfaceMaxTerms,
      ngram: searchSettings.ngram,
      ngramMaxTerms: bodyBudget.bodyNgramMaxTerms,
      ngramRaw: bodyBudget.bodyNgramText
    })
  };
  const searchDocument: SearchBuildDocument = {
    ...renderedNote,
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
    unresolvedLinks: parsedLinks.unresolvedLinks,
    searchDocument,
    positionTokens,
    canonicalRecord,
    partitionId,
    snippetCorpus: snippetCorpusEntries(
      documentId,
      lineSpans,
      lineSnippetEntries(documentId, snippetLineInputs, tokenized.slice(6), searchSettings)
    )
  };
}

function parseMarkdownNoteLinks(
  relPath: string,
  text: string
): { note: ReturnType<typeof parseMarkdownNote>; parsedLinks: ParsedNoteLinks } {
  const note = parseMarkdownNote(relPath, text);
  return {
    note,
    parsedLinks: parseNoteLinks(note.body)
  };
}

export function documentProjectionsFromParses(
  documents: readonly ParsedBuildDocument[],
  scanRecords: readonly BuildDocumentScanRecord[] = []
): BuildSnapshotDocumentProjection[] {
  const scanRecordByPath = new Map(scanRecords.map((record) => [record.path, record]));
  return documents.map((document) => documentProjectionFromParse(document, scanRecordByPath.get(document.path)));
}

function documentProjectionFromParse(
  document: ParsedBuildDocument,
  scanRecord?: BuildDocumentScanRecord
): BuildSnapshotDocumentProjection {
  return {
    liveManifest: {
      documentId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
      parsedFieldHashes: document.canonicalRecord.parsedFieldHashes,
      snippetLineSpanHash: document.canonicalRecord.snippetLineSpanHash
    },
    persisted: {
      partitionId: document.partitionId,
      title: document.searchDocument.title,
      tags: document.searchDocument.tags,
      snippetCorpus: document.snippetCorpus
    },
    links: {
      documentId: document.documentId,
      path: document.path,
      unresolvedLinks: scanRecord?.unresolvedLinks ?? document.unresolvedLinks
    }
  };
}

type LiveBuildDocumentScanRecord = BuildDocumentScanRecord & {
  documentId: string;
  partitionId: number;
};

type ReusedBasePartition = {
  segment: BuiltSegment;
  canonicalDocumentsByDocumentId: ReadonlyMap<string, CanonicalDocumentRecord>;
};

type AffectedPartitionPlan = {
  partitionId: number;
  freshPaths: readonly string[];
  retainedDocumentIds: readonly string[];
};

function liveDocumentRecordsFromScan(
  scanRecords: readonly BuildDocumentScanRecord[],
  partitionBits: number
): LiveBuildDocumentScanRecord[] {
  const sorted = scanRecords.map((record) => {
    const normalizedPath = normalizeVaultRelativePath(record.path);
    const documentId = sha256(utf8(normalizedPath));
    return {
      ...record,
      path: normalizedPath,
      documentId,
      partitionId: partitionIdForDocument(documentId, partitionBits)
    };
  }).sort((left, right) => compareUtf8(left.documentId, right.documentId));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].documentId === sorted[index].documentId) {
      throw new Error(`incremental build base diff failed: duplicate live documentId ${sorted[index].documentId}`);
    }
  }
  return sorted;
}

function affectedPartitionsForBase(
  liveRecords: readonly LiveBuildDocumentScanRecord[],
  baseDocuments: ReadonlyMap<string, PersistedDocumentRecord>,
  basePartitions: ReadonlyMap<number, CanonicalPartitionDescriptor>
): Set<number> {
  const affected = new Set<number>();
  const liveByDocumentId = new Map(liveRecords.map((record) => [record.documentId, record]));
  for (const record of liveRecords) {
    const baseDocument = baseDocuments.get(record.documentId);
    if (!baseDocument) {
      affected.add(record.partitionId);
      continue;
    }
    if (
      baseDocument.contentHash !== record.contentHash ||
      baseDocument.path !== record.path ||
      baseDocument.partitionId !== record.partitionId
    ) {
      affected.add(record.partitionId);
      affected.add(baseDocument.partitionId);
    }
  }
  for (const baseDocument of baseDocuments.values()) {
    if (!liveByDocumentId.has(baseDocument.documentId)) affected.add(baseDocument.partitionId);
  }
  for (const record of liveRecords) {
    if (!affected.has(record.partitionId) && !basePartitions.has(record.partitionId)) {
      affected.add(record.partitionId);
    }
  }
  return affected;
}

function reusedPartitionIdsForLiveRecords(
  liveRecords: readonly LiveBuildDocumentScanRecord[],
  affectedPartitions: ReadonlySet<number>
): number[] {
  return [...new Set(
    liveRecords
      .filter((record) => !affectedPartitions.has(record.partitionId))
      .map((record) => record.partitionId)
  )].sort((left, right) => left - right);
}

function affectedPartitionPlansForBase(
  liveRecords: readonly LiveBuildDocumentScanRecord[],
  affectedPartitions: ReadonlySet<number>,
  baseDocuments: ReadonlyMap<string, PersistedDocumentRecord>,
  basePartitions: ReadonlyMap<number, CanonicalPartitionDescriptor>
): AffectedPartitionPlan[] {
  const plans = new Map<number, { freshPaths: string[]; retainedDocumentIds: string[] }>();
  for (const record of liveRecords) {
    if (!affectedPartitions.has(record.partitionId)) continue;
    const plan = plans.get(record.partitionId) ?? { freshPaths: [], retainedDocumentIds: [] };
    if (liveRecordCanReuseBaseContribution(record, baseDocuments, basePartitions)) {
      plan.retainedDocumentIds.push(record.documentId);
    } else {
      plan.freshPaths.push(record.relPath);
    }
    plans.set(record.partitionId, plan);
  }
  return [...plans.entries()]
    .map(([partitionId, plan]) => ({
      partitionId,
      freshPaths: plan.freshPaths,
      retainedDocumentIds: plan.retainedDocumentIds.sort(compareUtf8)
    }))
    .sort((left, right) => left.partitionId - right.partitionId);
}

function liveRecordCanReuseBaseContribution(
  record: LiveBuildDocumentScanRecord,
  baseDocuments: ReadonlyMap<string, PersistedDocumentRecord>,
  basePartitions: ReadonlyMap<number, CanonicalPartitionDescriptor>
): boolean {
  const baseDocument = baseDocuments.get(record.documentId);
  return baseDocument !== undefined &&
    baseDocument.contentHash === record.contentHash &&
    baseDocument.path === record.path &&
    baseDocument.partitionId === record.partitionId &&
    basePartitions.has(record.partitionId);
}

async function reduceBuildSegmentPlans(
  plans: readonly AffectedPartitionPlan[],
  freshDocuments: readonly ParsedBuildDocument[],
  base: BuildSnapshotBase,
  basePartitions: ReadonlyMap<number, CanonicalPartitionDescriptor>,
  progress?: (progress: SearchIndexProgressUpdate) => void,
  reducer: ReduceBuildSegmentInputs = reduceBuildSegmentInputs
): Promise<BuiltSegment[]> {
  const freshByPartition = new Map<number, ParsedBuildDocument[]>();
  for (const document of freshDocuments) {
    const partition = freshByPartition.get(document.partitionId) ?? [];
    partition.push(document);
    freshByPartition.set(document.partitionId, partition);
  }
  const inputs = plans.map((plan): ReduceBuildSegmentInput => {
    const documents = freshByPartition.get(plan.partitionId) ?? [];
    const descriptor = basePartitions.get(plan.partitionId);
    if (plan.retainedDocumentIds.length > 0 && !descriptor) {
      throw new Error(`incremental build base is missing affected partition ${plan.partitionId}`);
    }
    if (plan.retainedDocumentIds.length > 0 && descriptor) {
      return {
        mode: "base",
        partitionId: plan.partitionId,
        freshDocuments: documents,
        base: {
          segmentsDir: base.segmentsDir,
          segmentHash: descriptor.segmentHash,
          retainedDocumentIds: plan.retainedDocumentIds
        }
      };
    }
    return {
      mode: "full",
      partitionId: plan.partitionId,
      documents
    };
  });
  return reducer(inputs, progress);
}

function retainedDocumentIdsForProjection(
  liveRecords: readonly LiveBuildDocumentScanRecord[],
  reusedPartitionIds: readonly number[],
  affectedPlans: readonly AffectedPartitionPlan[]
): Set<string> {
  const reused = new Set(reusedPartitionIds);
  const retained = new Set<string>();
  for (const record of liveRecords) {
    if (reused.has(record.partitionId)) retained.add(record.documentId);
  }
  for (const plan of affectedPlans) {
    for (const documentId of plan.retainedDocumentIds) retained.add(documentId);
  }
  return retained;
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function readReusableBasePartitions(
  base: BuildSnapshotBase,
  partitionIds: readonly number[]
): Map<number, ReusedBasePartition> {
  const byPartition = new Map(base.envelope.manifest.partitions.map((partition) => [partition.partitionId, partition]));
  const reused = new Map<number, ReusedBasePartition>();
  for (const partitionId of partitionIds) {
    const descriptor = byPartition.get(partitionId);
    if (!descriptor) throw new Error(`incremental build base is missing partition ${partitionId}`);
    const bytes = fs.readFileSync(safeSegmentPath(base.segmentsDir, descriptor.segmentHash));
    const actualHash = sha256(bytes);
    if (actualHash !== descriptor.segmentHash) {
      throw new Error(`incremental build base segment hash mismatch for ${descriptor.segmentHash}`);
    }
    const decoded = decodeCanonicalSegment(bytes);
    const bm25Bytes = canonicalSegmentSectionBytes(bytes, CANONICAL_SEGMENT_SECTION.bm25);
    const bm25Stats = bm25Bytes ? decodeCanonicalBm25Section(bm25Bytes) : [];
    const canonicalDocuments = decoded.documents ?? [];
    const documentIds = canonicalDocuments.map((document) => document.documentId);
    if (documentIds.length !== descriptor.documentCount) {
      throw new Error(`incremental build base partition ${partitionId} document count mismatch`);
    }
    if (
      documentIds[0] !== descriptor.documentIdStart ||
      documentIds[documentIds.length - 1] !== descriptor.documentIdEnd
    ) {
      throw new Error(`incremental build base partition ${partitionId} document bounds mismatch`);
    }
    reused.set(partitionId, {
      segment: {
        partitionId,
        hash: descriptor.segmentHash,
        bytes,
        documentIds,
        bm25Stats
      },
      canonicalDocumentsByDocumentId: new Map(canonicalDocuments.map((document) => [document.documentId, document]))
    });
  }
  return reused;
}

function documentProjectionsFromRetainedBase(
  liveRecords: readonly LiveBuildDocumentScanRecord[],
  retainedDocumentIds: ReadonlySet<string>,
  baseDocuments: ReadonlyMap<string, PersistedDocumentRecord>,
  reusedPartitions: ReadonlyMap<number, ReusedBasePartition>
): BuildSnapshotDocumentProjection[] {
  const documents: BuildSnapshotDocumentProjection[] = [];
  for (const record of liveRecords) {
    if (!retainedDocumentIds.has(record.documentId)) continue;
    const baseDocument = baseDocuments.get(record.documentId);
    if (!baseDocument) throw new Error(`incremental build base is missing document ${record.documentId}`);
    const reusedPartition = reusedPartitions.get(record.partitionId);
    if (!reusedPartition) throw new Error(`incremental build base is missing reused partition ${record.partitionId}`);
    const canonicalDocument = reusedPartition.canonicalDocumentsByDocumentId.get(record.documentId);
    if (!canonicalDocument) throw new Error(`incremental build base segment is missing document ${record.documentId}`);
    documents.push({
      liveManifest: {
        documentId: record.documentId,
        path: record.path,
        contentHash: record.contentHash,
        parsedFieldHashes: canonicalDocument.parsedFieldHashes,
        snippetLineSpanHash: canonicalDocument.snippetLineSpanHash
      },
      persisted: persistedProjectionFromBaseDocument(baseDocument),
      links: {
        documentId: record.documentId,
        path: record.path,
        unresolvedLinks: record.unresolvedLinks
      }
    });
  }
  return documents;
}

function persistedProjectionFromBaseDocument(
  document: PersistedDocumentRecord
): BuildSnapshotPersistedDocumentProjection {
  return {
    partitionId: document.partitionId,
    title: document.title,
    tags: [...document.tags],
    snippetCorpus: {
      bodyStartLine: document.snippetCorpus.bodyStartLine,
      fallback: document.snippetCorpus.fallback,
      lines: document.snippetCorpus.lines.map(({ segmentId: _segmentId, ...line }) => ({ ...line }))
    }
  };
}

function sortBuildSnapshotDocumentProjections(
  documents: readonly BuildSnapshotDocumentProjection[]
): BuildSnapshotDocumentProjection[] {
  const sorted = [...documents].sort((left, right) => compareUtf8(left.liveManifest.documentId, right.liveManifest.documentId));
  assertBuildSnapshotDocumentProjectionsSortedByDocumentId(sorted);
  return sorted;
}

function sortBuiltSegmentsByPartitionId(segments: readonly BuiltSegment[]): BuiltSegment[] {
  const sorted = [...segments].sort((left, right) => left.partitionId - right.partitionId);
  assertBuiltSegmentsSortedByPartitionId(sorted);
  return sorted;
}

function baseSnapshotIdentityMatches(base: BuildSnapshotBase, expected: SnapshotIdentityTuple): boolean {
  if (base.envelope.snapshotId !== sha256(canonicalSnapshotManifestBytes(base.envelope.manifest))) return false;
  if (base.envelope.canonicalManifestSha256 !== base.envelope.snapshotId) return false;
  if (base.envelope.corpusSnapshotId !== undefined && base.envelope.corpusSnapshotId !== corpusSnapshotIdFromManifest(base.envelope.manifest)) {
    return false;
  }
  return Buffer.compare(
    Buffer.from(canonicalValueBytes(base.envelope.manifest.identityTuple)),
    Buffer.from(canonicalValueBytes(expected))
  ) === 0;
}

export function contributionFromParse(document: ParsedBuildDocument): DocumentSegmentContribution {
  const postings: DocumentSegmentPostingContribution[] = [];
  const fieldLengths: DocumentSegmentFieldLengthContribution[] = [];
  const fieldTexts: DocumentSegmentFieldTextContribution[] = [];
  for (const field of SEGMENT_FIELD_TEXT_FIELDS) {
    fieldTexts.push({
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
      fieldLengths.push({ channel, fieldId, length: normalizedTokens.length });
      for (const [term, positions] of positionsByTerm) {
        postings.push({
          term: `${channel}\u0000${term}`,
          fieldId,
          positions
        });
      }
    }
  }
  return {
    documentId: document.documentId,
    document: document.canonicalRecord,
    postings,
    fieldLengths,
    fieldTexts
  };
}

export function contributionsFromSegment(segment: CanonicalSegment): DocumentSegmentContribution[] {
  const documents = segment.documents ?? [];
  const contributions = documents.map((document): DocumentSegmentContribution & {
    postings: DocumentSegmentPostingContribution[];
    fieldLengths: DocumentSegmentFieldLengthContribution[];
    fieldTexts: DocumentSegmentFieldTextContribution[];
  } => ({
    documentId: document.documentId,
    document,
    postings: [],
    fieldLengths: [],
    fieldTexts: []
  }));
  const byLocalDocId = new Map(contributions.map((contribution, index) => [index + 1, contribution]));
  assertExtractedDocumentsAreUsable(documents);

  for (const posting of segment.postings) {
    const contribution = byLocalDocId.get(posting.docId);
    if (!contribution) throw new Error(`canonical segment extraction failed: posting references missing local docId ${posting.docId}`);
    const { channel } = contributionPostingTerm(posting.term);
    assertSegmentContributionChannel(channel);
    contribution.postings.push({
      term: posting.term,
      fieldId: posting.fieldId,
      positions: [...posting.positions]
    });
  }

  for (const fieldText of segment.fieldTexts ?? []) {
    const contribution = byLocalDocId.get(fieldText.docId);
    if (!contribution) throw new Error(`canonical segment extraction failed: fieldTexts reference missing local docId ${fieldText.docId}`);
    contribution.fieldTexts.push({
      fieldId: fieldText.fieldId,
      text: fieldText.text
    });
  }

  const bm25 = segment.bm25 ?? [];
  if (documents.length > 0 && bm25.length === 0) {
    throw new Error("canonical segment extraction failed: non-empty segment is missing BM25 field lengths");
  }
  for (const field of bm25) {
    assertSegmentBm25FieldLengths(field, documents.length);
    const channel = assertSegmentContributionChannel(field.channel);
    for (const length of field.documentLengths) {
      const contribution = byLocalDocId.get(length.docId);
      if (!contribution) throw new Error(`canonical segment extraction failed: BM25 references missing local docId ${length.docId}`);
      contribution.fieldLengths.push({
        channel,
        fieldId: field.fieldId,
        length: length.length
      });
    }
  }

  assertExtractedFieldLengthsAreComplete(contributions);
  assertSegmentBm25FrequenciesMatchPostings(segment.postings, bm25);
  return contributions;
}

function buildSegment(partitionId: number, documents: readonly ParsedBuildDocument[]): BuiltSegment {
  return foldSegment(partitionId, documents.map((document) => contributionFromParse(document)));
}

export function foldSegment(partitionId: number, contributions: readonly DocumentSegmentContribution[]): BuiltSegment {
  const sorted = [...contributions].sort((left, right) => compareUtf8(left.documentId, right.documentId));
  const postings: CanonicalPosting[] = [];
  const canonicalDocuments: CanonicalDocumentRecord[] = [];
  const fieldTexts: CanonicalFieldText[] = [];
  const bm25 = new Map<string, MutableBuildBm25Stats>();
  sorted.forEach((contribution, index) => {
    const docId = index + 1;
    canonicalDocuments.push(contribution.document);
    for (const fieldText of contribution.fieldTexts) {
      fieldTexts.push({
        docId,
        fieldId: fieldText.fieldId,
        text: fieldText.text
      });
    }
    recordContributionBm25Stats(bm25, docId, contribution);
    for (const posting of contribution.postings) {
      postings.push({
        term: posting.term,
        fieldId: posting.fieldId,
        docId,
        positions: posting.positions
      });
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

function assertBuildSnapshotDocumentProjectionsSortedByDocumentId(
  documents: readonly BuildSnapshotDocumentProjection[]
): void {
  for (const document of documents) {
    if (document.liveManifest.documentId !== document.links.documentId) {
      throw new Error("parallel build determinism assertion failed: document projection ids must match");
    }
    if (document.liveManifest.path !== document.links.path) {
      throw new Error("parallel build determinism assertion failed: document projection paths must match");
    }
  }
  for (let index = 1; index < documents.length; index += 1) {
    const previous = documents[index - 1].liveManifest;
    const current = documents[index].liveManifest;
    const order = compareUtf8(previous.documentId, current.documentId);
    if (order === 0) throw new Error(`parallel build determinism assertion failed: duplicate documentId ${current.documentId}`);
    if (order > 0) {
      throw new Error("parallel build determinism assertion failed: document projections must be sorted by documentId");
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

function assertExtractedDocumentsAreUsable(documents: readonly CanonicalDocumentRecord[]): void {
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.documentId)) {
      throw new Error(`canonical segment extraction failed: duplicate documentId ${document.documentId}`);
    }
    seen.add(document.documentId);
  }
}

function assertSegmentBm25FieldLengths(field: CanonicalBm25FieldStats, documentCount: number): void {
  const channel = assertSegmentContributionChannel(field.channel);
  assertUnsignedInteger(field.fieldId, "BM25 extraction fieldId");
  assertUnsignedInteger(field.documentCount, "BM25 extraction documentCount");
  assertUnsignedInteger(field.totalFieldLength, "BM25 extraction totalFieldLength");
  if (field.documentCount !== documentCount) {
    throw new Error(`canonical segment extraction failed: BM25 ${channel}/${field.fieldId} documentCount mismatch`);
  }
  if (field.documentLengths.length !== documentCount) {
    throw new Error(`canonical segment extraction failed: BM25 ${channel}/${field.fieldId} must carry one length per document`);
  }
  let total = 0;
  for (let index = 0; index < field.documentLengths.length; index += 1) {
    const length = field.documentLengths[index];
    assertUnsignedInteger(length.docId, "BM25 extraction document length docId");
    assertUnsignedInteger(length.length, "BM25 extraction document length");
    if (length.docId !== index + 1) {
      throw new Error(`canonical segment extraction failed: BM25 ${channel}/${field.fieldId} lengths must cover local docIds 1..N`);
    }
    total += length.length;
  }
  if (total !== field.totalFieldLength) {
    throw new Error(`canonical segment extraction failed: BM25 ${channel}/${field.fieldId} totalFieldLength mismatch`);
  }
}

function assertExtractedFieldLengthsAreComplete(contributions: readonly DocumentSegmentContribution[]): void {
  if (contributions.length === 0) return;
  const expected = expectedSegmentFieldLengthKeys();
  for (const contribution of contributions) {
    const actual = new Set(contribution.fieldLengths.map((field) => bm25ContributionKey(field.channel, field.fieldId)));
    if (actual.size !== expected.size) {
      throw new Error(`canonical segment extraction failed: document ${contribution.documentId} has incomplete fieldLengths`);
    }
    for (const key of expected) {
      if (!actual.has(key)) {
        throw new Error(`canonical segment extraction failed: document ${contribution.documentId} is missing fieldLength ${key}`);
      }
    }
  }
}

function assertSegmentBm25FrequenciesMatchPostings(
  postings: readonly CanonicalPosting[],
  bm25: readonly CanonicalBm25FieldStats[]
): void {
  const expectedDocsByTerm = new Map<string, Set<number>>();
  for (const posting of postings) {
    const { channel, term } = contributionPostingTerm(posting.term);
    assertSegmentContributionChannel(channel);
    const key = bm25FrequencyKey(channel, posting.fieldId, term);
    const docs = expectedDocsByTerm.get(key) ?? new Set<number>();
    docs.add(posting.docId);
    expectedDocsByTerm.set(key, docs);
  }
  const expected = new Map([...expectedDocsByTerm.entries()].map(([key, docs]) => [key, docs.size]));
  const actual = new Map<string, number>();
  for (const field of bm25) {
    const channel = assertSegmentContributionChannel(field.channel);
    for (const frequency of field.documentFrequencies) {
      assertUnsignedInteger(frequency.frequency, "BM25 extraction documentFrequency");
      const key = bm25FrequencyKey(channel, field.fieldId, frequency.term);
      actual.set(key, (actual.get(key) ?? 0) + frequency.frequency);
    }
  }
  assertNumberMapsEqual(actual, expected, "canonical segment extraction failed: BM25 document frequencies do not match postings");
}

function assertNumberMapsEqual(actual: ReadonlyMap<string, number>, expected: ReadonlyMap<string, number>, label: string): void {
  if (actual.size !== expected.size) throw new Error(label);
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) throw new Error(label);
  }
}

function expectedSegmentFieldLengthKeys(): Set<string> {
  return new Set(SEARCH_TOKEN_CHANNELS.flatMap((channel) =>
    SEARCH_PROPERTIES.map((field) => bm25ContributionKey(channel, POSITIONAL_FIELD_ID[field]))
  ));
}

function assertSegmentContributionChannel(channel: string): SearchTokenChannel {
  if (!SEARCH_TOKEN_CHANNELS.includes(channel as SearchTokenChannel)) {
    throw new Error(`canonical segment extraction failed: unknown token channel ${channel}`);
  }
  return channel as SearchTokenChannel;
}

function bm25FrequencyKey(channel: string, fieldId: number, term: string): string {
  return `${channel}\u0000${fieldId}\u0000${term}`;
}

type MutableBuildBm25Stats = {
  channel: SearchTokenChannel;
  fieldId: number;
  documentCount: number;
  totalFieldLength: number;
  documentLengths: { docId: number; length: number }[];
  documentFrequencies: Map<string, number>;
};

type SegmentFieldTextField = Exclude<SearchField, "body">;

const SEGMENT_FIELD_TEXT_FIELDS = SEARCH_PROPERTIES.filter(
  (field): field is SegmentFieldTextField => field !== "body"
);

function recordContributionBm25Stats(
  stats: Map<string, MutableBuildBm25Stats>,
  docId: number,
  contribution: DocumentSegmentContribution
): void {
  const termsByField = new Map<string, { channel: SearchTokenChannel; fieldId: number; terms: Set<string> }>();
  for (const posting of contribution.postings) {
    const { channel, term } = contributionPostingTerm(posting.term);
    const key = bm25ContributionKey(channel, posting.fieldId);
    const entry = termsByField.get(key) ?? { channel, fieldId: posting.fieldId, terms: new Set<string>() };
    entry.terms.add(term);
    termsByField.set(key, entry);
  }
  for (const fieldLength of contribution.fieldLengths) {
    const terms = termsByField.get(bm25ContributionKey(fieldLength.channel, fieldLength.fieldId))?.terms ?? new Set<string>();
    recordBuildBm25Stats(stats, fieldLength.channel, fieldLength.fieldId, docId, fieldLength.length, terms);
  }
}

function recordBuildBm25Stats(
  stats: Map<string, MutableBuildBm25Stats>,
  channel: SearchTokenChannel,
  fieldId: number,
  docId: number,
  fieldLength: number,
  distinctTerms: ReadonlySet<string>
): void {
  const key = bm25ContributionKey(channel, fieldId);
  const entry = stats.get(key) ?? {
    channel,
    fieldId,
    documentCount: 0,
    totalFieldLength: 0,
    documentLengths: [],
    documentFrequencies: new Map<string, number>()
  };
  entry.documentCount += 1;
  entry.totalFieldLength += fieldLength;
  entry.documentLengths.push({ docId, length: fieldLength });
  for (const term of distinctTerms) {
    entry.documentFrequencies.set(term, (entry.documentFrequencies.get(term) ?? 0) + 1);
  }
  stats.set(key, entry);
}

function contributionPostingTerm(value: string): { channel: SearchTokenChannel; term: string } {
  const separator = value.indexOf("\u0000");
  if (separator <= 0) throw new Error("segment contribution posting term must include a token channel");
  return {
    channel: value.slice(0, separator) as SearchTokenChannel,
    term: value.slice(separator + 1)
  };
}

function bm25ContributionKey(channel: SearchTokenChannel, fieldId: number): string {
  return `${channel}\u0000${fieldId}`;
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

function parsedFieldHashes(document: SearchBuildDocument): Record<string, string> {
  return Object.fromEntries(
    SEARCH_PROPERTIES.map((field) => [field, sha256(utf8(parsedFieldHashText(document, field)))])
  );
}

function parsedFieldHashText(document: SearchBuildDocument, field: SearchField): string {
  if (field === "body") return document.body;
  return canonicalFieldText(document, field);
}

function canonicalFieldText(document: SearchBuildDocument, field: SegmentFieldTextField): string {
  switch (field) {
    case "path":
      return document.path;
    case "title":
      return document.title;
    case "aliases":
      return document.aliases.join("\n");
    case "tags":
      return document.tags.join("\n");
    case "headings":
      return document.headings.join("\n");
  }
  const exhaustive: never = field;
  return exhaustive;
}

function tokenText(document: SearchBuildDocument, channel: "surface" | "ngram", field: SearchField): string[] {
  const value = document[SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]];
  return typeof value === "string" ? value.split(" ").filter(Boolean) : [];
}

function channelPositionTokens(document: SearchBuildDocument, channel: "surface" | "ngram"): Record<SearchField, readonly string[]> {
  const output = {} as Record<SearchField, readonly string[]>;
  for (const field of SEARCH_PROPERTIES) output[field] = tokenText(document, channel, field);
  return output;
}

function normalizeTokenSequence(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.normalize("NFC").trim()).filter(Boolean);
}

type LinkTargetIndex = {
  byPath: Map<string, string>;
  byPathNoMarkdownExtension: Map<string, string[]>;
  byBasename: Map<string, string[]>;
  byBasenameNoMarkdownExtension: Map<string, string[]>;
};

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

function renderedLineSpanEntries(lines: readonly LineSpanEntry[]): LineSpanEntry[] {
  return lines.map((line) => ({
    ...line,
    text: parseNoteLinks(line.text).renderedText
  }));
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

function snippetCorpusEntries(
  documentId: string,
  fullLineSpans: readonly LineSpanEntry[],
  analyzedLines: readonly Omit<SnapshotSnippetLine, "segmentId">[]
): ParsedSnippetCorpus {
  const bodyStartLine = snippetCorpusBodyStartLine(fullLineSpans);
  const linesByNumber = new Map<number, Omit<SnapshotSnippetLine, "segmentId">>();
  for (const line of analyzedLines) {
    if (line.line <= bodyStartLine) continue;
    if (!linesByNumber.has(line.line)) linesByNumber.set(line.line, line);
  }

  const fallbackLine = snippetCorpusFallbackLine(fullLineSpans, bodyStartLine);
  if (!fallbackLine) {
    return {
      bodyStartLine,
      lines: [...linesByNumber.values()].sort((left, right) => left.line - right.line),
      fallback: { kind: "title", line: 1 }
    };
  }

  const fallbackSnippetId = `${documentId}:${fallbackLine.line}`;
  if (!linesByNumber.has(fallbackLine.line)) {
    linesByNumber.set(fallbackLine.line, {
      snippetId: fallbackSnippetId,
      documentId,
      line: fallbackLine.line,
      text: fallbackLine.text,
      byteStart: fallbackLine.byteStart,
      byteEnd: fallbackLine.byteEnd,
      channels: emptySearchTokenChannels()
    });
  }

  return {
    bodyStartLine,
    lines: [...linesByNumber.values()].sort((left, right) => left.line - right.line),
    fallback: { kind: "line", snippetId: fallbackSnippetId }
  };
}

function snippetCorpusBodyStartLine(lines: readonly LineSpanEntry[]): number {
  if (lines[0]?.text.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].text.trim();
    if (trimmed === "---" || trimmed === "...") return lines[index].line;
  }
  return 0;
}

function snippetCorpusFallbackLine(
  lines: readonly LineSpanEntry[],
  bodyStartLine: number
): LineSpanEntry | undefined {
  let firstNonBlank: LineSpanEntry | undefined;
  for (const line of lines) {
    if (line.line <= bodyStartLine || line.text.trim().length === 0) continue;
    firstNonBlank ??= line;
    if (/^#{1,6}\s+/.test(line.text)) return line;
  }
  return firstNonBlank;
}

function snippetLineAnalysisInputs(
  lines: readonly LineSpanEntry[],
  budget: BodyIndexBudget,
  analysisLines: readonly LineSpanEntry[] = lines
): SnippetLineAnalysisInput[] {
  const maxLines = budget.snippetDocMaxAnalyzedLines ?? lines.length;
  const initialSelected = lines.length <= maxLines ? lines.map((_, index) => index) : evenSampledIndices(lines.length, maxLines);
  const maxChars = budget.snippetDocMaxAnalyzedChars ?? Number.POSITIVE_INFINITY;
  const selected = fitSnippetLineIndicesToCharBudget(
    analysisLines,
    initialSelected,
    maxChars,
    budget.snippetLineAnalysisMaxChars
  );
  const output: SnippetLineAnalysisInput[] = [];
  let usedChars = 0;
  for (const index of selected) {
    const line = lines[index];
    if (!line) continue;
    const analysisLine = analysisLines[index] ?? line;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    const analysisText = analysisLine.text.slice(0, Math.min(budget.snippetLineAnalysisMaxChars, remaining));
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

function buildLinkTargetIndex(scannedPaths: readonly string[]): LinkTargetIndex {
  const paths = [...new Set(scannedPaths.map(normalizeVaultRelativePath).filter(Boolean))].sort(compareUtf8);
  const byPath = new Map<string, string>();
  const byPathNoMarkdownExtension = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  const byBasenameNoMarkdownExtension = new Map<string, string[]>();
  for (const relPath of paths) {
    byPath.set(relPath, relPath);
    addLinkTargetAlias(byPathNoMarkdownExtension, stripMarkdownExtension(relPath), relPath);
    const basename = path.posix.basename(relPath);
    addLinkTargetAlias(byBasename, basename, relPath);
    addLinkTargetAlias(byBasenameNoMarkdownExtension, stripMarkdownExtension(basename), relPath);
  }
  return { byPath, byPathNoMarkdownExtension, byBasename, byBasenameNoMarkdownExtension };
}

function addLinkTargetAlias(index: Map<string, string[]>, alias: string, relPath: string): void {
  const normalized = normalizeVaultRelativePath(alias);
  if (!normalized) return;
  const entries = index.get(normalized) ?? [];
  if (!entries.includes(relPath)) entries.push(relPath);
  index.set(normalized, entries.sort(compareUtf8));
}

function resolveLinkTarget(
  vaultRoot: string,
  sourcePath: string,
  rawTargetPath: string,
  targetIndex: LinkTargetIndex
): string | undefined {
  const targetPath = decodeLinkTargetPath(rawTargetPath).trim();
  if (!targetPath) return targetIndex.byPath.get(sourcePath);
  if (isExternalLinkTarget(targetPath)) return undefined;

  const candidates = linkPathCandidates(vaultRoot, sourcePath, targetPath);
  for (const candidate of candidates) {
    const resolved = lookupLinkTarget(candidate, targetIndex);
    if (resolved) return resolved;
  }

  if (!targetPath.includes("/") && !targetPath.includes("\\")) {
    const basename = normalizeVaultRelativePath(targetPath);
    return uniqueLinkTarget(targetIndex.byBasename.get(basename)) ??
      uniqueLinkTarget(targetIndex.byBasenameNoMarkdownExtension.get(stripMarkdownExtension(basename)));
  }
  return undefined;
}

function decodeLinkTargetPath(targetPath: string): string {
  try {
    return decodeURIComponent(targetPath);
  } catch {
    return targetPath;
  }
}

function isExternalLinkTarget(targetPath: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(targetPath) || targetPath.startsWith("//");
}

function linkPathCandidates(vaultRoot: string, sourcePath: string, targetPath: string): string[] {
  const sourceDir = path.posix.dirname(sourcePath);
  const normalizedSourceDir = sourceDir === "." ? "" : sourceDir;
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const rawCandidates: string[] = [];
  if (normalizedTarget.startsWith("/")) {
    rawCandidates.push(normalizedTarget.slice(1));
  } else if (normalizedTarget.startsWith("./") || normalizedTarget.startsWith("../")) {
    rawCandidates.push(path.posix.join(normalizedSourceDir, normalizedTarget));
  } else if (normalizedTarget.includes("/")) {
    rawCandidates.push(normalizedTarget, path.posix.join(normalizedSourceDir, normalizedTarget));
  } else {
    rawCandidates.push(path.posix.join(normalizedSourceDir, normalizedTarget), normalizedTarget);
  }

  const candidates: string[] = [];
  for (const raw of rawCandidates) {
    const candidate = safeCanonicalVaultRelativePath(vaultRoot, raw);
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function safeCanonicalVaultRelativePath(vaultRoot: string, candidate: string): string | undefined {
  try {
    return normalizeVaultRelativePath(resolveVaultPath(vaultRoot, candidate, { mustExist: false }).rel);
  } catch {
    return undefined;
  }
}

function lookupLinkTarget(candidate: string, targetIndex: LinkTargetIndex): string | undefined {
  const normalized = normalizeVaultRelativePath(candidate);
  return targetIndex.byPath.get(normalized) ??
    targetIndex.byPath.get(`${normalized}.md`) ??
    uniqueLinkTarget(targetIndex.byPathNoMarkdownExtension.get(stripMarkdownExtension(normalized)));
}

function uniqueLinkTarget(targets: readonly string[] | undefined): string | undefined {
  return targets?.length === 1 ? targets[0] : undefined;
}

function stripMarkdownExtension(value: string): string {
  return value.toLocaleLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

function compareResolvedLinkEdges(left: ResolvedLinkEdge, right: ResolvedLinkEdge): number {
  return compareUtf8(left.sourcePath, right.sourcePath) ||
    compareUtf8(left.targetPath, right.targetPath) ||
    compareUtf8(left.sourceDocumentId, right.sourceDocumentId) ||
    compareUtf8(left.targetDocumentId, right.targetDocumentId);
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
