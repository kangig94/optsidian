import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirSync, writePrivateFileAtomicSync } from '../core/private-path.js';
import { createProcessToken, isAlive, processTokenEquals, type ProcessToken } from '../core/lifecycle/process-token.js';
import type { CurrentWriterToken, TenancyFenceProvider } from '../core/lifecycle/conditional-commit.js';
import { ExclusiveClaim, ExclusiveClaimBusyError, readExclusiveClaimOwner } from '../core/lifecycle/exclusive-claim.js';
import {
  SEARCH_DAEMON_PULSE_STALENESS_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  type SearchDaemonPhase,
  type ShutdownSupersessionPayload,
  type TenancySlot,
  type TenancyRecord,
} from './protocol.js';

export const OWNER_RECORD_FIELDS = [
  'slot',
  'epoch',
  'incarnationId',
  'binaryVersion',
  'pid',
  'socketPath',
  'startedAt',
] as const;

export type OwnerRecord = TenancyRecord;

export type OwnerPulse = {
  epoch: number;
  incarnationId: string;
  socket: string;
  phase: SearchDaemonPhase;
  pulseSeq: number;
  progressSeq: number;
  updatedAt: string;
};

export type DesiredOwnerIdentity = {
  uid: number;
  runtimeHash: string;
  runtimeScopeHash: string;
  binaryVersion: string;
  protocolVersion: number;
};

export type OwnerRegistry = {
  runtimeDir: string;
  ownerPath: string;
  readOwner(): OwnerRecord | undefined;
  writeOwner(record: OwnerRecord): void;
  readOwnerPulse(): OwnerPulse | undefined;
  writeOwnerPulse(pulse: OwnerPulse): void;
  writeOwnerAndPulse?(record: OwnerRecord, pulse: OwnerPulse): void;
  removeOwner(record?: OwnerRecord): void;
  compatibleOwners?(desired?: DesiredOwnerIdentity): OwnerRecord[];
  discoverPredecessors?(desired: DesiredOwnerIdentity, current?: OwnerRecord): VerifiedDaemonPredecessor[];
};

export type CreateOwnerRegistryOptions = {
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  desired: DesiredOwnerIdentity;
};

export type SuccessorHealthProof =
  | { kind: 'cold'; observedAtMs: number }
  | { kind: 'identity-mismatch'; observedAtMs: number; error?: unknown }
  | { kind: 'draining'; observedAtMs: number; error?: unknown }
  | { kind: 'wedged'; observedAtMs: number; startupGraceExpired?: boolean; error?: unknown };

type SuccessorClaimHandle = {
  claim: ExclusiveClaim;
  claimId: string;
  intendedOwner: OwnerRecord;
  observedOwner?: OwnerRecord;
  childEnv: Record<string, string>;
  markSpawnFailure(error: unknown): void;
};

export type TryClaimSuccessorResult =
  | { kind: 'claimed'; handle: SuccessorClaimHandle }
  | { kind: 'wait'; untilMs?: number; reason: 'claim-busy' | 'backoff' | 'not-needed' }
  | { kind: 'unavailable'; error: Error };

export type TryClaimSuccessorOptions = {
  desired: DesiredOwnerIdentity;
  intendedOwner: OwnerRecord;
  deadlineMs: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  claimId?: string;
  token?: ProcessToken;
  pollMs?: number;
  backstopTtlMs?: number;
};

type BreakerBudget = {
  maxFailures: number;
  windowMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
};

type SuccessorBreakerRecord = {
  schemaVersion: 1;
  slot: TenancySlot;
  desired: {
    binaryVersion: string;
  };
  holder?: {
    pid: number;
    incarnationId: string;
    claimId: string;
    acquiredAtMs: number;
  };
  attempts: number;
  firstFailureAtMs?: number;
  lastFailureAtMs?: number;
  backoffUntilMs?: number;
  budget: BreakerBudget;
};

export type VerifiedDaemonPredecessor = {
  owner: OwnerRecord;
  ownerPath: string;
  token: ProcessToken;
};

export type ReapedMarkerRecord = {
  schemaVersion: 1;
  supersessionId: string;
  predecessor: ShutdownSupersessionPayload['predecessor'];
  createdAtMs: number;
  createdAt: string;
};

export type SupersessionSentinelPredecessor = {
  owner: OwnerRecord;
  reapedMarkerPath: string;
};

export type SupersessionSentinel = {
  schemaVersion: 1;
  uid: number;
  runtimeScopeHash: string;
  supersessionId: string;
  successor: {
    epoch: number;
    incarnationId: string;
    pid: number;
    protocolVersion: number;
    binaryVersion: string;
  };
  predecessors: SupersessionSentinelPredecessor[];
  startedAtMs: number;
  createdAt: string;
};

const DAEMON_SCOPE_HASH_PREFIX_LENGTH = 24;
const SUCCESSOR_CLAIM_DIR_SUFFIX = '.successor.claim';
const SUCCESSOR_BREAKER_SUFFIX = '.successor-breaker.json';
const REAPED_MARKER_PREFIX = 'search-daemon-reaped';
const SUPERSESSION_SENTINEL_PREFIX = 'search-daemon-supersession';
const DEFAULT_SUCCESSOR_CLAIM_BACKSTOP_TTL_MS = 30_000;
const DEFAULT_STARTUP_GRACE_MS = 10_000;
const DEFAULT_CHURN_MAX_FAILURES = 3;
const DEFAULT_CHURN_WINDOW_MS = 60_000;
const DEFAULT_CHURN_BACKOFF_BASE_MS = 1_000;
const DEFAULT_CHURN_BACKOFF_MAX_MS = 15_000;

