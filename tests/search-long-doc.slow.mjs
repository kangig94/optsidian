import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: {
      name: 'test-analyzer',
      version: '1',
      node: 'test',
    },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenize(text)),
  };
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempRoot(prefix = 'optsidian-search-long-doc-') {
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
    byteLength: bytes.byteLength,
  };
}

function bm25StatsFromManifest(manifest) {
  return {
    schemaId: manifest.bm25StatsSchemaId,
    corpusStats: manifest.corpusStats.map((entry) => ({
      ...entry,
      averageFieldLength: entry.documentCount > 0 ? entry.totalFieldLength / entry.documentCount : 0,
    })),
    rows: manifest.bm25GlobalStatsRows.map((row) => ({
      channel: row[0],
      fieldId: row[1],
      term: row[2],
      documentFrequency: row[3],
    })),
    hash: manifest.bm25GlobalStatsHash,
  };
}

function snapshotHandle(built, pinToken = 'pin-long-doc') {
  return {
    snapshotId: built.snapshotId,
    pinToken,
    bm25Stats: bm25StatsFromManifest(built.manifest),
    documents: sharedHandle(new TextEncoder().encode(JSON.stringify(built.documents))),
    segments: built.segments.map((segment) => ({
      segmentId: segment.hash,
      partitionId: segment.partitionId,
      bytes: sharedHandle(segment.bytes),
    })),
  };
}

function evenSampledLineNumbers(length, maxCount) {
  if (length <= maxCount) return new Set(Array.from({ length }, (_, index) => index + 1));
  const sampled = new Set();
  for (let index = 0; index < maxCount; index += 1) {
    sampled.add(Math.round(((length - 1) * index) / (maxCount - 1)) + 1);
  }
  return sampled;
}

test('snapshot build samples oversize body and snippet analysis before tokenization', async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport('src/daemon/search-store/builder.ts');
  const { BODY_FULL_ANALYSIS_MAX_CHARS, BODY_LEXICAL_SAMPLE_MAX_CHARS, SNIPPET_DOC_ANALYZED_LINES_MAX } =
    await futureImport('src/core/search/analysis/budget.ts');
  const vault = tempRoot();
  const lines = Array.from(
    { length: SNIPPET_DOC_ANALYZED_LINES_MAX + 200 },
    (_, index) => `line-${index} ${'가'.repeat(200)}`,
  );
  const body = `${lines.join('\n')}\n${'나'.repeat(BODY_FULL_ANALYSIS_MAX_CHARS)}\n`;
  writeVaultFile(vault, 'Long.md', `# Long\n\n${body}`);
  const tokenizedTexts = [];
  const analyzer = {
    ...testAnalyzer(),
    tokenizeBatch: async (texts) => {
      tokenizedTexts.push(...texts);
      return texts.map((text) =>
        [
          ...text
            .normalize('NFKC')
            .toLowerCase()
            .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
        ].map((match) => match[0]),
      );
    },
  };

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const record = built.documents[0];
  const analyzedSnippetLines = record.snippetCorpus.lines.filter((line) =>
    Object.values(line.channels).some((terms) => terms.length > 0),
  );

  assert.equal(record.snippetCorpus.lines[0].text, '# Long');
  assert.ok(record.snippetCorpus.lines.some((line) => line.text.startsWith('line-3199 ')));
  assert.ok(tokenizedTexts[5].length <= BODY_LEXICAL_SAMPLE_MAX_CHARS);
  assert.ok(analyzedSnippetLines.length <= SNIPPET_DOC_ANALYZED_LINES_MAX);
  assert.ok(analyzedSnippetLines.some((line) => line.line >= 3202));
});

test('long document snippets exclude frontmatter even when snippet lines are sampled', async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport('src/daemon/search-store/builder.ts');
  const { executeSearchJob } = await futureImport('src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await futureImport('src/core/search/params.ts');
  const marker = 'frontmatteronlymarker';
  const vault = tempRoot();
  const bodyLines = Array.from({ length: 10000 }, (_, index) =>
    index === 0 ? '# Visible Heading' : `body line ${index} ${'x'.repeat(80)}`,
  );
  writeVaultFile(
    vault,
    'Long.md',
    ['---', 'aliases:', `  - ${marker}`, 'tags: [sampled-frontmatter]', '---', '', ...bodyLines].join('\n'),
  );
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const snapshot = snapshotHandle(built);

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: marker, limit: 1 }),
    analysis: {
      raw: marker,
      primaryChannel: 'morph',
      primaryTerms: [marker],
      channels: {
        morph: [marker],
        surface: [marker],
        ngram: [],
      },
    },
    analyzerIdentity: analyzer.identity,
    snapshot,
  });

  assert.equal(result.matches[0]?.path, 'Long.md');
  assert.deepEqual(
    result.matches[0]?.snippets.map((snippet) => snippet.text),
    ['# Visible Heading'],
  );
});

