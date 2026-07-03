import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VaultPublisher,
  createLocalTenancyFenceProvider,
  editionCoverageFromCorpus
} from "../src/daemon/search-store/publisher.ts";

test("AC1 stale slow corpus build is rejected after a newer frontier commits", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const publisher = createPublisher(root, fence);
    const docV1 = doc("doc-a", "A.md", "hash-v1");
    publisher.markDirty({ op: "upsert", docId: docV1.documentId, path: docV1.path, contentHash: docV1.contentHash });
    const bootstrapBoundary = publisher.recordScanBoundary();
    const bootstrap = await publisher.commit(
      candidate({
        frontierSeq: bootstrapBoundary.frontierSeq,
        scanBoundaryJournalSeq: bootstrapBoundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [docV1]),
        documents: [docV1],
        dense: unavailable(),
        identity: publisher.retrievalIdentity
      }),
      undefined,
      fence.writerToken
    );
    assert.equal(bootstrap.ok, true);

    const docV2 = doc("doc-a", "A.md", "hash-v2");
    publisher.markDirty({ op: "upsert", docId: docV2.documentId, path: docV2.path, contentHash: docV2.contentHash });
    const slowBoundary = publisher.recordScanBoundary();
    const slowCandidate = candidate({
      baseEditionSeq: 1,
      frontierSeq: slowBoundary.frontierSeq,
      scanBoundaryJournalSeq: slowBoundary.scanBoundaryJournalSeq,
      corpus: corpus("snapshot-v2", [docV2]),
      documents: [docV2],
      dense: unavailable(),
      identity: publisher.retrievalIdentity
    });

    const docV3 = doc("doc-a", "A.md", "hash-v3");
    publisher.markDirty({ op: "upsert", docId: docV3.documentId, path: docV3.path, contentHash: docV3.contentHash });
    const fastBoundary = publisher.recordScanBoundary();
    const fast = await publisher.commit(
      candidate({
        baseEditionSeq: 1,
        frontierSeq: fastBoundary.frontierSeq,
        scanBoundaryJournalSeq: fastBoundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v3", [docV3]),
        documents: [docV3],
        dense: unavailable(),
        identity: publisher.retrievalIdentity
      }),
      1,
      fence.writerToken
    );
    assert.equal(fast.ok, true);
    assert.equal(fast.value.record.editionSeq, 2);
    assert.equal(fast.value.ackedJournalSeqs.length, 2);

    const stale = await publisher.commit(slowCandidate, 1, fence.writerToken);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "not-head");

    const blindLaterSeq = await publisher.commit({ ...slowCandidate, baseEditionSeq: 2, frontierSeq: fastBoundary.frontierSeq }, 2, fence.writerToken);
    assert.equal(blindLaterSeq.ok, false);
    assert.equal(blindLaterSeq.reason, "rejected");
    assert.match(blindLaterSeq.message, /same-frontier edition cannot change corpus/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC1 same-frontier dense lifecycle update is accepted only at current head", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const publisher = createPublisher(root, fence);
    const document = doc("doc-a", "A.md", "hash-v1");
    publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
    const boundary = publisher.recordScanBoundary();
    const first = await publisher.commit(
      candidate({
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: fresh("gen-1", publisher.retrievalIdentity),
        identity: publisher.retrievalIdentity
      }),
      undefined,
      fence.writerToken
    );
    assert.equal(first.ok, true);

    const lifecycleOnly = await publisher.commit(
      candidate({
        baseEditionSeq: 1,
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: failed(),
        identity: publisher.retrievalIdentity
      }),
      1,
      fence.writerToken
    );
    assert.equal(lifecycleOnly.ok, true);
    assert.equal(lifecycleOnly.value.record.editionSeq, 2);
    assert.deepEqual(lifecycleOnly.value.ackedJournalSeqs, []);
    assert.equal(lifecycleOnly.value.record.corpus.snapshotId, "snapshot-v1");

    const staleSameFrontier = await publisher.commit(
      candidate({
        baseEditionSeq: 1,
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: unavailable("dense-stale"),
        identity: publisher.retrievalIdentity
      }),
      1,
      fence.writerToken
    );
    assert.equal(staleSameFrontier.ok, false);
    assert.equal(staleSameFrontier.reason, "not-head");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC1 stale writer token is rejected through the tenancy fence", async () => {
  const root = tempRoot();
  try {
    const firstFence = createLocalTenancyFenceProvider({ incarnationId: "first" });
    const secondFence = createLocalTenancyFenceProvider({ incarnationId: "second" });
    let liveToken = secondFence.writerToken;
    const publisher = createPublisher(root, {
      currentWriterToken: () => liveToken
    });
    const document = doc("doc-a", "A.md", "hash-v1");
    publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
    const boundary = publisher.recordScanBoundary();

    const stale = await publisher.commit(
      candidate({
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: unavailable(),
        identity: publisher.retrievalIdentity
      }),
      undefined,
      firstFence.writerToken
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "not-current");

    liveToken = firstFence.writerToken;
    const accepted = await publisher.commit(
      candidate({
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: unavailable(),
        identity: publisher.retrievalIdentity
      }),
      undefined,
      firstFence.writerToken
    );
    assert.equal(accepted.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC1 tenancy change after prevalidation but before append is rejected", async () => {
  const root = tempRoot();
  try {
    const firstFence = createLocalTenancyFenceProvider({ incarnationId: "first" });
    const secondFence = createLocalTenancyFenceProvider({ incarnationId: "second" });
    let liveToken = firstFence.writerToken;
    const publisher = createPublisher(root, {
      currentWriterToken: () => liveToken
    }, {
      beforeAppendForTests: () => {
        liveToken = secondFence.writerToken;
      }
    });
    const document = doc("doc-a", "A.md", "hash-v1");
    publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
    const boundary = publisher.recordScanBoundary();
    const rejected = await publisher.commit(
      candidate({
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-v1", [document]),
        documents: [document],
        dense: unavailable(),
        identity: publisher.retrievalIdentity
      }),
      undefined,
      firstFence.writerToken
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "not-current");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createPublisher(root, tenancyFence, options = {}) {
  const retrievalIdentity = {
    vaultStateHash: "vault-a",
    lexicalIdentityHash: "lexical-a",
    embeddingSpaceId: "space-a"
  };
  return new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, retrievalIdentity.embeddingSpaceId)),
    retrievalIdentity,
    tenancyFence,
    ...options
  });
}

