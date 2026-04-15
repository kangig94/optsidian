import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("dist/optsidian");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-"));
}

function makeFakeObsidian(dir, vaultRoot) {
  const fake = path.join(dir, "obsidian-fake.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_OBSIDIAN_LOG) fs.appendFileSync(process.env.FAKE_OBSIDIAN_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "vault" && args[1] === "info=path") {
  console.log(process.env.FAKE_VAULT);
  process.exit(0);
}
if (args.includes("fail")) {
  console.error("native failure");
  process.exit(7);
}
console.log("native " + args.join(" "));
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...options.env }
  });
  return result;
}

function setup() {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const log = path.join(dir, "obsidian.log");
  const fake = makeFakeObsidian(dir, vault);
  const env = { OPTSIDIAN_OBSIDIAN_BIN: fake, FAKE_VAULT: vault, FAKE_OBSIDIAN_LOG: log };
  return { dir, vault, env, log };
}

test("native-sufficient commands delegate unchanged", () => {
  const { env, log } = setup();
  const result = run(["files", "folder=Dashboard"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native files folder=Dashboard");
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8").trim()), ["files", "folder=Dashboard"]);
});

test("version flag reports package version", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("policy table does not implement native-sufficient commands", async () => {
  const policy = await import(path.resolve("src/cli/policy.ts"));
  for (const command of policy.implementedCommands()) {
    assert.equal(policy.NATIVE_SUFFICIENT_COMMANDS.has(command), false, `${command} must not be both implemented and native-sufficient`);
  }
});

test("delete remains delegated to native Obsidian", () => {
  const { env, log } = setup();
  const result = run(["delete", "path=note.md"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native delete path=note.md");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["delete", "path=note.md"]);
});

test("raw preserves native exit code", () => {
  const { env } = setup();
  const result = run(["raw", "fail"], { env });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /native failure/);
});

test("read returns line-numbered ranges with metadata", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "one\ntwo\nthree\nfour\n");
  const result = run(["read", "path=note.md", "lines=2:3"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /path: note\.md/);
  assert.match(result.stdout, /lines: 2-3\/4/);
  assert.match(result.stdout, /2 \| two/);
  assert.match(result.stdout, /3 \| three/);
});

test("read caps JSON output and reports empty files as zero lines", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "empty.md"), "");
  let result = run(["read", "path=empty.md", "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).range.total, 0);

  fs.writeFileSync(path.join(vault, "long.md"), "abcdef\n");
  result = run(["read", "path=long.md", "format=json", "max-chars=3"], { env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.truncated, true);
  assert.match(payload.content, /truncated/);
});

test("grep is markdown-first and supports context", () => {
  const { vault, env } = setup();
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.writeFileSync(path.join(vault, "a.md"), "before\nneedle\nnext\n");
  fs.writeFileSync(path.join(vault, "b.js"), "needle in js\n");
  fs.writeFileSync(path.join(vault, ".obsidian", "ignored.md"), "needle hidden\n");
  const result = run(["grep", "query=needle", "context=1"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a\.md:1- \| before/);
  assert.match(result.stdout, /a\.md:2: \| needle/);
  assert.doesNotMatch(result.stdout, /b\.js/);
  assert.doesNotMatch(result.stdout, /ignored/);
});

test("search ranks notes and index commands manage cache", () => {
  const { vault, env } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cli-cache-"));
  fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "Projects", "Alpha.md"),
    "---\ntitle: Alpha\ntags: [project, alpha]\n---\n# Rollout\n\nBlocked by review.\n"
  );
  fs.writeFileSync(path.join(vault, "body.md"), "project alpha is mentioned only in body\n");

  let result = run(["search", "query=project alpha", "format=json", "limit=2"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "search");
  assert.equal(payload.matches[0].path, "Projects/Alpha.md");
  assert.equal(payload.index.status, "rebuilt");

  result = run(["index", "status"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /index: ready/);
  assert.match(result.stdout, /stale: false/);

  result = run(["index", "clear"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /index: cleared/);
});

test("write and edit mutate only optimized commands", () => {
  const { vault, env } = setup();
  let result = run(["write", "path=note.md", "content=hello\\nthere"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "hello\nthere");

  result = run(["edit", "path=note.md", "replace=hello\\nthere", "with=world"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "world");
});

test("dry-run does not write", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "old\n");
  const result = run(["edit", "path=note.md", "replace=old", "with=new", "dry-run"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "old\n");
});

test("edit treats replacement text literally", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "hello\nabc123\nabc456\n");
  let result = run(["edit", "path=note.md", "replace=hello", "with=$&"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "$&\nabc123\nabc456\n");

  result = run(["edit", "path=note.md", "regex=abc\\d+", "with=$1", "all"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "$&\n$1\n$1\n");
});

test("apply_patch updates files and accepts absolute in-vault paths", () => {
  const { vault, env } = setup();
  const target = path.join(vault, "note.md");
  fs.writeFileSync(target, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: ${target}
@@
-beta
+gamma
*** End Patch
`;
  const result = run(["apply_patch"], { env, input: patch });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "alpha\ngamma\n");
  assert.match(result.stdout, /M note\.md/);
});

test("apply_patch move-to-self updates without deleting the file", () => {
  const { vault, env } = setup();
  const target = path.join(vault, "note.md");
  fs.writeFileSync(target, "old\n");
  const patch = `*** Begin Patch
*** Update File: note.md
*** Move to: note.md
@@
-old
+new
*** End Patch
`;
  const result = run(["apply_patch"], { env, input: patch });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
});

test("apply_patch rejects absolute paths outside vault", () => {
  const { dir, env } = setup();
  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, "old\n");
  const patch = `*** Begin Patch
*** Update File: ${outside}
@@
-old
+new
*** End Patch
`;
  const result = run(["apply_patch"], { env, input: patch });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /outside the vault/);
  assert.equal(fs.readFileSync(outside, "utf8"), "old\n");
});

test("mkdir and copy stay inside vault", () => {
  const { vault, env } = setup();
  let result = run(["mkdir", "path=dir/sub"], { env });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(path.join(vault, "dir", "sub", "a.md"), "x");
  result = run(["copy", "from=dir/sub/a.md", "to=copy.md"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "copy.md"), "utf8"), "x");
});
