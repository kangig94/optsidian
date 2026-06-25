import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function testAnalyzer() {
  const tokenize = (text) =>
    [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map(
      (match) => match[0]
    );
  return {
    identity: {
      name: "test-analyzer",
      version: "1",
      node: "test"
    },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text))
  };
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempRoot(prefix = "optsidian-search-long-doc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function futureImport(relativePath) {
  return import(path.join(repoRoot, relativePath));
}

function sharedHandle(bytes) {
  const buffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    buffer,
    byteOffset: 0,
    byteLength: bytes.byteLength
  };
}

test("snapshot build samples oversize body and snippet analysis before tokenization", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const {
    BODY_FULL_ANALYSIS_MAX_CHARS,
    BODY_LEXICAL_SAMPLE_MAX_CHARS,
    SNIPPET_DOC_ANALYZED_LINES_MAX
  } = await futureImport("src/core/search/analysis/budget.ts");
  const vault = tempRoot();
  const lines = Array.from({ length: SNIPPET_DOC_ANALYZED_LINES_MAX + 200 }, (_, index) =>
    `line-${index} ${"가".repeat(200)}`
  );
  const body = `${lines.join("\n")}\n${"나".repeat(BODY_FULL_ANALYSIS_MAX_CHARS)}\n`;
  writeVaultFile(vault, "Long.md", `# Long\n\n${body}`);
  const tokenizedTexts = [];
  const analyzer = {
    ...testAnalyzer(),
    tokenizeBatch: async (texts) => {
      tokenizedTexts.push(...texts);
      return texts.map((text) =>
        [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu)].map(
          (match) => match[0]
        )
      );
    }
  };

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const record = built.diagnostics.documents[0];

  assert.match(record.searchDocument.body, /^# Long\n\nline-0 /);
  assert.ok(record.searchDocument.body.includes("line-3199"));
  assert.ok(tokenizedTexts[5].length <= BODY_LEXICAL_SAMPLE_MAX_CHARS);
  assert.ok(record.snippetLines.length <= SNIPPET_DOC_ANALYZED_LINES_MAX);
  assert.ok(record.snippetLines.some((line) => line.line >= 3202));
});

test("long document snippets exclude frontmatter even when snippet lines are sampled", async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport("src/daemon/search-store/builder.ts");
  const { executeSearchJob } = await futureImport("src/daemon/search-execution.ts");
  const { normalizeSearchParams } = await futureImport("src/core/search/params.ts");
  const marker = "frontmatteronlymarker";
  const vault = tempRoot();
  const bodyLines = Array.from({ length: 10000 }, (_, index) =>
    index === 0 ? "# Visible Heading" : `body line ${index} ${"x".repeat(80)}`
  );
  writeVaultFile(vault, "Long.md", [
    "---",
    "aliases:",
    `  - ${marker}`,
    "tags: [sampled-frontmatter]",
    "---",
    "",
    ...bodyLines
  ].join("\n"));
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1
  });
  const snapshot = {
    snapshotId: built.snapshotId,
    pinToken: "pin-long-doc",
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.diagnostics.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      bytes: sharedHandle(segment.bytes)
    }))
  };

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: marker, limit: 1 }),
    analysis: {
      raw: marker,
      primaryChannel: "morph",
      primaryTerms: [marker],
      channels: {
        morph: [marker],
        surface: [marker],
        ngram: []
      }
    },
    analyzerIdentity: analyzer.identity,
    snapshot
  });

  assert.equal(result.matches[0]?.path, "Long.md");
  assert.deepEqual(result.matches[0]?.snippets.map((snippet) => snippet.text), ["# Visible Heading"]);
});