export function createOwnerRegistry(options: CreateOwnerRegistryOptions): OwnerRegistry {
  const runtimeDir = options.runtimeDir ?? defaultSearchDaemonRuntimeDir(options.env);
  ensurePrivateDirSync(runtimeDir, 'Optsidian search daemon runtime directory');
  const stem = ownerRegistryStem(options.desired);
  const ownerPath = path.join(runtimeDir, `${stem}.owner`);
  return {
    runtimeDir,
    ownerPath,
    readOwner: () => readOwnerFile(ownerPath),
    writeOwner: (record) => {
      writeOwnerFile(ownerPath, record);
    },
    readOwnerPulse: () => readOwnerPulse(ownerPath),
    writeOwnerPulse: (pulse) => {
      writeOwnerPulse(ownerPath, pulse);
    },
    writeOwnerAndPulse: (record, pulse) => {
      writeOwnerAndPulse(ownerPath, record, pulse);
    },
    removeOwner: (record) => {
      removeOwnerFile(ownerPath, record);
    },
    compatibleOwners(desired) {
      const owner = readOwnerFile(ownerPath);
      if (!owner) return [];
      return desired && !ownerMatchesDesired(owner, desired) ? [] : [owner];
    },
    discoverPredecessors(desired, current) {
      return discoverDaemonPredecessors(runtimeDir, desired, current);
    },
  };
}

export function defaultSearchDaemonRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR?.trim();
  if (override) return path.resolve(override);
  const uid = currentUid();
  const configured = env.XDG_RUNTIME_DIR?.trim();
  const runtimeBase = configured ? configured : path.join(os.tmpdir(), `optsidian-${uid}`);
  return path.join(runtimeBase, 'optsidian', 'search-daemon');
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
  return crypto.randomBytes(24).toString('hex');
}

export function computeRuntimeHash(binaryPath: string, protocolVersion = SEARCH_DAEMON_PROTOCOL_VERSION): string {
  const resolved = resolveExistingPath(binaryPath);
  return sha256(`${resolved}\0protocol:${protocolVersion}`);
}

