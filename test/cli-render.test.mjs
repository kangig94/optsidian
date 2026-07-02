import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSearch,
  renderSimilarity
} from "../src/cli/render.ts";

const FRESH_DENSE = {
  state: "fresh",
  pendingCount: 0,
  generationAgeMs: 1240
};

const COLD_DENSE = {
  state: "cold",
  pendingCount: 3,
  generationAgeMs: null
};

function searchMatch(overrides = {}) {
  return {
    path: "Projects/Alpha.md",
    title: "Alpha",
    tags: ["project"],
    snippets: [{ line: 3, text: "alpha project handoff" }],
    ...overrides
  };
}

function similarityResult(overrides = {}) {
  return {
    path: "Projects/Beta.md",
    title: "Beta",
    score: 0.875,
    tags: ["project"],
    snippets: [{ line: 4, text: "beta project neighbor" }],
    ...overrides
  };
}

function baseSimilarity(overrides = {}) {
  return {
    ok: true,
    command: "similarity",
    schemaVersion: 1,
    available: true,
    status: "ready",
    origin: "text",
    request: {
      mode: "left",
      left: { text: "project handoff" },
      topK: 10,
      minScore: 0,
      format: "text"
    },
    results: [],
    matches: [],
    ...overrides
  };
}

test("renderSearch prints and preserves dense signal for ready, not-ready, and empty results", () => {
  const ready = {
    ok: true,
    command: "search",
    schemaVersion: 1,
    available: true,
    status: "ready",
    dense: FRESH_DENSE,
    matches: [searchMatch()]
  };
  assert.equal(
    renderSearch(ready, "text"),
    [
      "dense: state=fresh pending=0 generationAge=1240ms",
      "",
      "1. Projects/Alpha.md",
      "title: Alpha",
      "tags: project",
      "snippets:",
      "  3 | alpha project handoff",
      ""
    ].join("\n")
  );
  assert.deepEqual(JSON.parse(renderSearch(ready, "json")).dense, FRESH_DENSE);

  const notReady = {
    ok: true,
    command: "search",
    schemaVersion: 1,
    available: false,
    status: "index-not-ready",
    dense: COLD_DENSE,
    matches: []
  };
  assert.equal(
    renderSearch(notReady, "text"),
    "Search index not ready.\ndense: state=cold pending=3 generationAge=null\n"
  );
  assert.deepEqual(JSON.parse(renderSearch(notReady, "json")).dense, COLD_DENSE);

  const empty = {
    ok: true,
    command: "search",
    schemaVersion: 1,
    available: true,
    status: "ready",
    dense: COLD_DENSE,
    matches: []
  };
  assert.equal(
    renderSearch(empty, "text"),
    "dense: state=cold pending=3 generationAge=null\nNo matches found.\n"
  );
  assert.deepEqual(JSON.parse(renderSearch(empty, "json")).dense, COLD_DENSE);
});

test("renderSimilarity prints and preserves dense signal for ready, not-ready, and empty results", () => {
  const ready = baseSimilarity({
    dense: FRESH_DENSE,
    results: [similarityResult()],
    matches: [searchMatch({ path: "Projects/Beta.md", title: "Beta" })]
  });
  assert.equal(
    renderSimilarity(ready, "text"),
    [
      "dense: state=fresh pending=0 generationAge=1240ms",
      "",
      "1. Projects/Beta.md",
      "score: 0.875",
      "title: Beta",
      "tags: project",
      "snippets:",
      "  4 | beta project neighbor",
      ""
    ].join("\n")
  );
  assert.deepEqual(JSON.parse(renderSimilarity(ready, "json")).dense, FRESH_DENSE);

  const notReady = baseSimilarity({
    available: false,
    status: "index-not-ready",
    reason: "source-vector-missing",
    dense: COLD_DENSE
  });
  assert.equal(
    renderSimilarity(notReady, "text"),
    "Similarity index not ready: source-vector-missing.\ndense: state=cold pending=3 generationAge=null\n"
  );
  assert.deepEqual(JSON.parse(renderSimilarity(notReady, "json")).dense, COLD_DENSE);

  const empty = baseSimilarity({
    dense: COLD_DENSE,
    results: []
  });
  assert.equal(
    renderSimilarity(empty, "text"),
    "dense: state=cold pending=3 generationAge=null\nNo similar notes found.\n"
  );
  assert.deepEqual(JSON.parse(renderSimilarity(empty, "json")).dense, COLD_DENSE);
});
