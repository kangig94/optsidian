import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../../core/private-path.js";
import {
  currentWriterTokensEqual,
  type ConditionalCommitResult,
  type CurrentWriterToken,
  type TenancyFenceProvider
} from "../../core/lifecycle/conditional-commit.js";
import { ExclusiveClaim, readExclusiveClaimOwner, reclaimExclusiveClaim } from "../../core/lifecycle/exclusive-claim.js";
import { createProcessToken, isAlive as processTokenIsAlive } from "../../core/lifecycle/process-token.js";
import {
  FrontierJournal,
  frontierSubjectKey,
  type FrontierAppendOperation,
  type FrontierCoverageCandidate,
  type FrontierDirtyOperation,
  type FrontierScanBoundary
} from "../../core/lifecycle/frontier-journal.js";
import { LevelReconciler } from "../../core/lifecycle/level-reconciler.js";
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
  type RetrievalIdentity
} from "./publication.js";
import { safeStoreFileName } from "./cache-paths.js";

export type EditionCandidate = {
  baseEditionSeq?: number;
  frontierSeq: number;
  scanBoundaryJournalSeq: number;
  corpus: EditionCorpusRecord;
  linkGraphId: EditionRecord["linkGraphId"];
  dense: DenseEdition;
  identity: EditionIdentity;
  coverage: FrontierCoverageCandidate;
};

export type EditionCommitValue = {
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
  now?: () => number;
  beforeAppendForTests?: () => void | Promise<void>;
};

type PublisherIntent =
  | { kind: "dirty"; operations: FrontierAppendOperation[] }
  | { kind: "diagnostic"; diagnostic: SaveDiagnosticRecord };

type PublisherWorld = {
  pendingOperations: readonly FrontierDirtyOperation[];
};

