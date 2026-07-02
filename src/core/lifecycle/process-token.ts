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

export const defaultProcessStartIdentityProvider: ProcessStartIdentityProvider = {
  readStartId(pid: number): string | undefined {
    assertValidPid(pid);
    if (process.platform === "linux") return readLinuxProcStartTime(pid);
    return `portable-unknown:${pid}`;
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
