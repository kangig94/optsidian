import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_PERSISTENCE_SCHEMA_HASH } from '../../src/daemon/search-store/types.ts';

export function currentEdition(paths) {
  const editions = [];
  for (const publicationsDir of publicationDirs(paths.ledgersDir ?? path.join(paths.rootDir, 'ledgers'))) {
    for (const entry of safeReadDir(publicationsDir)) {
      if (!/^\d+$/.test(entry)) continue;
      const parsed = readJsonIfExists(path.join(publicationsDir, entry));
      const record = parsed?.record;
      if (record?.editionSeq === Number(entry)) editions.push(record);
    }
  }
  editions.sort((left, right) => left.editionSeq - right.editionSeq);
  const edition = editions.at(-1);
  if (!edition) throw new Error(`no edition head under ${paths.rootDir}`);
  return edition;
}

export function activeSnapshotFromEdition(paths) {
  const edition = currentEdition(paths);
  return {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    snapshotId: edition.corpus.snapshotId,
    canonicalManifestSha256: edition.corpus.canonicalManifestSha256,
  };
}

export function activeRetrievalFromEdition(paths) {
  const editions = allEditions(paths);
  const edition = editions
    .filter((candidate) => candidate.dense.state === 'fresh' && candidate.identity.retrievalSnapshotId)
    .at(-1);
  if (!edition) throw new Error(`no fresh dense edition under ${paths.rootDir}`);
  if (edition.dense.state !== 'fresh') {
    throw new Error(`current edition dense state is ${edition.dense.state}`);
  }
  return {
    schemaHash: SNAPSHOT_PERSISTENCE_SCHEMA_HASH,
    retrievalSnapshotId: edition.identity.retrievalSnapshotId,
    snapshotId: edition.corpus.snapshotId,
    corpusSnapshotId: edition.corpus.corpusSnapshotId,
    linkGraphId: edition.linkGraphId,
    embeddingSetId: edition.dense.embeddingSetId,
    vectorGenerationId: edition.dense.generationId,
  };
}

export function generationDirForEnvelope(vectorPaths, envelope) {
  return path.join(vectorPaths.generationsDir, envelope.vector.manifestHash ?? envelope.vector.generationId);
}

export function editionDense(paths) {
  return currentEdition(paths).dense;
}

function publicationDirs(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isDirectory(current)) continue;
    if (path.basename(current) === 'publications') {
      out.push(current);
      continue;
    }
    for (const entry of safeReadDir(current)) stack.push(path.join(current, entry));
  }
  return out;
}

function allEditions(paths) {
  const editions = [];
  for (const publicationsDir of publicationDirs(paths.ledgersDir ?? path.join(paths.rootDir, 'ledgers'))) {
    for (const entry of safeReadDir(publicationsDir)) {
      if (!/^\d+$/.test(entry)) continue;
      const parsed = readJsonIfExists(path.join(publicationsDir, entry));
      const record = parsed?.record;
      if (record?.editionSeq === Number(entry)) editions.push(record);
    }
  }
  editions.sort((left, right) => left.editionSeq - right.editionSeq);
  return editions;
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
