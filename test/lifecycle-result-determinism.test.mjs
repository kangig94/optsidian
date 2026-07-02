import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveSearchRuntimeProfile,
  lexicalIdentityHashForSearchRuntimeProfile,
} from "../src/daemon/runtime-profile.ts";
import { computeRetrievalSnapshotId } from "../src/daemon/search-store/snapshot-store.ts";
import {
  DaemonSearchStoreService,
  rankingTuningHash
} from "../src/daemon/search-store/service.ts";

test("AC11 ranking tuning changes query identity only, never lexical or retrieval identity", () => {
  const baseProfile = effectiveSearchRuntimeProfile(process.cwd(), {
    ...process.env,
    OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: "deterministic-hash",
    OPTSIDIAN_SEARCH_NGRAM: "0"
  });
  const tunedProfile = {
    ...baseProfile,
    ranking: { rrfK: 17, denseLambda: 4, linkLambda: 5 }
  };
  assert.equal(
    lexicalIdentityHashForSearchRuntimeProfile(baseProfile),
    lexicalIdentityHashForSearchRuntimeProfile(tunedProfile)
  );

  const retrievalSnapshotId = computeRetrievalSnapshotId({
    corpusSnapshotId: "corpus-a",
    linkGraphId: "link-a",
    embeddingSetId: "embedding-a",
    retrieverPlanIdentity: "plan-a",
    rankingFeatureVersion: "ranking-features-v1"
  });
  assert.equal(
    computeRetrievalSnapshotId({
      corpusSnapshotId: "corpus-a",
      linkGraphId: "link-a",
      embeddingSetId: "embedding-a",
      retrieverPlanIdentity: "plan-a",
      rankingFeatureVersion: "ranking-features-v1"
    }),
    retrievalSnapshotId
  );

  const settings = { search: { rrfK: 40, denseLambda: 9, linkLambda: 10 } };
  const env = {
    OPTSIDIAN_SEARCH_RRF_K: "23",
    OPTSIDIAN_SEARCH_DENSE_LAMBDA: "7.5",
    OPTSIDIAN_SEARCH_LINK_LAMBDA: "2.5"
  };
  const settingsIdentity = service({ settings, env: {} }).resultIdentityForQuery(queryIdentityInput());
  assert.equal(settingsIdentity.rankingTuningHash, rankingTuningHash({
    rrfK: 40,
    lambdas: { dense: 9, link: 10 }
  }));

  const envIdentity = service({ settings, env }).resultIdentityForQuery(queryIdentityInput());
  assert.equal(envIdentity.rankingTuningHash, rankingTuningHash({
    rrfK: 23,
    lambdas: { dense: 7.5, link: 2.5 }
  }));
  assert.notEqual(envIdentity.rankingTuningHash, settingsIdentity.rankingTuningHash);

  const overrideIdentity = service({
    settings,
    env,
    rankingTuning: { rrfK: 11, lambdas: { dense: 5, link: 6 } }
  }).resultIdentityForQuery(queryIdentityInput());
  assert.equal(overrideIdentity.rankingTuningHash, rankingTuningHash({
    rrfK: 11,
    lambdas: { dense: 5, link: 6 }
  }));
  assert.notEqual(overrideIdentity.rankingTuningHash, envIdentity.rankingTuningHash);

  assert.deepEqual(
    stripTuning(overrideIdentity),
    stripTuning(envIdentity),
    "ranking tuning hash is the only per-query identity field changed by tuning"
  );
});

function service(options = {}) {
  return new DaemonSearchStoreService(
    {},
    {},
    {},
    {},
    { queryCacheSize: 1, searchSettings: { ngram: false }, ...options }
  );
}

function queryIdentityInput() {
  return {
    snapshotId: "snapshot-a",
    query: "alpha",
    filters: { path: "Projects" },
    limit: 10,
    rankingVersion: "ranking-v1",
    analyzerIdentity: { name: "test-analyzer", version: "1", node: "test" }
  };
}

function stripTuning(identity) {
  const { rankingTuningHash: _rankingTuningHash, ...rest } = identity;
  return rest;
}
