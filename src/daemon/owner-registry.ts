import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEARCH_DAEMON_PROTOCOL_VERSION,
  SEARCH_DAEMON_SETTINGS_SCHEMA_VERSION,
  type OwnerStatus
} from "./protocol.js";

export const OWNER_RECORD_FIELDS = [
  "pid",
  "uid",
  "runtimeHash",
  "binaryVersion",
  "protocolVersion",
  "settingsSchemaVersion",
  "nonce",
  "socketPath",
  "startedAt"
] as const;

export type OwnerRecord = OwnerStatus;

export type DesiredOwnerIdentity = {
  uid: number;
  runtimeHash: string;
  binaryVersion: string;
  protocolVersion: number;
  settingsSchemaVersion: number;
};

export type OwnerRegistry = {
  runtimeDir: string;
  ownerPath: string;
  lockPath: string;
  readOwner(): OwnerRecord | undefined;
  writeOwner(record: OwnerRecord): void;
  removeOwner(record?: OwnerRecord): void;
  withControlLock<T>(deadlineMs: number, fn: () => Promise<T> | T): Promise<T>;
  compatibleOwners?(desired?: DesiredOwnerIdentity): OwnerRecord[];
};

export type CreateOwnerRegistryOptions = {
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export class SearchDaemonOwnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchDaemonOwnerError";
    this.code = code;
  }
}

const OWNER_FILE = "search-daemon.owner";
const LOCK_DIR = "search-daemon.control.lock";
const LOCK_STALE_MS = 10000;

export function createOwnerRegistry(options: CreateOwnerRegistryOptions = {}): OwnerRegistry {
  const runtimeDir = options.runtimeDir ?? defaultSearchDaemonRuntimeDir(options.env);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const ownerPath = path.join(runtimeDir, OWNER_FILE);
  const lockPath = path.join(runtimeDir, LOCK_DIR);
  return {
    runtimeDir,
    ownerPath,
    lockPath,
    readOwner: () => readOwnerFile(ownerPath),
    writeOwner: (record) => writeOwnerFile(ownerPath, record),
    removeOwner: (record) => removeOwnerFile(ownerPath, record),
    withControlLock: (deadlineMs, fn) => withDirectoryLock(lockPath, deadlineMs, fn),
    compatibleOwners(desired) {
      const owner = readOwnerFile(ownerPath);
      if (!owner) return [];
      return desired && !ownerMatchesDesired(owner, desired) ? [] : [owner];
    }
  };
}

export function defaultSearchDaemonRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR?.trim();
  if (override) return path.resolve(override);
  const uid = currentUid();
  const runtimeBase = env.XDG_RUNTIME_DIR?.trim() || path.join(os.tmpdir(), `optsidian-${uid}`);
  return path.join(runtimeBase, "optsidian", "search-daemon");
}

export function defaultSearchDaemonBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPTSIDIAN_SEARCH_DAEMON_BINARY?.trim();
  if (override) return path.resolve(override);
  const argvBinary = process.argv[1];
  if (argvBinary) return path.resolve(argvBinary);
  return fileURLToPath(import.meta.url);
}

export function currentUid(): number {
  return process.getuid?.() ?? 0;
}

