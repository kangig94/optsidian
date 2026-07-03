import crypto from 'node:crypto';
import path from 'node:path';
import type { SearchAnalyzerIdentity } from '../analyzer.js';
import type { SearchTokenChannel } from '../analysis/channels.js';
import type { RetrieverIdentity } from '../contracts.js';
import { identityPhraseCandidates } from '../ranking/identity.js';
import { SEARCH_PROPERTIES } from '../schema.js';
import type { SearchField } from '../../types.js';
import { decodeUnsignedLeb128, encodeUnsignedLeb128, encodeZigZagLeb128, assertSafeUnsignedInteger } from './leb128.js';

const CANONICAL_SEGMENT_MAGIC = Uint8Array.from([0x4f, 0x53, 0x53, 0x47]);
export const CANONICAL_SEGMENT_VERSION = 1;

export const CANONICAL_SEGMENT_SECTION = {
  postings: 1,
  documents: 2,
  fieldTexts: 3,
  bm25: 4,
  docProjection: 5,
  termDictionary: 6,
} as const;

export const CANONICAL_BM25_STATS_SCHEMA_ID = 1;

export const CANONICAL_DOC_PROJECTION_SCHEMA_ID = 1;

export const CANONICAL_TERM_DICTIONARY_SCHEMA_ID = 1;

const DOC_PROJECTION_HEADER_FIXED_OFFSET_COUNT = 8;
const DOC_PROJECTION_ROW_WORDS = 19;
const DOC_PROJECTION_FIELD_LENGTH_WORDS = 3;
const DOC_PROJECTION_OFFSET_WORDS = 6;

export type CanonicalPosting = {
  term: string;
  fieldId: number;
  docId: number;
  positions: readonly number[];
};

export type CanonicalDocumentRecord = {
  documentId: string;
  path: string;
  contentHash: string;
  parsedFieldHashes?: Record<string, string>;
  snippetLineSpanHash?: string;
  deleted?: boolean;
};

export type CanonicalFieldText = {
  docId: number;
  fieldId: number;
  text: string;
};

export type CanonicalBm25FieldStats = {
  channel: string;
  fieldId: number;
  documentCount: number;
  totalFieldLength: number;
  documentLengths: readonly {
    docId: number;
    length: number;
  }[];
  documentFrequencies: readonly {
    term: string;
    frequency: number;
  }[];
};

type CanonicalBm25CorpusStats = {
  channel: string;
  fieldId: number;
  documentCount: number;
  totalFieldLength: number;
};

type CanonicalBm25GlobalStatsRow = readonly [channel: string, fieldId: number, term: string, documentFrequency: number];

export type CanonicalBm25GlobalStats = {
  bm25StatsSchemaId: typeof CANONICAL_BM25_STATS_SCHEMA_ID;
  corpusStats: readonly CanonicalBm25CorpusStats[];
  bm25GlobalStatsRows: readonly CanonicalBm25GlobalStatsRow[];
  bm25GlobalStatsHash: string;
};

export type CanonicalTermDictionaryEntry = {
  term: string;
  postingsOffset: number;
  postingsByteLength: number;
  postingCount: number;
};

export type CanonicalDocProjectionDoc = {
  localDocId: number;
  documentId: string;
  path: string;
};

export type CanonicalDocProjectionIdentityKeys = {
  path: string;
  filenameStem: string;
  title: readonly string[];
  aliases: readonly string[];
  headings: readonly string[];
  pathSegments: readonly string[];
};

export type CanonicalDocProjectionFieldLength = {
  channel: string;
  fieldId: number;
  length: number;
};

export type CanonicalDocProjectionOffsets = {
  channel: string;
  fieldId: number;
  fieldTextOffset: number;
  fieldTextByteLength: number;
  postingsOffset: number;
  postingsByteLength: number;
};

export type CanonicalSegment = {
  postings: readonly CanonicalPosting[];
  documents?: readonly CanonicalDocumentRecord[];
  fieldTexts?: readonly CanonicalFieldText[];
  bm25?: readonly CanonicalBm25FieldStats[];
};

export type SearchSnapshotAnalyzerIdentity = {
  analyzer: SearchAnalyzerIdentity;
  channels: readonly SearchTokenChannel[];
  ngram: {
    enabled: boolean;
    min: number;
    max: number;
    bodyBudget: unknown;
  };
};

type SearchSegmentSchemaIdentity = {
  format: 'canonical-segment';
  version: typeof CANONICAL_SEGMENT_VERSION;
  sections: readonly {
    name: keyof typeof CANONICAL_SEGMENT_SECTION;
    id: number;
    schemaId?: number;
  }[];
};

type SearchCorpusStatsSchemaIdentity = {
  id: 'bm25-global-stats';
  schemaId: typeof CANONICAL_BM25_STATS_SCHEMA_ID;
};

type SearchScoringModelIdentity = {
  id: string;
  rankingFeatureVersion: string;
  retrieverIdentity: RetrieverIdentity;
  weights: {
    lambdas: {
      phrase: number;
      exact: number;
      dense: number;
      link: number;
    };
  };
};

export type SearchModelIdentity = {
  schemaVersion: 1;
  analyzerIdentity: SearchSnapshotAnalyzerIdentity;
  segmentSchema: SearchSegmentSchemaIdentity;
  corpusStatsSchema: SearchCorpusStatsSchemaIdentity;
  scoringModel: SearchScoringModelIdentity;
};

export type SnapshotIdentityTuple = {
  buildVersion: string;
  fieldSetVersion: string;
  partitionBits: number;
  analyzerIdentity: SearchSnapshotAnalyzerIdentity;
  searchSettingsHash: string;
  rankingFeatureVersion: string;
  searchModelIdentity: SearchModelIdentity;
};

type LexicalCorpusIdentity = {
  schemaVersion: 1;
  buildVersion: string;
  fieldSetVersion: string;
  partitionBits: number;
  analyzerIdentity: SearchSnapshotAnalyzerIdentity;
  searchSettingsHash: string;
  segmentSchema: SearchSegmentSchemaIdentity;
  corpusStatsSchema: SearchCorpusStatsSchemaIdentity;
  liveDocumentManifestHash: string;
  tombstoneHash: string;
  bm25StatsSchemaId: typeof CANONICAL_BM25_STATS_SCHEMA_ID;
  corpusStats: readonly CanonicalBm25CorpusStats[];
  bm25GlobalStatsRows: readonly CanonicalBm25GlobalStatsRow[];
  bm25GlobalStatsHash: string;
  partitions: readonly CanonicalPartitionDescriptor[];
};

export type CanonicalPartitionDescriptor = {
  partitionId: number;
  documentIdStart: string;
  documentIdEnd: string;
  segmentHash: string;
  documentCount: number;
  byteLength: number;
};

export type CanonicalSnapshotManifest = {
  identityTuple: SnapshotIdentityTuple;
  liveDocumentManifestHash: string;
  tombstoneHash: string;
  bm25StatsSchemaId: typeof CANONICAL_BM25_STATS_SCHEMA_ID;
  corpusStats: readonly CanonicalBm25CorpusStats[];
  bm25GlobalStatsRows: readonly CanonicalBm25GlobalStatsRow[];
  bm25GlobalStatsHash: string;
  partitions: readonly CanonicalPartitionDescriptor[];
};

export type CanonicalSnapshotForTests = {
  snapshotId: string;
  canonicalManifestBytes: Uint8Array;
  manifest: CanonicalSnapshotManifest;
  segments: readonly {
    partitionId: number;
    hash: string;
    bytes: Uint8Array;
  }[];
};

type CanonicalSnapshotTestDocument = {
  path: string;
  content: string;
};

export type CanonicalSnapshotBuildForTestsInput = {
  identityTuple: SnapshotIdentityTuple;
  documents: readonly CanonicalSnapshotTestDocument[];
  history?: readonly unknown[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type Section = {
  id: number;
  bytes: Uint8Array;
};

type SectionEntry = {
  id: number;
  offset: number;
  length: number;
};

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export function encodeCanonicalSegment(segment: CanonicalSegment): Uint8Array {
  const normalized = normalizeCanonicalSegment(segment);
  const sections = canonicalSections(normalized);
  const payloads = sections.map((section) => section.bytes);
  const entries: SectionEntry[] = [];
  let payloadOffset = 0;
  for (const section of sections) {
    entries.push({ id: section.id, offset: payloadOffset, length: section.bytes.length });
    payloadOffset += section.bytes.length;
  }

  const header = new ByteWriter();
  header.writeBytes(CANONICAL_SEGMENT_MAGIC);
  header.writeUnsigned(CANONICAL_SEGMENT_VERSION);
  header.writeUnsigned(entries.length);
  for (const entry of entries) {
    header.writeUnsigned(entry.id);
    header.writeUnsigned(entry.offset);
    header.writeUnsigned(entry.length);
  }
  return concatBytes([header.bytes(), ...payloads]);
}

export function decodeCanonicalSegment(bytes: Uint8Array): CanonicalSegment {
  const { entries, payloadStart } = parseCanonicalSegmentHeader(bytes);
  let expectedPayloadOffset = 0;
  const segment: CanonicalSegment = { postings: [] };
  let postingsPayload: Uint8Array | undefined;
  let docProjectionPayload: Uint8Array | undefined;
  let termDictionaryPayload: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry.offset !== expectedPayloadOffset)
      throw new Error('canonical segment sections must be contiguous and sorted');
    expectedPayloadOffset += entry.length;
    const start = payloadStart + entry.offset;
    const end = start + entry.length;
    if (start < payloadStart || end > bytes.length) throw new Error('canonical segment section bounds are invalid');
    const payload = bytes.subarray(start, end);
    if (entry.id === CANONICAL_SEGMENT_SECTION.postings) {
      postingsPayload = payload;
      segment.postings = decodePostingsSection(payload);
    } else if (entry.id === CANONICAL_SEGMENT_SECTION.documents) segment.documents = decodeDocumentsSection(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.fieldTexts) segment.fieldTexts = decodeFieldTextsSection(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.bm25) segment.bm25 = decodeBm25Section(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.docProjection) docProjectionPayload = payload;
    else if (entry.id === CANONICAL_SEGMENT_SECTION.termDictionary) termDictionaryPayload = payload;
    else throw new Error(`unknown canonical segment section ${entry.id}`);
  }
  if (payloadStart + expectedPayloadOffset !== bytes.length) {
    throw new Error('canonical segment contains trailing bytes');
  }
  if (!postingsPayload) throw new Error('canonical segment missing postings section');
  if (!docProjectionPayload) throw new Error('canonical segment missing docProjection section');
  if (!termDictionaryPayload) throw new Error('canonical segment missing term dictionary section');
  validateDocProjectionSection(
    docProjectionPayload,
    segment.documents ?? [],
    segment.fieldTexts ?? [],
    segment.bm25 ?? [],
  );
  validateTermDictionaryAgainstPostings(termDictionaryPayload, postingsPayload);
  return normalizeCanonicalSegment(segment);
}

