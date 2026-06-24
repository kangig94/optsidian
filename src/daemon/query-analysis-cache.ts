import crypto from "node:crypto";
import type { SearchTextAnalysis } from "../core/search/analysis/index.js";
import type { SearchAnalyzerIdentity } from "../core/search/analyzer.js";
import type { SearchField } from "../core/types.js";
import { INDEX_AFFECTING_SEARCH_SETTINGS_HASH } from "./search-store/builder.js";

export type QueryAnalysisCacheKeyInput = {
  analyzerIdentity: SearchAnalyzerIdentity;
  rawQuery: string;
  fields?: readonly SearchField[];
  searchSettingsHash?: string;
};

type CacheEntry = {
  key: string;
  analysis: SearchTextAnalysis;
  lastAccess: number;
};

export class QueryAnalysisCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxEntries = 512) {
    this.maxEntries = Math.max(0, maxEntries);
  }

  get(input: QueryAnalysisCacheKeyInput): SearchTextAnalysis | undefined {
    if (this.maxEntries === 0) {
      this.misses += 1;
      return undefined;
    }
    const key = queryAnalysisCacheKey(input);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    entry.lastAccess = Date.now();
    return cloneAnalysis(entry.analysis);
  }

  set(input: QueryAnalysisCacheKeyInput, analysis: SearchTextAnalysis): void {
    if (this.maxEntries === 0) return;
    const key = queryAnalysisCacheKey(input);
    this.entries.set(key, { key, analysis: cloneAnalysis(analysis), lastAccess: Date.now() });
    this.enforceLimit();
  }

  stats() {
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    };
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const coldest = [...this.entries.values()].sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (!coldest) return;
      this.entries.delete(coldest.key);
      this.evictions += 1;
    }
  }
}

export function queryAnalysisCacheKey(input: QueryAnalysisCacheKeyInput): string {
  return sha256(stableStringify({
    analyzerIdentity: input.analyzerIdentity,
    rawQuery: input.rawQuery,
    fields: [...(input.fields ?? [])].sort((left, right) => left.localeCompare(right)),
    searchSettingsHash: input.searchSettingsHash ?? INDEX_AFFECTING_SEARCH_SETTINGS_HASH
  }));
}

function cloneAnalysis(analysis: SearchTextAnalysis): SearchTextAnalysis {
  return {
    raw: analysis.raw,
    primaryChannel: analysis.primaryChannel,
    primaryTerms: [...analysis.primaryTerms],
    channels: {
      morph: [...analysis.channels.morph],
      surface: [...analysis.channels.surface],
      ngram: [...analysis.channels.ngram]
    }
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
