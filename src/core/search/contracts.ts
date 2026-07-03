import type { SearchTextAnalysis, SearchTokenChannel } from './analysis/channels.js';
import type { EmbeddingVector } from './dense/provider.js';
import type { SearchField } from '../types.js';

export const SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION = 1;

type SnapshotId = string;
type SegmentId = string;
export type DocumentId = string;
type CandidateId = string;

export type ShardDocRef = {
  segmentId: SegmentId;
  partitionId: number;
  localDocId: number;
  documentId: DocumentId;
};

export type RetrieverIdentity = {
  id: string;
  version: string;
  parameters?: Record<string, unknown>;
};

export type CorpusSnapshotId = string;
export type LinkGraphId = string;
export type EmbeddingSetId = string;
export type RetrieverPlanIdentity = string;
export type RetrievalSnapshotId = string;

export type LinkGraphEdge = {
  sourcePath: string;
  targetPath: string;
  sourceDocumentId: DocumentId;
  targetDocumentId: DocumentId;
};

export type LinkGraphNeighbor = {
  documentId: DocumentId;
  path?: string;
  score: number;
  directions: readonly ('outlink' | 'inlink')[];
  edges: readonly LinkGraphEdge[];
};

export type LinkGraphData = {
  schemaVersion: 1;
  linkGraphId: LinkGraphId;
  corpusSnapshotId: CorpusSnapshotId;
  resolverVersion: string;
  edges: readonly LinkGraphEdge[];
  backlinks: readonly LinkGraphEdge[];
};

export interface LinkGraphView extends LinkGraphData {
  outlinks(documentId: DocumentId): readonly LinkGraphEdge[];
  inlinks(documentId: DocumentId): readonly LinkGraphEdge[];
  neighbors(documentId: DocumentId): readonly LinkGraphNeighbor[];
}

export type CandidateRef = {
  candidateId: CandidateId;
  documentId: DocumentId;
  shardDocRef: ShardDocRef;
  path?: string;
};

export type RetrievalQuery = {
  rawQuery: string;
  analysis: SearchTextAnalysis;
  fields?: readonly SearchField[];
  tags?: readonly string[];
  pathPrefix?: string;
  limit?: number;
  channels?: readonly SearchTokenChannel[];
  proximityWindow?: number;
  snapshotId?: SnapshotId;
  sourceDocumentId?: DocumentId;
  sourcePath?: string;
  queryVector?: EmbeddingVector;
};

export type CandidateChannelRank = {
  channel: SearchTokenChannel;
  rank: number;
  score: number;
  weightedScore: number;
  matchedTerms: readonly string[];
  fieldScores: readonly CandidateFieldScore[];
};

export type CandidateFieldScore = {
  field: SearchField;
  fieldId: number;
  score: number;
};

export type CandidatePhraseMatch = {
  channel: SearchTokenChannel;
  field: SearchField;
  fieldId: number;
  starts: readonly number[];
};

export type CandidateProximityMatch = {
  channel: SearchTokenChannel;
  field: SearchField;
  fieldId: number;
  score: number;
  window: {
    lo: number;
    hi: number;
    width: number;
  };
};

export type RetrieverSignal = {
  retrieverId: string;
  retrieverIdentity: RetrieverIdentity;
  rank: number;
  rawScore: number;
  normalizedScore: number;
  contribution: number;
};

export type CandidateRetrieverSignals = {
  lexical?: RetrieverSignal;
  dense?: RetrieverSignal;
  link?: RetrieverSignal;
  all: readonly RetrieverSignal[];
};

export type RetrievalCandidate = CandidateRef & {
  rank: number;
  retrievalScore: number;
  retrieverSignals?: CandidateRetrieverSignals;
  denseAgreement?: number;
  linkAgreement?: number;
  rrfScore?: number;
  channels: readonly CandidateChannelRank[];
  phraseMatches: readonly CandidatePhraseMatch[];
  proximityMatches: readonly CandidateProximityMatch[];
};