export function canonicalSegmentSectionBytes(bytes: Uint8Array, sectionId: number): Uint8Array | undefined {
  const { entries, payloadStart } = parseCanonicalSegmentHeader(bytes);
  let expectedPayloadOffset = 0;
  let found: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry.offset !== expectedPayloadOffset)
      throw new Error('canonical segment sections must be contiguous and sorted');
    expectedPayloadOffset += entry.length;
    const start = payloadStart + entry.offset;
    const end = start + entry.length;
    if (start < payloadStart || end > bytes.length) throw new Error('canonical segment section bounds are invalid');
    if (entry.id === sectionId) found = bytes.subarray(start, end);
  }
  if (payloadStart + expectedPayloadOffset !== bytes.length) {
    throw new Error('canonical segment contains trailing bytes');
  }
  return found;
}

export function canonicalSegmentHash(input: CanonicalSegment | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : encodeCanonicalSegment(input);
  return sha256(bytes);
}

export function canonicalSnapshotManifestBytes(manifest: CanonicalSnapshotManifest): Uint8Array {
  return canonicalValueBytes({
    identityTuple: manifest.identityTuple as { readonly [key: string]: CanonicalValue | undefined },
    liveDocumentManifestHash: manifest.liveDocumentManifestHash,
    tombstoneHash: manifest.tombstoneHash,
    bm25StatsSchemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((field) => ({
      channel: field.channel,
      fieldId: field.fieldId,
      documentCount: field.documentCount,
      totalFieldLength: field.totalFieldLength,
    })),
    bm25GlobalStatsRows: manifest.bm25GlobalStatsRows.map((row) => [row[0], row[1], row[2], row[3]]),
    bm25GlobalStatsHash: manifest.bm25GlobalStatsHash,
    partitions: manifest.partitions.map((partition) => ({
      partitionId: partition.partitionId,
      documentIdStart: partition.documentIdStart,
      documentIdEnd: partition.documentIdEnd,
      segmentHash: partition.segmentHash,
      documentCount: partition.documentCount,
      byteLength: partition.byteLength,
    })),
  });
}

export function snapshotIdFromManifest(manifest: CanonicalSnapshotManifest): string {
  return sha256(canonicalSnapshotManifestBytes(manifest));
}

function lexicalCorpusIdentityFromManifest(manifest: CanonicalSnapshotManifest): LexicalCorpusIdentity {
  return {
    schemaVersion: 1,
    buildVersion: manifest.identityTuple.buildVersion,
    fieldSetVersion: manifest.identityTuple.fieldSetVersion,
    partitionBits: manifest.identityTuple.partitionBits,
    analyzerIdentity: lexicalAnalyzerIdentity(manifest.identityTuple.analyzerIdentity),
    searchSettingsHash: manifest.identityTuple.searchSettingsHash,
    segmentSchema: manifest.identityTuple.searchModelIdentity.segmentSchema,
    corpusStatsSchema: manifest.identityTuple.searchModelIdentity.corpusStatsSchema,
    liveDocumentManifestHash: manifest.liveDocumentManifestHash,
    tombstoneHash: manifest.tombstoneHash,
    bm25StatsSchemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((field) => ({
      channel: field.channel,
      fieldId: field.fieldId,
      documentCount: field.documentCount,
      totalFieldLength: field.totalFieldLength,
    })),
    bm25GlobalStatsRows: manifest.bm25GlobalStatsRows.map((row) => [row[0], row[1], row[2], row[3]]),
    bm25GlobalStatsHash: manifest.bm25GlobalStatsHash,
    partitions: manifest.partitions.map((partition) => ({
      partitionId: partition.partitionId,
      documentIdStart: partition.documentIdStart,
      documentIdEnd: partition.documentIdEnd,
      segmentHash: partition.segmentHash,
      documentCount: partition.documentCount,
      byteLength: partition.byteLength,
    })),
  };
}

export function corpusSnapshotIdFromManifest(manifest: CanonicalSnapshotManifest): string {
  return sha256(canonicalValueBytes(lexicalCorpusIdentityFromManifest(manifest)));
}

function lexicalAnalyzerIdentity(identity: SearchSnapshotAnalyzerIdentity): SearchSnapshotAnalyzerIdentity {
  const { embeddingModel: _embeddingModel, ...analyzer } = identity.analyzer;
  return {
    analyzer,
    channels: [...identity.channels],
    ngram: {
      enabled: identity.ngram.enabled,
      min: identity.ngram.min,
      max: identity.ngram.max,
      bodyBudget: identity.ngram.bodyBudget,
    },
  };
}

export function canonicalValueBytes(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  writeCanonicalValue(writer, value);
  return writer.bytes();
}

function canonicalBm25GlobalStatsBytes(stats: Omit<CanonicalBm25GlobalStats, 'bm25GlobalStatsHash'>): Uint8Array {
  return canonicalValueBytes({
    schemaId: stats.bm25StatsSchemaId,
    corpusStats: stats.corpusStats.map((field) => ({
      channel: field.channel,
      fieldId: field.fieldId,
      documentCount: field.documentCount,
      totalFieldLength: field.totalFieldLength,
    })),
    rows: stats.bm25GlobalStatsRows.map((row) => [row[0], row[1], row[2], row[3]]),
  });
}

export function canonicalBm25GlobalStatsHash(stats: Omit<CanonicalBm25GlobalStats, 'bm25GlobalStatsHash'>): string {
  return sha256(canonicalBm25GlobalStatsBytes(stats));
}

export function reduceCanonicalBm25GlobalStats(
  segmentStats: readonly (readonly CanonicalBm25FieldStats[])[],
  channelOrder: readonly string[],
): CanonicalBm25GlobalStats {
  const corpus = new Map<string, CanonicalBm25CorpusStats>();
  const frequencies = new Map<string, { channel: string; fieldId: number; term: string; documentFrequency: number }>();
  for (const stats of segmentStats) {
    for (const field of normalizeBm25Stats(stats)) {
      const corpusKey = bm25FieldKey(field.channel, field.fieldId);
      const corpusEntry = corpus.get(corpusKey) ?? {
        channel: field.channel,
        fieldId: field.fieldId,
        documentCount: 0,
        totalFieldLength: 0,
      };
      corpusEntry.documentCount += field.documentCount;
      corpusEntry.totalFieldLength += field.totalFieldLength;
      assertSafeUnsignedInteger(corpusEntry.documentCount, 'BM25 global documentCount');
      assertSafeUnsignedInteger(corpusEntry.totalFieldLength, 'BM25 global totalFieldLength');
      corpus.set(corpusKey, corpusEntry);

      for (const entry of field.documentFrequencies) {
        const frequencyKey = bm25TermKey(field.channel, field.fieldId, entry.term);
        const current = frequencies.get(frequencyKey) ?? {
          channel: field.channel,
          fieldId: field.fieldId,
          term: entry.term,
          documentFrequency: 0,
        };
        current.documentFrequency += entry.frequency;
        assertSafeUnsignedInteger(current.documentFrequency, 'BM25 global documentFrequency');
        frequencies.set(frequencyKey, current);
      }
    }
  }

  const compare = bm25GlobalOrder(channelOrder);
  const corpusStats = [...corpus.values()].sort((left, right) =>
    compare(left.channel, left.fieldId, '', right.channel, right.fieldId, ''),
  );
  const bm25GlobalStatsRows = [...frequencies.values()]
    .filter((entry) => entry.documentFrequency > 0)
    .sort((left, right) => compare(left.channel, left.fieldId, left.term, right.channel, right.fieldId, right.term))
    .map((entry): CanonicalBm25GlobalStatsRow => [entry.channel, entry.fieldId, entry.term, entry.documentFrequency]);
  assertNoDuplicateBm25Rows(bm25GlobalStatsRows);
  const withoutHash = {
    bm25StatsSchemaId: CANONICAL_BM25_STATS_SCHEMA_ID,
    corpusStats,
    bm25GlobalStatsRows,
  } as const;
  return {
    ...withoutHash,
    bm25GlobalStatsHash: canonicalBm25GlobalStatsHash(withoutHash),
  };
}

export function encodeFloat64Canonical(value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new Error('canonical float must be finite');
  const normalized = Object.is(value, -0) ? 0 : value;
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, normalized, true);
  return bytes;
}

export function buildCanonicalSnapshotForTests(input: CanonicalSnapshotBuildForTestsInput): CanonicalSnapshotForTests {
  void input.history;
  const records = input.documents
    .map((document) => {
      const path = normalizeVaultRelativePath(document.path);
      return {
        documentId: sha256(utf8(path)),
        path,
        contentHash: sha256(utf8(document.content)),
        parsedFieldHashes: {
          body: sha256(utf8(document.content)),
        },
        snippetLineSpanHash: sha256(utf8(lineSpanSource(document.content))),
        deleted: false,
        content: document.content,
      };
    })
    .sort((left, right) => compareByteStrings(left.documentId, right.documentId));

  const partitions = new Map<number, typeof records>();
  for (const record of records) {
    const partitionId = partitionIdForDocument(record.documentId, input.identityTuple.partitionBits);
    const partition = partitions.get(partitionId) ?? [];
    partition.push(record);
    partitions.set(partitionId, partition);
  }

  const segments = [...partitions.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([partitionId, partitionRecords]) => {
      const segment = segmentForTestRecords(partitionRecords);
      const bytes = encodeCanonicalSegment(segment);
      return {
        partitionId,
        hash: canonicalSegmentHash(bytes),
        bytes,
        bm25: segment.bm25 ?? [],
        documentIdStart: partitionRecords[0]?.documentId ?? '',
        documentIdEnd: partitionRecords[partitionRecords.length - 1]?.documentId ?? '',
        documentCount: partitionRecords.length,
      };
    });
  const bm25GlobalStats = reduceCanonicalBm25GlobalStats(
    segments.map((segment) => segment.bm25),
    ['morph', 'surface', 'ngram'],
  );

  const manifest: CanonicalSnapshotManifest = {
    identityTuple: input.identityTuple,
    liveDocumentManifestHash: sha256(
      canonicalValueBytes(
        records.map((record) => ({
          documentId: record.documentId,
          path: record.path,
          contentHash: record.contentHash,
          parsedFieldHashes: record.parsedFieldHashes,
          snippetLineSpanHash: record.snippetLineSpanHash,
          deleted: false,
        })),
      ),
    ),
    tombstoneHash: sha256(canonicalValueBytes([])),
    bm25StatsSchemaId: bm25GlobalStats.bm25StatsSchemaId,
    corpusStats: bm25GlobalStats.corpusStats,
    bm25GlobalStatsRows: bm25GlobalStats.bm25GlobalStatsRows,
    bm25GlobalStatsHash: bm25GlobalStats.bm25GlobalStatsHash,
    partitions: segments.map((segment) => ({
      partitionId: segment.partitionId,
      documentIdStart: segment.documentIdStart,
      documentIdEnd: segment.documentIdEnd,
      segmentHash: segment.hash,
      documentCount: segment.documentCount,
      byteLength: segment.bytes.length,
    })),
  };
  const canonicalManifestBytes = canonicalSnapshotManifestBytes(manifest);
  return {
    snapshotId: sha256(canonicalManifestBytes),
    canonicalManifestBytes,
    manifest,
    segments: segments.map((segment) => ({
      partitionId: segment.partitionId,
      hash: segment.hash,
      bytes: segment.bytes,
    })),
  };
}