export function computeRuntimeScopeHash(
  binaryPath: string,
  uid = currentUid(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.OPTSIDIAN_SEARCH_DAEMON_INSTALL_IDENTITY?.trim();
  const installIdentity = configured && configured.length > 0 ? configured : path.resolve(binaryPath);
  return sha256(`uid:${uid}\0install:${installIdentity}`);
}

export function computeBinaryVersion(binaryPath: string): string {
  const resolved = path.resolve(binaryPath);
  try {
    return sha256(fs.readFileSync(resolved));
  } catch {
    return sha256(`missing:${resolved}`);
  }
}

export function desiredOwnerIdentity(binaryPath: string, env: NodeJS.ProcessEnv = process.env): DesiredOwnerIdentity {
  const uid = currentUid();
  return {
    uid,
    runtimeHash: computeRuntimeHash(binaryPath),
    runtimeScopeHash: computeRuntimeScopeHash(binaryPath, uid, env),
    binaryVersion: computeBinaryVersion(binaryPath),
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
  };
}

export function randomSocketNonce(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function socketPathForOwner(runtimeDir: string, desired: DesiredOwnerIdentity, nonce?: string): string {
  const suffix = nonce ? `-${nonce}` : '';
  const name = `${daemonSocketStem(desired)}${suffix}.sock`;
  const candidate = path.join(runtimeDir, name);
  if (candidate.length < 100) return candidate;
  const socketDir = path.join(os.tmpdir(), `od-${desired.uid}-${sha256(path.resolve(runtimeDir)).slice(0, 12)}`);
  ensurePrivateDirSync(socketDir, 'Optsidian search daemon socket directory');
  return path.join(socketDir, name);
}

export async function sweepStaleDaemonSockets(
  runtimeDir: string,
  desired: DesiredOwnerIdentity,
  keepSocketPath: string,
  probe: (socketPath: string) => Promise<'listening' | 'refused' | 'missing' | 'unavailable'>,
): Promise<void> {
  const ownerPath = path.join(runtimeDir, `${ownerRegistryStem(desired)}.owner`);
  const socketDir = path.dirname(keepSocketPath);
  const stem = daemonSocketStem(desired);
  const entries = fs.readdirSync(socketDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(stem) || !entry.name.endsWith('.sock')) continue;
    const socketPath = path.join(socketDir, entry.name);
    if (socketPath === keepSocketPath) continue;
    if (socketPath === readOwnerFile(ownerPath)?.socketPath) continue;
    const before = lstatMaybe(socketPath);
    const verdict = await probe(socketPath);
    if (verdict === 'listening' || verdict === 'unavailable') continue;
    if (verdict === 'missing') continue;
    if (verdict === 'refused') {
      const after = lstatMaybe(socketPath);
      if (!before || !after || !sameFileStat(before, after)) continue;
    }
    if (socketPath === readOwnerFile(ownerPath)?.socketPath) continue;
    fs.rmSync(socketPath, { force: true });
  }
}

export function createOwnerRecord(
  desired: DesiredOwnerIdentity,
  socketPath: string,
  epoch: number,
  incarnationId: string,
  pid = process.pid,
  startedAt = new Date().toISOString(),
): OwnerRecord {
  return {
    slot: {
      uid: desired.uid,
      runtimeHash: desired.runtimeHash,
      runtimeScopeHash: desired.runtimeScopeHash,
      protocolVersion: desired.protocolVersion,
    },
    epoch,
    incarnationId,
    binaryVersion: desired.binaryVersion,
    pid,
    socketPath,
    startedAt,
  };
}

export function nextOwnerEpoch(registry: Pick<OwnerRegistry, 'readOwner'>): number {
  return (registry.readOwner()?.epoch ?? 0) + 1;
}

export function createBindBackedTenancyFenceProvider(
  registry: Pick<OwnerRegistry, 'readOwner'>,
  owner: OwnerRecord,
  claimId: string,
  processToken: ProcessToken = createProcessToken(owner.pid),
): TenancyFenceProvider & { readonly writerToken: CurrentWriterToken } {
  const writerToken: CurrentWriterToken = {
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    claimId,
    processToken,
  };
  return {
    writerToken,
    currentWriterToken() {
      const current = registry.readOwner();
      if (!current || !sameOwnerIncarnation(current, owner)) return undefined;
      if (!processTokenEquals(writerToken.processToken, processToken)) return undefined;
      return writerToken;
    },
  };
}

export function sameOwnerIncarnation(left: OwnerRecord, right: OwnerRecord): boolean {
  return (
    left.epoch === right.epoch &&
    left.incarnationId === right.incarnationId &&
    left.socketPath === right.socketPath &&
    ownerSlotEquals(left, right)
  );
}

function ownerSlotEquals(left: OwnerRecord, right: OwnerRecord): boolean {
  return (
    left.slot.uid === right.slot.uid &&
    left.slot.runtimeHash === right.slot.runtimeHash &&
    left.slot.runtimeScopeHash === right.slot.runtimeScopeHash &&
    left.slot.protocolVersion === right.slot.protocolVersion
  );
}

export function ownerMatchesDesired(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  return ownerSharesDesiredSlot(owner, desired) && owner.binaryVersion === desired.binaryVersion;
}

export function ownerSharesDesiredSlot(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  return (
    owner.slot.uid === desired.uid &&
    owner.slot.runtimeHash === desired.runtimeHash &&
    (owner.slot.runtimeScopeHash === undefined || owner.slot.runtimeScopeHash === desired.runtimeScopeHash) &&
    owner.slot.protocolVersion === desired.protocolVersion
  );
}

export async function tryClaimSuccessor(
  registry: OwnerRegistry,
  observedOwner: OwnerRecord | undefined,
  healthProof: SuccessorHealthProof,
  options: TryClaimSuccessorOptions,
): Promise<TryClaimSuccessorResult> {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const budget = successorBreakerBudget(env);
  const claimId = options.claimId ?? crypto.randomUUID();
  const claimDir = successorClaimDir(registry.ownerPath);
  const timeoutMs = Math.max(0, options.deadlineMs - now());
  let claim: ExclusiveClaim;
  try {
    claim = await ExclusiveClaim.acquire(claimDir, {
      claimId,
      token: options.token,
      timeoutMs,
      pollMs: options.pollMs,
      backstopTtlMs: options.backstopTtlMs ?? successorClaimBackstopTtlMs(env),
      now,
    });
  } catch (error) {
    if (error instanceof ExclusiveClaimBusyError) return { kind: 'wait', reason: 'claim-busy' };
    throw error;
  }

  try {
    const breaker = readBreakerForMutation(registry.ownerPath, options.desired, budget, now);
    if (breaker.kind === 'corrupt') {
      const error = unavailableError(
        `search daemon successor breaker is unreadable and was quarantined: ${errorMessage(breaker.error)}`,
      );
      claim.release();
      return { kind: 'unavailable', error };
    }

    const activeBreaker = breaker.record;
    if (activeBreaker.backoffUntilMs !== undefined && activeBreaker.backoffUntilMs > now()) {
      claim.release();
      return { kind: 'wait', reason: 'backoff', untilMs: activeBreaker.backoffUntilMs };
    }
    if (activeBreaker.attempts >= activeBreaker.budget.maxFailures) {
      claim.release();
      return {
        kind: 'unavailable',
        error: unavailableError(
          `search daemon successor churn budget exhausted (${activeBreaker.attempts}/${activeBreaker.budget.maxFailures} failures in ${activeBreaker.budget.windowMs}ms)`,
        ),
      };
    }

    const replacement = successorStillNeeded(registry, observedOwner, healthProof, options.desired, {
      nowMs: now(),
      startupGraceMs: startupGraceMs(env),
    });
    if (!replacement) {
      claim.release();
      return { kind: 'wait', reason: 'not-needed' };
    }

    const admitted = recordBreakerAttempt(activeBreaker, claim, options.intendedOwner, now());
    writeSuccessorBreaker(registry.ownerPath, admitted);
    return {
      kind: 'claimed',
      handle: {
        claim,
        claimId,
        intendedOwner: options.intendedOwner,
        observedOwner,
        childEnv: successorChildEnv(claimId, observedOwner, options.intendedOwner, healthProof),
        markSpawnFailure(error) {
          try {
            const { holder: _holder, ...withoutHolder } = admitted;
            const failed = {
              ...withoutHolder,
              lastFailureAtMs: now(),
            };
            writeSuccessorBreaker(registry.ownerPath, failed);
          } catch {
            // The already-recorded attempt still enforces churn; do not mask the spawn error.
          }
          claim.release();
          void error;
        },
      },
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

export function successorClaimDir(ownerPath: string): string {
  return `${ownerPath}${SUCCESSOR_CLAIM_DIR_SUFFIX}`;
}

function successorClaimBackstopTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_CLAIM_TTL_MS, DEFAULT_SUCCESSOR_CLAIM_BACKSTOP_TTL_MS);
}

export function startupGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_STARTUP_GRACE_MS, DEFAULT_STARTUP_GRACE_MS);
}

