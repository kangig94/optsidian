import type {
  CandidateSet,
  DocumentId,
  LinkGraphData,
  LinkGraphEdge,
  LinkGraphNeighbor,
  LinkGraphView,
  Retriever,
  RetrieverIdentity,
  RetrievalCandidate,
  RetrievalQuery,
  ShardDocRef,
} from '../contracts.js';
import type { SearchSnapshot } from './positional/engine.js';

export const LINK_ADJACENCY_RETRIEVER_VERSION = '1';
export const LINK_ADJACENCY_SCORING_VERSION = 'direct-1hop-v1';
export const LINK_ADJACENCY_DIRECT_SCORE = 1;

export type LinkAdjacencyRetrieverOptions = {
  snapshot: SearchSnapshot;
  linkGraph?: LinkGraphView;
  limit?: number;
  directScore?: number;
};

type DocumentRefEntry = {
  ref: ShardDocRef;
  path: string;
};

type NeighborAccumulator = {
  documentId: DocumentId;
  path?: string;
  score: number;
  directions: Set<'outlink' | 'inlink'>;
  edges: LinkGraphEdge[];
};

export function createLinkGraphView(data: LinkGraphData): LinkGraphView {
  const edges = canonicalLinkGraphEdges(data.edges);
  const backlinks = canonicalLinkGraphBacklinks(data.backlinks.length > 0 ? data.backlinks : edges);
  const outlinksByDocumentId = new Map<DocumentId, LinkGraphEdge[]>();
  const inlinksByDocumentId = new Map<DocumentId, LinkGraphEdge[]>();
  for (const edge of edges) {
    appendEdge(outlinksByDocumentId, edge.sourceDocumentId, edge);
    appendEdge(inlinksByDocumentId, edge.targetDocumentId, edge);
  }
  for (const entries of outlinksByDocumentId.values()) entries.sort(compareLinkGraphEdges);
  for (const entries of inlinksByDocumentId.values()) entries.sort(compareLinkGraphBacklinks);

  return {
    schemaVersion: 1,
    linkGraphId: data.linkGraphId,
    corpusSnapshotId: data.corpusSnapshotId,
    resolverVersion: data.resolverVersion,
    edges,
    backlinks,
    outlinks: (documentId) => outlinksByDocumentId.get(documentId) ?? [],
    inlinks: (documentId) => inlinksByDocumentId.get(documentId) ?? [],
    neighbors: (documentId) => linkGraphNeighbors(documentId, outlinksByDocumentId, inlinksByDocumentId),
  };
}

export function canonicalLinkGraphEdges(edges: readonly LinkGraphEdge[]): LinkGraphEdge[] {
  const byKey = new Map<string, LinkGraphEdge>();
  for (const edge of edges) {
    const canonical = canonicalLinkGraphEdge(edge);
    byKey.set(linkGraphEdgeKey(canonical), canonical);
  }
  return [...byKey.values()].sort(compareLinkGraphEdges);
}

export function canonicalLinkGraphBacklinks(edges: readonly LinkGraphEdge[]): LinkGraphEdge[] {
  return canonicalLinkGraphEdges(edges).sort(compareLinkGraphBacklinks);
}

export function createLinkAdjacencyRetriever(options: LinkAdjacencyRetrieverOptions): Retriever {
  const linkGraph = options.linkGraph ?? options.snapshot.linkGraph;
  const retrieverIdentity: RetrieverIdentity = {
    id: 'link-adjacency',
    version: LINK_ADJACENCY_RETRIEVER_VERSION,
    parameters: {
      linkGraphId: linkGraph?.linkGraphId ?? null,
      resolverVersion: linkGraph?.resolverVersion ?? null,
      scoring: LINK_ADJACENCY_SCORING_VERSION,
      directScore: options.directScore ?? LINK_ADJACENCY_DIRECT_SCORE,
    },
  };
  return {
    retrieverIdentity,
    retrieve: (query) => retrieveLinkAdjacencyCandidates(query, retrieverIdentity, options, linkGraph),
  };
}

function retrieveLinkAdjacencyCandidates(
  query: RetrievalQuery,
  retrieverIdentity: RetrieverIdentity,
  options: LinkAdjacencyRetrieverOptions,
  linkGraph: LinkGraphView | undefined,
): CandidateSet {
  if (!linkGraph) return emptyLinkCandidateSet(query, retrieverIdentity);
  const refs = documentRefIndex(options.snapshot);
  const sourceDocumentId = query.sourceDocumentId ?? sourceDocumentIdByPath(query.sourcePath, refs);
  if (!sourceDocumentId) return emptyLinkCandidateSet(query, retrieverIdentity);
  const directScore = finitePositive(options.directScore ?? LINK_ADJACENCY_DIRECT_SCORE, LINK_ADJACENCY_DIRECT_SCORE);
  const candidates: RetrievalCandidate[] = [];
  for (const neighbor of linkGraph.neighbors(sourceDocumentId)) {
    if (neighbor.documentId === sourceDocumentId) continue;
    const entry = refs.byDocumentId.get(neighbor.documentId);
    if (!entry) continue;
    const linkAgreement = Math.max(0, Math.min(1, neighbor.score * directScore));
    candidates.push({
      candidateId: neighbor.documentId,
      documentId: neighbor.documentId,
      shardDocRef: entry.ref,
      path: entry.path,
      rank: 0,
      retrievalScore: linkAgreement,
      linkAgreement,
      channels: [],
      phraseMatches: [],
      proximityMatches: [],
    });
  }
  candidates.sort(compareLinkCandidates);
  const limit = Math.max(0, Math.trunc(options.limit ?? query.limit ?? candidates.length));
  return {
    schemaVersion: 1,
    snapshotId: query.snapshotId ?? options.snapshot.snapshotId,
    retrieverIdentity,
    complete: true,
    candidates: candidates.slice(0, limit).map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    })),
  };
}