function normalizeCanonicalSegment(segment: CanonicalSegment): CanonicalSegment {
  return {
    postings: normalizePostings(segment.postings),
    documents: normalizeDocuments(segment.documents ?? []),
    fieldTexts: normalizeFieldTexts(segment.fieldTexts ?? []),
    bm25: normalizeBm25Stats(segment.bm25 ?? []),
  };
}

function canonicalSections(segment: CanonicalSegment): Section[] {
  const postings = encodePostingsSectionWithDictionary(segment.postings);
  const fieldTexts = encodeFieldTextsSectionWithOffsets(segment.fieldTexts ?? []);
  const sections: Section[] = [
    { id: CANONICAL_SEGMENT_SECTION.postings, bytes: postings.bytes },
    {
      id: CANONICAL_SEGMENT_SECTION.docProjection,
      bytes: encodeDocProjectionSection({
        documents: segment.documents ?? [],
        fieldTexts: segment.fieldTexts ?? [],
        fieldTextOffsets: fieldTexts.offsets,
        bm25: segment.bm25 ?? [],
      }),
    },
    { id: CANONICAL_SEGMENT_SECTION.termDictionary, bytes: encodeTermDictionarySection(postings.termDictionary) },
  ];
  if ((segment.documents?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.documents, bytes: encodeDocumentsSection(segment.documents ?? []) });
  }
  if ((segment.fieldTexts?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.fieldTexts, bytes: fieldTexts.bytes });
  }
  if ((segment.bm25?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.bm25, bytes: encodeBm25Section(segment.bm25 ?? []) });
  }
  return sections.sort((left, right) => left.id - right.id);
}

function normalizePostings(postings: readonly CanonicalPosting[]): CanonicalPosting[] {
  const merged = new Map<string, { term: string; fieldId: number; docId: number; positions: Set<number> }>();
  for (const posting of postings) {
    const term = normalizeCanonicalString(posting.term, 'NFC');
    if (!term) continue;
    assertSafeUnsignedInteger(posting.fieldId, 'posting fieldId');
    assertSafeUnsignedInteger(posting.docId, 'posting docId');
    const key = `${term}\u0000${posting.fieldId}\u0000${posting.docId}`;
    const entry = merged.get(key) ?? {
      term,
      fieldId: posting.fieldId,
      docId: posting.docId,
      positions: new Set<number>(),
    };
    for (const position of posting.positions) {
      assertSafeUnsignedInteger(position, 'posting position');
      entry.positions.add(position);
    }
    merged.set(key, entry);
  }
  return [...merged.values()]
    .map((entry) => ({
      term: entry.term,
      fieldId: entry.fieldId,
      docId: entry.docId,
      positions: [...entry.positions].sort((left, right) => left - right),
    }))
    .filter((posting) => posting.positions.length > 0)
    .sort(comparePostings);
}

function comparePostings(left: CanonicalPosting, right: CanonicalPosting): number {
  const termOrder = compareBytes(utf8(left.term), utf8(right.term));
  if (termOrder !== 0) return termOrder;
  if (left.fieldId !== right.fieldId) return left.fieldId - right.fieldId;
  return left.docId - right.docId;
}

function normalizeDocuments(documents: readonly CanonicalDocumentRecord[]): CanonicalDocumentRecord[] {
  return documents
    .map((document) => ({
      documentId: normalizeHash(document.documentId, 'documentId'),
      path: normalizeVaultRelativePath(document.path),
      contentHash: normalizeHash(document.contentHash, 'contentHash'),
      parsedFieldHashes: normalizeHashRecord(document.parsedFieldHashes),
      snippetLineSpanHash: document.snippetLineSpanHash
        ? normalizeHash(document.snippetLineSpanHash, 'snippetLineSpanHash')
        : undefined,
      deleted: document.deleted === true,
    }))
    .sort((left, right) => compareByteStrings(left.documentId, right.documentId));
}

function normalizeFieldTexts(fieldTexts: readonly CanonicalFieldText[]): CanonicalFieldText[] {
  return fieldTexts
    .map((fieldText) => {
      assertSafeUnsignedInteger(fieldText.docId, 'field text docId');
      assertSafeUnsignedInteger(fieldText.fieldId, 'field text fieldId');
      assertFieldTextIsEncodable(fieldText.fieldId);
      return {
        docId: fieldText.docId,
        fieldId: fieldText.fieldId,
        text: normalizeCanonicalString(fieldText.text, 'NFKC'),
      };
    })
    .sort((left, right) => {
      if (left.docId !== right.docId) return left.docId - right.docId;
      return left.fieldId - right.fieldId;
    });
}

function assertFieldTextIsEncodable(fieldId: number): void {
  if (fieldId === fieldIdForSearchField('body')) {
    throw new Error('canonical fieldTexts cannot encode body field text');
  }
}

function normalizeBm25Stats(stats: readonly CanonicalBm25FieldStats[]): CanonicalBm25FieldStats[] {
  const normalized = stats
    .map((field) => {
      const channel = normalizeCanonicalString(field.channel, 'NFC');
      if (!channel) throw new Error('BM25 channel must not be empty');
      assertSafeUnsignedInteger(field.fieldId, 'BM25 fieldId');
      assertSafeUnsignedInteger(field.documentCount, 'BM25 documentCount');
      assertSafeUnsignedInteger(field.totalFieldLength, 'BM25 totalFieldLength');
      const documentLengths = field.documentLengths
        .map((entry) => {
          assertSafeUnsignedInteger(entry.docId, 'BM25 document length docId');
          assertSafeUnsignedInteger(entry.length, 'BM25 document length');
          return { docId: entry.docId, length: entry.length };
        })
        .sort((left, right) => left.docId - right.docId);
      assertNoDuplicateNumbers(
        documentLengths.map((entry) => entry.docId),
        'BM25 document length docId',
      );
      const documentFrequencies = mergeBm25DocumentFrequencies(field.documentFrequencies);
      return {
        channel,
        fieldId: field.fieldId,
        documentCount: field.documentCount,
        totalFieldLength: field.totalFieldLength,
        documentLengths,
        documentFrequencies,
      };
    })
    .sort(compareBm25FieldStats);
  assertNoDuplicateStrings(
    normalized.map((field) => bm25FieldKey(field.channel, field.fieldId)),
    'BM25 channel+field row',
  );
  return normalized;
}

function encodePostingsSectionWithDictionary(postings: readonly CanonicalPosting[]): {
  bytes: Uint8Array;
  termDictionary: CanonicalTermDictionaryEntry[];
} {
  const writer = new ByteWriter();
  const termDictionary: CanonicalTermDictionaryEntry[] = [];
  writer.writeUnsigned(postings.length);
  let current: { term: string; offset: number; count: number } | undefined;
  for (const posting of postings) {
    const rowOffset = writer.byteLength();
    if (!current || current.term !== posting.term) {
      if (current) {
        termDictionary.push({
          term: current.term,
          postingsOffset: current.offset,
          postingsByteLength: rowOffset - current.offset,
          postingCount: current.count,
        });
      }
      current = { term: posting.term, offset: rowOffset, count: 0 };
    }
    writePostingRow(writer, posting);
    current.count += 1;
  }
  if (current) {
    termDictionary.push({
      term: current.term,
      postingsOffset: current.offset,
      postingsByteLength: writer.byteLength() - current.offset,
      postingCount: current.count,
    });
  }
  return { bytes: writer.bytes(), termDictionary };
}

function decodePostingsSection(bytes: Uint8Array): CanonicalPosting[] {
  const reader = new ByteReader(bytes);
  const count = reader.readUnsigned();
  const postings: CanonicalPosting[] = [];
  for (let index = 0; index < count; index += 1) {
    postings.push(readCanonicalPostingRow(reader));
  }
  reader.assertDone();
  return normalizePostings(postings);
}

export function readCanonicalPostingRow(reader: ByteReader): CanonicalPosting {
  const term = reader.readString();
  const fieldId = reader.readUnsigned();
  const docId = reader.readUnsigned();
  const positionCount = reader.readUnsigned();
  const positions: number[] = [];
  let previous = -1;
  for (let positionIndex = 0; positionIndex < positionCount; positionIndex += 1) {
    const position = reader.readUnsigned();
    if (position <= previous) throw new Error('posting positions must be strictly increasing');
    positions.push(position);
    previous = position;
  }
  return { term, fieldId, docId, positions };
}

function writePostingRow(writer: ByteWriter, posting: CanonicalPosting): void {
  writer.writeString(posting.term);
  writer.writeUnsigned(posting.fieldId);
  writer.writeUnsigned(posting.docId);
  writer.writeUnsigned(posting.positions.length);
  let previous = -1;
  for (const position of posting.positions) {
    if (position <= previous) throw new Error('posting positions must be strictly increasing');
    writer.writeUnsigned(position);
    previous = position;
  }
}

