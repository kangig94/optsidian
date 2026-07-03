export {
  buildCanonicalSearchSnapshot,
  buildCanonicalSearchSnapshotFromSegments,
  contributionFromParse,
  contributionsFromSegment,
  DEFAULT_PARTITION_BITS,
  documentProjectionsFromParses,
  foldSegment,
  INDEX_AFFECTING_SEARCH_SETTINGS_HASH,
  INDEX_BUILD_VERSION,
  indexAffectingSearchSettingsHash,
  parseBuildDocumentBatch,
  reduceBuildSegment,
  resolveParsedDocumentLinkEdges,
  scanBuildDocuments,
  shuffleParsedBuildDocumentsByPartition,
  snapshotIdentityTuple,
  snapshotIdentityTupleForAnalyzerIdentity,
  sortParsedBuildDocuments
} from "./builder.js";

export type {
  BuildDocumentScan,
  BuildDocumentScanRecord,
  BuildSnapshotBase,
  BuildSnapshotDocumentLinkProjection,
  BuildSnapshotDocumentProjection,
  BuildSnapshotFromSegmentsInput,
  BuildSnapshotLiveDocumentProjection,
  BuildSnapshotPersistedDocumentProjection,
  DocumentSegmentContribution,
  DocumentSegmentFieldLengthContribution,
  DocumentSegmentFieldTextContribution,
  DocumentSegmentPostingContribution,
  ParseBuildDocumentBatchInput,
  ParseBuildDocumentBatchResult,
  ReduceBuildSegmentBaseInput,
  ReduceBuildSegmentBaseVariantInput,
  ReduceBuildSegmentFullInput,
  ReduceBuildSegmentInput,
  ReduceBuildSegmentInputs
} from "./builder.js";

export {
  DEFAULT_SEARCH_CACHE_UNUSED_DAYS,
  SEARCH_CACHE_CATALOG_SCHEMA_VERSION,
  SEARCH_CACHE_TOUCH_THROTTLE_MS,
  SearchCacheCatalog
} from "./cache-catalog.js";

export type {
  SearchCacheCatalogFile,
  SearchCacheCatalogOptions,
  SearchCacheIndexedOptions,
  SearchCachePruneOptions,
  SearchCacheRecord,
  SearchCacheTouchOptions
} from "./cache-catalog.js";

export {
  safeStoreFileName,
  searchStoreCachePaths,
  searchStoreId,
  searchStoreLedgerRootDir
} from "./cache-paths.js";

export type {
  SearchStoreCachePaths
} from "./cache-paths.js";

export {
  buildLinkGraphSidecar,
  computeLinkGraphId,
  LINK_GRAPH_RESOLVER_VERSION,
  LINK_GRAPH_SIDECAR_SCHEMA_VERSION,
  linkGraphSidecarExists,
  linkGraphSidecarPath,
  loadLinkGraphSidecar,
  loadLinkGraphView,
  storeLinkGraphSidecar,
  sweepLinkGraphSidecars
} from "./link-graph.js";

export type {
  LinkGraphSidecar,
  LinkGraphStoreOptions
} from "./link-graph.js";

export {
  decodeEditionRecord,
  durableRename,
  editionRecordChecksum,
  editionRecordEnvelope,
  encodeEditionRecord,
  fsyncDirSync,
  fsyncFileSync,
  metadataSha256,
  retrievalIdentityKey
} from "./publication.js";

export type {
  DenseEdition,
  DenseEditionBuilding,
  DenseEditionFailed,
  DenseEditionFresh,
  DenseEditionUnavailable,
  DurableRename,
  EditionCorpusRecord,
  EditionIdentity,
  EditionRecord,
  EditionRecordEnvelope,
  RetrievalIdentity
} from "./publication.js";

export {
  createLocalTenancyFenceProvider,
  denseFreshFromEdition,
  editionCoverageFromCorpus,
  EditionLedger,
  latestFreshEditionsUnder,
  liveEditionHeadsUnder,
  liveEditionsForGcUnder,
  SharedReclamationAuthority,
  VaultPublisher,
  VaultPublisherRegistry
} from "./publisher.js";

export type {
  BuildReservation,
  EditionCandidate,
  EditionCommitResult,
  EditionCommitValue,
  EditionLedgerOptions,
  SaveDiagnosticRecord,
  SharedReclamationAuthorityOptions,
  SweepLexicalArtifactsInput,
  SweepVectorGenerationsInput,
  VaultPublisherLease,
  VaultPublisherOptions,
  VaultPublisherPaths
} from "./publisher.js";

export {
  DaemonSearchStoreService,
  rankingTuningHash
} from "./service.js";

export type {
  DaemonRequestContext,
  LoadVaultOptions,
  SearchRankingTuning
} from "./service.js";

export {
  computeRetrievalSnapshotId,
  createConfiguredEmbeddingSetBuilder,
  createDaemonSnapshotStore,
  createLocalOnnxEmbeddingSetBuilder,
  createProviderEmbeddingSetBuilder,
  createWorkerEmbeddingSetBuilder,
  DaemonSnapshotStore
} from "./snapshot-store.js";

export type {
  DaemonSnapshotStoreOptions,
  DenseAttachmentResult,
  DenseGenerationPin,
  DenseSignal,
  DenseSignalState,
  DenseUsability,
  LexicalReadContextResult,
  LoadVaultResult,
  PinnedLexicalReadPin,
  PinnedRetrievalReadContext,
  PinnedRetrievalSnapshot,
  RetrievalEmbeddingBuildFoldResult,
  RetrievalEmbeddingBuildLane,
  RetrievalEmbeddingSetBuilder,
  RetrievalEmbeddingSetBuilderInput,
  RetrievalPinNotReadyReason,
  RetrievalPinResult,
  SnapshotDirtyFoldResult,
  SnapshotDirtyMark,
  SnapshotMutationResult,
  SnapshotRequestContext
} from "./snapshot-store.js";

export {
  SNAPSHOT_PERSISTENCE_SCHEMA,
  SNAPSHOT_PERSISTENCE_SCHEMA_HASH
} from "./types.js";

export type {
  BuiltSegment,
  BuiltSnapshot,
  ParsedBuildDocument,
  ParsedSnippetCorpus,
  PersistedDocumentRecord,
  ResolvedLinkEdge,
  RetrievalEmbeddingSetEnvelope,
  RetrievalSnapshotEnvelope,
  RetrievalVectorSpecEnvelope,
  SnapshotDiagnostics,
  SnapshotEnvelope,
  SnapshotSnippetCorpus,
  SnapshotSnippetFallback,
  SnapshotSnippetLine
} from "./types.js";
