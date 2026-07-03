import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, fsyncDirSync, fsyncFileSync, writePrivateFileSync } from '../private-path.js';

export type FrontierEntry =
  { op: 'upsert'; path: string; contentHash: string } | { op: 'delete'; path: string; tombstoneSeq: number };

export type FrontierDirtyOperation = FrontierEntry & {
  journalSeq: number;
  docId: string;
  state: FrontierOperationState;
  diagnosticId?: string;
};

export type FrontierOperationState = 'pending' | 'covered' | 'acked' | 'failed';

export type FrontierAppendOperation =
  | { op: 'upsert'; docId: string; path: string; contentHash: string }
  | { op: 'delete'; docId: string; path: string; tombstoneSeq: number };

export type FrontierSubject = {
  docId: string;
  path: string;
};

export type FrontierCommittedHashBySubject =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string | undefined>>
  | ((subject: FrontierSubject) => string | undefined);

export type FrontierTombstoneProof =
  | ReadonlySet<string>
  | ReadonlyMap<string, boolean | string | number | undefined>
  | Readonly<Record<string, boolean | string | number | undefined>>
  | ((subject: FrontierSubject, operation: Extract<FrontierDirtyOperation, { op: 'delete' }>) => boolean);

export type FrontierCoverageCandidate = {
  committedHashBySubject: FrontierCommittedHashBySubject;
  tombstoneProof: FrontierTombstoneProof;
};

export type FrontierScanBoundary = {
  frontierSeq: number;
  scanBoundaryJournalSeq: number;
};

type OperationLogRecord = {
  kind: 'operation';
  operation: FrontierAppendOperation & { journalSeq: number };
};

type StateLogRecord = {
  kind: 'state';
  journalSeq: number;
  state: FrontierOperationState;
  diagnosticId?: string;
};

type ScanLogRecord = {
  kind: 'scan';
  frontierSeq: number;
  scanBoundaryJournalSeq: number;
};

type FrontierLogRecord = OperationLogRecord | StateLogRecord | ScanLogRecord;

export class FrontierJournal {
  readonly rootDir: string;
  readonly journalPath: string;

  private readonly operationsBySeq = new Map<number, FrontierDirtyOperation>();
  private readonly orderedOperations: FrontierDirtyOperation[] = [];
  private nextJournalSeq = 1;
  private nextFrontierSeq = 1;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.journalPath = path.join(rootDir, 'frontier-journal.jsonl');
    ensurePrivateDirSync(rootDir, 'Frontier journal directory');
    this.replay();
  }

  append(operation: FrontierAppendOperation): FrontierDirtyOperation {
    validateAppendOperation(operation);
    const journalSeq = this.nextJournalSeq;
    this.nextJournalSeq += 1;
    const logRecord: OperationLogRecord = { kind: 'operation', operation: { ...operation, journalSeq } };
    this.appendLogRecord(logRecord);
    const dirty = operationFromLog(logRecord);
    this.recordOperation(dirty);
    return dirty;
  }

  appendUpsert(docId: string, filePath: string, contentHash: string): FrontierDirtyOperation {
    return this.append({ op: 'upsert', docId, path: filePath, contentHash });
  }

  appendDelete(docId: string, filePath: string, tombstoneSeq: number): FrontierDirtyOperation {
    return this.append({ op: 'delete', docId, path: filePath, tombstoneSeq });
  }

  recordScanBoundary(): FrontierScanBoundary {
    const boundary: FrontierScanBoundary = {
      frontierSeq: this.nextFrontierSeq,
      scanBoundaryJournalSeq: this.nextJournalSeq - 1,
    };
    this.nextFrontierSeq += 1;
    this.appendLogRecord({ kind: 'scan', ...boundary });
    return boundary;
  }

  operations(): readonly FrontierDirtyOperation[] {
    return this.orderedOperations.map((operation) => ({ ...operation }));
  }

  pendingOperations(): readonly FrontierDirtyOperation[] {
    return this.orderedOperations
      .filter((operation) => operation.state === 'pending')
      .map((operation) => ({ ...operation }));
  }

  markCovered(journalSeq: number): void {
    this.transition(journalSeq, 'covered');
  }

  ack(journalSeq: number): void {
    this.transition(journalSeq, 'acked');
  }

  fail(journalSeq: number, diagnosticId: string): void {
    this.transition(journalSeq, 'failed', diagnosticId);
  }

  coverage(candidate: FrontierCoverageCandidate, scanBoundaryJournalSeq: number): FrontierCoverage {
    return new FrontierCoverage(this.orderedOperations, candidate, scanBoundaryJournalSeq);
  }

  covers(
    operation: FrontierDirtyOperation | { journalSeq: number },
    candidate: FrontierCoverageCandidate,
    scanBoundaryJournalSeq: number,
  ): boolean {
    return this.coverage(candidate, scanBoundaryJournalSeq).covers(operation);
  }

  private transition(journalSeq: number, state: FrontierOperationState, diagnosticId?: string): void {
    if (!this.operationsBySeq.has(journalSeq)) throw new Error(`Unknown frontier journal sequence ${journalSeq}.`);
    this.appendLogRecord({ kind: 'state', journalSeq, state, diagnosticId });
    applyState(this.operationsBySeq, journalSeq, state, diagnosticId);
  }

  private replay(): void {
    if (!fs.existsSync(this.journalPath)) return;
    const text = fs.readFileSync(this.journalPath, 'utf8');
    const lines = text.split('\n');
    const lastLineIndex = lines.length - (text.endsWith('\n') ? 2 : 1);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let record: FrontierLogRecord;
      try {
        record = JSON.parse(line) as FrontierLogRecord;
      } catch (error) {
        if (index >= lastLineIndex) break;
        throw error;
      }
      this.applyLogRecord(record);
    }
    this.orderedOperations.sort((left, right) => left.journalSeq - right.journalSeq);
  }

  private appendLogRecord(record: FrontierLogRecord): void {
    ensurePrivateDirSync(this.rootDir, 'Frontier journal directory');
    const existed = fs.existsSync(this.journalPath);
    fs.appendFileSync(this.journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (!existed) writePrivateFileSync(this.journalPath, fs.readFileSync(this.journalPath), 'Frontier journal file');
    fsyncFileSync(this.journalPath);
    fsyncDirSync(this.rootDir);
  }

  private applyLogRecord(record: FrontierLogRecord): void {
    if (record.kind === 'operation') {
      const operation = operationFromLog(record);
      this.recordOperation(operation);
      this.nextJournalSeq = Math.max(this.nextJournalSeq, operation.journalSeq + 1);
      return;
    }
    if (record.kind === 'state') {
      applyState(this.operationsBySeq, record.journalSeq, record.state, record.diagnosticId);
      return;
    }
    if (record.kind === 'scan') {
      this.nextFrontierSeq = Math.max(this.nextFrontierSeq, record.frontierSeq + 1);
      return;
    }
  }

  private recordOperation(operation: FrontierDirtyOperation): void {
    this.operationsBySeq.set(operation.journalSeq, operation);
    this.orderedOperations.push(operation);
  }
}