export function initialOwnerPulse(owner: OwnerRecord, phase: SearchDaemonPhase = 'starting'): OwnerPulse {
  return {
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    socket: owner.socketPath,
    phase,
    pulseSeq: 0,
    progressSeq: 0,
    updatedAt: owner.startedAt,
  };
}

export function publishOwnerAndInitialPulse(registry: OwnerRegistry, owner: OwnerRecord): void {
  const pulse = initialOwnerPulse(owner);
  if (registry.writeOwnerAndPulse) {
    registry.writeOwnerAndPulse(owner, pulse);
    return;
  }
  registry.writeOwnerPulse(pulse);
  registry.writeOwner(owner);
}

export function resetSuccessorBreaker(registry: Pick<OwnerRegistry, 'ownerPath'>, claim: ExclusiveClaim): void {
  const current = readExclusiveClaimOwner(claim.claimDir);
  if (!current || current.claimId !== claim.claimId || !processTokenEquals(current.token, claim.token)) return;
  try {
    fs.rmSync(successorBreakerPath(registry.ownerPath), { force: true });
  } catch (error) {
    if (!isNoEntryError(error)) throw error;
  }
}

export function recordSuccessorClaimHolder(
  registry: Pick<OwnerRegistry, 'ownerPath'>,
  desired: DesiredOwnerIdentity,
  claim: ExclusiveClaim,
  intendedOwner: OwnerRecord,
  options: { env?: NodeJS.ProcessEnv; now?: () => number } = {},
): void {
  const current = readExclusiveClaimOwner(claim.claimDir);
  if (!current || current.claimId !== claim.claimId || !processTokenEquals(current.token, claim.token)) {
    throw unavailableError('search daemon successor claim holder changed before breaker update');
  }
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const breaker = readBreakerForMutation(registry.ownerPath, desired, successorBreakerBudget(env), now);
  if (breaker.kind === 'corrupt') {
    throw unavailableError(
      `search daemon successor breaker is unreadable and was quarantined: ${errorMessage(breaker.error)}`,
    );
  }
  if (breaker.record.holder?.claimId !== claim.claimId) return;
  writeSuccessorBreaker(registry.ownerPath, {
    ...breaker.record,
    holder: {
      pid: claim.token.pid,
      incarnationId: intendedOwner.incarnationId,
      claimId: claim.claimId,
      acquiredAtMs: claim.acquiredAtMs,
    },
  });
}

function successorChildEnv(
  claimId: string,
  observedOwner: OwnerRecord | undefined,
  intendedOwner: OwnerRecord,
  healthProof?: SuccessorHealthProof,
): Record<string, string> {
  return {
    OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_CLAIM_ID: claimId,
    OPTSIDIAN_SEARCH_DAEMON_INCARNATION: intendedOwner.incarnationId,
    ...(healthProof ? { OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_HEALTH_KIND: healthProof.kind } : {}),
    ...(intendedOwner.slot.runtimeScopeHash
      ? { OPTSIDIAN_SEARCH_DAEMON_RUNTIME_SCOPE_HASH: intendedOwner.slot.runtimeScopeHash }
      : {}),
    ...(observedOwner
      ? {
          OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_EPOCH: String(observedOwner.epoch),
          OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_INCARNATION: observedOwner.incarnationId,
          OPTSIDIAN_SEARCH_DAEMON_OBSERVED_OWNER_SOCKET: observedOwner.socketPath,
        }
      : {}),
  };
}

export async function convergeOnCompatibleDaemonForTests(
  registry: OwnerRegistry,
  desired: DesiredOwnerIdentity,
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
    process.pid,
  );
  registry.writeOwner(owner);
  return { owner, replaced: Boolean(current) };
}

