import crypto from 'node:crypto';
import type { SearchAnalyzerIdentity } from '../../core/search/analyzer.js';
import type { SearchTokenChannelTerms } from '../../core/search/analysis/channels.js';
import type { UnresolvedNoteLink } from '../../core/search/analysis/links.js';
import type {
  CorpusSnapshotId,
  EmbeddingSetId,
  LinkGraphEdge,
  LinkGraphId,
  RetrieverPlanIdentity,
  RetrievalSnapshotId,
} from '../../core/search/contracts.js';
import type {
  EmbeddingRecipeFreshnessId,
  EmbeddingRecipeIdentity,
  EmbeddingSetRecord,
  EmbeddingSpaceId,
} from '../../core/search/dense/embedding-set.js';
import type { VectorStoreKey } from '../vector-store/types.js';
import { canonicalValueBytes } from '../../core/search/segments/canonical.js';
import type {
  CanonicalBm25FieldStats,
  CanonicalDocumentRecord,
  CanonicalSnapshotManifest,
  SnapshotIdentityTuple,
} from '../../core/search/segments/canonical.js';
import type { SearchBuildDocument } from '../../core/search/markdown.js';
import type { SearchField, SearchSnippet } from '../../core/types.js';

export const SNAPSHOT_PERSISTENCE_SCHEMA = {
  name: 'optsidian.search-store.persistence',
  snapshotEnvelope: {
    fields: [
      'schemaHash',
      'snapshotId',
      'corpusSnapshotId?',
      'linkGraphId',
      'baseReuseImplementationIdentity?',
      'manifest',
      'canonicalManifestSha256',
      'documents',
      'diagnostics',
    ],
    diagnostics: ['schemaHash', 'analyzer', 'warnings?'],
    document: ['documentId', 'path', 'contentHash', 'partitionId', 'title', 'tags', 'snippetCorpus'],
    snippetCorpus: ['bodyStartLine', 'lines', 'fallback'],
    snippetFallback: ['kind', 'snippetId?', 'line?'],
    snippetLine: ['snippetId', 'segmentId', 'documentId', 'byteStart', 'byteEnd', 'line', 'text', 'channels'],
  },
  retrievalEmbeddingSetEnvelope: {
    fields: ['schemaHash', 'embeddingSetId', 'recipe', 'model', 'dim', 'records'],
    record: ['documentId', 'path?', 'text', 'contentHash', 'vector', 'vectorProjectionHash'],
  },
  retrievalVectorSpecEnvelope: [
    'embeddingSetId',
    'generationId',
    'specId',
    'dbPath',
    'manifestHash',
    'metadataSha256',
    'key?',
  ],
  retrievalSnapshotEnvelope: [
    'schemaHash',
    'retrievalSnapshotId',
    'snapshotId',
    'corpusSnapshotId',
    'linkGraphId',
    'embeddingSetId',
    'embeddingSpaceId',
    'embeddingRecipeFreshnessId',
    'retrieverPlanIdentity',
    'rankingFeatureVersion',
    'canonicalManifestSha256',
    'embeddingSet',
    'vector',
    'freshness',
  ],
} as const;

export const SNAPSHOT_PERSISTENCE_SCHEMA_HASH = crypto
  .createHash('sha256')
  .update(canonicalValueBytes(SNAPSHOT_PERSISTENCE_SCHEMA))
  .digest('hex');

export type PersistedDocumentRecord = {
  documentId: string;
  path: string;
  contentHash: string;
  partitionId: number;
  title: string;
  tags: string[];
  snippetCorpus: SnapshotSnippetCorpus;
};

type SnapshotDiagnostics = {
  schemaHash: string;
  analyzer: SearchAnalyzerIdentity;
  warnings?: readonly string[];
};

export type SnapshotEnvelope = {
  schemaHash: string;
  snapshotId: string;
  corpusSnapshotId?: CorpusSnapshotId;
  linkGraphId: LinkGraphId;
  baseReuseImplementationIdentity?: string;
  manifest: CanonicalSnapshotManifest;
  canonicalManifestSha256: string;
  documents: readonly PersistedDocumentRecord[];
  diagnostics: SnapshotDiagnostics;
};

export type RetrievalEmbeddingSetEnvelope = {
  schemaHash: string;
  embeddingSetId: EmbeddingSetId;
  recipe: EmbeddingRecipeIdentity;
  model: string;
  dim: number;
  records: readonly Omit<EmbeddingSetRecord, 'shardDocRef'>[];
};

type RetrievalVectorSpecEnvelope = {
  embeddingSetId: EmbeddingSetId;
  generationId: string;
  specId: string;
  dbPath: string;
  manifestHash: string;
  metadataSha256: string;
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
    state: 'fresh';
    corpusRevision: string;
  };
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
  positionTokens: Record<'morph' | 'surface' | 'ngram', Record<SearchField, readonly string[]>>;
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

type SnapshotSnippetFallback = { kind: 'line'; snippetId: string } | { kind: 'title'; line: 1 };

type SnapshotSnippetCorpus = {
  bodyStartLine: number;
  lines: SnapshotSnippetLine[];
  fallback: SnapshotSnippetFallback;
};

export type ParsedSnippetCorpus = Omit<SnapshotSnippetCorpus, 'lines'> & {
  lines: Omit<SnapshotSnippetLine, 'segmentId'>[];
};
