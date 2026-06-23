import type { CandidateSet, FeatureStore, Retriever, RetrievalQuery } from "../../contracts.js";
import type { SearchTokenChannel } from "../../analysis/index.js";
import type { SearchField } from "../../../types.js";
import type { Bm25Stats } from "./bm25.js";
import type {
  PositionalChannelIndex,
  PositionalDocumentRecord,
  PositionalPostings
} from "./types.js";

export type RankingInput = {
  candidateSet: CandidateSet;
  featurePayloads: Awaited<ReturnType<FeatureStore["featuresFor"]>>;
  query: RetrievalQuery;
  rankingConfig: unknown;
};

export type SearchSnapshot = {
  snapshotId: string;
  documents: readonly PositionalDocumentRecord[];
  postingsByChannel: PositionalChannelIndex;
  bm25: Bm25Stats;
  bm25ByChannel?: Partial<Record<SearchTokenChannel, Bm25Stats>>;
  canonicalFieldText?: ReadonlyMap<string, Partial<Record<SearchField, readonly string[]>>>;
};

export type SearchEngine = {
  snapshot: SearchSnapshot;
  retriever: Retriever;
  featureStore: FeatureStore;
  retrieve(query: RetrievalQuery): CandidateSet | Promise<CandidateSet>;
};

export function createSearchEngine(snapshot: SearchSnapshot, retriever: Retriever, featureStore: FeatureStore): SearchEngine {
  return {
    snapshot,
    retriever,
    featureStore,
    retrieve: (query) => retriever.retrieve(query)
  };
}

export function postingsForChannel(snapshot: SearchSnapshot, channel: SearchTokenChannel): PositionalPostings {
  return snapshot.postingsByChannel[channel] ?? new Map();
}
