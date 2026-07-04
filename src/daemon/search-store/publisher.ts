import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, writePrivateFileSync } from '../../core/private-path.js';
import {
  Attempt,
  AttemptCancelledError,
  currentWriterTokensEqual,
  type ConditionalCommitResult,
  type CurrentWriterToken,
  type MaybePromise,
  type TenancyFenceProvider,
} from '../../core/lifecycle/conditional-commit.js';
import {
  ExclusiveClaim,
  readExclusiveClaimOwner,
  reclaimExclusiveClaim,
} from '../../core/lifecycle/exclusive-claim.js';
import { createProcessToken, isAlive as processTokenIsAlive } from '../../core/lifecycle/process-token.js';
import {
  FrontierJournal,
  frontierSubjectKey,
  type FrontierAppendOperation,
  type FrontierCoverageCandidate,
  type FrontierDirtyOperation,
  type FrontierScanBoundary,
} from '../../core/lifecycle/frontier-journal.js';
import { LevelReconciler } from '../../core/lifecycle/level-reconciler.js';
import {
  decodeEditionRecord,
  encodeEditionRecord,
  fsyncDirSync,
  fsyncFileSync,
  retrievalIdentityKey,
  type DenseEdition,
  type DenseEditionFresh,
  type EditionCorpusRecord,
  type EditionIdentity,
  type EditionRecord,
  type RetrievalIdentity,
} from './publication.js';
import { safeStoreFileName } from './cache-paths.js';
import { SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS } from '../protocol.js';

const COMMIT_WITH_RETRY_MAX_NOT_HEAD_RETRIES = 16;

export type EditionCandidate = {
  baseEditionSeq?: number;
  frontierSeq: number;
  scanBoundaryJournalSeq: number;
  corpus: EditionCorpusRecord;
  linkGraphId: EditionRecord['linkGraphId'];
  dense: DenseEdition;
  identity: EditionIdentity;
  coverage: FrontierCoverageCandidate;
};

type EditionCommitValue = {
  record: EditionRecord;
  ackedJournalSeqs: number[];
};

export type EditionCommitResult = ConditionalCommitResult<EditionCommitValue>;

export type EditionLedgerOptions = {
  ledgerRootDir: string;
  frontierJournal: FrontierJournal;
  tenancyFence: TenancyFenceProvider;
  now?: () => number;
  beforeAppendForTests?: () => void | Promise<void>;
};

export type SaveDiagnosticRecord = {
  schemaVersion: 1;
  diagnosticId: string;
  journalSeqs: number[];
  vaultRoot: string;
  errorCode?: string;
  message: string;
  failedAt: string;
  writerToken: CurrentWriterToken;
};

export type VaultPublisherPaths = {
  ledgerRootDir: string;
  publicationsDir: string;
  frontierDir: string;
  diagnosticsDir: string;
  reservationsDir: string;
  claimsDir: string;
};

export type VaultPublisherOptions = {
  paths: VaultPublisherPaths;
  retrievalIdentity: RetrievalIdentity;
  tenancyFence: TenancyFenceProvider;
  effects?: VaultPublisherEffects;
  now?: () => number;
  beforeAppendForTests?: () => void | Promise<void>;
};

type PublisherIntentBase = {
  deadline?: number;
  cancellationId?: string;
  signal?: AbortSignal;
};

type RebuildIntent = PublisherIntentBase & {
  kind: 'rebuild';
  scanBoundary: FrontierScanBoundary;
  requestContext?: unknown;
  prepareRetrieval?: boolean;
  useActiveBase?: boolean;
  incrementalFallbackReason?: string;
};

type RefreshIntent = PublisherIntentBase & {
  kind: 'refresh';
  scanBoundary: FrontierScanBoundary;
  requestContext?: unknown;
  prepareRetrieval?: boolean;
  useActiveBase?: boolean;
  incrementalFallbackReason?: string;
};

type SaveIntent = PublisherIntentBase & {
  kind: 'save';
  scanBoundary: FrontierScanBoundary;
  requestContext?: unknown;
  prepareRetrieval?: boolean;
  useActiveBase?: boolean;
  incrementalFallbackReason?: string;
};

type DensePublicationIntent = PublisherIntentBase & {
  kind: 'dense-publication';
  force?: boolean;
  scanBoundary?: FrontierScanBoundary;
  targetEditionSeq?: number;
  targetCorpusSnapshotId?: string;
  targetLinkGraphId?: EditionRecord['linkGraphId'];
  targetRetrievalSnapshotId?: string;
  requestContext?: unknown;
};

type DirtyFrontierIntent = PublisherIntentBase & {
  kind: 'dirty-frontier';
  operations: readonly FrontierAppendOperation[];
};

type DiagnosticFrontierIntent = PublisherIntentBase & {
  kind: 'diagnostic-frontier';
  diagnostic: SaveDiagnosticRecord;
};

type ClearIntent = PublisherIntentBase & {
  kind: 'clear';
};

export type VaultPublisherIntent =
  | RebuildIntent
  | RefreshIntent
  | SaveIntent
  | DensePublicationIntent
  | DirtyFrontierIntent
  | DiagnosticFrontierIntent
  | ClearIntent;

type VaultPublisherBuildIntent = RebuildIntent | RefreshIntent | SaveIntent | DensePublicationIntent;

export type VaultPublisherBuildInput<TIntent extends VaultPublisherBuildIntent = VaultPublisherBuildIntent> = {
  intent: TIntent;
  intents: readonly TIntent[];
  head: EditionRecord | undefined;
  pendingOperations: readonly FrontierDirtyOperation[];
  signal: AbortSignal;
  deadline: number;
  cancellationId: string;
  cancellationIds: readonly string[];
};

export type VaultPublisherBuildOutput =
  | {
      kind: 'candidate';
      candidate: EditionCandidate;
      cleanup?: () => MaybePromise<void>;
    }
  | { kind: 'drop'; reason: string };

type VaultPublisherBarrierInput<TIntent extends VaultPublisherIntent = VaultPublisherIntent> = {
  intent: TIntent;
  head: EditionRecord | undefined;
  pendingOperations: readonly FrontierDirtyOperation[];
  signal: AbortSignal;
  deadline: number;
  cancellationId: string;
  cancellationIds: readonly string[];
};

type VaultPublisherCancellationInput = {
  cancellationId: string;
  reason: unknown;
  intents: readonly VaultPublisherIntent[];
};

type VaultPublisherLateResultInput = {
  result: VaultPublisherBuildOutput;
  intent: VaultPublisherBuildIntent;
  intents: readonly VaultPublisherBuildIntent[];
  reason: unknown;
};

type VaultPublisherLaneErrorInput = {
  error: unknown;
  intents: readonly VaultPublisherIntent[];
};

export type VaultPublisherEffects = {
  buildSnapshot?(
    input: VaultPublisherBuildInput<RebuildIntent | RefreshIntent | SaveIntent>,
  ): MaybePromise<VaultPublisherBuildOutput>;
  buildDense?(input: VaultPublisherBuildInput<DensePublicationIntent>): MaybePromise<VaultPublisherBuildOutput>;
  appendDirtyFrontier?(input: VaultPublisherBarrierInput<DirtyFrontierIntent>): MaybePromise<void>;
  clear?(input: VaultPublisherBarrierInput<ClearIntent>): MaybePromise<void>;
  cancelSnapshotEffects?(input: VaultPublisherCancellationInput): MaybePromise<void>;
  cancelEmbedScheduler?(input: VaultPublisherCancellationInput): MaybePromise<void>;
  cancelWorkerPools?(input: VaultPublisherCancellationInput): MaybePromise<void>;
  discardLateResult?(input: VaultPublisherLateResultInput): MaybePromise<void>;
  onError?(input: VaultPublisherLaneErrorInput): MaybePromise<void>;
};

