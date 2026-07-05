import { spawn } from 'node:child_process';
import os from 'node:os';

export const VRAM_PROBE_TTL_MS = 60_000;
const VRAM_PROBE_TIMEOUT_MS = 500;
const VRAM_PROBE_CIRCUIT_BREAKER_FAILURES = 3;
const VRAM_PROBE_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

const MIB_BYTES = 1024 * 1024;
const NVIDIA_SMI_COMMAND = 'nvidia-smi';
const NVIDIA_SMI_FREE_MEMORY_ARGS = ['--query-gpu=memory.free', '--format=csv,noheader,nounits'] as const;

export type VramProbeResult = {
  freeBytes: number;
  totalBytes?: number;
  atMs?: number;
  fresh?: boolean;
  error?: string;
};

type VramProbeExec = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal: AbortSignal },
) => string | Buffer | Uint8Array | Promise<string | Buffer | Uint8Array>;

export type VramProbeOptions = {
  now?: () => number;
  exec?: VramProbeExec;
  platform?: NodeJS.Platform | string;
  freeMemoryBytes?: () => number;
  timeoutMs?: number;
  circuitBreakerFailures?: number;
  circuitBreakerCooldownMs?: number;
};

type CacheEntry = {
  atMs: number;
  freeBytes: number;
};

export function parseNvidiaSmiFreeMemoryBytes(output: string | Buffer | Uint8Array): number {
  const text = outputToString(output);
  const values = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line));

  if (values.length === 0) return 0;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return 0;

  // Multiple GPUs report one value per line. Use the minimum free memory as the conservative gate.
  return Math.floor(Math.min(...values) * MIB_BYTES);
}

export function createVramProbe(options: VramProbeOptions = {}): () => Promise<VramProbeResult> {
  const now = options.now ?? Date.now;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const freeMemoryBytes = options.freeMemoryBytes ?? os.freemem;
  const timeoutMs = options.timeoutMs ?? VRAM_PROBE_TIMEOUT_MS;
  const circuitBreakerFailures = Math.max(
    1,
    Math.floor(options.circuitBreakerFailures ?? VRAM_PROBE_CIRCUIT_BREAKER_FAILURES),
  );
  const circuitBreakerCooldownMs = Math.max(
    1,
    Math.floor(options.circuitBreakerCooldownMs ?? VRAM_PROBE_CIRCUIT_BREAKER_COOLDOWN_MS),
  );
  let cache: CacheEntry | undefined;
  let consecutiveFailures = 0;
  let circuitOpenUntilMs: number | undefined;

  return async () => {
    const atMs = now();
    if (cache && atMs - cache.atMs < VRAM_PROBE_TTL_MS) return vramProbeResult(cache.freeBytes, cache.atMs, false);

    if (circuitOpenUntilMs !== undefined && atMs < circuitOpenUntilMs) {
      return staleVramProbeResult(cache, atMs, 'vram probe circuit breaker open');
    }

    try {
      const freeBytes = await probeFreeBytes({ exec, platform, freeMemoryBytes, timeoutMs });
      consecutiveFailures = 0;
      circuitOpenUntilMs = undefined;
      cache = { atMs, freeBytes };
      return vramProbeResult(freeBytes, atMs, true);
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= circuitBreakerFailures) circuitOpenUntilMs = atMs + circuitBreakerCooldownMs;
      return staleVramProbeResult(cache, atMs, error instanceof Error ? error.message : String(error));
    }
  };
}

async function probeFreeBytes(options: {
  exec: VramProbeExec;
  platform: NodeJS.Platform | string;
  freeMemoryBytes: () => number;
  timeoutMs: number;
}): Promise<number> {
  if (options.platform === 'linux') return probeLinuxFreeBytes(options.exec, options.timeoutMs);
  if (options.platform === 'darwin') return safeFreemem(options.freeMemoryBytes);
  return 0;
}

async function probeLinuxFreeBytes(exec: VramProbeExec, timeoutMs = VRAM_PROBE_TIMEOUT_MS): Promise<number> {
  return parseNvidiaSmiFreeMemoryBytes(
    await execWithTimeout(exec, NVIDIA_SMI_COMMAND, NVIDIA_SMI_FREE_MEMORY_ARGS, timeoutMs),
  );
}

function safeFreemem(freeMemoryBytes: () => number): number {
  try {
    const freeBytes = freeMemoryBytes();
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.floor(freeBytes) : 0;
  } catch {
    return 0;
  }
}

function defaultExec(command: string, args: readonly string[], options: { signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stdout: Buffer[] = [];
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill('SIGKILL');
    };

    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.on('close', (code, signal) => {
      settle(() => {
        if (options.signal.aborted) {
          reject(new Error(`nvidia-smi probe aborted${signal ? ` by ${signal}` : ''}`));
          return;
        }
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        reject(new Error(`nvidia-smi exited with code ${code ?? 'unknown'}`));
      });
    });
  });
}

async function execWithTimeout(
  exec: VramProbeExec,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | Buffer | Uint8Array> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const execPromise = Promise.resolve(exec(command, args, { timeoutMs, signal: controller.signal }));
  execPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`nvidia-smi probe timed out after ${timeoutMs}ms`));
      reject(new Error(`nvidia-smi probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!timedOut) controller.abort(new Error('nvidia-smi probe completed'));
  }
}

function outputToString(output: string | Buffer | Uint8Array): string {
  if (typeof output === 'string') return output;
  return Buffer.from(output).toString('utf8');
}

function vramProbeResult(freeBytes: number, atMs: number, fresh: boolean): VramProbeResult {
  const result: VramProbeResult = { freeBytes };
  Object.defineProperties(result, {
    atMs: { value: atMs, enumerable: false },
    fresh: { value: fresh, enumerable: false },
  });
  return result;
}

function staleVramProbeResult(cache: CacheEntry | undefined, atMs: number, error: string): VramProbeResult {
  const result = cache ? vramProbeResult(cache.freeBytes, cache.atMs, false) : vramProbeResult(0, atMs, false);
  Object.defineProperty(result, 'error', { value: error, enumerable: false });
  return result;
}
