import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchTokenChannelTerms } from "../../core/search/analysis/index.js";
import type {
  CanonicalSnapshotManifest,
  SnapshotIdentityTuple
} from "../../core/search/segments/index.js";
import type { SearchDocument } from "../../core/search/markdown.js";
import type { SearchSnippet } from "../../core/types.js";

export const SNAPSHOT_ENVELOPE_SCHEMA_VERSION = 1;
export const ACTIVE_POINTER_SCHEMA_VERSION = 1;

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
  schemaVersion: typeof SNAPSHOT_ENVELOPE_SCHEMA_VERSION;
  analyzer: SearchAnalyzerIdentity;
  documents: readonly PersistedDocumentRecord[];
  warnings?: readonly string[];
};

export type SnapshotEnvelope = {
  schemaVersion: typeof SNAPSHOT_ENVELOPE_SCHEMA_VERSION;
  snapshotId: string;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestSha256: string;
  diagnostics: SnapshotDiagnostics;
};

export type ActivePointer = {
  schemaVersion: typeof ACTIVE_POINTER_SCHEMA_VERSION;
  snapshotId: string;
  canonicalManifestSha256: string;
};

export type BuiltSegment = {
  partitionId: number;
  hash: string;
  bytes: Uint8Array;
  documentIds: readonly string[];
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
