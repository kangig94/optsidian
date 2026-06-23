import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../analysis/index.js";
import { RRF_K } from "../../constants.js";
import type {
  CandidateChannelRank,
  CandidateFieldScore,
  CandidatePhraseMatch,
  CandidateProximityMatch,
  CandidateSet,
  Retriever,
  RetrieverIdentity,
  RetrievalCandidate,
  RetrievalQuery
} from "../../contracts.js";
import type { SearchField } from "../../../types.js";
import { bm25FieldScore, fieldChannelBm25Boost, tokenChannelFusionWeight } from "./bm25.js";
import type { SearchSnapshot } from "./engine.js";
import { findPhraseMatches } from "./postings.js";
import { findProximityMatches } from "./proximity.js";
import {
  POSITIONAL_FIELD_BY_ID,
  POSITIONAL_FIELD_ID,
  POSITIONAL_SEARCH_FIELDS,
  type PositionalDocId,
  type PositionalDocumentRecord
} from "./types.js";

export const POSITIONAL_RETRIEVER_IDENTITY: RetrieverIdentity = {
  id: "positional-lexical",
  version: "1"
};

type CandidateBuilder = {
  candidateId: string;
  documentId: string;
  ordinalDocId: PositionalDocId;
  documentKey: string;
  path?: string;
  retrievalScore: number;
  channels: CandidateChannelRank[];
  phraseMatches: CandidatePhraseMatch[];
  proximityMatches: CandidateProximityMatch[];
};

type ChannelScoredDocument = {
  docId: PositionalDocId;
  score: number;
  matchedTerms: readonly string[];
  fieldScores: readonly CandidateFieldScore[];
};

type PositionalDocumentMap = ReadonlyMap<PositionalDocId, PositionalDocumentRecord>;

export function createPositionalRetriever(snapshot: SearchSnapshot): Retriever {
  return {
    retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
    retrieve: (query) => retrievePositionalCandidates(snapshot, query)
  };
}