export function createOwnerRegistryForTests(options: {
  scenario: string;
  desired: DesiredOwnerIdentity;
}): OwnerRegistry {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-owner-registry-test-'));
  const registry = createOwnerRegistry({ runtimeDir, desired: options.desired });
  const incompatible = (overrides: Partial<OwnerRecord>): OwnerRecord => ({
    ...createOwnerRecord(options.desired, socketPathForOwner(runtimeDir, options.desired), 1, 'stale', 999999),
    ...overrides,
  });

  switch (options.scenario) {
    case 'protocol-mismatch': {
      const peerDesired = {
        ...options.desired,
        protocolVersion: options.desired.protocolVersion + 1,
      };
      createOwnerRegistry({ runtimeDir, desired: peerDesired }).writeOwner(
        createOwnerRecord(peerDesired, socketPathForOwner(runtimeDir, peerDesired), 1, 'stale', 999999),
      );
      break;
    }
    case 'binary-mismatch':
      registry.writeOwner(incompatible({ binaryVersion: 'old-binary-version' }));
      break;
    case 'stale-pid-lock':
      registry.writeOwner(incompatible({ pid: 999999, incarnationId: 'stale' }));
      break;
    case 'orphaned-socket':
      registry.writeOwner(
        incompatible({
          socketPath: path.join(runtimeDir, 'missing.sock'),
          incarnationId: 'stale',
        }),
      );
      break;
    case 'simultaneous-cold-starts':
      break;
    default:
      throw new Error(`Unknown owner-registry test scenario: ${options.scenario}`);
  }

  return registry;
}

export function discoverDaemonPredecessors(
  runtimeDir: string,
  desired: DesiredOwnerIdentity,
  current?: OwnerRecord,
): VerifiedDaemonPredecessor[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if (isNoEntryError(error)) return [];
    throw error;
  }

  const ownerPattern = new RegExp(`^search-daemon-v\\d+-${desired.uid}-[a-f0-9]+\\.owner$`, 'u');
  const predecessors: VerifiedDaemonPredecessor[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ownerPattern.test(entry.name)) continue;
    const ownerPath = path.join(runtimeDir, entry.name);
    const owner = readOwnerFile(ownerPath);
    if (!owner) continue;
    if (owner.slot.uid !== desired.uid) continue;
    if (!ownerMatchesRuntimeScope(owner, desired)) continue;
    if (current && sameOwnerIncarnation(owner, current)) continue;
    if (
      owner.slot.protocolVersion === desired.protocolVersion &&
      owner.binaryVersion === desired.binaryVersion &&
      (!current || owner.incarnationId === current.incarnationId)
    ) {
      continue;
    }
    const token = verifiedProcessTokenForOwner(owner);
    if (!token) continue;
    predecessors.push({ owner, ownerPath, token });
  }
  return predecessors.sort((left, right) => right.owner.epoch - left.owner.epoch);
}

export function reapedMarkerPath(runtimeDir: string, predecessor: OwnerRecord): string {
  const key = sha256(
    `${predecessor.slot.uid}\0${predecessor.epoch}\0${predecessor.incarnationId}\0${predecessor.pid}`,
  ).slice(0, DAEMON_SCOPE_HASH_PREFIX_LENGTH);
  return path.join(runtimeDir, `${REAPED_MARKER_PREFIX}-${predecessor.slot.uid}-${key}.json`);
}

export function writeReapedMarker(markerPath: string, supersession: ShutdownSupersessionPayload): void {
  const now = Date.now();
  const marker: ReapedMarkerRecord = {
    schemaVersion: 1,
    supersessionId: supersession.id,
    predecessor: supersession.predecessor,
    createdAtMs: now,
    createdAt: new Date(now).toISOString(),
  };
  writePrivateFileAtomicSync(
    markerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
    'Optsidian search daemon reaped marker',
  );
}

export function readReapedMarker(markerPath: string): ReapedMarkerRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as unknown;
    return isReapedMarkerRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

export function reapedMarkerMatchesSupersession(
  marker: ReapedMarkerRecord | undefined,
  supersession: ShutdownSupersessionPayload,
): boolean {
  return Boolean(
    marker &&
    marker.supersessionId === supersession.id &&
    marker.createdAtMs >= supersession.startedAtMs &&
    marker.predecessor.uid === supersession.predecessor.uid &&
    marker.predecessor.epoch === supersession.predecessor.epoch &&
    marker.predecessor.incarnationId === supersession.predecessor.incarnationId &&
    marker.predecessor.pid === supersession.predecessor.pid,
  );
}

export function supersessionSentinelPath(runtimeDir: string, desired: DesiredOwnerIdentity): string {
  return path.join(
    runtimeDir,
    `${SUPERSESSION_SENTINEL_PREFIX}-${desired.uid}-${daemonScopeHash(desired.runtimeScopeHash)}.json`,
  );
}

export function writeSupersessionSentinel(
  runtimeDir: string,
  desired: DesiredOwnerIdentity,
  successor: OwnerRecord,
  predecessors: readonly SupersessionSentinelPredecessor[],
  supersessionId: string,
  startedAtMs: number,
): void {
  if (predecessors.length === 0) return;
  const sentinel: SupersessionSentinel = {
    schemaVersion: 1,
    uid: desired.uid,
    runtimeScopeHash: desired.runtimeScopeHash,
    supersessionId,
    successor: {
      epoch: successor.epoch,
      incarnationId: successor.incarnationId,
      pid: successor.pid,
      protocolVersion: successor.slot.protocolVersion,
      binaryVersion: successor.binaryVersion,
    },
    predecessors: predecessors.map((predecessor) => ({
      owner: predecessor.owner,
      reapedMarkerPath: predecessor.reapedMarkerPath,
    })),
    startedAtMs,
    createdAt: new Date(startedAtMs).toISOString(),
  };
  writePrivateFileAtomicSync(
    supersessionSentinelPath(runtimeDir, desired),
    `${JSON.stringify(sentinel, null, 2)}\n`,
    'Optsidian search daemon supersession sentinel',
  );
}

