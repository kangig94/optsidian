import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchTokenChannelTerms } from "../../core/search/analysis/index.js";
import type {
  CanonicalBm25FieldStats,
  CanonicalSnapshotManifest,
  CanonicalDocumentRecord,
  SnapshotIdentityTuple
} from "../../core/search/segments/index.js";
import type { SearchDocument } from "../../core/search/markdown.js";
import type { SearchField, SearchSnippet } from "../../core/types.js";

// One persistence-format version gates every on-disk snapshot artifact (envelope
// + active pointer). Bump when the snapshot envelope or active-pointer layout
// changes so an old artifact is refused at the read boundary.
export const SNAPSHOT_PERSISTENCE_VERSION = 1;

export type PersistedDocumentRecord = {
  documentId: string;
  path: string;
  contentHash: string;
  partitionId: number;
  searchDocument: SearchDocument;
  lineSnippets: SearchSnippet[];
  snippetLines: SnapshotSnippetLine[];
};

export type SnapshotDiagnostics = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  analyzer: SearchAnalyzerIdentity;
  documents: readonly PersistedDocumentRecord[];
  warnings?: readonly string[];
};

export type SnapshotEnvelope = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  snapshotId: string;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestSha256: string;
  diagnostics: SnapshotDiagnostics;
};

export type ActivePointer = {
  schemaVersion: typeof SNAPSHOT_PERSISTENCE_VERSION;
  snapshotId: string;
  canonicalManifestSha256: string;
};

export type BuiltSegment = {
  partitionId: number;
  hash: string;
  bytes: Uint8Array;
  documentIds: readonly string[];
  bm25Stats: readonly CanonicalBm25FieldStats[];
};

export type ParsedBuildDocument = {
  documentId: string;
  path: string;
  contentHash: string;
  searchDocument: SearchDocument;
  positionTokens: Record<"morph" | "surface" | "ngram", Record<SearchField, readonly string[]>>;
  canonicalRecord: CanonicalDocumentRecord;
  lineSnippets: SearchSnippet[];
  snippetLines: Omit<SnapshotSnippetLine, "segmentId">[];
  partitionId: number;
};

export type BuiltSnapshot = {
  snapshotId: string;
  identityTuple: SnapshotIdentityTuple;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestBytes: Uint8Array;
  canonicalManifestSha256: string;
  segments: readonly BuiltSegment[];
  diagnostics: SnapshotDiagnostics;
};

export type SnapshotLineSnippet = SearchSnippet & {
  source: "snapshot-field-text";
  queryChannels?: SearchTokenChannelTerms;
};

export type SnapshotSnippetLine = SearchSnippet & {
  snippetId: string;
  segmentId: string;
  documentId: string;
  byteStart: number;
  byteEnd: number;
  channels: SearchTokenChannelTerms;
};
