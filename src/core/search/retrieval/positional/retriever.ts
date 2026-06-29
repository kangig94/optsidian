import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../analysis/index.js";
import type {
  CandidateChannelRank,
  CandidateFieldScore,
  CandidatePhraseMatch,
  CandidateProximityMatch,
  CandidateSet,
  Retriever,
  RetrieverIdentity,
  RetrievalCandidate,
  RetrievalQuery,
  ShardDocRef
} from "../../contracts.js";
import type { SearchField } from "../../../types.js";
import { bm25TermScoreFromGlobalStats } from "./snapshot.js";
import { fieldChannelBm25Boost, tokenChannelFusionWeight } from "./bm25.js";
import type { SearchSnapshot, SearchSnapshotSegment } from "./engine.js";
import { normalizeTerm, phraseStartPositions } from "./postings.js";
import { minimumTermWindow } from "./proximity.js";
import {
  POSITIONAL_FIELD_BY_ID,
  POSITIONAL_FIELD_ID,
  POSITIONAL_SEARCH_FIELDS
} from "./types.js";
import type { CanonicalPosting } from "../../segments/index.js";

export const POSITIONAL_RETRIEVER_IDENTITY: RetrieverIdentity = {
  id: "positional-lexical",
  version: "3",
  parameters: {
    hangulFallback: "ngram-to-morph-surface-when-empty"
  }
};

type CandidateBuilder = {
  candidateId: string;
  documentId: string;
  shardDocRef: ShardDocRef;
  documentKey: string;
  path?: string;
  retrievalScore: number;
  channels: CandidateChannelRank[];
  phraseMatches: CandidatePhraseMatch[];
  proximityMatches: CandidateProximityMatch[];
};

type ChannelScoredDocument = {
  ref: ShardDocRef;
  segment: SearchSnapshotSegment;
  score: number;
  matchedTerms: readonly string[];
  fieldScores: readonly CandidateFieldScore[];
};

type MatchedDocumentFields = {
  ref: ShardDocRef;
  segment: SearchSnapshotSegment;
  fieldsById: Map<number, Map<string, number>>;
};

type SegmentPhraseMatch = {
  ref: ShardDocRef;
  fieldId: number;
  starts: readonly number[];
};

type SegmentProximityMatch = {
  ref: ShardDocRef;
  fieldId: number;
  score: number;
  window: {
    lo: number;
    hi: number;
    width: number;
  };
};

export type QueryPostingsLookup = (segment: SearchSnapshotSegment, canonicalTerm: string) => readonly CanonicalPosting[];

export function createPositionalRetriever(snapshot: SearchSnapshot, postingsLookup?: QueryPostingsLookup): Retriever {
  return {
    retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
    retrieve: (query) => retrievePositionalCandidates(snapshot, query, postingsLookup)
  };
}

