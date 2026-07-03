import crypto from 'node:crypto';
import {
  SEARCH_TOKEN_CHANNELS,
  emptySearchTokenChannels,
  type SearchTextAnalysis,
  type SearchTokenChannel,
  type SearchTokenChannelTerms,
} from '../../core/search/analysis/index.js';
import type {
  CandidateFeaturePayload,
  CandidateRef,
  CandidateSet,
  ExplainTrace,
  LinkGraphData,
  RetrievalCandidate,
} from '../../core/search/contracts.js';
import { SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION } from '../../core/search/contracts.js';
import { RANKING_CONSTANTS, SEARCH_TOKEN_CHANNEL_WEIGHT } from '../../core/search/constants.js';
import type { SearchAnalyzerIdentity } from '../../core/search/analyzer.js';
import { nullableRankPriority, rankBucketName, type ExactDominanceBound } from '../../core/search/ranking/index.js';
import type { PositionalBm25GlobalStats } from '../../core/search/retrieval/positional/index.js';
import {
  SEARCH_WARNING_BOUNDED,
  type NormalizedSearchParams,
  type RankedCandidate,
} from '../../core/search/internal-types.js';
import type { SearchMatch, SearchResult } from '../../core/types.js';
import type { PersistedDocumentRecord, SnapshotSnippetLine } from './types.js';

export type SharedBytesHandle = {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  byteLength: number;
};

export type SearchExecutionSnapshotHandle = {
  snapshotId: string;
  pinToken: string;
  bm25Stats: PositionalBm25GlobalStats;
  documents: SharedBytesHandle;
  linkGraph?: LinkGraphData;
  segments: Array<{
    segmentId: string;
    partitionId: number;
    bytes: SharedBytesHandle;
  }>;
};

export type SearchExecutionResult = SearchResult & { snapshotId: string; explainTrace?: ExplainTrace };

export type SearchHitEvidence = {
  documentId: string;
  path: string;
  shardDocRef: CandidateRef['shardDocRef'];
  score: number;
  queryTerms: string[];
  queryChannels: SearchTokenChannelTerms;
  matchedChannels: SearchTokenChannel[];
  channelScores: Partial<Record<SearchTokenChannel, number>>;
  candidate: RetrievalCandidate;
  source: 'persisted';
};

export type SearchShardFinalist = SearchHitEvidence & {
  rank: RankedCandidate;
  feature: CandidateFeaturePayload;
};

type ScoredSnippetLine = {
  line: SnapshotSnippetLine;
  score: number;
};

const textDecoder = new TextDecoder();

export function documentsFromHandle(handle: SearchExecutionSnapshotHandle): Map<string, PersistedDocumentRecord> {
  const records = JSON.parse(textDecoder.decode(sharedBytes(handle.documents))) as PersistedDocumentRecord[];
  return new Map(records.map((document) => [document.documentId, document]));
}

export function sharedBytes(handle: SharedBytesHandle): Uint8Array {
  return new Uint8Array(handle.buffer, handle.byteOffset, handle.byteLength);
}

export function documentsByPath(
  documents: ReadonlyMap<string, PersistedDocumentRecord>,
): Map<string, PersistedDocumentRecord> {
  return new Map([...documents.values()].map((record) => [record.path, record]));
}

export function snippetsForDocument(record: PersistedDocumentRecord, queryChannels: SearchTokenChannelTerms) {
  const corpus = record.snippetCorpus;
  const scoredByLine = new Map<number, ScoredSnippetLine>();
  for (const line of corpus.lines) {
    if (!snippetLineHasChannels(line) || line.line <= corpus.bodyStartLine || line.text.trim().length === 0) continue;
    const score = snippetScore(line, queryChannels);
    if (score <= 0) continue;
    const current = scoredByLine.get(line.line);
    if (!current || score > current.score) scoredByLine.set(line.line, { line, score });
  }
  const scored = topScoredSnippetLines(scoredByLine.values(), 3);
  if (scored.length > 0) return scored.map((entry) => entry.line);
  if (corpus.fallback.kind === 'line') {
    const fallbackSnippetId = corpus.fallback.snippetId;
    const fallback = corpus.lines.find((line) => line.snippetId === fallbackSnippetId);
    if (fallback) return [fallback];
  }
  return record.title ? [{ line: 1, text: record.title }] : [];
}

