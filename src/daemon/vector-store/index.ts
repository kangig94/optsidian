export { coralNeedleBindingLoadStatus, loadCoralNeedleBinding } from './binding.js';

export type { CoralNeedleBindingLoadStatus } from './binding.js';

export { VECTOR_CACHE_CATALOG_SCHEMA_VERSION, VectorCacheCatalog, vectorStoreId } from './cache-catalog.js';

export type { VectorCacheCatalogFile, VectorCacheCatalogOptions, VectorCacheRecord } from './cache-catalog.js';

export {
  vectorGenerationDbPath,
  vectorGenerationDir,
  vectorStagingDbPath,
  vectorStagingDir,
  vectorStoreCachePaths,
} from './cache-paths.js';

export type { VectorStoreCachePaths } from './cache-paths.js';

export { recoverRetrievalStaging, recoverRetrievalStartupState } from './freshness.js';

export {
  loadVectorGenerationMetadata,
  loadVectorGenerationMetadataByManifest,
  storeVectorGenerationMetadata,
  sweepVectorStaging,
  vectorGenerationManifestHash,
  VectorGenerationPool,
} from './pool.js';

export type {
  BuildVectorGenerationInput,
  BuiltVectorGeneration,
  PinReadableGenerationResult,
  ReadableVectorGenerationLease,
  VectorGenerationPoolOptions,
} from './pool.js';

export { createCoralNeedleProcessInstanceFactory } from './process-instance.js';

export type { CoralNeedleProcessFactoryOptions } from './process-instance.js';

export { vectorStoreKeyString } from './types.js';

export type {
  CoralChunkRecord,
  CoralEmbeddingSpec,
  CoralNeedleBinding,
  CoralNeedleInstance,
  CoralNeedleInstanceFactory,
  CoralSearchResult,
  CoralStoreStats,
  VectorGenerationMetadata,
  VectorStoreKey,
  VectorStoreRole,
} from './types.js';

export { docIdForVaultPath, startRetrievalSaveWatcher, VaultChangeProducer } from './watcher.js';

export type {
  RetrievalSaveWatcher,
  VaultChangeProducerOptions,
  VaultDirtyMark,
  VaultDirtyMarkConsumer,
  WatchDirectory,
} from './watcher.js';
