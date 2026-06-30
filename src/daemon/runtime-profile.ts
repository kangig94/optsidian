import crypto from "node:crypto";
import { KIWI_MODEL_TYPE, KIWI_MODEL_VERSION, KIWI_NLP_VERSION } from "../core/kiwi/artifact.js";
import { DEFAULT_RRF_K, SEARCH_SCORING_LAMBDAS } from "../core/search/constants.js";
import { readOptsidianSettings, searchNgramEnabled, type OptsidianSettings, type SearchSettings } from "../core/settings.js";
import type { IndexAffectingSearchSettings } from "../core/search/index-settings.js";
import { DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES } from "./query-analysis-cache-defaults.js";
import { defaultSearchExecutionWorkerCount } from "./worker-pool.js";

export const SEARCH_RUNTIME_PROFILE_SCHEMA_VERSION = 3;

export type SearchRuntimeProfile = {
  schemaVersion: typeof SEARCH_RUNTIME_PROFILE_SCHEMA_VERSION;
  analyzer: {
    mode: "intl" | "kiwi";
    extraLangs: string[];
    kiwiModel: {
      nlpVersion: string;
      modelVersion: string;
      modelType: string;
    };
  };
  index: IndexAffectingSearchSettings;
  embedding: {
    model: "bge-m3" | "multilingual-e5-small";
  };
  ranking: {
    denseLambda: number;
    linkLambda: number;
    rrfK: number;
  };
  workers: {
    query: number;
    index: number;
    searchExecution: number;
    analyzerMicrobatch: number;
    indexMicrobatch: number;
  };
  cache: {
    queryAnalysisEntries: number;
    snapshotRetention: number;
    executionSnapshots: number;
  };
  memory: {
    snapshotCountCap?: number;
    snapshotByteCap?: number;
    workerHeapGuardMb?: number;
    workerRssGuardMb?: number;
    workerRssGuardStrikes?: number;
  };
  daemon: {
    idleMs: number;
  };
};

export function effectiveSearchRuntimeProfile(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(cwd, env)
): SearchRuntimeProfile {
  const searchWorkers = positiveIntEnv(env, "OPTSIDIAN_SEARCH_WORKERS");
  const queryWorkers = positiveIntEnv(env, "OPTSIDIAN_SEARCH_QUERY_WORKERS") ?? (searchWorkers ? 1 : settings.search?.queryWorkers ?? 1);
  const indexWorkers = positiveIntEnv(env, "OPTSIDIAN_SEARCH_INDEX_WORKERS") ?? (searchWorkers ? 1 : settings.search?.indexWorkers ?? 1);
  return normalizeSearchRuntimeProfile({
    schemaVersion: SEARCH_RUNTIME_PROFILE_SCHEMA_VERSION,
    analyzer: {
      mode: analyzerMode(env, settings),
      extraLangs: extraLangs(env, settings),
      kiwiModel: {
        nlpVersion: KIWI_NLP_VERSION,
        modelVersion: KIWI_MODEL_VERSION,
        modelType: KIWI_MODEL_TYPE
      }
    },
    index: {
      ngram: searchNgramEnabled(env, settings)
    },
    embedding: {
      model: embeddingModel(env, settings)
    },
    ranking: {
      denseLambda: nonNegativeFloatEnv(env, "OPTSIDIAN_SEARCH_DENSE_LAMBDA") ?? settings.search?.denseLambda ?? SEARCH_SCORING_LAMBDAS.dense,
      linkLambda: nonNegativeFloatEnv(env, "OPTSIDIAN_SEARCH_LINK_LAMBDA") ?? settings.search?.linkLambda ?? SEARCH_SCORING_LAMBDAS.link,
      rrfK: positiveIntEnv(env, "OPTSIDIAN_SEARCH_RRF_K") ?? settings.search?.rrfK ?? DEFAULT_RRF_K
    },
    workers: {
      query: queryWorkers,
      index: indexWorkers,
      searchExecution: positiveIntEnv(env, "OPTSIDIAN_SEARCH_EXECUTION_WORKERS") ?? searchWorkers ?? settings.search?.executionWorkers ?? defaultSearchExecutionWorkerCount(),
      analyzerMicrobatch: positiveIntEnv(env, "OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH") ?? 16,
      indexMicrobatch: positiveIntEnv(env, "OPTSIDIAN_SEARCH_INDEX_MICROBATCH") ?? 128
    },
    cache: {
      queryAnalysisEntries: nonNegativeIntEnv(env, "OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE") ?? settings.search?.queryCacheSize ?? DEFAULT_QUERY_ANALYSIS_CACHE_ENTRIES,
      snapshotRetention: positiveIntEnv(env, "OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT") ?? settings.search?.snapshotRetentionCount ?? 2,
      executionSnapshots: positiveIntEnv(env, "OPTSIDIAN_SEARCH_EXECUTION_CACHE_SNAPSHOTS") ?? 2
    },
    memory: {
      ...optionalNumber("snapshotCountCap", positiveIntEnv(env, "OPTSIDIAN_SEARCH_MEMORY_BUDGET_COUNT") ??
        positiveIntEnv(env, "OPTSIDIAN_SEARCH_SNAPSHOT_COUNT_CAP") ??
        settings.search?.memoryBudgetCount),
      ...optionalNumber("snapshotByteCap", positiveIntEnv(env, "OPTSIDIAN_SEARCH_MEMORY_BUDGET_BYTES") ??
        positiveIntEnv(env, "OPTSIDIAN_SEARCH_SNAPSHOT_BYTE_CAP") ??
        settings.search?.memoryBudgetBytes),
      ...optionalNumber("workerHeapGuardMb", positiveIntEnv(env, "OPTSIDIAN_SEARCH_WORKER_HEAP_GUARD_MB") ??
        positiveIntEnv(env, "OPTSIDIAN_SEARCH_WORKER_MEMORY_MB")),
      ...optionalNumber("workerRssGuardMb", positiveIntEnv(env, "OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_MB")),
      ...optionalNumber("workerRssGuardStrikes", positiveIntEnv(env, "OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_STRIKES"))
    },
    daemon: {
      idleMs: nonNegativeIntEnv(env, "OPTSIDIAN_SEARCH_DAEMON_IDLE_MS") ?? settings.search?.daemonIdleMs ?? 5 * 60 * 1000
    }
  });
}

