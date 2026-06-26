import type { SearchTextAnalysis, SearchTokenChannel, SearchTokenChannelTerms } from "./analysis/index.js";
import type { SearchDocument } from "./markdown.js";
import type { SearchField, SearchSnippet } from "../types.js";

export const SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION = 1;

export type SnapshotId = string;
export type SegmentId = string;
export type DocumentId = string;
export type CandidateId = string;

export type RetrieverIdentity = {
  id: string;
  version: string;
  parameters?: Record<string, unknown>;
};

export type CandidateRef = {
  candidateId: CandidateId;
  documentId: DocumentId;
  ordinalDocId?: number;
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

export type RetrievalCandidate = CandidateRef & {
  rank: number;
  retrievalScore: number;
  channels: readonly CandidateChannelRank[];
  phraseMatches: readonly CandidatePhraseMatch[];
  proximityMatches: readonly CandidateProximityMatch[];
};

export type CandidateSet = {
  schemaVersion: 1;
  snapshotId?: SnapshotId;
  retrieverIdentity: RetrieverIdentity;
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

export type CandidateRarityFeature = {
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

export type CandidateIdentityFeature = {
  exactPriority: number | null;
  phrasePriority: number | null;
  canonicalFieldText: Partial<Record<SearchField, readonly string[]>>;
};

export type SnippetScoringInput = {
  snippetId: string;
  line: number;
  text: string;
  field?: SearchField;
  channels: SearchTokenChannelTerms;
  byteSpan?: {
    start: number;
    end: number;
  };
};

export type CandidateFeaturePayload = {
  candidate: CandidateRef;
  bm25: readonly CandidateBm25Feature[];
  phrasePositions: readonly CandidatePhraseMatch[];
  proximity: readonly CandidateProximityMatch[];
  rarity: CandidateRarityFeature;
  coverage: CandidateCoverageFeature;
  identity: CandidateIdentityFeature;
  tags: readonly string[];
  snippetScoringInputs: readonly SnippetScoringInput[];
};

export interface FeatureStore {
  featuresFor(query: RetrievalQuery, candidates: CandidateSet): readonly CandidateFeaturePayload[] | Promise<readonly CandidateFeaturePayload[]>;
  canonicalFieldText(candidate: CandidateRef, field: SearchField): readonly string[] | undefined;
}

export type SnapshotManifestView = {
  snapshotId: SnapshotId;
  identityTuple: unknown;
  liveDocumentManifestHash: string;
  tombstoneHash: string;
  partitions: readonly unknown[];
};

export type SnapshotSnippetRequest = CandidateRef & {
  maxSnippets?: number;
};

export interface SnapshotView {
  readonly snapshotId: SnapshotId;
  readonly manifest: SnapshotManifestView;
  segmentBytes(segmentId: SegmentId): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  segmentManifest(segmentId: SegmentId): unknown | undefined | Promise<unknown | undefined>;
  document(documentId: DocumentId): SearchDocument | undefined | Promise<SearchDocument | undefined>;
  canonicalFieldText(documentId: DocumentId, field: SearchField): readonly string[] | undefined | Promise<readonly string[] | undefined>;
  snippets(request: SnapshotSnippetRequest): readonly SearchSnippet[] | Promise<readonly SearchSnippet[]>;
  snippetBytes(snippetId: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
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

export type RankingConfigTrace = {
  rrfK: number;
  weights: Record<string, number>;
  signalWeights: Record<string, number>;
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
