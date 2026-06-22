import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeError, UsageError } from "../errors.js";
import { resolveVaultPathInput } from "../native/obsidian.js";
import { OPTSIDIAN_VERSION } from "../version.js";
import { warmSearchIndexes } from "./search/index.js";
import { readOptsidianSettings } from "./settings.js";
import type { SearchIndexWarmResult } from "./types.js";
import { recentVaultAccessRoots } from "./vault-access.js";

export type SearchIndexDaemonWarmTarget =
  | { kind: "recent" }
  | { kind: "vault"; vaultRoot: string };

type IndexDaemonMethod = "warmRecent" | "warmVault" | "status" | "shutdown";

type IndexDaemonRequest = {
  id: number;
  method: IndexDaemonMethod;
  params?: {
    vaultRoot?: string;
  };
};

type IndexDaemonResponse =
  | { id: number; result: IndexDaemonCommandResult }
  | { id: number; error: { message: string } };

type IndexDaemonCommandResult =
  | { accepted: true; status: IndexDaemonStatus }
  | { shuttingDown: true; status: IndexDaemonStatus };

type IndexDaemonStatus = {
  pid: number;
  running: boolean;
  queued: number;
  active: boolean;
  lastRun?: SearchIndexWarmResult;
  lastError?: string;
};

type IndexDaemonJob =
  | { kind: "recent" }
  | { kind: "vault"; vaultRoot: string };

const INDEX_DAEMON_PROTOCOL_VERSION = "v1";
const INDEX_DAEMON_RUNTIME_IDENTITY = stableHash(
  JSON.stringify({
    protocol: INDEX_DAEMON_PROTOCOL_VERSION,
    optsidian: OPTSIDIAN_VERSION,
    node: process.versions.node
  })
).slice(0, 16);
const INDEX_DAEMON_BIN_ENV = "OPTSIDIAN_INDEX_DAEMON_BIN";
const INDEX_DAEMON_ENABLE_ENV = "OPTSIDIAN_INDEX_DAEMON";
const INDEX_DAEMON_IDLE_ENV = "OPTSIDIAN_INDEX_DAEMON_IDLE_MS";
const INDEX_DAEMON_POLL_ENV = "OPTSIDIAN_INDEX_DAEMON_POLL_MS";
const INDEX_DAEMON_REQUEST_TIMEOUT_ENV = "OPTSIDIAN_INDEX_DAEMON_REQUEST_TIMEOUT_MS";
const INDEX_WARM_CONCURRENCY_ENV = "OPTSIDIAN_INDEX_WARM_CONCURRENCY";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_ONESHOT_IDLE_MS = 30 * 1000;
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 750;
const DEFAULT_INDEX_WARM_CONCURRENCY = 2;
const STARTUP_TIMEOUT_MS = 2000;
const INDEX_DAEMON_COMMAND = "__index-daemon";

let requestId = 0;

export function searchIndexDaemonCommand(): string {
  return INDEX_DAEMON_COMMAND;
}

export function pokeSearchIndexDaemonWarmRecent(env: NodeJS.ProcessEnv = process.env): void {
  if (indexDaemonDisabled(env)) return;
  if (!fs.existsSync(indexDaemonPaths(env).socketPath)) {
    spawnSearchIndexDaemon(env);
    return;
  }
  void requestSearchIndexDaemon("warmRecent", undefined, env).catch(() => {
    // Best-effort background indexing must never change the foreground command outcome.
  });
}

export function pokeSearchIndexDaemonWarmOnce(target: SearchIndexDaemonWarmTarget, env: NodeJS.ProcessEnv = process.env): void {
  if (indexDaemonDisabled(env)) return;
  const method = target.kind === "vault" ? "warmVault" : "warmRecent";
  const params = target.kind === "vault" ? { vaultRoot: target.vaultRoot } : undefined;
  void requestSearchIndexDaemon(method, params, env, { oneShot: true }).catch(() => {
    // Best-effort background indexing must never change the foreground command outcome.
  });
}

