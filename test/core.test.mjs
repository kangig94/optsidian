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

test("markdown search parser extracts title aliases tags headings and body", async () => {
  const { parseMarkdownNote } = await import(path.resolve("src/core/search-parse.ts"));
  const doc = parseMarkdownNote(
    "Projects/alpha.md",
    `---
title: Alpha Project
aliases:
  - Project A
tags: [project, alpha]
---
# Alpha Heading

Body with #rollout tag.
`
  );

  assert.equal(doc.title, "Alpha Project");
  assert.deepEqual(doc.aliases, ["Project A"]);
  assert.deepEqual(doc.tags.sort(), ["alpha", "project", "rollout"]);
  assert.deepEqual(doc.headings, ["Alpha Heading"]);
  assert.match(doc.body, /Body with #rollout tag/);
});

test("core write/read preserves shell-sensitive raw payloads", async () => {
  const vault = tempVault();
  const { grepVault, readVaultFile, writeVaultFile } = await core();
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

  const grep = grepVault(vault, { query: "$(whoami)" });
  assert.equal(grep.count, 1);
  assert.equal(grep.matches[0].text, "echo \"$HOME\" && echo $(whoami)");
});

test("core ranked search uses metadata fields and external cache", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const { getSearchIndexStatus, searchVault, writeVaultFile } = await core();
    writeVaultFile(vault, {
      path: "Projects/Alpha.md",
      content: `---
title: Alpha
tags:
  - project
  - alpha
aliases:
  - Project Alpha
---
# Rollout

The rollout is blocked by review.
`
    });
    writeVaultFile(vault, {
      path: "Archive/body.md",
      content: "This note only mentions project alpha in passing.\n"
    });

    const result = await searchVault(vault, { query: "project alpha", limit: 2 });
    assert.equal(result.command, "search");
    assert.equal(result.index.status, "rebuilt");
    assert.equal(result.matches[0].path, "Projects/Alpha.md");
    assert.deepEqual(result.matches[0].aliases, ["Project Alpha"]);
    assert.ok(result.matches[0].matchedFields.includes("tags"));
    assert.deepEqual(result.matches[0].fieldMatches.aliases, ["project", "alpha"]);
    assert.deepEqual(result.matches[0].fieldMatches.tags, ["project", "alpha"]);
    assert.match(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /Rollout|project|alpha/i);
    assert.doesNotMatch(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /title:|tags:|aliases:/i);

    const scoped = await searchVault(vault, { query: "project alpha", path: "Projects", limit: 2 });
    assert.equal(scoped.scope, "Projects");
    assert.deepEqual(scoped.matches.map((match) => match.path), ["Projects/Alpha.md"]);

    const fieldFiltered = await searchVault(vault, { query: "review", fields: ["title"], limit: 2 });
    assert.equal(fieldFiltered.matches.length, 0);

    const tagFiltered = await searchVault(vault, { query: "project alpha", tags: ["project", "alpha"], limit: 2 });
    assert.deepEqual(tagFiltered.filters, { tags: ["project", "alpha"], fields: undefined });
    assert.deepEqual(tagFiltered.matches.map((match) => match.path), ["Projects/Alpha.md"]);

    const tagOnly = await searchVault(vault, { tags: ["project"], limit: 2 });
    assert.equal(tagOnly.query, undefined);
    assert.equal(tagOnly.matches[0].score, 0);
    assert.deepEqual(tagOnly.matches.map((match) => match.path), ["Projects/Alpha.md"]);
    assert.equal(tagOnly.matches[0].matchedFields.length, 0);

    writeVaultFile(vault, {
      path: "Projects/Beta.md",
      content: `---
tags: [project]
---
# Beta

Another project note.
`
    });
    await searchVault(vault, { query: "project", limit: 5 });
    const originalRead = fs.readFileSync;
    const noteReads = [];
    fs.readFileSync = function patchedRead(filePath, ...rest) {
      if (typeof filePath === "string" && filePath.endsWith(".md")) {
        noteReads.push(path.basename(filePath));
      }
      return originalRead.call(this, filePath, ...rest);
    };
    try {
      const limitedTagOnly = await searchVault(vault, { tags: ["project"], limit: 1 });
      assert.equal(limitedTagOnly.matches.length, 1);
      assert.equal(noteReads.length, 1);
    } finally {
      fs.readFileSync = originalRead;
    }

    const status = getSearchIndexStatus(vault);
    assert.equal(status.ready, true);
    assert.equal(status.stale, false);
    assert.match(status.cacheDir, new RegExp(`^${cache.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(status.cacheDir.startsWith(vault), false);

    await assert.rejects(() => searchVault(vault, { path: "Projects", limit: 2 }), /query=<text> or tag=<tag>/);
    await assert.rejects(() => searchVault(vault, { query: "review", fields: ["unknown"], limit: 2 }), /field must be one of/);
    await assert.rejects(() => searchVault(vault, { tags: ["project"], fields: ["title"], limit: 2 }), /field=<field> requires query=<text>/);
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
  }
});

test("core frontmatter reads and mutates structured YAML while preserving body", async () => {
  const vault = tempVault();
  const {
    addFrontmatterValue,
    deleteFrontmatter,
    readFrontmatter,
    removeFrontmatterValue,
    setFrontmatter
  } = await core();
  fs.writeFileSync(
    path.join(vault, "note.md"),
    "\uFEFF---\r\nstatus: draft\r\ntags:\r\n  - project\r\n---\r\n# Title\r\nBody\r\n"
  );

  let read = readFrontmatter(vault, { path: "note.md" });
  assert.equal(read.hasFrontmatter, true);
  assert.equal(read.frontmatter.status, "draft");
  assert.deepEqual(read.frontmatter.tags, ["project"]);

  const set = setFrontmatter(vault, { path: "note.md", key: "priority", value: 3 });
  assert.equal(set.command, "frontmatter");
  let content = fs.readFileSync(path.join(vault, "note.md"), "utf8");
  assert.ok(content.startsWith("\uFEFF---\r\n"));
  assert.match(content, /priority: 3\r\n/);
  assert.ok(content.endsWith("# Title\r\nBody\r\n"));

  addFrontmatterValue(vault, { path: "note.md", key: "tags", value: "alpha" });
  const duplicate = addFrontmatterValue(vault, { path: "note.md", key: "tags", value: "alpha" });
  assert.equal(duplicate.changes.length, 0);
  removeFrontmatterValue(vault, { path: "note.md", key: "tags", value: "project" });
  deleteFrontmatter(vault, { path: "note.md", key: "priority" });

  read = readFrontmatter(vault, { path: "note.md" });
  assert.deepEqual(read.frontmatter.tags, ["alpha"]);
  assert.equal(read.frontmatter.priority, undefined);
});

test("core frontmatter creates blocks and rejects unsafe YAML shapes", async () => {
  const vault = tempVault();
  const { addFrontmatterValue, readFrontmatter, setFrontmatter } = await core();
  fs.writeFileSync(path.join(vault, "plain.md"), "# Plain\n");

  setFrontmatter(vault, { path: "plain.md", key: "status", value: "active", dryRun: true });
  assert.equal(fs.readFileSync(path.join(vault, "plain.md"), "utf8"), "# Plain\n");
  setFrontmatter(vault, { path: "plain.md", key: "status", value: "active" });
  assert.equal(fs.readFileSync(path.join(vault, "plain.md"), "utf8"), "---\nstatus: active\n---\n# Plain\n");
  assert.deepEqual(readFrontmatter(vault, { path: "plain.md" }).frontmatter, { status: "active" });

  fs.writeFileSync(path.join(vault, "duplicate.md"), "---\na: 1\na: 2\n---\nBody\n");
  assert.throws(() => setFrontmatter(vault, { path: "duplicate.md", key: "b", value: true }), /Map keys must be unique/);

  fs.writeFileSync(path.join(vault, "list-root.md"), "---\n- a\n---\nBody\n");
  assert.throws(() => setFrontmatter(vault, { path: "list-root.md", key: "b", value: true }), /YAML mapping/);

  fs.writeFileSync(path.join(vault, "scalar-list.md"), "---\ntags: project\n---\nBody\n");
  assert.throws(() => addFrontmatterValue(vault, { path: "scalar-list.md", key: "tags", value: "alpha" }), /not a list/);

  fs.writeFileSync(path.join(vault, "note.txt"), "status: active\n");
  assert.throws(() => readFrontmatter(vault, { path: "note.txt" }), /Markdown files/);
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
  const { editVaultFile, grepVault, readVaultFile, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "note.md", content: "one\ntwo\n" });

  assert.throws(() => readVaultFile(vault, { path: "note.md", head: 0 }), /head must be a positive integer/);
  assert.throws(() => readVaultFile(vault, { path: "note.md", lines: { start: 3, end: 2 } }), /lines\.end must be >= lines\.start/);
  assert.throws(() => grepVault(vault, { query: "one", context: -1 }), /context must be a non-negative integer/);
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
