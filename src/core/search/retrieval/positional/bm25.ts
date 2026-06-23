import type { SearchTokenChannel } from "../../analysis/index.js";
import { SEARCH_BM25_B, SEARCH_BM25_D, SEARCH_BM25_K1, SEARCH_TOKEN_CHANNEL_WEIGHT } from "../../constants.js";
import { SEARCH_FIELD_CHANNEL_BOOST } from "../../schema.js";
import type { SearchField } from "../../../types.js";
import { POSITIONAL_FIELD_BY_ID, POSITIONAL_FIELD_ID, type PositionalDocId, type PositionalFieldId } from "./types.js";

export type Bm25DocumentFieldInput = {
  fieldId?: PositionalFieldId;
  field?: SearchField;
  tokens: readonly string[];
};

export type Bm25DocumentInput = {
  docId: PositionalDocId;
  fields: readonly Bm25DocumentFieldInput[];
};

export type Bm25FieldStats = {
  fieldId: PositionalFieldId;
  field?: SearchField;
  documentCount: number;
  totalFieldLength: number;
  averageFieldLength: number;
  documentLengths: ReadonlyMap<PositionalDocId, number>;
  documentFrequency: ReadonlyMap<string, number>;
  termFrequency: ReadonlyMap<string, ReadonlyMap<PositionalDocId, number>>;
};

export type Bm25Stats = {
  fields: ReadonlyMap<PositionalFieldId, Bm25FieldStats>;
};

type MutableFieldStats = {
  fieldId: PositionalFieldId;
  field?: SearchField;
  documentCount: number;
  totalFieldLength: number;
  documentLengths: Map<PositionalDocId, number>;
  documentFrequency: Map<string, number>;
  termFrequency: Map<string, Map<PositionalDocId, number>>;
};

export function computeFieldBm25Stats(documents: readonly Bm25DocumentInput[]): Bm25Stats {
  const fields = new Map<PositionalFieldId, MutableFieldStats>();
  for (const document of documents) {
    assertNonNegativeInteger(document.docId, "docId");
    for (const inputField of document.fields) {
      const fieldId = fieldIdForInput(inputField);
      const fieldName = inputField.field ?? POSITIONAL_FIELD_BY_ID[fieldId];
      const stats = fields.get(fieldId) ?? {
        fieldId,
        field: fieldName,
        documentCount: 0,
        totalFieldLength: 0,
        documentLengths: new Map<PositionalDocId, number>(),
        documentFrequency: new Map<string, number>(),
        termFrequency: new Map<string, Map<PositionalDocId, number>>()
      };
      const terms = inputField.tokens.map((term) => term.normalize("NFC").trim()).filter(Boolean);
      stats.documentCount += 1;
      stats.totalFieldLength += terms.length;
      stats.documentLengths.set(document.docId, terms.length);

      const termCounts = new Map<string, number>();
      for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      for (const [term, frequency] of termCounts) {
        stats.documentFrequency.set(term, (stats.documentFrequency.get(term) ?? 0) + 1);
        const frequencies = stats.termFrequency.get(term) ?? new Map<PositionalDocId, number>();
        frequencies.set(document.docId, frequency);
        stats.termFrequency.set(term, frequencies);
      }
      fields.set(fieldId, stats);
    }
  }

  return {
    fields: new Map(
      [...fields.entries()]
        .sort(([left], [right]) => left - right)
        .map(([fieldId, stats]) => [
          fieldId,
          freezeFieldStats({
            ...stats,
            averageFieldLength: stats.documentCount > 0 ? stats.totalFieldLength / stats.documentCount : 0
          })
        ])
    )
  };
}

export function bm25TermScore(
  stats: Bm25Stats,
  term: string,
  docId: PositionalDocId,
  fieldId: PositionalFieldId,
  options: {
    k1?: number;
    b?: number;
    d?: number;
  } = {}
): number {
  const field = stats.fields.get(fieldId);
  if (!field) return 0;
  const normalizedTerm = term.normalize("NFC").trim();
  const frequency = field.termFrequency.get(normalizedTerm)?.get(docId) ?? 0;
  if (frequency <= 0) return 0;
  const documentFrequency = field.documentFrequency.get(normalizedTerm) ?? 0;
  if (field.documentCount <= 0 || documentFrequency <= 0 || field.averageFieldLength <= 0) return 0;
  const fieldLength = field.documentLengths.get(docId) ?? 0;
  if (fieldLength <= 0) return 0;
  const k1 = options.k1 ?? SEARCH_BM25_K1;
  const b = options.b ?? SEARCH_BM25_B;
  const d = options.d ?? SEARCH_BM25_D;
  const idf = Math.log((field.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
  const tf = frequency / fieldLength;
  return (idf * (d + tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * fieldLength) / field.averageFieldLength));
}

export function bm25FieldScore(
  stats: Bm25Stats,
  terms: readonly string[],
  docId: PositionalDocId,
  fieldId: PositionalFieldId,
  options: {
    k1?: number;
    b?: number;
    d?: number;
  } = {}
): number {
  return terms.reduce((sum, term) => sum + bm25TermScore(stats, term, docId, fieldId, options), 0);
}

export function boostedBm25FieldScore(
  stats: Bm25Stats,
  terms: readonly string[],
  docId: PositionalDocId,
  field: SearchField,
  channel: SearchTokenChannel
): number {
  const fieldId = POSITIONAL_FIELD_ID[field];
  return bm25FieldScore(stats, terms, docId, fieldId) * fieldChannelBm25Boost(channel, field);
}

export function fieldChannelBm25Boost(channel: SearchTokenChannel, field: SearchField): number {
  return SEARCH_FIELD_CHANNEL_BOOST[channel][field];
}

export function tokenChannelFusionWeight(channel: SearchTokenChannel): number {
  return SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
}

export function bm25TermStats(
  stats: Bm25Stats,
  term: string,
  fieldId: PositionalFieldId
): {
  documentFrequency: number;
  documentCount: number;
  averageFieldLength: number;
} {
  const field = stats.fields.get(fieldId);
  return {
    documentFrequency: field?.documentFrequency.get(term.normalize("NFC").trim()) ?? 0,
    documentCount: field?.documentCount ?? 0,
    averageFieldLength: field?.averageFieldLength ?? 0
  };
}

function fieldIdForInput(input: Bm25DocumentFieldInput): PositionalFieldId {
  if (input.field !== undefined) return POSITIONAL_FIELD_ID[input.field];
  if (input.fieldId === undefined) throw new Error("BM25 field input needs field or fieldId");
  assertNonNegativeInteger(input.fieldId, "fieldId");
  return input.fieldId;
}

function freezeFieldStats(stats: MutableFieldStats & { averageFieldLength: number }): Bm25FieldStats {
  return {
    fieldId: stats.fieldId,
    field: stats.field,
    documentCount: stats.documentCount,
    totalFieldLength: stats.totalFieldLength,
    averageFieldLength: stats.averageFieldLength,
    documentLengths: new Map([...stats.documentLengths.entries()].sort(([left], [right]) => left - right)),
    documentFrequency: new Map([...stats.documentFrequency.entries()].sort(([left], [right]) => left.localeCompare(right))),
    termFrequency: new Map(
      [...stats.termFrequency.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([term, frequencies]) => [term, new Map([...frequencies.entries()].sort(([left], [right]) => left - right))])
    )
  };
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