export type VaultPublisherIntentResult =
  | {
      status: 'covered';
      intentKind: VaultPublisherIntent['kind'];
      head: EditionRecord;
    }
  | {
      status: 'committed';
      intentKind: VaultPublisherIntent['kind'];
      edition: EditionRecord;
      ackedJournalSeqs: number[];
      reason?: string;
    }
  | {
      status: 'completed';
      intentKind: VaultPublisherIntent['kind'];
      journaledOperations?: FrontierDirtyOperation[];
    }
  | {
      status: 'not-ready';
      intentKind: VaultPublisherIntent['kind'];
      reason: string;
      head?: EditionRecord;
    }
  | {
      status: 'dropped';
      intentKind: VaultPublisherIntent['kind'];
      reason: string;
    };

type StructuralLaneEnvelope = {
  intent: VaultPublisherIntent;
  deferred: Deferred<VaultPublisherIntentResult>;
  settled: boolean;
};

type BuildStructuralLaneEnvelope = StructuralLaneEnvelope & {
  intent: VaultPublisherBuildIntent;
};

type StructuralLaneWorld = {
  head: EditionRecord | undefined;
  pendingOperations: readonly FrontierDirtyOperation[];
};

type StructuralLaneFold = StructuralLaneWorld & {
  intents: readonly StructuralLaneEnvelope[];
};

export class EditionLedger {
  readonly ledgerRootDir: string;
  readonly publicationsDir: string;

  private readonly frontierJournal: FrontierJournal;
  private readonly tenancyFence: TenancyFenceProvider;
  private readonly now: () => number;
  private readonly beforeAppendForTests: (() => void | Promise<void>) | undefined;

  constructor(options: EditionLedgerOptions) {
    this.ledgerRootDir = options.ledgerRootDir;
    this.publicationsDir = path.join(options.ledgerRootDir, 'publications');
    this.frontierJournal = options.frontierJournal;
    this.tenancyFence = options.tenancyFence;
    this.now = options.now ?? Date.now;
    this.beforeAppendForTests = options.beforeAppendForTests;
    ensurePrivateDirSync(this.publicationsDir, 'Optsidian edition publications directory');
    this.sweepIncomplete();
  }

  current(): EditionRecord | undefined {
    const records = this.history();
    return records.at(-1);
  }

