import type { CandidateSet, FeatureStore, LinkGraphView, Retriever, RetrievalQuery } from '../../contracts.js';
import type { ProjectionReader } from './segment-projection-reader.js';
import type { CanonicalSegmentPostingsReader } from './segment-postings-reader.js';
import type { PositionalBm25GlobalStats } from './snapshot.js';

export type SearchSnapshot = {
  snapshotId: string;
  documentCount: number;
  segments: readonly SearchSnapshotSegment[];
  bm25Stats: PositionalBm25GlobalStats;
  linkGraph?: LinkGraphView;
};

export type SearchSnapshotSegment = {
  segmentId: string;
  partitionId: number;
  bytes: Uint8Array;
  postings: CanonicalSegmentPostingsReader;
  projection: ProjectionReader;
};

export type SearchEngine = {
  snapshot: SearchSnapshot;
  retriever: Retriever;
  featureStore: FeatureStore;
  retrieve(query: RetrievalQuery): CandidateSet | Promise<CandidateSet>;
};

export function createSearchEngine(
  snapshot: SearchSnapshot,
  retriever: Retriever,
  featureStore: FeatureStore,
): SearchEngine {
  return {
    snapshot,
    retriever,
    featureStore,
    retrieve: (query) => retriever.retrieve(query),
  };
}
