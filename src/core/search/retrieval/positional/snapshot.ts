import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../analysis/index.js";
import { SEARCH_BM25_B, SEARCH_BM25_D, SEARCH_BM25_K1 } from "../../constants.js";
import { CanonicalSegmentPostingsReader } from "./segment-postings-reader.js";
import { ProjectionReader } from "./segment-projection-reader.js";
import type { SearchSnapshot } from "./engine.js";

export type PositionalSnapshotSegmentInput = {
  segmentId: string;
  partitionId: number;
  bytes: Uint8Array;
};

export type PositionalBm25GlobalStats = {
  schemaId: number;
  corpusStats: readonly {
    channel: SearchTokenChannel;
    fieldId: number;
    documentCount: number;
    totalFieldLength: number;
    averageFieldLength: number;
  }[];
  rows: readonly {
    channel: SearchTokenChannel;
    fieldId: number;
    term: string;
    documentFrequency: number;
  }[];
  hash: string;
};

export function buildSearchSnapshotFromSegments(input: {
  snapshotId: string;
  segments: readonly PositionalSnapshotSegmentInput[];
  bm25Stats: PositionalBm25GlobalStats;
  validateProjection?: boolean;
}): SearchSnapshot {
  const segments = input.segments.map((segment) => {
    const projection = new ProjectionReader(segment.bytes, { validate: input.validateProjection ?? true });
    return {
      segmentId: segment.segmentId,
      partitionId: segment.partitionId,
      bytes: segment.bytes,
      postings: new CanonicalSegmentPostingsReader(segment.bytes),
      projection
    };
  });
  return {
    snapshotId: input.snapshotId,
    documentCount: segments.reduce((sum, segment) => sum + segment.projection.documentCount(), 0),
    segments,
    bm25Stats: input.bm25Stats
  };
}

export function splitCanonicalPostingTerm(value: string): { channel: SearchTokenChannel; term: string } | undefined {
  const separator = value.indexOf("\u0000");
  if (separator < 1) return undefined;
  const channel = value.slice(0, separator);
  if (!SEARCH_TOKEN_CHANNELS.includes(channel as SearchTokenChannel)) return undefined;
  return { channel: channel as SearchTokenChannel, term: value.slice(separator + 1) };
}

export function bm25CorpusStats(
  globalStats: PositionalBm25GlobalStats,
  channel: SearchTokenChannel,
  fieldId: number
): PositionalBm25GlobalStats["corpusStats"][number] | undefined {
  return globalStats.corpusStats.find((entry) => entry.channel === channel && entry.fieldId === fieldId);
}

export function bm25DocumentFrequency(
  globalStats: PositionalBm25GlobalStats,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number
): number {
  const normalized = term.normalize("NFC").trim();
  return globalStats.rows.find((entry) =>
    entry.channel === channel &&
    entry.fieldId === fieldId &&
    entry.term === normalized
  )?.documentFrequency ?? 0;
}

export function bm25TermScoreFromGlobalStats(
  globalStats: PositionalBm25GlobalStats,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number,
  frequency: number,
  fieldLength: number,
  options: {
    k1?: number;
    b?: number;
    d?: number;
  } = {}
): number {
  if (frequency <= 0 || fieldLength <= 0) return 0;
  const corpus = bm25CorpusStats(globalStats, channel, fieldId);
  if (!corpus || corpus.documentCount <= 0 || corpus.averageFieldLength <= 0) return 0;
  const documentFrequency = bm25DocumentFrequency(globalStats, channel, term, fieldId);
  if (documentFrequency <= 0) return 0;
  const k1 = options.k1 ?? SEARCH_BM25_K1;
  const b = options.b ?? SEARCH_BM25_B;
  const d = options.d ?? SEARCH_BM25_D;
  const idf = Math.log((corpus.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
  const tf = frequency / fieldLength;
  return (idf * (d + tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * fieldLength) / corpus.averageFieldLength));
}