  // The most recent edition whose dense arm is `fresh` (and names a retrieval snapshot). After a
  // lexical-only rebuild the head edition is dense-`unavailable`/`building`, but a reader can still
  // attach this edition's committed dense generation and mask per-doc by contentHash — so documents
  // unchanged since it stay dense-enriched while only edited/new docs ride lexical-only.
  latestFresh(): EditionRecord | undefined {
    const records = this.history();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.dense.state === 'fresh' && record.identity.retrievalSnapshotId) return record;
    }
    return undefined;
  }

  history(): EditionRecord[] {
    ensurePrivateDirSync(this.publicationsDir, 'Optsidian edition publications directory');
    const records: EditionRecord[] = [];
    for (const entry of safeReadDir(this.publicationsDir)) {
      if (!/^\d+$/.test(entry)) continue;
      const record = this.readRecordFile(path.join(this.publicationsDir, entry));
      if (!record) continue;
      if (record.editionSeq !== Number(entry)) continue;
      records.push(record);
    }
    return records.sort((left, right) => left.editionSeq - right.editionSeq);
  }

  async commit(
    candidate: EditionCandidate,
    expectedHeadSeq: number | undefined,
    writerToken: CurrentWriterToken,
  ): Promise<EditionCommitResult> {
    await this.beforeAppendForTests?.();

    const currentHead = this.current();
    const actualHeadSeq = currentHead?.editionSeq;
    if (actualHeadSeq !== expectedHeadSeq) {
      return { ok: false, reason: 'not-head', message: headMismatchMessage(expectedHeadSeq, actualHeadSeq) };
    }

    const liveWriterToken = await this.tenancyFence.currentWriterToken();
    if (!liveWriterToken || !currentWriterTokensEqual(liveWriterToken, writerToken)) {
      return { ok: false, reason: 'not-current', message: 'writer token is no longer current' };
    }

    const validation = this.validateCandidate(candidate, currentHead);
    if (!validation.ok) return validation;

    const editionSeq = (currentHead?.editionSeq ?? 0) + 1;
    const record: EditionRecord = {
      schemaVersion: 1,
      editionSeq,
      frontierSeq: candidate.frontierSeq,
      ...(candidate.baseEditionSeq === undefined ? {} : { baseEditionSeq: candidate.baseEditionSeq }),
      scanBoundaryJournalSeq: candidate.scanBoundaryJournalSeq,
      corpus: candidate.corpus,
      linkGraphId: candidate.linkGraphId,
      dense: candidate.dense,
      identity: candidate.identity,
      writerToken,
      committedAt: new Date(this.now()).toISOString(),
    };

    const target = path.join(this.publicationsDir, String(editionSeq));
    try {
      writeEditionRecordExclusive(target, record);
      fsyncDirSync(this.publicationsDir);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        return { ok: false, reason: 'not-head', message: `publication ${editionSeq} already exists` };
      }
      throw error;
    }

    for (const journalSeq of validation.ackedJournalSeqs) {
      this.frontierJournal.markCovered(journalSeq);
      this.frontierJournal.ack(journalSeq);
    }

    return { ok: true, value: { record, ackedJournalSeqs: validation.ackedJournalSeqs } };
  }

  private validateCandidate(
    candidate: EditionCandidate,
    currentHead: EditionRecord | undefined,
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    if (!currentHead) {
      if (candidate.baseEditionSeq !== undefined) {
        return { ok: false, reason: 'rejected', message: 'bootstrap edition cannot have a base edition' };
      }
      if (candidate.frontierSeq < 1) {
        return { ok: false, reason: 'rejected', message: 'bootstrap edition must publish a corpus frontier' };
      }
      return this.validateCorpusAdvance(candidate);
    }

    if (candidate.frontierSeq > currentHead.frontierSeq) {
      return this.validateCorpusAdvance(candidate);
    }

    if (candidate.frontierSeq === currentHead.frontierSeq) {
      return this.validateSameFrontier(candidate, currentHead);
    }

    return {
      ok: false,
      reason: 'rejected',
      message: `candidate frontier ${candidate.frontierSeq} is older than current frontier ${currentHead.frontierSeq}`,
    };
  }

  private validateCorpusAdvance(
    candidate: EditionCandidate,
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    const dirtyThroughBoundary = this.frontierJournal
      .operations()
      .filter((operation) => operation.state !== 'acked' && operation.journalSeq <= candidate.scanBoundaryJournalSeq);
    const uncovered = dirtyThroughBoundary.filter(
      (operation) => !this.frontierJournal.covers(operation, candidate.coverage, candidate.scanBoundaryJournalSeq),
    );
    if (uncovered.length > 0) {
      return {
        ok: false,
        reason: 'rejected',
        message: `candidate frontier does not cover dirty journal seq ${uncovered.map((operation) => operation.journalSeq).join(',')}`,
      };
    }
    return { ok: true, ackedJournalSeqs: dirtyThroughBoundary.map((operation) => operation.journalSeq) };
  }

  private validateSameFrontier(
    candidate: EditionCandidate,
    currentHead: EditionRecord,
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    if (candidate.baseEditionSeq !== currentHead.editionSeq) {
      return {
        ok: false,
        reason: 'not-head',
        message: `same-frontier edition must be based on current edition ${currentHead.editionSeq}`,
      };
    }
    if (!sameCorpus(candidate.corpus, currentHead.corpus) || candidate.linkGraphId !== currentHead.linkGraphId) {
      return {
        ok: false,
        reason: 'rejected',
        message: 'same-frontier edition cannot change corpus or link graph identity',
      };
    }
    if (!sameStableIdentity(candidate.identity, currentHead.identity)) {
      return { ok: false, reason: 'rejected', message: 'same-frontier edition cannot change retrieval identity' };
    }
    if (!isDenseLifecycleTransition(currentHead.dense, candidate.dense)) {
      return { ok: false, reason: 'rejected', message: 'same-frontier edition may only change dense lifecycle state' };
    }
    return { ok: true, ackedJournalSeqs: [] };
  }

  private readRecordFile(filePath: string): EditionRecord | undefined {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return undefined;
      return decodeEditionRecord(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private sweepIncomplete(): void {
    ensurePrivateDirSync(this.publicationsDir, 'Optsidian edition publications directory');
    for (const entry of safeReadDir(this.publicationsDir)) {
      const entryPath = path.join(this.publicationsDir, entry);
      if (entry.endsWith('.tmp') || entry.endsWith('.partial')) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        continue;
      }
      if (/^\d+$/.test(entry) && !this.readRecordFile(entryPath)) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  }
}

export class VaultPublisher {
  readonly retrievalIdentity: RetrievalIdentity;
  readonly paths: VaultPublisherPaths;
  readonly frontierJournal: FrontierJournal;
  readonly ledger: EditionLedger;

  private readonly effects: VaultPublisherEffects;
  private readonly tenancyFence: TenancyFenceProvider;
  private readonly now: () => number;
  private readonly inFlightWork = new Set<Promise<unknown>>();
  private readonly pendingDebounceOperations: FrontierAppendOperation[] = [];
  private readonly structuralIntentQueue: StructuralLaneEnvelope[] = [];
  private readonly structuralReconciler: LevelReconciler<StructuralLaneWorld, StructuralLaneFold, void, void>;
  private activeStructuralErrorScope: readonly StructuralLaneEnvelope[] = [];
  private structuralStopped = false;
  private retiredByClear = false;
  private nextStructuralAttemptId = 1;

  constructor(options: VaultPublisherOptions) {
    this.retrievalIdentity = options.retrievalIdentity;
    this.paths = options.paths;
    this.effects = options.effects ?? {};
    this.tenancyFence = options.tenancyFence;
    this.now = options.now ?? Date.now;
    ensureVaultPublisherPaths(options.paths);
    this.frontierJournal = new FrontierJournal(options.paths.frontierDir);
    this.ledger = new EditionLedger({
      ledgerRootDir: options.paths.ledgerRootDir,
      frontierJournal: this.frontierJournal,
      tenancyFence: options.tenancyFence,
      now: this.now,
      beforeAppendForTests: options.beforeAppendForTests,
    });
    this.structuralReconciler = new LevelReconciler<StructuralLaneWorld, StructuralLaneFold, void, void>({
      enumerate: () =>
        this.retiredByClear
          ? { head: undefined, pendingOperations: [] }
          : {
              head: this.ledger.current(),
              pendingOperations: this.frontierJournal.pendingOperations(),
            },
      fold: (world) => {
        const intents = this.structuralIntentQueue.splice(0);
        this.activeStructuralErrorScope = intents;
        return {
          ...world,
          intents,
        };
      },
      act: (folded, batch) => this.actStructuralLane(folded, batch.signal),
      onError: (error, context) => this.handleStructuralLaneError(error, context),
    });
    this.structuralReconciler.start();
  }

  static pathsFor(rootDir: string): VaultPublisherPaths {
    return {
      ledgerRootDir: rootDir,
      publicationsDir: path.join(rootDir, 'publications'),
      frontierDir: path.join(rootDir, 'frontier'),
      diagnosticsDir: path.join(rootDir, 'diagnostics'),
      reservationsDir: path.join(rootDir, 'reservations'),
      claimsDir: path.join(rootDir, 'claims'),
    };
  }

  markDirty(operation: FrontierAppendOperation): FrontierDirtyOperation {
    this.assertNotRetiredByClear();
    return this.frontierJournal.append(operation);
  }

  enqueueDirty(operation: FrontierAppendOperation): void {
    void this.enqueueDirtyOperations([operation]).catch(() => undefined);
  }

  enqueueDirtyMarks(
    marks: readonly { docId: string; path: string; contentHash?: string }[],
  ): Promise<FrontierDirtyOperation[]> {
    return this.enqueueDirtyOperations(marks.map((mark) => snapshotDirtyMarkToFrontierOperation(mark, this.now())));
  }

  enqueueDebouncedDirtyMarks(marks: readonly { docId: string; path: string; contentHash?: string }[]): void {
    this.assertNotRetiredByClear();
    for (const mark of marks)
      this.pendingDebounceOperations.push(snapshotDirtyMarkToFrontierOperation(mark, this.now()));
  }

  async flushPendingDebounce(): Promise<FrontierDirtyOperation[]> {
    const operations = this.pendingDebounceOperations.splice(0);
    return this.enqueueDirtyOperations(operations);
  }

  recordScanBoundary(): FrontierScanBoundary {
    this.assertNotRetiredByClear();
    return this.frontierJournal.recordScanBoundary();
  }

  enqueue(intent: VaultPublisherIntent): Promise<VaultPublisherIntentResult> {
    const deferred = createDeferred<VaultPublisherIntentResult>();
    const envelope: StructuralLaneEnvelope = { intent, deferred, settled: false };
    if (this.retiredByClear) {
      this.dropStructuralEnvelope(envelope, new Error('VaultPublisher was reset by clear.'));
      return deferred.promise;
    }
    if (this.structuralStopped || this.structuralReconciler.isStopped) {
      this.rejectStructuralEnvelope(envelope, new Error('VaultPublisher structural lane is stopped.'));
      return deferred.promise;
    }
    if (intent.signal?.aborted) {
      this.dropStructuralEnvelope(envelope, abortReason(intent.signal) ?? new Error('Publisher intent was cancelled.'));
      return deferred.promise;
    }
    this.structuralIntentQueue.push(envelope);
    this.structuralReconciler.enqueueIntent();
    return deferred.promise;
  }

  commit(
    candidate: EditionCandidate,
    expectedHeadSeq: number | undefined,
    writerToken: CurrentWriterToken,
  ): Promise<EditionCommitResult> {
    this.assertNotRetiredByClear();
    return this.trackWork(this.ledger.commit(candidate, expectedHeadSeq, writerToken));
  }

  async persistFailureDiagnostic(input: {
    journalSeqs: readonly number[];
    vaultRoot: string;
    error: unknown;
    writerToken: CurrentWriterToken;
  }): Promise<SaveDiagnosticRecord> {
    const diagnostic: SaveDiagnosticRecord = {
      schemaVersion: 1,
      diagnosticId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      journalSeqs: [...input.journalSeqs],
      vaultRoot: input.vaultRoot,
      ...errorCodeField(input.error),
      message: input.error instanceof Error ? input.error.message : String(input.error),
      failedAt: new Date(this.now()).toISOString(),
      writerToken: input.writerToken,
    };
    const result = await this.enqueue({ kind: 'diagnostic-frontier', diagnostic });
    if (result.status !== 'completed') {
      throw new Error(
        result.status === 'dropped'
          ? result.reason
          : `diagnostic frontier transition did not complete: ${result.status}`,
      );
    }
    return diagnostic;
  }

  diagnostics(): SaveDiagnosticRecord[] {
    return safeReadDir(this.paths.diagnosticsDir)
      .map((entry) => readDiagnostic(path.join(this.paths.diagnosticsDir, entry)))
      .filter((record): record is SaveDiagnosticRecord => record !== undefined)
      .sort(
        (left, right) =>
          left.failedAt.localeCompare(right.failedAt) || left.diagnosticId.localeCompare(right.diagnosticId),
      );
  }

  async drain(): Promise<void> {
    if (!this.retiredByClear) {
      await bestEffort(async () => {
        await this.flushPendingDebounce();
      });
    }
    await this.structuralReconciler.drain();
    await Promise.allSettled([...this.inFlightWork]);
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    if (!this.retiredByClear && options.drain !== false) {
      await bestEffort(async () => {
        await this.flushPendingDebounce();
      });
    } else {
      this.pendingDebounceOperations.length = 0;
    }
    this.structuralStopped = true;
    if (options.drain === false) {
      const waiters = this.structuralIntentQueue.splice(0);
      const error = new Error('VaultPublisher structural lane stopped without drain.');
      for (const waiter of waiters) this.rejectStructuralEnvelope(waiter, error);
    }
    await this.structuralReconciler.stop({ drain: options.drain ?? true });
    if (options.drain !== false) await Promise.allSettled([...this.inFlightWork]);
  }

  private async actStructuralLane(folded: StructuralLaneFold, laneSignal: AbortSignal): Promise<void> {
    let head = folded.head;
    try {
      for (let index = 0; index < folded.intents.length; index += 1) {
        const envelope = folded.intents[index];
        if (!envelope || envelope.settled) continue;
        const intent = envelope.intent;
        if (this.retiredByClear && intent.kind !== 'clear') {
          this.dropStructuralEnvelope(envelope, new Error('VaultPublisher was reset by clear.'));
          continue;
        }
        if (isBuildIntent(intent)) {
          const group: StructuralLaneEnvelope[] = [envelope];
          while (index + 1 < folded.intents.length) {
            const next = folded.intents[index + 1];
            if (!next || next.settled || !isBuildIntent(next.intent)) break;
            if (buildLaneForIntent(next.intent) !== buildLaneForIntent(intent)) break;
            group.push(next);
            index += 1;
          }
          this.activeStructuralErrorScope = group;
          head = await this.actBuildGroup(group, head, folded.pendingOperations, laneSignal);
          this.activeStructuralErrorScope = [];
          continue;
        }
        this.activeStructuralErrorScope = [envelope];
        head = await this.actBarrierIntent(envelope, head, folded.pendingOperations, laneSignal);
        this.activeStructuralErrorScope = [];
      }
    } catch (error) {
      await this.handleStructuralLaneError(error);
    } finally {
      this.activeStructuralErrorScope = [];
    }
  }

  private async actBuildGroup(
    envelopes: readonly StructuralLaneEnvelope[],
    head: EditionRecord | undefined,
    _pendingOperations: readonly FrontierDirtyOperation[],
    laneSignal: AbortSignal,
  ): Promise<EditionRecord | undefined> {
    const buildEnvelopes: BuildStructuralLaneEnvelope[] = [];
    for (const envelope of envelopes) {
      if (isBuildIntent(envelope.intent)) buildEnvelopes.push(envelope as BuildStructuralLaneEnvelope);
    }
    const remaining = this.unsettledBuildEnvelopes(buildEnvelopes, head);
    if (remaining.length === 0) return head;
    const timing = this.buildAttemptTiming(remaining.map((envelope) => envelope.intent));

    // Coalesced lexical intents must stay in enqueue order: publishFreshSnapshot records the scan
    // boundary and immediately enqueues, so later envelopes represent monotonic journal boundaries.
    // Add a second producer only if it preserves that ordering contract.
    return this.commitWithRetry({
      remaining,
      head,
      laneSignal,
      timing,
    });
  }

  private async commitWithRetry(input: {
    remaining: BuildStructuralLaneEnvelope[];
    head: EditionRecord | undefined;
    laneSignal: AbortSignal;
    timing: { deadline: number; cancellationId: string; cancellationIds: readonly string[] };
  }): Promise<EditionRecord | undefined> {
    let { remaining, head } = input;
    const { laneSignal, timing } = input;
    let notHeadRetries = 0;
    while (remaining.length > 0) {
      const representative = remaining[remaining.length - 1]?.intent;
      if (!representative || !isBuildIntent(representative)) return head;
      const buildEffect = this.buildEffectForIntent(representative);
      if (!buildEffect) {
        for (const envelope of remaining) {
          this.dropStructuralEnvelope(
            envelope,
            new Error(`no publisher lane build effect for ${envelope.intent.kind}`),
          );
        }
        return head;
      }

      let output: VaultPublisherBuildOutput;
      try {
        output = await this.runBuildAttempt({
          envelopes: remaining,
          representative,
          head,
          pendingOperations: this.frontierJournal.pendingOperations(),
          laneSignal,
          timing,
          buildEffect,
        });
      } catch (error) {
        if (!isLaneAbort(error)) throw error;
        await this.cancelAttemptCleanup(
          timing.cancellationIds,
          error,
          remaining.map((envelope) => envelope.intent),
        );
        for (const envelope of remaining) this.dropStructuralEnvelope(envelope, error);
        return head;
      }

      if (output.kind === 'drop') {
        for (const envelope of remaining) this.dropStructuralEnvelope(envelope, new Error(output.reason));
        return head;
      }

      try {
        const committed = await this.commitBuildOutput(output);
        if (!committed.ok) {
          if (committed.reason === 'not-current') {
            // This daemon's writer token was superseded by a newer incarnation: a retryable
            // stale-incarnation lifecycle condition, not a terminal failure. Reject (rather than
            // drop) so the STALE_INCARNATION code survives to the client — a dropped result is
            // rethrown as a bare message, stripping the code the client keys retry/resync on.
            const staleError = Object.assign(
              new Error(`edition commit rejected: not-current${committed.message ? `: ${committed.message}` : ''}`),
              { code: 'STALE_INCARNATION' },
            );
            for (const envelope of remaining) this.rejectStructuralEnvelope(envelope, staleError);
            return head;
          }
          if (committed.reason !== 'not-head') {
            const commitError = new Error(
              `edition commit rejected: ${committed.reason}${committed.message ? `: ${committed.message}` : ''}`,
            );
            for (const envelope of remaining) this.dropStructuralEnvelope(envelope, commitError);
            return head;
          }
          const previousHeadSeq = head?.editionSeq ?? 0;
          const previousRemainingCount = remaining.length;
          head = this.ledger.current();
          remaining = this.unsettledBuildEnvelopes(remaining, head);
          if (remaining.length === 0) continue;
          notHeadRetries += 1;
          const headAdvanced = (head?.editionSeq ?? 0) > previousHeadSeq;
          const remainingShrank = remaining.length < previousRemainingCount;
          if (!headAdvanced && !remainingShrank) {
            const progressError = new Error(
              `edition commit not-head retry made no progress${committed.message ? `: ${committed.message}` : ''}`,
            );
            for (const envelope of remaining) this.rejectStructuralEnvelope(envelope, progressError);
            return head;
          }
          if (notHeadRetries > COMMIT_WITH_RETRY_MAX_NOT_HEAD_RETRIES) {
            const cappedError = new Error(
              `edition commit not-head retry limit exceeded after ${notHeadRetries} retries`,
            );
            for (const envelope of remaining) this.rejectStructuralEnvelope(envelope, cappedError);
            return head;
          }
          continue;
        }
        const nextHead = committed.value.record;
        this.resolveCommittedEnvelopes(remaining, nextHead, committed.value);
        return nextHead;
      } finally {
        await cleanupBuildOutput(output);
      }
    }
    return head;
  }

  private resolveCommittedEnvelopes(
    envelopes: readonly BuildStructuralLaneEnvelope[],
    nextHead: EditionRecord,
    commitValue: EditionCommitValue,
  ): void {
    for (const envelope of envelopes) {
      if (envelope.intent.kind === 'dense-publication' && !denseHeadSatisfiesIntent(nextHead, envelope.intent)) {
        this.resolveStructuralEnvelope(envelope, {
          status: 'not-ready',
          intentKind: envelope.intent.kind,
          reason: 'dense-head-not-fresh-for-target',
          head: nextHead,
        });
        continue;
      }
      this.resolveStructuralEnvelope(envelope, {
        status: 'committed',
        intentKind: envelope.intent.kind,
        edition: nextHead,
        ackedJournalSeqs: commitValue.ackedJournalSeqs,
      });
    }
  }

  private unsettledBuildEnvelopes(
    envelopes: readonly BuildStructuralLaneEnvelope[],
    head: EditionRecord | undefined,
  ): BuildStructuralLaneEnvelope[] {
    return envelopes.filter((envelope) => {
      if (envelope.settled) return false;
      const intent = envelope.intent;
      if (!head) {
        if (intent.kind === 'dense-publication') {
          this.resolveStructuralEnvelope(envelope, {
            status: 'not-ready',
            intentKind: intent.kind,
            reason: 'no-lexical-head',
          });
          return false;
        }
        return true;
      }
      if (intent.kind === 'dense-publication') {
        if (!intent.force && denseHeadSatisfiesIntent(head, intent)) {
          this.resolveStructuralEnvelope(envelope, { status: 'covered', intentKind: intent.kind, head });
          return false;
        }
        if (denseIntentSupersededByHead(head, intent)) {
          this.resolveStructuralEnvelope(envelope, {
            status: 'not-ready',
            intentKind: intent.kind,
            reason: 'dense-target-superseded',
            head,
          });
          return false;
        }
        return true;
      }
      if (!headCoversScanBoundary(head, intent.scanBoundary)) return true;
      this.resolveStructuralEnvelope(envelope, { status: 'covered', intentKind: intent.kind, head });
      return false;
    });
  }

  private async actBarrierIntent(
    envelope: StructuralLaneEnvelope,
    head: EditionRecord | undefined,
    pendingOperations: readonly FrontierDirtyOperation[],
    laneSignal: AbortSignal,
  ): Promise<EditionRecord | undefined> {
    const intent = envelope.intent;
    const timing = this.buildAttemptTiming([intent]);
    if (intent.kind === 'dirty-frontier') {
      const journaled: FrontierDirtyOperation[] = [];
      for (const operation of intent.operations) journaled.push(this.frontierJournal.append(operation));
      await this.effects.appendDirtyFrontier?.({
        intent,
        head,
        pendingOperations,
        signal: laneSignal,
        deadline: timing.deadline,
        cancellationId: timing.cancellationId,
        cancellationIds: timing.cancellationIds,
      });
      this.resolveStructuralEnvelope(envelope, {
        status: 'completed',
        intentKind: intent.kind,
        journaledOperations: journaled,
      });
      return head;
    }
    if (intent.kind === 'diagnostic-frontier') {
      this.writeDiagnostic(intent.diagnostic);
      for (const journalSeq of intent.diagnostic.journalSeqs) {
        this.frontierJournal.fail(journalSeq, intent.diagnostic.diagnosticId);
      }
      this.resolveStructuralEnvelope(envelope, { status: 'completed', intentKind: intent.kind });
      return head;
    }
    if (intent.kind === 'clear') {
      this.retireForClear();
      await this.effects.clear?.({
        intent,
        head,
        pendingOperations,
        signal: laneSignal,
        deadline: timing.deadline,
        cancellationId: timing.cancellationId,
        cancellationIds: timing.cancellationIds,
      });
      this.resolveStructuralEnvelope(envelope, { status: 'completed', intentKind: intent.kind });
      return undefined;
    }
    this.dropStructuralEnvelope(
      envelope,
      new Error(`unhandled publisher lane intent ${(intent as VaultPublisherIntent).kind}`),
    );
    return head;
  }

  private buildEffectForIntent(
    intent: VaultPublisherBuildIntent,
  ):
    | ((input: VaultPublisherBuildInput<VaultPublisherBuildIntent>) => MaybePromise<VaultPublisherBuildOutput>)
    | undefined {
    if (intent.kind === 'dense-publication') {
      const buildDense = this.effects.buildDense;
      if (!buildDense) return undefined;
      return (input) => buildDense(input as VaultPublisherBuildInput<DensePublicationIntent>);
    }
    const buildSnapshot = this.effects.buildSnapshot;
    if (!buildSnapshot) return undefined;
    return (input) => buildSnapshot(input as VaultPublisherBuildInput<RebuildIntent | RefreshIntent | SaveIntent>);
  }

  private buildAttemptTiming(intents: readonly VaultPublisherIntent[]): {
    deadline: number;
    cancellationId: string;
    cancellationIds: readonly string[];
  } {
    const deadlines = intents
      .map((intent) => intent.deadline)
      .filter((deadline): deadline is number => isFiniteNumber(deadline));
    const deadline =
      deadlines.length > 0 ? Math.min(...deadlines) : this.now() + SEARCH_DAEMON_DEFAULT_MUTATION_DEADLINE_MS;
    const suppliedCancellationIds = intents
      .map((intent) => intent.cancellationId)
      .filter(
        (cancellationId): cancellationId is string => typeof cancellationId === 'string' && cancellationId.length > 0,
      );
    const cancellationId =
      suppliedCancellationIds[0] ??
      `publisher-lane:${retrievalIdentityKey(this.retrievalIdentity)}:${this.nextStructuralAttemptId++}`;
    const cancellationIds = [...new Set([...suppliedCancellationIds, cancellationId])];
    return { deadline, cancellationId, cancellationIds };
  }

  private async runBuildAttempt(input: {
    envelopes: readonly BuildStructuralLaneEnvelope[];
    representative: VaultPublisherBuildIntent;
    head: EditionRecord | undefined;
    pendingOperations: readonly FrontierDirtyOperation[];
    laneSignal: AbortSignal;
    timing: { deadline: number; cancellationId: string; cancellationIds: readonly string[] };
    buildEffect: (
      buildInput: VaultPublisherBuildInput<VaultPublisherBuildIntent>,
    ) => MaybePromise<VaultPublisherBuildOutput>;
  }): Promise<VaultPublisherBuildOutput> {
    const timeoutController = new AbortController();
    const owner: { current: Attempt<VaultPublisherBuildOutput> | undefined } = { current: undefined };
    let fanInCleanup: (() => void) | undefined;
    const intents = input.envelopes.map((envelope) => envelope.intent);
    const timeoutError = new PublisherLaneTimeoutError(
      `publisher lane build deadline exceeded for ${input.representative.kind}`,
    );
    const timeoutMs = Math.max(0, input.timing.deadline - this.now());
    const timeout = setTimeout(() => {
      timeoutController.abort(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
    // fanInCleanup is assigned by the producer; Attempt.start must invoke that producer synchronously.
    const attempt = Attempt.start(
      owner,
      (attemptSignal) => {
        const fanIn = fanInAbortSignal([attemptSignal, timeoutController.signal, input.laneSignal]);
        fanInCleanup = fanIn.cleanup;
        const buildInput = {
          intent: input.representative,
          intents,
          head: input.head,
          pendingOperations: input.pendingOperations,
          signal: fanIn.signal,
          deadline: input.timing.deadline,
          cancellationId: input.timing.cancellationId,
          cancellationIds: input.timing.cancellationIds,
        };
        return (async () => input.buildEffect(buildInput))();
      },
      {
        close: async (result) => {
          await cleanupBuildOutput(result);
          await this.effects.discardLateResult?.({
            result,
            intent: input.representative,
            intents,
            reason:
              abortReason(timeoutController.signal) ?? abortReason(input.laneSignal) ?? abortReason(attempt.signal),
          });
        },
      },
    );
    const waiters = input.envelopes.map((envelope) => {
      const waiter = attempt.join({ signal: envelope.intent.signal });
      waiter.promise.catch((error: unknown) => {
        if (envelope.intent.signal?.aborted) {
          this.dropStructuralEnvelope(envelope, abortReason(envelope.intent.signal) ?? error);
        }
      });
      return waiter;
    });
    const timeoutPromise = rejectOnAbort(timeoutController.signal, timeoutError);
    const attemptAbortPromise = rejectOnAbort(attempt.signal);
    const laneAbortPromise = rejectOnAbort(input.laneSignal);
    try {
      return await Promise.race([attempt.result, timeoutPromise, attemptAbortPromise, laneAbortPromise]);
    } catch (error) {
      for (const waiter of waiters) waiter.leave();
      throw error;
    } finally {
      clearTimeout(timeout);
      fanInCleanup?.();
    }
  }

  private async commitBuildOutput(
    output: Extract<VaultPublisherBuildOutput, { kind: 'candidate' }>,
  ): Promise<EditionCommitResult> {
    const writerToken = await this.tenancyFence.currentWriterToken();
    if (!writerToken) return { ok: false, reason: 'not-current', message: 'writer token is no longer current' };
    return this.trackWork(this.ledger.commit(output.candidate, this.ledger.current()?.editionSeq, writerToken));
  }

  private async cancelAttemptCleanup(
    cancellationIds: readonly string[],
    reason: unknown,
    intents: readonly VaultPublisherIntent[],
  ): Promise<void> {
    for (const cancellationId of cancellationIds) {
      const input: VaultPublisherCancellationInput = { cancellationId, reason, intents };
      await bestEffort(() => this.effects.cancelSnapshotEffects?.(input));
      await bestEffort(() => this.effects.cancelEmbedScheduler?.(input));
      await bestEffort(() => this.effects.cancelWorkerPools?.(input));
    }
  }

  private async enqueueDirtyOperations(
    operations: readonly FrontierAppendOperation[],
  ): Promise<FrontierDirtyOperation[]> {
    if (operations.length === 0) return [];
    const result = await this.enqueue({ kind: 'dirty-frontier', operations });
    if (result.status === 'completed') return result.journaledOperations ?? [];
    if (result.status === 'dropped') throw new Error(result.reason);
    throw new Error(`dirty frontier append did not complete: ${result.status}`);
  }

  private retireForClear(): void {
    if (this.retiredByClear) return;
    this.retiredByClear = true;
    this.structuralStopped = true;
    this.pendingDebounceOperations.length = 0;
    const queued = this.structuralIntentQueue.splice(0);
    for (const envelope of queued)
      this.dropStructuralEnvelope(envelope, new Error('VaultPublisher was reset by clear.'));
  }

  private assertNotRetiredByClear(): void {
    if (this.retiredByClear) throw new Error('VaultPublisher was reset by clear.');
  }

  private async handleStructuralLaneError(error: unknown, context?: { phase?: string }): Promise<void> {
    const scoped = this.activeStructuralErrorScope.filter((envelope) => !envelope.settled);
    const failedBeforeAct = context?.phase === 'enumerate' || context?.phase === 'fold';
    const affected =
      scoped.length > 0
        ? scoped
        : failedBeforeAct
          ? this.structuralIntentQueue.splice(0).filter((envelope) => !envelope.settled)
          : [];
    await bestEffort(() =>
      this.effects.onError?.({
        error,
        intents: affected.map((envelope) => envelope.intent),
      }),
    );
    for (const envelope of affected) this.rejectStructuralEnvelope(envelope, error);
    this.activeStructuralErrorScope = [];
  }

  private resolveStructuralEnvelope(envelope: StructuralLaneEnvelope, value: VaultPublisherIntentResult): void {
    if (envelope.settled) return;
    envelope.settled = true;
    envelope.deferred.resolve(value);
  }

  private dropStructuralEnvelope(envelope: StructuralLaneEnvelope, reason: unknown): void {
    if (envelope.settled) return;
    envelope.settled = true;
    envelope.deferred.resolve({
      status: 'dropped',
      intentKind: envelope.intent.kind,
      reason: errorMessage(reason),
    });
  }

  private rejectStructuralEnvelope(envelope: StructuralLaneEnvelope, error: unknown): void {
    if (envelope.settled) return;
    envelope.settled = true;
    envelope.deferred.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private async trackWork<T>(work: Promise<T>): Promise<T> {
    this.inFlightWork.add(work);
    try {
      return await work;
    } finally {
      this.inFlightWork.delete(work);
    }
  }

  private writeDiagnostic(diagnostic: SaveDiagnosticRecord): void {
    ensurePrivateDirSync(this.paths.diagnosticsDir, 'Optsidian save diagnostics directory');
    const target = path.join(this.paths.diagnosticsDir, `${safeStoreFileName(diagnostic.diagnosticId)}.json`);
    writePrivateFileSync(target, `${JSON.stringify(diagnostic)}\n`, 'Optsidian save diagnostic');
    fsyncFileSync(target);
    fsyncDirSync(this.paths.diagnosticsDir);
  }
}

export type VaultPublisherLease = {
  publisher: VaultPublisher;
  release(): Promise<void>;
};

export class VaultPublisherRegistry {
  private readonly publishers = new Map<string, { publisher: VaultPublisher; refs: number; closing?: Promise<void> }>();

  acquire(options: VaultPublisherOptions): VaultPublisherLease {
    const key = retrievalIdentityKey(options.retrievalIdentity);
    let entry = this.publishers.get(key);
    // Reuse a live entry; but never hand back one that is already draining toward teardown (its
    // reconciler is being stopped). A closing entry keeps its own slot until its stop() resolves,
    // and a fresh publisher takes the key. Any momentary overlap between the draining publisher and
    // the fresh one is safe: the on-disk frontier journal is the shared source of truth and the
    // edition-ledger CAS (exclusive-create per editionSeq) serializes every commit, so two objects
    // can never commit conflicting or duplicate visible state. The previous code deleted the slot
    // BEFORE awaiting stop(), so a concurrent acquire fell into the empty slot and could reuse — or
    // race — a torn-down publisher; keeping the slot until stop() resolves closes that window.
    if (!entry || entry.closing) {
      entry = { publisher: new VaultPublisher(options), refs: 0 };
      this.publishers.set(key, entry);
    }
    entry.refs += 1;
    const acquired = entry;
    let released = false;
    return {
      publisher: acquired.publisher,
      release: async () => {
        if (released) return;
        released = true;
        acquired.refs = Math.max(0, acquired.refs - 1);
        if (acquired.refs > 0) return;
        const stopping = acquired.publisher.stop({ drain: true });
        acquired.closing = stopping;
        try {
          await stopping;
        } finally {
          if (this.publishers.get(key) === acquired) this.publishers.delete(key);
        }
      },
    };
  }

  get(identity: RetrievalIdentity): VaultPublisher | undefined {
    return this.publishers.get(retrievalIdentityKey(identity))?.publisher;
  }

  size(): number {
    return this.publishers.size;
  }

  async close(): Promise<void> {
    const entries = [...this.publishers.values()];
    this.publishers.clear();
    await Promise.all(entries.map((entry) => entry.publisher.stop({ drain: true })));
  }
}

export type BuildReservation = {
  readonly manifestHash: string;
  readonly claim: ExclusiveClaim;
  release(): boolean;
};

export type SharedReclamationAuthorityOptions = {
  now?: () => number;
};

export type SweepVectorGenerationsInput = {
  sharedKey: string;
  searchStoresDir: string;
  generationsDir: string;
  reservationsDir: string;
  claimDir: string;
  vaultStateHash: string;
  embeddingSetId: string;
  refCountForManifest?: (manifestHash: string) => number;
};

export type SweepLexicalArtifactsInput = {
  sharedKey: string;
  ledgerRootDir: string;
  claimDir: string;
  removeIfUnreferenced: (liveEditions: readonly EditionRecord[]) => void | Promise<void>;
};

export class SharedReclamationAuthority {
  private readonly now: () => number;
  private readonly runningByKey = new Map<string, Promise<void>>();

  constructor(options: SharedReclamationAuthorityOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  acquireBuildReservation(input: {
    reservationsDir: string;
    manifestHash: string;
    timeoutMs?: number;
  }): Promise<BuildReservation> {
    const claimDir = buildReservationClaimDir(input.reservationsDir, input.manifestHash);
    return ExclusiveClaim.acquire(claimDir, {
      timeoutMs: input.timeoutMs ?? 30_000,
      now: this.now,
    }).then((claim) => ({
      manifestHash: input.manifestHash,
      claim,
      release: () => claim.release(),
    }));
  }

  async sweepVectorGenerations(input: SweepVectorGenerationsInput): Promise<void> {
    await this.runSerialized(input.sharedKey, async () => {
      const claim = await ExclusiveClaim.acquire(input.claimDir, { timeoutMs: 30_000, now: this.now });
      try {
        ensurePrivateDirSync(input.generationsDir, 'Optsidian vector generations directory');
        for (const manifestHash of safeReadDir(input.generationsDir)) {
          const generationPath = path.join(input.generationsDir, manifestHash);
          if (!isDirectory(generationPath)) continue;
          const live = this.liveVectorManifestHashes(input);
          if (live.has(manifestHash)) continue;
          if ((input.refCountForManifest?.(manifestHash) ?? 0) > 0) continue;
          if (this.buildReservationIsLive(input.reservationsDir, manifestHash)) continue;
          fs.rmSync(generationPath, { recursive: true, force: true });
          fsyncDirSync(input.generationsDir);
        }
      } finally {
        claim.release();
      }
    });
  }

  async sweepLexicalArtifacts(input: SweepLexicalArtifactsInput): Promise<void> {
    await this.runSerialized(input.sharedKey, async () => {
      const claim = await ExclusiveClaim.acquire(input.claimDir, { timeoutMs: 30_000, now: this.now });
      try {
        const liveEditions = liveEditionHeadsUnder(input.ledgerRootDir);
        await input.removeIfUnreferenced(liveEditions);
      } finally {
        claim.release();
      }
    });
  }

  liveVectorManifestHashes(
    input: Pick<SweepVectorGenerationsInput, 'searchStoresDir' | 'vaultStateHash' | 'embeddingSetId'>,
  ): Set<string> {
    const live = new Set<string>();
    // Protect the latest fresh generation per ledger, not just the head's: after a lexical-only edit
    // the head is dense-unavailable, but readers still attach (and per-doc mask) the last fresh
    // generation until a new one is built, so it must survive the gap.
    for (const edition of latestFreshEditionsUnder(path.join(input.searchStoresDir, input.vaultStateHash))) {
      if (edition.identity.vaultStateHash !== input.vaultStateHash) continue;
      if (edition.dense.state !== 'fresh') continue;
      if (edition.dense.embeddingSetId !== input.embeddingSetId) continue;
      live.add(edition.dense.manifestHash);
    }
    return live;
  }

  buildReservationIsLive(reservationsDir: string, manifestHash: string): boolean {
    const claimDir = buildReservationClaimDir(reservationsDir, manifestHash);
    const owner = readExclusiveClaimOwner(claimDir);
    if (owner && processTokenIsAlive(owner.token)) return true;
    reclaimExclusiveClaim(claimDir, { now: this.now });
    return false;
  }

  private async runSerialized(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.runningByKey.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        if (this.runningByKey.get(key) === current) this.runningByKey.delete(key);
      });
    this.runningByKey.set(key, current);
    await current;
  }
}

export function createLocalTenancyFenceProvider(
  overrides: Partial<Omit<CurrentWriterToken, 'processToken'>> = {},
): TenancyFenceProvider & { readonly writerToken: CurrentWriterToken } {
  const writerToken: CurrentWriterToken = {
    epoch: overrides.epoch ?? 0,
    incarnationId: overrides.incarnationId ?? `local-${process.pid}`,
    claimId: overrides.claimId ?? `process-${process.pid}`,
    processToken: createProcessToken(),
  };
  return {
    writerToken,
    currentWriterToken: () => writerToken,
  };
}

export function editionCoverageFromCorpus(input: {
  documents: readonly { documentId: string; path: string; contentHash: string }[];
  tombstones?: readonly { docId: string; path: string; tombstoneSeq?: number }[];
}): FrontierCoverageCandidate {
  const committedHashBySubject = new Map<string, string>();
  for (const document of input.documents) {
    committedHashBySubject.set(
      frontierSubjectKey({ docId: document.documentId, path: document.path }),
      document.contentHash,
    );
  }
  const tombstoneProof = new Set<string>();
  for (const tombstone of input.tombstones ?? []) {
    tombstoneProof.add(frontierSubjectKey({ docId: tombstone.docId, path: tombstone.path }));
  }
  return { committedHashBySubject, tombstoneProof };
}

function readLedgerRecordsFromDir(publicationsDir: string): EditionRecord[] {
  const records: EditionRecord[] = [];
  for (const entry of safeReadDir(publicationsDir)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const record = decodeEditionRecord(fs.readFileSync(path.join(publicationsDir, entry), 'utf8'));
      if (record && record.editionSeq === Number(entry)) records.push(record);
    } catch {
      // Ignore torn or unreadable ledger records; later valid records can still be used.
    }
  }
  return records.sort((left, right) => left.editionSeq - right.editionSeq);
}

export function liveEditionHeadsUnder(rootDir: string): EditionRecord[] {
  const heads: EditionRecord[] = [];
  for (const publicationsDir of findPublicationsDirs(rootDir)) {
    const head = readLedgerRecordsFromDir(publicationsDir).at(-1);
    if (head) heads.push(head);
  }
  return heads;
}

// The most recent `fresh` edition per ledger under `rootDir`. These must stay servable even when a
// ledger's head has advanced to a dense-`unavailable`/`building` edition (post lexical-only edit),
// so a reader can attach the last fresh dense generation and per-doc mask. GC roots both these and
// the heads; the reader's dense attach path uses the same lookback.
function latestFreshEditionsUnder(rootDir: string): EditionRecord[] {
  const editions: EditionRecord[] = [];
  for (const publicationsDir of findPublicationsDirs(rootDir)) {
    const latestFresh = [...readLedgerRecordsFromDir(publicationsDir)]
      .reverse()
      .find((record) => record.dense.state === 'fresh');
    if (latestFresh) editions.push(latestFresh);
  }
  return editions;
}

// Head + latest-fresh edition per ledger, computed in ONE scan of each publications dir — the exact
// set GC must root (heads for the current corpus; latest-fresh so per-doc dense masking survives the
// lexical-edit→dense-rebuild gap). Combining the two avoids scanning every ledger twice per GC pass.
export function liveEditionsForGcUnder(rootDir: string): EditionRecord[] {
  const editions: EditionRecord[] = [];
  for (const publicationsDir of findPublicationsDirs(rootDir)) {
    const records = readLedgerRecordsFromDir(publicationsDir);
    const head = records.at(-1);
    if (head) editions.push(head);
    const latestFresh = [...records].reverse().find((record) => record.dense.state === 'fresh');
    if (latestFresh && latestFresh !== head) editions.push(latestFresh);
  }
  return editions;
}

function ensureVaultPublisherPaths(paths: VaultPublisherPaths): void {
  ensurePrivateDirSync(paths.ledgerRootDir, 'Optsidian publisher ledger directory');
  ensurePrivateDirSync(paths.publicationsDir, 'Optsidian edition publications directory');
  ensurePrivateDirSync(paths.frontierDir, 'Optsidian frontier journal directory');
  ensurePrivateDirSync(paths.diagnosticsDir, 'Optsidian save diagnostics directory');
  ensurePrivateDirSync(paths.reservationsDir, 'Optsidian build reservations directory');
  ensurePrivateDirSync(paths.claimsDir, 'Optsidian publisher claims directory');
}

function writeEditionRecordExclusive(filePath: string, record: EditionRecord): void {
  ensurePrivateDirSync(path.dirname(filePath), 'Optsidian edition publications directory');
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let tempCreated = false;
  try {
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      fs.writeFileSync(fd, encodeEditionRecord(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(tempPath, filePath);
  } finally {
    if (tempCreated) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Leftover .tmp files are reclaimed by sweepIncomplete on the next ledger construction.
      }
    }
  }
}

function headMismatchMessage(expected: number | undefined, actual: number | undefined): string {
  return `expected head ${expected ?? 'none'} but current head is ${actual ?? 'none'}`;
}

function sameCorpus(left: EditionCorpusRecord, right: EditionCorpusRecord): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.corpusSnapshotId === right.corpusSnapshotId &&
    left.canonicalManifestSha256 === right.canonicalManifestSha256
  );
}

function sameStableIdentity(left: EditionIdentity, right: EditionIdentity): boolean {
  return (
    left.vaultStateHash === right.vaultStateHash &&
    left.lexicalIdentityHash === right.lexicalIdentityHash &&
    left.embeddingSpaceId === right.embeddingSpaceId &&
    left.rankingFeatureVersion === right.rankingFeatureVersion &&
    JSON.stringify(left.retrievalIdentity) === JSON.stringify(right.retrievalIdentity) &&
    JSON.stringify(left.analyzerIdentity) === JSON.stringify(right.analyzerIdentity)
  );
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

class PublisherLaneTimeoutError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'PublisherLaneTimeoutError';
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isBuildIntent(intent: VaultPublisherIntent): intent is VaultPublisherBuildIntent {
  return (
    intent.kind === 'rebuild' ||
    intent.kind === 'refresh' ||
    intent.kind === 'save' ||
    intent.kind === 'dense-publication'
  );
}

function buildLaneForIntent(intent: VaultPublisherBuildIntent): 'lexical' | 'dense' {
  return intent.kind === 'dense-publication' ? 'dense' : 'lexical';
}

function headCoversScanBoundary(head: EditionRecord, boundary: FrontierScanBoundary): boolean {
  return (
    head.frontierSeq >= boundary.frontierSeq && (head.scanBoundaryJournalSeq ?? 0) >= boundary.scanBoundaryJournalSeq
  );
}

function denseHeadSatisfiesIntent(head: EditionRecord, intent: DensePublicationIntent): boolean {
  if (head.dense.state !== 'fresh' || !head.identity.retrievalSnapshotId) return false;
  if (intent.targetCorpusSnapshotId && head.corpus.corpusSnapshotId !== intent.targetCorpusSnapshotId) return false;
  if (intent.targetLinkGraphId && head.linkGraphId !== intent.targetLinkGraphId) return false;
  if (intent.targetRetrievalSnapshotId && head.identity.retrievalSnapshotId !== intent.targetRetrievalSnapshotId)
    return false;
  return true;
}

function denseIntentSupersededByHead(head: EditionRecord, intent: DensePublicationIntent): boolean {
  if (intent.targetCorpusSnapshotId && head.corpus.corpusSnapshotId !== intent.targetCorpusSnapshotId) return true;
  if (intent.targetLinkGraphId && head.linkGraphId !== intent.targetLinkGraphId) return true;
  return false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rejectOnAbort(signal: AbortSignal, fallback?: unknown): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError(signal, fallback));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(abortError(signal, fallback));
      },
      {
        once: true,
      },
    );
  });
}

