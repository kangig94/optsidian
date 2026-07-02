import crypto from "node:crypto";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchTokenChannelTerms, UnresolvedNoteLink } from "../../core/search/analysis/index.js";
import type { CorpusSnapshotId, EmbeddingSetId, LinkGraphEdge, LinkGraphId, RetrieverPlanIdentity, RetrievalSnapshotId } from "../../core/search/contracts.js";
import type {
  EmbeddingRecipeFreshnessId,
  EmbeddingRecipeIdentity,
  EmbeddingSetRecord,
  EmbeddingSpaceId
} from "../../core/search/dense/index.js";
import type { VectorStoreKey } from "../vector-store/types.js";
import {
  canonicalValueBytes,
  type CanonicalBm25FieldStats,
  type CanonicalDocumentRecord,
  type CanonicalSnapshotManifest,
  type SnapshotIdentityTuple
} from "../../core/search/segments/index.js";
import type { SearchBuildDocument } from "../../core/search/markdown.js";
import type { SearchField, SearchSnippet } from "../../core/types.js";

export const SNAPSHOT_PERSISTENCE_SCHEMA = {
  name: "optsidian.search-store.persistence",
  snapshotEnvelope: {
    fields: [
      "schemaHash",
      "snapshotId",
      "corpusSnapshotId?",
      "linkGraphId",
      "manifest",
      "canonicalManifestSha256",
      "documents",
      "diagnostics"
    ],
    diagnostics: ["schemaHash", "analyzer", "warnings?"],
    document: ["documentId", "path", "contentHash", "partitionId", "title", "tags", "snippetCorpus"],
    snippetCorpus: ["bodyStartLine", "lines", "fallback"],
    snippetFallback: ["kind", "snippetId?", "line?"],
    snippetLine: ["snippetId", "segmentId", "documentId", "byteStart", "byteEnd", "line", "text", "channels"]
  },
  activePointer: ["schemaHash", "snapshotId", "canonicalManifestSha256"],
  retrievalEmbeddingSetEnvelope: {
    fields: ["schemaHash", "embeddingSetId", "recipe", "model", "dim", "records"],
    record: ["documentId", "path?", "text", "contentHash", "vector", "vectorProjectionHash"]
  },
  retrievalVectorSpecEnvelope: ["embeddingSetId", "generationId", "specId", "dbPath", "key?"],
  retrievalSnapshotEnvelope: [
    "schemaHash",
    "retrievalSnapshotId",
    "snapshotId",
    "corpusSnapshotId",
    "linkGraphId",
    "embeddingSetId",
    "embeddingSpaceId",
    "embeddingRecipeFreshnessId",
    "retrieverPlanIdentity",
    "rankingFeatureVersion",
    "canonicalManifestSha256",
    "embeddingSet",
    "vector",
    "freshness"
  ],
  retrievalActivePointer: [
    "schemaHash",
    "retrievalSnapshotId",
    "snapshotId",
    "corpusSnapshotId",
    "linkGraphId",
    "embeddingSetId",
    "vectorGenerationId"
  ]
} as const;

export const SNAPSHOT_PERSISTENCE_SCHEMA_HASH = crypto
  .createHash("sha256")
  .update(canonicalValueBytes(SNAPSHOT_PERSISTENCE_SCHEMA))
  .digest("hex");

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
  schemaHash: string;
  analyzer: SearchAnalyzerIdentity;
  warnings?: readonly string[];
};

export type SnapshotEnvelope = {
  schemaHash: string;
  snapshotId: string;
  corpusSnapshotId?: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestSha256: string;
  documents: readonly PersistedDocumentRecord[];
  diagnostics: SnapshotDiagnostics;
};

export type ActivePointer = {
  schemaHash: string;
  snapshotId: string;
  canonicalManifestSha256: string;
};

export type RetrievalEmbeddingSetEnvelope = {
  schemaHash: string;
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
  schemaHash: string;
  retrievalSnapshotId: RetrievalSnapshotId;
  snapshotId: string;
  corpusSnapshotId: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  embeddingSetId: EmbeddingSetId;
  embeddingSpaceId: EmbeddingSpaceId;
  embeddingRecipeFreshnessId: EmbeddingRecipeFreshnessId;
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
  schemaHash: string;
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