export async function runSearchIndexDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = indexDaemonPaths(env);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const idleMs = parsePositiveIntegerEnv(env[INDEX_DAEMON_IDLE_ENV], DEFAULT_IDLE_MS, INDEX_DAEMON_IDLE_ENV);
  const pollMs = parseNonNegativeIntegerEnv(env[INDEX_DAEMON_POLL_ENV], DEFAULT_POLL_MS, INDEX_DAEMON_POLL_ENV);
  const warmConcurrency = indexWarmConcurrency(env);
  const sockets = new Set<net.Socket>();
  const queue: IndexDaemonJob[] = [];
  let active = false;
  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let lastRequestAt = Date.now();
  let lastRun: SearchIndexWarmResult | undefined;
  let lastError: string | undefined;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    lastRequestAt = Date.now();
    clearIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(socket, line);
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
  });

  function status(): IndexDaemonStatus {
    return {
      pid: process.pid,
      running: !closing,
      queued: queue.length,
      active,
      ...(lastRun ? { lastRun } : {}),
      ...(lastError ? { lastError } : {})
    };
  }

  function handleLine(socket: net.Socket, line: string): void {
    let request: IndexDaemonRequest | undefined;
    try {
      request = JSON.parse(line) as IndexDaemonRequest;
      if (typeof request.id !== "number") throw new Error("invalid index daemon request id");
      lastRequestAt = Date.now();
      clearIdleTimer();

      if (request.method === "warmRecent") {
        enqueue({ kind: "recent" });
        writeResult(socket, request.id, { accepted: true, status: status() });
        return;
      }
      if (request.method === "warmVault") {
        const vaultRoot = request.params?.vaultRoot;
        if (!vaultRoot) throw new Error("warmVault requires vaultRoot");
        enqueue({ kind: "vault", vaultRoot: resolveVaultPathInput(vaultRoot) });
        writeResult(socket, request.id, { accepted: true, status: status() });
        return;
      }
      if (request.method === "status") {
        writeResult(socket, request.id, { accepted: true, status: status() });
        return;
      }
      if (request.method === "shutdown") {
        writeResult(socket, request.id, { shuttingDown: true, status: status() });
        closeDaemon();
        return;
      }
      throw new Error("unsupported index daemon request");
    } catch (error) {
      writeError(socket, typeof request?.id === "number" ? request.id : 0, error);
    }
  }

  function writeResult(socket: net.Socket, id: number, result: IndexDaemonCommandResult): void {
    socket.write(`${JSON.stringify({ id, result })}\n`);
  }

  function writeError(socket: net.Socket, id: number, error: unknown): void {
    socket.write(`${JSON.stringify({ id, error: { message: errorMessage(error) } })}\n`);
  }

  function enqueue(job: IndexDaemonJob): void {
    clearPollTimer();
    if (job.kind === "recent") {
      if (queue.some((entry) => entry.kind === "recent")) return;
      queue.push(job);
    } else if (!queue.some((entry) => entry.kind === "vault" && entry.vaultRoot === job.vaultRoot)) {
      queue.push(job);
    }
    void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    if (active || closing) return;
    active = true;
    try {
      while (queue.length > 0 && !closing) {
        const job = queue.shift();
        if (!job) continue;
        try {
          lastRun = job.kind === "recent"
            ? await warmRecentVaults(env, warmConcurrency)
            : await warmSearchIndexes([job.vaultRoot], [], { fastNoop: true });
          lastError = undefined;
        } catch (error) {
          lastError = errorMessage(error);
        }
      }
    } finally {
      active = false;
      schedulePoll();
      armIdleTimer();
    }
  }

  function schedulePoll(): void {
    if (closing || pollMs < 1) return;
    const remainingIdleMs = idleMs - (Date.now() - lastRequestAt);
    if (remainingIdleMs <= 0) return;
    clearPollTimer();
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      enqueue({ kind: "recent" });
    }, Math.min(pollMs, remainingIdleMs));
    pollTimer.unref();
  }

  function armIdleTimer(): void {
    if (closing || sockets.size > 0) return;
    clearIdleTimer();
    const remaining = Math.max(1, idleMs - (Date.now() - lastRequestAt));
    idleTimer = setTimeout(() => {
      if (active) {
        armIdleTimer();
        return;
      }
      closeDaemon();
    }, remaining);
    idleTimer.unref();
  }

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function clearPollTimer(): void {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function closeDaemon(): void {
    if (closing) return;
    closing = true;
    clearIdleTimer();
    clearPollTimer();
    server.close();
    for (const socket of sockets) socket.destroy();
  }

  await listen(server, paths.socketPath);
  enqueue({ kind: "recent" });
  armIdleTimer();

  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  if (process.platform !== "win32") {
    fs.rmSync(paths.socketPath, { force: true });
  }
}

async function warmRecentVaults(env: NodeJS.ProcessEnv, concurrency: number): Promise<SearchIndexWarmResult> {
  return warmSearchIndexes(recentVaultAccessRoots({ env }), [], { fastNoop: true, concurrency });
}