export function retrievePositionalCandidates(snapshot: SearchSnapshot, query: RetrievalQuery): CandidateSet {
  const fields = allowedFields(query.fields);
  const candidateBuilders = new Map<PositionalDocId, CandidateBuilder>();
  const documentsByDocId = new Map(snapshot.documents.map((document) => [document.docId, document]));
  const channels = positionalSearchChannels(query);

  for (const channel of channels) {
    const terms = query.analysis.channels[channel].map((term) => term.normalize("NFC").trim()).filter(Boolean);
    if (terms.length === 0) continue;
    const channelScores = scoreChannel(snapshot, channel, terms, fields, documentsByDocId);
    channelScores.forEach((scored, index) => {
      const rank = index + 1;
      const builder = candidateBuilder(documentsByDocId, candidateBuilders, scored.docId);
      const weightedScore = tokenChannelFusionWeight(channel) / (RRF_K + rank);
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

    const postings = snapshot.postingsByChannel[channel];
    if (!postings) continue;
    for (const phraseMatch of findPhraseMatches(postings, terms, { fieldIds: fields.map((field) => POSITIONAL_FIELD_ID[field]) })) {
      candidateBuilder(documentsByDocId, candidateBuilders, phraseMatch.docId).phraseMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[phraseMatch.fieldId],
        fieldId: phraseMatch.fieldId,
        starts: phraseMatch.starts
      });
    }
    for (const proximityMatch of findProximityMatches(postings, terms, {
      maxWindow: query.proximityWindow,
      fieldIds: fields.map((field) => POSITIONAL_FIELD_ID[field])
    })) {
      candidateBuilder(documentsByDocId, candidateBuilders, proximityMatch.docId).proximityMatches.push({
        channel,
        field: POSITIONAL_FIELD_BY_ID[proximityMatch.fieldId],
        fieldId: proximityMatch.fieldId,
        score: proximityMatch.score,
        window: proximityMatch.window
      });
    }
  }

  if (candidateBuilders.size === 0 && query.analysis.primaryTerms.length === 0) {
    for (const document of snapshot.documents) candidateBuilder(documentsByDocId, candidateBuilders, document.docId);
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
      ordinalDocId: candidate.ordinalDocId,
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
  documentsByDocId: PositionalDocumentMap
): ChannelScoredDocument[] {
  const matchedByDocument = new Map<PositionalDocId, Map<number, Set<string>>>();
  const stats = snapshot.bm25ByChannel?.[channel] ?? snapshot.bm25;
  const postings = snapshot.postingsByChannel[channel] ?? new Map();
  const allowedFieldIds = new Set(fields.map((field) => POSITIONAL_FIELD_ID[field]));
  for (const term of terms) {
    for (const posting of postings.get(term) ?? []) {
      if (!allowedFieldIds.has(posting.fieldId)) continue;
      const fieldsById = matchedByDocument.get(posting.docId) ?? new Map<number, Set<string>>();
      const matchedTerms = fieldsById.get(posting.fieldId) ?? new Set<string>();
      matchedTerms.add(term);
      fieldsById.set(posting.fieldId, matchedTerms);
      matchedByDocument.set(posting.docId, fieldsById);
    }
  }

  const scored: ChannelScoredDocument[] = [];
  for (const [docId, fieldsById] of matchedByDocument) {
    const fieldScores: CandidateFieldScore[] = [];
    for (const field of fields) {
      const fieldId = POSITIONAL_FIELD_ID[field];
      const fieldMatched = fieldsById.get(fieldId);
      const matchedTerms = fieldMatched ? terms.filter((term) => fieldMatched.has(term)) : [];
      if (matchedTerms.length === 0) continue;
      const rawScore = bm25FieldScore(stats, matchedTerms, docId, fieldId);
      if (rawScore <= 0) continue;
      const score = rawScore * fieldChannelBm25Boost(channel, field);
      fieldScores.push({ field, fieldId, score });
    }
    const score = fieldScores.reduce((sum, fieldScore) => sum + fieldScore.score, 0);
    if (score > 0) {
      const matchedTerms = terms.filter((term) =>
        [...fieldsById.values()].some((fieldMatched) => fieldMatched.has(term))
      );
      scored.push({ docId, score, matchedTerms, fieldScores });
    }
  }
  return scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return documentKey(documentsByDocId, left.docId).localeCompare(documentKey(documentsByDocId, right.docId));
  });
}

function candidateBuilder(
  documentsByDocId: PositionalDocumentMap,
  builders: Map<PositionalDocId, CandidateBuilder>,
  docId: PositionalDocId
): CandidateBuilder {
  const existing = builders.get(docId);
  if (existing) return existing;
  const document = documentsByDocId.get(docId);
  if (!document) throw new Error(`unknown positional docId ${docId}`);
  const builder: CandidateBuilder = {
    candidateId: document.documentId,
    documentId: document.documentId,
    ordinalDocId: document.docId,
    documentKey: document.documentKey,
    path: document.path,
    retrievalScore: 0,
    channels: [],
    phraseMatches: [],
    proximityMatches: []
  };
  builders.set(docId, builder);
  return builder;
}

function allowedFields(fields: readonly SearchField[] | undefined): SearchField[] {
  return [...(fields ?? POSITIONAL_SEARCH_FIELDS)];
}

function positionalSearchChannels(query: RetrievalQuery): readonly SearchTokenChannel[] {
  if (query.channels) return query.channels;
  if (query.analysis.channels.ngram.length > 0 && hangulTerms(query.analysis.channels.ngram)) return ["ngram"];
  return SEARCH_TOKEN_CHANNELS;
}

function hangulTerms(terms: readonly string[]): boolean {
  return terms.some((term) => /\p{Script=Hangul}/u.test(term));
}

function documentKey(documentsByDocId: PositionalDocumentMap, docId: PositionalDocId): string {
  return documentsByDocId.get(docId)?.documentKey ?? String(docId);
}

function comparePhraseMatches(left: CandidatePhraseMatch, right: CandidatePhraseMatch): number {
  return left.fieldId - right.fieldId || left.channel.localeCompare(right.channel);
}

function compareProximityMatches(left: CandidateProximityMatch, right: CandidateProximityMatch): number {
  return left.fieldId - right.fieldId || left.channel.localeCompare(right.channel) || right.score - left.score;
}
