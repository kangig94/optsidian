const HANGUL_PATTERN = /\p{Script=Hangul}/u;
export const MIN_NGRAM = 2;
export const MAX_NGRAM = 3;
const MAX_NGRAM_SOURCE_LENGTH = 4096;
const MAX_NGRAMS_PER_TERM = 8192;

export type NgramSearchTermOptions = {
  maxTerms?: number;
};

export function ngramSearchTerms(terms: readonly string[], options: NgramSearchTermOptions = {}): string[] {
  const maxTerms = safeMaxTerms(options.maxTerms);
  if (maxTerms === 0) return [];
  const ngrams = new Set<string>();
  for (const term of terms) {
    if (!HANGUL_PATTERN.test(term)) continue;
    const grams = characterNgrams(term, MIN_NGRAM, MAX_NGRAM);
    for (const gram of grams) {
      const normalized = gram.trim();
      if (!normalized || ngrams.has(normalized)) continue;
      ngrams.add(normalized);
      if (ngrams.size >= maxTerms) return [...ngrams];
    }
  }
  return [...ngrams];
}

function characterNgrams(value: string, minLength: number, maxLength: number): string[] {
  const bounded = value.length > MAX_NGRAM_SOURCE_LENGTH ? value.slice(0, MAX_NGRAM_SOURCE_LENGTH) : value;
  const chars = [...bounded].filter((char) => HANGUL_PATTERN.test(char));
  const grams: string[] = [];
  for (let size = minLength; size <= maxLength; size += 1) {
    if (chars.length < size) continue;
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(""));
      if (grams.length >= MAX_NGRAMS_PER_TERM) return grams;
    }
  }
  return grams;
}

function safeMaxTerms(maxTerms?: number): number {
  if (typeof maxTerms !== "number") return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxTerms)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(maxTerms));
}