export function searchResult(
  matches: SearchMatch[],
  snapshotId: string,
  analyzer: SearchAnalyzerIdentity,
  search: NormalizedSearchParams,
  candidates: number,
  channels: SearchTokenChannelTerms = emptySearchTokenChannels(),
): SearchResult & { snapshotId: string } {
  return {
    ok: true,
    command: 'search',
    matches,
    snapshotId,
    ...(search.debug
      ? {
          debug: {
            ...(search.query
              ? {
                  query: {
                    raw: search.query,
                    terms: channels.morph.length > 0 ? channels.morph : channels.surface,
                    primaryChannel:
                      channels.morph.length > 0 ? 'morph' : channels.surface.length > 0 ? 'surface' : 'ngram',
                    channels: Object.fromEntries(Object.entries(channels).filter(([, terms]) => terms.length > 0)),
                  },
                }
              : {}),
            projection: {
              source: matches.length > 0 ? 'persisted' : 'none',
              tokenizerTier: (analyzer.activeAnalyzers ?? []).includes('ko') ? 'kiwi' : 'intl',
              documents: candidates,
              files: candidates,
            },
            analyzer: analyzerDebugInfo(analyzer),
            candidates,
            snapshotId,
            ...(search.query ? { reranker: 'unified-scalar-ac4-v1' as const } : {}),
          },
        }
      : {}),
  };
}

export function applySearchWarnings(result: SearchExecutionResult, warnings: readonly string[]): SearchExecutionResult {
  if (warnings.length === 0) return result;
  result.warnings = [...new Set([...(result.warnings ?? []), ...warnings])];
  if (result.explainTrace) {
    if (result.warnings.includes(SEARCH_WARNING_BOUNDED)) {
      result.explainTrace.inputs.candidateSet.complete = false;
    }
    Object.assign(result.explainTrace, { warnings: result.warnings });
  }
  return result;
}

export function matchDebug(input: {
  hit: {
    source: 'persisted';
    queryTerms: string[];
    queryChannels: SearchTokenChannelTerms;
    matchedChannels: SearchTokenChannel[];
    channelScores: Partial<Record<SearchTokenChannel, number>>;
    score: number;
    candidate: RetrievalCandidate;
  };
  rank: RankedCandidate;
  snapshotId: string;
  analyzer: SearchAnalyzerIdentity;
}): NonNullable<SearchMatch['debug']> {
  return {
    source: input.hit.source,
    queryTerms: input.hit.queryTerms,
    queryChannels: Object.fromEntries(Object.entries(input.hit.queryChannels).filter(([, terms]) => terms.length > 0)),
    matchedChannels: input.hit.matchedChannels,
    channelScores: Object.fromEntries(
      Object.entries(input.hit.channelScores).filter(([, score]) => score !== undefined),
    ),
    analyzer: analyzerDebugInfo(input.analyzer),
    candidateScore: input.hit.score,
    retrievalScore: input.hit.candidate.retrievalScore,
    rerankScore: input.rank.score,
    baseRank: input.rank.baseRank,
    bucket: rankBucketName(input.rank.bucket),
    exactPriority: nullableRankPriority(input.rank.exactPriority),
    phrasePriority: nullableRankPriority(input.rank.phrasePriority),
    coverageTerms: input.rank.coverageTerms,
    coverageFieldScore: input.rank.coverageFieldScore,
    lexicalScore: input.rank.lexicalScore,
    identityScore: input.rank.identityScore,
    exactLambda: input.rank.exactLambda,
    denseAgreement: input.rank.denseAgreement,
    linkAgreement: input.rank.linkAgreement,
    rrfScore: input.rank.rrfScore,
    rarityScore: input.rank.rarityScore,
    proximityScore: input.rank.proximityScore,
    bodyScore: input.rank.bodyScore,
    snapshotId: input.snapshotId,
  };
}