export function normalizeSearchRuntimeProfile(value: unknown): SearchRuntimeProfile {
  if (!isRecord(value)) throw new Error("search runtime profile must be an object");
  const analyzer = asRecord(value.analyzer, "search runtime profile analyzer");
  const index = optionalRecord(value.index, "search runtime profile index");
  const embedding = optionalRecord(value.embedding, "search runtime profile embedding");
  const ranking = optionalRecord(value.ranking, "search runtime profile ranking");
  const workers = asRecord(value.workers, "search runtime profile workers");
  const cache = asRecord(value.cache, "search runtime profile cache");
  const memory = asRecord(value.memory, "search runtime profile memory");
  const daemon = asRecord(value.daemon, "search runtime profile daemon");
  const mode = stringValue(analyzer.mode, "search runtime analyzer mode").trim().toLowerCase();
  if (mode !== "intl" && mode !== "kiwi") throw new Error("search runtime analyzer mode must be intl or kiwi");
  return {
    schemaVersion: SEARCH_RUNTIME_PROFILE_SCHEMA_VERSION,
    analyzer: {
      mode,
      extraLangs: [...new Set(stringList(analyzer.extraLangs).map((part) => part.trim().toLowerCase()).filter(Boolean))].sort(),
      kiwiModel: {
        nlpVersion: stringValue(asRecord(analyzer.kiwiModel, "search runtime kiwi model").nlpVersion, "kiwi nlp version"),
        modelVersion: stringValue(asRecord(analyzer.kiwiModel, "search runtime kiwi model").modelVersion, "kiwi model version"),
        modelType: stringValue(asRecord(analyzer.kiwiModel, "search runtime kiwi model").modelType, "kiwi model type")
      }
    },
    index: {
      ngram: booleanValue(index.ngram ?? false, "search runtime ngram")
    },
    embedding: {
      model: normalizeEmbeddingModel(embedding.model ?? "bge-m3", "search runtime embedding model")
    },
    ranking: {
      denseLambda: nonNegativeFloat(ranking.denseLambda ?? SEARCH_SCORING_LAMBDAS.dense, "dense lambda"),
      linkLambda: nonNegativeFloat(ranking.linkLambda ?? SEARCH_SCORING_LAMBDAS.link, "link lambda"),
      rrfK: positiveInt(ranking.rrfK ?? DEFAULT_RRF_K, "RRF k")
    },
    workers: {
      query: positiveInt(workers.query, "query workers"),
      index: positiveInt(workers.index, "index workers"),
      searchExecution: positiveInt(workers.searchExecution, "search execution workers"),
      analyzerMicrobatch: positiveInt(workers.analyzerMicrobatch, "analyzer microbatch"),
      indexMicrobatch: positiveInt(workers.indexMicrobatch, "index microbatch")
    },
    cache: {
      queryAnalysisEntries: nonNegativeInt(cache.queryAnalysisEntries, "query analysis cache entries"),
      snapshotRetention: positiveInt(cache.snapshotRetention, "snapshot retention"),
      executionSnapshots: positiveInt(cache.executionSnapshots, "execution snapshot cache")
    },
    memory: {
      ...optionalNumber("snapshotCountCap", optionalPositiveInt(memory.snapshotCountCap, "snapshot count cap")),
      ...optionalNumber("snapshotByteCap", optionalPositiveInt(memory.snapshotByteCap, "snapshot byte cap")),
      ...optionalNumber("workerHeapGuardMb", optionalPositiveInt(memory.workerHeapGuardMb, "worker heap guard")),
      ...optionalNumber("workerRssGuardMb", optionalPositiveInt(memory.workerRssGuardMb, "worker rss guard")),
      ...optionalNumber("workerRssGuardStrikes", optionalPositiveInt(memory.workerRssGuardStrikes, "worker rss guard strikes"))
    },
    daemon: {
      idleMs: nonNegativeInt(daemon.idleMs, "daemon idle ms")
    }
  };
}

