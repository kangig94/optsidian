import type { ManifestDiff, NormalizedSearchParams, PathFilter, SearchProjection, SearchProjectionHit } from "./internal-types.js";
import { analyzeSearchQuery } from "./analysis/index.js";
import { matchesPathFilter, matchesTagFilter } from "./params.js";
import { searchOramaCandidates } from "./retrieval/index.js";

export async function searchProjection(
  projection: SearchProjection,
  search: NormalizedSearchParams,
  pathFilter: PathFilter | undefined,
  excludedPaths: Set<string>
): Promise<SearchProjectionHit[]> {
  const queryAnalysis = search.query ? await analyzeSearchQuery(search.query, projection.analyzer) : undefined;
  if (search.query && (!queryAnalysis || queryAnalysis.primaryTerms.length === 0)) return [];
  const results = await searchOramaCandidates(projection.db, projection.manifest.documents, search, queryAnalysis);

  return results
    .filter(
      (hit) =>
        !excludedPaths.has(hit.document.path) &&
        (!pathFilter || matchesPathFilter(hit.document.path, pathFilter)) &&
        matchesTagFilter(hit.document.tags, search.tags)
    )
    .map((hit) => ({
      document: hit.document,
      score: hit.score,
      analyzer: projection.analyzer,
      queryTerms: hit.queryTerms,
      ...(queryAnalysis ? { queryChannels: queryAnalysis.channels } : {}),
      matchedChannels: hit.matchedChannels,
      channelScores: hit.channelScores,
      source: projection.source
    }));
}

export function mergeProjectionHits(hits: SearchProjectionHit[]): SearchProjectionHit[] {
  const byPath = new Map<string, SearchProjectionHit>();
  for (const hit of hits) {
    const existing = byPath.get(hit.document.path);
    if (!existing || hit.source === "overlay" || (existing.source !== "overlay" && hit.score > existing.score)) {
      byPath.set(hit.document.path, hit);
    }
  }
  return [...byPath.values()];
}

export function firstQueryTerms(hits: SearchProjectionHit[]): string[] {
  for (const hit of hits) {
    if (hit.queryTerms.length > 0) return hit.queryTerms;
  }
  return [];
}

export function staleResultPaths(diff: ManifestDiff): Set<string> {
  return new Set([...diff.deleted, ...diff.changed]);
}