function candidate(input) {
  return {
    ...(input.baseEditionSeq === undefined ? {} : { baseEditionSeq: input.baseEditionSeq }),
    frontierSeq: input.frontierSeq,
    scanBoundaryJournalSeq: input.scanBoundaryJournalSeq,
    corpus: input.corpus,
    linkGraphId: "link-graph",
    dense: input.dense,
    identity: editionIdentity(input.identity, input.dense),
    coverage: editionCoverageFromCorpus({ documents: input.documents })
  };
}

function editionIdentity(identity, dense) {
  return {
    retrievalIdentity: identity,
    vaultStateHash: identity.vaultStateHash,
    lexicalIdentityHash: identity.lexicalIdentityHash,
    embeddingSpaceId: identity.embeddingSpaceId,
    rankingFeatureVersion: "ranking-v1",
    analyzerIdentity: { name: "test-analyzer", version: "1", node: "test" },
    ...(dense.state === "fresh" ? { embeddingSetId: dense.embeddingSetId, retrievalSnapshotId: "retrieval-1" } : {})
  };
}

function corpus(snapshotId, _documents) {
  return {
    snapshotId,
    corpusSnapshotId: `${snapshotId}-corpus`,
    canonicalManifestSha256: `${snapshotId}-manifest`
  };
}

function doc(documentId, filePath, contentHash) {
  return { documentId, path: filePath, contentHash };
}

function fresh(generationId, identity) {
  return {
    state: "fresh",
    generationId,
    embeddingSetId: "embedding-shared",
    embeddingSpaceId: identity.embeddingSpaceId,
    embeddingRecipeFreshnessId: "recipe-freshness-a",
    specId: "spec-a",
    dbPath: `/tmp/${generationId}.duckdb`,
    manifestHash: `${generationId}-manifest`,
    metadataSha256: `${generationId}-metadata`
  };
}

function failed() {
  return {
    state: "failed",
    buildId: "build-failed",
    cause: "boom",
    diagnosticId: "diag-failed"
  };
}

function unavailable(reason = "dense-unavailable") {
  return { state: "unavailable", reason };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-publisher-frontier-"));
}
