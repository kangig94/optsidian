export const SEARCH_TOKEN_CHANNELS = ['morph', 'surface', 'ngram'] as const;

export type SearchTokenChannel = (typeof SEARCH_TOKEN_CHANNELS)[number];
export type SearchTokenChannelTerms = Record<SearchTokenChannel, string[]>;

export type SearchTextAnalysis = {
  raw: string;
  primaryChannel: SearchTokenChannel;
  primaryTerms: string[];
  channels: SearchTokenChannelTerms;
};

const SURFACE_TERM_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const ACRONYM_WORD_BOUNDARY = /([\p{Uppercase_Letter}]+)([\p{Uppercase_Letter}][\p{Lowercase_Letter}])/gu;
const LOWER_UPPER_BOUNDARY = /([\p{Lowercase_Letter}\p{Number}])([\p{Uppercase_Letter}])/gu;
const LETTER_NUMBER_BOUNDARY = /([\p{Letter}])(\p{Number})/gu;
const NUMBER_LETTER_BOUNDARY = /(\p{Number})([\p{Letter}])/gu;
const IDEOGRAPHIC_TERM_PATTERN = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function emptySearchTokenChannels(): SearchTokenChannelTerms {
  return {
    morph: [],
    surface: [],
    ngram: [],
  };
}

export function surfaceSearchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(SURFACE_TERM_PATTERN)) {
    terms.push(...surfaceTermVariants(match[0]));
  }
  return uniqueSearchTerms(terms);
}

export function termsToSearchText(terms: readonly string[]): string {
  return uniqueSearchTerms(terms).join(' ');
}

export function uniqueSearchTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function normalizeSurfaceTerm(term: string): string {
  return term.normalize('NFKC').toLowerCase().trim();
}

function surfaceTermVariants(raw: string): string[] {
  const normalized = normalizeSurfaceTerm(raw);
  if (!normalized) return [];

  const terms = [normalized];
  const expanded = expandSurfaceCompound(raw);
  for (const match of expanded.matchAll(SURFACE_TERM_PATTERN)) {
    const term = normalizeSurfaceTerm(match[0]);
    if (isUsefulSurfaceVariant(term, normalized)) terms.push(term);
  }
  return terms;
}

function expandSurfaceCompound(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(ACRONYM_WORD_BOUNDARY, '$1 $2')
    .replace(LOWER_UPPER_BOUNDARY, '$1 $2')
    .replace(LETTER_NUMBER_BOUNDARY, '$1 $2')
    .replace(NUMBER_LETTER_BOUNDARY, '$1 $2');
}

function isUsefulSurfaceVariant(term: string, original: string): boolean {
  if (!term) return false;
  if (term === original) return false;
  if (term.length >= 2) return true;
  return IDEOGRAPHIC_TERM_PATTERN.test(term);
}
