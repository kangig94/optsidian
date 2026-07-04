import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSearchDaemonClient } from '../src/daemon/client.ts';
import { readOwnerPulseProof } from '../src/daemon/client.ts';
import {
  createOwnerRecord,
  createOwnerRegistry,
  desiredOwnerIdentity,
  discoverDaemonPredecessors,
  initialOwnerPulse,
  publishOwnerAndInitialPulse,
  readReapedMarker,
  reapedMarkerMatchesSupersession,
  reapedMarkerPath,
  socketPathForOwner,
  successorClaimDir,
  tryClaimSuccessor,
  writeOwnerPulse,
  writeReapedMarker,
} from '../src/daemon/owner-registry.ts';
import {
  ExclusiveClaim,
  readExclusiveClaimOwner,
  reclaimExclusiveClaim,
} from '../src/core/lifecycle/exclusive-claim.ts';
import { createProcessToken } from '../src/core/lifecycle/process-token.ts';
import {
  SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS,
  SEARCH_DAEMON_HEARTBEAT_DEADLINE_MS,
  SEARCH_DAEMON_PROTOCOL_VERSION,
  SEARCH_DAEMON_PULSE_STALENESS_MS,
} from '../src/daemon/protocol.ts';
import { connectRpc, probeSocketPath } from '../src/daemon/transport.ts';
import { hasReapingProofForTests, reapingSignalPlanForTests } from '../src/daemon/server.ts';

const repoRoot = process.cwd();

test('AC6 kill and respawn mid client session resyncs to the successor', async () => {
  const runtimeDir = tempRoot();
  const env = daemonEnv(runtimeDir);
  const client = createSearchDaemonClient({
    runtimeDir,
    binaryPath: path.join(repoRoot, 'dist', 'optsidian'),
    readyTimeoutMs: 30000,
    env,
  });

  let finalStatus;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    process.kill(first.pid, 'SIGTERM');
    await waitForDead(first.pid);

    finalStatus = await client.status({ deadlineMs: 30000 });
    assert.equal(finalStatus.ready, true);
    assert.equal(finalStatus.protocolVersion, SEARCH_DAEMON_PROTOCOL_VERSION);
    assert.notEqual(finalStatus.incarnationId, first.incarnationId);
    assert.equal(finalStatus.epoch > first.epoch, true, 'successor epoch must advance');

    const connection = await connectRpc(finalStatus.socketPath);
    try {
      await assert.rejects(
        () =>
          connection.request({
            protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION - 1,
            requestId: 'protocol-mismatch',
            method: 'Status',
            deadline: Date.now() + 1000,
            payload: {},
          }),
        (error) => {
          assert.equal(error.code, 'BAD_REQUEST');
          assert.match(error.message, /protocol version mismatch/);
          return true;
        },
      );
    } finally {
      await connection.close();
    }
  } finally {
    if (finalStatus) {
      await createSearchDaemonClient({ runtimeDir, binaryPath: path.join(repoRoot, 'dist', 'optsidian'), env })
        .shutdown({ deadlineMs: 5000 })
        .catch(() => {});
    }
  }
});

test('AC6 semantic errors fail fast and are not retried', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const owner = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const requests = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    connect(record) {
      return {
        async request(request) {
          requests.push(request);
          if (request.method === 'Heartbeat') return heartbeatResult(record);
          throw Object.assign(new Error('malformed request'), { code: 'BAD_REQUEST' });
        },
        async close() {},
      };
    },
  });

  await assert.rejects(
    () => client.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'BAD_REQUEST');
      return true;
    },
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ['Heartbeat', 'Search'],
  );
});

test('AC6 Heartbeat admits a ready owner without Status readiness polling', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const owner = createOwnerRecord(desired, socketPathForOwner(runtimeDir, desired), 1, 'incarnation', process.pid);
  registry.writeOwner(owner);
  const calls = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    connect(record) {
      return {
        async request(request) {
          calls.push(request.method);
          if (request.method === 'Heartbeat') return heartbeatResult(record);
          return {
            ok: true,
            command: 'search',
            schemaVersion: 1,
            available: true,
            status: 'ready',
            snapshotId: 'snap-a',
            matches: [],
            results: [],
          };
        },
        async close() {},
      };
    },
  });

  await client.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 });
  assert.deepEqual(calls, ['Heartbeat', 'Search']);
});

