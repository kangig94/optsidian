import type { SearchDocument } from "../markdown.js";
import type { SearchField } from "../../types.js";
import type { QueryContext } from "../internal-types.js";
import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../analysis/index.js";
import { SEARCH_TOKEN_CHANNEL_WEIGHT } from "../constants.js";
import { SEARCH_BOOST, SEARCH_FIELD_CHANNEL_INDEX_PROPERTY, SEARCH_PROPERTIES } from "../schema.js";

export type CandidateRankSignals = {
  rarityScore: number;
  proximityScore: number;
};

export const EMPTY_RANK_SIGNALS: CandidateRankSignals = {
  rarityScore: 0,
  proximityScore: 0
};

type WeightedQueryTerm = {
  id: string;
  channel: SearchTokenChannel;
  term: string;
  weight: number;
};

export function candidateRankSignals(docs: SearchDocument[], context: QueryContext): Map<string, CandidateRankSignals> {
  const terms = weightedQueryTerms(context);
  if (docs.length === 0 || terms.length === 0) return new Map();

  const matchedByPath = new Map<string, Set<string>>();
  const documentFrequency = new Map(terms.map((term) => [term.id, 0]));
  for (const doc of docs) {
    const matched = matchedTerms(doc, context, terms);
    matchedByPath.set(doc.path, matched);
    for (const term of matched) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const rarityWeights = new Map(
    terms.map((term) => [term.id, term.weight * rarityWeight(docs.length, documentFrequency.get(term.id) ?? 0)])
  );
  const totalRarityWeight = [...rarityWeights.values()].reduce((sum, weight) => sum + weight, 0);
  const signals = new Map<string, CandidateRankSignals>();

  for (const doc of docs) {
    const matched = matchedByPath.get(doc.path) ?? new Set<string>();
    const matchedRarityWeight = [...matched].reduce((sum, term) => sum + (rarityWeights.get(term) ?? 0), 0);
    signals.set(doc.path, {
      rarityScore: totalRarityWeight > 0 ? matchedRarityWeight / totalRarityWeight : 0,
      proximityScore: bestProximityScore(doc, context)
    });
  }
  return signals;
}

function weightedQueryTerms(context: QueryContext): WeightedQueryTerm[] {
  const terms: WeightedQueryTerm[] = [];
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const term of uniqueTerms(context.channels[channel])) {
      terms.push({
        id: `${channel}:${term}`,
        channel,
        term,
        weight: SEARCH_TOKEN_CHANNEL_WEIGHT[channel]
      });
    }
  }
  return terms;
}

function uniqueTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.filter(Boolean))];
}

function rarityWeight(documentCount: number, frequency: number): number {
  if (frequency <= 0) return 0;
  return Math.log1p(documentCount / frequency);
}

function matchedTerms(doc: SearchDocument, context: QueryContext, terms: readonly WeightedQueryTerm[]): Set<string> {
  const matched = new Set<string>();
  for (const field of allowedFields(context)) {
    const tokensByChannel = new Map<SearchTokenChannel, Set<string>>();
    for (const term of terms) {
      const tokens = fieldTokenSet(doc, field, term.channel, tokensByChannel);
      if (tokens.has(term.term)) matched.add(term.id);
    }
  }
  return matched;
}

function fieldTokenSet(
  doc: SearchDocument,
  field: SearchField,
  channel: SearchTokenChannel,
  cache: Map<SearchTokenChannel, Set<string>>
): Set<string> {
  const cached = cache.get(channel);
  if (cached) return cached;
  const tokens = new Set(fieldTokens(doc, field, channel));
  cache.set(channel, tokens);
  return tokens;
}

function bestProximityScore(doc: SearchDocument, context: QueryContext): number {
  let best = 0;
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const terms = uniqueTerms(context.channels[channel]);
    if (terms.length < 2) continue;
    for (const field of allowedFields(context)) {
      const score = proximityScore(fieldTokens(doc, field, channel), terms);
      if (score === 0) continue;
      best = Math.max(best, score * fieldWeight(field) * SEARCH_TOKEN_CHANNEL_WEIGHT[channel]);
    }
  }
  return best;
}

function proximityScore(tokens: readonly string[], terms: readonly string[]): number {
  const requiredTerms = new Set(terms);
  let matchedTermsCount = 0;
  let left = 0;
  let bestWindow = Number.POSITIVE_INFINITY;
  const counts = new Map<string, number>();

  for (let right = 0; right < tokens.length; right += 1) {
    const rightToken = tokens[right];
    if (requiredTerms.has(rightToken)) {
      const count = counts.get(rightToken) ?? 0;
      counts.set(rightToken, count + 1);
      if (count === 0) matchedTermsCount += 1;
    }

    while (matchedTermsCount === requiredTerms.size) {
      bestWindow = Math.min(bestWindow, right - left + 1);
      const leftToken = tokens[left];
      if (requiredTerms.has(leftToken)) {
        const count = counts.get(leftToken) ?? 0;
        if (count <= 1) {
          counts.delete(leftToken);
          matchedTermsCount -= 1;
        } else {
          counts.set(leftToken, count - 1);
        }
      }
      left += 1;
    }
  }

  return Number.isFinite(bestWindow) ? requiredTerms.size / bestWindow : 0;
}

function allowedFields(context: QueryContext): SearchField[] {
  return SEARCH_PROPERTIES.filter((field) => context.allowed.has(field));
}

function fieldTokens(doc: SearchDocument, field: SearchField, channel: SearchTokenChannel): string[] {
  const tokenText = doc[SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]];
  return typeof tokenText === "string" ? tokenText.split(" ").filter(Boolean) : [];
}

function fieldWeight(field: SearchField): number {
  return SEARCH_BOOST[field] / SEARCH_BOOST.title;
}