export function searchRuntimeProfileHash(profile: SearchRuntimeProfile): string {
  return sha256(canonicalJson(normalizeSearchRuntimeProfile(profile)));
}

export function envForSearchRuntimeProfile(profile: SearchRuntimeProfile, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = normalizeSearchRuntimeProfile(profile);
  return cleanEnv({
    ...baseEnv,
    OPTSIDIAN_SEARCH_ANALYZER: normalized.analyzer.mode,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: normalized.analyzer.extraLangs.join(","),
    OPTSIDIAN_SEARCH_NGRAM: normalized.index.ngram ? "true" : "false",
    OPTSIDIAN_SEARCH_EMBEDDING_MODEL: normalized.embedding.model,
    OPTSIDIAN_SEARCH_DENSE_LAMBDA: String(normalized.ranking.denseLambda),
    OPTSIDIAN_SEARCH_LINK_LAMBDA: String(normalized.ranking.linkLambda),
    OPTSIDIAN_SEARCH_RRF_K: String(normalized.ranking.rrfK),
    OPTSIDIAN_SEARCH_QUERY_WORKERS: String(normalized.workers.query),
    OPTSIDIAN_SEARCH_INDEX_WORKERS: String(normalized.workers.index),
    OPTSIDIAN_SEARCH_WORKERS: String(normalized.workers.searchExecution),
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: String(normalized.workers.searchExecution),
    OPTSIDIAN_SEARCH_ANALYZER_MICROBATCH: String(normalized.workers.analyzerMicrobatch),
    OPTSIDIAN_SEARCH_INDEX_MICROBATCH: String(normalized.workers.indexMicrobatch),
    OPTSIDIAN_SEARCH_QUERY_CACHE_SIZE: String(normalized.cache.queryAnalysisEntries),
    OPTSIDIAN_SEARCH_SNAPSHOT_RETENTION_COUNT: String(normalized.cache.snapshotRetention),
    OPTSIDIAN_SEARCH_EXECUTION_CACHE_SNAPSHOTS: String(normalized.cache.executionSnapshots),
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: String(normalized.daemon.idleMs),
    OPTSIDIAN_SEARCH_MEMORY_BUDGET_COUNT: optionalEnv(normalized.memory.snapshotCountCap),
    OPTSIDIAN_SEARCH_SNAPSHOT_COUNT_CAP: optionalEnv(normalized.memory.snapshotCountCap),
    OPTSIDIAN_SEARCH_MEMORY_BUDGET_BYTES: optionalEnv(normalized.memory.snapshotByteCap),
    OPTSIDIAN_SEARCH_SNAPSHOT_BYTE_CAP: optionalEnv(normalized.memory.snapshotByteCap),
    OPTSIDIAN_SEARCH_WORKER_HEAP_GUARD_MB: optionalEnv(normalized.memory.workerHeapGuardMb),
    OPTSIDIAN_SEARCH_WORKER_MEMORY_MB: optionalEnv(normalized.memory.workerHeapGuardMb),
    OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_MB: optionalEnv(normalized.memory.workerRssGuardMb),
    OPTSIDIAN_SEARCH_WORKER_RSS_GUARD_STRIKES: optionalEnv(normalized.memory.workerRssGuardStrikes)
  });
}