test('Heartbeat liveness probe is capped at the heartbeat deadline', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const wedged = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, 'wedged'),
    1,
    'wedged-incarnation',
    process.pid,
    new Date(0).toISOString(),
  );
  let observedHeartbeatBudget;
  let spawnedAt;
  registry.writeOwner(wedged);

  const startedAt = Date.now();
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    readyTimeoutMs: 3000,
    spawnDaemon(record) {
      spawnedAt = Date.now();
      registry.writeOwner(createOwnerRecord(desired, record.socketPath, 2, record.incarnationId, process.pid));
    },
    connect(record) {
      return {
        async request(request) {
          if (request.method === 'Heartbeat' && record.incarnationId !== wedged.incarnationId) {
            return heartbeatResult(record);
          }
          if (record.incarnationId === wedged.incarnationId) {
            assert.equal(request.method, 'Heartbeat');
            observedHeartbeatBudget = request.deadline - Date.now();
            throw Object.assign(new Error('Heartbeat request timed out before a response was received'), {
              code: 'ETIMEDOUT',
            });
          }
          assert.equal(request.method, 'Status');
          return statusResult(record);
        },
        async close() {},
      };
    },
  });

  try {
    const status = await client.status({ deadlineMs: 3000 });
    assert.equal(status.ready, true);
    assert.notEqual(status.incarnationId, wedged.incarnationId);
    assert.equal(observedHeartbeatBudget <= SEARCH_DAEMON_HEARTBEAT_DEADLINE_MS + 100, true);
    assert.equal(spawnedAt - startedAt < SEARCH_DAEMON_DEFAULT_STATUS_DEADLINE_MS + 800, true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('AC1/AC2 no respawn storm when Status is starved but Heartbeat and pulse are healthy', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const owner = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, 'healthy'),
    7,
    'healthy-incarnation',
    process.pid,
    new Date(nowMs - 5_000).toISOString(),
  );
  registry.writeOwner(owner);
  registry.writeOwnerPulse({
    ...initialOwnerPulse(owner, 'ready'),
    pulseSeq: 42,
    progressSeq: 9,
    updatedAt: new Date(nowMs).toISOString(),
  });
  const requests = [];
  let spawnCalls = 0;
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    now: () => nowMs,
    spawnDaemon() {
      spawnCalls += 1;
      throw new Error('healthy heartbeat must not spawn a replacement');
    },
    connect(record) {
      return {
        async request(request) {
          requests.push(request.method);
          if (request.method === 'Heartbeat') {
            return heartbeatResult(record, { pulseSeq: 43, progressSeq: 10, updatedAt: new Date(nowMs).toISOString() });
          }
          if (request.method === 'Status') {
            throw Object.assign(new Error('Status is scheduler-starved'), { code: 'ETIMEDOUT' });
          }
          assert.equal(request.method, 'Search');
          return {
            ok: true,
            command: 'search',
            schemaVersion: 1,
            available: true,
            status: 'ready',
            snapshotId: 'snap-healthy',
            matches: [],
            results: [],
          };
        },
        async close() {},
      };
    },
  });

  const result = await client.search({ vault: runtimeDir, query: 'alpha', limit: 1, deadlineMs: 1000 });
  assert.equal(result.snapshotId, 'snap-healthy');
  assert.equal(spawnCalls, 0);
  assert.deepEqual(requests, ['Heartbeat', 'Search']);
});

test('AC1/AC2 admission serializes one successor while publication is stalled', async () => {
  const fixture = successorFixture('admission-stall');
  const first = await claimSuccessor(fixture, { claimId: 'claim-a' });
  assert.equal(first.kind, 'claimed');

  const second = await claimSuccessor(fixture, { claimId: 'claim-b' });
  assert.deepEqual({ kind: second.kind, reason: second.reason }, { kind: 'wait', reason: 'claim-busy' });

  publishOwnerAndInitialPulse(fixture.registry, first.handle.intendedOwner);
  assert.equal(first.handle.claim.release(), true);
  const afterPublish = await claimSuccessor(fixture, { claimId: 'claim-c' });
  assert.deepEqual({ kind: afterPublish.kind, reason: afterPublish.reason }, { kind: 'wait', reason: 'not-needed' });
});

