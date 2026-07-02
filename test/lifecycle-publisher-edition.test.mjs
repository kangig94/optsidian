import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SharedReclamationAuthority,
  VaultPublisher,
  createLocalTenancyFenceProvider,
  denseFreshFromEdition,
  editionCoverageFromCorpus,
  liveEditionHeadsUnder
} from "../src/daemon/search-store/publisher.ts";

test("AC2 atomic edition records dense failure without blocking lexical visibility", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const identity = retrievalIdentity("vault-a", "lex-a", "space-a");
    const publisher = publisherAt(root, identity, fence);
    const document = doc("doc-a", "A.md", "hash-a");
    publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
    const boundary = publisher.recordScanBoundary();

    const committed = await publisher.commit(
      candidate({
        identity,
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-a"),
        documents: [document],
        dense: {
          state: "failed",
          buildId: "dense-build-a",
          cause: "embedding unavailable",
          diagnosticId: "diag-a"
        }
      }),
      undefined,
      fence.writerToken
    );
    assert.equal(committed.ok, true);
    const edition = publisher.ledger.current();
    assert.equal(edition.corpus.snapshotId, "snapshot-a");
    assert.equal(edition.dense.state, "failed");
    assert.equal(edition.identity.retrievalSnapshotId, undefined);
    assert.equal(publisher.ledger.history().length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC2 fresh dense edition carries the vector generation identity readers and GC need", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const identity = retrievalIdentity("vault-a", "lex-a", "space-a");
    const publisher = publisherAt(root, identity, fence);
    const document = doc("doc-a", "A.md", "hash-a");
    publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
    const boundary = publisher.recordScanBoundary();
    const dense = fresh("manifest-a", identity);

    const committed = await publisher.commit(
      candidate({
        identity,
        frontierSeq: boundary.frontierSeq,
        scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
        corpus: corpus("snapshot-a"),
        documents: [document],
        dense
      }),
      undefined,
      fence.writerToken
    );
    assert.equal(committed.ok, true);
    assert.deepEqual(denseFreshFromEdition(publisher.ledger.current().dense), dense);
    assert.equal(publisher.ledger.current().identity.retrievalSnapshotId, "retrieval-manifest-a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC2 shared vector GC keeps sibling ledger live generation and reservation-protected builds", async () => {
  const root = tempRoot();
  try {
    const searchStoresDir = path.join(root, "search", "stores");
    const vectorRoot = path.join(root, "vectors");
    const generationsDir = path.join(vectorRoot, "generations");
    const reservationsDir = path.join(vectorRoot, "reservations");
    const claimDir = path.join(vectorRoot, "claims", "sweep");
    fs.mkdirSync(generationsDir, { recursive: true });

    const fence = createLocalTenancyFenceProvider();
    const identityA = retrievalIdentity("vault-a", "lex-a", "space-a");
    const identityB = retrievalIdentity("vault-a", "lex-b", "space-a");
    await commitFreshEdition(searchStoresDir, identityA, fence, "manifest-shared", "snapshot-a");
    await commitFreshEdition(searchStoresDir, identityB, fence, "manifest-shared", "snapshot-b");
    fs.mkdirSync(path.join(generationsDir, "manifest-shared"), { recursive: true });
    fs.mkdirSync(path.join(generationsDir, "manifest-stale"), { recursive: true });

    const authority = new SharedReclamationAuthority();
    await authority.sweepVectorGenerations({
      sharedKey: "vault-a:embedding-shared",
      searchStoresDir,
      generationsDir,
      reservationsDir,
      claimDir,
      vaultStateHash: "vault-a",
      embeddingSetId: "embedding-shared"
    });
    assert.equal(fs.existsSync(path.join(generationsDir, "manifest-shared")), true);
    assert.equal(fs.existsSync(path.join(generationsDir, "manifest-stale")), false);

    const reservation = await authority.acquireBuildReservation({ reservationsDir, manifestHash: "manifest-building" });
    fs.mkdirSync(path.join(generationsDir, "manifest-building"), { recursive: true });
    await authority.sweepVectorGenerations({
      sharedKey: "vault-a:embedding-shared",
      searchStoresDir,
      generationsDir,
      reservationsDir,
      claimDir,
      vaultStateHash: "vault-a",
      embeddingSetId: "embedding-shared"
    });
    assert.equal(fs.existsSync(path.join(generationsDir, "manifest-building")), true);
    reservation.release();
    await authority.sweepVectorGenerations({
      sharedKey: "vault-a:embedding-shared",
      searchStoresDir,
      generationsDir,
      reservationsDir,
      claimDir,
      vaultStateHash: "vault-a",
      embeddingSetId: "embedding-shared"
    });
    assert.equal(fs.existsSync(path.join(generationsDir, "manifest-building")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC2 shared lexical GC sees sibling ledgers under one lexical store", async () => {
  const root = tempRoot();
  try {
    const searchStoresDir = path.join(root, "search", "stores");
    const fence = createLocalTenancyFenceProvider();
    const identityA = retrievalIdentity("vault-a", "lex-shared", "space-a");
    const identityB = retrievalIdentity("vault-a", "lex-shared", "space-b");
    await commitFreshEdition(searchStoresDir, identityA, fence, "manifest-a", "snapshot-a");
    await commitFreshEdition(searchStoresDir, identityB, fence, "manifest-b", "snapshot-b");

    const authority = new SharedReclamationAuthority();
    const observed = [];
    await authority.sweepLexicalArtifacts({
      sharedKey: "vault-a:lex-shared",
      ledgerRootDir: path.join(searchStoresDir, "vault-a", "lex-shared"),
      claimDir: path.join(root, "lexical-claims", "vault-a-lex-shared"),
      removeIfUnreferenced: (liveEditions) => {
        observed.push(...liveEditions.map((edition) => edition.corpus.snapshotId).sort());
      }
    });
    assert.deepEqual(observed, ["snapshot-a", "snapshot-b"]);
    assert.deepEqual(
      liveEditionHeadsUnder(path.join(searchStoresDir, "vault-a", "lex-shared")).map((edition) => edition.identity.embeddingSpaceId).sort(),
      ["space-a", "space-b"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function commitFreshEdition(searchStoresDir, identity, fence, manifestHash, snapshotId) {
  const publisher = publisherAt(searchStoresDir, identity, fence);
  const document = doc(`${snapshotId}-doc`, `${snapshotId}.md`, `${snapshotId}-hash`);
  publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
  const boundary = publisher.recordScanBoundary();
  const committed = await publisher.commit(
    candidate({
      identity,
      frontierSeq: boundary.frontierSeq,
      scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
      corpus: corpus(snapshotId),
      documents: [document],
      dense: fresh(manifestHash, identity)
    }),
    undefined,
    fence.writerToken
  );
  assert.equal(committed.ok, true);
  await publisher.stop();
}

function publisherAt(root, identity, fence) {
  return new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, identity.vaultStateHash, identity.lexicalIdentityHash, identity.embeddingSpaceId)),
    retrievalIdentity: identity,
    tenancyFence: fence
  });
}

function candidate(input) {
  return {
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
    ...(dense.state === "fresh" ? {
      embeddingSetId: dense.embeddingSetId,
      retrievalSnapshotId: `retrieval-${dense.manifestHash}`,
      retrieverPlanIdentity: "plan-a"
    } : {})
  };
}

function retrievalIdentity(vaultStateHash, lexicalIdentityHash, embeddingSpaceId) {
  return { vaultStateHash, lexicalIdentityHash, embeddingSpaceId };
}

function corpus(snapshotId) {
  return {
    snapshotId,
    corpusSnapshotId: `${snapshotId}-corpus`,
    canonicalManifestSha256: `${snapshotId}-manifest`
  };
}

function doc(documentId, filePath, contentHash) {
  return { documentId, path: filePath, contentHash };
}

function fresh(manifestHash, identity) {
  return {
    state: "fresh",
    generationId: `generation-${manifestHash}`,
    embeddingSetId: "embedding-shared",
    embeddingSpaceId: identity.embeddingSpaceId,
    embeddingRecipeFreshnessId: "recipe-freshness-a",
    specId: "spec-a",
    dbPath: path.join("/tmp", `${manifestHash}.duckdb`),
    manifestHash,
    metadataSha256: `${manifestHash}-metadata`
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-publisher-edition-"));
}
