import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { corpusSnapshotIdFromManifest } from '../src/core/search/segments/canonical.ts';
import { buildCanonicalSearchSnapshot } from '../src/daemon/search-store/builder.ts';
import { searchStoreCachePaths, searchStoreLedgerRootDir } from '../src/daemon/search-store/cache-paths.ts';
import {
  VaultPublisher,
  createLocalTenancyFenceProvider,
  editionCoverageFromCorpus,
} from '../src/daemon/search-store/publisher.ts';
import { createDaemonSnapshotStore } from '../src/daemon/search-store/snapshot-store.ts';
import { createDeterministicEmbeddingSetBuilder } from './helpers/deterministic-embedding.mjs';
import { editionDense } from './helpers/edition-ledger.mjs';

test('AC4 publisher lane times out a hung build and continues with queued intents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-lane-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    const cancellation = {
      snapshot: [],
      embed: [],
      workers: [],
    };
    const buildInputs = [];
    let buildCalls = 0;
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          buildInputs.push(input);
          if (buildCalls === 1) return new Promise(() => undefined);
          const document = doc('doc-a', 'A.md', 'hash-v2');
          return {
            kind: 'candidate',
            candidate: candidate({
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus('snapshot-v2'),
              documents: [document],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
        cancelSnapshotEffects({ cancellationId }) {
          cancellation.snapshot.push(cancellationId);
        },
        cancelEmbedScheduler({ cancellationId }) {
          cancellation.embed.push(cancellationId);
        },
        cancelWorkerPools({ cancellationId }) {
          cancellation.workers.push(cancellationId);
        },
      },
    });

    publisher.markDirty({ op: 'upsert', docId: 'doc-a', path: 'A.md', contentHash: 'hash-v1' });
    const firstBoundary = publisher.recordScanBoundary();
    const firstDeadline = Date.now() + 150;
    const startedAt = Date.now();
    const first = publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: firstBoundary,
      deadline: firstDeadline,
      cancellationId: 'hung-build',
    });
    await waitFor(() => buildCalls === 1);
    assert.equal(buildInputs[0].deadline, firstDeadline);
    assert.equal(buildInputs[0].cancellationId, 'hung-build');
    assert.equal(buildInputs[0].signal.aborted, false);

    publisher.markDirty({ op: 'upsert', docId: 'doc-a', path: 'A.md', contentHash: 'hash-v2' });
    const secondBoundary = publisher.recordScanBoundary();
    const second = publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: secondBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'second-build',
    });

    const firstResult = await first;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(firstResult.status, 'dropped');
    assert.match(firstResult.reason, /deadline exceeded/);
    assert.ok(elapsedMs < 600, `hung build should settle near its hard deadline, took ${elapsedMs}ms`);
    assert.equal(buildInputs[0].signal.aborted, true);
    assert.deepEqual(cancellation.snapshot, ['hung-build']);
    assert.deepEqual(cancellation.embed, ['hung-build']);
    assert.deepEqual(cancellation.workers, ['hung-build']);

    const secondResult = await second;
    assert.equal(secondResult.status, 'committed');
    assert.equal(secondResult.edition.corpus.snapshotId, 'snapshot-v2');
    assert.equal(publisher.ledger.current()?.corpus.snapshotId, 'snapshot-v2');
    assert.equal(buildCalls, 2);
    assert.equal(buildInputs[1].cancellationId, 'second-build');
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a writer token superseded mid-commit rejects the intent as a retryable stale incarnation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-supersede-'));
  let publisher;
  try {
    const base = createLocalTenancyFenceProvider();
    const superseding = {
      ...base.writerToken,
      epoch: base.writerToken.epoch + 1,
      incarnationId: 'superseding-incarnation',
    };
    let fenceCalls = 0;
    const fence = {
      currentWriterToken() {
        fenceCalls += 1;
        // The lane acquires this daemon's token, then the ledger re-verifies at commit time.
        // Returning a newer incarnation's token on the verify read reproduces a live handoff:
        // this daemon built the edition but no longer holds the writer lease.
        return fenceCalls === 1 ? base.writerToken : superseding;
      },
    };
    const document = doc('doc-a', 'A.md', 'hash-a');
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          return {
            kind: 'candidate',
            candidate: candidate({
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus('superseded-snapshot'),
              documents: [document],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
    });
    const boundary = publisher.recordScanBoundary();

    await assert.rejects(
      publisher.enqueue({
        kind: 'rebuild',
        scanBoundary: boundary,
        deadline: Date.now() + 1_000,
        cancellationId: 'superseded-build',
      }),
      (error) => {
        // A dropped result would strip the code down to a bare message; the reject must carry
        // STALE_INCARNATION so the client keys retry/resync on it rather than treating it as fatal.
        assert.equal(error.code, 'STALE_INCARNATION');
        assert.match(error.message, /not-current/);
        return true;
      },
    );

    assert.equal(
      fenceCalls,
      2,
      `commit path should acquire then verify the writer token exactly once each, saw ${fenceCalls} reads`,
    );
    assert.equal(publisher.ledger.current(), undefined);
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lost writer lease at commit-acquire rejects the intent as a retryable stale incarnation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-no-lease-'));
  let publisher;
  try {
    // A fence that yields no current token models this daemon having lost the writer lease
    // outright: commitBuildOutput short-circuits at its acquire read, before ledger.commit runs,
    // so this covers the null-token not-current path distinct from the ledger-verify mismatch.
    let fenceCalls = 0;
    const fence = {
      currentWriterToken() {
        fenceCalls += 1;
        return undefined;
      },
    };
    const document = doc('doc-a', 'A.md', 'hash-a');
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          return {
            kind: 'candidate',
            candidate: candidate({
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus('leaseless-snapshot'),
              documents: [document],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
    });
    const boundary = publisher.recordScanBoundary();

    await assert.rejects(
      publisher.enqueue({
        kind: 'rebuild',
        scanBoundary: boundary,
        deadline: Date.now() + 1_000,
        cancellationId: 'leaseless-build',
      }),
      (error) => {
        assert.equal(error.code, 'STALE_INCARNATION');
        assert.match(error.message, /not-current/);
        return true;
      },
    );

    assert.equal(fenceCalls, 1, `acquire should short-circuit before ledger verify, saw ${fenceCalls} reads`);
    assert.equal(publisher.ledger.current(), undefined);
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publisher lane rejects all folded envelopes when a coalesced build throws', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-coalesced-throw-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    const thrown = new Error('coalesced build failed');
    let buildCalls = 0;
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          assert.equal(input.intents.length, 2);
          assert.deepEqual(
            input.intents.map((intent) => intent.kind),
            ['rebuild', 'save'],
          );
          throw thrown;
        },
      },
    });

    const firstDocument = doc('doc-a', 'A.md', 'hash-a');
    const secondDocument = doc('doc-b', 'B.md', 'hash-b');
    publisher.markDirty({
      op: 'upsert',
      docId: firstDocument.documentId,
      path: firstDocument.path,
      contentHash: firstDocument.contentHash,
    });
    const firstBoundary = publisher.recordScanBoundary();
    publisher.markDirty({
      op: 'upsert',
      docId: secondDocument.documentId,
      path: secondDocument.path,
      contentHash: secondDocument.contentHash,
    });
    const secondBoundary = publisher.recordScanBoundary();

    const first = publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: firstBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'coalesced-throw-rebuild',
    });
    const second = publisher.enqueue({
      kind: 'save',
      scanBoundary: secondBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'coalesced-throw-save',
    });
    const trailing = publisher.enqueue({
      kind: 'dirty-frontier',
      operations: [{ op: 'upsert', docId: 'doc-c', path: 'C.md', contentHash: 'hash-c' }],
    });
    const settlements = [first, second, trailing].map(settlePromise);

    await waitFor(() => buildCalls === 1);
    await withTimeout(publisher.drain(), 1_000, 'publisher drain after coalesced build failure');
    const results = await withTimeout(
      Promise.all(settlements),
      1_000,
      'publisher folded envelopes after coalesced build failure',
    );

    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected', 'rejected'],
    );
    for (const result of results) assert.equal(result.reason, thrown);
    assert.equal(publisher.ledger.current(), undefined);

    await withTimeout(publisher.stop(), 1_000, 'publisher stop after coalesced build failure');
    publisher = undefined;
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 concurrent lexical publisher intents resolve without caller-visible not-head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-ac2-concurrent-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    let buildCalls = 0;
    const documents = [doc('doc-a', 'A.md', 'hash-a'), doc('doc-b', 'B.md', 'hash-b'), doc('doc-c', 'C.md', 'hash-c')];
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus(`snapshot-${buildCalls}`),
              documents,
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    const kinds = ['rebuild', 'refresh', 'save'];
    const promises = documents.flatMap((document, index) => {
      publisher.markDirty({
        op: 'upsert',
        docId: document.documentId,
        path: document.path,
        contentHash: document.contentHash,
      });
      const scanBoundary = publisher.recordScanBoundary();
      return [
        publisher.enqueue({
          kind: kinds[index % kinds.length],
          scanBoundary,
          deadline: Date.now() + 1_000,
          cancellationId: `lexical-${index}`,
        }),
      ];
    });

    const results = await Promise.all(promises);
    assert.equal(buildCalls, 1);
    assert.equal(
      results.every((result) => result.status === 'committed'),
      true,
    );
    assert.equal(
      results.some((result) => result.reason?.includes('not-head')),
      false,
    );
    assert.equal(publisher.ledger.current()?.corpus.snapshotId, 'snapshot-1');
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 mixed rebuild refresh save and dense intents settle on one consistent head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-ac1-mixed-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    let lexicalBuildCalls = 0;
    let denseBuildCalls = 0;
    const documents = [doc('doc-a', 'A.md', 'hash-a'), doc('doc-b', 'B.md', 'hash-b'), doc('doc-c', 'C.md', 'hash-c')];
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          lexicalBuildCalls += 1;
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus(`mixed-lexical-${lexicalBuildCalls}`),
              documents,
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
        buildDense(input) {
          denseBuildCalls += 1;
          assert.ok(input.head);
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head.editionSeq,
              frontierSeq: input.head.frontierSeq,
              scanBoundaryJournalSeq: input.head.scanBoundaryJournalSeq ?? 0,
              corpus: input.head.corpus,
              documents,
              dense: freshDense(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    const lexicalPromises = ['rebuild', 'refresh', 'save'].map((kind, index) => {
      const document = documents[index];
      publisher.markDirty({
        op: 'upsert',
        docId: document.documentId,
        path: document.path,
        contentHash: document.contentHash,
      });
      return publisher.enqueue({
        kind,
        scanBoundary: publisher.recordScanBoundary(),
        deadline: Date.now() + 1_000,
        cancellationId: `mixed-${kind}`,
      });
    });
    const densePromise = publisher.enqueue({
      kind: 'dense-publication',
      deadline: Date.now() + 1_000,
      cancellationId: 'mixed-dense',
    });

    const results = await Promise.all([...lexicalPromises, densePromise]);
    assert.equal(lexicalBuildCalls, 1);
    assert.equal(denseBuildCalls, 1);
    assert.equal(
      results.every((result) => result.status === 'committed'),
      true,
    );
    assert.equal(
      results.some((result) => result.reason?.includes('not-head')),
      false,
    );
    const finalHead = publisher.ledger.current();
    assert.ok(finalHead);
    assert.equal(finalHead.editionSeq, 2);
    assert.equal(finalHead.dense.state, 'fresh');
    for (const result of results) {
      assert.equal(result.edition.corpus.snapshotId, finalHead.corpus.snapshotId);
    }
    assert.equal(results.at(-1).edition.editionSeq, finalHead.editionSeq);
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 sibling commit between build and commit is adopted as covering head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-ac2-sibling-'));
  let publisher;
  let sibling;
  try {
    const fence = createLocalTenancyFenceProvider();
    const document = doc('doc-a', 'A.md', 'hash-a');
    let buildCalls = 0;
    let injected = false;
    const scanBoundaryRef = {};
    publisher = createPublisher(root, fence, {
      beforeAppendForTests: async () => {
        if (injected) return;
        injected = true;
        const scanBoundary = scanBoundaryRef.value;
        assert.ok(scanBoundary);
        sibling = createPublisher(root, fence);
        await sibling.commit(
          candidate({
            frontierSeq: scanBoundary.frontierSeq,
            scanBoundaryJournalSeq: scanBoundary.scanBoundaryJournalSeq,
            corpus: corpus('sibling-snapshot'),
            documents: [document],
            dense: unavailable(),
            identity: sibling.retrievalIdentity,
          }),
          undefined,
          fence.writerToken,
        );
      },
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus('built-loser'),
              documents: [document],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
    });
    const scanBoundary = publisher.recordScanBoundary();
    scanBoundaryRef.value = scanBoundary;

    const result = await publisher.enqueue({
      kind: 'rebuild',
      scanBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'adopt-sibling',
    });

    assert.equal(result.status, 'covered');
    assert.equal(result.head.corpus.snapshotId, 'sibling-snapshot');
    assert.equal(publisher.ledger.current()?.corpus.snapshotId, 'sibling-snapshot');
    assert.equal(buildCalls, 1);
  } finally {
    await publisher?.stop().catch(() => undefined);
    await sibling?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 sibling commit below pending boundary forces a second build against the new head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-ac2-sibling-retry-'));
  let publisher;
  let sibling;
  try {
    const fence = createLocalTenancyFenceProvider();
    const firstDocument = doc('doc-a', 'A.md', 'hash-a');
    const secondDocument = doc('doc-b', 'B.md', 'hash-b');
    let buildCalls = 0;
    let injected = false;
    const siblingBoundaryRef = {};
    publisher = createPublisher(root, fence, {
      beforeAppendForTests: async () => {
        if (injected) return;
        injected = true;
        const siblingBoundary = siblingBoundaryRef.value;
        assert.ok(siblingBoundary);
        sibling = createPublisher(root, fence);
        const commit = await sibling.commit(
          candidate({
            frontierSeq: siblingBoundary.frontierSeq,
            scanBoundaryJournalSeq: siblingBoundary.scanBoundaryJournalSeq,
            corpus: corpus('sibling-partial'),
            documents: [firstDocument],
            dense: unavailable(),
            identity: sibling.retrievalIdentity,
          }),
          undefined,
          fence.writerToken,
        );
        assert.equal(commit.ok, true);
      },
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus(`built-${buildCalls}`),
              documents: [firstDocument, secondDocument],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: firstDocument.documentId,
      path: firstDocument.path,
      contentHash: firstDocument.contentHash,
    });
    siblingBoundaryRef.value = publisher.recordScanBoundary();
    publisher.markDirty({
      op: 'upsert',
      docId: secondDocument.documentId,
      path: secondDocument.path,
      contentHash: secondDocument.contentHash,
    });
    const pendingBoundary = publisher.recordScanBoundary();

    const result = await publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: pendingBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'retry-after-partial-sibling',
    });

    assert.equal(result.status, 'committed');
    assert.equal(buildCalls, 2);
    assert.equal(result.edition.corpus.snapshotId, 'built-2');
    assert.equal(result.edition.baseEditionSeq, 1);
    assert.equal(publisher.ledger.current()?.corpus.snapshotId, 'built-2');
  } finally {
    await publisher?.stop().catch(() => undefined);
    await sibling?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 not-head retry rejects when ledger state makes no progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-ac2-no-progress-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    const firstDocument = doc('doc-a', 'A.md', 'hash-a');
    const secondDocument = doc('doc-b', 'B.md', 'hash-b');
    let buildCalls = 0;
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          buildCalls += 1;
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus(`built-${buildCalls}`),
              documents: [firstDocument, secondDocument],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: firstDocument.documentId,
      path: firstDocument.path,
      contentHash: firstDocument.contentHash,
    });
    const firstBoundary = publisher.recordScanBoundary();
    const firstCommit = await publisher.commit(
      candidate({
        frontierSeq: firstBoundary.frontierSeq,
        scanBoundaryJournalSeq: firstBoundary.scanBoundaryJournalSeq,
        corpus: corpus('base-snapshot'),
        documents: [firstDocument],
        dense: unavailable(),
        identity: publisher.retrievalIdentity,
      }),
      undefined,
      fence.writerToken,
    );
    assert.equal(firstCommit.ok, true);
    fs.writeFileSync(path.join(publisher.ledger.publicationsDir, '2'), 'not an edition record\n', { mode: 0o600 });

    publisher.markDirty({
      op: 'upsert',
      docId: secondDocument.documentId,
      path: secondDocument.path,
      contentHash: secondDocument.contentHash,
    });
    const pendingBoundary = publisher.recordScanBoundary();

    await assert.rejects(
      () =>
        publisher.enqueue({
          kind: 'rebuild',
          scanBoundary: pendingBoundary,
          deadline: Date.now() + 1_000,
          cancellationId: 'no-progress-not-head',
        }),
      /not-head retry made no progress/,
    );
    assert.equal(buildCalls, 1);
    assert.equal(publisher.ledger.current()?.editionSeq, 1);
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 dense publication is not satisfied by lexical scan-boundary coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-dense-predicate-'));
  let publisher;
  try {
    const fence = createLocalTenancyFenceProvider();
    let denseBuildCalls = 0;
    const document = doc('doc-a', 'A.md', 'hash-a');
    publisher = createPublisher(root, fence, {
      effects: {
        buildSnapshot(input) {
          return {
            kind: 'candidate',
            candidate: candidate({
              baseEditionSeq: input.head?.editionSeq,
              frontierSeq: input.intent.scanBoundary.frontierSeq,
              scanBoundaryJournalSeq: input.intent.scanBoundary.scanBoundaryJournalSeq,
              corpus: corpus('lexical-only'),
              documents: [document],
              dense: unavailable(),
              identity: publisher.retrievalIdentity,
            }),
          };
        },
        buildDense() {
          denseBuildCalls += 1;
          return { kind: 'drop', reason: 'test dense build stopped' };
        },
      },
    });

    publisher.markDirty({
      op: 'upsert',
      docId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
    });
    const scanBoundary = publisher.recordScanBoundary();
    const lexical = await publisher.enqueue({
      kind: 'rebuild',
      scanBoundary,
      deadline: Date.now() + 1_000,
      cancellationId: 'lexical',
    });
    assert.equal(lexical.status, 'committed');
    const head = publisher.ledger.current();
    assert.ok(head);

    const dense = await publisher.enqueue({
      kind: 'dense-publication',
      scanBoundary,
      targetCorpusSnapshotId: head.corpus.corpusSnapshotId,
      targetLinkGraphId: head.linkGraphId,
      deadline: Date.now() + 1_000,
      cancellationId: 'dense',
    });

    assert.equal(denseBuildCalls, 1);
    assert.equal(dense.status, 'dropped');
    assert.equal(dense.reason, 'test dense build stopped');
  } finally {
    await publisher?.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publisher drain and stop ignore debounced dirty dropped by a racing clear', async () => {
  for (const action of ['drain', 'stop']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `optsidian-publisher-${action}-clear-`));
    let publisher;
    try {
      const fence = createLocalTenancyFenceProvider();
      publisher = createPublisher(root, fence);
      publisher.enqueueDebouncedDirtyMarks([{ docId: 'doc-a', path: 'A.md', contentHash: 'hash-a' }]);
      const clear = publisher.enqueue({ kind: 'clear' });

      if (action === 'drain') await publisher.drain();
      else await publisher.stop();

      const clearResult = await clear;
      assert.equal(clearResult.status, 'completed');
    } finally {
      await publisher?.stop({ drain: false }).catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('AC1 search GC preserves in-flight lexical artifacts before edition commit', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-inflight-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-inflight-vault-'));
  let store;
  let rebuild;
  const segmentVisible = createDeferred();
  const allowPublish = createDeferred();
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    let segmentPath;
    let blocked = false;
    writeVaultFile(vault, 'Inflight.md', '# Inflight\n\ncontent\n');
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      retentionCount: 1,
      partitionBits: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 }),
      durableRenameSegment: async (tmp, target) => {
        fs.renameSync(tmp, target);
        if (!blocked) {
          blocked = true;
          segmentPath = target;
          segmentVisible.resolve();
          await allowPublish.promise;
        }
      },
    });
    const paths = searchStoreCachePaths(vault, env);
    const publisher = store.publisherFor(paths);
    rebuild = publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: publisher.recordScanBoundary(),
      deadline: Date.now() + 5_000,
      cancellationId: 'gc-inflight-rebuild',
      requestContext: {
        deadline: Date.now() + 5_000,
        cancellationId: 'gc-inflight-rebuild',
        embeddingLane: 'rebuild',
      },
    });
    rebuild.catch(() => undefined);

    await segmentVisible.promise;
    assert.equal(publisher.ledger.current(), undefined);
    assert.ok(segmentPath);
    assert.equal(fs.existsSync(segmentPath), true);
    const linkGraphFiles = fs.readdirSync(paths.linkGraphsDir);
    assert.ok(linkGraphFiles.length > 0, 'link graph sidecar should be visible before commit');

    await store.requestGc(paths);
    assert.equal(fs.existsSync(segmentPath), true, 'GC must not unlink an in-flight segment');
    for (const file of linkGraphFiles) {
      assert.equal(
        fs.existsSync(path.join(paths.linkGraphsDir, file)),
        true,
        'GC must not unlink an in-flight link graph',
      );
    }

    allowPublish.resolve();
    const result = await rebuild;
    assert.equal(result.status, 'committed');
    assert.equal(publisher.ledger.current()?.corpus.snapshotId, result.edition.corpus.snapshotId);
    assert.equal(fs.existsSync(segmentPath), true);
  } finally {
    allowPublish.resolve();
    await rebuild?.catch(() => undefined);
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC3 stale-incarnation search GC deletion is rejected', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-stale-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-stale-vault-'));
  let store;
  let currentToken;
  let ownerToken;
  try {
    const ownerFence = createLocalTenancyFenceProvider({ incarnationId: 'owner' });
    const siblingFence = createLocalTenancyFenceProvider({ incarnationId: 'sibling' });
    ownerToken = ownerFence.writerToken;
    currentToken = siblingFence.writerToken;
    const tenancyFence = {
      writerToken: ownerFence.writerToken,
      currentWriterToken: async () => currentToken,
    };
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    store = createDaemonSnapshotStore({
      env,
      tenancyFence,
      retentionCount: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    });
    const paths = searchStoreCachePaths(vault, env);
    fs.mkdirSync(paths.snapshotsDir, { recursive: true });
    const staleCandidate = path.join(paths.snapshotsDir, 'stale-candidate');
    fs.writeFileSync(staleCandidate, '{}\n');

    await assert.rejects(() => store.requestGc(paths), /search GC deletion rejected/);
    assert.equal(fs.existsSync(staleCandidate), true);
  } finally {
    if (ownerToken) currentToken = ownerToken;
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('loadVault surfaces a superseded writer token as a retryable STALE_INCARNATION rather than a swallowed failure', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-load-stale-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-load-stale-vault-'));
  let store;
  try {
    // No current writer token models this daemon having lost the lease before the warm publish
    // commits. loadVault must NOT downgrade that to a resolved {status:'failed'} (which strips the
    // code); it must rethrow so the client resyncs and retries against the current daemon.
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    writeVaultFile(vault, 'Load.md', '# Load\n\ncontent\n');
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      retentionCount: 1,
      partitionBits: 1,
      tenancyFence: { currentWriterToken: async () => undefined },
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 }),
    });

    await assert.rejects(
      store.loadVault(vault, { deadline: Date.now() + 5_000, cancellationId: 'load-stale', embeddingLane: 'rebuild' }),
      (error) => {
        assert.equal(error.code, 'STALE_INCARNATION');
        return true;
      },
    );
  } finally {
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC3 handoff after root snapshot before delete does not unlink sibling-published artifact', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-handoff-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-gc-handoff-vault-'));
  let store;
  let siblingPublisher;
  let currentToken;
  let ownerToken;
  try {
    const ownerFence = createLocalTenancyFenceProvider({ incarnationId: 'owner' });
    const siblingFence = createLocalTenancyFenceProvider({ incarnationId: 'sibling' });
    ownerToken = ownerFence.writerToken;
    currentToken = ownerFence.writerToken;
    const tenancyFence = {
      writerToken: ownerFence.writerToken,
      currentWriterToken: async () => currentToken,
    };
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      tenancyFence,
      retentionCount: 99,
      partitionBits: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 }),
    });
    const paths = searchStoreCachePaths(vault, env);

    writeVaultFile(vault, 'Handoff.md', '# Handoff\n\nbefore\n');
    const first = await store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'gc-handoff-first',
      embeddingLane: 'rebuild',
    });
    await store.drainPublishers();
    await delay(20);

    writeVaultFile(vault, 'Handoff.md', '# Handoff\n\nafter\n');
    const second = await store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'gc-handoff-second',
      embeddingLane: 'rebuild',
    });
    await store.drainPublishers();
    assert.notEqual(first.snapshotId, second.snapshotId);
    store.retentionCount = 1;

    const victimPath = path.join(paths.snapshotsDir, first.snapshotId);
    const retainedPath = path.join(paths.snapshotsDir, second.snapshotId);
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(victimPath, oldTime, oldTime);
    fs.utimesSync(retainedPath, new Date(), new Date());

    const stalePublisher = store.publisherFor(paths);
    const retrievalIdentity = stalePublisher.retrievalIdentity;
    fs.rmSync(paths.ledgersDir, { recursive: true, force: true });

    const originalSnapshotIsProtected = store.snapshotIsProtectedForGc.bind(store);
    let handoffPublished = false;
    store.snapshotIsProtectedForGc = async (candidatePaths, snapshotId) => {
      const protectedForGc = await originalSnapshotIsProtected(candidatePaths, snapshotId);
      if (snapshotId === first.snapshotId && !protectedForGc && !handoffPublished) {
        handoffPublished = true;
        currentToken = siblingFence.writerToken;
        siblingPublisher = new VaultPublisher({
          paths: VaultPublisher.pathsFor(searchStoreLedgerRootDir(paths, retrievalIdentity.embeddingSpaceId)),
          retrievalIdentity,
          tenancyFence,
        });
        const envelope = JSON.parse(fs.readFileSync(victimPath, 'utf8'));
        const commit = await siblingPublisher.commit(
          candidateForEnvelope(paths, envelope, retrievalIdentity),
          undefined,
          siblingFence.writerToken,
        );
        assert.equal(commit.ok, true);
      }
      return protectedForGc;
    };

    await assert.rejects(() => store.requestGc(paths), /search GC deletion rejected/);
    assert.equal(handoffPublished, true);
    assert.equal(fs.existsSync(victimPath), true);
    assert.equal(siblingPublisher.ledger.current()?.corpus.snapshotId, first.snapshotId);
  } finally {
    if (ownerToken) currentToken = ownerToken;
    await siblingPublisher?.stop().catch(() => undefined);
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC5 dense-ready no-op refresh returns while a long rebuild is queued', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac5-ready-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac5-ready-vault-'));
  let store;
  let holdSecondBuild;
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    writeVaultFile(vault, 'Ready.md', '# Ready\n\nunchanged content\n');
    holdSecondBuild = createDeferred();
    let buildCalls = 0;
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      partitionBits: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => {
        buildCalls += 1;
        if (buildCalls === 2) await holdSecondBuild.promise;
        return buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
      },
    });

    const loaded = await store.loadVault(vault);
    assert.equal(loaded.vaults[0].status, 'ready');
    const paths = searchStoreCachePaths(vault, env);
    assert.equal(editionDense(paths).state, 'fresh');
    assert.equal(buildCalls, 1);

    const publisher = store.publisherFor(paths);
    const longRebuild = publisher.enqueue({
      kind: 'rebuild',
      scanBoundary: publisher.recordScanBoundary(),
      deadline: Date.now() + 5_000,
      cancellationId: 'long-rebuild',
      requestContext: {
        deadline: Date.now() + 5_000,
        cancellationId: 'long-rebuild',
      },
    });
    await waitFor(() => buildCalls === 2);

    const startedAt = Date.now();
    const refreshed = await store.refresh(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'dense-ready-refresh',
      embeddingLane: 'refresh',
    });
    assert.equal(refreshed.rebuilt, false);
    assert.ok(Date.now() - startedAt < 150, 'dense-ready no-op refresh should not wait behind rebuild lane work');
    assert.equal(editionDense(paths).state, 'fresh');

    holdSecondBuild.resolve();
    const rebuildResult = await longRebuild;
    assert.equal(rebuildResult.status, 'committed');
  } finally {
    holdSecondBuild?.resolve();
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC5 dense-missing no-op refresh enqueues dense and returns without awaiting same-lane work', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac5-missing-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac5-missing-vault-'));
  let store;
  let holdSecondDense;
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    writeVaultFile(vault, 'Dense.md', '# Dense\n\ninitial content\n');
    const innerEmbedding = createDeterministicEmbeddingSetBuilder();
    holdSecondDense = createDeferred();
    let denseBuildCalls = 0;
    const embeddingSetBuilder = {
      providerIdentity: innerEmbedding.providerIdentity,
      recipeIdentity: innerEmbedding.recipeIdentity,
      build: async (input) => {
        denseBuildCalls += 1;
        if (denseBuildCalls === 2) await holdSecondDense.promise;
        return innerEmbedding.build(input);
      },
      foldQueuedDocument: innerEmbedding.foldQueuedDocument?.bind(innerEmbedding),
      drainNextIncrementalDocuments: innerEmbedding.drainNextIncrementalDocuments?.bind(innerEmbedding),
    };
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      partitionBits: 1,
      embeddingSetBuilder,
      snapshotBuilder: async () => buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 }),
    });

    const loaded = await store.loadVault(vault);
    assert.equal(loaded.vaults[0].status, 'ready');
    const paths = searchStoreCachePaths(vault, env);
    assert.equal(editionDense(paths).state, 'fresh');
    assert.equal(denseBuildCalls, 1);

    writeVaultFile(vault, 'Dense.md', '# Dense\n\nchanged content\n');
    const rebuilt = await store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'lexical-rebuild',
      embeddingLane: 'rebuild',
    });
    assert.equal(rebuilt.ok, true);
    await waitFor(() => denseBuildCalls === 2);
    assert.equal(editionDense(paths).state, 'unavailable');

    const startedAt = Date.now();
    const refreshed = await store.refresh(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'dense-missing-refresh',
      embeddingLane: 'refresh',
    });
    assert.equal(refreshed.rebuilt, false);
    assert.ok(Date.now() - startedAt < 150, 'dense-missing refresh must not await dense in the same lane scope');
    assert.equal(editionDense(paths).state, 'unavailable');

    holdSecondDense.resolve();
    await waitFor(() => editionDense(paths).state === 'fresh', 1_000);
  } finally {
    holdSecondDense?.resolve();
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC8 dirty frontier is reset by clear before the next rebuild', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac8-reset-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac8-reset-vault-'));
  let store;
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    writeVaultFile(vault, 'Before.md', '# Before\n\npre-clear content\n');
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      partitionBits: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 }),
    });
    const paths = searchStoreCachePaths(vault, env);

    const journalSeqs = await store.journalSaveDirtyMarks(vault, [
      { docId: 'pre-clear-doc', path: 'Before.md', contentHash: 'pre-clear-hash' },
    ]);
    assert.deepEqual(journalSeqs, [1]);
    const preClearPublisher = store.publisherFor(paths);
    assert.equal(preClearPublisher.frontierJournal.operations().length, 1);

    const cleared = await store.clear(vault);
    assert.equal(cleared.action, 'clear');

    const postClearPublisher = store.publisherFor(paths);
    assert.notEqual(postClearPublisher, preClearPublisher);
    assert.deepEqual(postClearPublisher.frontierJournal.operations(), []);

    writeVaultFile(vault, 'After.md', '# After\n\npost-clear content\n');
    const rebuilt = await store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'ac8-reset-rebuild',
      embeddingLane: 'rebuild',
    });
    assert.equal(rebuilt.ok, true);

    const head = postClearPublisher.ledger.current();
    assert.ok(head);
    assert.equal(head.editionSeq, 1);
    assert.equal(head.frontierSeq, 1);
    assert.equal(head.scanBoundaryJournalSeq, 0);
    assert.deepEqual(postClearPublisher.frontierJournal.operations(), []);
  } finally {
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('AC8 concurrent clear versus rebuild and save settles without reusing deleted ledger state', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac8-race-cache-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-store-ac8-race-vault-'));
  let store;
  let holdFirstBuild;
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
    const analyzer = testAnalyzer();
    holdFirstBuild = createDeferred();
    let buildCalls = 0;
    writeVaultFile(vault, 'Race.md', '# Race\n\ninitial content\n');
    store = createDaemonSnapshotStore({
      env,
      analyzer,
      partitionBits: 1,
      embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
      snapshotBuilder: async () => {
        buildCalls += 1;
        if (buildCalls === 1) await holdFirstBuild.promise;
        return buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer, partitionBits: 1 });
      },
    });
    const paths = searchStoreCachePaths(vault, env);

    const rebuild = store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'ac8-race-rebuild',
      embeddingLane: 'rebuild',
    });
    await waitFor(() => buildCalls === 1);
    const clear = store.clear(vault);
    await Promise.resolve();
    const save = store.publishSaveSnapshot(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'ac8-race-save',
      embeddingLane: 'save',
    });

    holdFirstBuild.resolve();
    const [rebuildResult, clearResult, saveResult] = await Promise.allSettled([rebuild, clear, save]);
    assert.equal(rebuildResult.status, 'fulfilled');
    assert.equal(clearResult.status, 'fulfilled');
    assert.equal(saveResult.status, 'rejected');
    assert.match(saveResult.reason.message, /reset by clear/);

    const freshPublisher = store.publisherFor(paths);
    assert.equal(freshPublisher.ledger.current(), undefined);

    const rebuiltAfterClear = await store.rebuild(vault, {
      deadline: Date.now() + 5_000,
      cancellationId: 'ac8-race-post-clear-rebuild',
      embeddingLane: 'rebuild',
    });
    assert.equal(rebuiltAfterClear.ok, true);
    const head = freshPublisher.ledger.current();
    assert.ok(head);
    assert.equal(head.editionSeq, 1);
    assert.equal(head.scanBoundaryJournalSeq, 0);
  } finally {
    holdFirstBuild?.resolve();
    await store?.close().catch(() => undefined);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'test-analyzer', version: 'publisher-lane', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPublisher(root, tenancyFence, options = {}) {
  const retrievalIdentity = {
    vaultStateHash: 'vault-a',
    lexicalIdentityHash: 'lexical-a',
    embeddingSpaceId: 'space-a',
  };
  return new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, retrievalIdentity.embeddingSpaceId)),
    retrievalIdentity,
    tenancyFence,
    ...options,
  });
}