function encodeDocumentsSection(documents: readonly CanonicalDocumentRecord[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(documents.length);
  for (const document of documents) {
    writer.writeString(document.documentId);
    writer.writeString(document.path);
    writer.writeString(document.contentHash);
    const fieldHashes = Object.entries(document.parsedFieldHashes ?? {}).sort(([left], [right]) =>
      compareByteStrings(left, right),
    );
    writer.writeUnsigned(fieldHashes.length);
    for (const [field, hash] of fieldHashes) {
      writer.writeString(field);
      writer.writeString(hash);
    }
    writer.writeString(document.snippetLineSpanHash ?? '');
    writer.writeUnsigned(document.deleted ? 1 : 0);
  }
  return writer.bytes();
}

function decodeDocumentsSection(bytes: Uint8Array): CanonicalDocumentRecord[] {
  const reader = new ByteReader(bytes);
  const count = reader.readUnsigned();
  const documents: CanonicalDocumentRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const documentId = reader.readString();
    const path = reader.readString();
    const contentHash = reader.readString();
    const parsedFieldHashCount = reader.readUnsigned();
    const parsedFieldHashes: Record<string, string> = {};
    for (let hashIndex = 0; hashIndex < parsedFieldHashCount; hashIndex += 1) {
      parsedFieldHashes[reader.readString()] = reader.readString();
    }
    const snippetLineSpanHash = reader.readString();
    const deleted = reader.readUnsigned() === 1;
    documents.push({
      documentId,
      path,
      contentHash,
      parsedFieldHashes,
      snippetLineSpanHash: snippetLineSpanHash || undefined,
      deleted,
    });
  }
  reader.assertDone();
  return normalizeDocuments(documents);
}

function encodeFieldTextsSectionWithOffsets(fieldTexts: readonly CanonicalFieldText[]): {
  bytes: Uint8Array;
  offsets: ReadonlyMap<string, { offset: number; byteLength: number }>;
} {
  const writer = new ByteWriter();
  const offsets = new Map<string, { offset: number; byteLength: number }>();
  writer.writeUnsigned(fieldTexts.length);
  for (const fieldText of fieldTexts) {
    assertFieldTextIsEncodable(fieldText.fieldId);
    const offset = writer.byteLength();
    writer.writeUnsigned(fieldText.docId);
    writer.writeUnsigned(fieldText.fieldId);
    writer.writeString(fieldText.text);
    offsets.set(docFieldKey(fieldText.docId, fieldText.fieldId), {
      offset,
      byteLength: writer.byteLength() - offset,
    });
  }
  return { bytes: writer.bytes(), offsets };
}

function decodeFieldTextsSection(bytes: Uint8Array): CanonicalFieldText[] {
  const reader = new ByteReader(bytes);
  const count = reader.readUnsigned();
  const fieldTexts: CanonicalFieldText[] = [];
  for (let index = 0; index < count; index += 1) {
    fieldTexts.push({
      docId: reader.readUnsigned(),
      fieldId: reader.readUnsigned(),
      text: reader.readString(),
    });
  }
  reader.assertDone();
  return normalizeFieldTexts(fieldTexts);
}