test('long document snippets fall back to a deep unsampled heading when only frontmatter metadata matches', async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport('src/daemon/search-store/builder.ts');
  const { executeSearchJob } = await futureImport('src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await futureImport('src/core/search/params.ts');
  const { SNIPPET_DOC_ANALYZED_LINES_MAX } = await futureImport('src/core/search/analysis/budget.ts');
  const marker = 'deepfallbackaliasmarker';
  const deepHeading = '# Deep Visible Heading';
  const deepHeadingLine = 4007;
  const firstBodyLine = 7;
  const deepHeadingBodyIndex = deepHeadingLine - firstBodyLine;
  assert.ok(deepHeadingBodyIndex > SNIPPET_DOC_ANALYZED_LINES_MAX);

  const vault = tempRoot();
  const bodyLines = Array.from({ length: 10000 }, (_, index) =>
    index === deepHeadingBodyIndex ? deepHeading : `body filler ${index} ${'x'.repeat(80)}`,
  );
  const sampledLines = evenSampledLineNumbers(6 + bodyLines.length, SNIPPET_DOC_ANALYZED_LINES_MAX);
  assert.equal(sampledLines.has(deepHeadingLine), false);

  writeVaultFile(
    vault,
    'DeepFallback.md',
    ['---', 'aliases:', `  - ${marker}`, 'tags: [deep-fallback]', '---', '', ...bodyLines].join('\n'),
  );
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  const fallbackLine = built.documents[0].snippetCorpus.lines.find((line) => line.line === deepHeadingLine);
  assert.deepEqual(fallbackLine?.channels, { morph: [], surface: [], ngram: [] });

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: marker, limit: 1 }),
    analysis: {
      raw: marker,
      primaryChannel: 'morph',
      primaryTerms: [marker],
      channels: {
        morph: [marker],
        surface: [marker],
        ngram: [],
      },
    },
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built, 'pin-deep-fallback'),
  });

  assert.equal(result.matches[0]?.path, 'DeepFallback.md');
  assert.deepEqual(
    result.matches[0]?.snippets.map((snippet) => ({
      line: snippet.line,
      text: snippet.text,
    })),
    [{ line: deepHeadingLine, text: deepHeading }],
  );
});

test('long document snippets use full frontmatter boundary when closing delimiter is unsampled', async () => {
  const { buildCanonicalSearchSnapshot } = await futureImport('src/daemon/search-store/builder.ts');
  const { executeSearchJob } = await futureImport('src/daemon/search-execution.ts');
  const { normalizeSearchParams } = await futureImport('src/core/search/params.ts');
  const { SNIPPET_DOC_ANALYZED_LINES_MAX } = await futureImport('src/core/search/analysis/budget.ts');
  const marker = 'boundaryaliasmarker';
  const closingLine = 4007;
  const aliasLine = 5;
  const expectedSnippetLine = 4009;
  const expectedSnippetText = '# Boundary Body Heading';

  const frontmatterLines = [
    '---',
    'frontmatter filler 1',
    'frontmatter filler 2',
    'frontmatter filler 3',
    `aliases: [${marker}]`,
  ];
  while (frontmatterLines.length < closingLine - 1) {
    frontmatterLines.push(`frontmatter filler ${frontmatterLines.length}`);
  }
  frontmatterLines.push('---');
  const bodyLines = Array.from({ length: 7000 }, (_, index) => `body boundary filler ${index} ${'y'.repeat(80)}`);
  const allLines = [...frontmatterLines, '', expectedSnippetText, ...bodyLines];
  const sampledLines = evenSampledLineNumbers(allLines.length, SNIPPET_DOC_ANALYZED_LINES_MAX);
  assert.equal(sampledLines.has(aliasLine), true);
  assert.equal(sampledLines.has(closingLine), false);
  assert.equal(expectedSnippetLine, closingLine + 2);

  const vault = tempRoot();
  writeVaultFile(vault, 'Boundary.md', allLines.join('\n'));
  const analyzer = testAnalyzer();
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer,
    partitionBits: 1,
  });
  assert.equal(built.documents[0].snippetCorpus.bodyStartLine, closingLine);
  assert.equal(
    built.documents[0].snippetCorpus.lines.some((line) => line.text.includes(marker)),
    false,
  );

  const result = executeSearchJob({
    vault,
    search: normalizeSearchParams({ query: marker, limit: 1 }),
    analysis: {
      raw: marker,
      primaryChannel: 'morph',
      primaryTerms: [marker],
      channels: {
        morph: [marker],
        surface: [marker],
        ngram: [],
      },
    },
    analyzerIdentity: analyzer.identity,
    snapshot: snapshotHandle(built, 'pin-boundary-fallback'),
  });

  assert.equal(result.matches[0]?.path, 'Boundary.md');
  assert.deepEqual(
    result.matches[0]?.snippets.map((snippet) => ({
      line: snippet.line,
      text: snippet.text,
    })),
    [{ line: expectedSnippetLine, text: expectedSnippetText }],
  );
});
