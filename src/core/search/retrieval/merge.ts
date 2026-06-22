import type { ChannelHit, OramaProjectionCandidate } from "./candidates.js";

export function mergeChannelHits(hits: readonly ChannelHit[], queryTerms: string[]): OramaProjectionCandidate[] {
  const byPath = new Map<string, OramaProjectionCandidate>();
  for (const hit of hits) {
    const existing = byPath.get(hit.document.path);
    if (!existing) {
      byPath.set(hit.document.path, {
        document: hit.document,
        score: hit.score,
        queryTerms,
        matchedChannels: [hit.channel],
        channelScores: { [hit.channel]: hit.score }
      });
      continue;
    }
    existing.score += hit.score;
    existing.channelScores[hit.channel] = (existing.channelScores[hit.channel] ?? 0) + hit.score;
    if (!existing.matchedChannels.includes(hit.channel)) existing.matchedChannels.push(hit.channel);
  }
  return [...byPath.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.document.path.localeCompare(right.document.path);
  });
}
