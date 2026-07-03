import { SEARCH_TOKEN_CHANNELS, type SearchTextAnalysis, type SearchTokenChannel } from "../../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchScoringLambdas } from "../../core/search/constants.js";
import { matchesPathFilter } from "../../core/search/params.js";
import type { ExactDominanceBound } from "../../core/search/ranking/index.js";
import { POSITIONAL_FIELD_ID } from "../../core/search/retrieval/positional/index.js";
import { SEARCH_PROPERTIES } from "../../core/search/schema.js";
import {
  CANONICAL_SEGMENT_SECTION,
  canonicalSegmentSectionBytes,
  lookupCanonicalTermDictionaryEntry,
  ProjectionReader
} from "../../core/search/segments/index.js";
import type { NormalizedSearchParams, PathFilter } from "../../core/search/internal-types.js";
import type { SearchField } from "../../core/types.js";
import { compareByteStrings } from "./finalist-order.js";
import type { SearchExecutionSnapshotHandle, SharedBytesHandle } from "./result-shaping.js";
import type { DenseVectorSearchHit } from "../search-execution.js";
import { exactDominanceBoundForSearchHandle } from "./search-execution-state.js";
import type { RetrievalEmbeddingSetEnvelope } from "./types.js";

export type SearchQueryPlanInput = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  denseEmbeddingSet?: RetrievalEmbeddingSetEnvelope;
  queryVector?: readonly number[];
  denseSearchResults?: readonly DenseVectorSearchHit[];
  denseLiveContentHashes?: ReadonlyMap<string, string>;
  sourceDocumentId?: string;
  sourcePath?: string;
  excludeDocumentIds?: readonly string[];
  rrfK?: number;
  scoringLambdas?: Partial<SearchScoringLambdas>;
  deadline: number;
  cancellationId: string;
  explain?: boolean;
};

export type ShardTaskPlan = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  denseEmbeddingSet?: RetrievalEmbeddingSetEnvelope;
  queryVector?: readonly number[];
  denseSearchResults?: readonly DenseVectorSearchHit[];
  denseLiveContentHashes?: ReadonlyMap<string, string>;
  sourceDocumentId?: string;
  sourcePath?: string;
  excludeDocumentIds?: readonly string[];
  rrfK?: number;
  scoringLambdas?: Partial<SearchScoringLambdas>;
  channels: readonly SearchTokenChannel[];
  requestedLimit: number;
  workEstimate: number;
  deadline: number;
  cancellationId: string;
  explain?: boolean;
  mergeKey: string;
};

export type SearchPlan = {
  snapshotId: string;
  exactBound?: ExactDominanceBound;
  tasks: readonly ShardTaskPlan[];
  requestedLimit: number;
  estimatedWork: number;
  mergeKey: string;
};

const EMPTY_DOCUMENTS_HANDLE = sharedBytesHandle(new TextEncoder().encode("[]"));

export class SearchQueryPlanner {
  plan(input: SearchQueryPlanInput): SearchPlan {
    const channels = fanoutSearchChannels(input.snapshot, input.analysis, input.search.fields);
    const tasks = partitionJobPlans(input, channels);
    const estimatedWork = tasks.reduce((sum, task) => sum + task.workEstimate, 0);
    const exactBound = tasks.length > 0 || input.explain
      ? exactDominanceBoundForSearchHandle({
          search: input.search,
          snapshot: input.snapshot,
          analysis: input.analysis
        })
      : undefined;
    return {
      snapshotId: input.snapshot.snapshotId,
      ...(exactBound ? { exactBound } : {}),
      tasks,
      requestedLimit: input.search.limit,
      estimatedWork,
      mergeKey: searchPlanMergeKey(input.snapshot.snapshotId, channels, tasks)
    };
  }
}

