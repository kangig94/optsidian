import type { SearchAnalyzerIdentity } from "./analyzer.js";
import type { SearchAnalyzerDebug, SearchDebugInfo, SearchMatch } from "../types.js";
import type {
  NormalizedSearchParams,
  RankedCandidate,
  SearchProjection,
  SearchProjectionHit
} from "./internal-types.js";
import type { SearchTokenChannelTerms } from "./analysis/index.js";
import { nullableRankPriority, rankBucketName } from "./ranking/index.js";

export function searchDebugInfo(
  search: NormalizedSearchParams,
  projection: SearchProjection,
  hits: SearchProjectionHit[]
): SearchDebugInfo {
  const firstHit = firstQueryHit(hits);
  return {
    ...(search.query
      ? {
          query: {
            raw: search.query,
            terms: firstHit?.queryTerms ?? [],
            ...(firstHit?.queryChannels
              ? {
                  primaryChannel: firstPrimaryQueryChannel(firstHit),
                  channels: debugQueryChannels(firstHit.queryChannels)
                }
              : {})
          }
        }
      : {}),
    projection: {
      source: searchDebugProjectionSource(hits),
      tokenizerTier: projection.manifest.tokenizerTier,
      documents: projection.manifest.documents,
      files: Object.keys(projection.manifest.files).length
    },
    analyzer: analyzerDebugInfo(projection.manifest.analyzer),
    candidates: hits.length,
    ...(search.query ? { reranker: "rrf-metadata-v2" as const } : {})
  };
}

export function searchMatchDebug(
  hit: SearchProjectionHit,
  rank: RankedCandidate | undefined
): NonNullable<SearchMatch["debug"]> {
  return {
    source: hit.source,
    queryTerms: hit.queryTerms,
    ...(hit.queryChannels ? { queryChannels: debugQueryChannels(hit.queryChannels) } : {}),
    ...(hit.matchedChannels.length > 0 ? { matchedChannels: [...hit.matchedChannels] } : {}),
    ...(Object.keys(hit.channelScores).length > 0 ? { channelScores: debugChannelScores(hit.channelScores) } : {}),
    analyzer: analyzerDebugInfo(hit.analyzer.identity),
    ...(Number.isFinite(hit.score) ? { oramaScore: hit.score } : {}),
    ...(rank
      ? {
          rerankScore: rank.score,
          baseRank: rank.baseRank,
          bucket: rankBucketName(rank.bucket),
          exactPriority: nullableRankPriority(rank.exactPriority),
          phrasePriority: nullableRankPriority(rank.phrasePriority),
          coverageTerms: rank.coverageTerms,
          coverageFieldScore: rank.coverageFieldScore,
          rarityScore: rank.rarityScore,
          proximityScore: rank.proximityScore
        }
      : {})
  };
}

function searchDebugProjectionSource(hits: SearchProjectionHit[]): SearchDebugInfo["projection"]["source"] {
  if (hits.length === 0) return "none";
  const sources = new Set(hits.map((hit) => hit.source));
  if (sources.size > 1) return "mixed";
  return hits[0]?.source ?? "none";
}

function firstQueryHit(hits: SearchProjectionHit[]): SearchProjectionHit | undefined {
  return hits.find((hit) => hit.queryTerms.length > 0 || hit.queryChannels !== undefined);
}

function firstPrimaryQueryChannel(hit: SearchProjectionHit): string | undefined {
  if (!hit.queryChannels) return undefined;
  if (hit.queryTerms.length === 0) return undefined;
  for (const [channel, terms] of Object.entries(hit.queryChannels)) {
    if (terms.length === hit.queryTerms.length && terms.every((term, index) => term === hit.queryTerms[index])) return channel;
  }
  return undefined;
}

function debugQueryChannels(channels: SearchTokenChannelTerms): Record<string, string[]> {
  return Object.fromEntries(Object.entries(channels).filter(([, terms]) => terms.length > 0));
}

function debugChannelScores(scores: SearchProjectionHit["channelScores"]): Record<string, number> {
  return Object.fromEntries(Object.entries(scores).filter(([, score]) => score !== undefined));
}

function analyzerDebugInfo(identity: SearchAnalyzerIdentity): SearchAnalyzerDebug {
  return {
    name: identity.name,
    version: identity.version,
    ...(identity.baseline ? { baseline: identity.baseline } : {}),
    ...(identity.runtime ? { runtime: identity.runtime } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.optionsHash ? { optionsHash: identity.optionsHash } : {}),
    ...(identity.declaredAnalyzers ? { declaredAnalyzers: [...identity.declaredAnalyzers] } : {}),
    ...(identity.activeAnalyzers ? { activeAnalyzers: [...identity.activeAnalyzers] } : {})
  };
}
