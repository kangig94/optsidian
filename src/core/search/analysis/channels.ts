export const SEARCH_TOKEN_CHANNELS = ["morph", "surface", "ngram"] as const;

export type SearchTokenChannel = typeof SEARCH_TOKEN_CHANNELS[number];
export type SearchTokenChannelTerms = Record<SearchTokenChannel, string[]>;

export type SearchTextAnalysis = {
  raw: string;
  primaryChannel: SearchTokenChannel;
  primaryTerms: string[];
  channels: SearchTokenChannelTerms;
};

const SURFACE_TERM_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;

export function emptySearchTokenChannels(): SearchTokenChannelTerms {
  return {
    morph: [],
    surface: [],
    ngram: []
  };
}

export function surfaceSearchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(SURFACE_TERM_PATTERN)) {
    const term = normalizeSurfaceTerm(match[0]);
    if (term) terms.push(term);
  }
  return uniqueSearchTerms(terms);
}

export function termsToSearchText(terms: readonly string[]): string {
  return uniqueSearchTerms(terms).join(" ");
}

export function uniqueSearchTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

export function tokenChannelsOverlap(left: SearchTokenChannelTerms, right: SearchTokenChannelTerms): boolean {
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const available = new Set(left[channel]);
    if (right[channel].some((term) => available.has(term))) return true;
  }
  return false;
}

function normalizeSurfaceTerm(term: string): string {
  return term.normalize("NFKC").toLowerCase().trim();
}
