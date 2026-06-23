import { uniqueSearchTerms } from "./channels.js";

const HANGUL_PATTERN = /\p{Script=Hangul}/u;
export const MIN_NGRAM = 2;
export const MAX_NGRAM = 3;
const MAX_NGRAM_SOURCE_LENGTH = 4096;
const MAX_NGRAMS_PER_TERM = 8192;

export function ngramSearchTerms(terms: readonly string[]): string[] {
  const ngrams: string[] = [];
  for (const term of terms) {
    if (!HANGUL_PATTERN.test(term)) continue;
    const grams = characterNgrams(term, MIN_NGRAM, MAX_NGRAM);
    for (const gram of grams) {
      ngrams.push(gram);
    }
  }
  return uniqueSearchTerms(ngrams);
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
