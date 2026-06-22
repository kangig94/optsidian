import { uniqueSearchTerms } from "./channels.js";

const HANGUL_PATTERN = /\p{Script=Hangul}/u;
const MIN_NGRAM = 2;
const MAX_NGRAM = 3;

export function ngramSearchTerms(terms: readonly string[]): string[] {
  const ngrams: string[] = [];
  for (const term of terms) {
    if (!HANGUL_PATTERN.test(term)) continue;
    ngrams.push(...characterNgrams(term, MIN_NGRAM, MAX_NGRAM));
  }
  return uniqueSearchTerms(ngrams);
}

function characterNgrams(value: string, minLength: number, maxLength: number): string[] {
  const chars = [...value].filter((char) => HANGUL_PATTERN.test(char));
  const grams: string[] = [];
  for (let size = minLength; size <= maxLength; size += 1) {
    if (chars.length < size) continue;
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(""));
    }
  }
  return grams;
}