export function readSupersessionSentinel(
  runtimeDir: string,
  desired: DesiredOwnerIdentity,
): SupersessionSentinel | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(supersessionSentinelPath(runtimeDir, desired), 'utf8')) as unknown;
    return isSupersessionSentinel(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

function ownerMatchesRuntimeScope(owner: OwnerRecord, desired: DesiredOwnerIdentity): boolean {
  if (owner.slot.runtimeScopeHash) return owner.slot.runtimeScopeHash === desired.runtimeScopeHash;
  // Legacy owner records predate the path-stable scope. Keep them visible for the first upgrade
  // handoff; every returned candidate is still live-token verified before the caller may act.
  return true;
}

function verifiedProcessTokenForOwner(owner: OwnerRecord): ProcessToken | undefined {
  try {
    const token = createProcessToken(owner.pid);
    return isAlive(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function readBreakerForMutation(
  ownerPath: string,
  desired: DesiredOwnerIdentity,
  budget: BreakerBudget,
  now: () => number,
): { kind: 'ok'; record: SuccessorBreakerRecord } | { kind: 'corrupt'; error: unknown } {
  const breakerPath = successorBreakerPath(ownerPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(breakerPath, 'utf8')) as unknown;
  } catch (error) {
    if (isNoEntryError(error)) return { kind: 'ok', record: freshBreaker(desired, budget) };
    quarantineBreakerFile(breakerPath, 'corrupt', now);
    return { kind: 'corrupt', error };
  }

  if (!isSuccessorBreakerRecord(parsed)) {
    quarantineBreakerFile(breakerPath, 'corrupt', now);
    return { kind: 'corrupt', error: new Error('invalid successor breaker schema') };
  }

  if (!sameSlot(parsed.slot, desired)) {
    quarantineBreakerFile(breakerPath, 'slot', now);
    return { kind: 'ok', record: freshBreaker(desired, budget) };
  }
  if (parsed.desired.binaryVersion !== desired.binaryVersion) {
    quarantineBreakerFile(breakerPath, 'binary-version', now);
    return { kind: 'ok', record: freshBreaker(desired, budget) };
  }

  const normalized: SuccessorBreakerRecord = {
    ...parsed,
    budget,
  };
  if (normalized.firstFailureAtMs !== undefined && now() - normalized.firstFailureAtMs >= normalized.budget.windowMs) {
    return { kind: 'ok', record: freshBreaker(desired, budget) };
  }
  return { kind: 'ok', record: normalized };
}

function recordBreakerAttempt(
  record: SuccessorBreakerRecord,
  claim: ExclusiveClaim,
  intendedOwner: OwnerRecord,
  nowMs: number,
): SuccessorBreakerRecord {
  const attempts = record.attempts + 1;
  const firstFailureAtMs = record.firstFailureAtMs ?? nowMs;
  return {
    ...record,
    holder: {
      pid: claim.token.pid,
      incarnationId: intendedOwner.incarnationId,
      claimId: claim.claimId,
      acquiredAtMs: claim.acquiredAtMs,
    },
    attempts,
    firstFailureAtMs,
    lastFailureAtMs: nowMs,
    backoffUntilMs: nowMs + backoffDelayMs(attempts, record.budget),
  };
}

function writeSuccessorBreaker(ownerPath: string, record: SuccessorBreakerRecord): void {
  writePrivateFileAtomicSync(
    successorBreakerPath(ownerPath),
    `${JSON.stringify(record, null, 2)}\n`,
    'Optsidian search daemon successor breaker',
  );
}

function freshBreaker(desired: DesiredOwnerIdentity, budget: BreakerBudget): SuccessorBreakerRecord {
  return {
    schemaVersion: 1,
    slot: {
      uid: desired.uid,
      runtimeHash: desired.runtimeHash,
      runtimeScopeHash: desired.runtimeScopeHash,
      protocolVersion: desired.protocolVersion,
    },
    desired: {
      binaryVersion: desired.binaryVersion,
    },
    attempts: 0,
    budget,
  };
}

function successorStillNeeded(
  registry: OwnerRegistry,
  observedOwner: OwnerRecord | undefined,
  healthProof: SuccessorHealthProof,
  desired: DesiredOwnerIdentity,
  options: { nowMs: number; startupGraceMs: number },
): boolean {
  const current = registry.readOwner();
  if (!current) return true;
  if (observedOwner && !sameOwnerIncarnation(current, observedOwner)) return false;
  if (!observedOwner && ownerMatchesDesired(current, desired)) return false;
  if (!ownerMatchesDesired(current, desired)) return true;

  let pulse: OwnerPulse | undefined;
  try {
    pulse = registry.readOwnerPulse();
  } catch {
    pulse = undefined;
  }

  if (pulse && pulseMatchesOwner(pulse, current)) {
    if (pulse.phase === 'draining') return true;
    const updatedAtMs = Date.parse(pulse.updatedAt);
    const pulseFresh = Number.isFinite(updatedAtMs) && options.nowMs - updatedAtMs <= SEARCH_DAEMON_PULSE_STALENESS_MS;
    if (pulseFresh) return false;
  }

  if (healthProof.kind === 'identity-mismatch' || healthProof.kind === 'draining') return false;
  if (withinStartupGrace(current, options.nowMs, options.startupGraceMs)) return false;
  return true;
}

function pulseMatchesOwner(pulse: OwnerPulse, owner: OwnerRecord): boolean {
  return (
    pulse.epoch === owner.epoch && pulse.incarnationId === owner.incarnationId && pulse.socket === owner.socketPath
  );
}

function withinStartupGrace(owner: OwnerRecord, nowMs: number, graceMs: number): boolean {
  const startedAtMs = Date.parse(owner.startedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs <= graceMs;
}

function successorBreakerBudget(env: NodeJS.ProcessEnv): BreakerBudget {
  return {
    maxFailures: settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_CHURN_MAX_FAILURES, DEFAULT_CHURN_MAX_FAILURES),
    windowMs: settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_CHURN_WINDOW_MS, DEFAULT_CHURN_WINDOW_MS),
    backoffBaseMs: settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_BASE_MS, DEFAULT_CHURN_BACKOFF_BASE_MS),
    backoffMaxMs: settingNumber(env.OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_MAX_MS, DEFAULT_CHURN_BACKOFF_MAX_MS),
  };
}

function backoffDelayMs(attempts: number, budget: BreakerBudget): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = budget.backoffBaseMs * 2 ** exponent;
  return Math.min(budget.backoffMaxMs, delay);
}

