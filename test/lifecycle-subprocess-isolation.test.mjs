import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoralNeedleProcessInstanceFactory } from "../src/daemon/vector-store/process-instance.ts";

test("AC5 crashed coral-needle subprocess rejects calls without unhandled retire rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-subprocess-isolation-"));
  const scriptPath = path.join(root, "crash-child.mjs");
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    fs.writeFileSync(scriptPath, "process.exit(42);\n");
    const factory = createCoralNeedleProcessInstanceFactory({
      scriptPath,
      bindingPath: path.join(root, "fake-coral-needle.node")
    });
    const instance = await factory.create({
      role: "query",
      key: { vaultStateHash: "vault", embeddingSetId: "embedding" },
      generationId: "gen-crash",
      dbPath: path.join(root, "db")
    });

    await assert.rejects(
      () => instance.initStore(path.join(root, "db")),
      /coral-needle process exited|Channel closed|ERR_IPC_CHANNEL_CLOSED/
    );
    await instance.close();
    await delay(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