function candidate(input) {
  return {
    ...(input.baseEditionSeq === undefined ? {} : { baseEditionSeq: input.baseEditionSeq }),
    frontierSeq: input.frontierSeq,
    scanBoundaryJournalSeq: input.scanBoundaryJournalSeq,
    corpus: input.corpus,
    linkGraphId: 'link-graph',
    dense: input.dense,
    identity: editionIdentity(input.identity, input.dense),
    coverage: editionCoverageFromCorpus({ documents: input.documents }),
  };
}

function editionIdentity(identity, dense) {
  return {
    retrievalIdentity: identity,
    vaultStateHash: identity.vaultStateHash,
    lexicalIdentityHash: identity.lexicalIdentityHash,
    embeddingSpaceId: identity.embeddingSpaceId,
    rankingFeatureVersion: 'ranking-v1',
    analyzerIdentity: { name: 'test-analyzer', version: '1', node: 'test' },
    ...(dense.state === 'fresh' ? { embeddingSetId: dense.embeddingSetId, retrievalSnapshotId: 'retrieval-1' } : {}),
  };
}

function corpus(snapshotId) {
  return {
    snapshotId,
    corpusSnapshotId: `${snapshotId}-corpus`,
    canonicalManifestSha256: `${snapshotId}-manifest`,
  };
}