function successorBreakerPath(ownerPath: string): string {
  return `${ownerPath}${SUCCESSOR_BREAKER_SUFFIX}`;
}

function quarantineBreakerFile(breakerPath: string, reason: string, now: () => number): void {
  try {
    fs.renameSync(breakerPath, `${breakerPath}.quarantine-${reason}-${Math.trunc(now())}-${crypto.randomUUID()}`);
  } catch (error) {
    if (!isNoEntryError(error)) {
      try {
        fs.rmSync(breakerPath, { force: true });
      } catch {
        // The caller still fails closed; this is a best-effort repair attempt.
      }
    }
  }
}

function isSuccessorBreakerRecord(value: unknown): value is SuccessorBreakerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SuccessorBreakerRecord>;
  const attempts = record.attempts;
  return (
    record.schemaVersion === 1 &&
    isSlot(record.slot) &&
    Boolean(record.desired) &&
    typeof record.desired?.binaryVersion === 'string' &&
    typeof attempts === 'number' &&
    Number.isInteger(attempts) &&
    attempts >= 0 &&
    isOptionalFiniteNumber(record.firstFailureAtMs) &&
    isOptionalFiniteNumber(record.lastFailureAtMs) &&
    isOptionalFiniteNumber(record.backoffUntilMs) &&
    isBreakerBudget(record.budget) &&
    isOptionalBreakerHolder(record.holder)
  );
}

function isBreakerBudget(value: unknown): value is BreakerBudget {
  if (!value || typeof value !== 'object') return false;
  const budget = value as Partial<BreakerBudget>;
  const maxFailures = budget.maxFailures;
  const windowMs = budget.windowMs;
  const backoffBaseMs = budget.backoffBaseMs;
  const backoffMaxMs = budget.backoffMaxMs;
  return (
    typeof maxFailures === 'number' &&
    Number.isInteger(maxFailures) &&
    maxFailures > 0 &&
    typeof windowMs === 'number' &&
    Number.isFinite(windowMs) &&
    windowMs > 0 &&
    typeof backoffBaseMs === 'number' &&
    Number.isFinite(backoffBaseMs) &&
    backoffBaseMs >= 0 &&
    typeof backoffMaxMs === 'number' &&
    Number.isFinite(backoffMaxMs) &&
    backoffMaxMs >= backoffBaseMs
  );
}

function isOptionalBreakerHolder(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const holder = value as Record<string, unknown>;
  const pid = holder.pid;
  const incarnationId = holder.incarnationId;
  const claimId = holder.claimId;
  const acquiredAtMs = holder.acquiredAtMs;
  return (
    Number.isSafeInteger(pid) &&
    typeof incarnationId === 'string' &&
    typeof claimId === 'string' &&
    typeof acquiredAtMs === 'number' &&
    Number.isFinite(acquiredAtMs)
  );
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

function sameSlot(slot: TenancySlot, desired: DesiredOwnerIdentity): boolean {
  return (
    slot.uid === desired.uid &&
    slot.runtimeHash === desired.runtimeHash &&
    (slot.runtimeScopeHash === undefined || slot.runtimeScopeHash === desired.runtimeScopeHash) &&
    slot.protocolVersion === desired.protocolVersion
  );
}

function settingNumber(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && raw.trim() !== '' && /^\d+$/.test(raw.trim())) return Number(raw);
  return fallback;
}

