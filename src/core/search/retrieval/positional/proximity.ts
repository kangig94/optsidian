import { normalizeTerm, positionsForTerm, postingKeysForTerms } from './postings.js';
import type { PositionalDocId, PositionalFieldId, PositionalPostings } from './types.js';

export type TermWindow = {
  lo: number;
  hi: number;
  width: number;
};

export type PositionalProximityMatch = {
  docId: PositionalDocId;
  fieldId: PositionalFieldId;
  score: number;
  window: TermWindow;
};

type MergedPosition = {
  termIndex: number;
  position: number;
};

export function minimumTermWindow(positionLists: readonly (readonly number[])[]): TermWindow | undefined {
  if (positionLists.length === 0 || positionLists.some((positions) => positions.length === 0)) return undefined;
  const merged: MergedPosition[] = [];
  positionLists.forEach((positions, termIndex) => {
    for (const position of positions) merged.push({ termIndex, position });
  });
  merged.sort((left, right) => left.position - right.position || left.termIndex - right.termIndex);

  const counts = new Map<number, number>();
  let covered = 0;
  let left = 0;
  let best: TermWindow | undefined;
  for (let right = 0; right < merged.length; right += 1) {
    const rightTerm = merged[right].termIndex;
    const rightCount = counts.get(rightTerm) ?? 0;
    counts.set(rightTerm, rightCount + 1);
    if (rightCount === 0) covered += 1;

    while (covered === positionLists.length && left <= right) {
      const lo = merged[left].position;
      const hi = merged[right].position;
      const width = hi - lo + 1;
      if (!best || width < best.width || (width === best.width && lo < best.lo)) best = { lo, hi, width };

      const leftTerm = merged[left].termIndex;
      const leftCount = counts.get(leftTerm) ?? 0;
      if (leftCount <= 1) {
        counts.delete(leftTerm);
        covered -= 1;
      } else {
        counts.set(leftTerm, leftCount - 1);
      }
      left += 1;
    }
  }
  return best;
}

export function proximityScore(positionLists: readonly (readonly number[])[]): number {
  const window = minimumTermWindow(positionLists);
  return window ? positionLists.length / window.width : 0;
}

export function findProximityMatches(
  postings: PositionalPostings,
  terms: readonly string[],
  options: {
    maxWindow?: number;
    docIds?: readonly PositionalDocId[];
    fieldIds?: readonly PositionalFieldId[];
  } = {},
): PositionalProximityMatch[] {
  const normalizedTerms = uniqueTerms(terms.map(normalizeTerm).filter(Boolean));
  if (normalizedTerms.length === 0) return [];
  const allowedDocs = options.docIds ? new Set(options.docIds) : undefined;
  const allowedFields = options.fieldIds ? new Set(options.fieldIds) : undefined;
  const matches: PositionalProximityMatch[] = [];

  for (const key of postingKeysForTerms(postings, normalizedTerms)) {
    if (allowedDocs && !allowedDocs.has(key.docId)) continue;
    if (allowedFields && !allowedFields.has(key.fieldId)) continue;
    const positionLists = normalizedTerms.map((term) => positionsForTerm(postings, term, key.docId, key.fieldId));
    const window = minimumTermWindow(positionLists);
    if (!window) continue;
    if (options.maxWindow !== undefined && window.width > options.maxWindow) continue;
    matches.push({
      docId: key.docId,
      fieldId: key.fieldId,
      score: normalizedTerms.length / window.width,
      window,
    });
  }
  return matches.sort((left, right) => left.docId - right.docId || left.fieldId - right.fieldId);
}

function uniqueTerms(terms: readonly string[]): string[] {
  return [...new Set(terms)];
}
