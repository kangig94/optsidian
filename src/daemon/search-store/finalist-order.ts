import type { RetrievalCandidate } from '../../core/search/contracts.js';
import type { RankedCandidate } from '../../core/search/internal-types.js';
import type { SearchShardFinalist } from './result-shaping.js';

export type RankedHitEntry<T extends { candidate: RetrievalCandidate }> = {
  hit: T;
  rank: RankedCandidate;
};

export function sortedSearchShardFinalists(finalists: readonly SearchShardFinalist[]): SearchShardFinalist[] {
  return [...finalists].sort((left, right) =>
    compareRankedHitEntries({ hit: left, rank: left.rank }, { hit: right, rank: right.rank }),
  );
}

export function finalistsInBaseRankOrder(finalists: readonly SearchShardFinalist[]): SearchShardFinalist[] {
  return [...finalists].sort(
    (left, right) =>
      left.rank.baseRank - right.rank.baseRank ||
      compareByteStrings(left.rank.path, right.rank.path) ||
      compareByteStrings(left.candidate.candidateId, right.candidate.candidateId),
  );
}

export function compareRankedHitEntries<T extends { candidate: RetrievalCandidate }>(
  left: RankedHitEntry<T>,
  right: RankedHitEntry<T>,
): number {
  if (right.rank.score !== left.rank.score) return right.rank.score - left.rank.score;
  const pathOrder = compareByteStrings(left.rank.path, right.rank.path);
  if (pathOrder !== 0) return pathOrder;
  const segmentOrder = compareByteStrings(
    left.hit.candidate.shardDocRef.segmentId,
    right.hit.candidate.shardDocRef.segmentId,
  );
  if (segmentOrder !== 0) return segmentOrder;
  return left.hit.candidate.shardDocRef.localDocId - right.hit.candidate.shardDocRef.localDocId;
}

export function compareByteStrings(left: string, right: string): number {
  const leftBytes = utf8(left.normalize('NFC'));
  const rightBytes = utf8(right.normalize('NFC'));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