function linkGraphNeighbors(
  documentId: DocumentId,
  outlinksByDocumentId: ReadonlyMap<DocumentId, readonly LinkGraphEdge[]>,
  inlinksByDocumentId: ReadonlyMap<DocumentId, readonly LinkGraphEdge[]>,
): readonly LinkGraphNeighbor[] {
  const byDocumentId = new Map<DocumentId, NeighborAccumulator>();
  for (const edge of outlinksByDocumentId.get(documentId) ?? []) {
    accumulateNeighbor(byDocumentId, edge.targetDocumentId, edge.targetPath, 'outlink', edge);
  }
  for (const edge of inlinksByDocumentId.get(documentId) ?? []) {
    accumulateNeighbor(byDocumentId, edge.sourceDocumentId, edge.sourcePath, 'inlink', edge);
  }
  return [...byDocumentId.values()]
    .map((entry): LinkGraphNeighbor => ({
      documentId: entry.documentId,
      ...(entry.path ? { path: entry.path } : {}),
      score: entry.score,
      directions: [...entry.directions].sort(compareCodePoint),
      edges: [...entry.edges].sort(compareLinkGraphEdges),
    }))
    .sort(compareLinkGraphNeighbors);
}

function accumulateNeighbor(
  neighbors: Map<DocumentId, NeighborAccumulator>,
  documentId: DocumentId,
  path: string | undefined,
  direction: 'outlink' | 'inlink',
  edge: LinkGraphEdge,
): void {
  const current = neighbors.get(documentId) ?? {
    documentId,
    path,
    score: 1,
    directions: new Set<'outlink' | 'inlink'>(),
    edges: [],
  };
  current.path ??= path;
  current.score = Math.max(current.score, 1);
  current.directions.add(direction);
  current.edges.push(edge);
  neighbors.set(documentId, current);
}

function documentRefIndex(snapshot: SearchSnapshot): {
  byDocumentId: ReadonlyMap<DocumentId, DocumentRefEntry>;
  byPath: ReadonlyMap<string, DocumentId>;
} {
  const byDocumentId = new Map<DocumentId, DocumentRefEntry>();
  const byPath = new Map<string, DocumentId>();
  for (const segment of snapshot.segments) {
    for (let localDocId = 1; localDocId <= segment.projection.documentCount(); localDocId += 1) {
      const doc = segment.projection.doc(localDocId);
      const ref = {
        segmentId: segment.segmentId,
        partitionId: segment.partitionId,
        localDocId: doc.localDocId,
        documentId: doc.documentId,
      };
      byDocumentId.set(doc.documentId, { ref, path: doc.path });
      byPath.set(normalizePathKey(doc.path), doc.documentId);
    }
  }
  return { byDocumentId, byPath };
}

function sourceDocumentIdByPath(
  sourcePath: string | undefined,
  refs: { byPath: ReadonlyMap<string, DocumentId> },
): DocumentId | undefined {
  if (!sourcePath) return undefined;
  return refs.byPath.get(normalizePathKey(sourcePath));
}

function emptyLinkCandidateSet(query: RetrievalQuery, retrieverIdentity: RetrieverIdentity): CandidateSet {
  return {
    schemaVersion: 1,
    snapshotId: query.snapshotId,
    retrieverIdentity,
    complete: true,
    candidates: [],
  };
}

function canonicalLinkGraphEdge(edge: LinkGraphEdge): LinkGraphEdge {
  return {
    sourcePath: normalizePathKey(edge.sourcePath),
    targetPath: normalizePathKey(edge.targetPath),
    sourceDocumentId: edge.sourceDocumentId,
    targetDocumentId: edge.targetDocumentId,
  };
}

function appendEdge(index: Map<DocumentId, LinkGraphEdge[]>, documentId: DocumentId, edge: LinkGraphEdge): void {
  const edges = index.get(documentId) ?? [];
  edges.push(edge);
  index.set(documentId, edges);
}

function linkGraphEdgeKey(edge: LinkGraphEdge): string {
  return `${edge.sourcePath}\u0000${edge.targetPath}\u0000${edge.sourceDocumentId}\u0000${edge.targetDocumentId}`;
}

function compareLinkGraphEdges(left: LinkGraphEdge, right: LinkGraphEdge): number {
  return (
    compareUtf8(left.sourcePath, right.sourcePath) ||
    compareUtf8(left.targetPath, right.targetPath) ||
    compareUtf8(left.sourceDocumentId, right.sourceDocumentId) ||
    compareUtf8(left.targetDocumentId, right.targetDocumentId)
  );
}

function compareLinkGraphBacklinks(left: LinkGraphEdge, right: LinkGraphEdge): number {
  return (
    compareUtf8(left.targetPath, right.targetPath) ||
    compareUtf8(left.sourcePath, right.sourcePath) ||
    compareUtf8(left.targetDocumentId, right.targetDocumentId) ||
    compareUtf8(left.sourceDocumentId, right.sourceDocumentId)
  );
}

function compareLinkGraphNeighbors(left: LinkGraphNeighbor, right: LinkGraphNeighbor): number {
  if (right.score !== left.score) return right.score - left.score;
  return compareUtf8(left.path ?? '', right.path ?? '') || compareUtf8(left.documentId, right.documentId);
}

function compareLinkCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  if (right.retrievalScore !== left.retrievalScore) return right.retrievalScore - left.retrievalScore;
  return compareUtf8(left.path ?? '', right.path ?? '') || compareUtf8(left.documentId, right.documentId);
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).join('/').normalize('NFC');
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value.normalize('NFC'));
}
