import { SEARCH_TOKEN_CHANNELS, type SearchTextAnalysis, type SearchTokenChannel, type SearchTokenChannelTerms } from "../../core/search/analysis/index.js";
import type { NormalizedSearchParams } from "../../core/search/internal-types.js";
import { bm25BoundKey, exactDominanceLambda, type ExactDominanceBound } from "../../core/search/ranking/index.js";
import { createLinkGraphView } from "../../core/search/retrieval/link.js";
import {
  bm25TermScoreFromStatsLookup,
  buildSearchSnapshotFromSegments,
  createPositionalBm25StatsLookup,
  createSearchFieldLengthLookup,
  POSITIONAL_FIELD_BY_ID,
  type SearchSnapshot
} from "../../core/search/retrieval/positional/index.js";
import { SEARCH_PROPERTIES } from "../../core/search/schema.js";
import { sharedBytes, type SearchExecutionSnapshotHandle } from "./result-shaping.js";

export type SearchExecutionCacheStats = {
  entries: number;
  limit: number;
  hits: number;
  misses: number;
  evictions: number;
  preloads: number;
  snapshotIds: string[];
};

export type SearchExecutionPreloadResult = {
  snapshotId: string;
  cacheHit: boolean;
  cache: SearchExecutionCacheStats;
};

export type SearchExecutionWarmResult = {
  snapshotId: string;
  cacheHit: boolean;
};

export type SearchExecutionState = {
  snapshot: SearchSnapshot;
};

const SEARCH_EXECUTION_STATE_CACHE_LIMIT = envPositiveInt(process.env, "OPTSIDIAN_SEARCH_EXECUTION_CACHE_SNAPSHOTS") ?? 2;
const searchExecutionStateCache = new Map<string, SearchExecutionState>();
const bm25SingleTermBoundCache = new Map<string, ReadonlyMap<string, number>>();
const searchExecutionStateCacheCounters = {
  hits: 0,
  misses: 0,
  evictions: 0,
  preloads: 0
};

export function cachedSearchExecutionStateFromHandle(
  handle: SearchExecutionSnapshotHandle
): { state: SearchExecutionState; cacheHit: boolean } {
  const cacheKey = searchExecutionStateCacheKey(handle);
  const cached = searchExecutionStateCache.get(cacheKey);
  if (cached) {
    searchExecutionStateCacheCounters.hits += 1;
    searchExecutionStateCache.delete(cacheKey);
    searchExecutionStateCache.set(cacheKey, cached);
    return { state: cached, cacheHit: true };
  }
  searchExecutionStateCacheCounters.misses += 1;
  const state = searchExecutionStateFromHandle(handle);
  searchExecutionStateCache.set(cacheKey, state);
  while (searchExecutionStateCache.size > SEARCH_EXECUTION_STATE_CACHE_LIMIT) {
    const oldest = searchExecutionStateCache.keys().next().value;
    if (!oldest) break;
    searchExecutionStateCache.delete(oldest);
    searchExecutionStateCacheCounters.evictions += 1;
  }
  return { state, cacheHit: false };
}

export function searchExecutionStateFromHandle(handle: SearchExecutionSnapshotHandle): SearchExecutionState {
  const snapshot = buildSearchSnapshotFromSegments({
    snapshotId: handle.snapshotId,
    segments: handle.segments.map((segment) => ({
      segmentId: segment.segmentId,
      partitionId: segment.partitionId,
      bytes: sharedBytes(segment.bytes)
    })),
    bm25Stats: handle.bm25Stats,
    ...(handle.linkGraph ? { linkGraph: createLinkGraphView(handle.linkGraph) } : {}),
    validateProjection: false
  });
  return { snapshot };
}

export function searchExecutionStateFromShardHandle(handle: SearchExecutionSnapshotHandle): SearchExecutionState {
  const cached = touchCachedState(searchExecutionStateCacheKey(handle));
  if (!cached) return searchExecutionStateFromHandle(handle);

  const cachedBySegment = new Map(cached.snapshot.segments.map((segment) => [snapshotSegmentKey(segment), segment]));
  const segments = [];
  for (const requested of handle.segments) {
    const segment = cachedBySegment.get(snapshotSegmentKey(requested));
    if (!segment) return searchExecutionStateFromHandle(handle);
    segments.push(segment);
  }

  return {
    snapshot: {
      snapshotId: handle.snapshotId,
      documentCount: segments.reduce((sum, segment) => sum + segment.projection.documentCount(), 0),
      segments,
      bm25Stats: cached.snapshot.bm25Stats,
      ...(cached.snapshot.linkGraph ? { linkGraph: cached.snapshot.linkGraph } : {})
    }
  };
}

export function warmSearchExecutionSnapshot(handle: SearchExecutionSnapshotHandle): SearchExecutionWarmResult {
  const result = cachedSearchExecutionStateFromHandle(handle);
  snapshotBm25SingleTermBounds(result.state.snapshot);
  return {
    snapshotId: result.state.snapshot.snapshotId,
    cacheHit: result.cacheHit
  };
}

