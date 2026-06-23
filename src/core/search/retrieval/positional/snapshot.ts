import { SEARCH_TOKEN_CHANNELS, type SearchTokenChannel } from "../../analysis/index.js";
import type { SearchField } from "../../../types.js";
import { decodeCanonicalSegment } from "../../segments/index.js";
import { computeFieldBm25Stats, type Bm25Stats } from "./bm25.js";
import type { SearchSnapshot } from "./engine.js";
import {
  POSITIONAL_FIELD_BY_ID,
  type PositionalChannelIndex,
  type PositionalDocumentRecord,
  type PositionalPostings
} from "./types.js";

export type PositionalSnapshotDocumentMetadata = {
  documentId: string;
  tags?: readonly string[];
};

export type PositionalSnapshotSegmentInput = {
  segmentId: string;
  bytes: Uint8Array;
};

type MutablePositionalPostings = Map<string, Array<{ docId: number; fieldId: number; positions: readonly number[] }>>;

export function buildSearchSnapshotFromSegments(input: {
  snapshotId: string;
  segments: readonly PositionalSnapshotSegmentInput[];
  documents?: ReadonlyMap<string, PositionalSnapshotDocumentMetadata>;
}): SearchSnapshot {
  const postingsByChannel: PositionalChannelIndex = {};
  const positionalDocuments: PositionalDocumentRecord[] = [];
  const fieldTextByDocument = new Map<string, Partial<Record<SearchField, readonly string[]>>>();
  let nextDocId = 1;

  for (const segment of input.segments) {
    const decoded = decodeCanonicalSegment(segment.bytes);
    const localToGlobal = new Map<number, number>();
    (decoded.documents ?? []).forEach((document, index) => {
      const metadata = input.documents?.get(document.documentId);
      const globalDocId = nextDocId;
      nextDocId += 1;
      localToGlobal.set(index + 1, globalDocId);
      positionalDocuments.push({
        docId: globalDocId,
        documentId: document.documentId,
        documentKey: document.path,
        path: document.path,
        tags: metadata?.tags ?? []
      });
    });
    for (const text of decoded.fieldTexts ?? []) {
      const localDocument = decoded.documents?.[text.docId - 1];
      const globalDocId = localToGlobal.get(text.docId);
      if (!localDocument || !globalDocId) continue;
      const field = POSITIONAL_FIELD_BY_ID[text.fieldId];
      const current = fieldTextByDocument.get(localDocument.documentId) ?? {};
      current[field] = [...(current[field] ?? []), text.text];
      fieldTextByDocument.set(localDocument.documentId, current);
    }
    for (const posting of decoded.postings) {
      const parsed = splitCanonicalPostingTerm(posting.term);
      if (!parsed) continue;
      const globalDocId = localToGlobal.get(posting.docId);
      if (!globalDocId) continue;
      const channelPostings = (postingsByChannel[parsed.channel] as MutablePositionalPostings | undefined) ?? new Map();
      const postings = channelPostings.get(parsed.term) ?? [];
      postings.push({
        docId: globalDocId,
        fieldId: posting.fieldId,
        positions: posting.positions
      });
      channelPostings.set(parsed.term, postings);
      postingsByChannel[parsed.channel] = channelPostings as PositionalPostings;
    }
  }

  sortPostings(postingsByChannel);
  const documents = positionalDocuments.sort((left, right) => left.docId - right.docId);
  return {
    snapshotId: input.snapshotId,
    documents,
    postingsByChannel,
    bm25: mergedBm25FromPostings(postingsByChannel, documents),
    bm25ByChannel: bm25ByChannelFromPostings(postingsByChannel, documents),
    canonicalFieldText: fieldTextByDocument as ReadonlyMap<string, Partial<Record<SearchField, readonly string[]>>>
  };
}

export function bm25ByChannelFromPostings(
  postingsByChannel: PositionalChannelIndex,
  documents: readonly PositionalDocumentRecord[]
): Partial<Record<SearchTokenChannel, Bm25Stats>> {
  return Object.fromEntries(
    SEARCH_TOKEN_CHANNELS.map((channel) => [channel, bm25FromSinglePostings(postingsByChannel[channel] ?? new Map(), documents)])
  );
}

export function mergedBm25FromPostings(
  postingsByChannel: PositionalChannelIndex,
  documents: readonly PositionalDocumentRecord[]
): Bm25Stats {
  const merged = new Map<string, Array<{ docId: number; fieldId: number; positions: readonly number[] }>>();
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    for (const [term, postings] of postingsByChannel[channel] ?? new Map()) {
      merged.set(`${channel}\u0000${term}`, [...postings]);
    }
  }
  return bm25FromSinglePostings(merged, documents);
}

export function bm25FromSinglePostings(
  postings: PositionalPostings,
  documents: readonly PositionalDocumentRecord[]
): Bm25Stats {
  return computeFieldBm25Stats(
    documents.map((document) => ({
      docId: document.docId,
      fields: Object.entries(POSITIONAL_FIELD_BY_ID).map(([fieldId]) => ({
        fieldId: Number(fieldId),
        tokens: tokensForField(postings, document.docId, Number(fieldId))
      }))
    }))
  );
}

export function sortPostings(postingsByChannel: PositionalChannelIndex): void {
  for (const channel of SEARCH_TOKEN_CHANNELS) {
    const postings = postingsByChannel[channel];
    if (!postings) continue;
    postingsByChannel[channel] = new Map([...postings.entries()].sort(([left], [right]) => compareCodePoint(left, right)).map(([term, list]) => [
      term,
      [...list].sort((left, right) => left.docId - right.docId || left.fieldId - right.fieldId)
    ]));
  }
}

export function splitCanonicalPostingTerm(value: string): { channel: SearchTokenChannel; term: string } | undefined {
  const separator = value.indexOf("\u0000");
  if (separator < 1) return undefined;
  const channel = value.slice(0, separator);
  if (!SEARCH_TOKEN_CHANNELS.includes(channel as SearchTokenChannel)) return undefined;
  return { channel: channel as SearchTokenChannel, term: value.slice(separator + 1) };
}

function tokensForField(postings: PositionalPostings, docId: number, fieldId: number): string[] {
  const tokens: Array<{ term: string; pos: number }> = [];
  for (const [term, postingList] of postings) {
    const posting = postingList.find((entry) => entry.docId === docId && entry.fieldId === fieldId);
    if (!posting) continue;
    for (const pos of posting.positions) tokens.push({ term, pos });
  }
  return tokens.sort((left, right) => left.pos - right.pos || compareCodePoint(left.term, right.term)).map((entry) => entry.term);
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
