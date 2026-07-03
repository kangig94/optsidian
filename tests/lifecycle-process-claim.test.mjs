import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProcessToken, isAlive } from '../src/core/lifecycle/process-token.ts';
import {
  ExclusiveClaim,
  ExclusiveClaimBusyError,
  readExclusiveClaimOwner,
} from '../src/core/lifecycle/exclusive-claim.ts';
import { installArtifact, stagingNamespaceName } from '../src/core/lifecycle/artifact-install.ts';

test('ProcessToken proves live and dead processes and rejects pid reuse by start identity', async () => {
  const current = createProcessToken();
  assert.equal(isAlive(current), true);

  const reusedPid = { pid: current.pid, startId: `${current.startId}:not-the-same-start` };
  assert.equal(isAlive(reusedPid), false);

  const child = spawnSleeper();
  try {
    const childToken = await createTokenForPid(child.pid);
    assert.equal(isAlive(childToken), true);
    child.kill();
    await waitForExit(child);
    assert.equal(isAlive(childToken), false);
  } finally {
    if (!child.killed) child.kill();
  }
});

test('ExclusiveClaim does not reclaim a provably live holder', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'claim');
  try {
    const holder = await ExclusiveClaim.acquire(claimDir, {
      token: createProcessToken(),
      claimId: 'live-holder',
      timeoutMs: 0,
    });
    try {
      await assert.rejects(
        () => ExclusiveClaim.acquire(claimDir, { timeoutMs: 30, pollMs: 5 }),
        (error) => error instanceof ExclusiveClaimBusyError,
      );
      assert.equal(readExclusiveClaimOwner(claimDir)?.claimId, 'live-holder');
    } finally {
      assert.equal(holder.release(), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ExclusiveClaim immediately reclaims a dead holder', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'claim');
  const child = spawnSleeper();
  try {
    const deadToken = await createTokenForPid(child.pid);
    await ExclusiveClaim.acquire(claimDir, {
      token: deadToken,
      claimId: 'dead-holder',
      timeoutMs: 0,
    });
    child.kill();
    await waitForExit(child);

    const successor = await ExclusiveClaim.acquire(claimDir, {
      token: createProcessToken(),
      claimId: 'successor',
      timeoutMs: 100,
      pollMs: 5,
    });
    try {
      assert.equal(readExclusiveClaimOwner(claimDir)?.claimId, 'successor');
    } finally {
      assert.equal(successor.release(), true);
    }
  } finally {
    if (!child.killed) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8 installArtifact does not reclaim a live holder', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'claim');
  const artifactDir = path.join(root, 'artifact');
  const holder = await ExclusiveClaim.acquire(claimDir, {
    token: createProcessToken(),
    claimId: 'live-holder',
    timeoutMs: 0,
  });
  let staged = false;
  try {
    await assert.rejects(
      () =>
        installArtifact({
          artifactDir,
          claimDir,
          verifyDepth: 'metadata',
          timeoutMs: 30,
          pollMs: 5,
          verifyInstalled: () => undefined,
          stage: () => {
            staged = true;
          },
          computeChecksum: () => 'unused',
        }),
      (error) => error instanceof ExclusiveClaimBusyError,
    );
    assert.equal(staged, false);
    assert.equal(readExclusiveClaimOwner(claimDir)?.claimId, 'live-holder');
  } finally {
    holder.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8 installArtifact reclaims dead and pid-reused holders without waiting for mtime', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'claim');
  const artifactDir = path.join(root, 'artifact');
  const current = createProcessToken();
  await ExclusiveClaim.acquire(claimDir, {
    token: { pid: current.pid, startId: `${current.startId}:old-process` },
    claimId: 'pid-reused-holder',
    timeoutMs: 0,
  });

  try {
    const result = await installArtifact({
      artifactDir,
      claimDir,
      verifyDepth: 'digest',
      timeoutMs: 100,
      pollMs: 5,
      verifyInstalled: verifyTinyArtifact,
      stage: (stagingDir) => {
        fs.writeFileSync(path.join(stagingDir, 'payload.txt'), 'installed\n');
      },
      computeChecksum: (stagingDir) => sha256(fs.readFileSync(path.join(stagingDir, 'payload.txt'))),
    });

    assert.equal(result.activated, true);
    assert.equal(result.artifact, 'installed\n');
    assert.equal(readExclusiveClaimOwner(claimDir), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8 installArtifact sweeps orphaned staging namespaces on acquire', async () => {
  const root = tempRoot();
  const claimDir = path.join(root, 'claim');
  const artifactDir = path.join(root, 'artifact');
  const stagingRoot = path.join(root, 'staging');
  const current = createProcessToken();
  const deadToken = { pid: current.pid, startId: `${current.startId}:dead-staging-owner` };
  const orphan = path.join(stagingRoot, stagingNamespaceName(deadToken));
  fs.mkdirSync(path.join(orphan, 'old-claim'), { recursive: true });
  fs.writeFileSync(
    path.join(orphan, 'owner.json'),
    `${JSON.stringify({
      token: deadToken,
      claimId: 'old-claim',
      createdAtMs: Date.now(),
    })}\n`,
  );

  try {
    await installArtifact({
      artifactDir,
      claimDir,
      stagingRoot,
      verifyDepth: 'metadata',
      timeoutMs: 100,
      pollMs: 5,
      verifyInstalled: verifyTinyArtifact,
      stage: (stagingDir) => {
        fs.writeFileSync(path.join(stagingDir, 'payload.txt'), 'swept\n');
      },
      computeChecksum: (stagingDir) => sha256(fs.readFileSync(path.join(stagingDir, 'payload.txt'))),
    });

    assert.equal(fs.existsSync(orphan), false);
    assert.equal(verifyTinyArtifact(artifactDir), 'swept\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'optsidian-lifecycle-claim-'));
}

function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);'], {
    stdio: 'ignore',
  });
}

async function createTokenForPid(pid) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return createProcessToken(pid);
    } catch (error) {
      lastError = error;
      await delay(5);
    }
  }
  throw lastError;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyTinyArtifact(artifactDir) {
  try {
    const file = path.join(artifactDir, 'payload.txt');
    const stat = fs.statSync(file);
    return stat.isFile() ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
