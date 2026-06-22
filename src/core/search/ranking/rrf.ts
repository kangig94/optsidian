import { RRF_K } from "../constants.js";
import type { RankedCandidate } from "../internal-types.js";

export function rankMap(
  candidates: RankedCandidate[],
  comparator: (left: RankedCandidate, right: RankedCandidate) => number
): Map<string, number> {
  const sorted = [...candidates].sort(comparator);
  return new Map(sorted.map((candidate, index) => [candidate.path, index + 1]));
}

export function rrfContribution(rank: number, weight: number): number {
  return weight / (RRF_K + rank);
}