export function retrievePositionalCandidates(
  snapshot: SearchSnapshot,
  query: RetrievalQuery,
  postingsLookup = createQueryPostingsLookup()
): CandidateSet {
  const fields = allowedFields(query.fields);
  const candidateBuilders = new Map<string, CandidateBuilder>();
  const explicitChannels = Boolean(query.channels);
  const channels = positionalSearchChannels(query);
  const searchedChannels = new Set<SearchTokenChannel>();

  const searchChannel = (channel: SearchTokenChannel) => {
    searchedChannels.add(channel);
    const terms = query.analysis.channels[channel].map((term) => term.normalize("NFC").trim()).filter(Boolean);
    if (terms.length === 0) return;
    const channelScores = scoreChannel(snapshot, channel, terms, fields, postingsLookup);
    channelScores.forEach((scored, index) => {
      const rank = index + 1;
      const builder = candidateBuilder(scored.segment, candidateBuilders, scored.ref);
      const weightedScore = tokenChannelFusionWeight(channel) * scored.score;
      builder.retrievalScore += weightedScore;
      builder.channels.push({
        channel,
        rank,
        score: scored.score,
        weightedScore,
        matchedTerms: scored.matchedTerms,
        fieldScores: scored.fieldScores
      });
    });

    for (const phraseMatch of findSegmentPhraseMatches(snapshot, channel, terms, fields, postingsLookup)) {
      const segment = segmentForRef(snapshot, phraseMatch.ref);
      candidateBuilder(segment, candidateBuilders, phraseMatch.ref).phraseMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[phraseMatch.fieldId],
        fieldId: phraseMatch.fieldId,
        starts: phraseMatch.starts
      });
    }
    for (const proximityMatch of findSegmentProximityMatches(snapshot, channel, terms, fields, query.proximityWindow, postingsLookup)) {
      const segment = segmentForRef(snapshot, proximityMatch.ref);
      candidateBuilder(segment, candidateBuilders, proximityMatch.ref).proximityMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[proximityMatch.fieldId],
        fieldId: proximityMatch.fieldId,
        score: proximityMatch.score,
        window: proximityMatch.window
      });
    }
  };

  for (const channel of channels) searchChannel(channel);

  if (!explicitChannels && shouldRunHangulFallback(query, channels, candidateBuilders.size, snapshot.documentCount)) {
    for (const channel of SEARCH_TOKEN_CHANNELS) {
      if (searchedChannels.has(channel) || channel === "ngram") continue;
      searchChannel(channel);
    }
  }

  if (candidateBuilders.size === 0 && query.analysis.primaryTerms.length === 0) {
    for (const segment of snapshot.segments) {
      for (let localDocId = 1; localDocId <= segment.projection.documentCount(); localDocId += 1) {
        candidateBuilder(segment, candidateBuilders, shardDocRef(segment, localDocId));
      }
    }
  }

  const candidates = [...candidateBuilders.values()]
    .sort((left, right) => {
      if (right.retrievalScore !== left.retrievalScore) return right.retrievalScore - left.retrievalScore;
      return left.documentKey.localeCompare(right.documentKey);
    })
    .slice(0, query.limit ?? candidateBuilders.size)
    .map<RetrievalCandidate>((candidate, index) => ({
      candidateId: candidate.candidateId,
      documentId: candidate.documentId,
      shardDocRef: candidate.shardDocRef,
      path: candidate.path,
      rank: index + 1,
      retrievalScore: candidate.retrievalScore,
      channels: candidate.channels.sort((left, right) => left.rank - right.rank || left.channel.localeCompare(right.channel)),
      phraseMatches: candidate.phraseMatches.sort(comparePhraseMatches),
      proximityMatches: candidate.proximityMatches.sort(compareProximityMatches)
    }));

  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
    complete: true,
    candidates
  };
}

function scoreChannel(
  snapshot: SearchSnapshot,
  channel: SearchTokenChannel,
  terms: readonly string[],
  fields: readonly SearchField[],
  postingsLookup: QueryPostingsLookup
): ChannelScoredDocument[] {
  const matchedByDocument = new Map<string, MatchedDocumentFields>();
  const allowedFieldIds = new Set(fields.map((field) => POSITIONAL_FIELD_ID[field]));
  for (const segment of snapshot.segments) {
    for (const term of terms) {
      for (const posting of postingsLookup(segment, canonicalTerm(channel, term))) {
        if (!allowedFieldIds.has(posting.fieldId)) continue;
        const ref = shardDocRef(segment, posting.docId);
        const key = shardKey(ref);
        const entry = matchedByDocument.get(key) ?? {
          ref,
          segment,
          fieldsById: new Map<number, Map<string, number>>()
        };
        const termFrequencies = entry.fieldsById.get(posting.fieldId) ?? new Map<string, number>();
        termFrequencies.set(term, posting.positions.length);
        entry.fieldsById.set(posting.fieldId, termFrequencies);
        matchedByDocument.set(key, entry);
      }
    }
  }

  const scored: ChannelScoredDocument[] = [];
  for (const entry of matchedByDocument.values()) {
    const fieldScores: CandidateFieldScore[] = [];
    for (const field of fields) {
      const fieldId = POSITIONAL_FIELD_ID[field];
      const fieldMatched = entry.fieldsById.get(fieldId);
      const matchedTerms = fieldMatched ? terms.filter((term) => fieldMatched.has(term)) : [];
      if (matchedTerms.length === 0) continue;
      const rawScore = matchedTerms.reduce((sum, term) => {
        const frequency = fieldMatched?.get(term) ?? 0;
        const fieldLength = entry.segment.projection.fieldLength(entry.ref.localDocId, channel, fieldId);
        return sum + bm25TermScoreFromGlobalStats(snapshot.bm25Stats, channel, term, fieldId, frequency, fieldLength);
      }, 0);
      if (rawScore <= 0) continue;
      const score = rawScore * fieldChannelBm25Boost(channel, field);
      fieldScores.push({ field, fieldId, score });
    }
    const score = fieldScores.reduce((sum, fieldScore) => sum + fieldScore.score, 0);
    if (score > 0) {
      const matchedTerms = terms.filter((term) =>
        [...entry.fieldsById.values()].some((fieldMatched) => fieldMatched.has(term))
      );
      scored.push({ ref: entry.ref, segment: entry.segment, score, matchedTerms, fieldScores });
    }
  }
  return scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return documentKey(left.segment, left.ref.localDocId).localeCompare(documentKey(right.segment, right.ref.localDocId));
  });
}