function unavailableError(message: string): Error {
  return Object.assign(new Error(`${message}. Search daemon is required; direct in-process search is unavailable.`), {
    code: 'SEARCH_DAEMON_UNAVAILABLE',
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownerRegistryStem(desired: DesiredOwnerIdentity): string {
  return `search-daemon-v${desired.protocolVersion}-${desired.uid}-${daemonScopeHash(desired.runtimeHash)}`;
}

function daemonSocketStem(desired: DesiredOwnerIdentity): string {
  return `optsidian-search-daemon-v${desired.protocolVersion}-${desired.uid}-${daemonScopeHash(desired.runtimeHash)}`;
}

function daemonScopeHash(runtimeHash: string): string {
  return sha256(runtimeHash).slice(0, DAEMON_SCOPE_HASH_PREFIX_LENGTH);
}

function lstatMaybe(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

function sameFileStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.mtimeMs === right.mtimeMs;
}

function readOwnerFile(ownerPath: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as unknown;
    if (!isOwnerRecord(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

export function readOwnerRecordAtPath(ownerPath: string): OwnerRecord | undefined {
  return readOwnerFile(ownerPath);
}

export function readOwnerPulse(ownerPath: string): OwnerPulse | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPulsePath(ownerPath), 'utf8')) as unknown;
    if (!isOwnerPulse(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if (isNoEntryError(error)) return undefined;
    throw error;
  }
}

function writeOwnerFile(ownerPath: string, record: OwnerRecord): void {
  writePrivateFileAtomicSync(ownerPath, `${JSON.stringify(record, null, 2)}\n`, 'Optsidian search daemon owner file');
}

export function writeOwnerPulse(ownerPath: string, pulse: OwnerPulse): void {
  writePrivateFileAtomicSync(
    ownerPulsePath(ownerPath),
    `${JSON.stringify(pulse, null, 2)}\n`,
    'Optsidian search daemon owner pulse file',
  );
}

function writeOwnerAndPulse(ownerPath: string, record: OwnerRecord, pulse: OwnerPulse): void {
  writeOwnerPulse(ownerPath, pulse);
  writeOwnerFile(ownerPath, record);
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
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isSlot(record.slot) &&
    Number.isInteger(record.epoch) &&
    typeof record.incarnationId === 'string' &&
    typeof record.binaryVersion === 'string' &&
    Number.isInteger(record.pid) &&
    typeof record.socketPath === 'string' &&
    typeof record.startedAt === 'string'
  );
}

function isOwnerPulse(value: unknown): value is OwnerPulse {
  if (!value || typeof value !== 'object') return false;
  const pulse = value as Record<string, unknown>;
  return (
    Number.isInteger(pulse.epoch) &&
    typeof pulse.incarnationId === 'string' &&
    typeof pulse.socket === 'string' &&
    isSearchDaemonPhase(pulse.phase) &&
    Number.isInteger(pulse.pulseSeq) &&
    Number.isInteger(pulse.progressSeq) &&
    typeof pulse.updatedAt === 'string'
  );
}

function isReapedMarkerRecord(value: unknown): value is ReapedMarkerRecord {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<ReapedMarkerRecord>;
  return (
    marker.schemaVersion === 1 &&
    typeof marker.supersessionId === 'string' &&
    isSupersessionPredecessor(marker.predecessor) &&
    typeof marker.createdAtMs === 'number' &&
    Number.isFinite(marker.createdAtMs) &&
    typeof marker.createdAt === 'string'
  );
}

function isSupersessionSentinel(value: unknown): value is SupersessionSentinel {
  if (!value || typeof value !== 'object') return false;
  const sentinel = value as Partial<SupersessionSentinel>;
  return (
    sentinel.schemaVersion === 1 &&
    Number.isInteger(sentinel.uid) &&
    typeof sentinel.runtimeScopeHash === 'string' &&
    typeof sentinel.supersessionId === 'string' &&
    Boolean(sentinel.successor) &&
    Number.isInteger(sentinel.successor?.epoch) &&
    typeof sentinel.successor?.incarnationId === 'string' &&
    Number.isInteger(sentinel.successor?.pid) &&
    Number.isInteger(sentinel.successor?.protocolVersion) &&
    typeof sentinel.successor?.binaryVersion === 'string' &&
    Array.isArray(sentinel.predecessors) &&
    sentinel.predecessors.every(isSupersessionSentinelPredecessor) &&
    typeof sentinel.startedAtMs === 'number' &&
    Number.isFinite(sentinel.startedAtMs) &&
    typeof sentinel.createdAt === 'string'
  );
}

function isSupersessionSentinelPredecessor(value: unknown): value is SupersessionSentinelPredecessor {
  if (!value || typeof value !== 'object') return false;
  const predecessor = value as Partial<SupersessionSentinelPredecessor>;
  return isOwnerRecord(predecessor.owner) && typeof predecessor.reapedMarkerPath === 'string';
}

function isSupersessionPredecessor(value: unknown): value is ShutdownSupersessionPayload['predecessor'] {
  if (!value || typeof value !== 'object') return false;
  const predecessor = value as Partial<ShutdownSupersessionPayload['predecessor']>;
  return (
    Number.isInteger(predecessor.uid) &&
    Number.isInteger(predecessor.epoch) &&
    typeof predecessor.incarnationId === 'string' &&
    Number.isInteger(predecessor.pid)
  );
}

function isSearchDaemonPhase(value: unknown): value is SearchDaemonPhase {
  return value === 'starting' || value === 'ready' || value === 'draining';
}

function isSlot(value: unknown): value is TenancySlot {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Record<string, unknown>;
  return (
    Number.isInteger(slot.uid) &&
    typeof slot.runtimeHash === 'string' &&
    (slot.runtimeScopeHash === undefined || typeof slot.runtimeScopeHash === 'string') &&
    Number.isInteger(slot.protocolVersion)
  );
}

function ownerPulsePath(ownerPath: string): string {
  return `${ownerPath}.pulse`;
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
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isNoEntryError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT',
  );
}