async function requestSearchIndexDaemon(
  method: IndexDaemonMethod,
  params: IndexDaemonRequest["params"] | undefined,
  env: NodeJS.ProcessEnv,
  spawnOptions: SearchIndexDaemonSpawnOptions = {}
): Promise<IndexDaemonCommandResult> {
  try {
    return await requestRunningSearchIndexDaemon(method, params, env);
  } catch (error) {
    cleanupStaleSocketForError(error, env);
    spawnSearchIndexDaemon(env, spawnOptions);
  }

  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    await sleep(50);
    try {
      return await requestRunningSearchIndexDaemon(method, params, env);
    } catch (error) {
      lastError = error;
    }
  }
  throw new RuntimeError(`Search index daemon is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function requestRunningSearchIndexDaemon(
  method: IndexDaemonMethod,
  params: IndexDaemonRequest["params"] | undefined,
  env: NodeJS.ProcessEnv
): Promise<IndexDaemonCommandResult> {
  const request: IndexDaemonRequest = {
    id: ++requestId,
    method,
    ...(params ? { params } : {})
  };
  const response = await sendIndexDaemonRequest(indexDaemonPaths(env).socketPath, request, env);
  if ("error" in response) throw new RuntimeError(response.error.message);
  return response.result;
}

function sendIndexDaemonRequest(
  socketPath: string,
  request: IndexDaemonRequest,
  env: NodeJS.ProcessEnv
): Promise<IndexDaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeError("Search index daemon request timed out"));
    }, parsePositiveIntegerEnv(env[INDEX_DAEMON_REQUEST_TIMEOUT_ENV], DEFAULT_REQUEST_TIMEOUT_MS, INDEX_DAEMON_REQUEST_TIMEOUT_ENV));
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
        resolve(JSON.parse(buffer.slice(0, newline)) as IndexDaemonResponse);
      } catch (error) {
        reject(new RuntimeError(`Search index daemon returned invalid JSON: ${errorMessage(error)}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

type SearchIndexDaemonSpawnOptions = {
  oneShot?: boolean;
};

function spawnSearchIndexDaemon(env: NodeJS.ProcessEnv, options: SearchIndexDaemonSpawnOptions = {}): void {
  const bin = env[INDEX_DAEMON_BIN_ENV] || process.argv[1];
  if (!bin) return;
  const childEnv = options.oneShot
    ? {
        ...env,
        [INDEX_DAEMON_POLL_ENV]: env[INDEX_DAEMON_POLL_ENV] ?? "0",
        [INDEX_DAEMON_IDLE_ENV]: env[INDEX_DAEMON_IDLE_ENV] ?? String(DEFAULT_ONESHOT_IDLE_MS)
      }
    : env;
  const child = spawn(process.execPath, [bin, INDEX_DAEMON_COMMAND], {
    detached: true,
    stdio: "ignore",
    env: childEnv
  });
  child.unref();
}

function indexDaemonPaths(env: NodeJS.ProcessEnv): { runtimeDir: string; socketPath: string } {
  const base = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `optsidian-${process.getuid?.() ?? "user"}`);
  const runtimeDir = path.join(base, "optsidian");
  if (process.platform === "win32") {
    const key = stableHash(`${runtimeDir}:${INDEX_DAEMON_PROTOCOL_VERSION}:${INDEX_DAEMON_RUNTIME_IDENTITY}`).slice(0, 16);
    return { runtimeDir, socketPath: `\\\\.\\pipe\\optsidian-index-${key}` };
  }
  return { runtimeDir, socketPath: path.join(runtimeDir, `index-${INDEX_DAEMON_PROTOCOL_VERSION}-${INDEX_DAEMON_RUNTIME_IDENTITY}.sock`) };
}

export function __searchIndexDaemonSocketPathForTests(env: NodeJS.ProcessEnv = process.env): string {
  return indexDaemonPaths(env).socketPath;
}

function cleanupStaleSocketForError(error: unknown, env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") return;
  if (!isConnectionRefused(error)) return;
  fs.rmSync(indexDaemonPaths(env).socketPath, { force: true });
}

function indexDaemonDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[INDEX_DAEMON_ENABLE_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a positive integer`);
  return Math.max(1, Number(raw));
}

function parseNonNegativeIntegerEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(raw);
}

function indexWarmConcurrency(env: NodeJS.ProcessEnv): number {
  const settings = readOptsidianSettings(process.cwd(), env);
  return parsePositiveIntegerEnv(
    env[INDEX_WARM_CONCURRENCY_ENV],
    settings.search?.indexWarmConcurrency ?? DEFAULT_INDEX_WARM_CONCURRENCY,
    INDEX_WARM_CONCURRENCY_ENV
  );
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ECONNREFUSED";
}

function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