export class FrontierCoverage {
  private readonly operationsBySeq = new Map<number, FrontierDirtyOperation>();
  private readonly candidate: FrontierCoverageCandidate;
  private readonly scanBoundaryJournalSeq: number;

  constructor(
    operations: readonly FrontierDirtyOperation[],
    candidate: FrontierCoverageCandidate,
    scanBoundaryJournalSeq: number,
  ) {
    this.candidate = candidate;
    this.scanBoundaryJournalSeq = scanBoundaryJournalSeq;
    for (const operation of operations) this.operationsBySeq.set(operation.journalSeq, operation);
  }

  covers(operation: FrontierDirtyOperation | { journalSeq: number }): boolean {
    const target = this.resolve(operation);
    if (!target || target.journalSeq > this.scanBoundaryJournalSeq) return false;
    if (this.directlyCovers(target)) return true;

    const laterOperations = [...this.operationsBySeq.values()]
      .filter(
        (candidate) =>
          candidate.journalSeq > target.journalSeq &&
          candidate.journalSeq <= this.scanBoundaryJournalSeq &&
          candidate.docId === target.docId &&
          candidate.path === target.path,
      )
      .sort((left, right) => right.journalSeq - left.journalSeq);

    return laterOperations.some((later) => this.directlyCovers(later));
  }

  private resolve(operation: FrontierDirtyOperation | { journalSeq: number }): FrontierDirtyOperation | undefined {
    return this.operationsBySeq.get(operation.journalSeq);
  }

  private directlyCovers(operation: FrontierDirtyOperation): boolean {
    if (operation.op === 'upsert') {
      return committedHashForSubject(this.candidate.committedHashBySubject, operation) === operation.contentHash;
    }
    return tombstoneProofCovers(this.candidate.tombstoneProof, operation);
  }
}

export function frontierSubjectKey(subject: FrontierSubject): string {
  return `${subject.docId}\u0000${subject.path}`;
}

function operationFromLog(record: OperationLogRecord): FrontierDirtyOperation {
  return { ...record.operation, state: 'pending' };
}

function validateAppendOperation(operation: FrontierAppendOperation): void {
  if (!operation.docId) throw new Error('Frontier operation docId is required.');
  if (!operation.path) throw new Error('Frontier operation path is required.');
  if (operation.op === 'upsert' && !operation.contentHash) throw new Error('Frontier upsert requires a contentHash.');
  if (operation.op === 'delete' && (!Number.isSafeInteger(operation.tombstoneSeq) || operation.tombstoneSeq < 0)) {
    throw new Error('Frontier delete requires a non-negative tombstoneSeq.');
  }
}

function applyState(
  operationsBySeq: Map<number, FrontierDirtyOperation>,
  journalSeq: number,
  state: FrontierOperationState,
  diagnosticId?: string,
): void {
  const operation = operationsBySeq.get(journalSeq);
  if (!operation) throw new Error(`Unknown frontier journal sequence ${journalSeq}.`);
  operation.state = state;
  if (diagnosticId) operation.diagnosticId = diagnosticId;
  else delete operation.diagnosticId;
}

function committedHashForSubject(lookup: FrontierCommittedHashBySubject, subject: FrontierSubject): string | undefined {
  if (typeof lookup === 'function') return lookup(subject);
  const key = frontierSubjectKey(subject);
  if (lookup instanceof Map) return lookup.get(key);
  const record = lookup as Readonly<Record<string, string | undefined>>;
  return record[key];
}

function tombstoneProofCovers(
  proof: FrontierTombstoneProof,
  operation: Extract<FrontierDirtyOperation, { op: 'delete' }>,
): boolean {
  if (typeof proof === 'function') return proof(operation, operation);
  const key = frontierSubjectKey(operation);
  if (proof instanceof Set) return proof.has(key);
  if (proof instanceof Map) {
    const value = proof.get(key);
    return value === true || value === operation.tombstoneSeq;
  }
  const record = proof as Readonly<Record<string, boolean | string | number | undefined>>;
  const value = record[key];
  return value === true || value === operation.tombstoneSeq;
}
