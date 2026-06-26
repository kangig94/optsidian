import type { SearchAnalyzer } from "../analyzer.js";
import {
  surfaceSearchTerms,
  uniqueSearchTerms,
  type SearchTextAnalysis,
  type SearchTokenChannel
} from "./channels.js";
import { ngramSearchTerms } from "./korean.js";

export type SearchTextAnalysisOptions = {
  ngram?: boolean;
};

export async function analyzeSearchQuery(
  raw: string,
  analyzer: SearchAnalyzer,
  options: SearchTextAnalysisOptions = {}
): Promise<SearchTextAnalysis> {
  return analyzeSearchText(raw, await analyzer.tokenize(raw), options);
}

export function analyzeSearchText(
  raw: string,
  morphTokens: readonly string[],
  options: SearchTextAnalysisOptions = {}
): SearchTextAnalysis {
  const morph = uniqueSearchTerms(morphTokens);
  const surface = surfaceSearchTerms(raw);
  const ngram = options.ngram === true ? ngramSearchTerms([...surface, ...morph]) : [];
  const primaryChannel = primarySearchChannel(morph, surface, ngram);
  return {
    raw,
    primaryChannel,
    primaryTerms: primaryTerms(primaryChannel, { morph, surface, ngram }),
    channels: {
      morph,
      surface,
      ngram
    }
  };
}

function primarySearchChannel(
  morph: readonly string[],
  surface: readonly string[],
  ngram: readonly string[]
): SearchTokenChannel {
  if (morph.length > 0) return "morph";
  if (surface.length > 0) return "surface";
  return ngram.length > 0 ? "ngram" : "morph";
}

function primaryTerms(
  channel: SearchTokenChannel,
  terms: Record<SearchTokenChannel, string[]>
): string[] {
  return terms[channel];
}
