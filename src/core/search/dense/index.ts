export {
  buildEmbeddingSet,
  buildEmbeddingSetFromVectors,
  computeEmbeddingSetId,
  DETERMINISTIC_HASH_EMBEDDING_RECIPE_VERSION,
  deterministicHashEmbeddingRecipeIdentity,
  EMBEDDING_RECIPE_FRESHNESS_ID_VERSION,
  EMBEDDING_SPACE_ID_VERSION,
  EMBEDDING_VECTOR_PROJECTION_VERSION,
  embeddingRecipeFreshnessId,
  embeddingRecipeIdentityForProvider,
  embeddingSpaceIdForRecipe,
  VECTOR_GENERATION_MANIFEST_ID_VERSION,
  vectorGenerationIdForManifest,
  vectorProjectionHash
} from "./embedding-set.js";

export type {
  BuiltEmbeddingSet,
  EmbeddingRecipeFreshnessId,
  EmbeddingRecipeIdentity,
  EmbeddingSetDocumentInput,
  EmbeddingSetRecord,
  EmbeddingSpaceId
} from "./embedding-set.js";

export {
  ensureLocalOnnxModelArtifact,
  HUGGINGFACE_TOKENIZERS_RUNTIME_VERSION,
  inspectLocalOnnxModelArtifact,
  LOCAL_ONNX_MODELS,
  LOCAL_ONNX_RECIPE_VERSION,
  LOCAL_ONNX_RENDERED_TEXT_PROJECTION_VERSION,
  localOnnxDataDir,
  localOnnxManifestPath,
  localOnnxModelArtifactHash,
  localOnnxModelDescriptor,
  localOnnxModelDir,
  localOnnxModelFilePath,
  localOnnxSessionModelPath,
  localOnnxTokenizerArtifactHash,
  localOnnxTokenizerConfigPath,
  localOnnxTokenizerJsonPath,
  ONNXRUNTIME_NODE_RUNTIME_VERSION,
  resolveLocalOnnxModelKey
} from "./artifacts.js";

export type {
  LocalOnnxArtifactEnsureOptions,
  LocalOnnxArtifactFile,
  LocalOnnxArtifactFileRole,
  LocalOnnxArtifactInstallResult,
  LocalOnnxArtifactManifest,
  LocalOnnxArtifactState,
  LocalOnnxModelAlias,
  LocalOnnxModelDescriptor,
  LocalOnnxModelKey
} from "./artifacts.js";

export {
  candidateExecutionProviders,
  createLocalOnnxProviderFromConfig,
  createOnnxSessionWithFallback,
  localOnnxEmbeddingRecipeIdentity,
  LocalOnnxProvider,
  meanPoolLastHiddenState,
  renderLocalOnnxEmbeddingInput,
  resolveLocalOnnxProviderSelection,
  truncateEncoding
} from "./local-onnx.js";

export type {
  LocalOnnxProviderOptions,
  LocalOnnxProviderSelection,
  LocalOnnxRuntime,
  LocalOnnxSession,
  LocalOnnxSessionSelection,
  LocalOnnxTensor,
  LocalOnnxTokenizer,
  LocalOnnxTokenizerEncoding,
  OnnxExecutionProvider,
  OnnxExecutionProviderPreference
} from "./local-onnx.js";

export {
  cosineSimilarity,
  denseAgreementFromCosine,
  DeterministicHashProvider,
  normalizeEmbeddingVector
} from "./provider.js";

export type {
  DeterministicHashProviderOptions,
  EmbeddingInputKind,
  EmbeddingProvider,
  EmbeddingProviderIdentity,
  EmbeddingVector
} from "./provider.js";

export {
  createDenseRetriever,
  DENSE_RETRIEVER_VERSION
} from "./retriever.js";

export type {
  DenseEmbeddingRecord,
  DenseEmbeddingSet,
  DenseMetric,
  DenseRetrieverOptions
} from "./retriever.js";
