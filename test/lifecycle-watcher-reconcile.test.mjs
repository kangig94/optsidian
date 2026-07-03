import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VaultChangeProducer,
  docIdForVaultPath
} from "../src/daemon/vector-store/watcher.ts";

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-watcher-reconcile-"));
}

function writeVaultFile(vault, relPath, content) {
  const abs = path.join(vault, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function markFor(vault, relPath) {
  return {
    docId: docIdForVaultPath(relPath),
    path: relPath,
    contentHash: sha256(fs.readFileSync(path.join(vault, relPath)))
  };
}

function fakeWatchFactory() {
  const listeners = new Map();
  const closed = [];
  let unrefCount = 0;
  return {
    listeners,
    closed,
    get unrefCount() {
      return unrefCount;
    },
    watchDirectory(dir, listener) {
      listeners.set(dir, listener);
      return {
        close() {
          closed.push(dir);
        },
        unref() {
          unrefCount += 1;
        }
      };
    }
  };
}

function fakeIntervalFactory() {
  const created = [];
  const cleared = [];
  let unrefCount = 0;
  return {
    created,
    cleared,
    get unrefCount() {
      return unrefCount;
    },
    setInterval(callback, ms) {
      const timer = {
        callback,
        ms,
        unref() {
          unrefCount += 1;
        }
      };
      created.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    }
  };
}

test("AC4 delete and recreate of a watched directory reopens the handle and converges", async () => {
  const vault = tempVault();
  writeVaultFile(vault, "Dir/A.md", "before\n");
  const fake = fakeWatchFactory();
  const emitted = [];
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 1000,
    watchDirectory: fake.watchDirectory,
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    const root = fs.realpathSync(vault);
    const dir = path.join(root, "Dir");
    const rootListener = fake.listeners.get(root);
    const oldDirListener = fake.listeners.get(dir);
    assert.equal(typeof rootListener, "function");
    assert.equal(typeof oldDirListener, "function");

    fs.rmSync(dir, { recursive: true, force: true });
    writeVaultFile(vault, "Dir/A.md", "after recreate\n");
    rootListener("rename", "Dir");

    assert.ok(fake.closed.includes(dir), "old watched directory handle was closed");
    const reopenedDirListener = fake.listeners.get(dir);
    assert.equal(typeof reopenedDirListener, "function");
    assert.notEqual(reopenedDirListener, oldDirListener);

    let marks = await producer.flushNow();
    const recreatedMark = markFor(vault, "Dir/A.md");
    assert.deepEqual(marks, [recreatedMark]);

    fs.writeFileSync(path.join(vault, "Dir/A.md"), "after rewatch\n");
    reopenedDirListener("change", "A.md");
    marks = await producer.flushNow();
    const rewatchedMark = markFor(vault, "Dir/A.md");
    assert.deepEqual(marks, [rewatchedMark]);
    assert.deepEqual(emitted, [recreatedMark, rewatchedMark]);
  } finally {
    producer.close();
  }
});

test("AC4 reconcile prunes only missing watchers in the reconciled subtree", async () => {
  const vault = tempVault();
  writeVaultFile(vault, "A/Dead/Child/Nested.md", "nested\n");
  writeVaultFile(vault, "B/Dead/Child/Unrelated.md", "unrelated\n");
  const fake = fakeWatchFactory();
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 1000,
    watchDirectory: fake.watchDirectory,
    onDirtyMarks() {}
  });

  try {
    const root = fs.realpathSync(vault);
    const rootListener = fake.listeners.get(root);
    const aDead = path.join(root, "A", "Dead");
    const aChild = path.join(aDead, "Child");
    const bDead = path.join(root, "B", "Dead");
    const bChild = path.join(bDead, "Child");
    assert.equal(typeof rootListener, "function");
    assert.equal(typeof fake.listeners.get(aDead), "function");
    assert.equal(typeof fake.listeners.get(aChild), "function");
    assert.equal(typeof fake.listeners.get(bDead), "function");
    assert.equal(typeof fake.listeners.get(bChild), "function");

    fs.rmSync(aDead, { recursive: true, force: true });
    fs.rmSync(bDead, { recursive: true, force: true });
    rootListener("rename", "A");

    assert.ok(fake.closed.includes(aDead), "dead watched directory under reconciled subtree was closed");
    assert.ok(fake.closed.includes(aChild), "dead watched descendant under reconciled subtree was closed");
    assert.equal(fake.closed.includes(bDead), false, "missing watched directory outside reconciled subtree stayed open");
    assert.equal(fake.closed.includes(bChild), false, "missing watched descendant outside reconciled subtree stayed open");
  } finally {
    producer.close();
  }
});