test('AC4 pinned successor lease survives parent exit after child rebind', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'successor.claim');
  const now = () => 10_000;
  const parent = token(4101, 'parent-start');
  const child = token(4102, 'child-start');
  const parentClaim = await ExclusiveClaim.acquire(claimDir, {
    claimId: 'lease-parent',
    token: parent,
    now,
    timeoutMs: 0,
  });

  const rebound = ExclusiveClaim.rebindToken(claimDir, 'lease-parent', { token: child });
  assert.ok(rebound, 'child must conditionally rebind the parent-held claim');
  assert.equal(parentClaim.release(), false, 'parent can no longer release after child rebind');
  assert.equal(
    reclaimExclusiveClaim(claimDir, {
      now,
      isAlive: (candidate) => candidate.pid === child.pid,
    }),
    false,
    'dead parent must not make a live child-held claim reclaimable',
  );
  assert.deepEqual(readExclusiveClaimOwner(claimDir)?.token, child);
  assert.equal(rebound.release(), true);
});

test('AC4 child crash after claim before owner publication is reclaimable without split brain', async () => {
  const fixture = successorFixture('child-crash');
  const first = await claimSuccessor(fixture, { claimId: 'crashed-child', token: token(4201, 'child-start') });
  assert.equal(first.kind, 'claimed');
  assert.equal(fixture.registry.readOwner()?.incarnationId, fixture.observedOwner.incarnationId);

  assert.equal(
    reclaimExclusiveClaim(successorClaimDir(fixture.registry.ownerPath), {
      now: fixture.now,
      isAlive: () => false,
    }),
    true,
  );
  const recovered = await claimSuccessor(fixture, { claimId: 'recovered-parent', token: token(4202, 'parent-start') });
  assert.equal(recovered.kind, 'claimed');
  recovered.handle.claim.release();
});

test('AC4 two parents racing successor acquire admit exactly one claimant', async () => {
  const fixture = successorFixture('two-parents');
  const [left, right] = await Promise.all([
    claimSuccessor(fixture, { claimId: 'left-parent' }),
    claimSuccessor(fixture, { claimId: 'right-parent' }),
  ]);
  const claimed = [left, right].filter((result) => result.kind === 'claimed');
  const waiting = [left, right].filter((result) => result.kind === 'wait' && result.reason === 'claim-busy');
  assert.equal(claimed.length, 1);
  assert.equal(waiting.length, 1);
  claimed[0].handle.claim.release();
});

test('AC4 reclaim racing the child rebind CAS aborts before model load', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'successor.claim');
  const now = () => 10_000;
  const parent = token(4401, 'parent-start');
  const child = token(4402, 'child-start');
  await ExclusiveClaim.acquire(claimDir, {
    claimId: 'old-nonce',
    token: parent,
    now,
    timeoutMs: 0,
  });
  const gateRead = readExclusiveClaimOwner(claimDir);
  assert.equal(gateRead?.claimId, 'old-nonce');

  assert.equal(
    reclaimExclusiveClaim(claimDir, {
      now,
      isAlive: () => false,
    }),
    true,
  );
  const competitor = await ExclusiveClaim.acquire(claimDir, {
    claimId: 'new-nonce',
    token: token(4403, 'competitor-start'),
    now,
    timeoutMs: 0,
  });
  let childModelLoads = 0;
  const rebound = ExclusiveClaim.rebindToken(claimDir, gateRead.claimId, { token: child });
  if (rebound) childModelLoads += 1;

  assert.equal(rebound, undefined);
  assert.equal(childModelLoads, 0);
  assert.equal(readExclusiveClaimOwner(claimDir)?.claimId, 'new-nonce');
  competitor.release();
});

