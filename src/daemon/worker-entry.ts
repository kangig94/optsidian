import { isMainThread, parentPort, workerData, type TransferListItem } from "node:worker_threads";
import { analyzeSearchQuery, type SearchTextAnalysisOptions } from "../core/search/analysis/index.js";
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer } from "../core/search/analyzer.js";
import type { IndexAffectingSearchSettings } from "../core/search/index-settings.js";
import { readOptsidianSettings } from "../core/settings.js";
import type { SearchIndexProgressUpdate } from "./protocol.js";
import {
  buildCanonicalSearchSnapshot,
  parseBuildDocumentBatch,
  reduceBuildSegment
} from "./search-store/builder.js";
import {
  executeSearchJob,
  executeSearchShardJob,
  preloadSearchExecutionSnapshot,
  searchExecutionCacheStats,
  type SearchExecutionJob,
  type SearchExecutionSnapshotHandle,
  type SearchShardExecutionJob
} from "./search-execution.js";

type WorkerEnvelope = {
  id: number;
  request: {
    type: string;
    payload?: unknown;
  };
};

type WorkerContext = {
  optsidianSearchWorker?: boolean;
  kind?: "analyzer" | "search";
  env?: NodeJS.ProcessEnv;
};

let analyzer: SearchAnalyzer | undefined;
let searchDaemonWorkerProcessErrorHandlersInstalled = false;

export async function runSearchDaemonWorker(): Promise<void> {
  if (isMainThread || !parentPort) return;
  const context = workerData as WorkerContext;
  if (context.optsidianSearchWorker !== true) return;
  installSearchDaemonWorkerProcessErrorHandlers();
  const env = context.env ?? process.env;
  parentPort.on("message", (message: WorkerEnvelope) => {
    void handleMessage(message, context, env);
  });
}

async function handleMessage(message: WorkerEnvelope, context: WorkerContext, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const result = await dispatch(message.request.type, message.request.payload, context, env, (progress) => {
      const memory = workerLocalMemoryUsage();
      parentPort?.postMessage({
        id: message.id,
        progress,
        memory,
        memoryRss: memory.rss
      });
    });
    const memory = workerLocalMemoryUsage();
    const response = {
      id: message.id,
      ok: true,
      result,
      memory,
      memoryRss: memory.rss
    };
    parentPort?.postMessage(response, transferListForWorkerResult(result));
  } catch (error) {
    const memory = workerLocalMemoryUsage();
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: {
        code: (error as { code?: unknown } | undefined)?.code,
        message: error instanceof Error ? error.message : String(error)
      },
      memory,
      memoryRss: memory.rss
    });
  }
}

function workerLocalMemoryUsage(): NodeJS.MemoryUsage {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers
  };
}

async function dispatch(
  type: string,
  payload: unknown,
  context: WorkerContext,
  env: NodeJS.ProcessEnv,
  progress: (progress: SearchIndexProgressUpdate) => void
): Promise<unknown> {
  if (type === "warmup") {
    if (context.kind === "analyzer") {
      const activeAnalyzer = analyzerForWorker(env);
      return withSearchAnalyzerLease(activeAnalyzer, async (leased) => {
        await leased.tokenizeBatch(["warmup latin", "한국어"]);
        return { analyzerIdentity: leased.identity };
      }, undefined, {
        wait: true,
        installIfMissing: true
      });
    }
    return { ready: true };
  }
  if (context.kind === "search") {
    if (type === "search") return executeSearchJob(payload as SearchExecutionJob);
    if (type === "searchShard") return executeSearchShardJob(payload as SearchShardExecutionJob);
    if (type === "preloadSnapshot") return preloadSearchExecutionSnapshot(payload as SearchExecutionSnapshotHandle);
    if (type === "searchExecutionStats") return searchExecutionCacheStats();
    throw Object.assign(new Error(`unsupported search worker job: ${type}`), { code: "BAD_REQUEST" });
  }
  if (context.kind !== "analyzer") {
    throw Object.assign(new Error(`unsupported worker kind: ${String(context.kind)}`), { code: "BAD_REQUEST" });
  }
  const activeAnalyzer = analyzerForWorker(env);
  if (type === "analyzeQuery") {
    const input = payload as { rawQuery: string; options?: SearchTextAnalysisOptions };
    return withSearchAnalyzerLease(activeAnalyzer, async (leased) => ({
      analyzerIdentity: leased.identity,
      analysis: await analyzeSearchQuery(input.rawQuery, leased, input.options)
    }), undefined, { wait: true, installIfMissing: true });
  }
  if (type === "tokenizeBatch") {
    const input = payload as { texts: string[] };
    return withSearchAnalyzerLease(activeAnalyzer, async (leased) => ({
      analyzerIdentity: leased.identity,
      tokens: await leased.tokenizeBatch(input.texts)
    }), undefined, { wait: true, installIfMissing: true });
  }
  if (type === "buildSnapshot") {
    const input = payload as {
      vaultRoot: string;
      partitionBits?: number;
      searchSettings?: Partial<IndexAffectingSearchSettings>;
    };
    return withSearchAnalyzerLease(activeAnalyzer, (leased) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer: leased,
        searchSettings: input.searchSettings,
        partitionBits: input.partitionBits,
        progress
      }), undefined, { wait: true, installIfMissing: true });
  }
  if (type === "parseBuildDocuments") {
    const input = payload as {
      vaultRoot: string;
      relPaths: readonly string[];
      partitionBits: number;
      searchSettings: IndexAffectingSearchSettings;
    };
    return withSearchAnalyzerLease(activeAnalyzer, (leased) =>
      parseBuildDocumentBatch(input, leased), undefined, { wait: true, installIfMissing: true });
  }
  if (type === "reduceBuildSegment") {
    const input = payload as Parameters<typeof reduceBuildSegment>[0];
    return reduceBuildSegment(input);
  }
  throw Object.assign(new Error(`unsupported analyzer worker job: ${type}`), { code: "BAD_REQUEST" });
}

function analyzerForWorker(env: NodeJS.ProcessEnv): SearchAnalyzer {
  analyzer ??= resolveSearchAnalyzer(env, readOptsidianSettings(process.cwd(), env), {
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {})
  });
  return analyzer;
}

function installSearchDaemonWorkerProcessErrorHandlers(): void {
  if (searchDaemonWorkerProcessErrorHandlersInstalled) return;
  searchDaemonWorkerProcessErrorHandlersInstalled = true;
  process.on("uncaughtException", (error) => {
    logSearchDaemonWorkerProcessError("uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logSearchDaemonWorkerProcessError("unhandledRejection", reason);
    process.exit(1);
  });
}

function logSearchDaemonWorkerProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error && error.stack ? error.stack : String(error);
  try {
    process.stderr.write(`[optsidian search worker] ${kind}: ${message}\n`);
  } catch {}
}

function transferListForWorkerResult(result: unknown): TransferListItem[] {
  const buffers = new Set<ArrayBuffer>();
  if (isObjectRecord(result)) {
    addUint8ArrayTransfer(buffers, result.bytes);
    addUint8ArrayTransfer(buffers, result.canonicalManifestBytes);
    const segments = result.segments;
    if (Array.isArray(segments)) {
      for (const segment of segments) {
        if (isObjectRecord(segment)) addUint8ArrayTransfer(buffers, segment.bytes);
      }
    }
  }
  return [...buffers];
}

function addUint8ArrayTransfer(buffers: Set<ArrayBuffer>, value: unknown): void {
  if (!(value instanceof Uint8Array)) return;
  if (!(value.buffer instanceof ArrayBuffer)) return;
  buffers.add(value.buffer);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