export function partitionJobPlans(
  input: SearchQueryPlanInput,
  channels: readonly SearchTokenChannel[]
): ShardTaskPlan[] {
  const needsDenseFanout = Boolean(input.queryVector && input.denseEmbeddingSet);
  const needsLinkFanout = Boolean(input.sourceDocumentId ? input.sourceDocumentId : input.sourcePath);
  return [...input.snapshot.segments]
    .filter((segment) => segmentMatchesPathFilter(segment, input.pathFilter))
    .sort(compareSegments)
    .map((segment) => ({
      segment,
      workEstimate: estimateSegmentWork(segment, input.analysis, input.search.fields, channels)
    }))
    .filter((entry) => entry.workEstimate > 0 || needsDenseFanout || needsLinkFanout)
    .map((entry): ShardTaskPlan => ({
      vault: input.vault,
      search: input.search,
      pathFilter: input.pathFilter,
      analysis: input.analysis,
      analyzerIdentity: input.analyzerIdentity,
      snapshot: {
        snapshotId: input.snapshot.snapshotId,
        pinToken: input.snapshot.pinToken,
        bm25Stats: input.snapshot.bm25Stats,
        documents: EMPTY_DOCUMENTS_HANDLE,
        linkGraph: input.snapshot.linkGraph,
        segments: [entry.segment]
      },
      denseEmbeddingSet: input.denseEmbeddingSet,
      queryVector: input.queryVector,
      denseSearchResults: input.denseSearchResults,
      denseLiveContentHashes: input.denseLiveContentHashes,
      sourceDocumentId: input.sourceDocumentId,
      sourcePath: input.sourcePath,
      excludeDocumentIds: input.excludeDocumentIds,
      rrfK: input.rrfK,
      scoringLambdas: input.scoringLambdas,
      channels,
      requestedLimit: input.search.limit,
      workEstimate: needsDenseFanout || needsLinkFanout ? Math.max(1, entry.workEstimate) : entry.workEstimate,
      deadline: input.deadline,
      cancellationId: input.cancellationId,
      explain: input.explain,
      mergeKey: segmentMergeKey(entry.segment)
    }));
}

export function fanoutSearchChannels(
  snapshot: SearchExecutionSnapshotHandle,
  analysis: SearchTextAnalysis,
  fields: readonly SearchField[] | undefined
): readonly SearchTokenChannel[] {
  if (analysis.channels.ngram.length > 0 && hangulTerms(analysis.channels.ngram)) {
    const ngramWork = snapshot.segments.reduce((sum, segment) =>
      sum + estimateSegmentWork(segment, analysis, fields, ["ngram"]), 0);
    return ngramWork > 0 ? ["ngram"] : SEARCH_TOKEN_CHANNELS.filter((channel) => channel !== "ngram");
  }
  return SEARCH_TOKEN_CHANNELS;
}

export function estimateSegmentWork(
  segment: SearchExecutionSnapshotHandle["segments"][number],
  analysis: SearchTextAnalysis,
  fields: readonly SearchField[] | undefined,
  channels: readonly SearchTokenChannel[]
): number {
  const allowedFieldIds = new Set((fields ?? SEARCH_PROPERTIES).map((field) => POSITIONAL_FIELD_ID[field]));
  const segmentBytes = sharedBytes(segment.bytes);
  const postingsBytes = canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.postings);
  const termDictionaryBytes = canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.termDictionary);
  if (!postingsBytes || !termDictionaryBytes) throw new Error(`segment ${segment.segmentId} is missing postings dictionaries`);
  let estimate = 0;
  for (const channel of channels) {
    for (const term of new Set(analysis.channels[channel])) {
      const entry = lookupCanonicalTermDictionaryEntry(termDictionaryBytes, canonicalPostingTerm(channel, term));
      if (!entry) continue;
      if (fields === undefined || allowedFieldIds.size === SEARCH_PROPERTIES.length) {
        estimate += entry.postingCount;
        continue;
      }
      estimate += fieldScopedPostingCount(postingsBytes, entry, allowedFieldIds);
    }
  }
  return estimate;
}

