import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLinkAdjacencyRetriever,
  createLinkGraphView,
  retrieveWithFusion
} from "../src/core/search/retrieval/index.ts";
import {
  buildSearchSnapshotFromSegments,
  createPositionalRetriever,
  POSITIONAL_FIELD_ID
} from "../src/core/search/retrieval/positional/index.ts";
import { rerankCandidatesWithSignals, rerankScore } from "../src/core/search/ranking/index.ts";
import { rankSignalsFromFeatures } from "../src/daemon/search-execution.ts";
import {
  buildCanonicalSearchSnapshot
} from "../src/daemon/search-store/builder.ts";
import {
  buildLinkGraphSidecar,
  computeLinkGraphId,
  linkGraphSidecarPath,
  loadLinkGraphSidecar,
  loadLinkGraphView,
  storeLinkGraphSidecar
} from "../src/daemon/search-store/link-graph.ts";
import { searchStoreCachePaths } from "../src/daemon/search-store/cache-paths.ts";
import { createDaemonSnapshotStore } from "../src/daemon/search-store/snapshot-store.ts";
import { createDeterministicEmbeddingSetBuilder } from "./helpers/deterministic-embedding.mjs";

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map((match) => match[0]);
  return {
    identity: { name: "test-analyzer", version: "retrieval-substrate-p3", node: "test" },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize)
  };
}

function tempRoot(prefix = "optsidian-retrieval-p3-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function eventually(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(new TextEncoder().encode(value.normalize("NFC"))).digest("hex");
}

function queryAnalysis(raw) {
  const terms = raw.split(/\s+/u).filter(Boolean);
  return {
    raw,
    primaryChannel: "morph",
    primaryTerms: terms,
    channels: {
      morph: terms,
      surface: terms,
      ngram: []
    }
  };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      channel: entry.channel,
      fieldId: entry.fieldId,
      documentCount: entry.documentCount,
      totalFieldLength: entry.totalFieldLength,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3]
    })),
    hash: manifest.bm25GlobalStatsHash
  };
}

function searchSnapshotFromBuilt(built, linkGraph) {
  return buildSearchSnapshotFromSegments({
    snapshotId: built.snapshotId,
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: segment.bytes
    })),
    bm25Stats: bm25StatsFromManifest(built.manifest),
    linkGraph,
    validateProjection: false
  });
}

function featurePayload(candidate, lexicalScore) {
  return {
    candidate: {
      candidateId: candidate.candidateId,
      documentId: candidate.documentId,
      shardDocRef: candidate.shardDocRef,
      path: candidate.path
    },
    ...(candidate.retrieverSignals ? { retrieverSignals: candidate.retrieverSignals } : {}),
    ...(candidate.denseAgreement === undefined ? {} : { denseAgreement: candidate.denseAgreement }),
    ...(candidate.linkAgreement === undefined ? {} : { linkAgreement: candidate.linkAgreement }),
    ...(candidate.rrfScore === undefined ? {} : { rrfScore: candidate.rrfScore }),
    bm25: lexicalScore > 0
      ? [{
          channel: "morph",
          field: "body",
          fieldId: POSITIONAL_FIELD_ID.body,
          term: "shared",
          frequency: 1,
          documentFrequency: 2,
          documentCount: 3,
          fieldLength: 1,
          averageFieldLength: 1,
          score: lexicalScore
        }]
      : [],
    phrasePositions: [],
    proximity: [],
    rarity: {
      matchedWeightedTerms: 0,
      totalWeightedTerms: 0,
      score: 0
    },
    coverage: {
      terms: 0,
      fieldScore: 0,
      matched: []
    },
    identity: {
      exactPriority: null,
      phrasePriority: null
    },
    tags: []
  };
}

async function buildSnapshotWithHigherId(vault, analyzer, baseSnapshotId) {
  for (let nonce = 0; nonce < 128; nonce += 1) {
    writeVaultFile(vault, "Query.md", `[[Beta]]\nnonce ${nonce}\n`);
    writeVaultFile(vault, "Beta.md", `# Beta\n\nbeta ${nonce}\n`);
    const built = await buildCanonicalSearchSnapshot({
      vaultRoot: vault,
      analyzer,
      partitionBits: 1,
      searchSettings: { ngram: false }
    });
    if (built.snapshotId > baseSnapshotId) return built;
  }
  throw new Error("failed to build a lexicographically newer snapshot fixture");
}

