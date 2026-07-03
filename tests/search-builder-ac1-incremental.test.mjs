import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCanonicalSearchSnapshot } from '../src/daemon/search-store/builder.ts';
import { createDaemonPools } from '../src/daemon/pools.ts';
import { computeRetrievalSnapshotId } from '../src/daemon/search-store/snapshot-store.ts';
import { SNAPSHOT_PERSISTENCE_SCHEMA_HASH } from '../src/daemon/search-store/types.ts';
import { DeterministicHashProvider, buildEmbeddingSet } from '../src/core/search/dense/index.ts';

const AC3_REQUIRED_CASES = [
  'add',
  'modify',
  'delete',
  'rename',
  'hangul-decomposed-jamo',
  'hangul-nfkc-compat',
  'frontmatter-edits',
  'empty-files',
  'zero-length-fields',
  'basename-collisions-created',
  'basename-collisions-destroyed',
  'wikilinks',
  'markdown-links',
  'embeds',
  'non-utf8-md',
  'decomposed-unicode-filename-add-modify',
];

const DECOMPOSED_UNICODE_FILENAME = 'Unicode/Cafe\u0301.md';
const COMPOSED_UNICODE_FILENAME = 'Unicode/Caf\u00e9.md';

function testAnalyzer(stats) {
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
    tokenizeBatch: async (texts) => {
      if (stats) {
        stats.batches++;
        stats.texts += texts.length;
        if (texts.length >= 6) stats.documentParses++;
      }
      return texts.map(tokenize);
    },
  };
}

function tempRoot(prefix = 'optsidian-search-ac1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVaultFile(vault, rel, content) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function removeVaultFile(vault, rel) {
  fs.rmSync(path.join(vault, rel), { force: true });
}

