import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeError, UsageError } from "../errors.js";

export type SearchAnalyzerIdentity = {
  name: string;
  version: string;
  runtime?: string;
  node: string;
  icu?: string;
  model?: string;
  optionsHash?: string;
};

export type SearchAnalyzer = {
  identity: SearchAnalyzerIdentity;
  tokenize(text: string): Promise<string[]>;
  tokenizeBatch(texts: readonly string[]): Promise<string[][]>;
};

type AnalyzerRequest = {
  id: number;
  method: "tokenizeBatch";
  params: {
    analyzer: SearchAnalyzerSelector;
    texts: string[];
  };
};

type SearchAnalyzerSelector = {
  name: string;
  version?: string;
  model?: string;
  optionsHash?: string;
};

type AnalyzerResponse =
  | { id: number; result: { analyzer: SearchAnalyzerIdentity; tokens: string[][] } }
  | { id: number; error: { message: string } };

const ANALYZER_VERSION = "intl-segmenter-v1";
const ANALYZER_MODE_ENV = "OPTSIDIAN_SEARCH_ANALYZER";
const ANALYZER_IDLE_ENV = "OPTSIDIAN_ANALYZER_IDLE_MS";
const ANALYZER_REQUEST_TIMEOUT_ENV = "OPTSIDIAN_ANALYZER_REQUEST_TIMEOUT_MS";
const ANALYZER_BIN_ENV = "OPTSIDIAN_ANALYZER_DAEMON_BIN";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const STARTUP_TIMEOUT_MS = 2000;
const WORD_SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;

let requestId = 0;

export function resolveSearchAnalyzer(env: NodeJS.ProcessEnv = process.env): SearchAnalyzer {
  const mode = (env[ANALYZER_MODE_ENV] ?? "intl").trim().toLowerCase();
  if (mode === "intl") return createIntlAnalyzer();
  if (mode === "intl-daemon" || mode === "daemon-intl") return createDaemonAnalyzer(env);
  if (mode === "kiwi") {
    throw new UsageError("OPTSIDIAN_SEARCH_ANALYZER=kiwi is not available in this build yet");
  }
  throw new UsageError(`${ANALYZER_MODE_ENV} must be one of: intl, intl-daemon`);
}

export function analyzerCacheKey(identity: SearchAnalyzerIdentity): string {
  const name = identity.name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "analyzer";
  return name === "intl" ? "intl" : `${name}-${stableHash(analyzerIdentityKey(identity)).slice(0, 12)}`;
}

export function analyzerIdentityKey(identity: SearchAnalyzerIdentity): string {
  return stableStringify(identity);
}

export function tokensToSearchText(tokens: readonly string[]): string {
  return unique(tokens).join(" ");
}

export function tokenizeIntlText(text: string): string[] {
  const normalized = normalizeAnalyzerInput(text);
  if (!normalized) return [];
  const segmenter = intlSegmenter();
  const tokens: string[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike !== true) continue;
      for (const run of segment.segment.matchAll(WORD_SCRIPT_RUN_PATTERN)) {
        tokens.push(run[0]);
      }
    }
  } else {
    for (const run of normalized.matchAll(WORD_SCRIPT_RUN_PATTERN)) {
      tokens.push(run[0]);
    }
  }
  return unique(tokens.map((token) => token.trim()).filter(Boolean));
}

export async function runSearchAnalyzerDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = analyzerDaemonPaths(env);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const idleMs = parseIdleMs(env[ANALYZER_IDLE_ENV]);
  const sockets = new Set<net.Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  const server = net.createServer((socket) => {
    clearIdleTimer();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleAnalyzerLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      armIdleTimer();
    });
    socket.on("error", () => {
      sockets.delete(socket);
      armIdleTimer();
    });
    armIdleTimer();
  });

  function armIdleTimer(): void {
    if (sockets.size > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      server.close();
      for (const socket of sockets) socket.destroy();
    }, idleMs);
    idleTimer.unref();
  }

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.off("error", reject);
      armIdleTimer();
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  if (process.platform !== "win32") {
    fs.rmSync(paths.socketPath, { force: true });
  }
}

function createIntlAnalyzer(): SearchAnalyzer {
  return {
    identity: intlIdentity(),
    tokenize: async (text) => tokenizeIntlText(text),
    tokenizeBatch: async (texts) => texts.map((text) => tokenizeIntlText(text))
  };
}

function createDaemonAnalyzer(env: NodeJS.ProcessEnv): SearchAnalyzer {
  return {
    identity: intlIdentity(),
    tokenize: async (text) => (await requestDaemonTokenization([text], env))[0] ?? [],
    tokenizeBatch: async (texts) => requestDaemonTokenization([...texts], env)
  };
}

