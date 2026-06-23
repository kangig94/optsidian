import crypto from "node:crypto";
import { decodeUnsignedLeb128, encodeUnsignedLeb128, encodeZigZagLeb128, assertSafeUnsignedInteger } from "./leb128.js";

export const CANONICAL_SEGMENT_MAGIC = Uint8Array.from([0x4f, 0x53, 0x53, 0x47]);
export const CANONICAL_SEGMENT_VERSION = 1;

export const CANONICAL_SEGMENT_SECTION = {
  postings: 1,
  documents: 2,
  fieldTexts: 3,
  bm25: 4
} as const;

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

export type CanonicalSegment = {
  postings: readonly CanonicalPosting[];
  documents?: readonly CanonicalDocumentRecord[];
  fieldTexts?: readonly CanonicalFieldText[];
  bm25?: readonly CanonicalBm25FieldStats[];
};

export type SnapshotIdentityTuple = {
  schemaVersion: number;
  fieldSetVersion: string;
  partitionVersion: number;
  partitionBits: number;
  analyzerIdentity: unknown;
  searchSettingsHash: string;
  indexBuilderVersion: string;
  rankingFeatureVersion: string;
  retrieverIdentity?: unknown;
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

export type CanonicalSnapshotTestDocument = {
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

type CanonicalValue = null | boolean | number | string | Uint8Array | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue | undefined };

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
  let offset = 0;
  for (const magicByte of CANONICAL_SEGMENT_MAGIC) {
    if (bytes[offset] !== magicByte) throw new Error("invalid canonical segment magic");
    offset += 1;
  }
  const version = decodeUnsignedLeb128(bytes, offset);
  if (version.value !== CANONICAL_SEGMENT_VERSION) throw new Error(`unsupported canonical segment version ${version.value}`);
  offset = version.offset;
  const sectionCount = decodeUnsignedLeb128(bytes, offset);
  offset = sectionCount.offset;

  const entries: SectionEntry[] = [];
  let previousId = -1;
  for (let index = 0; index < sectionCount.value; index += 1) {
    const id = decodeUnsignedLeb128(bytes, offset);
    const sectionOffset = decodeUnsignedLeb128(bytes, id.offset);
    const length = decodeUnsignedLeb128(bytes, sectionOffset.offset);
    if (id.value <= previousId) throw new Error("canonical segment section table must be sorted by section id");
    entries.push({ id: id.value, offset: sectionOffset.value, length: length.value });
    previousId = id.value;
    offset = length.offset;
  }

  const payloadStart = offset;
  let expectedPayloadOffset = 0;
  const segment: CanonicalSegment = { postings: [] };
  for (const entry of entries) {
    if (entry.offset !== expectedPayloadOffset) throw new Error("canonical segment sections must be contiguous and sorted");
    expectedPayloadOffset += entry.length;
    const start = payloadStart + entry.offset;
    const end = start + entry.length;
    if (start < payloadStart || end > bytes.length) throw new Error("canonical segment section bounds are invalid");
    const payload = bytes.subarray(start, end);
    if (entry.id === CANONICAL_SEGMENT_SECTION.postings) segment.postings = decodePostingsSection(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.documents) segment.documents = decodeDocumentsSection(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.fieldTexts) segment.fieldTexts = decodeFieldTextsSection(payload);
    else if (entry.id === CANONICAL_SEGMENT_SECTION.bm25) segment.bm25 = decodeBm25Section(payload);
    else throw new Error(`unknown canonical segment section ${entry.id}`);
  }
  if (payloadStart + expectedPayloadOffset !== bytes.length) {
    throw new Error("canonical segment contains trailing bytes");
  }
  return normalizeCanonicalSegment(segment);
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
    partitions: manifest.partitions.map((partition) => ({
      partitionId: partition.partitionId,
      documentIdStart: partition.documentIdStart,
      documentIdEnd: partition.documentIdEnd,
      segmentHash: partition.segmentHash,
      documentCount: partition.documentCount,
      byteLength: partition.byteLength
    }))
  });
}

export function snapshotIdFromManifest(manifest: CanonicalSnapshotManifest): string {
  return sha256(canonicalSnapshotManifestBytes(manifest));
}

export function canonicalValueBytes(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  writeCanonicalValue(writer, value);
  return writer.bytes();
}

export function encodeFloat64Canonical(value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new Error("canonical float must be finite");
  const normalized = Object.is(value, -0) ? 0 : value;
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, normalized, true);
  return bytes;
}