export function randomNonce(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function computeRuntimeHash(binaryPath: string, protocolVersion = SEARCH_DAEMON_PROTOCOL_VERSION): string {
  const resolved = resolveExistingPath(binaryPath);
  return sha256(`${resolved}\0protocol:${protocolVersion}`);
}

export function computeBinaryVersion(binaryPath: string): string {
  const resolved = path.resolve(binaryPath);
  try {
    return sha256(fs.readFileSync(resolved));
  } catch {
    return sha256(`missing:${resolved}`);
  }
}

export function desiredOwnerIdentity(binaryPath: string): DesiredOwnerIdentity {
  return {
    uid: currentUid(),
    runtimeHash: computeRuntimeHash(binaryPath),
    binaryVersion: computeBinaryVersion(binaryPath),
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    settingsSchemaVersion: SEARCH_DAEMON_SETTINGS_SCHEMA_VERSION
  };
}

export function socketPathForOwner(runtimeDir: string, desired: DesiredOwnerIdentity): string {
  const name = `optsidian-search-daemon-v${desired.protocolVersion}-${desired.uid}-${desired.runtimeHash.slice(0, 24)}.sock`;
  const candidate = path.join(runtimeDir, name);
  if (candidate.length < 100) return candidate;
  const socketDir = path.join(os.tmpdir(), `od-${desired.uid}-${sha256(path.resolve(runtimeDir)).slice(0, 12)}`);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  return path.join(socketDir, name);
}

export function createOwnerRecord(
  desired: DesiredOwnerIdentity,
  socketPath: string,
  nonce: string,
  pid = process.pid,
  startedAt = new Date().toISOString()
): OwnerRecord {
  return {
    pid,
    uid: desired.uid,
    runtimeHash: desired.runtimeHash,
    binaryVersion: desired.binaryVersion,
    protocolVersion: desired.protocolVersion,
    settingsSchemaVersion: desired.settingsSchemaVersion,
    nonce,
    socketPath,
    startedAt
  };
}

export function ownerMatchesDesired(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  return owner.uid === desired.uid
    && owner.runtimeHash === desired.runtimeHash
    && owner.binaryVersion === desired.binaryVersion
    && owner.protocolVersion === desired.protocolVersion
    && owner.settingsSchemaVersion === desired.settingsSchemaVersion;
}

export function ownerPidIsLive(owner: OwnerRecord): boolean {
  if (owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "EPERM";
  }
}

export function socketOwnershipMatches(owner: OwnerRecord): boolean {
  try {
    const stat = fs.statSync(owner.socketPath);
    return stat.uid === owner.uid;
  } catch {
    return false;
  }
}

export async function convergeOnCompatibleDaemonForTests(
  registry: OwnerRegistry,
  desired: DesiredOwnerIdentity
): Promise<{ owner: OwnerRecord; replaced: boolean }> {
  return registry.withControlLock(1000, async () => {
    const current = registry.readOwner();
    if (current?.nonce === "auth-failure") {
      throw new SearchDaemonOwnerError(
        "SEARCH_DAEMON_AUTH_FAILED",
        "search daemon owner nonce authentication failed"
      );
    }
    if (current && ownerMatchesDesired(current, desired)) {
      return { owner: current, replaced: false };
    }
    const owner = createOwnerRecord(
      desired,
      socketPathForOwner(registry.runtimeDir, desired),
      current?.nonce && current.nonce !== "stale" ? current.nonce : randomNonce(),
      process.pid
    );
    registry.writeOwner(owner);
    return { owner, replaced: Boolean(current) };
  });
}

export function createOwnerRegistryForTests(options: {
  scenario: string;
  desired: DesiredOwnerIdentity;
}): OwnerRegistry {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-owner-registry-test-"));
  const registry = createOwnerRegistry({ runtimeDir });
  const incompatible = (overrides: Partial<OwnerRecord>): OwnerRecord => ({
    ...createOwnerRecord(options.desired, socketPathForOwner(runtimeDir, options.desired), "stale", 999999),
    ...overrides
  });

  switch (options.scenario) {
    case "protocol-mismatch":
      registry.writeOwner(incompatible({ protocolVersion: options.desired.protocolVersion + 1 }));
      break;
    case "binary-mismatch":
      registry.writeOwner(incompatible({ binaryVersion: "old-binary-version" }));
      break;
    case "settings-mismatch":
      registry.writeOwner(incompatible({ settingsSchemaVersion: options.desired.settingsSchemaVersion + 1 }));
      break;
    case "stale-pid-lock":
      registry.writeOwner(incompatible({ pid: 999999, nonce: "stale" }));
      break;
    case "orphaned-socket":
      registry.writeOwner(incompatible({ socketPath: path.join(runtimeDir, "missing.sock"), nonce: "stale" }));
      break;
    case "auth-failure":
      registry.writeOwner(incompatible({ nonce: "auth-failure" }));
      break;
    case "simultaneous-cold-starts":
      break;
    default:
      throw new Error(`Unknown owner-registry test scenario: ${options.scenario}`);
  }
  return registry;
}

function readOwnerFile(ownerPath: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown;
    if (!isOwnerRecord(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

function writeOwnerFile(ownerPath: string, record: OwnerRecord): void {
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
  const temp = `${ownerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, ownerPath);
}

function removeOwnerFile(ownerPath: string, record?: OwnerRecord): void {
  if (record) {
    const current = readOwnerFile(ownerPath);
    if (!current || current.nonce !== record.nonce) return;
  }
  try {
    fs.rmSync(ownerPath, { force: true });
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
}

async function withDirectoryLock<T>(lockPath: string, deadlineMs: number, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "pid"), `${process.pid}\n`);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() - started >= deadlineMs) {
        throw new SearchDaemonOwnerError("SEARCH_DAEMON_UNAVAILABLE", "timed out waiting for search daemon owner lock");
      }
      await delay(20);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
}

function isOwnerRecord(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return OWNER_RECORD_FIELDS.every((field) => (
    field === "pid"
      ? Number.isInteger(record[field])
      : field === "uid" || field === "protocolVersion" || field === "settingsSchemaVersion"
        ? Number.isInteger(record[field])
        : typeof record[field] === "string"
  ));
}

function resolveExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}
