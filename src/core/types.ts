import type { ExplainTrace } from './search/contracts.js';

export type LineRange = {
  start: number;
  end: number;
};

export type ReadParams = {
  path: string;
  lines?: LineRange;
  head?: number;
  tail?: number;
  around?: string;
  context?: number;
  maxLines?: number;
};

export type ReadResult = {
  ok: true;
  command: 'read';
  path: string;
  range: {
    start: number;
    end: number;
    total: number;
  };
  truncated: boolean;
  numberedText: string;
};

export type GrepParams = {
  query: string;
  path?: string;
  context?: number;
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  all?: boolean;
  includeHidden?: boolean;
};

export type GrepLine = {
  line: number;
  text: string;
};

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
  contextBefore: GrepLine[];
  contextAfter: GrepLine[];
};

export type GrepResult = {
  ok: true;
  command: 'grep';
  query: string;
  matches: GrepMatch[];
  count: number;
};

export type SearchRetrievalMode = 'lexical' | 'vector' | 'hybrid';

export type SearchCoverageMode = 'full' | 'bounded';

export type SearchCoverageBudget = {
  work?: number;
  shards?: number;
  timeMs?: number;
};

export type SearchParams = {
  query?: string;
  path?: string;
  tags?: string[];
  fields?: string[];
  limit?: number;
  debug?: boolean;
  retrieval?: SearchRetrievalMode;
  coverage?: SearchCoverageMode;
  budget?: SearchCoverageBudget;
};

export type SearchField = 'title' | 'aliases' | 'tags' | 'headings' | 'path' | 'body';

export type SearchSnippet = {
  line: number;
  text: string;
};

export type SearchAnalyzerDebug = {
  name: string;
  version: string;
  runtime?: string;
  model?: string;
  declaredAnalyzers?: string[];
  activeAnalyzers?: string[];
};

export type SearchMatchDebug = {
  source: 'persisted';
  queryTerms: string[];
  queryChannels?: Record<string, string[]>;
  matchedChannels?: string[];
  channelScores?: Record<string, number>;
  analyzer: SearchAnalyzerDebug;
  candidateScore?: number;
  retrievalScore?: number;
  rerankScore?: number;
  baseRank?: number;
  bucket?: 'exact' | 'phrase' | 'coverage' | 'base';
  exactPriority?: number | null;
  phrasePriority?: number | null;
  coverageTerms?: number;
  coverageFieldScore?: number;
  lexicalScore?: number;
  identityScore?: number;
  exactLambda?: number;
  denseAgreement?: number;
  linkAgreement?: number;
  rrfScore?: number;
  rarityScore?: number;
  proximityScore?: number;
  bodyScore?: number;
  snapshotId?: string;
};

export type SearchMatch = {
  path: string;
  title: string;
  tags: string[];
  snippets: SearchSnippet[];
  debug?: SearchMatchDebug;
};

export type SearchDebugInfo = {
  query?: {
    raw: string;
    terms: string[];
    primaryChannel?: string;
    channels?: Record<string, string[]>;
  };
  projection: {
    source: 'persisted' | 'none';
    tokenizerTier: 'intl' | 'kiwi';
    documents: number;
    files: number;
  };
  analyzer: SearchAnalyzerDebug;
  candidates: number;
  snapshotId?: string;
  reranker?: 'unified-scalar-ac4-v1';
};

export type SearchResult = {
  ok: true;
  command: 'search';
  schemaVersion?: 1;
  available?: boolean;
  status?: 'ready' | 'index-not-ready';
  origin?: RetrieveOrigin;
  results?: RetrieveRankedResult[];
  matches: SearchMatch[];
  snapshotId?: string;
  retrievalSnapshotId?: string;
  dense?: RetrieveDenseSignal;
  debug?: SearchDebugInfo;
  warnings?: string[];
};

export type RetrieveOrigin = 'text' | 'note' | 'pair' | 'global';

