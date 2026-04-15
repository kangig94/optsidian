import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-core-"));
}

async function core() {
  return import(path.resolve("src/core/index.ts"));
}

test("core write/read preserves shell-sensitive raw payloads", async () => {
  const vault = tempVault();
  const { readVaultFile, searchVault, writeVaultFile } = await core();
  const raw = [
    "literal $HOME",
    "subshell $(echo hacked)",
    "backticks `uname -a`",
    "quotes 'single' \"double\"",
    "```bash",
    "echo \"$HOME\" && echo $(whoami)",
    "```",
    ""
  ].join("\n");

  const write = writeVaultFile(vault, { path: "raw.md", content: raw });
  assert.equal(write.ok, true);
  assert.equal(write.command, "write");
  assert.equal(write.changes[0].after, raw);
  assert.equal(fs.readFileSync(path.join(vault, "raw.md"), "utf8"), raw);

  const read = readVaultFile(vault, { path: "raw.md" });
  assert.equal(read.path, "raw.md");
  assert.match(read.content, /\$HOME/);
  assert.match(read.content, /\$\(echo hacked\)/);
  assert.match(read.content, /`uname -a`/);

  const search = searchVault(vault, { query: "$(whoami)" });
  assert.equal(search.count, 1);
  assert.equal(search.matches[0].text, "echo \"$HOME\" && echo $(whoami)");
});

test("core edit treats replacement and selectors as literal data", async () => {
  const vault = tempVault();
  const { editVaultFile, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "note.md", content: "alpha $HOME\nbeta\n" });

  const edit = editVaultFile(vault, {
    path: "note.md",
    selector: { kind: "replace", value: "alpha $HOME" },
    replacement: "literal $(date) and `id`"
  });

  assert.equal(edit.command, "edit");
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "literal $(date) and `id`\nbeta\n");
});

test("core apply_patch accepts raw patch text without shell staging", async () => {
  const vault = tempVault();
  const { applyVaultPatch } = await core();
  const patch = `*** Begin Patch
*** Add File: patch.md
+# Raw payload
+$HOME
+$(whoami)
+\`pwd\`
+\`\`\`ts
+const value = "$HOME";
+\`\`\`
*** End Patch
`;

  const result = applyVaultPatch(vault, { patch });
  assert.equal(result.command, "apply_patch");
  assert.deepEqual(result.changes.map((change) => [change.code, change.path]), [["A", "patch.md"]]);
  assert.equal(
    fs.readFileSync(path.join(vault, "patch.md"), "utf8"),
    "# Raw payload\n$HOME\n$(whoami)\n`pwd`\n```ts\nconst value = \"$HOME\";\n```\n"
  );
});

test("core validates adapter-independent numeric parameters", async () => {
  const vault = tempVault();
  const { editVaultFile, readVaultFile, searchVault, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "note.md", content: "one\ntwo\n" });

  assert.throws(() => readVaultFile(vault, { path: "note.md", head: 0 }), /head must be a positive integer/);
  assert.throws(() => readVaultFile(vault, { path: "note.md", lines: { start: 3, end: 2 } }), /lines\.end must be >= lines\.start/);
  assert.throws(() => searchVault(vault, { query: "one", context: -1 }), /context must be a non-negative integer/);
  assert.throws(
    () => editVaultFile(vault, { path: "note.md", selector: { kind: "range", value: { start: 2, end: 1 } }, replacement: "x" }),
    /range\.end must be >= range\.start/
  );
});

test("core copy reports overwrite as modification", async () => {
  const vault = tempVault();
  const { copyVaultPath, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "source.md", content: "new\n" });
  writeVaultFile(vault, { path: "dest.md", content: "old\n" });

  const result = copyVaultPath(vault, { from: "source.md", to: "dest.md", overwrite: true });
  assert.equal(result.changes[0].code, "M");
  assert.equal(fs.readFileSync(path.join(vault, "dest.md"), "utf8"), "new\n");
});

test("core apply_patch refuses unsafe overwrites", async () => {
  const vault = tempVault();
  const { applyVaultPatch, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "existing.md", content: "old\n" });
  writeVaultFile(vault, { path: "source.md", content: "source\n" });
  writeVaultFile(vault, { path: "target.md", content: "target\n" });

  assert.throws(
    () => applyVaultPatch(vault, { patch: "*** Begin Patch\n*** Add File: existing.md\n+new\n*** End Patch\n" }),
    /Refusing to add existing file/
  );
  assert.equal(fs.readFileSync(path.join(vault, "existing.md"), "utf8"), "old\n");

  const moveOverExisting = `*** Begin Patch
*** Update File: source.md
*** Move to: target.md
@@
-source
+moved
*** End Patch
`;
  assert.throws(() => applyVaultPatch(vault, { patch: moveOverExisting }), /Refusing to move over existing file/);
  assert.equal(fs.readFileSync(path.join(vault, "source.md"), "utf8"), "source\n");
  assert.equal(fs.readFileSync(path.join(vault, "target.md"), "utf8"), "target\n");
});
