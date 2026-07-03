import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirSync, writePrivateFileAtomicSync } from "../core/private-path.js";
import { createProcessToken, processTokenEquals, type ProcessToken } from "../core/lifecycle/process-token.js";
import type { CurrentWriterToken, TenancyFenceProvider } from "../core/lifecycle/conditional-commit.js";
import {
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type TenancySlot,
  type TenancyRecord
} from "./protocol.js";

export const OWNER_RECORD_FIELDS = [
  "slot",
  "epoch",
  "incarnationId",
  "binaryVersion",
  "pid",
  "socketPath",
  "startedAt"
] as const;

export type OwnerRecord = TenancyRecord;

export type DesiredOwnerIdentity = {
  uid: number;
  runtimeHash: string;
  binaryVersion: string;
  protocolVersion: number;
};

export type OwnerRegistry = {
  runtimeDir: string;
  ownerPath: string;
  readOwner(): OwnerRecord | undefined;
  writeOwner(record: OwnerRecord): void;
  removeOwner(record?: OwnerRecord): void;
  compatibleOwners?(desired?: DesiredOwnerIdentity): OwnerRecord[];
};

export type CreateOwnerRegistryOptions = {
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  desired: DesiredOwnerIdentity;
};

export class SearchDaemonOwnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchDaemonOwnerError";
    this.code = code;
  }
}

const DAEMON_SCOPE_HASH_PREFIX_LENGTH = 24;

