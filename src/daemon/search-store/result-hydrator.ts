import type { SearchTextAnalysis } from "../../core/search/analysis/index.js";
import type { ExactDominanceBound } from "../../core/search/ranking/index.js";
import type { NormalizedSearchParams } from "../../core/search/internal-types.js";
import type { SearchAnalyzerIdentity } from "../../core/search/analyzer.js";
import type { SearchMatch } from "../../core/types.js";
import { POSITIONAL_RETRIEVER_IDENTITY } from "../../core/search/retrieval/positional/index.js";
import {
  documentsByPath,
  documentsFromHandle,
  explainTrace,
  matchDebug,
  searchResult,
  snippetsForDocument,
  type SearchExecutionResult,
  type SearchExecutionSnapshotHandle,
  type SearchShardFinalist
} from "./result-shaping.js";
import { finalistsInBaseRankOrder } from "./finalist-order.js";

export type ResultHydrationAggregation = {
  finalists: readonly SearchShardFinalist[];
  scoredCount: number;
  exactBound?: ExactDominanceBound;
  analysis: SearchTextAnalysis;
};

export type ResultHydratorInput = {
  search: NormalizedSearchParams;
  snapshot: SearchExecutionSnapshotHandle;
  analyzerIdentity: SearchAnalyzerIdentity;
  explain?: boolean;
  aggregation: ResultHydrationAggregation;
};

export class ResultHydrator {
  hydrate(input: ResultHydratorInput): SearchExecutionResult {
    const documents = documentsFromHandle(input.snapshot);
    const documentsByRelPath = documentsByPath(documents);
    const rankedAll = [...input.aggregation.finalists];
    const ranked = rankedAll.slice(0, input.search.limit);
    const matches = this.hydrateMatches(input, documents, documentsByRelPath, ranked);
    const result: SearchExecutionResult = searchResult(
      matches,
      input.snapshot.snapshotId,
      input.analyzerIdentity,
      input.search,
      input.aggregation.scoredCount,
      input.aggregation.analysis.channels
    );
    if (input.explain) this.attachExplainTrace(result, input, rankedAll);
    return result;
  }

  private hydrateMatches(
    input: ResultHydratorInput,
    documents: ReturnType<typeof documentsFromHandle>,
    documentsByRelPath: ReturnType<typeof documentsByPath>,
    ranked: readonly SearchShardFinalist[]
  ): SearchMatch[] {
    return ranked.map((finalist): SearchMatch => {
      const record = documents.get(finalist.documentId) ?? documentsByRelPath.get(finalist.path);
      return {
        path: finalist.rank.path,
        title: record?.title ?? finalist.rank.title,
        tags: record?.tags ?? finalist.rank.tags,
        snippets: record ? snippetsForDocument(record, input.aggregation.analysis.channels) : [],
        ...(input.search.debug
          ? {
              debug: matchDebug({
                hit: finalist,
                rank: finalist.rank,
                snapshotId: input.snapshot.snapshotId,
                analyzer: input.analyzerIdentity
              })
            }
          : {})
      };
    });
  }

  private attachExplainTrace(
    result: SearchExecutionResult,
    input: ResultHydratorInput,
    rankedAll: readonly SearchShardFinalist[]
  ): void {
    if (!input.aggregation.exactBound) {
      throw Object.assign(new Error("explain requires shard exact-bound evidence"), { code: "INTERNAL" });
    }
    const traceFinalists = finalistsInBaseRankOrder(input.aggregation.finalists);
    result.explainTrace = explainTrace({
      candidateSet: {
        schemaVersion: 1,
        snapshotId: input.snapshot.snapshotId,
        retrieverIdentity: POSITIONAL_RETRIEVER_IDENTITY,
        complete: true,
        candidates: traceFinalists.map((finalist) => finalist.candidate)
      },
      exactBound: input.aggregation.exactBound,
      featurePayloads: traceFinalists.map((finalist) => finalist.feature),
      queryAnalysis: input.aggregation.analysis,
      ranked: rankedAll.map((finalist) => finalist.rank)
    });
  }
}
