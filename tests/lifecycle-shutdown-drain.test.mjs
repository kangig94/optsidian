import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FrontierJournal } from '../src/core/lifecycle/frontier-journal.ts';
import {
  VaultPublisher,
  createLocalTenancyFenceProvider,
  editionCoverageFromCorpus,
} from '../src/daemon/search-store/publisher.ts';
import { createSearchDaemonIdleIsolationHarnessForTests } from '../src/daemon/server.ts';

test('AC9 publisher stop drains in-flight commit work and journals pending debounce', async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const entered = deferred();
    const release = deferred();
    let gateOnce = true;
    const publisher = createPublisher(root, fence, {
      beforeAppendForTests: async () => {
        if (!gateOnce) return;
        gateOnce = false;
        entered.resolve();
        await release.promise;
      },
    });
    const document = { documentId: 'doc-a', path: 'A.md', contentHash: 'hash-a' };
    publisher.markDirty({
      op: 'upsert',
      docId: document.documentId,
      path: document.path,
      contentHash: document.contentHash,
    });
    const boundary = publisher.recordScanBoundary();
    const commit = publisher.commit(
      {
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: {
          snapshotId: 'snapshot-a',
          corpusSnapshotId: 'corpus-a',
          canonicalManifestSha256: 'manifest-a',
        },
        linkGraphId: 'link-a',
        dense: { state: 'unavailable', reason: 'dense-not-built' },
        identity: editionIdentity(publisher.retrievalIdentity),
        coverage: editionCoverageFromCorpus({ documents: [document] }),
      },
      undefined,
      fence.writerToken,
    );
    await entered.promise;

    publisher.enqueueDebouncedDirtyMarks([{ docId: 'doc-b', path: 'B.md', contentHash: 'hash-b' }]);
    const stopped = publisher.stop();
    let stopReturned = false;
    stopped.then(() => {
      stopReturned = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopReturned, false);

    release.resolve();
    const committed = await commit;
    assert.equal(committed.ok, true);
    await stopped;
    assert.equal(stopReturned, true);

    const replayed = new FrontierJournal(path.join(root, 'ledger', 'frontier'));
    assert.equal(
      replayed
        .operations()
        .some(
          (operation) =>
            operation.op === 'upsert' &&
            operation.docId === 'doc-b' &&
            operation.path === 'B.md' &&
            operation.contentHash === 'hash-b',
        ),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC9 daemon drain relinquishes socket and owner before slow teardown', async () => {
  const closeEntered = deferred();
  const releaseClose = deferred();
  const scheduler = {
    cancel() {},
    async close() {
      closeEntered.resolve();
      await releaseClose.promise;
    },
  };
  const harness = createSearchDaemonIdleIsolationHarnessForTests({
    idleMs: 3_600_000,
    embedScheduler: scheduler,
  });
  fs.writeFileSync(harness.socketPath, '');

  const closing = harness.close();
  await closeEntered.promise;

  assert.equal(fs.existsSync(harness.socketPath), false);
  assert.equal(harness.ownerRemoved(), true);

  releaseClose.resolve();
  await closing;
});

test('supersession drain is bounded while explicit shutdown drain waits for in-flight work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  const boundedRpcServer = {
    relinquish: async () => undefined,
    drain: async () => new Promise(() => {}),
    close: async () => undefined,
  };
  const boundedHarness = createSearchDaemonIdleIsolationHarnessForTests({
    idleMs: 3_600_000,
    env: {
      ...process.env,
      OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS: '10',
    },
    embedScheduler: createScheduler(),
    rpcServer: boundedRpcServer,
  });
  let supersessionSettled = false;
  const supersessionShutdown = boundedHarness.waitForShutdown().then(() => {
    supersessionSettled = true;
  });

  boundedHarness.replaceOwner({
    ...boundedHarness.owner,
    incarnationId: 'successor-incarnation',
    socketPath: `${boundedHarness.socketPath}.successor`,
  });
  t.mock.timers.tick(10);
  await flushAsyncTurns();
  assert.equal(supersessionSettled, false);

  t.mock.timers.tick(5000);
  await flushAsyncTurns();
  assert.equal(supersessionSettled, true);
  await supersessionShutdown;

  const explicitDrain = deferred();
  const explicitRpcServer = {
    relinquish: async () => undefined,
    drain: async () => explicitDrain.promise,
    close: async () => undefined,
  };
  const explicitHarness = createSearchDaemonIdleIsolationHarnessForTests({
    idleMs: 3_600_000,
    embedScheduler: createScheduler(),
    rpcServer: explicitRpcServer,
  });
  let explicitSettled = false;
  const explicitShutdown = explicitHarness.close().then(() => {
    explicitSettled = true;
  });

  await flushAsyncTurns();
  t.mock.timers.tick(5000);
  await flushAsyncTurns();
  assert.equal(explicitSettled, false);

  explicitDrain.resolve();
  await explicitShutdown;
  assert.equal(explicitSettled, true);
});

function createPublisher(root, fence, options = {}) {
  const retrievalIdentity = {
    vaultStateHash: 'vault-a',
    lexicalIdentityHash: 'lex-a',
    embeddingSpaceId: 'space-a',
  };
  return new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, 'ledger')),
    retrievalIdentity,
    tenancyFence: fence,
    ...options,
  });
}

function editionIdentity(identity) {
  return {
    retrievalIdentity: identity,
    vaultStateHash: identity.vaultStateHash,
    lexicalIdentityHash: identity.lexicalIdentityHash,
    embeddingSpaceId: identity.embeddingSpaceId,
    rankingFeatureVersion: 'ranking-v1',
    analyzerIdentity: { name: 'test-analyzer', version: '1', node: 'test' },
  };
}

function createScheduler() {
  return {
    cancel() {},
    async close() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncTurns() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-publisher-shutdown-'));
}
