import type { SearchTextAnalysis } from '../../core/search/analysis/index.js';
import type { ExactDominanceBound } from '../../core/search/ranking/index.js';
import type { SearchShardExecutionResult } from '../search-execution.js';
import { sortedSearchShardFinalists } from './finalist-order.js';
import type { SearchShardFinalist } from './result-shaping.js';

export type ResultAggregationSnapshot = {
  finalists: SearchShardFinalist[];
  scoredCount: number;
  exactBound?: ExactDominanceBound;
  analysis: SearchTextAnalysis;
};

export type ResultAggregatorInput = {
  exactBound?: ExactDominanceBound;
  analysis: SearchTextAnalysis;
};

export class ResultAggregator {
  private readonly analysis: SearchTextAnalysis;
  private readonly exactBound: ExactDominanceBound | undefined;
  private readonly finalists: SearchShardFinalist[] = [];
  private scored = 0;

  constructor(input: ResultAggregatorInput) {
    this.analysis = input.analysis;
    this.exactBound = input.exactBound;
  }

  ingest(shardResult: SearchShardExecutionResult): void {
    this.scored += shardResult.scoredCount;
    if (shardResult.finalists.length === 0) return;
    this.finalists.push(...shardResult.finalists);
  }

  finalize(): ResultAggregationSnapshot {
    return {
      finalists: sortedSearchShardFinalists(this.finalists),
      scoredCount: this.scored,
      ...(this.exactBound ? { exactBound: this.exactBound } : {}),
      analysis: this.analysis,
    };
  }
}