function fanInAbortSignal(signals: readonly AbortSignal[]): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(abortError(signal));
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => {
      abort(signal);
    };
    signal.addEventListener('abort', listener, { once: true });
    listeners.push(() => {
      signal.removeEventListener('abort', listener);
    });
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const cleanup of listeners.splice(0)) cleanup();
    },
  };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal && 'reason' in signal ? (signal as { readonly reason?: unknown }).reason : undefined;
}

function abortError(signal: AbortSignal | undefined, fallback?: unknown): Error {
  const reason = abortReason(signal) ?? fallback;
  if (reason instanceof Error) return reason;
  if (reason === undefined) return new AttemptCancelledError();
  const message = typeof reason === 'string' ? reason : 'operation aborted';
  return Object.assign(new Error(message), { code: 'CANCELLED' });
}

async function cleanupBuildOutput(output: VaultPublisherBuildOutput): Promise<void> {
  if (output.kind === 'candidate') await output.cleanup?.();
}

async function bestEffort(work: () => MaybePromise<void> | undefined): Promise<void> {
  try {
    await work();
  } catch {
    // Cleanup hooks must not kill the long-lived publisher lane.
  }
}

function isLaneAbort(error: unknown): boolean {
  return (
    error instanceof PublisherLaneTimeoutError ||
    error instanceof AttemptCancelledError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    errorCode(error) === 'DEADLINE_EXCEEDED' ||
    errorCode(error) === 'CANCELLED'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDenseLifecycleTransition(_current: DenseEdition, candidate: DenseEdition): boolean {
  if (candidate.state === 'fresh') return candidate.manifestHash.length > 0;
  if (candidate.state === 'building') return candidate.buildId.length > 0;
  if (candidate.state === 'failed') return candidate.diagnosticId.length > 0;
  return candidate.reason.length > 0;
}

function snapshotDirtyMarkToFrontierOperation(
  mark: { docId: string; path: string; contentHash?: string },
  nowMs: number,
): FrontierAppendOperation {
  if (mark.contentHash !== undefined) {
    return { op: 'upsert', docId: mark.docId, path: mark.path, contentHash: mark.contentHash };
  }
  return { op: 'delete', docId: mark.docId, path: mark.path, tombstoneSeq: nowMs };
}

function readDiagnostic(filePath: string): SaveDiagnosticRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Partial<SaveDiagnosticRecord>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.diagnosticId !== 'string' ||
      !Array.isArray(record.journalSeqs) ||
      !record.journalSeqs.every((seq) => Number.isSafeInteger(seq)) ||
      typeof record.vaultRoot !== 'string' ||
      typeof record.message !== 'string' ||
      typeof record.failedAt !== 'string' ||
      !record.writerToken
    )
      return undefined;
    return record as SaveDiagnosticRecord;
  } catch {
    return undefined;
  }
}

function errorCodeField(error: unknown): { errorCode?: string } {
  const code = errorCode(error);
  return code ? { errorCode: code } : {};
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function findPublicationsDirs(rootDir: string): string[] {
  const output: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isDirectory(current)) continue;
    if (path.basename(current) === 'publications') {
      output.push(current);
      continue;
    }
    for (const entry of safeReadDir(current)) stack.push(path.join(current, entry));
  }
  return output;
}

function buildReservationClaimDir(reservationsDir: string, manifestHash: string): string {
  return path.join(reservationsDir, safeStoreFileName(manifestHash));
}

export function denseFreshFromEdition(dense: DenseEdition): DenseEditionFresh | undefined {
  return dense.state === 'fresh' ? dense : undefined;
}
