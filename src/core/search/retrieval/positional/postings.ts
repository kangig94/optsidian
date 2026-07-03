import type {
  PositionalDocId,
  PositionalDocumentInput,
  PositionalFieldId,
  PositionalPosting,
  PositionalPostings,
} from './types.js';

export type PositionalPhraseMatch = {
  docId: PositionalDocId;
  fieldId: PositionalFieldId;
  starts: readonly number[];
};

type PostingKey = {
  docId: PositionalDocId;
  fieldId: PositionalFieldId;
};

const textEncoder = new TextEncoder();

export function buildPositionalPostings(documents: readonly PositionalDocumentInput[]): PositionalPostings {
  const byTermAndPosting = new Map<
    string,
    { term: string; docId: PositionalDocId; fieldId: PositionalFieldId; positions: number[] }
  >();
  for (const document of documents) {
    assertNonNegativeInteger(document.docId, 'docId');
    for (const field of document.fields) {
      assertNonNegativeInteger(field.fieldId, 'fieldId');
      field.tokens.forEach((rawTerm, position) => {
        const term = normalizeTerm(rawTerm);
        if (!term) return;
        const key = postingKey(term, document.docId, field.fieldId);
        const posting = byTermAndPosting.get(key) ?? {
          term,
          docId: document.docId,
          fieldId: field.fieldId,
          positions: [],
        };
        posting.positions.push(position);
        byTermAndPosting.set(key, posting);
      });
    }
  }

  const sortedPostings = [...byTermAndPosting.values()]
    .map((posting) => ({
      term: posting.term,
      docId: posting.docId,
      fieldId: posting.fieldId,
      positions: uniqueSorted(posting.positions),
    }))
    .sort(
      (left, right) =>
        comparePostingTerms(left.term, right.term) || left.fieldId - right.fieldId || left.docId - right.docId,
    );

  const postings = new Map<string, PositionalPosting[]>();
  for (const posting of sortedPostings) {
    const list = postings.get(posting.term) ?? [];
    list.push({ docId: posting.docId, fieldId: posting.fieldId, positions: posting.positions });
    postings.set(posting.term, list);
  }
  return postings;
}

export function positionsForTerm(
  postings: PositionalPostings,
  term: string,
  docId: PositionalDocId,
  fieldId: PositionalFieldId,
): readonly number[] {
  const normalized = normalizeTerm(term);
  const posting = postings.get(normalized)?.find((entry) => entry.docId === docId && entry.fieldId === fieldId);
  return posting?.positions ?? [];
}

export function phraseStartPositions(positionLists: readonly (readonly number[])[]): number[] {
  if (positionLists.length === 0 || positionLists.some((positions) => positions.length === 0)) return [];
  const remaining = positionLists.slice(1).map((positions) => new Set(positions));
  const starts: number[] = [];
  for (const start of positionLists[0]) {
    let matched = true;
    for (let offset = 0; offset < remaining.length; offset += 1) {
      if (!remaining[offset].has(start + offset + 1)) {
        matched = false;
        break;
      }
    }
    if (matched) starts.push(start);
  }
  return starts;
}

export function findPhraseMatches(
  postings: PositionalPostings,
  terms: readonly string[],
  options: {
    docIds?: readonly PositionalDocId[];
    fieldIds?: readonly PositionalFieldId[];
  } = {},
): PositionalPhraseMatch[] {
  const normalizedTerms = terms.map(normalizeTerm).filter(Boolean);
  if (normalizedTerms.length === 0) return [];
  const allowedDocs = options.docIds ? new Set(options.docIds) : undefined;
  const allowedFields = options.fieldIds ? new Set(options.fieldIds) : undefined;
  const firstPostings = postings.get(normalizedTerms[0]) ?? [];
  const matches: PositionalPhraseMatch[] = [];

  for (const firstPosting of firstPostings) {
    if (allowedDocs && !allowedDocs.has(firstPosting.docId)) continue;
    if (allowedFields && !allowedFields.has(firstPosting.fieldId)) continue;
    const positionLists = normalizedTerms.map((term) =>
      positionsForTerm(postings, term, firstPosting.docId, firstPosting.fieldId),
    );
    const starts = phraseStartPositions(positionLists);
    if (starts.length > 0) {
      matches.push({ docId: firstPosting.docId, fieldId: firstPosting.fieldId, starts });
    }
  }
  return matches.sort(comparePhraseMatches);
}

export function postingKeysForTerms(postings: PositionalPostings, terms: readonly string[]): PostingKey[] {
  const keySet = new Set<string>();
  const keys: PostingKey[] = [];
  for (const term of terms.map(normalizeTerm).filter(Boolean)) {
    for (const posting of postings.get(term) ?? []) {
      const key = `${posting.docId}:${posting.fieldId}`;
      if (keySet.has(key)) continue;
      keySet.add(key);
      keys.push({ docId: posting.docId, fieldId: posting.fieldId });
    }
  }
  return keys.sort((left, right) => left.docId - right.docId || left.fieldId - right.fieldId);
}

export function normalizeTerm(term: string): string {
  return term.normalize('NFC').trim();
}

function postingKey(term: string, docId: PositionalDocId, fieldId: PositionalFieldId): string {
  return `${term}\u0000${docId}\u0000${fieldId}`;
}

function uniqueSorted(values: readonly number[]): number[] {
  for (const value of values) assertNonNegativeInteger(value, 'position');
  return [...new Set(values)].sort((left, right) => left - right);
}

function comparePhraseMatches(left: PositionalPhraseMatch, right: PositionalPhraseMatch): number {
  return left.docId - right.docId || left.fieldId - right.fieldId;
}

function comparePostingTerms(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