export function explainTrace(input: {
  candidateSet: CandidateSet;
  exactBound: ExactDominanceBound;
  featurePayloads: readonly CandidateFeaturePayload[];
  queryAnalysis: SearchTextAnalysis;
  ranked: readonly RankedCandidate[];
}): ExplainTrace {
  const rankingConfig = rankingConfigTrace(input.exactBound);
  const rankedOutput = rankedOutputFromRanked(normalizeTraceBaseRanks(input.ranked, input.candidateSet));
  return {
    schemaVersion: SEARCH_EXPLAIN_TRACE_SCHEMA_VERSION,
    rankingAlgorithmId: 'unified-scalar-ac4-v1',
    frozenReplayFormulaVersion: 'unified-scalar-ac4-v1/offline-1',
    rankingConfig,
    inputs: {
      candidateSet: input.candidateSet,
      featurePayloads: input.featurePayloads,
      queryAnalysis: input.queryAnalysis,
      rankingConfig,
    },
    expectedOutputHash: hashRankedOutput(rankedOutput),
  };
}

function snippetScore(line: SnapshotSnippetLine, queryChannels: SearchTokenChannelTerms): number {
  let score = 0;
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const lineTerms = line.channels[channel];
    if (lineTerms.length === 0) continue;
    for (const term of queryChannels[channel]) {
      if (lineTerms.includes(term)) score += SEARCH_TOKEN_CHANNEL_WEIGHT[channel];
    }
  }
  return score;
}

function snippetLineHasChannels(line: SnapshotSnippetLine): boolean {
  return SEARCH_TOKEN_CHANNELS.some((channel) => line.channels[channel].length > 0);
}

function topScoredSnippetLines(entries: Iterable<ScoredSnippetLine>, limit: number): ScoredSnippetLine[] {
  const output: ScoredSnippetLine[] = [];
  for (const entry of entries) {
    const insertAt = output.findIndex((current) => compareScoredSnippetLine(entry, current) < 0);
    if (insertAt < 0) output.push(entry);
    else output.splice(insertAt, 0, entry);
    if (output.length > limit) output.pop();
  }
  return output;
}

function compareScoredSnippetLine(left: ScoredSnippetLine, right: ScoredSnippetLine): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.line.line - right.line.line;
}

function analyzerDebugInfo(identity: SearchAnalyzerIdentity) {
  return {
    name: identity.name,
    version: identity.version,
    ...(identity.runtime ? { runtime: identity.runtime } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.declaredAnalyzers ? { declaredAnalyzers: [...identity.declaredAnalyzers] } : {}),
    ...(identity.activeAnalyzers ? { activeAnalyzers: [...identity.activeAnalyzers] } : {}),
  };
}

function normalizeTraceBaseRanks(ranked: readonly RankedCandidate[], candidateSet: CandidateSet): RankedCandidate[] {
  const baseRankByPath = new Map<string, number>();
  for (const [index, candidate] of candidateSet.candidates.entries()) {
    const path = candidate.path;
    if (!path || baseRankByPath.has(path)) continue;
    baseRankByPath.set(path, index + 1);
  }
  return ranked.map((candidate) => {
    const baseRank = baseRankByPath.get(candidate.path);
    return baseRank === undefined || baseRank === candidate.baseRank ? candidate : { ...candidate, baseRank };
  });
}

function rankedOutputFromRanked(ranked: readonly RankedCandidate[]) {
  return ranked.map((candidate) => ({
    path: candidate.path,
    bucket: rankBucketName(candidate.bucket),
    score: candidate.score,
    baseRank: candidate.baseRank,
    exactPriority: nullableRankPriority(candidate.exactPriority),
    phrasePriority: nullableRankPriority(candidate.phrasePriority),
    coverageTerms: candidate.coverageTerms,
    coverageFieldScore: candidate.coverageFieldScore,
    lexicalScore: candidate.lexicalScore,
    identityScore: candidate.identityScore,
    exactLambda: candidate.exactLambda,
    denseAgreement: candidate.denseAgreement,
    linkAgreement: candidate.linkAgreement,
    rrfScore: candidate.rrfScore,
    rarityScore: candidate.rarityScore,
    proximityScore: candidate.proximityScore,
    bodyScore: candidate.bodyScore,
  }));
}

function rankingConfigTrace(exactBound: ExactDominanceBound) {
  return {
    exactDominanceBound: exactBound,
    constants: RANKING_CONSTANTS,
  };
}

function hashRankedOutput(rankedOutput: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(rankedOutput)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
