#!/usr/bin/env node

const DEFAULT_DENSE_LAMBDAS = [0.15, 0.25, 0.35];
const DEFAULT_LINK_LAMBDAS = [0.1, 0.2, 0.3];
const DEFAULT_RRF_K = [30, 60, 90];

const fixtures = [
  {
    query: 'hangul semantic neighbor',
    relevant: 'neighbor-note',
    candidates: [
      { id: 'neighbor-note', lexical: 0.2, dense: 0.93, link: 1, ranks: { lexical: 4, dense: 1, link: 1 } },
      { id: 'literal-note', lexical: 1.4, dense: 0.35, link: 0, ranks: { lexical: 1, dense: 3 } },
      { id: 'archive-note', lexical: 0.1, dense: 0.22, link: 0, ranks: { lexical: 5, dense: 5 } },
    ],
  },
  {
    query: 'lexical exact neighbor',
    relevant: 'exact-note',
    candidates: [
      { id: 'exact-note', lexical: 1.8, dense: 0.62, link: 0.5, ranks: { lexical: 1, dense: 2, link: 2 } },
      { id: 'semantic-note', lexical: 0.2, dense: 0.95, link: 0, ranks: { lexical: 4, dense: 1 } },
      { id: 'linked-note', lexical: 0.1, dense: 0.3, link: 1, ranks: { lexical: 5, dense: 5, link: 1 } },
    ],
  },
  {
    query: 'link adjacency neighbor',
    relevant: 'linked-note',
    candidates: [
      { id: 'linked-note', lexical: 0.6, dense: 0.58, link: 1, ranks: { lexical: 2, dense: 2, link: 1 } },
      { id: 'lexical-note', lexical: 1.0, dense: 0.4, link: 0, ranks: { lexical: 1, dense: 4 } },
      { id: 'far-note', lexical: 0.1, dense: 0.2, link: 0, ranks: { lexical: 5, dense: 5 } },
    ],
  },
];

const denseLambdas = listEnv('OPTSIDIAN_TUNE_DENSE_LAMBDAS', DEFAULT_DENSE_LAMBDAS);
const linkLambdas = listEnv('OPTSIDIAN_TUNE_LINK_LAMBDAS', DEFAULT_LINK_LAMBDAS);
const rrfKs = listEnv('OPTSIDIAN_TUNE_RRF_K', DEFAULT_RRF_K);

const runs = [];
for (const denseLambda of denseLambdas) {
  for (const linkLambda of linkLambdas) {
    for (const rrfK of rrfKs) {
      runs.push(evaluate({ denseLambda, linkLambda, rrfK }));
    }
  }
}

runs.sort((left, right) => right.mrr - left.mrr || right.recallAt1 - left.recallAt1 || left.rrfK - right.rrfK);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      note: 'Fixture tuning is empirical; this script reports relative scores and never enforces an absolute gate.',
      fixtures: fixtures.length,
      best: runs[0],
      runs,
    },
    null,
    2,
  ),
);

function evaluate(config) {
  let reciprocalRankSum = 0;
  let recallAt1 = 0;
  for (const fixture of fixtures) {
    const ranked = fixture.candidates
      .map((candidate) => ({
        id: candidate.id,
        score:
          candidate.lexical +
          config.denseLambda * candidate.dense +
          config.linkLambda * candidate.link +
          rrf(candidate.ranks.lexical, config.rrfK) +
          rrf(candidate.ranks.dense, config.rrfK) +
          rrf(candidate.ranks.link, config.rrfK),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const rank = ranked.findIndex((candidate) => candidate.id === fixture.relevant) + 1;
    reciprocalRankSum += rank > 0 ? 1 / rank : 0;
    if (rank === 1) recallAt1 += 1;
  }
  return {
    ...config,
    mrr: Number((reciprocalRankSum / fixtures.length).toFixed(6)),
    recallAt1: Number((recallAt1 / fixtures.length).toFixed(6)),
  };
}

function rrf(rank, k) {
  return rank === undefined ? 0 : 1 / (k + rank);
}

function listEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values : fallback;
}
