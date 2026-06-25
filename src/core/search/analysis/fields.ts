import { surfaceSearchTerms, termsToSearchText, uniqueSearchTerms } from "./channels.js";
import { ngramSearchTerms } from "./korean.js";

export type SearchFieldTokenTexts = {
  morph: string;
  surface: string;
  ngram: string;
};

export type SearchFieldTokenTextOptions = {
  morphMaxTerms?: number;
  surfaceMaxTerms?: number;
  ngramMaxTerms?: number;
  ngramRaw?: string;
};

export function searchFieldTokenTexts(
  raw: string,
  morphTokens: readonly string[],
  options: SearchFieldTokenTextOptions = {}
): SearchFieldTokenTexts {
  const morph = limitTerms(uniqueSearchTerms(morphTokens), options.morphMaxTerms);
  const surface = limitTerms(surfaceSearchTerms(raw), options.surfaceMaxTerms);
  const ngramSurface = options.ngramRaw === undefined
    ? surface
    : limitTerms(surfaceSearchTerms(options.ngramRaw), options.surfaceMaxTerms);
  const ngram = ngramSearchTerms([...ngramSurface, ...morph], { maxTerms: options.ngramMaxTerms });
  return {
    morph: termsToSearchText(morph),
    surface: termsToSearchText(surface),
    ngram: termsToSearchText(ngram)
  };
}

function limitTerms(terms: readonly string[], maxTerms?: number): readonly string[] {
  if (typeof maxTerms !== "number" || !Number.isFinite(maxTerms)) return terms;
  const limit = Math.max(0, Math.trunc(maxTerms));
  return terms.slice(0, limit);
}