async function requestDaemonTokenization(texts: string[], env: NodeJS.ProcessEnv): Promise<string[][]> {
  if (texts.length === 0) return [];
  try {
    return await requestRunningDaemon(texts, env);
  } catch (error) {
    cleanupStaleSocketForError(error, env);
    spawnAnalyzerDaemon(env);
  }

  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    await sleep(50);
    try {
      return await requestRunningDaemon(texts, env);
    } catch (error) {
      lastError = error;
    }
  }
  throw new RuntimeError(`Analyzer daemon is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function requestRunningDaemon(texts: string[], env: NodeJS.ProcessEnv): Promise<string[][]> {
  const paths = analyzerDaemonPaths(env);
  const id = ++requestId;
  const request: AnalyzerRequest = { id, method: "tokenizeBatch", params: { analyzer: { name: "intl" }, texts } };
  const response = await sendAnalyzerRequest(paths.socketPath, request, env);
  if ("error" in response) {
    throw new RuntimeError(response.error.message);
  }
  const expectedIdentity = analyzerIdentityKey(intlIdentity());
  const actualIdentity = analyzerIdentityKey(response.result.analyzer);
  if (actualIdentity !== expectedIdentity) {
    throw new RuntimeError("Analyzer daemon identity does not match the active search analyzer");
  }
  return response.result.tokens;
}

function sendAnalyzerRequest(socketPath: string, request: AnalyzerRequest, env: NodeJS.ProcessEnv): Promise<AnalyzerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeError("Analyzer daemon request timed out"));
    }, parseRequestTimeoutMs(env[ANALYZER_REQUEST_TIMEOUT_ENV]));
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as AnalyzerResponse);
      } catch (error) {
        reject(new RuntimeError(`Analyzer daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function handleAnalyzerLine(socket: net.Socket, line: string): void {
  let request: AnalyzerRequest | undefined;
  try {
    request = JSON.parse(line) as AnalyzerRequest;
    if (request.method !== "tokenizeBatch" || request.params?.analyzer?.name !== "intl" || !Array.isArray(request.params.texts)) {
      throw new Error("unsupported analyzer request");
    }
    const tokens = request.params.texts.map((text) => tokenizeIntlText(String(text)));
    socket.write(`${JSON.stringify({ id: request.id, result: { analyzer: intlIdentity(), tokens } })}\n`);
  } catch (error) {
    const id = typeof request?.id === "number" ? request.id : 0;
    socket.write(`${JSON.stringify({ id, error: { message: error instanceof Error ? error.message : String(error) } })}\n`);
  }
}

function spawnAnalyzerDaemon(env: NodeJS.ProcessEnv): void {
  const bin = env[ANALYZER_BIN_ENV] || process.argv[1];
  if (!bin) throw new RuntimeError(`Cannot start analyzer daemon: ${ANALYZER_BIN_ENV} is unset and process.argv[1] is unavailable`);
  const child = spawn(process.execPath, [bin, "__analyzer-daemon"], {
    detached: true,
    stdio: "ignore",
    env
  });
  child.unref();
}

function analyzerDaemonPaths(env: NodeJS.ProcessEnv): { runtimeDir: string; socketPath: string } {
  const base = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `optsidian-${process.getuid?.() ?? "user"}`);
  const runtimeDir = path.join(base, "optsidian");
  if (process.platform === "win32") {
    const key = stableHash(runtimeDir).slice(0, 16);
    return { runtimeDir, socketPath: `\\\\.\\pipe\\optsidian-analyzer-${key}` };
  }
  return { runtimeDir, socketPath: path.join(runtimeDir, "analyzer.sock") };
}

function cleanupStaleSocketForError(error: unknown, env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") return;
  if (!isConnectionRefused(error)) return;
  const { socketPath } = analyzerDaemonPaths(env);
  fs.rmSync(socketPath, { force: true });
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ECONNREFUSED";
}

function parseIdleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MS;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${ANALYZER_IDLE_ENV} must be a non-negative integer`);
  return Math.max(1, Number(raw));
}

function parseRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${ANALYZER_REQUEST_TIMEOUT_ENV} must be a non-negative integer`);
  return Math.max(1, Number(raw));
}

function normalizeAnalyzerInput(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[#._/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function intlSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== "function") return undefined;
  return new Intl.Segmenter(undefined, { granularity: "word" });
}

function intlIdentity(): SearchAnalyzerIdentity {
  return {
    name: "intl",
    version: ANALYZER_VERSION,
    runtime: "node-intl",
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {})
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
