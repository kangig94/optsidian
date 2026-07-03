import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readVaultFileHardened } from "../src/core/path.ts";
import {
  VaultChangeProducer,
  docIdForVaultPath
} from "../src/daemon/vector-store/watcher.ts";

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-watcher-ac7-"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeVaultFile(vault, relPath, content) {
  const abs = path.join(vault, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
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

test("AC7 watcher producer coalesces rename+write into one content-hashed dirty mark", async () => {
  const vault = tempVault();
  const note = writeVaultFile(vault, "Note.md", "before\n");
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
    const listener = fake.listeners.get(root);
    assert.equal(typeof listener, "function");
    assert.equal(fake.unrefCount > 0, true);

    fs.writeFileSync(note, "after\n");
    listener("rename", "Note.md");
    listener("change", "Note.md");

    const marks = await producer.flushNow();
    assert.equal(marks.length, 1);
    assert.equal(emitted.length, 1);
    assert.deepEqual(marks[0], {
      docId: docIdForVaultPath("Note.md"),
      path: "Note.md",
      contentHash: sha256(fs.readFileSync(note))
    });
  } finally {
    producer.close();
  }
});

test("hardened vault read rejects a symlink swap after path resolution without reading outside the vault", () => {
  const vault = tempVault();
  const outsideDir = tempVault();
  const note = writeVaultFile(vault, "Swap.md", "inside\n");
  const outside = writeVaultFile(outsideDir, "secret.md", "outside-secret\n");
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  let readCount = 0;
  fs.openSync = function patchedOpenSync(file, flags, mode) {
    if (!swapped && path.resolve(String(file)) === path.resolve(note)) {
      swapped = true;
      fs.rmSync(note);
      fs.symlinkSync(outside, note);
    }
    return originalOpenSync.call(this, file, flags, mode);
  };
  fs.readFileSync = function patchedReadFileSync(file, options) {
    readCount += 1;
    return originalReadFileSync.call(this, file, options);
  };

  try {
    assert.throws(() => readVaultFileHardened(vault, "Swap.md"));
    assert.equal(swapped, true);
    assert.equal(readCount, 0);
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("AC7 watcher producer emits a delete dirty mark when fs-watch observes a markdown unlink", async () => {
  const vault = tempVault();
  const note = writeVaultFile(vault, "Delete.md", "delete me\n");
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
    const listener = fake.listeners.get(root);
    assert.equal(typeof listener, "function");

    fs.rmSync(note);
    listener("rename", "Delete.md");

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

test("AC7 watcher producer ignores .obsidian and dotdir churn at enumeration and runtime discovery", async () => {
  const vault = tempVault();
  writeVaultFile(vault, "A.md", "alpha\n");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
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
    assert.equal([...fake.listeners.keys()].some((dir) => dir.includes(`${path.sep}.obsidian`)), false);
    assert.equal([...fake.listeners.keys()].some((dir) => dir.includes(`${path.sep}.hidden`)), false);

    const listener = fake.listeners.get(root);
    assert.equal(typeof listener, "function");
    listener("change", ".obsidian/churn.md");
    listener("rename", ".hidden");
    listener("change", ".hidden/Hidden.md");

    fs.mkdirSync(path.join(vault, ".runtime"), { recursive: true });
    listener("rename", ".runtime");
    assert.equal([...fake.listeners.keys()].some((dir) => dir.includes(`${path.sep}.runtime`)), false);

    const marks = await producer.flushNow();
    assert.deepEqual(marks, []);
    assert.deepEqual(emitted, []);
  } finally {
    producer.close();
  }
});

test("AC7 watcher producer falls back to a periodic content-delta scan when watch registration fails", async () => {
  const vault = tempVault();
  const note = writeVaultFile(vault, "Scan.md", "before\n");
  const emitted = [];
  let watchAttempts = 0;
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 5,
    fallbackPollMs: 15,
    watchDirectory() {
      watchAttempts += 1;
      throw new Error("inotify exhausted");
    },
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    assert.equal(watchAttempts > 0, true);
    assert.equal(producer.usingFallbackScan(), true);
    fs.writeFileSync(note, "after\n");
    await waitFor(() => emitted.length === 1);
    assert.deepEqual(emitted[0], {
      docId: docIdForVaultPath("Scan.md"),
      path: "Scan.md",
      contentHash: sha256(fs.readFileSync(note))
    });
  } finally {
    producer.close();
  }
});

test("AC7 fallback scan emits a delete dirty mark when a known markdown path disappears", async () => {
  const vault = tempVault();
  const note = writeVaultFile(vault, "ScanDelete.md", "before\n");
  const emitted = [];
  const producer = new VaultChangeProducer({
    vaultRoot: vault,
    debounceMs: 5,
    fallbackPollMs: 15,
    watchDirectory() {
      throw new Error("inotify exhausted");
    },
    onDirtyMarks(marks) {
      emitted.push(...marks);
    }
  });

  try {
    assert.equal(producer.usingFallbackScan(), true);
    fs.rmSync(note);
    await waitFor(() => emitted.length === 1);
    assert.deepEqual(emitted[0], {
      docId: docIdForVaultPath("ScanDelete.md"),
      path: "ScanDelete.md"
    });
  } finally {
    producer.close();
  }
});

test("default watcher factory routes an fs.watch 'error' event to the fallback scan instead of crashing", async () => {
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
    // No watchDirectory injected → the production default factory is used, which must attach the
    // 'error' listener. Emitting 'error' would throw as an uncaughtException without that listener.
    producer = new VaultChangeProducer({ vaultRoot: vault, debounceMs: 1000, onDirtyMarks() {} });
    assert.equal(producer.usingFallbackScan(), false);
    assert.ok(created.length > 0, "default factory created at least one fs.watch handle");
    created[0].emit("error", new Error("simulated watch error"));
    await waitFor(() => producer.usingFallbackScan() === true);
  } finally {
    fs.watch = realWatch;
    producer?.close();
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