function renameVaultFile(vault, from, to) {
  fs.mkdirSync(path.dirname(path.join(vault, to)), { recursive: true });
  fs.renameSync(path.join(vault, from), path.join(vault, to));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function noteContent(name, revision, targetPath = 'Doc-00.md') {
  const targetStem = path.posix.basename(targetPath, '.md');
  return [
    '---',
    `title: ${name} title ${revision}`,
    `tags: [tag-${revision % 5}, shared]`,
    'frontmatterLink: [[IgnoredFrontmatterTarget]]',
    '---',
    `# ${name}`,
    '',
    `Revision ${revision} links to [[${targetStem}]], [markdown ${targetStem}](${targetPath}), and ![[${targetStem}]].`,
    'Hangul 가나다 decomposed 한 compatibility ① ㎏.',
    '',
  ].join('\n');
}

function frontmatterEditContent(revision) {
  return [
    '---',
    `title: Frontmatter edited ${revision}`,
    `tags: [frontmatter-edited, ac3-${revision}]`,
    'aliases: []',
    'frontmatterLink: [[IgnoredFrontmatterTarget]]',
    '---',
    '# Stable link body',
    '',
    'Body links to [[Doc-02]], [Doc 03](Doc-03.md), and ![[Doc-04]].',
    'Hangul 가나다 decomposed 한 compatibility ① ㎏.',
    '',
  ].join('\n');
}

function collisionTwinContent(name) {
  return [
    '---',
    `title: ${name}`,
    'tags: [collision]',
    '---',
    `# ${name}`,
    '',
    'The basename of this note is intentionally duplicated during AC3.',
  ].join('\n');
}

function collisionIndexContent() {
  return [
    '---',
    'title: Collision Index',
    'tags: [collision]',
    '---',
    '# Collision Index',
    '',
    'This basename-only link resolves only while [[Twin]] is unique.',
  ].join('\n');
}

function decomposedFilenameContent(revision) {
  return [
    '---',
    `title: Decomposed filename ${revision}`,
    'tags: [unicode-path]',
    '---',
    '# Unicode path',
    '',
    `Revision ${revision} for the decomposed Unicode filename links to [[Doc-00]].`,
    'Hangul 가나다 decomposed 한 compatibility ① ㎏.',
    '',
  ].join('\n');
}

function createVault(docCount = 24, coverage) {
  const vault = tempRoot();
  const documents = new Map();
  for (let index = 0; index < docCount; index += 1) {
    const rel = `Doc-${String(index).padStart(2, '0')}.md`;
    documents.set(rel, noteContent(`Doc ${index}`, index, `Doc-${String((index + 1) % docCount).padStart(2, '0')}.md`));
  }
  documents.set('Collision/A/Twin.md', collisionTwinContent('Twin A'));
  documents.set('Collision/Index.md', collisionIndexContent());
  for (const [rel, content] of documents) writeVaultFile(vault, rel, content);
  writeVaultFile(vault, 'Binary.md', Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
  coverage?.add('hangul-decomposed-jamo');
  coverage?.add('hangul-nfkc-compat');
  coverage?.add('wikilinks');
  coverage?.add('markdown-links');
  coverage?.add('embeds');
  coverage?.add('non-utf8-md');
  return { vault, documents };
}

function snapshotEnvelope(built) {
  return {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    snapshotId: built.snapshotId,
    corpusSnapshotId: built.corpusSnapshotId,
    linkGraphId: built.linkGraphId,
    manifest: built.manifest,
    canonicalManifestSha256: built.canonicalManifestSha256,
    documents: built.documents,
    diagnostics: built.diagnostics,
  };
}

function baseFromBuilt(built, segmentsDir) {
  const baseReuseImplementationIdentity = 'test-ac1';
  fs.mkdirSync(segmentsDir, { recursive: true });
  for (const segment of built.segments) {
    fs.writeFileSync(path.join(segmentsDir, segment.hash), segment.bytes);
  }
  return {
    envelope: {
      ...snapshotEnvelope(built),
      baseReuseImplementationIdentity,
    },
    segmentsDir,
    baseReuseImplementationIdentity,
  };
}

function denseTextForDocument(document) {
  const snippets = document.snippetCorpus.lines.map((line) => line.text).join('\n');
  const tags = document.tags.length > 0 ? `\n${document.tags.join(' ')}` : '';
  return `${document.title}\n${document.path}\n${snippets}${tags}`.trim();
}

function denseInputsForBuiltSnapshot(built) {
  return built.documents.map((document) => ({
    documentId: document.documentId,
    shardDocRef: {
      segmentId: '',
      partitionId: document.partitionId,
      localDocId: 0,
      documentId: document.documentId,
    },
    path: document.path,
    text: denseTextForDocument(document),
    contentHash: document.contentHash,
  }));
}

function segmentsByPartitionId(built) {
  const segments = new Map();
  for (const segment of built.segments) {
    assert.equal(segments.has(segment.partitionId), false, `duplicate segment partition ${segment.partitionId}`);
    segments.set(segment.partitionId, segment);
  }
  return segments;
}

function retrievalSnapshotIdForBuiltSnapshot(built, embeddingSet, provider) {
  return computeRetrievalSnapshotId({
    corpusSnapshotId: built.corpusSnapshotId,
    linkGraphId: built.linkGraphId,
    embeddingSetId: embeddingSet.embeddingSetId,
    retrieverPlanIdentity: `ac3-deterministic-plan:${provider.identity.model}:${built.linkGraphId}`,
    rankingFeatureVersion: String(built.identityTuple.rankingFeatureVersion),
  });
}

async function assertIncrementalEqualsFull(incremental, full, label) {
  assert.equal(incremental.snapshotId, full.snapshotId, `${label}: snapshotId`);
  assert.equal(incremental.corpusSnapshotId, full.corpusSnapshotId, `${label}: corpusSnapshotId`);
  assert.equal(incremental.linkGraphId, full.linkGraphId, `${label}: linkGraphId`);
  assert.equal(
    Buffer.compare(Buffer.from(incremental.canonicalManifestBytes), Buffer.from(full.canonicalManifestBytes)),
    0,
    `${label}: canonicalManifestBytes`,
  );
  assert.deepEqual(incremental.documents, full.documents, `${label}: persisted documents`);
  assert.deepEqual(
    denseInputsForBuiltSnapshot(incremental),
    denseInputsForBuiltSnapshot(full),
    `${label}: dense inputs`,
  );
  assert.deepEqual(incremental.linkEdges, full.linkEdges, `${label}: link edges`);
  assert.equal(incremental.segments.length, full.segments.length, `${label}: segment count`);
  const incrementalSegments = segmentsByPartitionId(incremental);
  const fullSegments = segmentsByPartitionId(full);
  assert.deepEqual([...incrementalSegments.keys()], [...fullSegments.keys()], `${label}: segment partitions`);
  for (const [partitionId, incrementalSegment] of incrementalSegments) {
    const fullSegment = fullSegments.get(partitionId);
    assert.ok(fullSegment, `${label}: full segment ${partitionId} exists`);
    assert.deepEqual(
      incrementalSegment.documentIds,
      fullSegment.documentIds,
      `${label}: segment ${partitionId} documentIds`,
    );
    assert.equal(
      Buffer.compare(Buffer.from(incrementalSegment.bytes), Buffer.from(fullSegment.bytes)),
      0,
      `${label}: segment ${partitionId} bytes`,
    );
    assert.equal(incrementalSegment.hash, fullSegment.hash, `${label}: segment ${partitionId} hash`);
    assert.equal(
      sha256(incrementalSegment.bytes),
      incrementalSegment.hash,
      `${label}: incremental segment ${partitionId} hash`,
    );
  }
  const provider = new DeterministicHashProvider({ dim: 8 });
  assert.equal(provider.identity.id, 'deterministic-hash', `${label}: deterministic embedding provider`);
  assert.equal(
    process.env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER,
    'deterministic-hash',
    `${label}: deterministic embedding provider env`,
  );
  const incrementalEmbeddingSet = await buildEmbeddingSet({
    provider,
    documents: denseInputsForBuiltSnapshot(incremental),
  });
  const fullEmbeddingSet = await buildEmbeddingSet({ provider, documents: denseInputsForBuiltSnapshot(full) });
  assert.equal(
    incrementalEmbeddingSet.embeddingSetId,
    fullEmbeddingSet.embeddingSetId,
    `${label}: deterministic dense identity`,
  );
  assert.equal(
    retrievalSnapshotIdForBuiltSnapshot(incremental, incrementalEmbeddingSet, provider),
    retrievalSnapshotIdForBuiltSnapshot(full, fullEmbeddingSet, provider),
    `${label}: deterministic retrieval snapshot identity`,
  );
}

function rng(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(values, random) {
  return values[Math.floor(random() * values.length)];
}

function applyMutation(vault, documents, operation, random, step) {
  const paths = [...documents.keys()].sort();
  if (operation === 'add' || paths.length < 4) {
    const rel = `Generated/Doc-${step}-${Math.floor(random() * 1_000_000)}.md`;
    const target = choose(paths, random) ?? rel;
    const content = noteContent(`Generated ${step}`, step, target);
    documents.set(rel, content);
    writeVaultFile(vault, rel, content);
    return 'add';
  }
  if (operation === 'delete') {
    const rel = choose(paths, random);
    documents.delete(rel);
    removeVaultFile(vault, rel);
    return 'delete';
  }
  if (operation === 'rename') {
    const rel = choose(paths, random);
    const renamed = `Renamed/${step}-${path.posix.basename(rel)}`;
    const content = documents.get(rel);
    documents.delete(rel);
    documents.set(renamed, content);
    renameVaultFile(vault, rel, renamed);
    return 'rename';
  }
  const rel = choose(paths, random);
  const target =
    choose(
      paths.filter((candidate) => candidate !== rel),
      random,
    ) ?? rel;
  const content = noteContent(path.posix.basename(rel, '.md'), step + 1000, target);
  documents.set(rel, content);
  writeVaultFile(vault, rel, content);
  return 'modify';
}

function applyScriptedAc3Mutation(vault, documents, step, coverage) {
  if (step === 0) {
    const rel = 'Doc-01.md';
    const content = frontmatterEditContent(step);
    documents.set(rel, content);
    writeVaultFile(vault, rel, content);
    coverage.add('modify');
    coverage.add('frontmatter-edits');
    coverage.add('hangul-decomposed-jamo');
    coverage.add('hangul-nfkc-compat');
    coverage.add('wikilinks');
    coverage.add('markdown-links');
    coverage.add('embeds');
    return 'modify-frontmatter-links-hangul';
  }
  if (step === 1) {
    const rel = 'Empty.md';
    documents.set(rel, '');
    writeVaultFile(vault, rel, '');
    coverage.add('add');
    coverage.add('empty-files');
    coverage.add('zero-length-fields');
    return 'add-empty-zero-length-fields';
  }
  if (step === 2) {
    const rel = 'Collision/B/Twin.md';
    const content = collisionTwinContent('Twin B');
    documents.set(rel, content);
    writeVaultFile(vault, rel, content);
    coverage.add('add');
    coverage.add('basename-collisions-created');
    return 'create-basename-collision';
  }
  if (step === 3) {
    const from = 'Collision/B/Twin.md';
    const to = 'Collision/B/Twin-Renamed.md';
    const content = documents.get(from);
    assert.equal(typeof content, 'string');
    documents.delete(from);
    documents.set(to, content);
    renameVaultFile(vault, from, to);
    coverage.add('rename');
    coverage.add('basename-collisions-destroyed');
    return 'destroy-basename-collision-by-rename';
  }
  if (step === 4) {
    const rel = 'Empty.md';
    documents.delete(rel);
    removeVaultFile(vault, rel);
    coverage.add('delete');
    return 'delete-empty-file';
  }
  if (step === 5) {
    const content = decomposedFilenameContent(step);
    documents.set(DECOMPOSED_UNICODE_FILENAME, content);
    writeVaultFile(vault, DECOMPOSED_UNICODE_FILENAME, content);
    coverage.add('add');
    coverage.add('decomposed-unicode-filename-add-modify');
    return 'add-decomposed-unicode-filename';
  }
  if (step === 6) {
    const content = decomposedFilenameContent(step);
    documents.set(DECOMPOSED_UNICODE_FILENAME, content);
    writeVaultFile(vault, DECOMPOSED_UNICODE_FILENAME, content);
    coverage.add('modify');
    coverage.add('decomposed-unicode-filename-add-modify');
    return 'modify-decomposed-unicode-filename';
  }
  return undefined;
}

function assertRequiredCaseCoverage(coverage) {
  const missing = AC3_REQUIRED_CASES.filter((name) => !coverage.has(name));
  assert.deepEqual(missing, [], `AC3 required cases not exercised: ${missing.join(', ')}`);
}

function edgeExists(built, sourcePath, targetPath) {
  return built.linkEdges.some((edge) => edge.sourcePath === sourcePath && edge.targetPath === targetPath);
}

function assertNonUtf8Excluded(built, label) {
  assert.equal(
    built.documents.some((document) => document.path === 'Binary.md'),
    false,
    `${label}: non-UTF8 .md excluded`,
  );
}

function assertAc3LinkStepState(built, label) {
  assert.equal(edgeExists(built, 'Doc-01.md', 'Doc-02.md'), true, `${label}: wikilink edge`);
  assert.equal(edgeExists(built, 'Doc-01.md', 'Doc-03.md'), true, `${label}: markdown link edge`);
  assert.equal(edgeExists(built, 'Doc-01.md', 'Doc-04.md'), true, `${label}: embed edge`);
}

function assertCollisionEdgeState(built, expected, label) {
  assert.equal(edgeExists(built, 'Collision/Index.md', 'Collision/A/Twin.md'), expected, label);
}

function assertDecomposedFilenameState(built, label) {
  assert.ok(
    built.documents.some((document) => document.path === COMPOSED_UNICODE_FILENAME),
    `${label}: decomposed filename indexed under normalized identity path`,
  );
}

async function withDeterministicEmbeddingProvider(callback) {
  const previous = process.env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER;
  process.env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER = 'deterministic-hash';
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER;
    else process.env.OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER = previous;
  }
}

test('AC3 incremental builder is byte-identical to full over explicit and randomized mutation sequences', async (t) => {
  const partitionBits = 3;
  const seeds = [0x5eed, 0xac10];
  const scriptedOperationByStep = ['modify', 'add', 'add', 'rename', 'delete', 'add', 'modify'];
  await withDeterministicEmbeddingProvider(async () => {
    const coverage = new Set();
    for (const seed of seeds) {
      const random = rng(seed);
      const { vault, documents } = createVault(24, coverage);
      const segmentsDir = path.join(tempRoot('optsidian-search-ac1-segments-'), 'segments');
      let previous = await buildCanonicalSearchSnapshot({
        vaultRoot: vault,
        analyzer: testAnalyzer(),
        partitionBits,
      });
      let base = baseFromBuilt(previous, segmentsDir);
      const seenOperations = new Set();
      for (let step = 0; step < 14; step += 1) {
        const scripted = applyScriptedAc3Mutation(vault, documents, step, coverage);
        const operation = choose(['modify', 'add', 'rename', 'delete'], random);
        const applied = scripted ?? applyMutation(vault, documents, operation, random, step);
        seenOperations.add(scripted ? scriptedOperationByStep[step] : applied);
        const incremental = await buildCanonicalSearchSnapshot({
          vaultRoot: vault,
          analyzer: testAnalyzer(),
          partitionBits,
          base,
        });
        const full = await buildCanonicalSearchSnapshot({
          vaultRoot: vault,
          analyzer: testAnalyzer(),
          partitionBits,
        });
        await assertIncrementalEqualsFull(incremental, full, `seed ${seed} step ${step} ${applied}`);
        assertNonUtf8Excluded(incremental, `seed ${seed} step ${step} ${applied}`);
        if (applied === 'modify-frontmatter-links-hangul') {
          assertAc3LinkStepState(incremental, `seed ${seed} step ${step} ${applied}`);
        }
        if (applied === 'create-basename-collision') {
          assertCollisionEdgeState(incremental, false, 'basename collision creation makes basename link ambiguous');
        }
        if (applied === 'destroy-basename-collision-by-rename') {
          assertCollisionEdgeState(incremental, true, 'basename collision destruction restores basename link');
        }
        if (applied === 'add-decomposed-unicode-filename' || applied === 'modify-decomposed-unicode-filename') {
          assertDecomposedFilenameState(incremental, `seed ${seed} step ${step} ${applied}`);
        }
        previous = incremental;
        base = baseFromBuilt(previous, segmentsDir);
      }
      assert.deepEqual([...seenOperations].sort(), ['add', 'delete', 'modify', 'rename']);
    }
    assertRequiredCaseCoverage(coverage);
    t.diagnostic(`AC3 cases exercised: ${AC3_REQUIRED_CASES.join(', ')}`);
  });
});

function linkDenseContent(index, docCount, linksPerDocument, revision = 0) {
  const lines = [
    '---',
    `title: Link Dense ${index} revision ${revision}`,
    `tags: [dense-${index % 7}, perf, revision-${revision}]`,
    '---',
    `# Link Dense ${index}`,
    '',
    'Dense links:',
  ];
  for (let offset = 1; offset <= linksPerDocument; offset += 1) {
    const target = `Doc-${String((index + offset) % docCount).padStart(2, '0')}.md`;
    const targetStem = path.posix.basename(target, '.md');
    lines.push(`- [[${targetStem}]] [markdown ${targetStem}](${target}) ![[${targetStem}]]`);
  }
  lines.push('Hangul 가나다 decomposed 한 compatibility ① ㎏.', '');
  return lines.join('\n');
}

function createLinkDenseVault(docCount = 96, linksPerDocument = 12) {
  const coverage = new Set();
  const { vault, documents } = createVault(docCount, coverage);
  for (let index = 0; index < docCount; index += 1) {
    const rel = `Doc-${String(index).padStart(2, '0')}.md`;
    const content = linkDenseContent(index, docCount, linksPerDocument);
    documents.set(rel, content);
    writeVaultFile(vault, rel, content);
  }
  return { vault, documents };
}

test('AC3 performance gate reparses O(changed docs) on a large link-dense fixture', async (t) => {
  await withDeterministicEmbeddingProvider(async () => {
    const partitionBits = 3;
    const { vault } = createLinkDenseVault(96, 12);
    const segmentsDir = path.join(tempRoot('optsidian-search-ac3-segments-'), 'segments');
    const previous = await buildCanonicalSearchSnapshot({
      vaultRoot: vault,
      analyzer: testAnalyzer(),
      partitionBits,
    });
    const target = previous.documents.find(
      (document) =>
        /^Doc-\d+\.md$/.test(document.path) &&
        previous.documents.filter((candidate) => candidate.partitionId === document.partitionId).length <
          previous.documents.length,
    );
    assert.ok(target);
    const targetIndex = Number(/^Doc-(\d+)\.md$/.exec(target.path)?.[1]);
    writeVaultFile(vault, target.path, linkDenseContent(targetIndex, 96, 12, 9999));
    const base = baseFromBuilt(previous, segmentsDir);
    const incrementalStats = { batches: 0, texts: 0, documentParses: 0 };
    const incremental = await buildCanonicalSearchSnapshot({
      vaultRoot: vault,
      analyzer: testAnalyzer(incrementalStats),
      partitionBits,
      base,
    });
    const fullStats = { batches: 0, texts: 0, documentParses: 0 };
    const full = await buildCanonicalSearchSnapshot({
      vaultRoot: vault,
      analyzer: testAnalyzer(fullStats),
      partitionBits,
    });
    await assertIncrementalEqualsFull(incremental, full, 'large link-dense single edit');
    assert.equal(incrementalStats.documentParses, 1, 'incremental reparses only the edited document');
    assert.equal(fullStats.documentParses, full.documents.length, 'full reparses every live parsed document');
    assert.ok(
      incrementalStats.documentParses * 16 <= fullStats.documentParses,
      `incremental parse work should be substantially lower (${incrementalStats.documentParses} vs ${fullStats.documentParses})`,
    );
    assert.ok(incremental.linkEdges.length >= 96 * 12, 'large fixture is link-dense');
    t.diagnostic(
      `AC3 performance parse work: incremental=${incrementalStats.documentParses}, full=${fullStats.documentParses}, linkEdges=${incremental.linkEdges.length}`,
    );
  });
});

test(
  'AnalyzerWorkerPool incremental base build exercises worker reduce pipeline and equals full',
  { timeout: 180_000 },
  async () => {
    await withDeterministicEmbeddingProvider(async () => {
      const partitionBits = 3;
      const { vault } = createVault(40);
      const env = {
        ...process.env,
        OPTSIDIAN_SEARCH_ANALYZER: 'intl',
        OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
        OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
        OPTSIDIAN_SEARCH_INDEX_WORKERS: '2',
        OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
        OPTSIDIAN_SEARCH_INDEX_MICROBATCH: '4',
      };
      const pools = await createDaemonPools(env, {});
      try {
        await pools.throughputAnalyzer.warmup(2);
        const options = (suffix) => ({
          deadline: Date.now() + 120_000,
          cancellationId: `worker-base-${suffix}`,
          vault,
        });
        const previous = await pools.throughputAnalyzer.buildSnapshot(vault, partitionBits, options('base'), {
          ngram: false,
        });
        const segmentsDir = path.join(tempRoot('optsidian-search-worker-base-segments-'), 'segments');
        const base = baseFromBuilt(previous, segmentsDir);
        for (let index = 0; index < 12; index += 1) {
          const rel = `Doc-${String(index).padStart(2, '0')}.md`;
          writeVaultFile(vault, rel, noteContent(`Worker Base ${index}`, 7000 + index, 'Doc-39.md'));
        }

        const incremental = await pools.throughputAnalyzer.buildSnapshot(
          vault,
          partitionBits,
          options('incremental'),
          { ngram: false },
          base,
        );
        const full = await pools.throughputAnalyzer.buildSnapshot(vault, partitionBits, options('full'), {
          ngram: false,
        });

        await assertIncrementalEqualsFull(incremental, full, 'AnalyzerWorkerPool worker-base build');
        assert.ok(
          incremental.documents.filter((document) => document.title.startsWith('Worker Base ')).length >= 12,
          'many changed docs are present in the worker-base result',
        );
      } finally {
        await pools.close();
      }
    });
  },
);
