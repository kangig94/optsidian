import type { ChildProcess } from "node:child_process";
import type { AnyOrama } from "@orama/orama";
import type { SearchAnalyzer, SearchAnalyzerIdentity } from "./analyzer.js";
import type { ParsedMarkdownNote, SearchDocument } from "./markdown.js";
import type {
  SearchField,
  SearchIndexReconcileSnapshot,
  SearchReconcileReason
} from "../types.js";
import type { SearchTokenChannel, SearchTokenChannelTerms } from "./analysis/index.js";
import type { SEARCH_RECONCILE_STATUS_SCHEMA_VERSION } from "./constants.js";

export type FileManifest = {
  mtimeMs: number;
  size: number;
};

export type SearchTokenizerTier = "intl" | "kiwi";
export type SearchManifestMismatch = "match" | "tier-only-upgrade" | "incompatible";

export type SearchManifest = {
  cacheVersion: number;
  schemaDigest: string;
  engine: string;
  optsidianVersion: string;
  builtAt: string;
  documents: number;
  tokenizerTier: SearchTokenizerTier;
  tokenizerIdentity: string;
  declaredAnalyzers: string[];
  activeAnalyzers: string[];
  nodeVersion: string;
  icuVersion: string | null;
  analyzer: SearchAnalyzerIdentity;
  files: Record<string, FileManifest>;
};

export type CachePaths = {
  cacheDir: string;
  indexDir: string;
  indexPath: string;
  manifestPath: string;
  commitPath: string;
  analysisPath: string;
};

export type LoadedIndex = {
  db: AnyOrama;
  manifest: SearchManifest;
  analyzer: SearchAnalyzer;
  warnings: string[];
};

export type SearchProjection = {
  db: AnyOrama;
  manifest: SearchManifest;
  analyzer: SearchAnalyzer;
  source: "persisted" | "overlay";
  queryTerms?: string[];
};

export type SearchProjectionHit = {
  document: SearchDocument;
  score: number;
  analyzer: SearchAnalyzer;
  queryTerms: string[];
  queryChannels?: SearchTokenChannelTerms;
  matchedChannels: SearchTokenChannel[];
  channelScores: Partial<Record<SearchTokenChannel, number>>;
  source: SearchProjection["source"];
};

export type SearchPlan = {
  projection: SearchProjection;
  diff: ManifestDiff;
  currentFiles: Record<string, FileManifest>;
  warnings: string[];
};

export type SearchOverlayLimits = {
  maxFiles: number;
  maxBytes: number;
};

export type BuildDocumentsOptions = {
  strictAnalyzerErrors?: boolean;
};

export type SearchReconcileRequester = (vaultRoot: string, analyzer: SearchAnalyzer, reason: SearchReconcileReason) => void;

export type SearchIndexWriteOptions = {
  serveStaleTier: boolean;
  fastNoop?: boolean;
};

export type SearchIndexWarmOptions = {
  fastNoop?: boolean;
  concurrency?: number;
};

export type SearchReconcileChildSpawner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

export type ActiveSearchReconcile = {
  reasons: Set<SearchReconcileReason>;
};

export type SearchReconcileLock = {
  release(): void;
};

export type SearchIndexWriterLock = {
  release(): void;
};

export type SearchReconcileLockOwner = {
  reason?: SearchReconcileReason;
  startedAt?: string;
  pid?: number;
};

export type SearchReconcileStatusFile = SearchIndexReconcileSnapshot & {
  schemaVersion: typeof SEARCH_RECONCILE_STATUS_SCHEMA_VERSION;
};

export type PathFilter = {
  rel: string;
  directory: boolean;
};

export type NormalizedSearchParams = {
  query?: string;
  path?: string;
  tags?: string[];
  fields?: SearchField[];
  limit: number;
  debug: boolean;
};

export type ManifestDiff = {
  added: string[];
  changed: string[];
  deleted: string[];
};

export type SearchTokenFields = Pick<
  SearchDocument,
  | "pathTokens"
  | "titleTokens"
  | "aliasesTokens"
  | "tagsTokens"
  | "headingsTokens"
  | "bodyTokens"
  | "pathSurfaceTokens"
  | "titleSurfaceTokens"
  | "aliasesSurfaceTokens"
  | "tagsSurfaceTokens"
  | "headingsSurfaceTokens"
  | "bodySurfaceTokens"
  | "pathNgramTokens"
  | "titleNgramTokens"
  | "aliasesNgramTokens"
  | "tagsNgramTokens"
  | "headingsNgramTokens"
  | "bodyNgramTokens"
>;

export type AnalysisCacheEntry = FileManifest & {
  tokens: SearchTokenFields;
};

export type AnalysisCache = {
  cacheVersion: number;
  analyzer: SearchAnalyzerIdentity;
  files: Record<string, AnalysisCacheEntry>;
};

export type ManifestRead = {
  raw: string;
  manifest: SearchManifest;
};

export type PersistedIndex = {
  db: AnyOrama;
  manifest: SearchManifest;
};

export type SearchIndexCommit = {
  cacheVersion: number;
  indexSha256: string;
  manifestSha256: string;
  writtenAt: string;
};

export type RankedCandidate = {
  path: string;
  title: string;
  tags: string[];
  bucket: number;
  score: number;
  baseRank: number;
  exactPriority: number;
  phrasePriority: number;
  coverageTerms: number;
  coverageFieldScore: number;
  rarityScore: number;
  proximityScore: number;
};

export type QueryContext = {
  phrase: string;
  phrases: string[];
  terms: string[];
  channels: SearchTokenChannelTerms;
  allowed: Set<SearchField>;
};

export type ParsedSearchDocument = ParsedMarkdownNote & SearchTokenFields;
