import type {
  CandidateSet,
  EmbeddingSetId,
  Retriever,
  RetrieverIdentity,
  RetrievalCandidate,
  RetrievalQuery,
  ShardDocRef
} from "../contracts.js";
import {
  cosineSimilarity,
  denseAgreementFromCosine,
  normalizeEmbeddingVector,
  type EmbeddingProvider,
  type EmbeddingVector
} from "./provider.js";

export type DenseMetric = "cosine";

export type DenseEmbeddingRecord = {
  candidateId?: string;
  documentId: string;
  shardDocRef: ShardDocRef;
  path?: string;
  text: string;
  vector: EmbeddingVector;
};

export type DenseEmbeddingSet = {
  embeddingSetId: EmbeddingSetId;
  model: string;
  records: readonly DenseEmbeddingRecord[];
  coveredDocumentIds?: ReadonlySet<string>;
};

export type DenseRetrieverOptions = {
  provider: EmbeddingProvider;
  embeddingSet?: DenseEmbeddingSet;
  model?: string;
  metric?: DenseMetric;
  limit?: number;
};

export const DENSE_RETRIEVER_VERSION = "1";

export function createDenseRetriever(options: DenseRetrieverOptions): Retriever {
  const metric = options.metric ?? "cosine";
  const model = options.model ?? options.embeddingSet?.model ?? options.provider.identity.model;
  const retrieverIdentity: RetrieverIdentity = {
    id: "dense",
    version: DENSE_RETRIEVER_VERSION,
    parameters: { model, metric }
  };
  return {
    retrieverIdentity,
    retrieve: async (query) => retrieveDenseCandidates(query, retrieverIdentity, options, metric)
  };
}

async function retrieveDenseCandidates(
  query: RetrievalQuery,
  retrieverIdentity: RetrieverIdentity,
  options: DenseRetrieverOptions,
  metric: DenseMetric
): Promise<CandidateSet> {
  const embeddingSet = options.embeddingSet;
  if (!embeddingSet || embeddingSet.records.length === 0) return emptyDenseCandidateSet(query, retrieverIdentity);
  if (metric !== "cosine") throw new Error(`unsupported dense metric: ${metric}`);

  const queryVector = normalizeEmbeddingVector(
    query.queryVector ?? await options.provider.embed(query.rawQuery, { inputKind: "query" }),
    options.provider.identity.dim
  );
  const candidates = embeddingSet.records
    .filter((record) => !embeddingSet.coveredDocumentIds || embeddingSet.coveredDocumentIds.has(record.documentId))
    .map((record) => {
      const vector = normalizeEmbeddingVector(record.vector, queryVector.length);
      const cosine = cosineSimilarity(queryVector, vector);
      const denseAgreement = denseAgreementFromCosine(cosine);
      return {
        record,
        cosine,
        denseAgreement
      };
    })
    .sort((left, right) => {
      if (right.denseAgreement !== left.denseAgreement) return right.denseAgreement - left.denseAgreement;
      return denseRecordKey(left.record).localeCompare(denseRecordKey(right.record));
    })
    .slice(0, options.limit ?? query.limit ?? embeddingSet.records.length)
    .map<RetrievalCandidate>((entry, index) => ({
      candidateId: entry.record.candidateId ?? entry.record.documentId,
      documentId: entry.record.documentId,
      shardDocRef: entry.record.shardDocRef,
      path: entry.record.path,
      rank: index + 1,
      retrievalScore: entry.denseAgreement,
      denseAgreement: entry.denseAgreement,
      channels: [],
      phraseMatches: [],
      proximityMatches: []
    }));

  return {
    schemaVersion: 1,
    snapshotId: query.snapshotId,
    retrieverIdentity,
    complete: true,
    candidates
  };
}

function emptyDenseCandidateSet(query: RetrievalQuery, retrieverIdentity: RetrieverIdentity): CandidateSet {
  return {
    schemaVersion: 1,
    snapshotId: query.snapshotId,
    retrieverIdentity,
    complete: true,
    candidates: []
  };
}

function denseRecordKey(record: DenseEmbeddingRecord): string {
  return record.path ?? record.candidateId ?? record.documentId;
}