function encodeBm25Section(stats: readonly CanonicalBm25FieldStats[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(CANONICAL_BM25_STATS_SCHEMA_ID);
  writer.writeUnsigned(stats.length);
  for (const field of stats) {
    writer.writeString(field.channel);
    writer.writeUnsigned(field.fieldId);
    writer.writeUnsigned(field.documentCount);
    writer.writeUnsigned(field.totalFieldLength);
    writer.writeUnsigned(field.documentLengths.length);
    for (const entry of field.documentLengths) {
      writer.writeUnsigned(entry.docId);
      writer.writeUnsigned(entry.length);
    }
    writer.writeUnsigned(field.documentFrequencies.length);
    for (const entry of field.documentFrequencies) {
      writer.writeString(entry.term);
      writer.writeUnsigned(entry.frequency);
    }
  }
  return writer.bytes();
}

function decodeBm25Section(bytes: Uint8Array): CanonicalBm25FieldStats[] {
  const reader = new ByteReader(bytes);
  const schemaId = reader.readUnsigned();
  if (schemaId !== CANONICAL_BM25_STATS_SCHEMA_ID) throw new Error(`unsupported BM25 stats schema ${schemaId}`);
  const count = reader.readUnsigned();
  const stats: CanonicalBm25FieldStats[] = [];
  for (let index = 0; index < count; index += 1) {
    const channel = reader.readString();
    const fieldId = reader.readUnsigned();
    const documentCount = reader.readUnsigned();
    const totalFieldLength = reader.readUnsigned();
    const documentLengthCount = reader.readUnsigned();
    const documentLengths: { docId: number; length: number }[] = [];
    for (let lengthIndex = 0; lengthIndex < documentLengthCount; lengthIndex += 1) {
      documentLengths.push({ docId: reader.readUnsigned(), length: reader.readUnsigned() });
    }
    const dfCount = reader.readUnsigned();
    const documentFrequencies: { term: string; frequency: number }[] = [];
    for (let dfIndex = 0; dfIndex < dfCount; dfIndex += 1) {
      documentFrequencies.push({ term: reader.readString(), frequency: reader.readUnsigned() });
    }
    stats.push({ channel, fieldId, documentCount, totalFieldLength, documentLengths, documentFrequencies });
  }
  reader.assertDone();
  return normalizeBm25Stats(stats);
}

export function decodeCanonicalBm25Section(bytes: Uint8Array): CanonicalBm25FieldStats[] {
  return decodeBm25Section(bytes);
}

type DocProjectionBuildInput = {
  documents: readonly CanonicalDocumentRecord[];
  fieldTexts: readonly CanonicalFieldText[];
  fieldTextOffsets: ReadonlyMap<string, { offset: number; byteLength: number }>;
  bm25: readonly CanonicalBm25FieldStats[];
};

type DocProjectionRowInput = {
  localDocId: number;
  documentId: string;
  path: string;
  pathIdentityKey: string;
  filenameStemKey: string;
  titleKeys: readonly string[];
  aliasKeys: readonly string[];
  headingKeys: readonly string[];
  pathSegmentKeys: readonly string[];
  tags: readonly string[];
  fieldLengths: readonly CanonicalDocProjectionFieldLength[];
  offsets: readonly CanonicalDocProjectionOffsets[];
};

type DocProjectionHeader = {
  documentCount: number;
  stringTableOffset: number;
  tagDictionaryOffset: number;
  rowsOffset: number;
  identityRefsOffset: number;
  tagIdsOffset: number;
  fieldLengthsOffset: number;
  offsetsOffset: number;
  endOffset: number;
};

function encodeDocProjectionSection(input: DocProjectionBuildInput): Uint8Array {
  const rows = buildDocProjectionRows(input);
  const strings = docProjectionStringTable(rows);
  const stringRefs = new Map(strings.map((value, index) => [value, index]));
  const tagStrings = docProjectionTagDictionary(rows);
  const tagRefs = tagStrings.map((tag) => requiredStringRef(stringRefs, tag));
  const tagIdsByTag = new Map(tagStrings.map((tag, index) => [tag, index]));
  const identityRefs: number[] = [];
  const tagIds: number[] = [];
  const fieldLengths: Array<[number, number, number]> = [];
  const offsetRows: Array<[number, number, number, number, number, number]> = [];
  const rowWords: number[][] = [];

  for (const row of rows) {
    const titleSpan = pushNumericSpan(
      identityRefs,
      row.titleKeys.map((key) => requiredStringRef(stringRefs, key)),
    );
    const aliasSpan = pushNumericSpan(
      identityRefs,
      row.aliasKeys.map((key) => requiredStringRef(stringRefs, key)),
    );
    const headingSpan = pushNumericSpan(
      identityRefs,
      row.headingKeys.map((key) => requiredStringRef(stringRefs, key)),
    );
    const pathSegmentSpan = pushNumericSpan(
      identityRefs,
      row.pathSegmentKeys.map((key) => requiredStringRef(stringRefs, key)),
    );
    const tagSpan = pushNumericSpan(
      tagIds,
      row.tags.map((tag) => requiredTagId(tagIdsByTag, tag)),
    );
    const fieldLengthSpan = pushRowSpan(
      fieldLengths,
      row.fieldLengths.map((entry) => [requiredStringRef(stringRefs, entry.channel), entry.fieldId, entry.length]),
    );
    const offsetSpan = pushRowSpan(
      offsetRows,
      row.offsets.map((entry) => [
        requiredStringRef(stringRefs, entry.channel),
        entry.fieldId,
        entry.fieldTextOffset,
        entry.fieldTextByteLength,
        entry.postingsOffset,
        entry.postingsByteLength,
      ]),
    );
    rowWords.push([
      row.localDocId,
      requiredStringRef(stringRefs, row.documentId),
      requiredStringRef(stringRefs, row.path),
      refPlusOne(stringRefs, row.pathIdentityKey),
      refPlusOne(stringRefs, row.filenameStemKey),
      titleSpan.offset,
      titleSpan.count,
      aliasSpan.offset,
      aliasSpan.count,
      headingSpan.offset,
      headingSpan.count,
      pathSegmentSpan.offset,
      pathSegmentSpan.count,
      tagSpan.offset,
      tagSpan.count,
      fieldLengthSpan.offset,
      fieldLengthSpan.count,
      offsetSpan.offset,
      offsetSpan.count,
    ]);
  }

  const stringTable = encodeDocProjectionStringTable(strings);
  const tagDictionary = encodeDocProjectionFixedRows(tagRefs.map((ref) => [ref]));
  const rowTable = encodeDocProjectionFixedRows(rowWords);
  const identityRefTable = encodeDocProjectionFixedRows(identityRefs.map((ref) => [ref]));
  const tagIdTable = encodeDocProjectionFixedRows(tagIds.map((tagId) => [tagId]));
  const fieldLengthTable = encodeDocProjectionFixedRows(fieldLengths);
  const offsetTable = encodeDocProjectionFixedRows(offsetRows);
  const header = encodeDocProjectionHeader(rows.length, {
    stringTableLength: stringTable.length,
    tagDictionaryLength: tagDictionary.length,
    rowTableLength: rowTable.length,
    identityRefTableLength: identityRefTable.length,
    tagIdTableLength: tagIdTable.length,
    fieldLengthTableLength: fieldLengthTable.length,
    offsetTableLength: offsetTable.length,
  });
  return concatBytes([
    header,
    stringTable,
    tagDictionary,
    rowTable,
    identityRefTable,
    tagIdTable,
    fieldLengthTable,
    offsetTable,
  ]);
}

function buildDocProjectionRows(input: DocProjectionBuildInput): DocProjectionRowInput[] {
  const textByDocField = new Map(
    input.fieldTexts.map((fieldText) => [docFieldKey(fieldText.docId, fieldText.fieldId), fieldText.text]),
  );
  const lengthsByDoc = docProjectionFieldLengthsByDoc(input.bm25);
  return input.documents.map((document, index) => {
    const localDocId = index + 1;
    const pathStem = filenameStem(document.path);
    const tags = normalizedDocProjectionTags(
      textByDocField.get(docFieldKey(localDocId, fieldIdForSearchField('tags'))) ?? '',
    );
    const fieldLengths = lengthsByDoc.get(localDocId) ?? [];
    return {
      localDocId,
      documentId: document.documentId,
      path: document.path,
      pathIdentityKey: firstIdentityKey(document.path),
      filenameStemKey: firstIdentityKey(pathStem),
      titleKeys: identityKeysForText(textByDocField.get(docFieldKey(localDocId, fieldIdForSearchField('title'))) ?? ''),
      aliasKeys: identityKeysForLines(
        textByDocField.get(docFieldKey(localDocId, fieldIdForSearchField('aliases'))) ?? '',
      ),
      headingKeys: identityKeysForLines(
        textByDocField.get(docFieldKey(localDocId, fieldIdForSearchField('headings'))) ?? '',
      ),
      pathSegmentKeys: identityKeysForValues(pathSegments(document.path)),
      tags,
      fieldLengths,
      offsets: docProjectionOffsets(localDocId, fieldLengths, input.fieldTextOffsets),
    };
  });
}

function docProjectionFieldLengthsByDoc(
  bm25: readonly CanonicalBm25FieldStats[],
): ReadonlyMap<number, readonly CanonicalDocProjectionFieldLength[]> {
  const byDoc = new Map<number, CanonicalDocProjectionFieldLength[]>();
  for (const field of bm25) {
    for (const length of field.documentLengths) {
      const entries = byDoc.get(length.docId) ?? [];
      entries.push({
        channel: field.channel,
        fieldId: field.fieldId,
        length: length.length,
      });
      byDoc.set(length.docId, entries);
    }
  }
  for (const [docId, entries] of byDoc) {
    byDoc.set(docId, entries.sort(compareProjectionFieldLength));
  }
  return byDoc;
}

function docProjectionOffsets(
  localDocId: number,
  fieldLengths: readonly CanonicalDocProjectionFieldLength[],
  fieldTextOffsets: ReadonlyMap<string, { offset: number; byteLength: number }>,
): CanonicalDocProjectionOffsets[] {
  return fieldLengths
    .map((entry) => {
      const fieldText = fieldTextOffsets.get(docFieldKey(localDocId, entry.fieldId));
      return {
        channel: entry.channel,
        fieldId: entry.fieldId,
        fieldTextOffset: fieldText?.offset ?? 0,
        fieldTextByteLength: fieldText?.byteLength ?? 0,
        postingsOffset: 0,
        postingsByteLength: 0,
      };
    })
    .sort(compareProjectionOffsets);
}

function encodeDocProjectionHeader(
  documentCount: number,
  lengths: {
    stringTableLength: number;
    tagDictionaryLength: number;
    rowTableLength: number;
    identityRefTableLength: number;
    tagIdTableLength: number;
    fieldLengthTableLength: number;
    offsetTableLength: number;
  },
): Uint8Array {
  const headerLength = docProjectionHeaderLength(documentCount);
  let offset = headerLength;
  const stringTableOffset = offset;
  offset += lengths.stringTableLength;
  const tagDictionaryOffset = offset;
  offset += lengths.tagDictionaryLength;
  const rowsOffset = offset;
  offset += lengths.rowTableLength;
  const identityRefsOffset = offset;
  offset += lengths.identityRefTableLength;
  const tagIdsOffset = offset;
  offset += lengths.tagIdTableLength;
  const fieldLengthsOffset = offset;
  offset += lengths.fieldLengthTableLength;
  const offsetsOffset = offset;
  offset += lengths.offsetTableLength;

  const writer = new ByteWriter();
  writer.writeUnsigned(CANONICAL_DOC_PROJECTION_SCHEMA_ID);
  writer.writeUnsigned(documentCount);
  for (const value of [
    stringTableOffset,
    tagDictionaryOffset,
    rowsOffset,
    identityRefsOffset,
    tagIdsOffset,
    fieldLengthsOffset,
    offsetsOffset,
    offset,
  ]) {
    writer.writeFixedUnsigned64(value);
  }
  return writer.bytes();
}

function docProjectionHeaderLength(documentCount: number): number {
  const writer = new ByteWriter();
  writer.writeUnsigned(CANONICAL_DOC_PROJECTION_SCHEMA_ID);
  writer.writeUnsigned(documentCount);
  for (let index = 0; index < DOC_PROJECTION_HEADER_FIXED_OFFSET_COUNT; index += 1) writer.writeFixedUnsigned64(0);
  return writer.byteLength();
}

function encodeDocProjectionStringTable(strings: readonly string[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(strings.length);
  const chunks = strings.map((value) => {
    const chunk = new ByteWriter();
    chunk.writeString(value);
    return chunk.bytes();
  });
  let offset = 0;
  for (const chunk of chunks) {
    writer.writeFixedUnsigned64(offset);
    offset += chunk.length;
  }
  for (const chunk of chunks) writer.writeBytes(chunk);
  return writer.bytes();
}

function encodeDocProjectionFixedRows(rows: readonly (readonly number[])[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(rows.length);
  for (const row of rows) {
    for (const value of row) writer.writeFixedUnsigned64(value);
  }
  return writer.bytes();
}

function docProjectionStringTable(rows: readonly DocProjectionRowInput[]): string[] {
  const strings = new Set<string>();
  for (const row of rows) {
    strings.add(row.documentId);
    strings.add(row.path);
    if (row.pathIdentityKey) strings.add(row.pathIdentityKey);
    if (row.filenameStemKey) strings.add(row.filenameStemKey);
    for (const value of row.titleKeys) strings.add(value);
    for (const value of row.aliasKeys) strings.add(value);
    for (const value of row.headingKeys) strings.add(value);
    for (const value of row.pathSegmentKeys) strings.add(value);
    for (const tag of row.tags) strings.add(tag);
    for (const length of row.fieldLengths) strings.add(length.channel);
    for (const offset of row.offsets) strings.add(offset.channel);
  }
  return [...strings].sort(compareByteStrings);
}

function docProjectionTagDictionary(rows: readonly DocProjectionRowInput[]): string[] {
  const tags = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags) tags.add(tag);
  }
  return [...tags].sort(compareByteStrings);
}

function pushNumericSpan(target: number[], values: readonly number[]): { offset: number; count: number } {
  const offset = target.length;
  target.push(...values);
  return { offset, count: values.length };
}

function pushRowSpan<T>(target: T[], values: readonly T[]): { offset: number; count: number } {
  const offset = target.length;
  target.push(...values);
  return { offset, count: values.length };
}

function requiredStringRef(refs: ReadonlyMap<string, number>, value: string): number {
  const ref = refs.get(value);
  if (ref === undefined) throw new Error(`missing docProjection string ref for ${JSON.stringify(value)}`);
  return ref;
}

function refPlusOne(refs: ReadonlyMap<string, number>, value: string): number {
  if (!value) return 0;
  return requiredStringRef(refs, value) + 1;
}

function requiredTagId(refs: ReadonlyMap<string, number>, value: string): number {
  const ref = refs.get(value);
  if (ref === undefined) throw new Error(`missing docProjection tag ref for ${JSON.stringify(value)}`);
  return ref;
}

function firstIdentityKey(value: string): string {
  return identityPhraseCandidates(value)[0] ?? '';
}

function identityKeysForText(value: string): string[] {
  return identityKeysForValues([value]);
}

function identityKeysForLines(value: string): string[] {
  return identityKeysForValues(value.split(/\r?\n/u));
}

function identityKeysForValues(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => identityPhraseCandidates(value)).filter(Boolean))].sort(
    compareByteStrings,
  );
}

function normalizedDocProjectionTags(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map(normalizeTagKey).filter(Boolean))].sort(compareByteStrings);
}

