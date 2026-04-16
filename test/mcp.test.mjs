import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const mcpBin = path.resolve("dist/optsidian-mcp");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-mcp-"));
}

function tempVault() {
  const vault = path.join(tempRoot(), "vault");
  fs.mkdirSync(vault, { recursive: true });
  return vault;
}

function payload(result) {
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent;
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
console.error("unexpected args: " + args.join(" "));
process.exit(9);
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function makeFailingObsidian(dir) {
  const fake = path.join(dir, "obsidian-failing.cjs");
  const script = `#!/usr/bin/env node
console.error("Obsidian is not running");
process.exit(7);
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

test("mcp tool handlers preserve raw JSON payloads without shell staging", async () => {
  const vault = tempVault();
  const { createToolHandlers } = await import(path.resolve("src/mcp/tools.ts"));
  const tools = createToolHandlers(vault);
  const raw = [
    "literal $HOME",
    "subshell $(echo hacked)",
    "backticks `uname -a`",
    "```bash",
    "echo \"$HOME\" && echo $(whoami)",
    "```",
    ""
  ].join("\n");

  let result = tools.write({ path: "raw.md", content: raw });
  assert.equal(payload(result).ok, true);
  assert.equal(fs.readFileSync(path.join(vault, "raw.md"), "utf8"), raw);

  result = tools.read({ path: "raw.md" });
  assert.match(payload(result).content, /\$HOME/);
  assert.match(payload(result).content, /\$\(echo hacked\)/);
  assert.match(payload(result).content, /`uname -a`/);

  result = tools.grep({ query: "$(whoami)" });
  assert.equal(payload(result).count, 1);
});

test("mcp edit uses flat fields and validates selector count", async () => {
  const vault = tempVault();
  const { createToolHandlers } = await import(path.resolve("src/mcp/tools.ts"));
  const tools = createToolHandlers(vault);
  tools.write({ path: "note.md", content: "alpha\nbeta\n" });

  let result = tools.edit({ path: "note.md", replace: "alpha", with: "literal $(date)" });
  assert.equal(payload(result).command, "edit");
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "literal $(date)\nbeta\n");

  result = tools.edit({ path: "note.md", replace: "beta", line: 2, with: "x" });
  assert.equal(result.isError, true);
  assert.equal(payload(result).errorType, "usage");
  assert.match(payload(result).message, /exactly one/);
});

test("mcp apply_patch copy and mkdir return structured results", async () => {
  const vault = tempVault();
  const { createToolHandlers } = await import(path.resolve("src/mcp/tools.ts"));
  const tools = createToolHandlers(vault);

  let result = tools.apply_patch({
    patch: "*** Begin Patch\n*** Add File: patch.md\n+$HOME\n+`pwd`\n*** End Patch\n"
  });
  assert.equal(payload(result).command, "apply_patch");
  assert.equal(fs.readFileSync(path.join(vault, "patch.md"), "utf8"), "$HOME\n`pwd`\n");

  result = tools.mkdir({ path: "dir/sub" });
  assert.equal(payload(result).changes[0].path, "dir/sub");

  result = tools.copy({ from: "patch.md", to: "dir/sub/copy.md" });
  assert.equal(payload(result).changes[0].from, "patch.md");
  assert.equal(fs.readFileSync(path.join(vault, "dir", "sub", "copy.md"), "utf8"), "$HOME\n`pwd`\n");
});

test("mcp frontmatter tools preserve structured JSON values", async () => {
  const vault = tempVault();
  const { createToolHandlers } = await import(path.resolve("src/mcp/tools.ts"));
  const tools = createToolHandlers(vault);
  tools.write({ path: "note.md", content: "# Note\nliteral $HOME\n" });

  let result = tools.frontmatter_set({
    path: "note.md",
    key: "aliases",
    value: ["Project $HOME", { label: "Alpha", active: true }]
  });
  assert.equal(payload(result).command, "frontmatter");

  result = tools.frontmatter_add({ path: "note.md", key: "tags", value: "project" });
  assert.equal(payload(result).changes[0].path, "note.md");

  result = tools.frontmatter_read({ path: "note.md" });
  assert.deepEqual(payload(result).frontmatter.aliases, ["Project $HOME", { label: "Alpha", active: true }]);
  assert.deepEqual(payload(result).frontmatter.tags, ["project"]);

  result = tools.frontmatter_remove({ path: "note.md", key: "tags", value: "project", dryRun: true });
  assert.equal(payload(result).dryRun, true);
  assert.deepEqual(payload(tools.frontmatter_read({ path: "note.md" })).frontmatter.tags, ["project"]);

  result = tools.frontmatter_delete({ path: "note.md", key: "aliases" });
  assert.equal(payload(result).command, "frontmatter");
  assert.equal(payload(tools.frontmatter_read({ path: "note.md" })).frontmatter.aliases, undefined);
});

