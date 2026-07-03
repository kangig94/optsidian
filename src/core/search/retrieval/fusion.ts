import crypto from 'node:crypto';
import type {
  CandidateRetrieverSignals,
  CandidateSet,
  Retriever,
  RetrieverIdentity,
  RetrieverPlanIdentity,
  RetrieverSignal,
  RetrievalCandidate,
  RetrievalQuery,
} from '../contracts.js';
import { DEFAULT_RRF_K } from '../constants.js';
import { canonicalValueBytes } from '../segments/index.js';

export { DEFAULT_RRF_K };
export const FUSION_RETRIEVER_VERSION = '1';

export type FusionParameters = {
  algorithm: 'rrf';
  k: number;
  weights: readonly { retrieverId: string; weight: number }[];
};

export type FusionOptions = {
  k?: number;
  weights?: Readonly<Record<string, number>>;
  limit?: number;
};

type RetrieverSet = {
  identity: RetrieverIdentity;
  set: CandidateSet;
};

type CandidateAccumulator = {
  candidate: RetrievalCandidate;
  rrfScore: number;
  signals: RetrieverSignal[];
  retrieverOrder: number[];
};

export function createFusionRetriever(retrievers: readonly Retriever[], options: FusionOptions = {}): Retriever {
  const parameters = fusionParameters(
    retrievers.map((retriever) => retriever.retrieverIdentity),
    options,
  );
  const retrieverPlanIdentity = computeRetrieverPlanIdentity(
    retrievers.map((retriever) => retriever.retrieverIdentity),
    parameters,
  );
  const retrieverIdentity: RetrieverIdentity = {
    id: 'fusion',
    version: FUSION_RETRIEVER_VERSION,
    parameters: {
      retrieverPlanIdentity,
      fusion: parameters,
      retrievers: retrievers.map((retriever) => retriever.retrieverIdentity),
    },
  };
  return {
    retrieverIdentity,
    retrieve: async (query) => retrieveWithFusion(retrievers, query, options, retrieverIdentity, retrieverPlanIdentity),
  };
}

export async function retrieveWithFusion(
  retrievers: readonly Retriever[],
  query: RetrievalQuery,
  options: FusionOptions = {},
  retrieverIdentity?: RetrieverIdentity,
  retrieverPlanIdentity?: RetrieverPlanIdentity,
): Promise<CandidateSet> {
  const sets: RetrieverSet[] = [];
  for (const retriever of retrievers) {
    sets.push({
      identity: retriever.retrieverIdentity,
      set: await retriever.retrieve(query),
    });
  }
  return fuseCandidateSets(sets, query, options, retrieverIdentity, retrieverPlanIdentity);
}

export function fuseCandidateSets(
  retrieverSets: readonly RetrieverSet[],
  query: RetrievalQuery,
  options: FusionOptions = {},
  retrieverIdentity?: RetrieverIdentity,
  retrieverPlanIdentity?: RetrieverPlanIdentity,
): CandidateSet {
  const identities = retrieverSets.map((entry) => entry.identity);
  const parameters = fusionParameters(identities, options);
  const planIdentity = retrieverPlanIdentity ?? computeRetrieverPlanIdentity(identities, parameters);
  const identity = retrieverIdentity ?? {
    id: 'fusion',
    version: FUSION_RETRIEVER_VERSION,
    parameters: {
      retrieverPlanIdentity: planIdentity,
      fusion: parameters,
      retrievers: identities,
    },
  };
  const snapshotId = candidateSetSnapshotId(retrieverSets, query.snapshotId);
  const accumulators = new Map<string, CandidateAccumulator>();

  retrieverSets.forEach((entry, retrieverIndex) => {
    const weight = retrieverWeight(entry.identity, options.weights);
    const normalizedScores = normalizedScoreByCandidate(entry.set.candidates);
    entry.set.candidates.forEach((candidate, index) => {
      const rank = candidate.rank > 0 ? candidate.rank : index + 1;
      const contribution = weight / (parameters.k + rank);
      const signal: RetrieverSignal = {
        retrieverId: entry.identity.id,
        retrieverIdentity: entry.identity,
        rank,
        rawScore: finiteNumber(candidate.retrievalScore),
        normalizedScore: normalizedScores.get(candidate.candidateId) ?? 0,
        contribution,
      };
      const current = accumulators.get(candidate.candidateId) ?? {
        candidate: cloneCandidate(candidate),
        rrfScore: 0,
        signals: [],
        retrieverOrder: [],
      };
      current.rrfScore += contribution;
      current.signals.push(signal);
      current.retrieverOrder.push(retrieverIndex);
      current.candidate = mergeCandidate(current.candidate, candidate);
      accumulators.set(candidate.candidateId, current);
    });
  });

  const limit = options.limit ?? query.limit ?? accumulators.size;
  const candidates = [...accumulators.values()]
    .map((entry) => finalizeCandidate(entry))
    .sort(compareFusedCandidates)
    .slice(0, limit)
    .map((candidate, index): RetrievalCandidate => ({
      ...candidate,
      rank: index + 1,
    }));

  return {
    schemaVersion: 1,
    snapshotId,
    retrieverIdentity: identity,
    retrieverPlanIdentity: planIdentity,
    complete: retrieverSets.every((entry) => entry.set.complete),
    candidates,
  };
}

