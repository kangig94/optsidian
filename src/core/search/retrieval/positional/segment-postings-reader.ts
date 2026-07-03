import {
  ByteReader,
  CANONICAL_SEGMENT_SECTION,
  canonicalSegmentSectionBytes,
  lookupCanonicalTermDictionaryEntry,
  readCanonicalPostingRow,
} from '../../segments/canonical.js';
import type { CanonicalPosting } from '../../segments/canonical.js';

export class CanonicalSegmentPostingsReader {
  private readonly postingsBytes: Uint8Array;
  private readonly termDictionaryBytes: Uint8Array;

  constructor(segmentBytes: Uint8Array) {
    const postingsBytes = canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.postings);
    const termDictionaryBytes = canonicalSegmentSectionBytes(segmentBytes, CANONICAL_SEGMENT_SECTION.termDictionary);
    if (!postingsBytes) throw new Error('canonical segment missing postings section');
    if (!termDictionaryBytes) throw new Error('canonical segment missing term dictionary section');
    this.postingsBytes = postingsBytes;
    this.termDictionaryBytes = termDictionaryBytes;
  }

  postingsForTerm(term: string): CanonicalPosting[] {
    const entry = lookupCanonicalTermDictionaryEntry(this.termDictionaryBytes, term);
    if (!entry) return [];
    const end = entry.postingsOffset + entry.postingsByteLength;
    if (entry.postingsOffset < 0 || end > this.postingsBytes.length) {
      throw new Error('term dictionary postings range is outside the postings section');
    }
    const reader = new ByteReader(this.postingsBytes.subarray(entry.postingsOffset, end));
    const postings: CanonicalPosting[] = [];
    for (let index = 0; index < entry.postingCount; index += 1) {
      const posting = readCanonicalPostingRow(reader);
      if (posting.term !== entry.term) throw new Error('term dictionary range contains a different term');
      postings.push(posting);
    }
    reader.assertDone();
    return postings;
  }
}