test("AC2 P3 link graph sidecar hash/load/view accessors are deterministic", async () => {
  const vault = tempRoot();
  writeVaultFile(vault, "Index.md", [
    "Links [[folder/Target#Section]]",
    "Alias [[AliasTarget|Alias]]",
    "Markdown [Markdown Target](docs/Markdown Target.md)",
    "Embed ![[Embeds/Card]]"
  ].join("\n"));
  writeVaultFile(vault, "folder/Target.md", "# Target\n");
  writeVaultFile(vault, "AliasTarget.md", "# Alias Target\n");
  writeVaultFile(vault, "docs/Markdown Target.md", "# Markdown Target\n");
  writeVaultFile(vault, "Embeds/Card.md", "# Card\n");

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: { ngram: false }
  });
  const sidecar = buildLinkGraphSidecar({
    corpusSnapshotId: built.corpusSnapshotId,
    edges: built.linkEdges
  });
  assert.equal(built.linkGraphId, sidecar.linkGraphId);
  assert.equal(
    sidecar.linkGraphId,
    computeLinkGraphId(built.corpusSnapshotId, sidecar.resolverVersion, built.linkEdges)
  );
  assert.deepEqual(
    sidecar.edges.map((edge) => [edge.sourcePath, edge.targetPath]),
    [
      ["Index.md", "AliasTarget.md"],
      ["Index.md", "Embeds/Card.md"],
      ["Index.md", "docs/Markdown Target.md"],
      ["Index.md", "folder/Target.md"]
    ]
  );
  assert.deepEqual(
    sidecar.backlinks.map((edge) => [edge.targetPath, edge.sourcePath]),
    [
      ["AliasTarget.md", "Index.md"],
      ["Embeds/Card.md", "Index.md"],
      ["docs/Markdown Target.md", "Index.md"],
      ["folder/Target.md", "Index.md"]
    ]
  );

  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const paths = searchStoreCachePaths(vault, env);
  await storeLinkGraphSidecar(paths, sidecar);
  const loaded = loadLinkGraphSidecar(paths, sidecar.linkGraphId);
  assert.deepEqual(loaded, sidecar);

  const view = loadLinkGraphView(paths, sidecar.linkGraphId);
  assert.ok(view);
  const indexId = sha256Text("Index.md");
  const targetId = sha256Text("folder/Target.md");
  assert.deepEqual(view.outlinks(indexId).map((edge) => edge.targetPath), [
    "AliasTarget.md",
    "Embeds/Card.md",
    "docs/Markdown Target.md",
    "folder/Target.md"
  ]);
  assert.deepEqual(view.inlinks(targetId).map((edge) => edge.sourcePath), ["Index.md"]);
  assert.deepEqual(view.neighbors(indexId).map((neighbor) => neighbor.path), [
    "AliasTarget.md",
    "Embeds/Card.md",
    "docs/Markdown Target.md",
    "folder/Target.md"
  ]);

  const store = createDaemonSnapshotStore({
    env,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: { ngram: false },
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async () => built
  });
  const loadedVault = await store.loadVault(vault);
  assert.equal(loadedVault.snapshotId, built.snapshotId);
  const pin = await store.pin(vault, built.snapshotId);
  try {
    assert.equal(pin.view.linkGraphId, sidecar.linkGraphId);
    assert.deepEqual(pin.view.outlinks(indexId).map((edge) => edge.targetPath), view.outlinks(indexId).map((edge) => edge.targetPath));
    assert.deepEqual(pin.view.inlinks(targetId).map((edge) => edge.sourcePath), ["Index.md"]);
    assert.deepEqual(pin.view.neighbors(indexId).map((neighbor) => neighbor.documentId), view.neighbors(indexId).map((neighbor) => neighbor.documentId));
  } finally {
    store.release(pin);
  }
});