export type CandidateSet = {
  schemaVersion: 1;
  snapshotId?: SnapshotId;
  retrieverIdentity: RetrieverIdentity;
  retrieverPlanIdentity?: RetrieverPlanIdentity;
  complete: boolean;
  candidates: readonly RetrievalCandidate[];
};

export interface Retriever {
  readonly retrieverIdentity: RetrieverIdentity;
  retrieve(query: RetrievalQuery): CandidateSet | Promise<CandidateSet>;
}

export type CandidateBm25Feature = {
  channel: SearchTokenChannel;
  field: SearchField;
  fieldId: number;
  term: string;
  frequency: number;
  documentFrequency: number;
  documentCount: number;
  fieldLength: number;
  averageFieldLength: number;
  score: number;
};

type CandidateRarityFeature = {
  matchedWeightedTerms: number;
  totalWeightedTerms: number;
  score: number;
};

export type CandidateCoverageFeature = {
  terms: number;
  fieldScore: number;
  matched: readonly {
    channel: SearchTokenChannel;
    field: SearchField;
    term: string;
    weight: number;
  }[];
};

type CandidateIdentityFeature = {
  exactPriority: number | null;
  phrasePriority: number | null;
};

export type CandidateFeaturePayload = {
  candidate: CandidateRef;
  retrieverSignals?: CandidateRetrieverSignals;
  denseAgreement?: number;
  linkAgreement?: number;
  rrfScore?: number;
  bm25: readonly CandidateBm25Feature[];
  phrasePositions: readonly CandidatePhraseMatch[];
  proximity: readonly CandidateProximityMatch[];
  rarity: CandidateRarityFeature;
  coverage: CandidateCoverageFeature;
  identity: CandidateIdentityFeature;
  tags: readonly string[];
};

export interface FeatureStore {
  featuresFor(
    query: RetrievalQuery,
    candidates: CandidateSet,
  ): readonly CandidateFeaturePayload[] | Promise<readonly CandidateFeaturePayload[]>;
}

export type SnapshotManifestView = {
  snapshotId: SnapshotId;
  identityTuple: unknown;
  liveDocumentManifestHash: string;
  tombstoneHash: string;
  partitions: readonly unknown[];
};

export interface SnapshotView {
  readonly snapshotId: SnapshotId;
  readonly manifest: SnapshotManifestView;
  readonly linkGraphId: LinkGraphId;
  readonly linkGraph: LinkGraphView;
  segmentBytes(segmentId: SegmentId): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  segmentManifest(segmentId: SegmentId): unknown | undefined | Promise<unknown | undefined>;
  outlinks(documentId: DocumentId): readonly LinkGraphEdge[];
  inlinks(documentId: DocumentId): readonly LinkGraphEdge[];
  neighbors(documentId: DocumentId): readonly LinkGraphNeighbor[];
}

export type PinnedSnapshot = {
  snapshotId: SnapshotId;
  view: SnapshotView;
  pinToken: string;
};

export interface SnapshotStore {
  pin(vaultId: string, snapshotId?: SnapshotId): PinnedSnapshot | Promise<PinnedSnapshot>;
  load(snapshotId: SnapshotId): SnapshotView | undefined | Promise<SnapshotView | undefined>;
  release(pin: PinnedSnapshot): void | Promise<void>;
}

type RankingConfigTrace = {
  constants: unknown;
  [key: string]: unknown;
};

export type ExplainTrace = {
  schemaVersion: typeof SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION;
  rankingAlgorithmId: string;
  frozenReplayFormulaVersion: string;
  rankingConfig: RankingConfigTrace;
  inputs: {
    candidateSet: CandidateSet;
    featurePayloads: readonly CandidateFeaturePayload[];
    queryAnalysis: SearchTextAnalysis;
    rankingConfig: RankingConfigTrace;
  };
  expectedOutputHash: string;
};
