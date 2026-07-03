import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCanonicalSearchSnapshot, scanBuildDocuments } from '../src/daemon/search-store/builder.ts';
import { parseNoteLinks } from '../src/core/search/analysis/links.ts';
import { parseMarkdownNote } from '../src/core/search/markdown.ts';

function testAnalyzer() {
  const tokenize = (text) =>
    [
      ...text
        .normalize('NFKC')
        .toLowerCase()
        .matchAll(/[\p{Letter}\p{Mark}\p{Number}]+/gu),
    ].map((match) => match[0]);
  return {
    identity: { name: 'test-analyzer', version: '1', node: 'test' },
    tokenize: async (text) => tokenize(text),
    tokenizeBatch: async (texts) => texts.map(tokenize),
  };
}

function tempRoot(prefix = 'optsidian-search-ac0-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createGoldenVault() {
  const vault = tempRoot();
  writeVaultFile(
    vault,
    'Alpha.md',
    [
      '---',
      'title: Alpha Title',
      'tags: [topic]',
      'related: [[FrontmatterOnly]]',
      '---',
      '# Alpha',
      '',
      'Body links to [[Beta]] and [Gamma](Gamma.md).',
      '',
    ].join('\n'),
  );
  writeVaultFile(vault, 'Beta.md', '# Beta\n\nBack to [[Alpha]].\n');
  writeVaultFile(vault, 'Gamma.md', '# Gamma\n\nNo outbound links.\n');
  writeVaultFile(vault, 'Binary.md', Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
  return vault;
}

test('AC0 full-build golden snapshot ids stay byte-identical', async () => {
  const built = await buildCanonicalSearchSnapshot({
    vaultRoot: createGoldenVault(),
    analyzer: testAnalyzer(),
    partitionBits: 1,
  });

  assert.equal(built.snapshotId, '8426d352228321d8ce9724417c5c9597d71fc222774a91c0b6c41fea25dcb33e');
  assert.equal(built.corpusSnapshotId, '25275eb61c403daa3ac39d6f85fc22580382f69a017a0c20354eb42e3d6d0632');
  assert.equal(built.linkGraphId, '0479f8cbf8ad5934b2cbc2554078015e05374bfa98e62f6a48b2902f0d2c7871');
  assert.equal(built.canonicalManifestSha256, built.snapshotId);
  assert.deepEqual(
    built.segments.map((segment) => segment.hash),
    [
      'b07e38c2aa4488a21168abeda2e1fdc930abbcc8a63c8eda7eab4938a6df2386',
      '662ae7a6232de8b40abeab3612e351c0afb8c8b544a2c102afe0da938de9de93',
    ],
  );
  assert.deepEqual(
    built.segments.map((segment) => sha256(segment.bytes)),
    built.segments.map((segment) => segment.hash),
  );
  assert.deepEqual(
    built.documents.map((document) => document.path),
    ['Alpha.md', 'Gamma.md', 'Beta.md'],
  );
  assert.deepEqual(
    built.linkEdges.map((edge) => [edge.sourcePath, edge.targetPath]),
    [
      ['Alpha.md', 'Beta.md'],
      ['Alpha.md', 'Gamma.md'],
      ['Beta.md', 'Alpha.md'],
    ],
  );
});

test('AC0 scan link extraction matches full parse body boundary and skips non-UTF8 documents', async () => {
  const vault = tempRoot();
  const sourceText = [
    '---',
    'title: Source',
    'related: [[FrontmatterOnly]]',
    '---',
    '# Source',
    '',
    'Body links to [[BodyTarget]], [Body Markdown](Folder/Body Markdown.md), and [[Binary]].',
    '',
  ].join('\n');
  writeVaultFile(vault, 'Source.md', sourceText);
  writeVaultFile(vault, 'FrontmatterOnly.md', '# Frontmatter Only\n');
  writeVaultFile(vault, 'BodyTarget.md', '# Body Target\n');
  writeVaultFile(vault, 'Folder/Body Markdown.md', '# Body Markdown\n');
  writeVaultFile(vault, 'Binary.md', Buffer.from([0xff, 0xfe, 0xfd, 0x00]));

  const scan = scanBuildDocuments(vault);
  const sourceRecord = scan.documents.find((record) => record.path === 'Source.md');
  assert.ok(sourceRecord);
  assert.equal(sourceRecord.contentHash, sha256(Buffer.from(sourceText)));
  assert.deepEqual(
    sourceRecord.unresolvedLinks.map((link) => ({
      kind: link.kind,
      embed: link.embed,
      rawTarget: link.rawTarget,
      targetPath: link.targetPath,
      label: link.label,
    })),
    parseNoteLinks(parseMarkdownNote('Source.md', sourceText).body).unresolvedLinks.map((link) => ({
      kind: link.kind,
      embed: link.embed,
      rawTarget: link.rawTarget,
      targetPath: link.targetPath,
      label: link.label,
    })),
  );
  assert.equal(
    sourceRecord.unresolvedLinks.some((link) => link.rawTarget === 'FrontmatterOnly'),
    false,
  );
  assert.equal(scan.files.includes('Binary.md'), true);
  assert.equal(
    scan.documents.some((record) => record.path === 'Binary.md'),
    false,
  );

  const built = await buildCanonicalSearchSnapshot({ vaultRoot: vault, analyzer: testAnalyzer(), partitionBits: 1 });
  assert.equal(
    built.documents.some((document) => document.path === 'Binary.md'),
    false,
  );
  assert.equal(
    built.linkEdges.some((edge) => edge.targetPath === 'FrontmatterOnly.md'),
    false,
  );
  assert.deepEqual(
    built.linkEdges.map((edge) => [edge.sourcePath, edge.targetPath]),
    [
      ['Source.md', 'Binary.md'],
      ['Source.md', 'BodyTarget.md'],
      ['Source.md', 'Folder/Body Markdown.md'],
    ],
  );
});