function normalizeTagKey(value: string): string {
  return value.replace(/^#+/u, '').trim().toLowerCase().normalize('NFC');
}

function filenameStem(relPath: string): string {
  return path.posix.basename(relPath, path.posix.extname(relPath));
}

function pathSegments(relPath: string): string[] {
  const dirname = path.posix.dirname(relPath);
  return !dirname || dirname === '.' ? [] : dirname.split('/').filter(Boolean);
}

function fieldIdForSearchField(field: SearchField): number {
  const index = SEARCH_PROPERTIES.indexOf(field);
  if (index < 0) throw new Error(`unknown search field ${field}`);
  return index;
}

function compareProjectionFieldLength(
  left: CanonicalDocProjectionFieldLength,
  right: CanonicalDocProjectionFieldLength,
): number {
  const channelOrder = compareByteStrings(left.channel, right.channel);
  if (channelOrder !== 0) return channelOrder;
  return left.fieldId - right.fieldId;
}

function compareProjectionOffsets(left: CanonicalDocProjectionOffsets, right: CanonicalDocProjectionOffsets): number {
  const channelOrder = compareByteStrings(left.channel, right.channel);
  if (channelOrder !== 0) return channelOrder;
  return left.fieldId - right.fieldId;
}

export class ProjectionReader {
  private readonly bytes: Uint8Array;
  private readonly header: DocProjectionHeader;
  private readonly stringTable: { count: number; offsets: readonly number[]; entriesStart: number; end: number };
  private readonly tagStringRefs: readonly number[];
  readonly fieldTextsByteLength: number | undefined;

  constructor(segmentBytes: Uint8Array, options: { sectionOnly?: boolean; validate?: boolean } = {}) {
    const validate = options.validate ?? true;
    const projectionBytes = options.sectionOnly
      ? segmentBytes
      : canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.docProjection);
    if (!projectionBytes) throw new Error('canonical segment missing docProjection section');
    const fieldTextsBytes = options.sectionOnly
      ? undefined
      : canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.fieldTexts);
    this.bytes = projectionBytes;
    this.fieldTextsByteLength = fieldTextsBytes?.byteLength;
    this.header = readDocProjectionHeader(this.bytes);
    this.stringTable = readDocProjectionStringTable(
      this.bytes,
      this.header.stringTableOffset,
      this.header.tagDictionaryOffset,
      validate,
    );
    this.tagStringRefs = readDocProjectionSingleColumnTable(
      this.bytes,
      this.header.tagDictionaryOffset,
      this.header.rowsOffset,
    );
    if (validate) validateProjectionReader(this);
  }

  static fromSectionBytes(bytes: Uint8Array, options: { validate?: boolean } = {}): ProjectionReader {
    return new ProjectionReader(bytes, { sectionOnly: true, validate: options.validate });
  }

  documentCount(): number {
    return this.header.documentCount;
  }

  doc(localDocId: number): CanonicalDocProjectionDoc {
    const row = this.row(localDocId);
    return {
      localDocId: row[0],
      documentId: this.stringAt(row[1]),
      path: this.stringAt(row[2]),
    };
  }

  identityKeys(localDocId: number): CanonicalDocProjectionIdentityKeys {
    const row = this.row(localDocId);
    return {
      path: this.optionalString(row[3]),
      filenameStem: this.optionalString(row[4]),
      title: this.stringSpan(this.header.identityRefsOffset, this.header.tagIdsOffset, row[5], row[6]),
      aliases: this.stringSpan(this.header.identityRefsOffset, this.header.tagIdsOffset, row[7], row[8]),
      headings: this.stringSpan(this.header.identityRefsOffset, this.header.tagIdsOffset, row[9], row[10]),
      pathSegments: this.stringSpan(this.header.identityRefsOffset, this.header.tagIdsOffset, row[11], row[12]),
    };
  }

  tagIds(localDocId: number): readonly number[] {
    const row = this.row(localDocId);
    return this.numberSpan(this.header.tagIdsOffset, this.header.fieldLengthsOffset, row[13], row[14]);
  }

  tagForId(tagId: number): string {
    assertSafeUnsignedInteger(tagId, 'docProjection tagId');
    if (tagId >= this.tagStringRefs.length) throw new Error('docProjection tagId is invalid');
    return this.stringAt(this.tagStringRefs[tagId]);
  }

  tagIdForTag(tag: string): number | undefined {
    const normalized = normalizeTagKey(tag);
    let low = 0;
    let high = this.tagStringRefs.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const order = compareByteStrings(normalized, this.tagForId(mid));
      if (order === 0) return mid;
      if (order < 0) high = mid - 1;
      else low = mid + 1;
    }
    return undefined;
  }

  fieldLengths(localDocId: number): readonly CanonicalDocProjectionFieldLength[] {
    const row = this.row(localDocId);
    return this.fieldLengthSpan(row[15], row[16]);
  }

  fieldLength(localDocId: number, channel: string, fieldId: number): number {
    return (
      this.fieldLengths(localDocId).find((entry) => entry.channel === channel && entry.fieldId === fieldId)?.length ?? 0
    );
  }

  offsets(localDocId: number, channel: string, fieldId: number): readonly CanonicalDocProjectionOffsets[] {
    return this.allOffsets(localDocId).filter((entry) => entry.channel === channel && entry.fieldId === fieldId);
  }

  allOffsets(localDocId: number): readonly CanonicalDocProjectionOffsets[] {
    const row = this.row(localDocId);
    return this.offsetSpan(row[17], row[18]);
  }

  private row(localDocId: number): readonly number[] {
    assertSafeUnsignedInteger(localDocId, 'docProjection localDocId');
    if (localDocId <= 0 || localDocId > this.header.documentCount)
      throw new Error('docProjection localDocId is out of range');
    const rowCount = readProjectionTableCount(this.bytes, this.header.rowsOffset, this.header.identityRefsOffset);
    if (rowCount !== this.header.documentCount) throw new Error('docProjection row count must match documentCount');
    const rowsStart = projectionFixedTableRowsStart(this.bytes, this.header.rowsOffset);
    const offset = rowsStart + (localDocId - 1) * DOC_PROJECTION_ROW_WORDS * 8;
    const row = readFixedRow(this.bytes, offset, DOC_PROJECTION_ROW_WORDS);
    if (row[0] !== localDocId) throw new Error('docProjection rows must be sorted by localDocId');
    return row;
  }

  private stringAt(index: number): string {
    assertSafeUnsignedInteger(index, 'docProjection string ref');
    if (index >= this.stringTable.count) throw new Error('docProjection string ref is invalid');
    const start = this.stringTable.entriesStart + this.stringTable.offsets[index];
    const end =
      index + 1 < this.stringTable.count
        ? this.stringTable.entriesStart + this.stringTable.offsets[index + 1]
        : this.stringTable.end;
    const reader = new ByteReader(this.bytes.subarray(start, end));
    const value = reader.readString();
    reader.assertDone();
    return value;
  }

  private optionalString(refPlusOneValue: number): string {
    return refPlusOneValue > 0 ? this.stringAt(refPlusOneValue - 1) : '';
  }

  private numberSpan(tableOffset: number, tableEnd: number, offset: number, count: number): number[] {
    const tableCount = readProjectionTableCount(this.bytes, tableOffset, tableEnd);
    if (offset + count > tableCount) throw new Error('docProjection numeric span is out of range');
    const start = projectionFixedTableRowsStart(this.bytes, tableOffset) + offset * 8;
    const output: number[] = [];
    for (let index = 0; index < count; index += 1) output.push(readFixedUnsigned64(this.bytes, start + index * 8));
    return output;
  }

  private stringSpan(tableOffset: number, tableEnd: number, offset: number, count: number): string[] {
    return this.numberSpan(tableOffset, tableEnd, offset, count).map((ref) => this.stringAt(ref));
  }

  private fieldLengthSpan(offset: number, count: number): CanonicalDocProjectionFieldLength[] {
    const tableCount = readProjectionTableCount(this.bytes, this.header.fieldLengthsOffset, this.header.offsetsOffset);
    if (offset + count > tableCount) throw new Error('docProjection field length span is out of range');
    const start =
      projectionFixedTableRowsStart(this.bytes, this.header.fieldLengthsOffset) +
      offset * DOC_PROJECTION_FIELD_LENGTH_WORDS * 8;
    const output: CanonicalDocProjectionFieldLength[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = readFixedRow(
        this.bytes,
        start + index * DOC_PROJECTION_FIELD_LENGTH_WORDS * 8,
        DOC_PROJECTION_FIELD_LENGTH_WORDS,
      );
      output.push({
        channel: this.stringAt(row[0]),
        fieldId: row[1],
        length: row[2],
      });
    }
    return output;
  }

  private offsetSpan(offset: number, count: number): CanonicalDocProjectionOffsets[] {
    const tableCount = readProjectionTableCount(this.bytes, this.header.offsetsOffset, this.header.endOffset);
    if (offset + count > tableCount) throw new Error('docProjection offset span is out of range');
    const start =
      projectionFixedTableRowsStart(this.bytes, this.header.offsetsOffset) + offset * DOC_PROJECTION_OFFSET_WORDS * 8;
    const output: CanonicalDocProjectionOffsets[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = readFixedRow(
        this.bytes,
        start + index * DOC_PROJECTION_OFFSET_WORDS * 8,
        DOC_PROJECTION_OFFSET_WORDS,
      );
      output.push({
        channel: this.stringAt(row[0]),
        fieldId: row[1],
        fieldTextOffset: row[2],
        fieldTextByteLength: row[3],
        postingsOffset: row[4],
        postingsByteLength: row[5],
      });
    }
    return output;
  }
}

function readDocProjectionHeader(bytes: Uint8Array): DocProjectionHeader {
  const reader = new ByteReader(bytes);
  const schemaId = reader.readUnsigned();
  if (schemaId !== CANONICAL_DOC_PROJECTION_SCHEMA_ID) throw new Error(`unsupported docProjection schema ${schemaId}`);
  const documentCount = reader.readUnsigned();
  let offset = reader.position();
  const values: number[] = [];
  for (let index = 0; index < DOC_PROJECTION_HEADER_FIXED_OFFSET_COUNT; index += 1) {
    values.push(readFixedUnsigned64(bytes, offset));
    offset += 8;
  }
  const header = {
    documentCount,
    stringTableOffset: values[0],
    tagDictionaryOffset: values[1],
    rowsOffset: values[2],
    identityRefsOffset: values[3],
    tagIdsOffset: values[4],
    fieldLengthsOffset: values[5],
    offsetsOffset: values[6],
    endOffset: values[7],
  };
  validateProjectionOffsets(header, offset, bytes.length);
  return header;
}

function validateProjectionOffsets(header: DocProjectionHeader, minimumOffset: number, byteLength: number): void {
  const offsets = [
    header.stringTableOffset,
    header.tagDictionaryOffset,
    header.rowsOffset,
    header.identityRefsOffset,
    header.tagIdsOffset,
    header.fieldLengthsOffset,
    header.offsetsOffset,
    header.endOffset,
  ];
  let previous = minimumOffset - 1;
  for (const offset of offsets) {
    if (offset <= previous || offset > byteLength) throw new Error('docProjection table offsets are invalid');
    previous = offset;
  }
  if (header.endOffset !== byteLength) throw new Error('docProjection section contains trailing bytes');
}

function readDocProjectionStringTable(
  bytes: Uint8Array,
  tableOffset: number,
  tableEnd: number,
  validate: boolean,
): { count: number; offsets: readonly number[]; entriesStart: number; end: number } {
  const reader = new ByteReader(bytes.subarray(tableOffset, tableEnd));
  const count = reader.readUnsigned();
  const offsetTableStart = tableOffset + reader.position();
  const entriesStart = offsetTableStart + count * 8;
  if (entriesStart > tableEnd) throw new Error('docProjection string table is truncated');
  const offsets: number[] = [];
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    const offset = readFixedUnsigned64(bytes, offsetTableStart + index * 8);
    if (offset <= previous && index > 0) throw new Error('docProjection string offsets must be strictly increasing');
    if (entriesStart + offset >= tableEnd && count > 0) throw new Error('docProjection string offset is invalid');
    offsets.push(offset);
    previous = offset;
  }
  if (validate) {
    let previousString: string | undefined;
    for (let index = 0; index < count; index += 1) {
      const start = entriesStart + offsets[index];
      const end = index + 1 < count ? entriesStart + offsets[index + 1] : tableEnd;
      const stringReader = new ByteReader(bytes.subarray(start, end));
      const value = stringReader.readString();
      stringReader.assertDone();
      if (previousString !== undefined && compareByteStrings(previousString, value) >= 0) {
        throw new Error('docProjection string table must be sorted by UTF-8 bytes');
      }
      previousString = value;
    }
  }
  return { count, offsets, entriesStart, end: tableEnd };
}