function findSegmentPhraseMatches(
  snapshot: SearchSnapshot,
  channel: SearchTokenChannel,
  terms: readonly string[],
  fields: readonly SearchField[],
  postingsLookup: QueryPostingsLookup
): SegmentPhraseMatch[] {
  const normalizedTerms = terms.map(normalizeTerm).filter(Boolean);
  if (normalizedTerms.length === 0) return [];
  const allowedFieldIds = new Set(fields.map((field) => POSITIONAL_FIELD_ID[field]));
  const matches: SegmentPhraseMatch[] = [];
  for (const segment of snapshot.segments) {
    const postingsByTerm = postingsByTermForSegment(segment, channel, normalizedTerms, postingsLookup);
    const firstPostings = postingsByTerm.get(normalizedTerms[0]) ?? [];
    for (const firstPosting of firstPostings) {
      if (!allowedFieldIds.has(firstPosting.fieldId)) continue;
      const positionLists = normalizedTerms.map((term) => positionsFromPostings(postingsByTerm.get(term) ?? [], firstPosting.docId, firstPosting.fieldId));
      const starts = phraseStartPositions(positionLists);
      if (starts.length === 0) continue;
      matches.push({
        ref: shardDocRef(segment, firstPosting.docId),
        fieldId: firstPosting.fieldId,
        starts
      });
    }
  }
  return matches.sort((left, right) => compareShardRefs(left.ref, right.ref) || left.fieldId - right.fieldId);
}

function findSegmentProximityMatches(
  snapshot: SearchSnapshot,
  channel: SearchTokenChannel,
  terms: readonly string[],
  fields: readonly SearchField[],
  maxWindow: number | undefined,
  postingsLookup: QueryPostingsLookup
): SegmentProximityMatch[] {
  const normalizedTerms = [...new Set(terms.map(normalizeTerm).filter(Boolean))];
  if (normalizedTerms.length === 0) return [];
  const allowedFieldIds = new Set(fields.map((field) => POSITIONAL_FIELD_ID[field]));
  const matches: SegmentProximityMatch[] = [];
  for (const segment of snapshot.segments) {
    const postingsByTerm = postingsByTermForSegment(segment, channel, normalizedTerms, postingsLookup);
    for (const key of postingKeysForTermPostings(postingsByTerm, normalizedTerms)) {
      if (!allowedFieldIds.has(key.fieldId)) continue;
      const positionLists = normalizedTerms.map((term) => positionsFromPostings(postingsByTerm.get(term) ?? [], key.localDocId, key.fieldId));
      const window = minimumTermWindow(positionLists);
      if (!window) continue;
      if (maxWindow !== undefined && window.width > maxWindow) continue;
      matches.push({
        ref: shardDocRef(segment, key.localDocId),
        fieldId: key.fieldId,
        score: normalizedTerms.length / window.width,
        window
      });
    }
  }
  return matches.sort((left, right) => compareShardRefs(left.ref, right.ref) || left.fieldId - right.fieldId);
}

function postingsByTermForSegment(
  segment: SearchSnapshotSegment,
  channel: SearchTokenChannel,
  terms: readonly string[],
  postingsLookup: QueryPostingsLookup
): ReadonlyMap<string, readonly CanonicalPosting[]> {
  const postings = new Map<string, readonly CanonicalPosting[]>();
  for (const term of terms) postings.set(term, postingsLookup(segment, canonicalTerm(channel, term)));
  return postings;
}

export function createQueryPostingsLookup(): QueryPostingsLookup {
  const bySegment = new Map<SearchSnapshotSegment, Map<string, readonly CanonicalPosting[]>>();
  return (segment, term) => {
    let entries = bySegment.get(segment);
    if (!entries) {
      entries = new Map();
      bySegment.set(segment, entries);
    }
    const cached = entries.get(term);
    if (cached) return cached;
    const postings = segment.postings.postingsForTerm(term);
    entries.set(term, postings);
    return postings;
  };
}

