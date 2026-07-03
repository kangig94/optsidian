import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSearchDaemonClient } from "../src/daemon/client.ts";
import {
  createBindBackedTenancyFenceProvider,
  createOwnerRecord,
  createOwnerRegistry,
  desiredOwnerIdentity,
  socketPathForOwner
} from "../src/daemon/owner-registry.ts";
import { SEARCH_DAEMON_PROTOCOL_VERSION } from "../src/daemon/protocol.ts";
import { createRpcServer, probeSocketPath } from "../src/daemon/transport.ts";
import {
  VaultPublisher,
  editionCoverageFromCorpus
} from "../src/daemon/search-store/publisher.ts";

test("AC7 partial-bind is unrepresentable under a single tenancy socket record", () => {
  const runtimeDir = tempRoot();
  const desired = desiredOwnerIdentity(process.execPath);
  const socketPath = socketPathForOwner(runtimeDir, desired);
  const owner = createOwnerRecord(desired, socketPath, 1, "incarnation-a", process.pid);

  assert.deepEqual(Object.keys(owner).sort(), [
    "binaryVersion",
    "epoch",
    "incarnationId",
    "pid",
    "slot",
    "socketPath",
    "startedAt"
  ].sort());
  assert.equal(owner.slot.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
  assert.equal(owner.socketPath, socketPath);
  assert.equal("querySocketPath" in owner, false);
  assert.equal("controlSocketPath" in owner, false);
});

test("AC8 stale socket path is unlinked only after a failed connect probe", async () => {
  const root = tempRoot();
  const socketPath = path.join(root, "daemon.sock");
  const live = net.createServer();
  await listen(live, socketPath);
  assert.equal(await probeSocketPath(socketPath), "listening");

  await assert.rejects(
    () => createRpcServer({ socketPath, handleRequest: async () => ({ ok: true }) }),
    (error) => {
      assert.equal(error.code, "EADDRINUSE");
      return true;
    }
  );
  assert.equal(await probeSocketPath(socketPath), "listening");

  await closeServer(live);
  const startedAt = Date.now();
  const server = await createRpcServer({ socketPath, handleRequest: async () => ({ ok: true }) });
  try {
    assert.ok(Date.now() - startedAt < 1000, "dead holder reclaimed without a wall-clock lease wait");
    assert.equal(await probeSocketPath(socketPath), "listening");
  } finally {
    await server.close();
  }
});

test("AC8 pid reuse cannot deadlock stale daemon replacement", async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const stale = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, "stale", process.pid);
  registry.writeOwner(stale);
  const published = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    readyTimeoutMs: 1000,
    spawnDaemon(record) {
      const owner = { ...record, epoch: 2, incarnationId: "fresh", pid: process.pid, startedAt: new Date().toISOString() };
      registry.writeOwner(owner);
      published.push(owner);
      return { pid: process.pid };
    },
    connect(record) {
      if (record.incarnationId === "stale") {
        throw Object.assign(new Error("stale socket refused"), { code: "ECONNREFUSED" });
      }
      return {
        async request(request) {
          assert.equal(request.method, "Status");
          return statusResult(record);
        },
        async close() {}
      };
    }
  });

  const status = await client.status({ deadlineMs: 1000 });
  assert.equal(status.incarnationId, "fresh");
  assert.equal(published.length, 1);
});

test("real bind-backed writer token rejects cross-incarnation stale publish", async () => {
  const root = tempRoot();
  const runtimeDir = path.join(root, "runtime");
  const desired = desiredOwnerIdentity(process.execPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const ownerA = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, "incarnation-a", process.pid);
  registry.writeOwner(ownerA);
  const fenceA = createBindBackedTenancyFenceProvider(registry, ownerA, "claim-a");
  const publisher = new VaultPublisher({
    paths: VaultPublisher.pathsFor(path.join(root, "ledger")),
    retrievalIdentity,
    tenancyFence: fenceA
  });
  const document = { documentId: "doc-a", path: "A.md", contentHash: "hash-a" };
  publisher.markDirty({ op: "upsert", docId: document.documentId, path: document.path, contentHash: document.contentHash });
  const boundary = publisher.recordScanBoundary();

  const ownerB = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 2, "incarnation-b", process.pid);
  registry.writeOwner(ownerB);
  const result = await publisher.commit({
    frontierSeq: boundary.frontierSeq,
    scanBoundaryJournalSeq: boundary.scanBoundaryJournalSeq,
    corpus: {
      snapshotId: "snapshot-a",
      corpusSnapshotId: "corpus-a",
      canonicalManifestSha256: "manifest-a"
    },
    linkGraphId: "link-a",
    dense: { state: "unavailable", reason: "dense-not-built" },
    identity: editionIdentity(),
    coverage: editionCoverageFromCorpus({ documents: [document] })
  }, undefined, fenceA.writerToken);

  assert.deepEqual(result, {
    ok: false,
    reason: "not-current",
    message: "writer token is no longer current"
  });
});

const retrievalIdentity = {
  vaultStateHash: "vault-a",
  lexicalIdentityHash: "lex-a",
  embeddingSpaceId: "space-a"
};

function editionIdentity() {
  return {
    retrievalIdentity,
    vaultStateHash: retrievalIdentity.vaultStateHash,
    lexicalIdentityHash: retrievalIdentity.lexicalIdentityHash,
    embeddingSpaceId: retrievalIdentity.embeddingSpaceId,
    rankingFeatureVersion: "ranking-v1",
    analyzerIdentity: { name: "test-analyzer", version: "1", node: "test" }
  };
}

function statusResult(owner) {
  return {
    ok: true,
    ready: true,
    phase: "ready",
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    binaryVersion: owner.binaryVersion,
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    pid: owner.pid,
    socketPath: owner.socketPath,
    startedAt: owner.startedAt,
    owner,
    metrics: { requests: 0, failures: 0, activeRequests: 0, startedAt: owner.startedAt },
    pools: {},
    searchStore: {},
    profiles: {},
    vaults: []
  };
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-daemon-tenancy-"));
}
