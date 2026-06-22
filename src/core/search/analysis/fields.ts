import { termsToSearchText } from "./channels.js";
import { analyzeSearchText } from "./query.js";

export type SearchFieldTokenTexts = {
  morph: string;
  surface: string;
  ngram: string;
};

export function searchFieldTokenTexts(raw: string, morphTokens: readonly string[]): SearchFieldTokenTexts {
  const analysis = analyzeSearchText(raw, morphTokens);
  return {
    morph: termsToSearchText(analysis.channels.morph),
    surface: termsToSearchText(analysis.channels.surface),
    ngram: termsToSearchText(analysis.channels.ngram)
  };
}