function doc(documentId, filePath, contentHash) {
  return { documentId, path: filePath, contentHash };
}

function unavailable(reason = 'dense-unavailable') {
  return { state: 'unavailable', reason };
}

function freshDense() {
  return {
    state: 'fresh',
    generationId: 'generation-1',
    embeddingSetId: 'embedding-set-1',
    embeddingSpaceId: 'space-a',
    embeddingRecipeFreshnessId: 'recipe-1',
    specId: 'spec-1',
    dbPath: 'vector.db',
    manifestHash: 'manifest-1',
    metadataSha256: 'metadata-1',
  };
}

function candidateForEnvelope(paths, envelope, retrievalIdentity) {
  return {
    frontierSeq: 1,
    scanBoundaryJournalSeq: 0,
    corpus: {
      snapshotId: envelope.snapshotId,
      corpusSnapshotId: envelope.corpusSnapshotId ?? corpusSnapshotIdFromManifest(envelope.manifest),
      canonicalManifestSha256: envelope.canonicalManifestSha256,
    },
    linkGraphId: envelope.linkGraphId,
    dense: unavailable('sibling-lexical-only'),
    identity: {
      retrievalIdentity,
      vaultStateHash: paths.vaultStateHash,
      lexicalIdentityHash: paths.lexicalIdentityHash,
      embeddingSpaceId: retrievalIdentity.embeddingSpaceId,
      rankingFeatureVersion: String(envelope.manifest.identityTuple.rankingFeatureVersion),
      analyzerIdentity: { name: 'test-analyzer', version: 'publisher-lane', node: 'test' },
    },
    coverage: editionCoverageFromCorpus({ documents: envelope.documents }),
  };
}

function settlePromise(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for condition');
}
