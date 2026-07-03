export {
  bm25BoundKey,
  compareCanonicalBm25Terms,
  compareTagOnlyMatches,
  exactDominanceLambda,
  identityScoreFromExactPriority,
  isRankedCandidate,
  nullableRankPriority,
  rankBucketName,
  rerankCandidatesWithSignals,
  rerankScore
} from "./score.js";

export type {
  CandidateRankSignals,
  ExactDominanceBound,
  ExactDominanceBoundInput,
  RankDocument
} from "./score.js";