function readDocProjectionSingleColumnTable(bytes: Uint8Array, tableOffset: number, tableEnd: number): number[] {
  const count = readProjectionTableCount(bytes, tableOffset, tableEnd);
  const rowsStart = projectionFixedTableRowsStart(bytes, tableOffset);
  if (rowsStart + count * 8 !== tableEnd) throw new Error('docProjection single-column table length is invalid');
  const output: number[] = [];
  for (let index = 0; index < count; index += 1) output.push(readFixedUnsigned64(bytes, rowsStart + index * 8));
  return output;
}

function readProjectionTableCount(bytes: Uint8Array, tableOffset: number, tableEnd: number): number {
  const read = decodeUnsignedLeb128(bytes, tableOffset);
  if (read.offset > tableEnd) throw new Error('docProjection fixed table is truncated');
  return read.value;
}

function projectionFixedTableRowsStart(bytes: Uint8Array, tableOffset: number): number {
  return decodeUnsignedLeb128(bytes, tableOffset).offset;
}

function readFixedRow(bytes: Uint8Array, offset: number, words: number): number[] {
  const row: number[] = [];
  for (let index = 0; index < words; index += 1) row.push(readFixedUnsigned64(bytes, offset + index * 8));
  return row;
}

function validateProjectionReader(reader: ProjectionReader): void {
  for (let localDocId = 1; localDocId <= reader.documentCount(); localDocId += 1) {
    const doc = reader.doc(localDocId);
    if (doc.localDocId !== localDocId) throw new Error('docProjection row localDocId mismatch');
    assertSortedUniqueNumbers(reader.tagIds(localDocId), 'docProjection tag ids');
    assertSortedUniqueProjectionFieldLengths(reader.fieldLengths(localDocId));
    const offsets = reader.allOffsets(localDocId);
    assertSortedUniqueProjectionOffsets(offsets);
    for (const offset of offsets) {
      if (
        reader.fieldTextsByteLength !== undefined &&
        offset.fieldTextByteLength > 0 &&
        offset.fieldTextOffset + offset.fieldTextByteLength > reader.fieldTextsByteLength
      ) {
        throw new Error('docProjection fieldText offset is out of range');
      }
    }
  }
}

function validateDocProjectionSection(
  bytes: Uint8Array,
  documents: readonly CanonicalDocumentRecord[],
  fieldTexts: readonly CanonicalFieldText[],
  bm25: readonly CanonicalBm25FieldStats[],
): void {
  void fieldTexts;
  void bm25;
  const reader = ProjectionReader.fromSectionBytes(bytes);
  if (reader.documentCount() !== documents.length)
    throw new Error('docProjection documentCount does not match documents section');
  for (let index = 0; index < documents.length; index += 1) {
    const projected = reader.doc(index + 1);
    const document = documents[index];
    if (!document || projected.documentId !== document.documentId || projected.path !== document.path) {
      throw new Error('docProjection document row does not match documents section');
    }
  }
}

function assertSortedUniqueProjectionFieldLengths(values: readonly CanonicalDocProjectionFieldLength[]): void {
  let previous: string | undefined;
  for (const value of values) {
    const key = `${value.channel}\u0000${value.fieldId}`;
    if (previous !== undefined && compareByteStrings(previous, key) >= 0) {
      throw new Error('docProjection field lengths must be sorted and unique');
    }
    previous = key;
  }
}

function assertSortedUniqueProjectionOffsets(values: readonly CanonicalDocProjectionOffsets[]): void {
  let previous: string | undefined;
  for (const value of values) {
    const key = `${value.channel}\u0000${value.fieldId}`;
    if (previous !== undefined && compareByteStrings(previous, key) >= 0) {
      throw new Error('docProjection offsets must be sorted and unique');
    }
    previous = key;
  }
}

function assertSortedUniqueNumbers(values: readonly number[], label: string): void {
  let previous: number | undefined;
  for (const value of values) {
    if (previous !== undefined && value <= previous) throw new Error(`${label} must be sorted and unique`);
    previous = value;
  }
}

function encodeTermDictionarySection(entries: readonly CanonicalTermDictionaryEntry[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(CANONICAL_TERM_DICTIONARY_SCHEMA_ID);
  writer.writeUnsigned(entries.length);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    writer.writeFixedUnsigned64(offset);
    const chunk = encodeTermDictionaryEntry(entry);
    chunks.push(chunk);
    offset += chunk.length;
  }
  for (const chunk of chunks) writer.writeBytes(chunk);
  return writer.bytes();
}

function encodeTermDictionaryEntry(entry: CanonicalTermDictionaryEntry): Uint8Array {
  const writer = new ByteWriter();
  writer.writeString(entry.term);
  writer.writeUnsigned(entry.postingsOffset);
  writer.writeUnsigned(entry.postingsByteLength);
  writer.writeUnsigned(entry.postingCount);
  return writer.bytes();
}

function decodeCanonicalTermDictionarySection(bytes: Uint8Array): CanonicalTermDictionaryEntry[] {
  const view = termDictionaryView(bytes);
  const offsets = termDictionaryEntryOffsets(bytes, view);
  const entries: CanonicalTermDictionaryEntry[] = [];
  let previousTerm: string | undefined;
  for (let index = 0; index < view.count; index += 1) {
    const start = view.entriesStart + offsets[index];
    const end = index + 1 < offsets.length ? view.entriesStart + offsets[index + 1] : bytes.length;
    const reader = new ByteReader(bytes.subarray(start, end));
    const entry: CanonicalTermDictionaryEntry = {
      term: reader.readString(),
      postingsOffset: reader.readUnsigned(),
      postingsByteLength: reader.readUnsigned(),
      postingCount: reader.readUnsigned(),
    };
    reader.assertDone();
    assertSafeUnsignedInteger(entry.postingsOffset, 'term dictionary postingsOffset');
    assertSafeUnsignedInteger(entry.postingsByteLength, 'term dictionary postingsByteLength');
    assertSafeUnsignedInteger(entry.postingCount, 'term dictionary postingCount');
    if (entry.postingCount <= 0) throw new Error('term dictionary postingCount must be positive');
    if (entry.postingsByteLength <= 0) throw new Error('term dictionary postingsByteLength must be positive');
    if (previousTerm !== undefined && compareBytes(utf8(previousTerm), utf8(entry.term)) >= 0) {
      throw new Error('term dictionary entries must be sorted by term bytes');
    }
    previousTerm = entry.term;
    entries.push(entry);
  }
  return entries;
}

export function lookupCanonicalTermDictionaryEntry(
  bytes: Uint8Array,
  term: string,
): CanonicalTermDictionaryEntry | undefined {
  const normalizedTerm = term.normalize('NFC');
  const needle = utf8(normalizedTerm);
  const view = termDictionaryView(bytes);
  let low = 0;
  let high = view.count - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entryOffset = readFixedUnsigned64(bytes, view.offsetTableStart + mid * 8);
    const absoluteOffset = view.entriesStart + entryOffset;
    if (absoluteOffset < view.entriesStart || absoluteOffset >= bytes.length) {
      throw new Error('term dictionary entry offset is invalid');
    }
    const length = decodeUnsignedLeb128(bytes, absoluteOffset);
    const termStart = length.offset;
    const termEnd = termStart + length.value;
    if (termEnd > bytes.length) throw new Error('truncated term dictionary entry term');
    const order = compareBytes(needle, bytes.subarray(termStart, termEnd));
    if (order === 0) {
      const postingsOffset = decodeUnsignedLeb128(bytes, termEnd);
      const postingsByteLength = decodeUnsignedLeb128(bytes, postingsOffset.offset);
      const postingCount = decodeUnsignedLeb128(bytes, postingsByteLength.offset);
      return {
        term: normalizedTerm,
        postingsOffset: postingsOffset.value,
        postingsByteLength: postingsByteLength.value,
        postingCount: postingCount.value,
      };
    }
    if (order < 0) high = mid - 1;
    else low = mid + 1;
  }
  return undefined;
}