export type RetrieveDenseSignalState = 'fresh' | 'stale' | 'rebuilding' | 'cold';

export type RetrieveDenseSignal = {
  state: RetrieveDenseSignalState;
  pendingCount: number;
  generationAgeMs: number | null;
};

export type RetrieveRankedResult = {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippets: SearchSnippet[];
  debug?: SearchMatchDebug;
};

export type RetrieveReadyResult = {
  ok: true;
  command: 'retrieve';
  schemaVersion: 1;
  available: true;
  status: 'ready';
  origin: RetrieveOrigin;
  snapshotId: string;
  retrievalSnapshotId?: string;
  dense: RetrieveDenseSignal;
  matches: SearchMatch[];
  results: RetrieveRankedResult[];
  debug?: SearchDebugInfo;
  explainTrace?: ExplainTrace;
  warnings?: string[];
};

export type RetrieveIndexNotReadyResult = {
  ok: true;
  command: 'retrieve';
  schemaVersion: 1;
  available: false;
  status: 'index-not-ready';
  origin: RetrieveOrigin;
  reason: string;
  dense: RetrieveDenseSignal;
  matches: [];
  results: [];
  warnings?: string[];
};

export type RetrieveResult = RetrieveReadyResult | RetrieveIndexNotReadyResult;

export type SimilarityMode = 'global' | 'left' | 'pair';

export type SimilarityProjectionField = 'title' | 'body' | 'aliases' | 'headings' | 'tags';

export type SimilarityMarkdownProjection = 'plain' | 'raw';

export type SimilarityFilterValue = null | string | number | boolean;

export type SimilarityFrontmatterFilter = {
  key: string;
  op: 'eq';
  value: SimilarityFilterValue;
};

export type SimilarityScope = {
  path?: string;
  paths?: string[];
  pathGlob?: string;
  frontmatter?: SimilarityFrontmatterFilter[];
};

export type SimilarityProjection = {
  fields?: SimilarityProjectionField[];
  stripFrontmatter?: boolean;
  markdown?: SimilarityMarkdownProjection;
};

export type SimilarityProviderParams = {
  model?: string;
};

export type SimilarityReference = {
  path?: string;
  text?: string;
  id?: string;
};

export type SimilarityParams = {
  mode?: SimilarityMode;
  scope?: SimilarityScope;
  projection?: SimilarityProjection;
  provider?: SimilarityProviderParams;
  left?: SimilarityReference;
  right?: SimilarityReference;
  topK?: number;
  minScore?: number;
};

export type NormalizedSimilarityParams = {
  mode: SimilarityMode;
  scope: {
    path?: string;
    paths: string[];
    pathGlob?: string;
    frontmatter: SimilarityFrontmatterFilter[];
  };
  projection: {
    fields: SimilarityProjectionField[];
    stripFrontmatter: boolean;
    markdown: SimilarityMarkdownProjection;
    version: string;
  };
  provider: {
    model: string;
  };
  left?: SimilarityReference;
  right?: SimilarityReference;
  topK: number;
  minScore: number;
};

export type SimilarityPairResult = {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippets: SearchSnippet[];
  debug?: SearchMatchDebug;
};

export type SimilarityResult = {
  ok: true;
  command: 'similarity';
  schemaVersion: 1;
  available: boolean;
  status: 'ready' | 'index-not-ready';
  origin: RetrieveOrigin;
  request: NormalizedSimilarityParams;
  snapshotId?: string;
  retrievalSnapshotId?: string;
  dense?: RetrieveDenseSignal;
  results: SimilarityPairResult[];
  matches: SearchMatch[];
  reason?: string;
  warnings?: string[];
};

export type SearchIndexProjectionStatus = {
  key: string;
  tier: 'intl' | 'kiwi';
  roles: Array<'active' | 'baseline' | 'cached'>;
  state: 'missing' | 'ready' | 'unreadable';
  compatible: boolean;
  staleTier?: boolean;
  documents?: number;
  files?: number;
  builtAt?: string;
};