test("mcp config and native vault resolution use fake obsidian", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const log = path.join(dir, "obsidian.log");
  const fake = makeFakeObsidian(dir, vault);
  const env = { ...process.env, OPTSIDIAN_OBSIDIAN_BIN: fake, FAKE_VAULT: vault, FAKE_OBSIDIAN_LOG: log };
  const { parseMcpArgs } = await import(path.resolve("src/mcp/config.ts"));
  const { resolveObsidianVaultRoot, resolveObsidianVaultRootWithFallback } = await import(path.resolve("src/native/obsidian.ts"));

  assert.deepEqual(parseMcpArgs(["--vault", "Work"], env), { help: false, version: false, vault: "Work", vaultPath: undefined });
  assert.deepEqual(parseMcpArgs([], { ...env, OPTSIDIAN_VAULT: "EnvVault" }), { help: false, version: false, vault: "EnvVault", vaultPath: undefined });
  assert.deepEqual(parseMcpArgs(["--vault-path", vault], env), { help: false, version: false, vault: undefined, vaultPath: vault });
  assert.equal(resolveObsidianVaultRoot({ vault: "Work", env }), vault);
  assert.equal(resolveObsidianVaultRootWithFallback({ vault: "Work", fallbackPath: path.join(dir, "missing"), env }), vault);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["vault", "info=path", "vault=Work"]);
});

test("mcp vault fallback path is used when native resolve fails", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const fake = makeFailingObsidian(dir);
  const env = { ...process.env, OPTSIDIAN_OBSIDIAN_BIN: fake };
  const { resolveObsidianVaultRootWithFallback } = await import(path.resolve("src/native/obsidian.ts"));

  assert.equal(resolveObsidianVaultRootWithFallback({ fallbackPath: vault, env }), fs.realpathSync(vault));
  assert.throws(() => resolveObsidianVaultRootWithFallback({ fallbackPath: path.join(dir, "missing"), env }), /Fallback vault path does not exist/);
});

test("optsidian-mcp help is available outside protocol mode", () => {
  const result = spawnSync(process.execPath, [mcpBin, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /optsidian-mcp/);
  assert.match(result.stdout, /frontmatter_read/);
  assert.match(result.stdout, /frontmatter_remove/);
});

test("optsidian-mcp version flag reports package version", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const result = spawnSync(process.execPath, [mcpBin, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("optsidian-mcp serves tools over stdio protocol", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  const cache = path.join(dir, "cache");
  fs.mkdirSync(vault, { recursive: true });
  const fake = makeFakeObsidian(dir, vault);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBin],
    cwd: path.resolve("."),
    env: {
      ...process.env,
      OPTSIDIAN_OBSIDIAN_BIN: fake,
      FAKE_VAULT: vault,
      XDG_CACHE_HOME: cache
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "optsidian-mcp-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "write"));
    assert.ok(listed.tools.some((tool) => tool.name === "read"));
    assert.ok(listed.tools.some((tool) => tool.name === "search"));
    assert.ok(listed.tools.some((tool) => tool.name === "frontmatter_set"));
    assert.ok(listed.tools.some((tool) => tool.name === "frontmatter_read"));
    assert.ok(listed.tools.some((tool) => tool.name === "grep"));

    const write = await client.callTool({
      name: "write",
      arguments: { path: "protocol.md", content: "---\ntitle: Protocol\nTags: [mcp]\n---\n# Protocol\n\nhello $HOME\n" }
    });
    assert.equal(write.structuredContent?.command, "write");

    const ranked = await client.callTool({
      name: "search",
      arguments: { query: "protocol mcp" }
    });
    assert.equal(ranked.structuredContent?.command, "search");
    assert.equal(ranked.structuredContent?.matches?.[0]?.path, "protocol.md");
    assert.deepEqual(ranked.structuredContent?.matches?.[0]?.fieldMatches?.tags, ["mcp"]);
    assert.doesNotMatch(
      String(ranked.structuredContent?.matches?.[0]?.snippets?.map((snippet) => snippet.text).join("\n")),
      /title:|tags:/i
    );

    const frontmatter = await client.callTool({
      name: "frontmatter_set",
      arguments: { path: "protocol.md", key: "aliases", value: ["Protocol $HOME"] }
    });
    assert.equal(frontmatter.structuredContent?.command, "frontmatter");

    const frontmatterRead = await client.callTool({
      name: "frontmatter_read",
      arguments: { path: "protocol.md" }
    });
    assert.deepEqual(frontmatterRead.structuredContent?.frontmatter?.aliases, ["Protocol $HOME"]);

    const read = await client.callTool({
      name: "read",
      arguments: { path: "protocol.md" }
    });
    assert.match(String(read.structuredContent?.content), /\$HOME/);
  } finally {
    await client.close();
  }
});

test("optsidian-mcp stdio starts with fallback path when native is unavailable", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const fake = makeFailingObsidian(dir);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBin],
    cwd: path.resolve("."),
    env: {
      ...process.env,
      OPTSIDIAN_OBSIDIAN_BIN: fake,
      OPTSIDIAN_VAULT_PATH: vault
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "optsidian-mcp-fallback-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    const write = await client.callTool({
      name: "write",
      arguments: { path: "fallback.md", content: "works\n" }
    });
    assert.equal(write.structuredContent?.command, "write");
    assert.equal(fs.readFileSync(path.join(vault, "fallback.md"), "utf8"), "works\n");
  } finally {
    await client.close();
  }
});