export function buildCanonicalSnapshotForTests(input: CanonicalSnapshotBuildForTestsInput): CanonicalSnapshotForTests {
  void input.history;
  const records = input.documents.map((document) => {
    const path = normalizeVaultRelativePath(document.path);
    return {
      documentId: sha256(utf8(path)),
      path,
      contentHash: sha256(utf8(document.content)),
      parsedFieldHashes: {
        body: sha256(utf8(document.content))
      },
      snippetLineSpanHash: sha256(utf8(lineSpanSource(document.content))),
      deleted: false,
      content: document.content
    };
  }).sort((left, right) => compareByteStrings(left.documentId, right.documentId));

  const partitions = new Map<number, typeof records>();
  for (const record of records) {
    const partitionId = partitionIdForDocument(record.documentId, input.identityTuple.partitionBits);
    const partition = partitions.get(partitionId) ?? [];
    partition.push(record);
    partitions.set(partitionId, partition);
  }

  const segments = [...partitions.entries()].sort((left, right) => left[0] - right[0]).map(([partitionId, partitionRecords]) => {
    const segment = segmentForTestRecords(partitionRecords);
    const bytes = encodeCanonicalSegment(segment);
    return {
      partitionId,
      hash: canonicalSegmentHash(bytes),
      bytes,
      documentIdStart: partitionRecords[0]?.documentId ?? "",
      documentIdEnd: partitionRecords[partitionRecords.length - 1]?.documentId ?? "",
      documentCount: partitionRecords.length
    };
  });

  const manifest: CanonicalSnapshotManifest = {
    identityTuple: input.identityTuple,
    liveDocumentManifestHash: sha256(canonicalValueBytes(records.map((record) => ({
      documentId: record.documentId,
      path: record.path,
      contentHash: record.contentHash,
      parsedFieldHashes: record.parsedFieldHashes,
      snippetLineSpanHash: record.snippetLineSpanHash,
      deleted: false
    })))),
    tombstoneHash: sha256(canonicalValueBytes([])),
    partitions: segments.map((segment) => ({
      partitionId: segment.partitionId,
      documentIdStart: segment.documentIdStart,
      documentIdEnd: segment.documentIdEnd,
      segmentHash: segment.hash,
      documentCount: segment.documentCount,
      byteLength: segment.bytes.length
    }))
  };
  const canonicalManifestBytes = canonicalSnapshotManifestBytes(manifest);
  return {
    snapshotId: sha256(canonicalManifestBytes),
    canonicalManifestBytes,
    manifest,
    segments: segments.map((segment) => ({
      partitionId: segment.partitionId,
      hash: segment.hash,
      bytes: segment.bytes
    }))
  };
}

function normalizeCanonicalSegment(segment: CanonicalSegment): CanonicalSegment {
  return {
    postings: normalizePostings(segment.postings),
    documents: normalizeDocuments(segment.documents ?? []),
    fieldTexts: normalizeFieldTexts(segment.fieldTexts ?? []),
    bm25: normalizeBm25Stats(segment.bm25 ?? [])
  };
}

function canonicalSections(segment: CanonicalSegment): Section[] {
  const sections: Section[] = [
    { id: CANONICAL_SEGMENT_SECTION.postings, bytes: encodePostingsSection(segment.postings) }
  ];
  if ((segment.documents?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.documents, bytes: encodeDocumentsSection(segment.documents ?? []) });
  }
  if ((segment.fieldTexts?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.fieldTexts, bytes: encodeFieldTextsSection(segment.fieldTexts ?? []) });
  }
  if ((segment.bm25?.length ?? 0) > 0) {
    sections.push({ id: CANONICAL_SEGMENT_SECTION.bm25, bytes: encodeBm25Section(segment.bm25 ?? []) });
  }
  return sections.sort((left, right) => left.id - right.id);
}

