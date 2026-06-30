import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchTokenChannelTerms, UnresolvedNoteLink } from "../../core/search/analysis/index.js";
import type { CorpusSnapshotId, EmbeddingSetId, LinkGraphEdge, LinkGraphId, RetrieverPlanIdentity, RetrievalSnapshotId } from "../../core/search/contracts.js";
import type { EmbeddingRecipeIdentity, EmbeddingSetRecord } from "../../core/search/dense/index.js";
import type { VectorStoreKey } from "../vector-store/types.js";
import type {
  CanonicalBm25FieldStats,
  CanonicalSnapshotManifest,
  CanonicalDocumentRecord,
  SnapshotIdentityTuple
} from "../../core/search/segments/index.js";
import type { SearchBuildDocument } from "../../core/search/markdown.js";
import type { SearchField, SearchSnippet } from "../../core/types.js";

// One persistence-format version gates every on-disk snapshot artifact (envelope
// + active pointer). Bump when the snapshot envelope or active-pointer layout
// changes so an old artifact is refused at the read boundary.
export const SNAPSHOT_PERSISTENCE_VERSION = 2;

export type PersistedDocumentRecord = {
  documentId: string;
  path: string;
  contentHash: string;
  partitionId: number;
  title: string;
  tags: string[];
  snippetCorpus: SnapshotSnippetCorpus;
};

export type SnapshotDiagnostics = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  analyzer: SearchAnalyzerIdentity;
  warnings?: readonly string[];
};

export type SnapshotEnvelope = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  snapshotId: string;
  corpusSnapshotId?: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestSha256: string;
  documents: readonly PersistedDocumentRecord[];
  diagnostics: SnapshotDiagnostics;
};

export type ActivePointer = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  snapshotId: string;
  canonicalManifestSha256: string;
};

export type RetrievalEmbeddingSetEnvelope = {
  schemaVersion: 1;
  embeddingSetId: EmbeddingSetId;
  recipe: EmbeddingRecipeIdentity;
  model: string;
  dim: number;
  records: readonly Omit<EmbeddingSetRecord, "shardDocRef">[];
};

export type RetrievalVectorSpecEnvelope = {
  embeddingSetId: EmbeddingSetId;
  generationId: string;
  specId: string;
  dbPath: string;
  key?: VectorStoreKey;
};

export type RetrievalSnapshotEnvelope = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  retrievalSnapshotId: RetrievalSnapshotId;
  snapshotId: string;
  corpusSnapshotId: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  embeddingSetId: EmbeddingSetId;
  retrieverPlanIdentity: RetrieverPlanIdentity;
  rankingFeatureVersion: string;
  canonicalManifestSha256: string;
  embeddingSet: RetrievalEmbeddingSetEnvelope;
  vector: RetrievalVectorSpecEnvelope;
  freshness: {
    state: "fresh";
    corpusRevision: string;
  };
};

export type RetrievalActivePointer = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  retrievalSnapshotId: RetrievalSnapshotId;
  snapshotId: string;
  corpusSnapshotId: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  embeddingSetId: EmbeddingSetId;
  vectorGenerationId: string;
};

export type BuiltSegment = {
  partitionId: number;
  hash: string;
  bytes: Uint8Array;
  documentIds: readonly string[];
  bm25Stats: readonly CanonicalBm25FieldStats[];
};

export type ResolvedLinkEdge = LinkGraphEdge;

export type ParsedBuildDocument = {
  documentId: string;
  path: string;
  contentHash: string;
  unresolvedLinks: readonly UnresolvedNoteLink[];
  searchDocument: SearchBuildDocument;
  positionTokens: Record<"morph" | "surface" | "ngram", Record<SearchField, readonly string[]>>;
  canonicalRecord: CanonicalDocumentRecord;
  snippetCorpus: ParsedSnippetCorpus;
  partitionId: number;
};

export type BuiltSnapshot = {
  snapshotId: string;
  corpusSnapshotId: CorpusSnapshotId;
  identityTuple: SnapshotIdentityTuple;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestBytes: Uint8Array;
  canonicalManifestSha256: string;
  segments: readonly BuiltSegment[];
  documents: readonly PersistedDocumentRecord[];
  linkGraphId: LinkGraphId;
  linkEdges: readonly ResolvedLinkEdge[];
  diagnostics: SnapshotDiagnostics;
};

export type SnapshotSnippetLine = SearchSnippet & {
  snippetId: string;
  segmentId: string;
  documentId: string;
  byteStart: number;
  byteEnd: number;
  channels: SearchTokenChannelTerms;
};

export type SnapshotSnippetFallback =
  | { kind: "line"; snippetId: string }
  | { kind: "title"; line: 1 };

export type SnapshotSnippetCorpus = {
  bodyStartLine: number;
  lines: SnapshotSnippetLine[];
  fallback: SnapshotSnippetFallback;
};

export type ParsedSnippetCorpus = Omit<SnapshotSnippetCorpus, "lines"> & {
  lines: Omit<SnapshotSnippetLine, "segmentId">[];
};
