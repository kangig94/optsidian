import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirSync, writePrivateFileSync } from '../../core/private-path.js';
import type {
  CorpusSnapshotId,
  LinkGraphData,
  LinkGraphEdge,
  LinkGraphId,
  LinkGraphView,
} from '../../core/search/contracts.js';
import { canonicalValueBytes } from '../../core/search/segments/index.js';
import {
  canonicalLinkGraphBacklinks,
  canonicalLinkGraphEdges,
  createLinkGraphView,
} from '../../core/search/retrieval/index.js';
import { durableRename, fsyncDirSync, fsyncFileSync, type DurableRename } from './publication.js';
import type { SearchStoreCachePaths } from './cache-paths.js';

export const LINK_GRAPH_SIDECAR_SCHEMA_VERSION = 1;
export const LINK_GRAPH_RESOLVER_VERSION = 'daemon-link-resolver-v1';

export type LinkGraphSidecar = LinkGraphData & {
  schemaVersion: typeof LINK_GRAPH_SIDECAR_SCHEMA_VERSION;
};

export type LinkGraphStoreOptions = {
  durableRenameLinkGraph?: DurableRename;
};

export function buildLinkGraphSidecar(input: {
  corpusSnapshotId: CorpusSnapshotId;
  edges: readonly LinkGraphEdge[];
  resolverVersion?: string;
}): LinkGraphSidecar {
  const resolverVersion = input.resolverVersion ?? LINK_GRAPH_RESOLVER_VERSION;
  const edges = canonicalLinkGraphEdges(input.edges);
  return {
    schemaVersion: LINK_GRAPH_SIDECAR_SCHEMA_VERSION,
    linkGraphId: computeLinkGraphId(input.corpusSnapshotId, resolverVersion, edges),
    corpusSnapshotId: input.corpusSnapshotId,
    resolverVersion,
    edges,
    backlinks: canonicalLinkGraphBacklinks(edges),
  };
}

export function computeLinkGraphId(
  corpusSnapshotId: CorpusSnapshotId,
  resolverVersion: string,
  edges: readonly LinkGraphEdge[],
): LinkGraphId {
  return sha256(
    canonicalValueBytes({
      corpusSnapshotId,
      resolverVersion,
      edges: canonicalLinkGraphEdges(edges),
    }),
  );
}

export async function storeLinkGraphSidecar(
  paths: SearchStoreCachePaths,
  sidecar: LinkGraphSidecar,
  options: LinkGraphStoreOptions = {},
): Promise<void> {
  ensureLinkGraphDir(paths);
  const canonical = buildLinkGraphSidecar({
    corpusSnapshotId: sidecar.corpusSnapshotId,
    resolverVersion: sidecar.resolverVersion,
    edges: sidecar.edges,
  });
  if (canonical.linkGraphId !== sidecar.linkGraphId) {
    throw new Error(`linkGraphId mismatch for link graph ${sidecar.linkGraphId}`);
  }
  const target = linkGraphSidecarPath(paths, canonical.linkGraphId);
  if (fs.existsSync(target)) {
    const existing = loadLinkGraphSidecar(paths, canonical.linkGraphId);
    if (existing?.linkGraphId === canonical.linkGraphId) return;
    fs.rmSync(target, { force: true });
  }
  const tmp = path.join(paths.tmpDir, `${canonical.linkGraphId}.${process.pid}.link-graph.tmp`);
  writePrivateFileSync(tmp, `${JSON.stringify(canonical)}\n`, 'Optsidian search link graph sidecar');
  fsyncFileSync(tmp);
  fsyncDirSync(paths.tmpDir);
  await (options.durableRenameLinkGraph ?? durableRename)(tmp, target);
  fsyncDirSync(paths.linkGraphsDir);
  const loaded = loadLinkGraphSidecar(paths, canonical.linkGraphId);
  if (!loaded) throw new Error(`link graph sidecar failed to load after publish: ${canonical.linkGraphId}`);
}

export function loadLinkGraphSidecar(
  paths: SearchStoreCachePaths,
  linkGraphId: LinkGraphId,
): LinkGraphSidecar | undefined {
  if (!isValidLinkGraphId(linkGraphId)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(linkGraphSidecarPath(paths, linkGraphId), 'utf8')) as unknown;
    if (!isLinkGraphSidecar(parsed)) return undefined;
    const canonical = buildLinkGraphSidecar({
      corpusSnapshotId: parsed.corpusSnapshotId,
      resolverVersion: parsed.resolverVersion,
      edges: parsed.edges,
    });
    if (canonical.linkGraphId !== linkGraphId || parsed.linkGraphId !== linkGraphId) return undefined;
    if (!sameCanonicalJson(parsed.backlinks, canonical.backlinks)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

export function loadLinkGraphView(paths: SearchStoreCachePaths, linkGraphId: LinkGraphId): LinkGraphView | undefined {
  const sidecar = loadLinkGraphSidecar(paths, linkGraphId);
  return sidecar ? createLinkGraphView(sidecar) : undefined;
}

export function linkGraphSidecarExists(paths: SearchStoreCachePaths, linkGraphId: LinkGraphId): boolean {
  return loadLinkGraphSidecar(paths, linkGraphId) !== undefined;
}

export function sweepLinkGraphSidecars(paths: SearchStoreCachePaths, roots: ReadonlySet<LinkGraphId>): void {
  ensureLinkGraphDir(paths);
  for (const file of safeReadDir(paths.linkGraphsDir)) {
    if (!isValidLinkGraphId(file) || roots.has(file)) continue;
    fs.rmSync(path.join(paths.linkGraphsDir, file), { force: true });
  }
}

export function linkGraphSidecarPath(paths: SearchStoreCachePaths, linkGraphId: LinkGraphId): string {
  return path.join(paths.linkGraphsDir, linkGraphId);
}

function ensureLinkGraphDir(paths: SearchStoreCachePaths): void {
  ensurePrivateDirSync(paths.linkGraphsDir, 'Optsidian search link graph directory');
  ensurePrivateDirSync(paths.tmpDir, 'Optsidian search tmp directory');
}

function isLinkGraphSidecar(value: unknown): value is LinkGraphSidecar {
  return (
    isRecord(value) &&
    value.schemaVersion === LINK_GRAPH_SIDECAR_SCHEMA_VERSION &&
    typeof value.linkGraphId === 'string' &&
    typeof value.corpusSnapshotId === 'string' &&
    typeof value.resolverVersion === 'string' &&
    Array.isArray(value.edges) &&
    Array.isArray(value.backlinks) &&
    value.edges.every(isLinkGraphEdge) &&
    value.backlinks.every(isLinkGraphEdge)
  );
}

function isLinkGraphEdge(value: unknown): value is LinkGraphEdge {
  return (
    isRecord(value) &&
    typeof value.sourcePath === 'string' &&
    typeof value.targetPath === 'string' &&
    typeof value.sourceDocumentId === 'string' &&
    typeof value.targetDocumentId === 'string'
  );
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).sort(compareCodePoint);
  } catch {
    return [];
  }
}

function isValidLinkGraphId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
