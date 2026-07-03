import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCanonicalSearchSnapshot, parseBuildDocumentBatch } from '../src/daemon/search-store/builder.ts';
import { SEARCH_TOKEN_CHANNELS } from '../src/core/search/analysis/index.ts';
import { parseNoteLinks } from '../src/core/search/analysis/links.ts';

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'test-analyzer', version: 'retrieval-substrate-p1', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function tempRoot(prefix = 'optsidian-retrieval-p1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256Text(value) {
  return crypto
    .createHash('sha256')
    .update(new TextEncoder().encode(value.normalize('NFC')))
    .digest('hex');
}

function parsedDocumentTokenSet(document) {
  const tokens = new Set();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const terms of Object.values(document.positionTokens[channel])) {
      for (const term of terms) tokens.add(term);
    }
  }
  for (const line of document.snippetCorpus.lines) {
    for (const channel of SEARCH_TOKEN_CHANNELS) {
      for (const term of line.channels[channel]) tokens.add(term);
    }
  }
  return tokens;
}

test('AC1 P1 link parser handles escaped pipes markdown titles angle destinations and recursive labels', () => {
  const parsed = parseNoteLinks(
    [
      String.raw`Escaped [[Folder/Note\|Still Target|Alias \| Visible]]`,
      `Titled [Display](docs/Target.md "Human Title")`,
      `Angled [Angle](<docs/Angle Target.md>)`,
      `Recursive [Outer [[Inner|Nested Label]]](Nested.md)`,
      `Plain recursive [[Wrapper|Alias [child](Child.md)]]`,
    ].join('\n'),
  );
  assert.match(parsed.renderedText, /Alias \| Visible/);
  assert.match(parsed.renderedText, /Display/);
  assert.match(parsed.renderedText, /Angle/);
  assert.match(parsed.renderedText, /Outer Nested Label/);
  assert.match(parsed.renderedText, /Alias child/);
  assert.deepEqual(
    parsed.unresolvedLinks.map((link) => ({
      kind: link.kind,
      targetPath: link.targetPath,
      label: link.label,
    })),
    [
      { kind: 'wikilink', targetPath: 'Folder/Note|Still Target', label: 'Alias | Visible' },
      { kind: 'markdown', targetPath: 'docs/Target.md', label: 'Display' },
      { kind: 'markdown', targetPath: 'docs/Angle Target.md', label: 'Angle' },
      { kind: 'markdown', targetPath: 'Nested.md', label: 'Outer Nested Label' },
      { kind: 'wikilink', targetPath: 'Wrapper', label: 'Alias child' },
    ],
  );
});

test('AC1 P1 link projection indexes labels and excludes raw link syntax from every token channel', async () => {
  const vault = tempRoot();
  writeVaultFile(
    vault,
    'Source.md',
    [
      'Plain [[folder/note]]',
      'Aliased [[x|Alias Label]]',
      'Display [Disp](folder/path-target.md)',
      'Empty [](folder/markdown-bare.md)',
      'Heading [[note#Deep Heading]]',
      'Reference [[note#^block-id]]',
      'Embed ![[Embeds/Card]]',
      'Hangul [[한국/노트|한글 별칭]]',
    ].join('\n'),
  );

  const result = await parseBuildDocumentBatch(
    {
      vaultRoot: vault,
      relPaths: ['Source.md'],
      partitionBits: 1,
      searchSettings: { ngram: true },
    },
    testAnalyzer(),
  );
  assert.equal(result.documents.length, 1);

  const [document] = result.documents;
  const tokens = parsedDocumentTokenSet(document);
  for (const expected of [
    'note',
    'alias',
    'label',
    'disp',
    'markdown',
    'bare',
    'deep',
    'heading',
    'card',
    '한글',
    '별칭',
  ]) {
    assert.ok(tokens.has(expected), `expected rendered label token ${JSON.stringify(expected)}`);
  }

  for (const forbidden of ['folder', 'x', 'path', 'target', 'embeds', 'block', 'id', '한국']) {
    assert.equal(tokens.has(forbidden), false, `raw link target token must not be indexed: ${forbidden}`);
  }
  for (const token of tokens) {
    for (const syntax of ['[[', ']]', '#', '^', '/', '(', ')', '[', ']']) {
      assert.equal(
        token.includes(syntax),
        false,
        `raw link syntax ${syntax} leaked into token ${JSON.stringify(token)}`,
      );
    }
  }
  assert.equal(document.searchDocument.body.includes('[['), false);
  assert.equal(document.searchDocument.body.includes('folder/note'), false);
  assert.equal(document.searchDocument.body.includes('#^block-id'), false);
});

test('AC2 P1 build emits deterministic resolved directed link edges', async () => {
  const vault = tempRoot();
  writeVaultFile(
    vault,
    'Index.md',
    [
      'Links [[folder/Target#Section]]',
      'Alias [[AliasTarget|Alias]]',
      'Markdown [Markdown Target](docs/Markdown Target.md)',
      'Embed ![[Embeds/Card]]',
      'Missing [[Missing]]',
      'External [External](https://example.com/raw.md)',
    ].join('\n'),
  );
  writeVaultFile(vault, 'nested/Relative.md', 'Relative [[../Root Target]]\n');
  writeVaultFile(vault, 'folder/Target.md', '# Target\n');
  writeVaultFile(vault, 'AliasTarget.md', '# Alias Target\n');
  writeVaultFile(vault, 'docs/Markdown Target.md', '# Markdown Target\n');
  writeVaultFile(vault, 'Embeds/Card.md', '# Card\n');
  writeVaultFile(vault, 'Root Target.md', '# Root Target\n');

  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: vault,
    analyzer: testAnalyzer(),
    partitionBits: 1,
    searchSettings: { ngram: false },
  });

  assert.deepEqual(
    built.linkEdges.map((edge) => [edge.sourcePath, edge.targetPath]),
    [
      ['Index.md', 'AliasTarget.md'],
      ['Index.md', 'Embeds/Card.md'],
      ['Index.md', 'docs/Markdown Target.md'],
      ['Index.md', 'folder/Target.md'],
      ['nested/Relative.md', 'Root Target.md'],
    ],
  );
  for (const edge of built.linkEdges) {
    assert.equal(edge.sourceDocumentId, sha256Text(edge.sourcePath));
    assert.equal(edge.targetDocumentId, sha256Text(edge.targetPath));
  }
});