function fieldScopedPostingCount(
  postingsBytes: Uint8Array,
  entry: NonNullable<ReturnType<typeof lookupCanonicalTermDictionaryEntry>>,
  allowedFieldIds: ReadonlySet<number>
): number {
  const end = entry.postingsOffset + entry.postingsByteLength;
  if (entry.postingsOffset < 0 || end > postingsBytes.length) {
    throw new Error("term dictionary postings range is outside the postings section");
  }
  let count = 0;
  const slice = postingsBytes.subarray(entry.postingsOffset, end);
  let offset = 0;
  for (let index = 0; index < entry.postingCount; index += 1) {
    const row = readPostingFieldId(slice, offset);
    offset = row.nextOffset;
    if (allowedFieldIds.has(row.fieldId)) count += 1;
  }
  return count;
}

function readPostingFieldId(bytes: Uint8Array, offset: number): { fieldId: number; nextOffset: number } {
  const term = readUnsignedLeb128(bytes, offset);
  const fieldId = readUnsignedLeb128(bytes, term.nextOffset + term.value);
  const docId = readUnsignedLeb128(bytes, fieldId.nextOffset);
  const positionsCount = readUnsignedLeb128(bytes, docId.nextOffset);
  let nextOffset = positionsCount.nextOffset;
  for (let index = 0; index < positionsCount.value; index += 1) {
    nextOffset = readUnsignedLeb128(bytes, nextOffset).nextOffset;
  }
  return { fieldId: fieldId.value, nextOffset };
}

function readUnsignedLeb128(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let current = offset;
  while (current < bytes.length) {
    const byte = bytes[current];
    value += (byte & 0x7f) * 2 ** shift;
    current += 1;
    if ((byte & 0x80) === 0) return { value, nextOffset: current };
    shift += 7;
  }
  throw new Error("truncated unsigned LEB128 value");
}

function segmentMatchesPathFilter(
  segment: SearchExecutionSnapshotHandle["segments"][number],
  pathFilter: PathFilter | undefined
): boolean {
  if (!pathFilter) return true;
  const projection = new ProjectionReader(sharedBytes(segment.bytes), { validate: false });
  for (let localDocId = 1; localDocId <= projection.documentCount(); localDocId += 1) {
    if (matchesPathFilter(projection.doc(localDocId).path, pathFilter)) return true;
  }
  return false;
}

function compareSegments(
  left: SearchExecutionSnapshotHandle["segments"][number],
  right: SearchExecutionSnapshotHandle["segments"][number]
): number {
  return left.partitionId - right.partitionId || compareByteStrings(left.segmentId, right.segmentId);
}

function sharedBytes(handle: SharedBytesHandle): Uint8Array {
  return new Uint8Array(handle.buffer, handle.byteOffset, handle.byteLength);
}

function sharedBytesHandle(bytes: Uint8Array): SharedBytesHandle {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength
  };
}

function canonicalPostingTerm(channel: SearchTokenChannel, term: string): string {
  return `${channel}\u0000${term.normalize("NFC").trim()}`;
}

function hangulTerms(terms: readonly string[]): boolean {
  return terms.some((term) => /\p{Script=Hangul}/u.test(term));
}

function searchPlanMergeKey(
  snapshotId: string,
  channels: readonly SearchTokenChannel[],
  tasks: readonly ShardTaskPlan[]
): string {
  return [
    "snapshot",
    snapshotId.normalize("NFC"),
    "channels",
    channels.join(","),
    "segments",
    tasks.map((task) => task.mergeKey).join(",")
  ].join("\u0000");
}

function segmentMergeKey(segment: SearchExecutionSnapshotHandle["segments"][number]): string {
  return ["segment", String(segment.partitionId), segment.segmentId.normalize("NFC")].join("\u0000");
}