export function settingsForSearchRuntimeProfile(profile: SearchRuntimeProfile): OptsidianSettings {
  const normalized = normalizeSearchRuntimeProfile(profile);
  const search: SearchSettings = {
    analyzer: normalized.analyzer.mode,
    extraLangs: normalized.analyzer.extraLangs,
    ngram: normalized.index.ngram,
    queryWorkers: normalized.workers.query,
    indexWorkers: normalized.workers.index,
    executionWorkers: normalized.workers.searchExecution,
    snapshotRetentionCount: normalized.cache.snapshotRetention,
    queryCacheSize: normalized.cache.queryAnalysisEntries,
    daemonIdleMs: normalized.daemon.idleMs,
    embeddingModel: normalized.embedding.model,
    denseLambda: normalized.ranking.denseLambda,
    linkLambda: normalized.ranking.linkLambda,
    rrfK: normalized.ranking.rrfK
  };
  if (normalized.memory.snapshotCountCap !== undefined) search.memoryBudgetCount = normalized.memory.snapshotCountCap;
  if (normalized.memory.snapshotByteCap !== undefined) search.memoryBudgetBytes = normalized.memory.snapshotByteCap;
  return { search };
}

function analyzerMode(env: NodeJS.ProcessEnv, settings: OptsidianSettings): "intl" | "kiwi" {
  const raw = env.OPTSIDIAN_SEARCH_ANALYZER ?? settings.search?.analyzer ?? "intl";
  const mode = raw.trim().toLowerCase();
  if (mode === "intl" || mode === "kiwi") return mode;
  return "intl";
}

function extraLangs(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string[] {
  const raw = env.OPTSIDIAN_SEARCH_EXTRA_LANGS;
  const values = raw !== undefined ? raw.split(",") : settings.search?.extraLangs ?? [];
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function embeddingModel(env: NodeJS.ProcessEnv, settings: OptsidianSettings): "bge-m3" | "multilingual-e5-small" {
  return normalizeEmbeddingModel(env.OPTSIDIAN_SEARCH_EMBEDDING_MODEL ?? settings.search?.embeddingModel ?? "bge-m3", "search embedding model");
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return asRecord(value, label);
}

function positiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  return optionalPositiveInt(env[key], key);
}

function nonNegativeIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  return optionalNonNegativeInt(env[key], key);
}

function nonNegativeFloatEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  return optionalNonNegativeFloat(env[key], key);
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return positiveInt(value, label);
}

function optionalNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return nonNegativeInt(value, label);
}

function optionalNonNegativeFloat(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return nonNegativeFloat(value, label);
}

function positiveInt(value: unknown, label: string): number {
  const number = nonNegativeInt(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function nonNegativeInt(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function nonNegativeFloat(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function normalizeEmbeddingModel(value: unknown, label: string): "bge-m3" | "multilingual-e5-small" {
  const raw = stringValue(String(value), label).trim().toLowerCase();
  if (raw === "bge" || raw === "bge-m3" || raw === "baai/bge-m3") return "bge-m3";
  if (raw === "e5" || raw === "e5-small" || raw === "multilingual-e5-small" || raw === "intfloat/multilingual-e5-small") {
    return "multilingual-e5-small";
  }
  throw new Error(`${label} must be bge-m3 or multilingual-e5-small`);
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("search runtime profile string list must be an array");
  return value.map((part) => stringValue(part, "search runtime profile list item")).filter(Boolean);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  throw new Error(`${label} must be true or false`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function optionalNumber<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: number };
}

function optionalEnv(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
