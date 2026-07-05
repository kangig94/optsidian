import { execFileSync } from 'node:child_process';
import os from 'node:os';

export const VRAM_PROBE_TTL_MS = 60_000;

const MIB_BYTES = 1024 * 1024;
const NVIDIA_SMI_COMMAND = 'nvidia-smi';
const NVIDIA_SMI_FREE_MEMORY_ARGS = ['--query-gpu=memory.free', '--format=csv,noheader,nounits'] as const;

export type VramProbeResult = {
  freeBytes: number;
  totalBytes?: number;
  atMs?: number;
  fresh?: boolean;
};

type VramProbeExec = (command: string, args: readonly string[]) => string | Buffer | Uint8Array;

export type VramProbeOptions = {
  now?: () => number;
  exec?: VramProbeExec;
  platform?: NodeJS.Platform | string;
  freeMemoryBytes?: () => number;
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

export function createVramProbe(options: VramProbeOptions = {}): () => VramProbeResult {
  const now = options.now ?? Date.now;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const freeMemoryBytes = options.freeMemoryBytes ?? os.freemem;
  let cache: CacheEntry | undefined;

  return () => {
    const atMs = now();
    if (cache && atMs - cache.atMs < VRAM_PROBE_TTL_MS) return vramProbeResult(cache.freeBytes, cache.atMs, false);

    const freeBytes = probeFreeBytes({ exec, platform, freeMemoryBytes });
    cache = { atMs, freeBytes };
    return vramProbeResult(freeBytes, atMs, true);
  };
}

function probeFreeBytes(options: {
  exec: VramProbeExec;
  platform: NodeJS.Platform | string;
  freeMemoryBytes: () => number;
}): number {
  if (options.platform === 'linux') return probeLinuxFreeBytes(options.exec);
  if (options.platform === 'darwin') return safeFreemem(options.freeMemoryBytes);
  return 0;
}

function probeLinuxFreeBytes(exec: VramProbeExec): number {
  try {
    return parseNvidiaSmiFreeMemoryBytes(exec(NVIDIA_SMI_COMMAND, NVIDIA_SMI_FREE_MEMORY_ARGS));
  } catch {
    return 0;
  }
}

function safeFreemem(freeMemoryBytes: () => number): number {
  try {
    const freeBytes = freeMemoryBytes();
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.floor(freeBytes) : 0;
  } catch {
    return 0;
  }
}

function defaultExec(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
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
