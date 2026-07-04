import assert from 'node:assert/strict';
import test from 'node:test';

import { LevelReconciler } from '../src/core/lifecycle/level-reconciler.ts';

test('LevelReconciler recomputes from enumerable world and drains before stop', async () => {
  const world = [];
  const acted = [];
  const acked = [];
  const reconciler = new LevelReconciler({
    enumerate() {
      return [...world];
    },
    fold(snapshot, batch) {
      return {
        snapshot,
        dirty: batch.dirty,
        intents: [...batch.intents],
      };
    },
    act(folded) {
      acted.push(folded);
      return folded;
    },
    ack(result) {
      acked.push(result);
    },
  });

  reconciler.start();
  world.push('first');
  reconciler.markDirty();
  await reconciler.drain();

  assert.deepEqual(acted, [{ snapshot: ['first'], dirty: true, intents: [] }]);
  assert.deepEqual(acked, acted);

  world.push('second');
  reconciler.enqueueIntent('publish');
  await reconciler.stop({ drain: true });

  assert.equal(reconciler.isStopped, true);
  assert.deepEqual(acted.at(-1), { snapshot: ['first', 'second'], dirty: false, intents: ['publish'] });
  assert.deepEqual(acked, acted);

  reconciler.markDirty();
  await delay(10);
  assert.equal(acted.length, 2);
});

test('LevelReconciler hands enumerate and fold failures the undrained batch', async () => {
  await assertFailurePhaseSettlesWaiter('enumerate');
  await assertFailurePhaseSettlesWaiter('fold');
});

async function assertFailurePhaseSettlesWaiter(failingPhase) {
  let failNext = true;
  const errors = [];
  const acted = [];
  const reconciler = new LevelReconciler({
    enumerate() {
      if (failingPhase === 'enumerate' && failNext) {
        failNext = false;
        throw new Error('enumerate failed');
      }
      return {};
    },
    fold(_world, batch) {
      if (failingPhase === 'fold' && failNext) {
        failNext = false;
        throw new Error('fold failed');
      }
      return [...batch.intents];
    },
    act(intents) {
      for (const intent of intents) {
        acted.push(intent.name);
        intent.resolve(`acted:${intent.name}`);
      }
    },
    onError(error, context) {
      errors.push({ error, phase: context.phase, intents: context.batch.intents.map((intent) => intent.name) });
      for (const intent of context.batch.intents) intent.reject(error);
    },
  });

  reconciler.start();
  const failed = createIntent('failed');
  reconciler.enqueueIntent(failed);
  await assert.rejects(failed.promise, new RegExp(`${failingPhase} failed`));
  assert.deepEqual(errors, [
    {
      error: errors[0].error,
      phase: failingPhase,
      intents: ['failed'],
    },
  ]);

  const subsequent = createIntent('subsequent');
  reconciler.enqueueIntent(subsequent);
  assert.equal(await subsequent.promise, 'acted:subsequent');
  assert.deepEqual(acted, ['subsequent']);

  await reconciler.stop({ drain: true });
}

function createIntent(name) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { name, promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
