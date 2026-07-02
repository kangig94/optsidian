import assert from "node:assert/strict";
import test from "node:test";

import { LevelReconciler } from "../src/core/lifecycle/level-reconciler.ts";

test("LevelReconciler recomputes from enumerable world and drains before stop", async () => {
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
        intents: [...batch.intents]
      };
    },
    act(folded) {
      acted.push(folded);
      return folded;
    },
    ack(result) {
      acked.push(result);
    }
  });

  reconciler.start();
  world.push("first");
  reconciler.markDirty();
  await reconciler.drain();

  assert.deepEqual(acted, [{ snapshot: ["first"], dirty: true, intents: [] }]);
  assert.deepEqual(acked, acted);

  world.push("second");
  reconciler.enqueueIntent("publish");
  await reconciler.stop({ drain: true });

  assert.equal(reconciler.isStopped, true);
  assert.deepEqual(acted.at(-1), { snapshot: ["first", "second"], dirty: false, intents: ["publish"] });
  assert.deepEqual(acked, acted);

  reconciler.markDirty();
  await delay(10);
  assert.equal(acted.length, 2);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
