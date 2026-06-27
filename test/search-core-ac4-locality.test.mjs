import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function searchDocument(overrides = {}) {
  return {
    id: overrides.path ?? "note.md",
    path: overrides.path ?? "note.md",
    title: overrides.title ?? "Test Note",
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    headings: overrides.headings ?? [],
    body: overrides.body ?? "",
    pathTokens: "",
    titleTokens: "",
    aliasesTokens: "",
    tagsTokens: "",
    headingsTokens: "",
    bodyTokens: "",
    pathSurfaceTokens: "",
    titleSurfaceTokens: "",
    aliasesSurfaceTokens: "",
    tagsSurfaceTokens: "",
    headingsSurfaceTokens: "",
    bodySurfaceTokens: "",
    pathNgramTokens: "",
    titleNgramTokens: "",
    aliasesNgramTokens: "",
    tagsNgramTokens: "",
    headingsNgramTokens: "",
    bodyNgramTokens: "",
    ...overrides
  };
}

test("AC4 score is bitwise-identical regardless of candidate set size or ordering", async () => {
  const { rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/score.ts"));
  const queryChannels = { morph: ["needle"], surface: ["needle"], ngram: [] };
  const target = searchDocument({ path: "Target.md", title: "Target" });
  const decoyA = searchDocument({ path: "Decoy-A.md", title: "Decoy A" });
  const decoyB = searchDocument({ path: "Decoy-B.md", title: "Decoy B" });
  const decoyC = searchDocument({ path: "Decoy-C.md", title: "Decoy C" });
  const targetSignal = {
    lexicalScore: 12.5,
    identityScore: 1,
    exactPriority: 2,
    exactLambda: 100,
    denseAgreement: 0,
    rarityScore: 0,
    proximityScore: 2,
    bodyScore: 0
  };
  const signals = new Map([
    ["Target.md", targetSignal],
    ["Decoy-A.md", { lexicalScore: 4, identityScore: 0, exactLambda: 100, denseAgreement: 0, rarityScore: 0, proximityScore: 0, bodyScore: 0 }],
    ["Decoy-B.md", { lexicalScore: 8, identityScore: 0, exactLambda: 100, denseAgreement: 0, rarityScore: 0, proximityScore: 1, bodyScore: 0 }],
    ["Decoy-C.md", { lexicalScore: 1, identityScore: 0, exactLambda: 100, denseAgreement: 0, rarityScore: 0, proximityScore: 0, bodyScore: 0 }]
  ]);

  const scoreIn = (documents) => {
    const ranked = rerankCandidatesWithSignals(
      "needle",
      ["needle"],
      documents.map((document, index) => ({ document, score: 1000 - index, queryChannels })),
      undefined,
      signals
    );
    const targetRank = ranked.find((candidate) => candidate.path === "Target.md");
    assert.ok(targetRank);
    return targetRank.score;
  };

  const alone = scoreIn([target]);
  const pair = scoreIn([decoyA, target]);
  const larger = scoreIn([decoyB, target, decoyA, decoyC]);
  const reordered = scoreIn([decoyC, decoyA, target, decoyB]);

  assert.equal(Object.is(alone, pair), true);
  assert.equal(Object.is(alone, larger), true);
  assert.equal(Object.is(alone, reordered), true);
});

test("AC4 BM25Plus field score matches hand-computed vector and feeds unified lexical score", async () => {
  const { bm25TermScoreFromGlobalStats } = await import(path.join(repoRoot, "src/core/search/retrieval/positional/snapshot.ts"));
  const { POSITIONAL_FIELD_ID } = await import(path.join(repoRoot, "src/core/search/retrieval/positional/types.ts"));
  const { SEARCH_BM25_B, SEARCH_BM25_D, SEARCH_BM25_K1, SEARCH_TOKEN_CHANNEL_WEIGHT } = await import(path.join(repoRoot, "src/core/search/constants.ts"));
  const { SEARCH_FIELD_CHANNEL_BOOST } = await import(path.join(repoRoot, "src/core/search/schema.ts"));
  const { rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/score.ts"));
  const fieldId = POSITIONAL_FIELD_ID.title;
  const stats = {
    schemaId: 1,
    corpusStats: [
      { channel: "morph", fieldId, documentCount: 2, totalFieldLength: 5, averageFieldLength: 2.5 }
    ],
    rows: [
      { channel: "morph", fieldId, term: "alpha", documentFrequency: 1 }
    ],
    hash: "fixture"
  };

  const tfNorm = 3 / 4;
  const idf = Math.log((2 - 1 + 0.5) / (1 + 0.5) + 1);
  const denominator = tfNorm + SEARCH_BM25_K1 * (1 - SEARCH_BM25_B + (SEARCH_BM25_B * 4) / 2.5);
  const expectedBm25 = (idf * (SEARCH_BM25_D + tfNorm * (SEARCH_BM25_K1 + 1))) / denominator;
  const actualBm25 = bm25TermScoreFromGlobalStats(stats, "morph", "alpha", fieldId, 3, 4);
  assert.equal(actualBm25, expectedBm25);

  const lexicalScore = actualBm25 * SEARCH_TOKEN_CHANNEL_WEIGHT.morph * SEARCH_FIELD_CHANNEL_BOOST.morph.title;
  const document = searchDocument({ path: "Alpha.md", title: "Alpha" });
  const ranked = rerankCandidatesWithSignals(
    "alpha",
    ["alpha"],
    [{ document, score: 0, queryChannels: { morph: ["alpha"], surface: [], ngram: [] } }],
    ["title"],
    new Map([
      ["Alpha.md", {
        lexicalScore,
        identityScore: 0,
        exactLambda: 0,
        denseAgreement: 0,
        rarityScore: 0,
        proximityScore: 0,
        bodyScore: 0
      }]
    ])
  );
  assert.equal(ranked[0].score, lexicalScore);
});

test("AC4 exact-priority lambda dominates max-term multi-channel body stuffing", async () => {
  const {
    MAX_SEARCH_QUERY_TERMS_PER_CHANNEL,
    SEARCH_SCORING_LAMBDAS
  } = await import(path.join(repoRoot, "src/core/search/constants.ts"));
  const { SEARCH_TOKEN_CHANNELS } = await import(path.join(repoRoot, "src/core/search/analysis/index.ts"));
  const { SEARCH_PROPERTIES } = await import(path.join(repoRoot, "src/core/search/schema.ts"));
  const { bm25BoundKey, exactDominanceLambda, rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/score.ts"));
  const bounds = new Map();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const field of SEARCH_PROPERTIES) bounds.set(bm25BoundKey(channel, field), 1);
  }
  const channelTermCounts = Object.fromEntries(
    SEARCH_TOKEN_CHANNELS.map((channel) => [channel, MAX_SEARCH_QUERY_TERMS_PER_CHANNEL])
  );
  const bound = exactDominanceLambda({
    channelTermCounts,
    fields: SEARCH_PROPERTIES,
    bm25SingleTermBounds: bounds
  });
  const stuffedScore = bound.lexicalBound + SEARCH_SCORING_LAMBDAS.phrase * bound.proximityBound;
  assert.ok(bound.lambdaExact > stuffedScore);

  const queryChannels = Object.fromEntries(
    SEARCH_TOKEN_CHANNELS.map((channel) => [
      channel,
      Array.from({ length: MAX_SEARCH_QUERY_TERMS_PER_CHANNEL }, (_, index) => `${channel}-${index}`)
    ])
  );
  const exactTitle = searchDocument({ path: "Title.md", title: "Needle" });
  const exactAlias = searchDocument({ path: "Alias.md", aliases: ["Needle"] });
  const exactPath = searchDocument({ path: "Needle.md" });
  const stuffed = searchDocument({ path: "Stuffed.md", body: "max-term body stuffed fixture" });
  const baseSignal = {
    exactLambda: bound.lambdaExact,
    denseAgreement: 0,
    rarityScore: 0,
    bodyScore: 0
  };
  const ranked = rerankCandidatesWithSignals(
    "needle",
    ["needle"],
    [
      { document: stuffed, score: 0, queryChannels },
      { document: exactPath, score: 0, queryChannels },
      { document: exactAlias, score: 0, queryChannels },
      { document: exactTitle, score: 0, queryChannels }
    ],
    undefined,
    new Map([
      ["Stuffed.md", { ...baseSignal, lexicalScore: bound.lexicalBound, identityScore: 0, proximityScore: bound.proximityBound }],
      ["Needle.md", { ...baseSignal, lexicalScore: 0, identityScore: 1, exactPriority: 2, proximityScore: 0 }],
      ["Alias.md", { ...baseSignal, lexicalScore: 0, identityScore: 2, exactPriority: 1, proximityScore: 0 }],
      ["Title.md", { ...baseSignal, lexicalScore: 0, identityScore: 3, exactPriority: 0, proximityScore: 0 }]
    ])
  );

  assert.deepEqual(ranked.map((candidate) => candidate.path), [
    "Title.md",
    "Alias.md",
    "Needle.md",
    "Stuffed.md"
  ]);
});