test('AC5 durable successor breaker resets on binary version and fails closed on corruption', async () => {
  const fixture = successorFixture('breaker-reset');
  const first = await claimSuccessor(fixture, { claimId: 'breaker-a' });
  assert.equal(first.kind, 'claimed');
  first.handle.claim.release();
  const breakerPath = `${fixture.registry.ownerPath}.successor-breaker.json`;
  const firstBreaker = JSON.parse(fs.readFileSync(breakerPath, 'utf8'));
  assert.equal(firstBreaker.desired.binaryVersion, fixture.desired.binaryVersion);

  const fixedDesired = { ...fixture.desired, binaryVersion: `${fixture.desired.binaryVersion}-fixed` };
  const fixedOwner = createOwnerRecord(
    fixedDesired,
    socketPathForOwner(fixture.registry.runtimeDir, fixedDesired, 'fixed'),
    3,
    'fixed-incarnation',
    process.pid,
    new Date(0).toISOString(),
  );
  const fixed = await tryClaimSuccessor(fixture.registry, fixture.observedOwner, fixture.healthProof, {
    desired: fixedDesired,
    intendedOwner: fixedOwner,
    deadlineMs: fixture.now(),
    now: fixture.now,
    env: fixture.env,
    claimId: 'breaker-fixed',
    token: token(4501, 'fixed-start'),
    pollMs: 0,
  });
  assert.equal(fixed.kind, 'claimed');
  fixed.handle.claim.release();
  const quarantines = fs.readdirSync(fixture.registry.runtimeDir).filter((entry) => entry.includes('binary-version'));
  assert.equal(quarantines.length, 1);
  const fixedBreaker = JSON.parse(fs.readFileSync(breakerPath, 'utf8'));
  assert.equal(fixedBreaker.desired.binaryVersion, fixedDesired.binaryVersion);

  fs.writeFileSync(breakerPath, '{not json');
  const corrupt = await claimSuccessor(fixture, { claimId: 'breaker-corrupt', token: token(4502, 'corrupt-start') });
  assert.equal(corrupt.kind, 'unavailable');
  assert.equal(corrupt.error.code, 'SEARCH_DAEMON_UNAVAILABLE');
  assert.match(corrupt.error.message, /unreadable/);
});

test('AC5 durable breaker mutation is serialized by the successor claim and fails fast after budget', async () => {
  const fixture = successorFixture('breaker-serialized', {
    OPTSIDIAN_SEARCH_DAEMON_CHURN_MAX_FAILURES: '3',
    OPTSIDIAN_SEARCH_DAEMON_CHURN_WINDOW_MS: '60000',
    OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_BASE_MS: '0',
    OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_MAX_MS: '0',
  });
  const first = await claimSuccessor(fixture, { claimId: 'budget-a' });
  assert.equal(first.kind, 'claimed');
  const blocked = await claimSuccessor(fixture, { claimId: 'budget-b' });
  assert.deepEqual({ kind: blocked.kind, reason: blocked.reason }, { kind: 'wait', reason: 'claim-busy' });
  const breakerPath = `${fixture.registry.ownerPath}.successor-breaker.json`;
  assert.equal(JSON.parse(fs.readFileSync(breakerPath, 'utf8')).attempts, 1);
  first.handle.markSpawnFailure(new Error('boot failed 1'));

  for (const claimId of ['budget-c', 'budget-d']) {
    const claimed = await claimSuccessor(fixture, { claimId });
    assert.equal(claimed.kind, 'claimed');
    claimed.handle.markSpawnFailure(new Error(`boot failed ${claimId}`));
  }
  const exhausted = await claimSuccessor(fixture, { claimId: 'budget-e' });
  assert.equal(exhausted.kind, 'unavailable');
  assert.equal(exhausted.error.code, 'SEARCH_DAEMON_UNAVAILABLE');
  assert.match(exhausted.error.message, /churn budget exhausted/);
});