export type SearchAnalyzerRuntimeStatus = {
  targetTier: 'intl' | 'kiwi';
  declaredAnalyzers: string[];
  activeAnalyzers: string[];
  kiwi?: {
    modelState: 'missing' | 'installed';
    modelPath: string;
    missingFiles: string[];
    analyzerState: 'unloaded' | 'loading' | 'loaded' | 'daemon';
    leaseCount: number;
    reason?: string;
  };
};

export type SearchIndexWarmAccessStatus = {
  path: string;
  recent: boolean;
  maxAgeDays: number;
  lastAccessAt?: string;
  expiresAt?: string;
};

export type SearchIndexWarmScheduleStatus = {
  path: string;
  intervalMinutes: number;
  throttled: boolean;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
};

export type SearchIndexStatusResult = {
  ok: true;
  command: 'index';
  action: 'status';
  ready: boolean;
  staleTier?: boolean;
  analyzer: SearchAnalyzerRuntimeStatus;
  projections: SearchIndexProjectionStatus[];
  warmAccess: SearchIndexWarmAccessStatus;
  warmSchedule: SearchIndexWarmScheduleStatus;
};

export type SearchIndexWarmVaultResult = {
  vaultRoot: string;
  status: 'ready' | 'failed';
  error?: string;
};

export type SearchIndexWarmResult = {
  ok: true;
  command: 'index';
  action: 'warm';
  vaults: SearchIndexWarmVaultResult[];
  warnings?: string[];
  snapshotId?: string;
};

export type SearchIndexMutationResult = {
  ok: true;
  command: 'index';
  action: 'rebuild' | 'clear';
  snapshotId?: string;
};

export type SearchIndexPrunedStore = {
  storeId: string;
  lastUsedAtMs?: number;
  lastIndexedAtMs?: number;
  bytes: number;
};

export type SearchIndexPruneSkippedStore = {
  storeId: string;
  reason: string;
};

export type SearchIndexPruneResult = {
  ok: true;
  command: 'index';
  action: 'prune';
  dryRun: boolean;
  unusedDays: number;
  cutoffAt: string;
  removedStores: SearchIndexPrunedStore[];
  skippedStores: SearchIndexPruneSkippedStore[];
  removedBytes: number;
};

export type FrontmatterValue =
  null | string | number | boolean | FrontmatterValue[] | { [key: string]: FrontmatterValue };

export type FrontmatterReadParams = {
  path: string;
};

export type FrontmatterMutationParams = {
  path: string;
  key: string;
  value?: FrontmatterValue;
  dryRun?: boolean;
};

export type FrontmatterReadResult = {
  ok: true;
  command: 'frontmatter';
  action: 'read';
  path: string;
  hasFrontmatter: boolean;
  frontmatter: Record<string, FrontmatterValue>;
};

export type ChangeCode = 'A' | 'M' | 'D';

export type FileChange = {
  code: ChangeCode;
  path: string;
  from?: string;
  before?: string;
  after?: string;
  diff?: string;
};

export type MutationResult = {
  ok: true;
  command: 'edit' | 'write' | 'copy' | 'mkdir' | 'apply_patch' | 'frontmatter';
  dryRun: boolean;
  changes: FileChange[];
  message?: string;
};

export type EditSelector =
  | { kind: 'replace'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'line'; value: number }
  | { kind: 'range'; value: LineRange };

export type EditParams = {
  path: string;
  selector: EditSelector;
  replacement: string;
  all?: boolean;
  dryRun?: boolean;
};

export type WriteParams = {
  path: string;
  content: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type CopyParams = {
  from: string;
  to: string;
  recursive?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type MkdirParams = {
  path: string;
  parents?: boolean;
  dryRun?: boolean;
};

export type PatchParams = {
  patch: string;
  dryRun?: boolean;
};
