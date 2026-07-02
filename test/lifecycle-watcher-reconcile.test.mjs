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