test("AC2 P3 link graph GC roots protect active in-flight loaded retained and collect orphans", async () => {
  const analyzer = testAnalyzer();
  const vault = tempRoot();
  writeVaultFile(vault, "Query.md", "[[Alpha]]\n");
  writeVaultFile(vault, "Alpha.md", "# Alpha\n\nalpha\n");
  const builtA = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
    searchSettings: { ngram: false }
  });
  const builtB = await buildSnapshotWithHigherId(vault, analyzer, builtA.snapshotId);

  const cacheRoot = tempRoot();
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };
  const paths = searchStoreCachePaths(vault, env);
  let buildIndex = 0;
  let inFlightSweepRan = false;
  let store;
  store = createDaemonSnapshotStore({
    env,
    analyzer,
    partitionBits: 1,
    searchSettings: { ngram: false },
    retentionCount: 1,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async () => {
      buildIndex += 1;
      return buildIndex === 1 ? builtA : builtB;
    },
    durableRenameLinkGraph: async (from, to) => {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.rename(from, to);
      if (path.basename(to) === builtB.linkGraphId) {
        store.markSweepGc(paths);
        assert.equal(fs.existsSync(to), true, "in-flight link graph was collected during publish");
        inFlightSweepRan = true;
      }
    }
  });

  await store.loadVault(vault);
  const pinA = await store.pin(vault, builtA.snapshotId);
  await store.rebuild(vault);
  assert.equal(inFlightSweepRan, true);
  assert.equal(fs.existsSync(linkGraphSidecarPath(paths, builtB.linkGraphId)), true, "active link graph must survive GC");
  assert.equal(fs.existsSync(linkGraphSidecarPath(paths, builtA.linkGraphId)), true, "loaded link graph must survive GC");

  const orphan = buildLinkGraphSidecar({
    corpusSnapshotId: "f".repeat(64),
    edges: [{
      sourcePath: "Orphan.md",
      targetPath: "Nowhere.md",
      sourceDocumentId: sha256Text("Orphan.md"),
      targetDocumentId: sha256Text("Nowhere.md")
    }]
  });
  await storeLinkGraphSidecar(paths, orphan);
  assert.equal(fs.existsSync(linkGraphSidecarPath(paths, orphan.linkGraphId)), true);
  store.markSweepGc(paths);
  await eventually(() => {
    assert.equal(fs.existsSync(linkGraphSidecarPath(paths, orphan.linkGraphId)), false, "orphan link graph must be collected");
  });

  const releaseOrphan = buildLinkGraphSidecar({
    corpusSnapshotId: "e".repeat(64),
    edges: [{
      sourcePath: "ReleaseOrphan.md",
      targetPath: "Nowhere.md",
      sourceDocumentId: sha256Text("ReleaseOrphan.md"),
      targetDocumentId: sha256Text("Nowhere.md")
    }]
  });
  await storeLinkGraphSidecar(paths, releaseOrphan);
  store.release(pinA);
  store.markSweepGc(paths);
  await eventually(() => {
    assert.equal(fs.existsSync(linkGraphSidecarPath(paths, releaseOrphan.linkGraphId)), false, "release orphan link graph must be collected");
  });
  assert.equal(fs.existsSync(linkGraphSidecarPath(paths, builtA.linkGraphId)), true, "loaded link graph remains protected after pin release");

  const retainedCacheRoot = tempRoot();
  const retainedEnv = { ...process.env, XDG_CACHE_HOME: retainedCacheRoot };
  const retainedPaths = searchStoreCachePaths(vault, retainedEnv);
  let retainedBuildIndex = 0;
  const retainedStore = createDaemonSnapshotStore({
    env: retainedEnv,
    analyzer,
    partitionBits: 1,
    searchSettings: { ngram: false },
    retentionCount: 2,
    embeddingSetBuilder: createDeterministicEmbeddingSetBuilder(),
    snapshotBuilder: async () => {
      retainedBuildIndex += 1;
      return retainedBuildIndex === 1 ? builtA : builtB;
    }
  });
  await retainedStore.loadVault(vault);
  await retainedStore.rebuild(vault);
  const retainedOrphan = buildLinkGraphSidecar({
    corpusSnapshotId: "d".repeat(64),
    edges: [{
      sourcePath: "RetainedOrphan.md",
      targetPath: "Nowhere.md",
      sourceDocumentId: sha256Text("RetainedOrphan.md"),
      targetDocumentId: sha256Text("Nowhere.md")
    }]
  });
  await storeLinkGraphSidecar(retainedPaths, retainedOrphan);
  retainedStore.markSweepGc(retainedPaths);
  await eventually(() => {
    assert.equal(fs.existsSync(linkGraphSidecarPath(retainedPaths, retainedOrphan.linkGraphId)), false, "retained-store orphan link graph must be collected");
  });
  assert.equal(fs.existsSync(linkGraphSidecarPath(retainedPaths, builtA.linkGraphId)), true, "retained link graph must survive GC");
  assert.equal(fs.existsSync(linkGraphSidecarPath(retainedPaths, builtB.linkGraphId)), true, "active retained-store link graph must survive GC");
});

