import type { SearchDocument } from "../markdown.js";
import type { SearchTokenChannel } from "../analysis/index.js";

export type SearchProjectionCandidate = {
  document: SearchDocument;
  score: number;
  queryTerms: string[];
  matchedChannels: SearchTokenChannel[];
  channelScores: Partial<Record<SearchTokenChannel, number>>;
};

export type ChannelHit = {
  document: SearchDocument;
  channel: SearchTokenChannel;
  score: number;
};
