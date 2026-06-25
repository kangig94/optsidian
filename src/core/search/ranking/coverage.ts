import type { SearchDocument } from "../markdown.js";
import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../analysis/index.js";
import {
  COVERAGE_FIELD_WEIGHT,
  SEARCH_TOKEN_CHANNEL_WEIGHT,
  WEAK_METADATA_COVERAGE_TERMS,
  type CoverageField
} from "../constants.js";
import type { QueryContext } from "../internal-types.js";
import { SEARCH_FIELD_CHANNEL_INDEX_PROPERTY } from "../schema.js";

const WEAK_METADATA_COVERAGE_TERM_SET = new Set<string>(WEAK_METADATA_COVERAGE_TERMS);

export function metadataCoverage(doc: SearchDocument, context: QueryContext): { terms: number; fieldScore: number } {
  if (context.terms.length === 0 && SEARCH_TOKEN_CHANNELS.every((channel) => context.channels[channel].length === 0)) {
    return { terms: 0, fieldScore: 0 };
  }

  let matchedTerms = 0;
  let fieldScore = 0;
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const terms = context.channels[channel];
    if (terms.length === 0) continue;
    const values = coverageFieldValues(doc, context, channel);
    const channelWeight = SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
    for (const term of terms) {
      if (isWeakMetadataCoverageTerm(term)) continue;
      let matched = false;
      for (const [field, entries] of values) {
        if (entries.includes(term)) {
          matched = true;
          fieldScore += COVERAGE_FIELD_WEIGHT[field] * channelWeight;
        }
      }
      if (matched) matchedTerms += channelWeight;
    }
  }

  return { terms: matchedTerms, fieldScore };
}

function isWeakMetadataCoverageTerm(term: string): boolean {
  return WEAK_METADATA_COVERAGE_TERM_SET.has(term);
}

function coverageFieldValues(
  doc: SearchDocument,
  context: QueryContext,
  channel: SearchTokenChannel
): Array<[CoverageField, string[]]> {
  return [
    ["title", context.allowed.has("title") ? fieldTokens(doc, "title", channel) : []],
    ["aliases", context.allowed.has("aliases") ? fieldTokens(doc, "aliases", channel) : []],
    ["tags", context.allowed.has("tags") ? fieldTokens(doc, "tags", channel) : []],
    ["headings", context.allowed.has("headings") ? fieldTokens(doc, "headings", channel) : []],
    ["path", context.allowed.has("path") ? fieldTokens(doc, "path", channel) : []]
  ];
}

function fieldTokens(doc: SearchDocument, field: CoverageField, channel: SearchTokenChannel): string[] {
  const tokenText = doc[SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]];
  return typeof tokenText === "string" ? tokenText.split(" ").filter(Boolean) : [];
}