function writeCanonicalValue(writer: ByteWriter, value: unknown): void {
  if (value === null) {
    writer.writeAscii('n');
    return;
  }
  if (typeof value === 'boolean') {
    writer.writeAscii(value ? 't' : 'f');
    return;
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      writer.writeAscii('i');
      writer.writeBytes(encodeZigZagLeb128(value));
      return;
    }
    writer.writeAscii('d');
    writer.writeBytes(encodeFloat64Canonical(value));
    return;
  }
  if (typeof value === 'string') {
    writer.writeAscii('s');
    writer.writeString(value);
    return;
  }
  if (value instanceof Uint8Array) {
    writer.writeAscii('b');
    writer.writeBytesWithLength(value);
    return;
  }
  if (Array.isArray(value)) {
    writer.writeAscii('a');
    writer.writeUnsigned(value.length);
    for (const item of value) writeCanonicalValue(writer, item);
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
      .sort(([left], [right]) => compareBytes(utf8(left.normalize('NFC')), utf8(right.normalize('NFC'))));
    writer.writeAscii('o');
    writer.writeUnsigned(entries.length);
    for (const [key, entryValue] of entries) {
      writer.writeString(key.normalize('NFC'));
      writeCanonicalValue(writer, entryValue);
    }
    return;
  }
  throw new Error(`unsupported canonical value type ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function segmentForTestRecords(
  records: ReadonlyArray<CanonicalDocumentRecord & { content: string }>,
): CanonicalSegment {
  const postings: CanonicalPosting[] = [];
  const documents: CanonicalDocumentRecord[] = [];
  const fieldTexts: CanonicalFieldText[] = [];
  const documentLengths: { docId: number; length: number }[] = [];
  const documentFrequencies = new Map<string, number>();
  records.forEach((record, index) => {
    const docId = index + 1;
    const tokens = tokenizeForTest(record.content);
    const positionsByTerm = new Map<string, number[]>();
    tokens.forEach((term, position) => {
      const positions = positionsByTerm.get(term) ?? [];
      positions.push(position);
      positionsByTerm.set(term, positions);
    });
    for (const [term, positions] of positionsByTerm) postings.push({ term, fieldId: 5, docId, positions });
    documentLengths.push({ docId, length: tokens.length });
    for (const term of positionsByTerm.keys()) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    documents.push({
      documentId: record.documentId,
      path: record.path,
      contentHash: record.contentHash,
      parsedFieldHashes: record.parsedFieldHashes,
      snippetLineSpanHash: record.snippetLineSpanHash,
      deleted: false,
    });
  });
  return {
    postings,
    documents,
    fieldTexts,
    bm25: [
      {
        channel: 'morph',
        fieldId: 5,
        documentCount: records.length,
        totalFieldLength: documentLengths.reduce((sum, entry) => sum + entry.length, 0),
        documentLengths,
        documentFrequencies: [...documentFrequencies.entries()].map(([term, frequency]) => ({ term, frequency })),
      },
    ],
  };
}

function tokenizeForTest(content: string): string[] {
  const terms: string[] = [];
  for (const match of content
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)) {
    terms.push(match[0]);
  }
  return terms;
}

export function partitionIdForDocument(documentId: string, partitionBits: number): number {
  assertSafeUnsignedInteger(partitionBits, 'partitionBits');
  if (partitionBits === 0) return 0;
  if (partitionBits > 48) throw new Error('partitionBits above 48 are not supported by the test snapshot builder');
  const nibbleCount = Math.ceil(partitionBits / 4);
  const raw = Number.parseInt(documentId.slice(0, nibbleCount), 16);
  return Math.floor(raw / 2 ** (nibbleCount * 4 - partitionBits));
}

function normalizeHash(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return normalized;
}

function normalizeHashRecord(record: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {}).sort(([left], [right]) => compareByteStrings(left, right))) {
    output[normalizeCanonicalString(key, 'NFC')] = normalizeHash(value, key);
  }
  return output;
}

function normalizeVaultRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part.normalize('NFC'));
  }
  return parts.join('/');
}

function normalizeCanonicalString(value: string, form: 'NFC' | 'NFKC'): string {
  return value.normalize(form);
}

function parseCanonicalSegmentHeader(bytes: Uint8Array): { entries: SectionEntry[]; payloadStart: number } {
  let offset = 0;
  for (const magicByte of CANONICAL_SEGMENT_MAGIC) {
    if (bytes[offset] !== magicByte) throw new Error('invalid canonical segment magic');
    offset += 1;
  }
  const version = decodeUnsignedLeb128(bytes, offset);
  if (version.value !== CANONICAL_SEGMENT_VERSION)
    throw new Error(`unsupported canonical segment version ${version.value}`);
  offset = version.offset;
  const sectionCount = decodeUnsignedLeb128(bytes, offset);
  offset = sectionCount.offset;

  const entries: SectionEntry[] = [];
  let previousId = -1;
  for (let index = 0; index < sectionCount.value; index += 1) {
    const id = decodeUnsignedLeb128(bytes, offset);
    const sectionOffset = decodeUnsignedLeb128(bytes, id.offset);
    const length = decodeUnsignedLeb128(bytes, sectionOffset.offset);
    if (id.value <= previousId) throw new Error('canonical segment section table must be sorted by section id');
    entries.push({ id: id.value, offset: sectionOffset.value, length: length.value });
    previousId = id.value;
    offset = length.offset;
  }
  return { entries, payloadStart: offset };
}

function validateTermDictionaryAgainstPostings(dictionaryBytes: Uint8Array, postingsBytes: Uint8Array): void {
  const expected = termDictionaryEntriesFromPostings(postingsBytes);
  const actual = decodeCanonicalTermDictionarySection(dictionaryBytes);
  if (actual.length !== expected.length) throw new Error('term dictionary entry count does not match postings');
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    if (
      left?.term !== right?.term ||
      left?.postingsOffset !== right?.postingsOffset ||
      left?.postingsByteLength !== right?.postingsByteLength ||
      left?.postingCount !== right?.postingCount
    ) {
      throw new Error('term dictionary does not match postings bytes');
    }
  }
}

function termDictionaryEntriesFromPostings(postingsBytes: Uint8Array): CanonicalTermDictionaryEntry[] {
  const reader = new ByteReader(postingsBytes);
  const count = reader.readUnsigned();
  const entries: CanonicalTermDictionaryEntry[] = [];
  let current: { term: string; offset: number; count: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const rowOffset = reader.position();
    const posting = readCanonicalPostingRow(reader);
    if (!current || current.term !== posting.term) {
      if (current) {
        entries.push({
          term: current.term,
          postingsOffset: current.offset,
          postingsByteLength: rowOffset - current.offset,
          postingCount: current.count,
        });
      }
      current = { term: posting.term, offset: rowOffset, count: 0 };
    }
    current.count += 1;
  }
  if (current) {
    entries.push({
      term: current.term,
      postingsOffset: current.offset,
      postingsByteLength: reader.position() - current.offset,
      postingCount: current.count,
    });
  }
  reader.assertDone();
  return entries;
}

function termDictionaryView(bytes: Uint8Array): { count: number; offsetTableStart: number; entriesStart: number } {
  const reader = new ByteReader(bytes);
  const schemaId = reader.readUnsigned();
  if (schemaId !== CANONICAL_TERM_DICTIONARY_SCHEMA_ID) {
    throw new Error(`unsupported term dictionary schema ${schemaId}`);
  }
  const count = reader.readUnsigned();
  const offsetTableStart = reader.position();
  const entriesStart = offsetTableStart + count * 8;
  if (entriesStart > bytes.length) throw new Error('truncated term dictionary offset table');
  return { count, offsetTableStart, entriesStart };
}

function termDictionaryEntryOffsets(
  bytes: Uint8Array,
  view: { count: number; offsetTableStart: number; entriesStart: number },
): number[] {
  const offsets: number[] = [];
  let previous = -1;
  for (let index = 0; index < view.count; index += 1) {
    const offset = readFixedUnsigned64(bytes, view.offsetTableStart + index * 8);
    if (offset <= previous) throw new Error('term dictionary entry offsets must be strictly increasing');
    if (view.entriesStart + offset >= bytes.length) throw new Error('term dictionary entry offset is invalid');
    offsets.push(offset);
    previous = offset;
  }
  return offsets;
}

function bm25GlobalOrder(channelOrder: readonly string[]) {
  const channelRank = new Map(channelOrder.map((channel, index) => [channel, index]));
  return (
    leftChannel: string,
    leftFieldId: number,
    leftTerm: string,
    rightChannel: string,
    rightFieldId: number,
    rightTerm: string,
  ): number => {
    const leftRank = channelRank.get(leftChannel) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = channelRank.get(rightChannel) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const channelOrderResult = compareBytes(utf8(leftChannel), utf8(rightChannel));
    if (channelOrderResult !== 0) return channelOrderResult;
    if (leftFieldId !== rightFieldId) return leftFieldId - rightFieldId;
    return compareBytes(utf8(leftTerm), utf8(rightTerm));
  };
}

function compareBm25FieldStats(left: CanonicalBm25FieldStats, right: CanonicalBm25FieldStats): number {
  const channelOrder = compareBytes(utf8(left.channel), utf8(right.channel));
  if (channelOrder !== 0) return channelOrder;
  return left.fieldId - right.fieldId;
}

function mergeBm25DocumentFrequencies(
  input: readonly { term: string; frequency: number }[],
): Array<{ term: string; frequency: number }> {
  const frequencies = new Map<string, number>();
  for (const entry of input) {
    assertSafeUnsignedInteger(entry.frequency, 'BM25 document frequency');
    const term = normalizeCanonicalString(entry.term, 'NFC');
    if (!term || entry.frequency === 0) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + entry.frequency);
  }
  return [...frequencies.entries()]
    .map(([term, frequency]) => {
      assertSafeUnsignedInteger(frequency, 'BM25 document frequency');
      return { term, frequency };
    })
    .sort((left, right) => compareBytes(utf8(left.term), utf8(right.term)));
}

function assertNoDuplicateNumbers(values: readonly number[], label: string): void {
  let previous: number | undefined;
  for (const value of values) {
    if (previous === value) throw new Error(`duplicate ${label}`);
    previous = value;
  }
}

function assertNoDuplicateStrings(values: readonly string[], label: string): void {
  let previous: string | undefined;
  for (const value of values) {
    if (previous === value) throw new Error(`duplicate ${label}`);
    previous = value;
  }
}

function assertNoDuplicateBm25Rows(rows: readonly CanonicalBm25GlobalStatsRow[]): void {
  let previous: string | undefined;
  for (const row of rows) {
    const key = bm25TermKey(row[0], row[1], row[2]);
    if (key === previous) throw new Error('duplicate BM25 global stats row after sort');
    previous = key;
  }
}

function bm25FieldKey(channel: string, fieldId: number): string {
  return `${channel}\u0000${fieldId}`;
}

function bm25TermKey(channel: string, fieldId: number, term: string): string {
  return `${channel}\u0000${fieldId}\u0000${term}`;
}

function docFieldKey(docId: number, fieldId: number): string {
  return `${docId}\u0000${fieldId}`;
}

function readFixedUnsigned64(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error('truncated fixed unsigned integer');
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixed unsigned integer exceeds safe integer range');
  return Number(value);
}

function lineSpanSource(content: string): string {
  return content
    .split(/\r?\n/u)
    .map((line, index) => `${index + 1}:${utf8(line).length}`)
    .join('\n');
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function compareByteStrings(left: string, right: string): number {
  return compareBytes(utf8(left.normalize('NFC')), utf8(right.normalize('NFC')));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  writeUnsigned(value: number): void {
    this.writeBytes(encodeUnsignedLeb128(value));
  }

  writeFixedUnsigned64(value: number): void {
    assertSafeUnsignedInteger(value, 'fixed unsigned integer');
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    this.writeBytes(bytes);
  }

  writeString(value: string): void {
    this.writeBytesWithLength(utf8(value.normalize('NFC')));
  }

  writeBytesWithLength(bytes: Uint8Array): void {
    this.writeUnsigned(bytes.length);
    this.writeBytes(bytes);
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  writeAscii(value: string): void {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index);
    }
    this.writeBytes(bytes);
  }

  byteLength(): number {
    return this.length;
  }

  bytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

export class ByteReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  readUnsigned(): number {
    const read = decodeUnsignedLeb128(this.bytes, this.offset);
    this.offset = read.offset;
    return read.value;
  }

  readString(): string {
    const length = this.readUnsigned();
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error('truncated canonical byte string');
    const value = utf8Decode(this.bytes.subarray(this.offset, end)).normalize('NFC');
    this.offset = end;
    return value;
  }

  position(): number {
    return this.offset;
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) throw new Error('canonical section contains trailing bytes');
  }
}
