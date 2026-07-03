import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FrontierJournal,
  frontierSubjectKey
} from "../src/core/lifecycle/frontier-journal.ts";
import {
  VaultPublisher,
  createLocalTenancyFenceProvider
} from "../src/daemon/search-store/publisher.ts";

test("FrontierJournal crash replay covers direct upsert and direct delete", () => {
  const root = tempRoot();
  try {
    const journal = new FrontierJournal(root);
    const upsert = journal.appendUpsert("doc-a", "a.md", "hash-a");
    const deletion = journal.appendDelete("doc-b", "b.md", 7);
    const boundary = journal.recordScanBoundary();

    const replayed = new FrontierJournal(root);
    const coverage = replayed.coverage(candidate({
      hashes: [[upsert, "hash-a"]],
      tombstones: [deletion]
    }), boundary.scanBoundaryJournalSeq);

    assert.equal(coverage.covers(upsert), true);
    assert.equal(coverage.covers(deletion), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FrontierJournal crash replay covers all same-subject supersession rows", () => {
  const cases = [
    {
      name: "upsert -> upsert",
      first: { op: "upsert", contentHash: "hash-old" },
      later: { op: "upsert", contentHash: "hash-new" },
      committedHash: "hash-new"
    },
    {
      name: "upsert -> delete",
      first: { op: "upsert", contentHash: "hash-old" },
      later: { op: "delete", tombstoneSeq: 11 },
      tombstone: true
    },
    {
      name: "delete -> delete",
      first: { op: "delete", tombstoneSeq: 12 },
      later: { op: "delete", tombstoneSeq: 13 },
      tombstone: true
    },
    {
      name: "delete -> upsert",
      first: { op: "delete", tombstoneSeq: 14 },
      later: { op: "upsert", contentHash: "hash-recreated" },
      committedHash: "hash-recreated"
    },
    {
      name: "recreate -> delete",
      first: { op: "upsert", contentHash: "hash-recreated" },
      later: { op: "delete", tombstoneSeq: 15 },
      tombstone: true
    }
  ];

  for (const row of cases) {
    const root = tempRoot();
    try {
      const journal = new FrontierJournal(root);
      const first = appendRowOperation(journal, row.first);
      const later = appendRowOperation(journal, row.later);
      const boundary = journal.recordScanBoundary();

      const replayed = new FrontierJournal(root);
      const coverage = replayed.coverage(candidate({
        hashes: row.committedHash ? [[later, row.committedHash]] : [],
        tombstones: row.tombstone ? [later] : []
      }), boundary.scanBoundaryJournalSeq);

      assert.equal(coverage.covers(first), true, row.name);
      assert.equal(coverage.covers(later), true, `${row.name} later operation`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("FrontierJournal does not supersede outside the scan boundary or across subject lines", () => {
  const outsideRoot = tempRoot();
  try {
    const journal = new FrontierJournal(outsideRoot);
    const first = journal.appendUpsert("doc-a", "a.md", "hash-old");
    const boundary = journal.recordScanBoundary();
    const later = journal.appendUpsert("doc-a", "a.md", "hash-new");

    const replayed = new FrontierJournal(outsideRoot);
    assert.equal(
      replayed.covers(first, candidate({ hashes: [[later, "hash-new"]] }), boundary.scanBoundaryJournalSeq),
      false
    );
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }

  const crossSubjectRoot = tempRoot();
  try {
    const journal = new FrontierJournal(crossSubjectRoot);
    const first = journal.appendUpsert("doc-a", "a.md", "hash-old");
    const otherPath = journal.appendUpsert("doc-a", "nested/a.md", "hash-new");
    const otherDoc = journal.appendUpsert("doc-b", "a.md", "hash-newer");
    const boundary = journal.recordScanBoundary();

    const replayed = new FrontierJournal(crossSubjectRoot);
    assert.equal(
      replayed.covers(first, candidate({ hashes: [[otherPath, "hash-new"], [otherDoc, "hash-newer"]] }), boundary.scanBoundaryJournalSeq),
      false
    );
  } finally {
    fs.rmSync(crossSubjectRoot, { recursive: true, force: true });
  }
});

test("AC3 publisher persists failed save diagnostics", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const publisher = createPublisher(root, fence);
    const [operation] = publisher.enqueueDirtyMarks([{ docId: "doc-a", path: "A.md", contentHash: "hash-a" }]);
    const error = Object.assign(new Error("save failed"), { code: "E_SAVE" });
    const diagnostic = await publisher.persistFailureDiagnostic({
      journalSeqs: [operation.journalSeq],
      vaultRoot: "/vault",
      error,
      writerToken: fence.writerToken
    });
    assert.equal(diagnostic.message, "save failed");
    assert.equal(diagnostic.errorCode, "E_SAVE");

    const replayed = createPublisher(root, fence);
    assert.deepEqual(
      replayed.diagnostics().map((record) => ({
        journalSeqs: record.journalSeqs,
        vaultRoot: record.vaultRoot,
        message: record.message,
        errorCode: record.errorCode
      })),
      [{ journalSeqs: [operation.journalSeq], vaultRoot: "/vault", message: "save failed", errorCode: "E_SAVE" }]
    );
    await replayed.stop();
    await publisher.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC3 publisher stop journals pending debounce state", async () => {
  const root = tempRoot();
  try {
    const fence = createLocalTenancyFenceProvider();
    const publisher = createPublisher(root, fence);
    publisher.enqueueDebouncedDirtyMarks([{ docId: "doc-a", path: "A.md", contentHash: "hash-a" }]);
    await publisher.stop();

    const replayed = createPublisher(root, fence);
    assert.deepEqual(
      replayed.frontierJournal.operations().map((operation) => ({
        op: operation.op,
        docId: operation.docId,
        path: operation.path,
        contentHash: operation.contentHash
      })),
      [{ op: "upsert", docId: "doc-a", path: "A.md", contentHash: "hash-a" }]
    );
    await replayed.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function appendRowOperation(journal, operation) {
  if (operation.op === "upsert") return journal.appendUpsert("doc", "note.md", operation.contentHash);
  return journal.appendDelete("doc", "note.md", operation.tombstoneSeq);
}

function candidate({ hashes = [], tombstones = [] }) {
  return {
    committedHashBySubject: new Map(hashes.map(([operation, hash]) => [frontierSubjectKey(operation), hash])),
    tombstoneProof: new Set(tombstones.map((operation) => frontierSubjectKey(operation)))
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-frontier-journal-"));
}

function createPublisher(root, fence) {
  const retrievalIdentity = {
    vaultStateHash: "vault-a",
    lexicalIdentityHash: "lex-a",
    embeddingSpaceId: "space-a"
  };
  return new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, "ledger")),
    retrievalIdentity,
    tenancyFence: fence
  });
}
