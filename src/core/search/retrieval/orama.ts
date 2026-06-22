import { search as oramaSearch } from "@orama/orama";
import type { AnyOrama, Results } from "@orama/orama";
import type { SearchDocument } from "../markdown.js";
import type { SearchField } from "../../types.js";
import type { SearchTextAnalysis, SearchTokenChannel } from "../analysis/index.js";
import {
  CANDIDATE_LIMIT_MIN,
  CANDIDATE_LIMIT_MULTIPLIER,
  RRF_K,
  SEARCH_FUZZY_WEIGHT_MULTIPLIER,
  SEARCH_TOKEN_CHANNEL_WEIGHT
} from "../constants.js";
import type { NormalizedSearchParams } from "../internal-types.js";
import {
  SEARCH_FIELD_CHANNEL_BOOST,
  SEARCH_FIELD_CHANNEL_INDEX_PROPERTY,
  SEARCH_PROPERTIES
} from "../schema.js";
import type { ChannelHit, OramaProjectionCandidate } from "./candidates.js";
import { mergeChannelHits } from "./merge.js";

export async function searchOramaCandidates(
  db: AnyOrama,
  documentCount: number,
  search: NormalizedSearchParams,
  queryAnalysis: SearchTextAnalysis | undefined
): Promise<OramaProjectionCandidate[]> {
  if (documentCount < 1) return [];
  if (!queryAnalysis) return searchAllOramaCandidates(db, rawSearchLimit(documentCount, search));
  if (queryAnalysis.primaryTerms.length === 0) return [];

  const channelHits: ChannelHit[] = [];
  for (const channel of searchChannels(queryAnalysis)) {
    const terms = queryAnalysis.channels[channel];
    if (terms.length === 0) continue;
    const results = (await oramaSearch(db, {
      limit: rawSearchLimit(documentCount, search),
      term: terms.join(" "),
      properties: searchFields(search.fields).map((field) => SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]),
      boost: boostForChannelFields(channel, search.fields),
      tolerance: 0
    })) as Results<SearchDocument>;
    channelHits.push(...results.hits.map((hit, index) => ({
      document: hit.document,
      channel,
      score: SEARCH_TOKEN_CHANNEL_WEIGHT[channel] / (RRF_K + index + 1)
    })));
  }

  if (channelHits.length === 0) {
    for (const channel of fuzzySearchChannels(queryAnalysis)) {
      const terms = queryAnalysis.channels[channel];
      const results = (await oramaSearch(db, {
        limit: rawSearchLimit(documentCount, search),
        term: terms.join(" "),
        properties: searchFields(search.fields).map((field) => SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field]),
        boost: boostForChannelFields(channel, search.fields),
        tolerance: 1
      })) as Results<SearchDocument>;
      channelHits.push(...results.hits.map((hit, index) => ({
        document: hit.document,
        channel,
        score: (SEARCH_TOKEN_CHANNEL_WEIGHT[channel] * SEARCH_FUZZY_WEIGHT_MULTIPLIER) / (RRF_K + index + 1)
      })));
    }
  }

  return mergeChannelHits(channelHits, queryAnalysis.primaryTerms);
}

async function searchAllOramaCandidates(db: AnyOrama, limit: number): Promise<OramaProjectionCandidate[]> {
  const results = (await oramaSearch(db, { limit })) as Results<SearchDocument>;
  return results.hits.map((hit) => ({
    document: hit.document,
    score: hit.score,
    queryTerms: [],
    matchedChannels: [],
    channelScores: {}
  }));
}

function rawSearchLimit(documentCount: number, search: NormalizedSearchParams): number {
  return search.query
    ? Math.min(documentCount, Math.max(search.limit * CANDIDATE_LIMIT_MULTIPLIER, CANDIDATE_LIMIT_MIN))
    : search.path || search.tags
      ? documentCount
      : search.limit;
}

function searchChannels(queryAnalysis: SearchTextAnalysis): SearchTokenChannel[] {
  const channels: SearchTokenChannel[] = [];
  if (queryAnalysis.channels.morph.length > 0) channels.push("morph");
  if (queryAnalysis.channels.surface.length > 0) channels.push("surface");
  if (queryAnalysis.channels.ngram.length > 0) channels.push("ngram");
  return channels;
}

function fuzzySearchChannels(queryAnalysis: SearchTextAnalysis): SearchTokenChannel[] {
  return searchChannels(queryAnalysis).filter((channel) => {
    if (channel === "ngram") return false;
    const terms = queryAnalysis.channels[channel];
    return terms.length > 0 && terms.every(isFuzzyEligibleTerm);
  });
}

function isFuzzyEligibleTerm(term: string): boolean {
  return term.length >= 5 && /^[a-z0-9]+$/u.test(term);
}

function searchFields(fields: SearchField[] | undefined): SearchField[] {
  return fields ?? [...SEARCH_PROPERTIES];
}

function boostForChannelFields(channel: SearchTokenChannel, fields: SearchField[] | undefined): Record<string, number> {
  const allowed = new Set(searchFields(fields));
  return Object.fromEntries(
    SEARCH_PROPERTIES
      .filter((field) => allowed.has(field))
      .map((field) => [SEARCH_FIELD_CHANNEL_INDEX_PROPERTY[channel][field], SEARCH_FIELD_CHANNEL_BOOST[channel][field]])
  );
}