type PublisherFold = {
  intents: readonly PublisherIntent[];
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
    this.publicationsDir = path.join(options.ledgerRootDir, "publications");
    this.frontierJournal = options.frontierJournal;
    this.tenancyFence = options.tenancyFence;
    this.now = options.now ?? Date.now;
    this.beforeAppendForTests = options.beforeAppendForTests;
    ensurePrivateDirSync(this.publicationsDir, "Optsidian edition publications directory");
    this.sweepIncomplete();
  }

  current(): EditionRecord | undefined {
    const records = this.history();
    return records.at(-1);
  }

  history(): EditionRecord[] {
    ensurePrivateDirSync(this.publicationsDir, "Optsidian edition publications directory");
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
    writerToken: CurrentWriterToken
  ): Promise<EditionCommitResult> {
    await this.beforeAppendForTests?.();

    const currentHead = this.current();
    const actualHeadSeq = currentHead?.editionSeq;
    if (actualHeadSeq !== expectedHeadSeq) {
      return { ok: false, reason: "not-head", message: headMismatchMessage(expectedHeadSeq, actualHeadSeq) };
    }

    const liveWriterToken = await this.tenancyFence.currentWriterToken();
    if (!liveWriterToken || !currentWriterTokensEqual(liveWriterToken, writerToken)) {
      return { ok: false, reason: "not-current", message: "writer token is no longer current" };
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
      committedAt: new Date(this.now()).toISOString()
    };

    const target = path.join(this.publicationsDir, String(editionSeq));
    try {
      writeEditionRecordExclusive(target, record);
      fsyncDirSync(this.publicationsDir);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return { ok: false, reason: "not-head", message: `publication ${editionSeq} already exists` };
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
    currentHead: EditionRecord | undefined
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    if (!currentHead) {
      if (candidate.baseEditionSeq !== undefined) {
        return { ok: false, reason: "rejected", message: "bootstrap edition cannot have a base edition" };
      }
      if (candidate.frontierSeq < 1) {
        return { ok: false, reason: "rejected", message: "bootstrap edition must publish a corpus frontier" };
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
      reason: "rejected",
      message: `candidate frontier ${candidate.frontierSeq} is older than current frontier ${currentHead.frontierSeq}`
    };
  }

  private validateCorpusAdvance(
    candidate: EditionCandidate
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    const dirtyThroughBoundary = this.frontierJournal.operations()
      .filter((operation) => operation.state !== "acked" && operation.journalSeq <= candidate.scanBoundaryJournalSeq);
    const uncovered = dirtyThroughBoundary.filter((operation) =>
      !this.frontierJournal.covers(operation, candidate.coverage, candidate.scanBoundaryJournalSeq)
    );
    if (uncovered.length > 0) {
      return {
        ok: false,
        reason: "rejected",
        message: `candidate frontier does not cover dirty journal seq ${uncovered.map((operation) => operation.journalSeq).join(",")}`
      };
    }
    return { ok: true, ackedJournalSeqs: dirtyThroughBoundary.map((operation) => operation.journalSeq) };
  }

  private validateSameFrontier(
    candidate: EditionCandidate,
    currentHead: EditionRecord
  ): { ok: true; ackedJournalSeqs: number[] } | Extract<EditionCommitResult, { ok: false }> {
    if (candidate.baseEditionSeq !== currentHead.editionSeq) {
      return {
        ok: false,
        reason: "not-head",
        message: `same-frontier edition must be based on current edition ${currentHead.editionSeq}`
      };
    }
    if (!sameCorpus(candidate.corpus, currentHead.corpus) || candidate.linkGraphId !== currentHead.linkGraphId) {
      return { ok: false, reason: "rejected", message: "same-frontier edition cannot change corpus or link graph identity" };
    }
    if (!sameStableIdentity(candidate.identity, currentHead.identity)) {
      return { ok: false, reason: "rejected", message: "same-frontier edition cannot change retrieval identity" };
    }
    if (!isDenseLifecycleTransition(currentHead.dense, candidate.dense)) {
      return { ok: false, reason: "rejected", message: "same-frontier edition may only change dense lifecycle state" };
    }
    return { ok: true, ackedJournalSeqs: [] };
  }

  private readRecordFile(filePath: string): EditionRecord | undefined {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return undefined;
      return decodeEditionRecord(fs.readFileSync(filePath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private sweepIncomplete(): void {
    ensurePrivateDirSync(this.publicationsDir, "Optsidian edition publications directory");
    for (const entry of safeReadDir(this.publicationsDir)) {
      if (entry.endsWith(".tmp") || entry.endsWith(".partial")) {
        fs.rmSync(path.join(this.publicationsDir, entry), { recursive: true, force: true });
      }
    }
  }
}

export class VaultPublisher {
  readonly retrievalIdentity: RetrievalIdentity;
  readonly paths: VaultPublisherPaths;
  readonly frontierJournal: FrontierJournal;
  readonly ledger: EditionLedger;

  private readonly now: () => number;
  private readonly inFlightWork = new Set<Promise<unknown>>();
  private readonly pendingDebounceOperations: FrontierAppendOperation[] = [];
  private readonly reconciler: LevelReconciler<PublisherWorld, PublisherFold, void, PublisherIntent>;

  constructor(options: VaultPublisherOptions) {
    this.retrievalIdentity = options.retrievalIdentity;
    this.paths = options.paths;
    this.now = options.now ?? Date.now;
    ensureVaultPublisherPaths(options.paths);
    this.frontierJournal = new FrontierJournal(options.paths.frontierDir);
    this.ledger = new EditionLedger({
      ledgerRootDir: options.paths.ledgerRootDir,
      frontierJournal: this.frontierJournal,
      tenancyFence: options.tenancyFence,
      now: this.now,
      beforeAppendForTests: options.beforeAppendForTests
    });
    this.reconciler = new LevelReconciler<PublisherWorld, PublisherFold, void, PublisherIntent>({
      enumerate: () => ({ pendingOperations: this.frontierJournal.pendingOperations() }),
      fold: (_world, batch) => ({ intents: batch.intents }),
      act: async (folded) => {
        for (const intent of folded.intents) {
          if (intent.kind === "dirty") {
            for (const operation of intent.operations) this.frontierJournal.append(operation);
          } else {
            this.writeDiagnostic(intent.diagnostic);
          }
        }
      }
    });
    this.reconciler.start();
  }

  static pathsFor(rootDir: string): VaultPublisherPaths {
    return {
      ledgerRootDir: rootDir,
      publicationsDir: path.join(rootDir, "publications"),
      frontierDir: path.join(rootDir, "frontier"),
      diagnosticsDir: path.join(rootDir, "diagnostics"),
      reservationsDir: path.join(rootDir, "reservations"),
      claimsDir: path.join(rootDir, "claims")
    };
  }

  markDirty(operation: FrontierAppendOperation): FrontierDirtyOperation {
    return this.frontierJournal.append(operation);
  }

  enqueueDirty(operation: FrontierAppendOperation): void {
    this.pendingDebounceOperations.push(operation);
    this.reconciler.enqueueIntent({ kind: "dirty", operations: [operation] });
  }

  enqueueDirtyMarks(marks: readonly { docId: string; path: string; contentHash?: string }[]): FrontierDirtyOperation[] {
    return marks.map((mark) => this.markDirty(snapshotDirtyMarkToFrontierOperation(mark, this.now())));
  }

  enqueueDebouncedDirtyMarks(marks: readonly { docId: string; path: string; contentHash?: string }[]): void {
    for (const mark of marks) this.pendingDebounceOperations.push(snapshotDirtyMarkToFrontierOperation(mark, this.now()));
  }

  flushPendingDebounce(): FrontierDirtyOperation[] {
    const operations = this.pendingDebounceOperations.splice(0);
    return operations.map((operation) => this.frontierJournal.append(operation));
  }

  recordScanBoundary(): FrontierScanBoundary {
    return this.frontierJournal.recordScanBoundary();
  }

  commit(
    candidate: EditionCandidate,
    expectedHeadSeq: number | undefined,
    writerToken: CurrentWriterToken
  ): Promise<EditionCommitResult> {
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
      writerToken: input.writerToken
    };
    this.writeDiagnostic(diagnostic);
    for (const journalSeq of diagnostic.journalSeqs) this.frontierJournal.fail(journalSeq, diagnostic.diagnosticId);
    return diagnostic;
  }

  diagnostics(): SaveDiagnosticRecord[] {
    return safeReadDir(this.paths.diagnosticsDir)
      .map((entry) => readDiagnostic(path.join(this.paths.diagnosticsDir, entry)))
      .filter((record): record is SaveDiagnosticRecord => record !== undefined)
      .sort((left, right) => left.failedAt.localeCompare(right.failedAt) || left.diagnosticId.localeCompare(right.diagnosticId));
  }

  async drain(): Promise<void> {
    await this.reconciler.drain();
    await Promise.allSettled([...this.inFlightWork]);
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.flushPendingDebounce();
    await this.reconciler.stop({ drain: options.drain ?? true });
    if (options.drain !== false) await Promise.allSettled([...this.inFlightWork]);
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
    ensurePrivateDirSync(this.paths.diagnosticsDir, "Optsidian save diagnostics directory");
    const target = path.join(this.paths.diagnosticsDir, `${safeStoreFileName(diagnostic.diagnosticId)}.json`);
    writePrivateFileSync(target, `${JSON.stringify(diagnostic)}\n`, "Optsidian save diagnostic");
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
      }
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
      now: this.now
    }).then((claim) => ({
      manifestHash: input.manifestHash,
      claim,
      release: () => claim.release()
    }));
  }

  async sweepVectorGenerations(input: SweepVectorGenerationsInput): Promise<void> {
    await this.runSerialized(input.sharedKey, async () => {
      const claim = await ExclusiveClaim.acquire(input.claimDir, { timeoutMs: 30_000, now: this.now });
      try {
        ensurePrivateDirSync(input.generationsDir, "Optsidian vector generations directory");
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

  liveVectorManifestHashes(input: Pick<
    SweepVectorGenerationsInput,
    "searchStoresDir" | "vaultStateHash" | "embeddingSetId"
  >): Set<string> {
    const live = new Set<string>();
    for (const edition of liveEditionHeadsUnder(path.join(input.searchStoresDir, input.vaultStateHash))) {
      if (edition.identity.vaultStateHash !== input.vaultStateHash) continue;
      if (edition.dense.state !== "fresh") continue;
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
  overrides: Partial<Omit<CurrentWriterToken, "processToken">> = {}
): TenancyFenceProvider & { readonly writerToken: CurrentWriterToken } {
  const writerToken: CurrentWriterToken = {
    epoch: overrides.epoch ?? 0,
    incarnationId: overrides.incarnationId ?? `local-${process.pid}`,
    claimId: overrides.claimId ?? `process-${process.pid}`,
    processToken: createProcessToken()
  };
  return {
    writerToken,
    currentWriterToken: () => writerToken
  };
}

export function editionCoverageFromCorpus(input: {
  documents: readonly { documentId: string; path: string; contentHash: string }[];
  tombstones?: readonly { docId: string; path: string; tombstoneSeq?: number }[];
}): FrontierCoverageCandidate {
  const committedHashBySubject = new Map<string, string>();
  for (const document of input.documents) {
    committedHashBySubject.set(frontierSubjectKey({ docId: document.documentId, path: document.path }), document.contentHash);
  }
  const tombstoneProof = new Set<string>();
  for (const tombstone of input.tombstones ?? []) {
    tombstoneProof.add(frontierSubjectKey({ docId: tombstone.docId, path: tombstone.path }));
  }
  return { committedHashBySubject, tombstoneProof };
}

export function liveEditionHeadsUnder(rootDir: string): EditionRecord[] {
  const heads: EditionRecord[] = [];
  for (const publicationsDir of findPublicationsDirs(rootDir)) {
    const records: EditionRecord[] = [];
    for (const entry of safeReadDir(publicationsDir)) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const record = decodeEditionRecord(fs.readFileSync(path.join(publicationsDir, entry), "utf8"));
        if (record && record.editionSeq === Number(entry)) records.push(record);
      } catch {}
    }
    const head = records.sort((left, right) => left.editionSeq - right.editionSeq).at(-1);
    if (head) heads.push(head);
  }
  return heads;
}

function ensureVaultPublisherPaths(paths: VaultPublisherPaths): void {
  ensurePrivateDirSync(paths.ledgerRootDir, "Optsidian publisher ledger directory");
  ensurePrivateDirSync(paths.publicationsDir, "Optsidian edition publications directory");
  ensurePrivateDirSync(paths.frontierDir, "Optsidian frontier journal directory");
  ensurePrivateDirSync(paths.diagnosticsDir, "Optsidian save diagnostics directory");
  ensurePrivateDirSync(paths.reservationsDir, "Optsidian build reservations directory");
  ensurePrivateDirSync(paths.claimsDir, "Optsidian publisher claims directory");
}

function writeEditionRecordExclusive(filePath: string, record: EditionRecord): void {
  ensurePrivateDirSync(path.dirname(filePath), "Optsidian edition publications directory");
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, encodeEditionRecord(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function headMismatchMessage(expected: number | undefined, actual: number | undefined): string {
  return `expected head ${expected ?? "none"} but current head is ${actual ?? "none"}`;
}

function sameCorpus(left: EditionCorpusRecord, right: EditionCorpusRecord): boolean {
  return left.snapshotId === right.snapshotId &&
    left.corpusSnapshotId === right.corpusSnapshotId &&
    left.canonicalManifestSha256 === right.canonicalManifestSha256;
}

function sameStableIdentity(left: EditionIdentity, right: EditionIdentity): boolean {
  return left.vaultStateHash === right.vaultStateHash &&
    left.lexicalIdentityHash === right.lexicalIdentityHash &&
    left.embeddingSpaceId === right.embeddingSpaceId &&
    left.rankingFeatureVersion === right.rankingFeatureVersion &&
    JSON.stringify(left.retrievalIdentity) === JSON.stringify(right.retrievalIdentity) &&
    JSON.stringify(left.analyzerIdentity) === JSON.stringify(right.analyzerIdentity);
}

function isDenseLifecycleTransition(_current: DenseEdition, candidate: DenseEdition): boolean {
  if (candidate.state === "fresh") return candidate.manifestHash.length > 0;
  if (candidate.state === "building") return candidate.buildId.length > 0;
  if (candidate.state === "failed") return candidate.diagnosticId.length > 0;
  return candidate.reason.length > 0;
}

function snapshotDirtyMarkToFrontierOperation(
  mark: { docId: string; path: string; contentHash?: string },
  nowMs: number
): FrontierAppendOperation {
  if (mark.contentHash !== undefined) {
    return { op: "upsert", docId: mark.docId, path: mark.path, contentHash: mark.contentHash };
  }
  return { op: "delete", docId: mark.docId, path: mark.path, tombstoneSeq: nowMs };
}

function readDiagnostic(filePath: string): SaveDiagnosticRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Partial<SaveDiagnosticRecord>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.diagnosticId !== "string" ||
      !Array.isArray(record.journalSeqs) ||
      !record.journalSeqs.every((seq) => Number.isSafeInteger(seq)) ||
      typeof record.vaultRoot !== "string" ||
      typeof record.message !== "string" ||
      typeof record.failedAt !== "string" ||
      !record.writerToken
    ) return undefined;
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
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
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
    if (path.basename(current) === "publications") {
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
  return dense.state === "fresh" ? dense : undefined;
}
