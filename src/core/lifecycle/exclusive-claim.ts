import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, writePrivateFileSync } from "../private-path.js";
import {
  createProcessToken,
  defaultProcessStartIdentityProvider,
  isAlive as defaultIsAlive,
  processStartIdIsAuthoritative,
  processTokenEquals,
  type ProcessStartIdentityProvider,
  type ProcessToken
} from "./process-token.js";

export type ExclusiveClaimOwner = {
  token: ProcessToken;
  claimId: string;
  acquiredAtMs: number;
};

export type ExclusiveClaimAcquireOptions = {
  token?: ProcessToken;
  claimId?: string;
  timeoutMs?: number;
  pollMs?: number;
  backstopTtlMs?: number;
  now?: () => number;
  startIdentityProvider?: ProcessStartIdentityProvider;
  isAlive?: (token: ProcessToken) => boolean;
};

export type ExclusiveClaimReclaimOptions = {
  backstopTtlMs?: number;
  now?: () => number;
  isAlive?: (token: ProcessToken) => boolean;
};

export class ExclusiveClaimBusyError extends Error {
  readonly owner: ExclusiveClaimOwner | undefined;

  constructor(claimDir: string, owner: ExclusiveClaimOwner | undefined) {
    super(owner ? `Exclusive claim is held by live pid ${owner.token.pid}: ${claimDir}` : `Exclusive claim is busy: ${claimDir}`);
    this.name = "ExclusiveClaimBusyError";
    this.owner = owner;
  }
}

export class ExclusiveClaim {
  readonly claimDir: string;
  readonly token: ProcessToken;
  readonly claimId: string;
  readonly acquiredAtMs: number;

  private released = false;

  private constructor(claimDir: string, owner: ExclusiveClaimOwner) {
    this.claimDir = claimDir;
    this.token = owner.token;
    this.claimId = owner.claimId;
    this.acquiredAtMs = owner.acquiredAtMs;
  }

  static async acquire(claimDir: string, options: ExclusiveClaimAcquireOptions = {}): Promise<ExclusiveClaim> {
    const now = options.now ?? Date.now;
    const pollMs = options.pollMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const token = options.token ?? createProcessToken(process.pid, options.startIdentityProvider ?? defaultProcessStartIdentityProvider);
    const owner: ExclusiveClaimOwner = {
      token,
      claimId: options.claimId ?? crypto.randomUUID(),
      acquiredAtMs: now()
    };
    const startedAt = now();

    while (true) {
      if (tryCreateClaim(claimDir, owner)) return new ExclusiveClaim(claimDir, owner);
      const reclaimed = reclaimExclusiveClaim(claimDir, {
        backstopTtlMs: options.backstopTtlMs,
        now,
        isAlive: options.isAlive
      });
      if (reclaimed) continue;

      if (now() - startedAt >= timeoutMs) {
        throw new ExclusiveClaimBusyError(claimDir, readExclusiveClaimOwner(claimDir));
      }
      await sleep(pollMs);
    }
  }

  get owner(): ExclusiveClaimOwner {
    return {
      token: this.token,
      claimId: this.claimId,
      acquiredAtMs: this.acquiredAtMs
    };
  }

  release(): boolean {
    if (this.released) return false;
    const current = readExclusiveClaimOwner(this.claimDir);
    if (!current || current.claimId !== this.claimId || !processTokenEquals(current.token, this.token)) return false;
    fs.rmSync(this.claimDir, { recursive: true, force: true });
    fsyncDirSync(path.dirname(this.claimDir));
    this.released = true;
    return true;
  }
}

export function reclaimExclusiveClaim(claimDir: string, options: ExclusiveClaimReclaimOptions = {}): boolean {
  const now = options.now ?? Date.now;
  const owner = readExclusiveClaimOwner(claimDir);
  if (owner) {
    const alive = (options.isAlive ?? defaultIsAlive)(owner.token);
    // A live holder is protected ONLY when its start-id is authoritative (proves this is the same
    // process, not a pid-reuse impostor). If the holder merely appears alive under an unverified
    // start-id (non-Linux), liveness is unprovable — fall through to the wall-clock TTL backstop so
    // a dead, pid-reused holder can still be reclaimed instead of deadlocking the claim forever.
    if (alive && processStartIdIsAuthoritative(owner.token.startId)) return false;
    if (!alive) {
      removeClaimDir(claimDir);
      return true;
    }
    return reclaimByTtl(claimDir, now, options.backstopTtlMs);
  }

  if (!fs.existsSync(claimDir)) return false;
  return reclaimByTtl(claimDir, now, options.backstopTtlMs);
}

function reclaimByTtl(claimDir: string, now: () => number, backstopTtlMs = 60_000): boolean {
  if (!Number.isFinite(backstopTtlMs)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(claimDir);
  } catch {
    return false;
  }
  if (now() - stat.mtimeMs < backstopTtlMs) return false;
  removeClaimDir(claimDir);
  return true;
}

export function readExclusiveClaimOwner(claimDir: string): ExclusiveClaimOwner | undefined {
  const ownerPath = path.join(claimDir, "owner.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return undefined;
  }
  if (!isExclusiveClaimOwner(parsed)) return undefined;
  return parsed;
}

function tryCreateClaim(claimDir: string, owner: ExclusiveClaimOwner): boolean {
  ensurePrivateDirSync(path.dirname(claimDir), "Exclusive claim parent directory");
  try {
    fs.mkdirSync(claimDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }

  try {
    ensurePrivateDirSync(claimDir, "Exclusive claim directory");
    writeOwner(claimDir, owner);
    fsyncDirSync(path.dirname(claimDir));
    return true;
  } catch (error) {
    fs.rmSync(claimDir, { recursive: true, force: true });
    throw error;
  }
}

function writeOwner(claimDir: string, owner: ExclusiveClaimOwner): void {
  const ownerPath = path.join(claimDir, "owner.json");
  writePrivateFileSync(ownerPath, `${JSON.stringify(owner)}\n`, "Exclusive claim owner file");
  fsyncFileSync(ownerPath);
  fsyncDirSync(claimDir);
}

function removeClaimDir(claimDir: string): void {
  fs.rmSync(claimDir, { recursive: true, force: true });
  fsyncDirSync(path.dirname(claimDir));
}

function isExclusiveClaimOwner(value: unknown): value is ExclusiveClaimOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<ExclusiveClaimOwner>;
  return (
    typeof owner.claimId === "string" &&
    Number.isFinite(owner.acquiredAtMs) &&
    isProcessToken(owner.token)
  );
}

function isProcessToken(value: unknown): value is ProcessToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<ProcessToken>;
  return Number.isSafeInteger(token.pid) && typeof token.startId === "string" && token.startId.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fsyncFileSync(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirSync(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (process.platform === "win32" && errorCode(error) === "EISDIR") return;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
