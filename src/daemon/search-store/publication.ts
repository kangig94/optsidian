import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirSync, fsyncFileSync } from '../../core/private-path.js';
import type { CurrentWriterToken } from '../../core/lifecycle/conditional-commit.js';
import type { SearchAnalyzerIdentity } from '../../core/search/analyzer.js';
import type {
  CorpusSnapshotId,
  EmbeddingSetId,
  LinkGraphId,
  RetrieverPlanIdentity,
  RetrievalSnapshotId,
} from '../../core/search/contracts.js';
import type { EmbeddingRecipeFreshnessId, EmbeddingSpaceId } from '../../core/search/dense/embedding-set.js';

export type DurableRename = (from: string, to: string) => void | Promise<void>;

export type RetrievalIdentity = {
  vaultStateHash: string;
  lexicalIdentityHash: string;
  embeddingSpaceId: EmbeddingSpaceId;
};

export type DenseEditionFresh = {
  state: 'fresh';
  generationId: string;
  embeddingSetId: EmbeddingSetId;
  embeddingSpaceId: EmbeddingSpaceId;
  embeddingRecipeFreshnessId: EmbeddingRecipeFreshnessId;
  specId: string;
  dbPath: string;
  manifestHash: string;
  metadataSha256: string;
};

type DenseEditionBuilding = {
  state: 'building';
  buildId: string;
  embeddingSetId?: EmbeddingSetId;
  startedAt: string;
};

type DenseEditionFailed = {
  state: 'failed';
  buildId: string;
  cause: string;
  diagnosticId: string;
};

type DenseEditionUnavailable = {
  state: 'unavailable';
  reason: string;
};

export type DenseEdition = DenseEditionFresh | DenseEditionBuilding | DenseEditionFailed | DenseEditionUnavailable;

export type EditionCorpusRecord = {
  snapshotId: string;
  corpusSnapshotId: CorpusSnapshotId;
  canonicalManifestSha256: string;
};

export type EditionIdentity = {
  retrievalIdentity: RetrievalIdentity;
  vaultStateHash: string;
  lexicalIdentityHash: string;
  embeddingSpaceId: EmbeddingSpaceId;
  embeddingSetId?: EmbeddingSetId;
  retrievalSnapshotId?: RetrievalSnapshotId;
  retrieverPlanIdentity?: RetrieverPlanIdentity;
  rankingFeatureVersion: string;
  analyzerIdentity: SearchAnalyzerIdentity;
};

export type EditionRecord = {
  schemaVersion: 1;
  editionSeq: number;
  frontierSeq: number;
  baseEditionSeq?: number;
  scanBoundaryJournalSeq?: number;
  corpus: EditionCorpusRecord;
  linkGraphId: LinkGraphId;
  dense: DenseEdition;
  identity: EditionIdentity;
  writerToken: CurrentWriterToken;
  committedAt: string;
};

type EditionRecordEnvelope = {
  schemaVersion: 1;
  checksumSha256: string;
  record: EditionRecord;
};

export async function durableRename(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rename(from, to);
}

export { fsyncDirSync, fsyncFileSync };

export function retrievalIdentityKey(identity: RetrievalIdentity): string {
  return [
    safePublicationKeyPart(identity.vaultStateHash),
    safePublicationKeyPart(identity.lexicalIdentityHash),
    safePublicationKeyPart(identity.embeddingSpaceId),
  ].join(':');
}

function editionRecordEnvelope(record: EditionRecord): EditionRecordEnvelope {
  return {
    schemaVersion: 1,
    checksumSha256: editionRecordChecksum(record),
    record,
  };
}

export function encodeEditionRecord(record: EditionRecord): string {
  return `${JSON.stringify(editionRecordEnvelope(record))}\n`;
}

export function decodeEditionRecord(text: string): EditionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isEditionRecordEnvelope(parsed)) return undefined;
  if (editionRecordChecksum(parsed.record) !== parsed.checksumSha256) return undefined;
  return parsed.record;
}

function editionRecordChecksum(record: EditionRecord): string {
  return sha256(Buffer.from(canonicalPublicationJson(record)));
}

export function metadataSha256(value: unknown): string {
  return sha256(Buffer.from(canonicalPublicationJson(value)));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalPublicationJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, sortCanonical(record[key])]),
  );
}

function safePublicationKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'value';
}

function isEditionRecordEnvelope(value: unknown): value is EditionRecordEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Partial<EditionRecordEnvelope>;
  return (
    envelope.schemaVersion === 1 && typeof envelope.checksumSha256 === 'string' && isEditionRecord(envelope.record)
  );
}

function isEditionRecord(value: unknown): value is EditionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<EditionRecord>;
  const corpus = record.corpus as Partial<EditionCorpusRecord> | undefined;
  return (
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.editionSeq) &&
    (record.editionSeq ?? 0) > 0 &&
    Number.isSafeInteger(record.frontierSeq) &&
    (record.frontierSeq ?? -1) >= 0 &&
    isRecord(corpus) &&
    typeof corpus.snapshotId === 'string' &&
    typeof corpus.corpusSnapshotId === 'string' &&
    typeof corpus.canonicalManifestSha256 === 'string' &&
    typeof record.linkGraphId === 'string' &&
    isDenseEdition(record.dense) &&
    isRecord(record.identity) &&
    isRecord(record.writerToken) &&
    typeof record.committedAt === 'string'
  );
}

function isDenseEdition(value: unknown): value is DenseEdition {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'fresh') {
    return (
      typeof value.generationId === 'string' &&
      typeof value.embeddingSetId === 'string' &&
      typeof value.embeddingSpaceId === 'string' &&
      typeof value.embeddingRecipeFreshnessId === 'string' &&
      typeof value.specId === 'string' &&
      typeof value.dbPath === 'string' &&
      typeof value.manifestHash === 'string' &&
      typeof value.metadataSha256 === 'string'
    );
  }
  if (value.state === 'building') {
    return (
      typeof value.buildId === 'string' &&
      (value.embeddingSetId === undefined || typeof value.embeddingSetId === 'string') &&
      typeof value.startedAt === 'string'
    );
  }
  if (value.state === 'failed') {
    return (
      typeof value.buildId === 'string' && typeof value.cause === 'string' && typeof value.diagnosticId === 'string'
    );
  }
  if (value.state === 'unavailable') return typeof value.reason === 'string';
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