export function createOwnerRegistry(options: CreateOwnerRegistryOptions): OwnerRegistry {
  const runtimeDir = options.runtimeDir ?? defaultSearchDaemonRuntimeDir(options.env);
  ensurePrivateDirSync(runtimeDir, "Optsidian search daemon runtime directory");
  const stem = ownerRegistryStem(options.desired);
  const ownerPath = path.join(runtimeDir, `${stem}.owner`);
  return {
    runtimeDir,
    ownerPath,
    readOwner: () => readOwnerFile(ownerPath),
    writeOwner: (record) => writeOwnerFile(ownerPath, record),
    removeOwner: (record) => removeOwnerFile(ownerPath, record),
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
  const configured = env.XDG_RUNTIME_DIR?.trim();
  const runtimeBase = configured ? configured : path.join(os.tmpdir(), `optsidian-${uid}`);
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

export function randomIncarnationId(): string {
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
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION
  };
}

export function socketPathForOwner(
  runtimeDir: string,
  desired: DesiredOwnerIdentity
): string {
  const name = `optsidian-search-daemon-v${desired.protocolVersion}-${desired.uid}-${daemonScopeHash(desired.runtimeHash)}.sock`;
  const candidate = path.join(runtimeDir, name);
  if (candidate.length < 100) return candidate;
  const socketDir = path.join(os.tmpdir(), `od-${desired.uid}-${sha256(path.resolve(runtimeDir)).slice(0, 12)}`);
  ensurePrivateDirSync(socketDir, "Optsidian search daemon socket directory");
  return path.join(socketDir, name);
}

export function createOwnerRecord(
  desired: DesiredOwnerIdentity,
  socketPath: string,
  epoch: number,
  incarnationId: string,
  pid = process.pid,
  startedAt = new Date().toISOString()
): OwnerRecord {
  return {
    slot: {
      uid: desired.uid,
      runtimeHash: desired.runtimeHash,
      protocolVersion: desired.protocolVersion
    },
    epoch,
    incarnationId,
    binaryVersion: desired.binaryVersion,
    pid,
    socketPath,
    startedAt
  };
}

export function nextOwnerEpoch(registry: Pick<OwnerRegistry, "readOwner">): number {
  return (registry.readOwner()?.epoch ?? 0) + 1;
}

export function createBindBackedTenancyFenceProvider(
  registry: Pick<OwnerRegistry, "readOwner">,
  owner: OwnerRecord,
  claimId: string,
  processToken: ProcessToken = createProcessToken(owner.pid)
): TenancyFenceProvider & { readonly writerToken: CurrentWriterToken } {
  const writerToken: CurrentWriterToken = {
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    claimId,
    processToken
  };
  return {
    writerToken,
    currentWriterToken() {
      const current = registry.readOwner();
      if (!current || !sameOwnerIncarnation(current, owner)) return undefined;
      if (!processTokenEquals(writerToken.processToken, processToken)) return undefined;
      return writerToken;
    }
  };
}

export function sameOwnerIncarnation(left: OwnerRecord, right: OwnerRecord): boolean {
  return left.epoch === right.epoch &&
    left.incarnationId === right.incarnationId &&
    left.socketPath === right.socketPath &&
    ownerSlotEquals(left, right);
}

function ownerSlotEquals(left: OwnerRecord, right: OwnerRecord): boolean {
  return left.slot.uid === right.slot.uid &&
    left.slot.runtimeHash === right.slot.runtimeHash &&
    left.slot.protocolVersion === right.slot.protocolVersion;
}

export function ownerMatchesDesired(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  return ownerSharesDesiredSlot(owner, desired)
    && owner.binaryVersion === desired.binaryVersion;
}

export function ownerSharesDesiredSlot(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  return owner.slot.uid === desired.uid
    && owner.slot.runtimeHash === desired.runtimeHash
    && owner.slot.protocolVersion === desired.protocolVersion;
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

export async function convergeOnCompatibleDaemonForTests(
  registry: OwnerRegistry,
  desired: DesiredOwnerIdentity
): Promise<{ owner: OwnerRecord; replaced: boolean }> {
  const current = registry.readOwner();
  if (current && ownerMatchesDesired(current, desired)) {
    return { owner: current, replaced: false };
  }
  const owner = createOwnerRecord(
    desired,
    socketPathForOwner(registry.runtimeDir, desired),
    (current?.epoch ?? 0) + 1,
    randomIncarnationId(),
    process.pid
  );
  registry.writeOwner(owner);
  return { owner, replaced: Boolean(current) };
}

export function createOwnerRegistryForTests(options: {
  scenario: string;
  desired: DesiredOwnerIdentity;
}): OwnerRegistry {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-owner-registry-test-"));
  const registry = createOwnerRegistry({ runtimeDir, desired: options.desired });
  const incompatible = (overrides: Partial<OwnerRecord>): OwnerRecord => ({
    ...createOwnerRecord(options.desired, socketPathForOwner(runtimeDir, options.desired), 1, "stale", 999999),
    ...overrides
  });

  switch (options.scenario) {
    case "protocol-mismatch": {
      const peerDesired = {
        ...options.desired,
        protocolVersion: options.desired.protocolVersion + 1
      };
      createOwnerRegistry({ runtimeDir, desired: peerDesired }).writeOwner(
        createOwnerRecord(peerDesired, socketPathForOwner(runtimeDir, peerDesired), 1, "stale", 999999)
      );
      break;
    }
    case "binary-mismatch":
      registry.writeOwner(incompatible({ binaryVersion: "old-binary-version" }));
      break;
    case "stale-pid-lock":
      registry.writeOwner(incompatible({ pid: 999999, incarnationId: "stale" }));
      break;
    case "orphaned-socket":
      registry.writeOwner(incompatible({
        socketPath: path.join(runtimeDir, "missing.sock"),
        incarnationId: "stale"
      }));
      break;
    case "simultaneous-cold-starts":
      break;
    default:
      throw new Error(`Unknown owner-registry test scenario: ${options.scenario}`);
  }
  return registry;
}

function ownerRegistryStem(desired: DesiredOwnerIdentity): string {
  return `search-daemon-v${desired.protocolVersion}-${desired.uid}-${daemonScopeHash(desired.runtimeHash)}`;
}

function daemonScopeHash(runtimeHash: string): string {
  return sha256(runtimeHash).slice(0, DAEMON_SCOPE_HASH_PREFIX_LENGTH);
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
  writePrivateFileAtomicSync(ownerPath, `${JSON.stringify(record, null, 2)}\n`, "Optsidian search daemon owner file");
}

function removeOwnerFile(ownerPath: string, record?: OwnerRecord): void {
  if (record) {
    const current = readOwnerFile(ownerPath);
    if (!current || current.epoch !== record.epoch || current.incarnationId !== record.incarnationId) return;
  }
  try {
    fs.rmSync(ownerPath, { force: true });
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
}

function isOwnerRecord(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isSlot(record.slot) &&
    Number.isInteger(record.epoch) &&
    typeof record.incarnationId === "string" &&
    typeof record.binaryVersion === "string" &&
    Number.isInteger(record.pid) &&
    typeof record.socketPath === "string" &&
    typeof record.startedAt === "string";
}

function isSlot(value: unknown): value is TenancySlot {
  if (!value || typeof value !== "object") return false;
  const slot = value as Record<string, unknown>;
  return Number.isInteger(slot.uid) &&
    typeof slot.runtimeHash === "string" &&
    Number.isInteger(slot.protocolVersion);
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

function isNoEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