test('AC3 wedged verdict uses backdated pulse at the H boundary without sleeping', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const wedged = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, 'stale-pulse'),
    11,
    'wedged-pulse',
    process.pid,
    new Date(nowMs - 60_000).toISOString(),
  );
  registry.writeOwner(wedged);
  registry.writeOwnerPulse({
    ...initialOwnerPulse(wedged, 'ready'),
    pulseSeq: 4,
    updatedAt: new Date(nowMs - SEARCH_DAEMON_PULSE_STALENESS_MS - 1).toISOString(),
  });
  const successorKinds = [];
  const client = createSearchDaemonClient({
    registry,
    binaryPath,
    now: () => nowMs,
    spawnDaemon(record, successorEnv) {
      successorKinds.push(successorEnv.OPTSIDIAN_SEARCH_DAEMON_SUCCESSOR_HEALTH_KIND);
      registry.writeOwner(createOwnerRecord(desired, record.socketPath, 12, record.incarnationId, process.pid));
    },
    connect(record) {
      return {
        async request(request) {
          if (record.incarnationId === wedged.incarnationId) {
            assert.equal(request.method, 'Heartbeat');
            throw Object.assign(new Error('main loop blocked'), { code: 'ETIMEDOUT' });
          }
          if (request.method === 'Heartbeat') return heartbeatResult(record);
          assert.equal(request.method, 'Status');
          return statusResult(record);
        },
        async close() {},
      };
    },
  });

  const status = await client.status({ deadlineMs: 1000 });
  assert.notEqual(status.incarnationId, wedged.incarnationId);
  assert.deepEqual(successorKinds, ['wedged']);
});

test('OwnerPulse sidecar writes, validates identity, and rejects stale or mismatched pulses', () => {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const owner = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, 'pulse'),
    2,
    'pulse-incarnation',
    process.pid,
    new Date(nowMs).toISOString(),
  );
  publishOwnerAndInitialPulse(registry, owner);
  assert.deepEqual(registry.readOwner(), owner);
  assert.deepEqual(registry.readOwnerPulse(), initialOwnerPulse(owner));

  writeOwnerPulse(registry.ownerPath, {
    ...initialOwnerPulse(owner, 'ready'),
    pulseSeq: 2,
    progressSeq: 1,
    updatedAt: new Date(nowMs).toISOString(),
  });
  assert.equal(readOwnerPulseProof(registry, owner, { nowMs }).valid, true);

  const stale = readOwnerPulseProof(registry, owner, { nowMs: nowMs + SEARCH_DAEMON_PULSE_STALENESS_MS + 1 });
  assert.deepEqual({ valid: stale.valid, reason: stale.reason }, { valid: false, reason: 'stale' });

  registry.writeOwnerPulse({
    ...initialOwnerPulse(owner, 'ready'),
    incarnationId: 'other-incarnation',
    updatedAt: new Date(nowMs).toISOString(),
  });
  const mismatch = readOwnerPulseProof(registry, owner, { nowMs });
  assert.deepEqual(
    { valid: mismatch.valid, reason: mismatch.reason },
    { valid: false, reason: 'incarnation-mismatch' },
  );
});

test('AC4 cross-protocol predecessor discovery is path-stable and reaping proof is scoped', () => {
  const runtimeDir = tempRoot();
  const env = { ...process.env, OPTSIDIAN_SEARCH_DAEMON_INSTALL_IDENTITY: 'global-install-stable' };
  const desired = desiredOwnerIdentity(process.execPath, env);
  const oldDesired = {
    ...desired,
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION - 1,
    runtimeHash: 'old-realpath-runtime-hash',
    binaryVersion: 'old-binary-version',
  };
  const oldRegistry = createOwnerRegistry({ runtimeDir, desired: oldDesired });
  const predecessor = createOwnerRecord(
    oldDesired,
    socketPathForOwner(runtimeDir, oldDesired, 'old'),
    5,
    'old-incarnation',
    process.pid,
  );
  oldRegistry.writeOwner(predecessor);

  const found = discoverDaemonPredecessors(runtimeDir, desired);
  assert.equal(found.length, 1);
  assert.equal(found[0].owner.incarnationId, predecessor.incarnationId);

  const markerPath = reapedMarkerPath(runtimeDir, predecessor);
  const startedAtMs = 0;
  const supersession = supersessionPayload(predecessor, 'supersession-a', startedAtMs, markerPath);
  oldRegistry.removeOwner(predecessor);
  assert.equal(
    hasReapingProofForTests({ markerPath, supersession, token: createProcessToken(process.pid) }),
    false,
    'owner/socket disappearance while pid is live is not teardown proof',
  );

  writeReapedMarker(markerPath, { ...supersession, id: 'different-supersession' });
  assert.equal(reapedMarkerMatchesSupersession(readReapedMarker(markerPath), supersession), false);
  writeReapedMarker(markerPath, supersession);
  assert.equal(reapedMarkerMatchesSupersession(readReapedMarker(markerPath), supersession), true);
  assert.equal(
    reapedMarkerMatchesSupersession(readReapedMarker(markerPath), {
      ...supersession,
      predecessor: { ...supersession.predecessor, pid: predecessor.pid + 1 },
    }),
    false,
    'reaped markers are pid-reuse scoped',
  );
});

