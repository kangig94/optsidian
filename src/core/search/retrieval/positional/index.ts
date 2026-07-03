export {
  bm25FieldScore,
  bm25TermScore,
  bm25TermStats,
  boostedBm25FieldScore,
  computeFieldBm25Stats,
  fieldChannelBm25Boost,
  tokenChannelFusionWeight,
} from './bm25.js';

export type { Bm25DocumentFieldInput, Bm25DocumentInput, Bm25FieldStats, Bm25Stats } from './bm25.js';

export { createSearchEngine, postingsForChannel } from './engine.js';

export type { RankingInput, SearchEngine, SearchSnapshot, SearchSnapshotSegment } from './engine.js';

export {
  buildPositionalPostings,
  findPhraseMatches,
  normalizeTerm,
  phraseStartPositions,
  positionsForTerm,
  postingKeysForTerms,
} from './postings.js';

export type { PositionalPhraseMatch } from './postings.js';

export { findProximityMatches, minimumTermWindow, proximityScore } from './proximity.js';

export type { PositionalProximityMatch, TermWindow } from './proximity.js';

export {
  createPositionalRetriever,
  createQueryPostingsLookup,
  POSITIONAL_RETRIEVER_IDENTITY,
  retrievePositionalCandidates,
} from './retriever.js';

export type { QueryPostingsLookup } from './retriever.js';

export { ProjectionReader } from './segment-projection-reader.js';

export type {
  CanonicalDocProjectionDoc,
  CanonicalDocProjectionFieldLength,
  CanonicalDocProjectionIdentityKeys,
  CanonicalDocProjectionOffsets,
} from './segment-projection-reader.js';

export { CanonicalSegmentPostingsReader } from './segment-postings-reader.js';

export {
  bm25CorpusStats,
  bm25DocumentFrequency,
  bm25TermScoreFromGlobalStats,
  bm25TermScoreFromStatsLookup,
  buildSearchSnapshotFromSegments,
  createPositionalBm25StatsLookup,
  createSearchFieldLengthLookup,
  splitCanonicalPostingTerm,
} from './snapshot.js';

export type {
  Bm25TermScoreOptions,
  PositionalBm25CorpusStats,
  PositionalBm25GlobalStats,
  PositionalBm25StatsLookup,
  PositionalSnapshotSegmentInput,
  SearchFieldLengthLookup,
} from './snapshot.js';

export { POSITIONAL_FIELD_BY_ID, POSITIONAL_FIELD_ID, POSITIONAL_SEARCH_FIELDS } from './types.js';

export type {
  PositionalChannelDocumentInput,
  PositionalChannelFieldInput,
  PositionalChannelIndex,
  PositionalDocId,
  PositionalDocumentInput,
  PositionalDocumentRecord,
  PositionalFieldId,
  PositionalFieldInput,
  PositionalPosting,
  PositionalPostings,
  PositionalQueryAnalysis,
} from './types.js';