function positionsFromPostings(postings: readonly CanonicalPosting[], localDocId: number, fieldId: number): readonly number[] {
  return postings.find((posting) => posting.docId === localDocId && posting.fieldId === fieldId)?.positions ?? [];
}

function postingKeysForTermPostings(
  postingsByTerm: ReadonlyMap<string, readonly CanonicalPosting[]>,
  terms: readonly string[]
): Array<{ localDocId: number; fieldId: number }> {
  const seen = new Set<string>();
  const keys: Array<{ localDocId: number; fieldId: number }> = [];
  for (const term of terms) {
    for (const posting of postingsByTerm.get(term) ?? []) {
      const key = `${posting.docId}:${posting.fieldId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push({ localDocId: posting.docId, fieldId: posting.fieldId });
    }
  }
  return keys.sort((left, right) => left.localDocId - right.localDocId || left.fieldId - right.fieldId);
}

function candidateBuilder(
  segment: SearchSnapshotSegment,
  builders: Map<string, CandidateBuilder>,
  ref: ShardDocRef
): CandidateBuilder {
  const key = shardKey(ref);
  const existing = builders.get(key);
  if (existing) return existing;
  const document = segment.projection.doc(ref.localDocId);
  const builder: CandidateBuilder = {
    candidateId: document.documentId,
    documentId: document.documentId,
    shardDocRef: ref,
    documentKey: document.path,
    path: document.path,
    retrievalScore: 0,
    channels: [],
    phraseMatches: [],
    proximityMatches: []
  };
  builders.set(key, builder);
  return builder;
}

function shardDocRef(segment: SearchSnapshotSegment, localDocId: number): ShardDocRef {
  const document = segment.projection.doc(localDocId);
  return {
    segmentId: segment.segmentId,
    partitionId: segment.partitionId,
    localDocId,
    documentId: document.documentId
  };
}

function segmentForRef(snapshot: SearchSnapshot, ref: ShardDocRef): SearchSnapshotSegment {
  const segment = snapshot.segments.find((entry) => entry.segmentId === ref.segmentId && entry.partitionId === ref.partitionId);
  if (!segment) throw new Error(`unknown search segment ${ref.segmentId}`);
  return segment;
}

function shardKey(ref: ShardDocRef): string {
  return `${ref.segmentId}\u0000${ref.partitionId}\u0000${ref.localDocId}`;
}

function compareShardRefs(left: ShardDocRef, right: ShardDocRef): number {
  const segmentOrder = left.segmentId.localeCompare(right.segmentId);
  if (segmentOrder !== 0) return segmentOrder;
  if (left.partitionId !== right.partitionId) return left.partitionId - right.partitionId;
  return left.localDocId - right.localDocId;
}

function documentKey(segment: SearchSnapshotSegment, localDocId: number): string {
  return segment.projection.doc(localDocId).path;
}

function canonicalTerm(channel: SearchTokenChannel, term: string): string {
  return `${channel}\u0000${term.normalize("NFC").trim()}`;
}

function allowedFields(fields: readonly SearchField[] | undefined): SearchField[] {
  return [...(fields ?? POSITIONAL_SEARCH_FIELDS)];
}

function positionalSearchChannels(query: RetrievalQuery): readonly SearchTokenChannel[] {
  if (query.channels) return query.channels;
  if (query.analysis.channels.ngram.length > 0 && hangulTerms(query.analysis.channels.ngram)) return ["ngram"];
  return SEARCH_TOKEN_CHANNELS;
}

function shouldRunHangulFallback(
  query: RetrievalQuery,
  channels: readonly SearchTokenChannel[],
  candidateCount: number,
  documentCount: number
): boolean {
  if (channels.length !== 1 || channels[0] !== "ngram") return false;
  if (!hangulTerms(query.analysis.channels.ngram)) return false;
  const desired = Math.min(documentCount, query.limit ?? documentCount);
  return desired > 0 && candidateCount === 0;
}

function hangulTerms(terms: readonly string[]): boolean {
  return terms.some((term) => /\p{Script=Hangul}/u.test(term));
}

function comparePhraseMatches(left: CandidatePhraseMatch, right: CandidatePhraseMatch): number {
  return left.fieldId - right.fieldId || left.channel.localeCompare(right.channel);
}

function compareProximityMatches(left: CandidateProximityMatch, right: CandidateProximityMatch): number {
  return left.fieldId - right.fieldId || left.channel.localeCompare(right.channel) || right.score - left.score;
}
