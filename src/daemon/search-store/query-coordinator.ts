import { SEARCH_TOKEN_CHANNELS, type SearchTextAnalysis, type SearchTokenChannel } from "../../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import { matchesPathFilter } from "../../core/search/params.js";
import { SEARCH_PROPERTIES } from "../../core/search/schema.js";
import {
  CANONICAL_SEGMENT_SECTION,
  canonicalSegmentSectionBytes,
  lookupCanonicalTermDictionaryEntry,
  ProjectionReader
} from "../../core/search/segments/index.js";
import type { NormalizedSearchParams, PathFilter } from "../../core/search/internal-types.js";
import type { SearchField } from "../../core/types.js";
import { POSITIONAL_FIELD_ID } from "../../core/search/retrieval/positional/index.js";
import { remainingDeadlineMs } from "../protocol.js";
import type { SearchExecutionWorkerPool } from "../pools.js";
import {
  exactDominanceBoundForSearchHandle,
  hydrateSearchShardFinalists,
  type SearchExecutionResult,
  type SearchExecutionSnapshotHandle,
  type SearchShardExecutionJob,
  type SearchShardExecutionResult,
  type SharedBytesHandle
} from "../search-execution.js";

export type QueryCoordinatorInput = {
  vault: string;
  search: NormalizedSearchParams;
  pathFilter?: PathFilter;
  analysis: SearchTextAnalysis;
  analyzerIdentity: SearchAnalyzerIdentity;
  snapshot: SearchExecutionSnapshotHandle;
  deadline: number;
  cancellationId: string;
  explain?: boolean;
};

export type QueryCoordinatorOptions = {
  exhaustiveWorkCeiling?: number;
};

const DEFAULT_EXHAUSTIVE_WORK_CEILING = 10_000_000;
const EMPTY_DOCUMENTS_HANDLE = sharedBytesHandle(new TextEncoder().encode("[]"));

export class QueryCoordinator {
  private readonly exhaustiveWorkCeiling: number;
  private readonly searchExecution: SearchExecutionWorkerPool;

  constructor(
    searchExecution: SearchExecutionWorkerPool,
    options: QueryCoordinatorOptions = {}
  ) {
    this.searchExecution = searchExecution;
    this.exhaustiveWorkCeiling =
      options.exhaustiveWorkCeiling ??
      envPositiveInt("OPTSIDIAN_SEARCH_EXHAUSTIVE_WORK_CEILING") ??
      DEFAULT_EXHAUSTIVE_WORK_CEILING;
  }

  async execute(input: QueryCoordinatorInput): Promise<SearchExecutionResult> {
    assertRemainingDeadline(input.deadline, "before partition fan-out");
    const channels = fanoutSearchChannels(input.snapshot, input.analysis, input.search.fields);
    const exactBound = exactDominanceBoundForSearchHandle({
      search: input.search,
      snapshot: input.snapshot,
      analysis: input.analysis
    });
    const jobs = this.partitionJobs(input, channels, exactBound);
    const totalWorkEstimate = jobs.reduce((sum, job) => sum + job.workEstimate, 0);
    if (totalWorkEstimate > this.exhaustiveWorkCeiling) {
      throw Object.assign(
        new Error(`query exhaustive work bound ${totalWorkEstimate} exceeds ceiling ${this.exhaustiveWorkCeiling}`),
        { code: "DEADLINE_EXCEEDED" }
      );
    }
    if (jobs.length === 0) {
      return hydrateSearchShardFinalists({
        search: input.search,
        snapshot: input.snapshot,
        analysis: input.analysis,
        analyzerIdentity: input.analyzerIdentity,
        finalists: [],
        scoredCount: 0,
        explain: input.explain,
        exactBound
      });
    }

    const shardResults = await this.dispatchAllSettled(jobs, input);
    for (const result of shardResults) {
      if (result.snapshotId !== input.snapshot.snapshotId) {
        throw Object.assign(new Error(`shard returned snapshot ${result.snapshotId}, expected ${input.snapshot.snapshotId}`), { code: "INTERNAL" });
      }
    }
    const finalists = shardResults.flatMap((result) => result.finalists);
    const scoredCount = shardResults.reduce((sum, result) => sum + result.scoredCount, 0);
    return hydrateSearchShardFinalists({
      search: input.search,
      snapshot: input.snapshot,
      analysis: input.analysis,
      analyzerIdentity: input.analyzerIdentity,
      finalists,
      scoredCount,
      explain: input.explain,
      exactBound
    });
  }

  private partitionJobs(
    input: QueryCoordinatorInput,
    channels: readonly SearchTokenChannel[],
    exactBound: SearchShardExecutionJob["exactBound"]
  ): SearchShardExecutionJob[] {
    const segments = [...input.snapshot.segments]
      .filter((segment) => segmentMatchesPathFilter(segment, input.pathFilter))
      .sort((left, right) => left.partitionId - right.partitionId || compareByteStrings(left.segmentId, right.segmentId));
    return segments.map((segment) => {
      const workEstimate = estimateSegmentWork(segment, input.analysis, input.search.fields, channels);
      return {
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
          segments: [segment]
        },
        channels,
        exactBound,
        requestedLimit: input.search.limit,
        workEstimate,
        deadline: input.deadline,
        cancellationId: input.cancellationId,
        explain: input.explain
      };
    });
  }

  private async dispatchAllSettled(
    jobs: readonly SearchShardExecutionJob[],
    input: QueryCoordinatorInput
  ): Promise<SearchShardExecutionResult[]> {
    let scheduled: Awaited<ReturnType<SearchExecutionWorkerPool["dispatchSearchShards"]>>;
    try {
      scheduled = await this.searchExecution.dispatchSearchShards(jobs, {
        deadline: input.deadline,
        cancellationId: input.cancellationId,
        vault: input.vault
      });
    } catch (error) {
      this.searchExecution.cancel(input.cancellationId);
      throw error;
    }

    let firstError: unknown;
    const guarded = scheduled.map((entry) =>
      entry.promise.catch((error: unknown) => {
        if (firstError === undefined) {
          firstError = error;
          this.searchExecution.cancel(input.cancellationId);
        }
        throw error;
      })
    );
    const settled = await Promise.allSettled(guarded);
    if (firstError !== undefined) throw firstError;
    return settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }
}

function fanoutSearchChannels(
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

function estimateSegmentWork(
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
  const projection = new ProjectionReader(sharedBytes(segment.bytes));
  for (let localDocId = 1; localDocId <= projection.documentCount(); localDocId += 1) {
    if (matchesPathFilter(projection.doc(localDocId).path, pathFilter)) return true;
  }
  return false;
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

function assertRemainingDeadline(deadline: number, label: string): void {
  if (remainingDeadlineMs(deadline) <= 0) {
    throw Object.assign(new Error(`request deadline expired ${label}`), { code: "DEADLINE_EXCEEDED" });
  }
}

function envPositiveInt(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
}

function compareByteStrings(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left.normalize("NFC"));
  const rightBytes = new TextEncoder().encode(right.normalize("NFC"));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
