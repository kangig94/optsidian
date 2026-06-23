import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { analyzeSearchQuery } from "../core/search/analysis/index.js";
import { resolveSearchAnalyzer, withSearchAnalyzerLease, type SearchAnalyzer } from "../core/search/analyzer.js";
import { readOptsidianSettings } from "../core/settings.js";
import { buildCanonicalSearchSnapshot } from "./search-store/builder.js";
import { executeSearchJob, type SearchExecutionJob } from "./search-execution.js";

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
    const result = await dispatch(message.request.type, message.request.payload, context, env);
    parentPort?.postMessage({
      id: message.id,
      ok: true,
      result,
      memoryRss: process.memoryUsage().rss
    });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: {
        code: (error as { code?: unknown } | undefined)?.code,
        message: error instanceof Error ? error.message : String(error)
      },
      memoryRss: process.memoryUsage().rss
    });
  }
}

async function dispatch(type: string, payload: unknown, context: WorkerContext, env: NodeJS.ProcessEnv): Promise<unknown> {
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
    if (type !== "search") throw Object.assign(new Error(`unsupported search worker job: ${type}`), { code: "BAD_REQUEST" });
    return executeSearchJob(payload as SearchExecutionJob);
  }
  if (context.kind !== "analyzer") {
    throw Object.assign(new Error(`unsupported worker kind: ${String(context.kind)}`), { code: "BAD_REQUEST" });
  }
  const activeAnalyzer = analyzerForWorker(env);
  if (type === "analyzeQuery") {
    const input = payload as { rawQuery: string };
    return withSearchAnalyzerLease(activeAnalyzer, async (leased) => ({
      analyzerIdentity: leased.identity,
      analysis: await analyzeSearchQuery(input.rawQuery, leased)
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
    const input = payload as { vaultRoot: string; partitionBits?: number };
    return withSearchAnalyzerLease(activeAnalyzer, (leased) =>
      buildCanonicalSearchSnapshot({
        vaultRoot: input.vaultRoot,
        analyzer: leased,
        partitionBits: input.partitionBits
      }), undefined, { wait: true, installIfMissing: true });
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