export function computeRetrieverPlanIdentity(
  identities: readonly RetrieverIdentity[],
  parameters: FusionParameters,
): RetrieverPlanIdentity {
  return crypto
    .createHash('sha256')
    .update(
      canonicalValueBytes({
        schemaVersion: 1,
        retrievers: identities,
        fusion: parameters,
      }),
    )
    .digest('hex');
}

function fusionParameters(identities: readonly RetrieverIdentity[], options: FusionOptions): FusionParameters {
  return {
    algorithm: 'rrf',
    k: options.k ?? DEFAULT_RRF_K,
    weights: identities.map((identity) => ({
      retrieverId: identity.id,
      weight: retrieverWeight(identity, options.weights),
    })),
  };
}

function normalizedScoreByCandidate(candidates: readonly RetrievalCandidate[]): ReadonlyMap<string, number> {
  const finiteScores = candidates.map((candidate) => finiteNumber(candidate.retrievalScore));
  const min = Math.min(...finiteScores);
  const max = Math.max(...finiteScores);
  const output = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const score = finiteScores[index];
    const normalized = max > min ? (score - min) / (max - min) : score > 0 ? 1 : 0;
    output.set(candidate.candidateId, normalized);
  });
  return output;
}

function finalizeCandidate(entry: CandidateAccumulator): RetrievalCandidate {
  const signals = entry.signals
    .map((signal, index) => ({ signal, order: entry.retrieverOrder[index] ?? Number.MAX_SAFE_INTEGER }))
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.signal.rank - right.signal.rank ||
        left.signal.retrieverId.localeCompare(right.signal.retrieverId),
    )
    .map((entry) => entry.signal);
  const retrieverSignals = typedRetrieverSignals(signals);
  const denseAgreement = entry.candidate.denseAgreement ?? retrieverSignals.dense?.normalizedScore;
  const linkAgreement = entry.candidate.linkAgreement ?? retrieverSignals.link?.normalizedScore;
  return {
    ...entry.candidate,
    retrievalScore: entry.rrfScore,
    rrfScore: entry.rrfScore,
    retrieverSignals,
    ...(denseAgreement === undefined ? {} : { denseAgreement }),
    ...(linkAgreement === undefined ? {} : { linkAgreement }),
  };
}

function typedRetrieverSignals(signals: readonly RetrieverSignal[]): CandidateRetrieverSignals {
  const output: CandidateRetrieverSignals = { all: signals };
  for (const signal of signals) {
    const slot = retrieverSignalSlot(signal.retrieverId);
    if (slot && !output[slot]) output[slot] = signal;
  }
  return output;
}

function retrieverSignalSlot(retrieverId: string): 'lexical' | 'dense' | 'link' | undefined {
  if (retrieverId === 'dense') return 'dense';
  if (retrieverId === 'link' || retrieverId === 'link-adjacency') return 'link';
  if (retrieverId === 'positional-lexical' || retrieverId.includes('lexical')) return 'lexical';
  return undefined;
}

function mergeCandidate(left: RetrievalCandidate, right: RetrievalCandidate): RetrievalCandidate {
  const leftHasLexical = left.channels.length > 0 || left.phraseMatches.length > 0 || left.proximityMatches.length > 0;
  const rightHasLexical =
    right.channels.length > 0 || right.phraseMatches.length > 0 || right.proximityMatches.length > 0;
  const base = !leftHasLexical && rightHasLexical ? right : left;
  return {
    ...base,
    denseAgreement: maxOptional(left.denseAgreement, right.denseAgreement),
    linkAgreement: maxOptional(left.linkAgreement, right.linkAgreement),
    rrfScore: maxOptional(left.rrfScore, right.rrfScore),
    retrieverSignals: left.retrieverSignals ?? right.retrieverSignals,
  };
}

function cloneCandidate(candidate: RetrievalCandidate): RetrievalCandidate {
  return {
    ...candidate,
    channels: [...candidate.channels],
    phraseMatches: [...candidate.phraseMatches],
    proximityMatches: [...candidate.proximityMatches],
  };
}

function compareFusedCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  if ((right.rrfScore ?? 0) !== (left.rrfScore ?? 0)) return (right.rrfScore ?? 0) - (left.rrfScore ?? 0);
  if (right.retrievalScore !== left.retrievalScore) return right.retrievalScore - left.retrievalScore;
  return candidateKey(left).localeCompare(candidateKey(right));
}

function candidateKey(candidate: RetrievalCandidate): string {
  return candidate.path ?? candidate.candidateId;
}

function candidateSetSnapshotId(
  retrieverSets: readonly RetrieverSet[],
  querySnapshotId: string | undefined,
): string | undefined {
  const snapshotIds = new Set(
    retrieverSets.map((entry) => entry.set.snapshotId).filter((value): value is string => Boolean(value)),
  );
  if (querySnapshotId) snapshotIds.add(querySnapshotId);
  if (snapshotIds.size > 1) throw new Error('cannot fuse candidate sets from different snapshots');
  return snapshotIds.values().next().value;
}

function retrieverWeight(identity: RetrieverIdentity, weights: Readonly<Record<string, number>> | undefined): number {
  const weight = weights?.[identity.id] ?? 1;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function maxOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