function normalizePostings(postings: readonly CanonicalPosting[]): CanonicalPosting[] {
  const merged = new Map<string, { term: string; fieldId: number; docId: number; positions: Set<number> }>();
  for (const posting of postings) {
    const term = normalizeCanonicalString(posting.term, "NFC");
    if (!term) continue;
    assertSafeUnsignedInteger(posting.fieldId, "posting fieldId");
    assertSafeUnsignedInteger(posting.docId, "posting docId");
    const key = `${term}\u0000${posting.fieldId}\u0000${posting.docId}`;
    const entry = merged.get(key) ?? { term, fieldId: posting.fieldId, docId: posting.docId, positions: new Set<number>() };
    for (const position of posting.positions) {
      assertSafeUnsignedInteger(position, "posting position");
      entry.positions.add(position);
    }
    merged.set(key, entry);
  }
  return [...merged.values()]
    .map((entry) => ({
      term: entry.term,
      fieldId: entry.fieldId,
      docId: entry.docId,
      positions: [...entry.positions].sort((left, right) => left - right)
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
  return documents.map((document) => ({
    documentId: normalizeHash(document.documentId, "documentId"),
    path: normalizeVaultRelativePath(document.path),
    contentHash: normalizeHash(document.contentHash, "contentHash"),
    parsedFieldHashes: normalizeHashRecord(document.parsedFieldHashes),
    snippetLineSpanHash: document.snippetLineSpanHash ? normalizeHash(document.snippetLineSpanHash, "snippetLineSpanHash") : undefined,
    deleted: document.deleted === true
  })).sort((left, right) => compareByteStrings(left.documentId, right.documentId));
}

function normalizeFieldTexts(fieldTexts: readonly CanonicalFieldText[]): CanonicalFieldText[] {
  return fieldTexts.map((fieldText) => {
    assertSafeUnsignedInteger(fieldText.docId, "field text docId");
    assertSafeUnsignedInteger(fieldText.fieldId, "field text fieldId");
    return {
      docId: fieldText.docId,
      fieldId: fieldText.fieldId,
      text: normalizeCanonicalString(fieldText.text, "NFKC")
    };
  }).sort((left, right) => {
    if (left.docId !== right.docId) return left.docId - right.docId;
    return left.fieldId - right.fieldId;
  });
}

function normalizeBm25Stats(stats: readonly CanonicalBm25FieldStats[]): CanonicalBm25FieldStats[] {
  return stats.map((field) => {
    assertSafeUnsignedInteger(field.fieldId, "BM25 fieldId");
    assertSafeUnsignedInteger(field.documentCount, "BM25 documentCount");
    assertSafeUnsignedInteger(field.totalFieldLength, "BM25 totalFieldLength");
    return {
      fieldId: field.fieldId,
      documentCount: field.documentCount,
      totalFieldLength: field.totalFieldLength,
      documentLengths: field.documentLengths.map((entry) => {
        assertSafeUnsignedInteger(entry.docId, "BM25 document length docId");
        assertSafeUnsignedInteger(entry.length, "BM25 document length");
        return { docId: entry.docId, length: entry.length };
      }).sort((left, right) => left.docId - right.docId),
      documentFrequencies: field.documentFrequencies.map((entry) => {
        assertSafeUnsignedInteger(entry.frequency, "BM25 document frequency");
        return { term: normalizeCanonicalString(entry.term, "NFC"), frequency: entry.frequency };
      }).sort((left, right) => compareBytes(utf8(left.term), utf8(right.term)))
    };
  }).sort((left, right) => left.fieldId - right.fieldId);
}

function encodePostingsSection(postings: readonly CanonicalPosting[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(postings.length);
  for (const posting of postings) {
    writer.writeString(posting.term);
    writer.writeUnsigned(posting.fieldId);
    writer.writeUnsigned(posting.docId);
    writer.writeUnsigned(posting.positions.length);
    let previous = -1;
    for (const position of posting.positions) {
      if (position <= previous) throw new Error("posting positions must be strictly increasing");
      writer.writeUnsigned(position);
      previous = position;
    }
  }
  return writer.bytes();
}

function decodePostingsSection(bytes: Uint8Array): CanonicalPosting[] {
  const reader = new ByteReader(bytes);
  const count = reader.readUnsigned();
  const postings: CanonicalPosting[] = [];
  for (let index = 0; index < count; index += 1) {
    const term = reader.readString();
    const fieldId = reader.readUnsigned();
    const docId = reader.readUnsigned();
    const positionCount = reader.readUnsigned();
    const positions: number[] = [];
    let previous = -1;
    for (let positionIndex = 0; positionIndex < positionCount; positionIndex += 1) {
      const position = reader.readUnsigned();
      if (position <= previous) throw new Error("posting positions must be strictly increasing");
      positions.push(position);
      previous = position;
    }
    postings.push({ term, fieldId, docId, positions });
  }
  reader.assertDone();
  return normalizePostings(postings);
}

function encodeDocumentsSection(documents: readonly CanonicalDocumentRecord[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(documents.length);
  for (const document of documents) {
    writer.writeString(document.documentId);
    writer.writeString(document.path);
    writer.writeString(document.contentHash);
    const fieldHashes = Object.entries(document.parsedFieldHashes ?? {}).sort(([left], [right]) => compareByteStrings(left, right));
    writer.writeUnsigned(fieldHashes.length);
    for (const [field, hash] of fieldHashes) {
      writer.writeString(field);
      writer.writeString(hash);
    }
    writer.writeString(document.snippetLineSpanHash ?? "");
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
      deleted
    });
  }
  reader.assertDone();
  return normalizeDocuments(documents);
}

function encodeFieldTextsSection(fieldTexts: readonly CanonicalFieldText[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(fieldTexts.length);
  for (const fieldText of fieldTexts) {
    writer.writeUnsigned(fieldText.docId);
    writer.writeUnsigned(fieldText.fieldId);
    writer.writeString(fieldText.text);
  }
  return writer.bytes();
}

function decodeFieldTextsSection(bytes: Uint8Array): CanonicalFieldText[] {
  const reader = new ByteReader(bytes);
  const count = reader.readUnsigned();
  const fieldTexts: CanonicalFieldText[] = [];
  for (let index = 0; index < count; index += 1) {
    fieldTexts.push({
      docId: reader.readUnsigned(),
      fieldId: reader.readUnsigned(),
      text: reader.readString()
    });
  }
  reader.assertDone();
  return normalizeFieldTexts(fieldTexts);
}

function encodeBm25Section(stats: readonly CanonicalBm25FieldStats[]): Uint8Array {
  const writer = new ByteWriter();
  writer.writeUnsigned(stats.length);
  for (const field of stats) {
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
  const count = reader.readUnsigned();
  const stats: CanonicalBm25FieldStats[] = [];
  for (let index = 0; index < count; index += 1) {
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
    stats.push({ fieldId, documentCount, totalFieldLength, documentLengths, documentFrequencies });
  }
  reader.assertDone();
  return normalizeBm25Stats(stats);
}

function writeCanonicalValue(writer: ByteWriter, value: unknown): void {
  if (value === null) {
    writer.writeAscii("n");
    return;
  }
  if (typeof value === "boolean") {
    writer.writeAscii(value ? "t" : "f");
    return;
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      writer.writeAscii("i");
      writer.writeBytes(encodeZigZagLeb128(value));
      return;
    }
    writer.writeAscii("d");
    writer.writeBytes(encodeFloat64Canonical(value));
    return;
  }
  if (typeof value === "string") {
    writer.writeAscii("s");
    writer.writeString(value);
    return;
  }
  if (value instanceof Uint8Array) {
    writer.writeAscii("b");
    writer.writeBytesWithLength(value);
    return;
  }
  if (Array.isArray(value)) {
    writer.writeAscii("a");
    writer.writeUnsigned(value.length);
    for (const item of value) writeCanonicalValue(writer, item);
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
      .sort(([left], [right]) => compareBytes(utf8(left.normalize("NFC")), utf8(right.normalize("NFC"))));
    writer.writeAscii("o");
    writer.writeUnsigned(entries.length);
    for (const [key, entryValue] of entries) {
      writer.writeString(key.normalize("NFC"));
      writeCanonicalValue(writer, entryValue);
    }
    return;
  }
  throw new Error(`unsupported canonical value type ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function segmentForTestRecords(records: ReadonlyArray<CanonicalDocumentRecord & { content: string }>): CanonicalSegment {
  const postings: CanonicalPosting[] = [];
  const documents: CanonicalDocumentRecord[] = [];
  const fieldTexts: CanonicalFieldText[] = [];
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
    documents.push({
      documentId: record.documentId,
      path: record.path,
      contentHash: record.contentHash,
      parsedFieldHashes: record.parsedFieldHashes,
      snippetLineSpanHash: record.snippetLineSpanHash,
      deleted: false
    });
    fieldTexts.push({ docId, fieldId: 5, text: record.content.normalize("NFKC") });
  });
  return { postings, documents, fieldTexts };
}

function tokenizeForTest(content: string): string[] {
  const terms: string[] = [];
  for (const match of content.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)) {
    terms.push(match[0]);
  }
  return terms;
}

export function partitionIdForDocument(documentId: string, partitionBits: number): number {
  assertSafeUnsignedInteger(partitionBits, "partitionBits");
  if (partitionBits === 0) return 0;
  if (partitionBits > 48) throw new Error("partitionBits above 48 are not supported by the test snapshot builder");
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
    output[normalizeCanonicalString(key, "NFC")] = normalizeHash(value, key);
  }
  return output;
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

function normalizeCanonicalString(value: string, form: "NFC" | "NFKC"): string {
  return value.normalize(form);
}

function lineSpanSource(content: string): string {
  return content.split(/\r?\n/u).map((line, index) => `${index + 1}:${utf8(line).length}`).join("\n");
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function compareByteStrings(left: string, right: string): number {
  return compareBytes(utf8(left.normalize("NFC")), utf8(right.normalize("NFC")));
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

  writeUnsigned(value: number): void {
    this.writeBytes(encodeUnsignedLeb128(value));
  }

  writeString(value: string): void {
    this.writeBytesWithLength(utf8(value.normalize("NFC")));
  }

  writeBytesWithLength(bytes: Uint8Array): void {
    this.writeUnsigned(bytes.length);
    this.writeBytes(bytes);
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  writeAscii(value: string): void {
    this.chunks.push(Uint8Array.from([...value].map((char) => char.charCodeAt(0))));
  }

  bytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
}

class ByteReader {
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
    if (end > this.bytes.length) throw new Error("truncated canonical byte string");
    const value = utf8Decode(this.bytes.subarray(this.offset, end)).normalize("NFC");
    this.offset = end;
    return value;
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) throw new Error("canonical section contains trailing bytes");
  }
}