export function preloadSearchExecutionSnapshot(handle: SearchExecutionSnapshotHandle): SearchExecutionPreloadResult {
  const result = warmSearchExecutionSnapshot(handle);
  searchExecutionStateCacheCounters.preloads += 1;
  return {
    snapshotId: result.snapshotId,
    cacheHit: result.cacheHit,
    cache: searchExecutionCacheStats()
  };
}

export function searchExecutionCacheStats(): SearchExecutionCacheStats {
  return {
    entries: searchExecutionStateCache.size,
    limit: SEARCH_EXECUTION_STATE_CACHE_LIMIT,
    hits: searchExecutionStateCacheCounters.hits,
    misses: searchExecutionStateCacheCounters.misses,
    evictions: searchExecutionStateCacheCounters.evictions,
    preloads: searchExecutionStateCacheCounters.preloads,
    snapshotIds: [...searchExecutionStateCache.values()].map((state) => state.snapshot.snapshotId)
  };
}

export function exactDominanceBoundForSearchHandle(input: {
  search: NormalizedSearchParams;
  snapshot: SearchExecutionSnapshotHandle;
  analysis: SearchTextAnalysis;
}): ExactDominanceBound {
  const snapshot = cachedSearchExecutionStateFromHandle(input.snapshot).state.snapshot;
  return exactDominanceBoundForSearchSnapshot({
    snapshot,
    analysis: input.analysis,
    search: input.search
  });
}

export function exactDominanceBoundForSearchSnapshot(input: {
  snapshot: SearchSnapshot;
  analysis: SearchTextAnalysis;
  search: Pick<NormalizedSearchParams, "fields">;
}): ExactDominanceBound {
  return exactDominanceLambda({
    channelTermCounts: queryChannelTermCounts(input.analysis.channels),
    fields: input.search.fields ?? [...SEARCH_PROPERTIES],
    bm25SingleTermBounds: snapshotBm25SingleTermBounds(input.snapshot)
  });
}

function snapshotBm25SingleTermBounds(snapshot: SearchSnapshot): ReadonlyMap<string, number> {
  const cached = bm25SingleTermBoundCache.get(snapshot.snapshotId);
  if (cached) {
    bm25SingleTermBoundCache.delete(snapshot.snapshotId);
    bm25SingleTermBoundCache.set(snapshot.snapshotId, cached);
    return cached;
  }

  const bounds = new Map<string, number>();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const field of SEARCH_PROPERTIES) bounds.set(bm25BoundKey(channel, field), 0);
  }

  const bm25StatsLookup = createPositionalBm25StatsLookup(snapshot.bm25Stats);
  const fieldLengthLookup = createSearchFieldLengthLookup();
  for (const row of snapshot.bm25Stats.rows) {
    const field = POSITIONAL_FIELD_BY_ID[row.fieldId];
    if (!field) continue;
    const key = bm25BoundKey(row.channel, field);
    let maxScore = bounds.get(key) ?? 0;
    for (const segment of snapshot.segments) {
      for (const posting of segment.postings.postingsForTerm(canonicalPostingTerm(row.channel, row.term))) {
        if (posting.fieldId !== row.fieldId) continue;
        const fieldLength = fieldLengthLookup(segment, posting.docId, row.channel, row.fieldId);
        const score = bm25TermScoreFromStatsLookup(
          bm25StatsLookup,
          row.channel,
          row.term,
          row.fieldId,
          posting.positions.length,
          fieldLength
        );
        if (!Number.isFinite(score) || score < 0) {
          throw new Error(`invalid BM25 bound observation for ${row.channel}/${field}/${row.term}`);
        }
        if (score > maxScore) maxScore = score;
      }
    }
    bounds.set(key, maxScore);
  }

  bm25SingleTermBoundCache.set(snapshot.snapshotId, bounds);
  while (bm25SingleTermBoundCache.size > SEARCH_EXECUTION_STATE_CACHE_LIMIT) {
    const oldest = bm25SingleTermBoundCache.keys().next().value;
    if (oldest === undefined) break;
    bm25SingleTermBoundCache.delete(oldest);
  }
  return bounds;
}

function touchCachedState(snapshotId: string): SearchExecutionState | undefined {
  const cached = searchExecutionStateCache.get(snapshotId);
  if (!cached) return undefined;
  searchExecutionStateCache.delete(snapshotId);
  searchExecutionStateCache.set(snapshotId, cached);
  return cached;
}

function searchExecutionStateCacheKey(handle: SearchExecutionSnapshotHandle): string {
  return handle.linkGraph ? `${handle.snapshotId}:${handle.linkGraph.linkGraphId}` : handle.snapshotId;
}

function snapshotSegmentKey(segment: { segmentId: string; partitionId: number }): string {
  return `${segment.partitionId}\u0000${segment.segmentId}`;
}

function queryChannelTermCounts(channels: SearchTokenChannelTerms): Partial<Record<SearchTokenChannel, number>> {
  const counts: Partial<Record<SearchTokenChannel, number>> = {};
  for (const channel of SEARCH_TOKEN_CHANNELS) counts[channel] = new Set(channels[channel]).size;
  return counts;
}

function canonicalPostingTerm(channel: SearchTokenChannel, term: string): string {
  return `${channel}\u0000${term.normalize("NFC").trim()}`;
}

function envPositiveInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Number(raw));
}