test("AC4 periodic backstop closes a missing watched directory without a reconcile event", async () => {
  const vault = tempVault();
  writeVaultFile(vault, "Missed/Note.md", "body\n");
  const fake = fakeWatchFactory();
  const interval = fakeIntervalFactory();
  const emitted = [];
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 1000,
    fallbackPollMs: 1234,
    watchDirectory: fake.watchDirectory,
    setInterval: interval.setInterval,
    clearInterval: interval.clearInterval,
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    const root = fs.realpathSync(vault);
    const missed = path.join(root, "Missed");
    assert.equal(typeof fake.listeners.get(missed), "function");
    assert.equal(interval.created.length, 1);
    assert.equal(interval.created[0].ms, 1234);
    assert.equal(interval.unrefCount, 1);

    fs.rmSync(missed, { recursive: true, force: true });
    interval.created[0].callback();

    assert.ok(fake.closed.includes(missed), "periodic backstop closed the leaked watcher");
    assert.deepEqual(await producer.flushNow(), []);
    assert.deepEqual(emitted, []);

    producer.close();
    assert.deepEqual(interval.cleared, [interval.created[0]]);
  } finally {
    producer.close();
  }
});

test("AC4 moved-in trees with pre-existing markdown are marked by enumeration", async () => {
  const vault = tempVault();
  const external = tempVault();
  writeVaultFile(external, "Tree/Root.md", "root\n");
  writeVaultFile(external, "Tree/Sub/Nested.md", "nested\n");
  const fake = fakeWatchFactory();
  const emitted = [];
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 1000,
    watchDirectory: fake.watchDirectory,
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    const root = fs.realpathSync(vault);
    const rootListener = fake.listeners.get(root);
    assert.equal(typeof rootListener, "function");

    fs.renameSync(path.join(external, "Tree"), path.join(vault, "Tree"));
    rootListener("rename", "Tree");

    assert.equal(typeof fake.listeners.get(path.join(root, "Tree")), "function");
    assert.equal(typeof fake.listeners.get(path.join(root, "Tree", "Sub")), "function");
    const marks = await producer.flushNow();
    assert.deepEqual(
      marks.map((mark) => mark.path).sort(),
      ["Tree/Root.md", "Tree/Sub/Nested.md"]
    );
    assert.deepEqual(emitted.map((mark) => mark.path).sort(), ["Tree/Root.md", "Tree/Sub/Nested.md"]);
  } finally {
    producer.close();
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("AC4 fs.watch error routes to fallback reconcile scan", async () => {
  const vault = tempVault();
  writeVaultFile(vault, "Note.md", "body\n");
  const realWatch = fs.watch;
  const created = [];
  fs.watch = (dir, listener) => {
    const watcher = realWatch(dir, listener);
    created.push(watcher);
    return watcher;
  };
  let producer;
  try {
    producer = new VaultChangeProducer({ vaultRoot: vault, debounceMs: 1000, onDirtyMarks() {} });
    assert.equal(producer.usingFallbackScan(), false);
    assert.ok(created.length > 0);
    created[0].emit("error", new Error("simulated watch error"));
    await waitFor(() => producer.usingFallbackScan() === true);
  } finally {
    fs.watch = realWatch;
    producer?.close();
  }
});

test("AC4 reconcile preserves delete marks and dotdir skip behavior", async () => {
  const vault = tempVault();
  const note = writeVaultFile(vault, "Delete.md", "delete\n");
  writeVaultFile(vault, ".hidden/Hidden.md", "hidden\n");
  const fake = fakeWatchFactory();
  const emitted = [];
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 1000,
    watchDirectory: fake.watchDirectory,
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    const root = fs.realpathSync(vault);
    const rootListener = fake.listeners.get(root);
    assert.equal(typeof rootListener, "function");
    assert.equal([...fake.listeners.keys()].some((dir) => dir.includes(`${path.sep}.hidden`)), false);

    fs.rmSync(note);
    rootListener("rename", "Delete.md");
    rootListener("rename", ".hidden");
    rootListener("change", ".hidden/Hidden.md");

    const marks = await producer.flushNow();
    assert.deepEqual(marks, [{
      docId: docIdForVaultPath("Delete.md"),
      path: "Delete.md"
    }]);
    assert.deepEqual(emitted, marks);
  } finally {
    producer.close();
  }
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