test("AC4 P3 link adjacency retriever propagates linkAgreement through fusion features and rerankScore", async () => {
  const vault = tempRoot();
  writeVaultFile(vault, "Query.md", "[[Linked]]\n");
  writeVaultFile(vault, "Linked.md", "shared\n");
  writeVaultFile(vault, "A-Unlinked.md", "shared\n");

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: { ngram: false }
  });
  const linkGraph = createLinkGraphView(buildLinkGraphSidecar({
    corpusSnapshotId: built.corpusSnapshotId,
    edges: built.linkEdges
  }));
  const snapshot = searchSnapshotFromBuilt(built, linkGraph);
  const query = {
    rawQuery: "shared",
    analysis: queryAnalysis("shared"),
    snapshotId: built.snapshotId,
    sourcePath: "Query.md",
    limit: 3
  };
  const lexicalRetriever = createPositionalRetriever(snapshot);
  const linkRetriever = createLinkAdjacencyRetriever({ snapshot, linkGraph });
  const lexical = await lexicalRetriever.retrieve(query);
  assert.deepEqual(
    lexical.candidates.filter((candidate) => candidate.path === "Linked.md" || candidate.path === "A-Unlinked.md").map((candidate) => candidate.path).sort(),
    ["A-Unlinked.md", "Linked.md"]
  );

  const fused = await retrieveWithFusion([lexicalRetriever, linkRetriever], query, { limit: 3 });
  assert.equal(fused.retrieverIdentity.id, "fusion");
  assert.equal(fused.candidates[0].path, "Linked.md");
  const linked = fused.candidates.find((candidate) => candidate.path === "Linked.md");
  const unlinked = fused.candidates.find((candidate) => candidate.path === "A-Unlinked.md");
  assert.ok(linked);
  assert.ok(unlinked);
  assert.equal(linked.retrieverSignals?.link?.rank, 1);
  assert.equal(linked.linkAgreement, 1);
  assert.equal(unlinked.linkAgreement ?? 0, 0);

  const features = [
    featurePayload(linked, 1),
    featurePayload(unlinked, 1)
  ];
  const signals = rankSignalsFromFeatures(features, 0);
  const linkedSignals = signals.get(linked.documentId);
  const unlinkedSignals = signals.get(unlinked.documentId);
  assert.ok(linkedSignals);
  assert.ok(unlinkedSignals);
  assert.equal(linkedSignals.linkAgreement, 1);
  assert.equal(unlinkedSignals.linkAgreement, 0);
  assert.ok(linkedSignals.rrfScore > 0);

  const ranked = rerankCandidatesWithSignals(
    "shared",
    [],
    [
      { document: { id: unlinked.documentId, path: unlinked.path, title: "A-Unlinked", tags: [] }, score: unlinked.retrievalScore },
      { document: { id: linked.documentId, path: linked.path, title: "Linked", tags: [] }, score: linked.retrievalScore }
    ],
    undefined,
    signals
  );
  assert.equal(ranked[0].path, "Linked.md");
  assert.equal(ranked[0].score, rerankScore(ranked[0]));
  assert.ok(rerankScore({ ...ranked[0], linkAgreement: 0 }) < ranked[0].score);
});