test('AC4 same-protocol recovered predecessor aborts successor admission before signalling', async () => {
  const fixture = successorFixture('same-protocol-recovered');
  fixture.registry.writeOwnerPulse({
    ...initialOwnerPulse(fixture.observedOwner, 'ready'),
    pulseSeq: 99,
    updatedAt: new Date(fixture.now()).toISOString(),
  });
  const result = await claimSuccessor(fixture, { claimId: 'recovered-predecessor' });
  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'wait', reason: 'not-needed' });
});

test('AC4 same-protocol wedged reaping escalates to SIGKILL and aborts if recovered', () => {
  assert.deepEqual(
    reapingSignalPlanForTests({
      kind: 'same-protocol-wedged',
      authoritativeStartId: true,
      identityBeforeTerm: true,
      proofAfterTerm: false,
      identityBeforeKill: true,
      proofAfterKill: true,
    }),
    { outcome: 'reaped', signals: ['SIGTERM', 'SIGKILL'] },
  );
  assert.deepEqual(
    reapingSignalPlanForTests({
      kind: 'same-protocol-wedged',
      recoveredBeforeSignal: true,
      authoritativeStartId: true,
    }),
    { outcome: 'abort-recovered', signals: [] },
  );
});

function statusResult(owner, overrides = {}) {
  return {
    ok: true,
    ready: true,
    phase: 'ready',
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    binaryVersion: owner.binaryVersion,
    epoch: owner.epoch,
    incarnationId: owner.incarnationId,
    pid: owner.pid,
    socketPath: owner.socketPath,
    startedAt: owner.startedAt,
    owner,
    metrics: { requests: 0, failures: 0, activeRequests: 0, startedAt: owner.startedAt },
    pools: {},
    searchStore: {},
    profiles: {},
    vaults: [],
    ...overrides,
  };
}

function heartbeatResult(owner, overrides = {}) {
  return {
    owner,
    phase: 'ready',
    protocolVersion: SEARCH_DAEMON_PROTOCOL_VERSION,
    incarnationId: owner.incarnationId,
    pulseSeq: 1,
    progressSeq: 0,
    updatedAt: owner.startedAt,
    ...overrides,
  };
}

