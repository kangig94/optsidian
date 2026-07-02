import fs from "node:fs";

export type ProcessToken = {
  pid: number;
  startId: string;
};

export type ProcessStartIdentityProvider = {
  readStartId(pid: number): string | undefined;
};

export type IsAliveOptions = {
  startIdentityProvider?: ProcessStartIdentityProvider;
};

// A start-id carrying this prefix could not be tied to a real process start time, so it cannot
// distinguish an original process from a later process that reused the same pid. `isAlive` still
// works for the original holder, but reclaim logic must NOT treat such a token as proof of liveness
// (see `processStartIdIsAuthoritative` / `reclaimExclusiveClaim`) — it falls through to the TTL
// backstop instead, so a dead-but-pid-reused holder can never permanently deadlock a claim.
export const UNVERIFIED_START_ID_PREFIX = "unverified:";

export function processStartIdIsAuthoritative(startId: string): boolean {
  return !startId.startsWith(UNVERIFIED_START_ID_PREFIX);
}

export const defaultProcessStartIdentityProvider: ProcessStartIdentityProvider = {
  readStartId(pid: number): string | undefined {
    assertValidPid(pid);
    // Linux exposes an authoritative per-process start time via /proc; other platforms have no cheap
    // native-free equivalent, so we emit an explicitly-unverified sentinel and let the claim TTL
    // backstop guard pid reuse there.
    if (process.platform === "linux") return readLinuxProcStartTime(pid) ?? `${UNVERIFIED_START_ID_PREFIX}${pid}`;
    return `${UNVERIFIED_START_ID_PREFIX}${pid}`;
  }
};

export function createProcessToken(
  pid = process.pid,
  startIdentityProvider: ProcessStartIdentityProvider = defaultProcessStartIdentityProvider
): ProcessToken {
  assertValidPid(pid);
  const startId = startIdentityProvider.readStartId(pid);
  if (!startId) throw new Error(`Cannot read process start identity for pid ${pid}.`);
  return { pid, startId };
}

export function readProcessStartId(
  pid: number,
  startIdentityProvider: ProcessStartIdentityProvider = defaultProcessStartIdentityProvider
): string | undefined {
  assertValidPid(pid);
  return startIdentityProvider.readStartId(pid);
}

export function isAlive(token: ProcessToken, options: IsAliveOptions = {}): boolean {
  assertValidPid(token.pid);
  if (!processExists(token.pid)) return false;
  const provider = options.startIdentityProvider ?? defaultProcessStartIdentityProvider;
  return provider.readStartId(token.pid) === token.startId;
}

export function processTokenEquals(left: ProcessToken, right: ProcessToken): boolean {
  return left.pid === right.pid && left.startId === right.startId;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function readLinuxProcStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fieldsFromState = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsFromState[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return undefined;
    throw error;
  }
}

function assertValidPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id: ${pid}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
