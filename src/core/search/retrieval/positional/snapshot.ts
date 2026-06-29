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

export type PositionalBm25CorpusStats = PositionalBm25GlobalStats["corpusStats"][number];

export type Bm25TermScoreOptions = {
  k1?: number;
  b?: number;
  d?: number;
};

export type PositionalBm25StatsLookup = {
  corpusStats(channel: SearchTokenChannel, fieldId: number): PositionalBm25CorpusStats | undefined;
  documentFrequency(channel: SearchTokenChannel, term: string, fieldId: number): number;
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

export function createPositionalBm25StatsLookup(globalStats: PositionalBm25GlobalStats): PositionalBm25StatsLookup {
  const corpusByKey = new Map<string, PositionalBm25CorpusStats>();
  for (const entry of globalStats.corpusStats) {
    const key = bm25CorpusStatsKey(entry.channel, entry.fieldId);
    if (!corpusByKey.has(key)) corpusByKey.set(key, entry);
  }
  const documentFrequencyByKey = new Map<string, number>();
  for (const row of globalStats.rows) {
    const key = bm25DocumentFrequencyKey(row.channel, row.term, row.fieldId);
    if (!documentFrequencyByKey.has(key)) documentFrequencyByKey.set(key, row.documentFrequency);
  }
  return {
    corpusStats: (channel, fieldId) => corpusByKey.get(bm25CorpusStatsKey(channel, fieldId)),
    documentFrequency: (channel, term, fieldId) =>
      documentFrequencyByKey.get(bm25DocumentFrequencyKey(channel, term, fieldId)) ?? 0
  };
}

export function bm25TermScoreFromStatsLookup(
  lookup: PositionalBm25StatsLookup,
  channel: SearchTokenChannel,
  term: string,
  fieldId: number,
  frequency: number,
  fieldLength: number,
  options: Bm25TermScoreOptions = {}
): number {
  if (frequency <= 0 || fieldLength <= 0) return 0;
  const corpus = lookup.corpusStats(channel, fieldId);
  if (!corpus || corpus.documentCount <= 0 || corpus.averageFieldLength <= 0) return 0;
  const documentFrequency = lookup.documentFrequency(channel, term, fieldId);
  if (documentFrequency <= 0) return 0;
  return bm25TermScoreFromObservedStats(corpus, documentFrequency, frequency, fieldLength, options);
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
  return bm25TermScoreFromObservedStats(corpus, documentFrequency, frequency, fieldLength, options);
}

function bm25TermScoreFromObservedStats(
  corpus: PositionalBm25CorpusStats,
  documentFrequency: number,
  frequency: number,
  fieldLength: number,
  options: Bm25TermScoreOptions = {}
): number {
  const k1 = options.k1 ?? SEARCH_BM25_K1;
  const b = options.b ?? SEARCH_BM25_B;
  const d = options.d ?? SEARCH_BM25_D;
  const idf = Math.log((corpus.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
  const tf = frequency / fieldLength;
  return (idf * (d + tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * fieldLength) / corpus.averageFieldLength));
}

function bm25CorpusStatsKey(channel: SearchTokenChannel, fieldId: number): string {
  return `${channel}\u0000${fieldId}`;
}

function bm25DocumentFrequencyKey(channel: SearchTokenChannel, term: string, fieldId: number): string {
  return `${channel}\u0000${fieldId}\u0000${term.normalize("NFC").trim()}`;
}