test('successor boot does not supersede a healthy (fresh-pulse) predecessor', async () => {
  const runtimeDir = tempRoot();
  const env = daemonEnv(runtimeDir);
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const client = createSearchDaemonClient({ runtimeDir, binaryPath, readyTimeoutMs: 30000, env });
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  let predecessorPid;
  let successor;
  const successorStderr = [];

  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    predecessorPid = first.pid;

    const successorSocket = socketPathForOwner(runtimeDir, desired, 'courtesy');
    successor = spawn(binaryPath, ['__search-daemon'], {
      env: {
        ...env,
        OPTSIDIAN_SEARCH_DAEMON_BINARY: binaryPath,
        OPTSIDIAN_SEARCH_DAEMON_UID: String(desired.uid),
        OPTSIDIAN_SEARCH_DAEMON_RUNTIME_HASH: desired.runtimeHash,
        OPTSIDIAN_SEARCH_DAEMON_BINARY_VERSION: desired.binaryVersion,
        OPTSIDIAN_SEARCH_DAEMON_SOCKET: successorSocket,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    successor.stderr?.on('data', (chunk) => {
      successorStderr.push(String(chunk));
    });
    assert.equal(typeof successor.pid, 'number');

    // The admission model refuses to publish over a live, fresh-pulse owner (the storm fix), so the
    // successor exits on its own without claiming ownership and the healthy predecessor survives.
    const successorExited = await waitForExit(successor.pid, 8000);
    assert.equal(
      successorExited,
      true,
      `successor must exit without superseding a healthy predecessor; stderr: ${successorStderr.join('')}`,
    );
    const ownerNow = registry.readOwner();
    assert.equal(ownerNow?.incarnationId, first.incarnationId, 'healthy predecessor remains the owner');
    const predecessorExited = await waitForExit(predecessorPid, 500);
    assert.equal(predecessorExited, false, 'a healthy predecessor must not be reaped');
  } finally {
    await createSearchDaemonClient({ runtimeDir, binaryPath, env })
      .shutdown({ deadlineMs: 5000 })
      .catch(() => {});
    if (successor && successor.exitCode === null && successor.signalCode === null) successor.kill('SIGKILL');
    if (predecessorPid !== undefined) {
      try {
        process.kill(predecessorPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a superseded daemon self-drains at equal epoch and cleans only its own socket', async () => {
  const runtimeDir = tempRoot();
  const env = { ...daemonEnv(runtimeDir), OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS: '20' };
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const client = createSearchDaemonClient({ runtimeDir, binaryPath, readyTimeoutMs: 30000, env });
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  let victimPid;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    victimPid = first.pid;
    const victimSocket = first.socketPath;
    assert.equal(fs.existsSync(victimSocket), true);

    // A different incarnation claims the slot at the SAME epoch on its OWN unique socket path —
    // the equal-epoch cold-start tie the total-order (`>=`) step-down must reap. A newer successor
    // never binds the victim's path (unique paths), so its socket is a distinct file.
    const successorSocket = socketPathForOwner(runtimeDir, desired, 'succ0nonce');
    assert.notEqual(successorSocket, victimSocket);
    registry.writeOwner(createOwnerRecord(desired, successorSocket, first.epoch, 'successor-incarnation', 999999));

    const exited = await waitForExit(victimPid, 4000);
    assert.equal(exited, true, 'superseded daemon should self-drain and exit');

    // It cleans up its OWN unique socket on the way out, and never touches the successor's record.
    assert.equal(fs.existsSync(victimSocket), false, 'stepped-down daemon should unlink its own socket');
    assert.equal(registry.readOwner()?.incarnationId, 'successor-incarnation');
  } finally {
    if (victimPid !== undefined) {
      try {
        process.kill(victimPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('failed deterministic socket start does not unlink a live incumbent socket or owner', async () => {
  const runtimeDir = tempRoot();
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const socketPath = socketPathForOwner(runtimeDir, desired);
  const owner = createOwnerRecord(desired, socketPath, 1, 'incumbent-incarnation', process.pid);
  const incumbent = net.createServer();
  let child;
  registry.writeOwner(owner);

  try {
    await listen(incumbent, socketPath);
    assert.equal(await probeSocketPath(socketPath), 'listening');

    child = spawn(binaryPath, ['__search-daemon'], {
      env: {
        ...daemonEnv(runtimeDir),
        OPTSIDIAN_SEARCH_DAEMON_BINARY: binaryPath,
        OPTSIDIAN_SEARCH_DAEMON_SOCKET: socketPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exit = await waitForChildExit(child, 5000);

    assert.notEqual(exit.code, 0, exit.stderr);
    assert.equal(await probeSocketPath(socketPath), 'listening');
    assert.equal(fs.existsSync(socketPath), true);
    assert.deepEqual(registry.readOwner(), owner);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closeServer(incumbent).catch(() => {});
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a sole owner never self-drains across many ownership poll cycles', async () => {
  const runtimeDir = tempRoot();
  const env = { ...daemonEnv(runtimeDir), OPTSIDIAN_SEARCH_DAEMON_OWNERSHIP_POLL_MS: '20' };
  const binaryPath = path.join(repoRoot, 'dist', 'optsidian');
  const client = createSearchDaemonClient({ runtimeDir, binaryPath, readyTimeoutMs: 30000, env });
  let pid;
  try {
    const first = await client.status({ deadlineMs: 30000 });
    assert.equal(first.ready, true);
    pid = first.pid;

    // Leave the owner file untouched across ~40 poll cycles; a healthy sole owner must not step down.
    await delay(800);

    assert.equal(await waitForExit(pid, 10), false, 'sole owner must stay alive');
    const after = await client.status({ deadlineMs: 30000 });
    assert.equal(after.ready, true);
    assert.equal(after.incarnationId, first.incarnationId);
    assert.equal(after.pid, first.pid);
  } finally {
    await createSearchDaemonClient({ runtimeDir, binaryPath, env })
      .shutdown({ deadlineMs: 5000 })
      .catch(() => {});
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('socketPathForOwner yields a unique path per incarnation nonce', () => {
  const desired = desiredOwnerIdentity(path.join(repoRoot, 'dist', 'optsidian'));
  const runtimeDir = tempRoot();
  try {
    const a = socketPathForOwner(runtimeDir, desired, 'aaaaaaaa');
    const b = socketPathForOwner(runtimeDir, desired, 'bbbbbbbb');
    const base = socketPathForOwner(runtimeDir, desired);
    assert.notEqual(a, b);
    assert.notEqual(a, base);
    assert.notEqual(b, base);
    assert.match(a, /-aaaaaaaa\.sock$/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

function successorFixture(label, envOverrides = {}) {
  const runtimeDir = tempRoot();
  const binaryPath = process.execPath;
  const desired = desiredOwnerIdentity(binaryPath);
  const registry = createOwnerRegistry({ runtimeDir, desired });
  const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const observedOwner = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, `${label}-old`),
    1,
    `${label}-observed`,
    process.pid,
    new Date(0).toISOString(),
  );
  const intendedOwner = createOwnerRecord(
    desired,
    socketPathForOwner(runtimeDir, desired, `${label}-new`),
    2,
    `${label}-intended`,
    process.pid,
    new Date(nowMs).toISOString(),
  );
  registry.writeOwner(observedOwner);
  return {
    runtimeDir,
    desired,
    registry,
    observedOwner,
    intendedOwner,
    healthProof: { kind: 'wedged', observedAtMs: nowMs, startupGraceExpired: true },
    now: () => nowMs,
    env: {
      ...process.env,
      OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_BASE_MS: '0',
      OPTSIDIAN_SEARCH_DAEMON_CHURN_BACKOFF_MAX_MS: '0',
      ...envOverrides,
    },
  };
}

function claimSuccessor(fixture, overrides = {}) {
  return tryClaimSuccessor(fixture.registry, fixture.observedOwner, fixture.healthProof, {
    desired: fixture.desired,
    intendedOwner: {
      ...fixture.intendedOwner,
      incarnationId:
        overrides.incarnationId ?? `${fixture.intendedOwner.incarnationId}-${overrides.claimId ?? 'claim'}`,
    },
    deadlineMs: overrides.deadlineMs ?? fixture.now(),
    now: fixture.now,
    env: fixture.env,
    claimId: overrides.claimId,
    token: overrides.token ?? createProcessToken(process.pid),
    pollMs: 0,
    backstopTtlMs: 1000,
  });
}

function token(pid, startId) {
  return { pid, startId };
}

function supersessionPayload(owner, id, startedAtMs, markerPath = 'reaped-marker.json') {
  return {
    id,
    predecessor: {
      uid: owner.slot.uid,
      epoch: owner.epoch,
      incarnationId: owner.incarnationId,
      pid: owner.pid,
    },
    reapedMarkerPath: markerPath,
    startedAtMs,
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

async function waitForDead(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
  process.kill(pid, 'SIGKILL');
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`daemon did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal, stderr: stderr.join('') });
    };
    const onStderr = (chunk) => {
      stderr.push(String(chunk));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    }

    child.once('error', onError);
    child.once('exit', onExit);
    child.stderr?.on('data', onStderr);
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonEnv(runtimeDir) {
  return {
    ...process.env,
    OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: runtimeDir,
    OPTSIDIAN_SEARCH_EXTRA_LANGS: '',
    OPTSIDIAN_SEARCH_QUERY_WORKERS: '1',
    OPTSIDIAN_SEARCH_INDEX_WORKERS: '1',
    OPTSIDIAN_SEARCH_EXECUTION_WORKERS: '1',
    OPTSIDIAN_SEARCH_DAEMON_IDLE_MS: '60000',
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-daemon-handoff-'));
}
