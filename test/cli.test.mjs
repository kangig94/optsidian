import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

const cli = path.resolve("dist/optsidian");
const SNAPSHOT_ID_PATTERN = "[a-f0-9]{64}";
const searchDaemonCleanupEnvs = new Map();

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-"));
}

function trackSearchDaemonEnv(env) {
  const runtimeDir = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR;
  if (runtimeDir) searchDaemonCleanupEnvs.set(runtimeDir, env);
  return env;
}

function makeFakeObsidian(dir, vaultRoot) {
const fake = path.join(dir, "obsidian-fake.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_OBSIDIAN_LOG) fs.appendFileSync(process.env.FAKE_OBSIDIAN_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_REQUIRE_OBSIDIAN_GUI === "1") {
  const required = {
    DISPLAY: process.env.FAKE_EXPECT_DISPLAY,
    DBUS_SESSION_BUS_ADDRESS: process.env.FAKE_EXPECT_DBUS,
    XDG_RUNTIME_DIR: process.env.FAKE_EXPECT_XDG
  };
  for (const [key, value] of Object.entries(required)) {
    if ((value && process.env[key] !== value) || (!value && !process.env[key])) {
      console.error("The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.");
      process.exit(7);
    }
  }
}
if (args[0] === "help") {
  if (process.env.FAKE_OBSIDIAN_HELP_FAIL) {
    console.error(process.env.FAKE_OBSIDIAN_HELP_FAIL);
    process.exit(9);
  }
  console.log(\`Obsidian CLI

Commands:
  files                 List files
  links                 List outgoing links
  read                  Read file contents
  search                Search vault for text
  version               Show version

Developer:
  dev:console           Show captured console messages\`);
  process.exit(0);
}
if (args[0] === "vault" && args[1] === "info=path") {
  console.log(process.env.FAKE_VAULT);
  process.exit(0);
}
if (args[0] === "plugin:reload" && process.env.FAKE_PLUGIN_RELOAD_NOT_FOUND === "1") {
  const idArg = args.find((arg) => arg.startsWith("id=")) || "id=unknown";
  console.log(\`Error: Plugin "\${idArg.slice(3)}" not found. Use "plugins" to list available plugins.\`);
  process.exit(0);
}
if (args[0] === "plugin:reload" && process.env.FAKE_PLUGIN_RELOAD_NOT_ENABLED === "1") {
  const idArg = args.find((arg) => arg.startsWith("id=")) || "id=unknown";
  console.log(\`Error: Plugin "\${idArg.slice(3)}" is not enabled.\`);
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

function makeSwitchingObsidian(dir, stateFile) {
  const fake = path.join(dir, "obsidian-switching.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "help") {
  console.log(\`Obsidian CLI

Commands:
  files                 List files
  links                 List outgoing links
  version               Show version\`);
  process.exit(0);
}
if (args[0] === "vault" && args[1] === "info=path") {
  if (!fs.existsSync(${JSON.stringify(stateFile)})) {
    console.error("Obsidian is not running");
    process.exit(7);
  }
  console.log(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8").trim());
  process.exit(0);
}
console.error("unexpected args: " + args.join(" "));
process.exit(9);
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function makeFlakyVaultObsidian(dir, vaultRoot) {
  const fake = path.join(dir, "obsidian-flaky-vault.cjs");
  const countFile = path.join(dir, "vault-count.txt");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_OBSIDIAN_LOG) fs.appendFileSync(process.env.FAKE_OBSIDIAN_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "help") {
  console.log(\`Obsidian CLI

Commands:
  vault                 Show vault info
  files                 List files\`);
  process.exit(0);
}
if (args[0] === "vault" && args[1] === "info=path") {
  const previous = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) : 0;
  fs.writeFileSync(${JSON.stringify(countFile)}, String(previous + 1));
  if (previous === 0) {
    console.log('Error: Command "vault" not found. It may require a plugin to be enabled.');
    process.exit(0);
  }
  console.log(${JSON.stringify(vaultRoot)});
  process.exit(0);
}
console.log("native " + args.join(" "));
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function makeFakeObsidianApp(dir, stateFile, logFile) {
  const fake = path.join(dir, "obsidian-app-fake.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_APP_PID_FILE) fs.writeFileSync(process.env.FAKE_APP_PID_FILE, String(process.pid));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const target = args[0] || "";
let vaultPath = process.env.FAKE_DEFAULT_VAULT || "";
try {
  const url = new URL(target);
  vaultPath = url.searchParams.get("path") || vaultPath;
} catch {}
if (vaultPath) fs.writeFileSync(${JSON.stringify(stateFile)}, vaultPath + "\\n");
if (process.env.FAKE_APP_HANG === "1") setInterval(() => {}, 1000);
`;
  fs.writeFileSync(fake, script);
  fs.chmodSync(fake, 0o755);
  return fake;
}

function makeFakePlugin(dir, id = "sample-plugin", manifestOverrides = {}) {
  const root = path.join(dir, id);
  fs.mkdirSync(root, { recursive: true });
  const manifest = {
    id,
    name: "Fake Plugin",
    version: "0.0.1",
    ...manifestOverrides
  };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(root, "main.js"), "module.exports = {};\n");
  return root;
}

function makeGitPluginRepo(dir, id = "sample-plugin") {
  const root = path.join(dir, "plugin-repo");
  const pluginRoot = path.join(root, "dist", "obsidian-plugin");
  makeFakePlugin(path.dirname(pluginRoot), path.basename(pluginRoot), { id });
  runGit(["init", "-b", "main"], root);
  runGit(["config", "user.name", "Optsidian Test"], root);
  runGit(["config", "user.email", "optsidian@example.test"], root);
  runGit(["add", "."], root);
  runGit(["commit", "-m", "initial"], root);
  return root;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function gitHead(cwd) {
  return runGit(["rev-parse", "HEAD"], cwd);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serveReleaseAsset(res, assets, name) {
  if (assets[name] === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200);
  res.end(assets[name]);
}

async function startGithubReleaseServer(options = {}) {
  const assets = options.assets ?? {};
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname.includes("/releases/")) {
      requests.push({ path: url.pathname, accept: req.headers.accept, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: options.tag ?? "1.2.3",
          assets: Object.keys(assets).map((name) => ({
            name,
            // API asset URL (preferred; works for private repos) + the public download URL.
            url: `${options.assetUrlBase ?? base}/assets/${encodeURIComponent(name)}`,
            browser_download_url: `${base}/download/${encodeURIComponent(name)}`
          }))
        })
      );
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      const name = decodeURIComponent(url.pathname.slice("/assets/".length));
      requests.push({ path: url.pathname, accept: req.headers.accept, authorization: req.headers.authorization });
      if (options.assetRedirectBase) {
        res.writeHead(302, { location: `${options.assetRedirectBase}/cdn/${encodeURIComponent(name)}` });
        res.end();
        return;
      }
      serveReleaseAsset(res, assets, name);
      return;
    }
    if (url.pathname.startsWith("/download/") || url.pathname.startsWith("/cdn/")) {
      const prefix = url.pathname.startsWith("/cdn/") ? "/cdn/" : "/download/";
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      requests.push({ path: url.pathname, accept: req.headers.accept, authorization: req.headers.authorization });
      serveReleaseAsset(res, assets, name);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// Force the direct (non-curl) HTTP path so the local release server is reachable even if
// the ambient environment advertises a proxy.
const NO_PROXY_ENV = {
  HTTPS_PROXY: "",
  https_proxy: "",
  HTTP_PROXY: "",
  http_proxy: "",
  ALL_PROXY: "",
  all_proxy: ""
};

function cleanupPidFile(pidFile) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd,
    env: options.mergeEnv === false
      ? { OPTSIDIAN_NO_UPDATE_CHECK: "1", ...options.env }
      : { ...process.env, OPTSIDIAN_NO_UPDATE_CHECK: "1", ...options.env }
  });
  return result;
}

// Async variant for tests whose CLI invocation talks to an in-process HTTP mock: spawnSync
// would block this process's event loop, so the mock server could never answer the child.
function runAsync(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.mergeEnv === false
        ? { OPTSIDIAN_NO_UPDATE_CHECK: "1", ...options.env }
        : { ...process.env, OPTSIDIAN_NO_UPDATE_CHECK: "1", ...options.env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 15000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

let pluginInstallModules;

async function runPluginInstallDirect(args, options = {}) {
  pluginInstallModules ??= Promise.all([
    import(path.resolve("src/cli/args.ts")),
    import(path.resolve("src/cli/commands/plugin.ts"))
  ]);
  const [{ parseArgs }, { runPluginInstall }] = await pluginInstallModules;
  const env = { OPTSIDIAN_NO_UPDATE_CHECK: "1", ...options.env };
  const previousEnv = new Map();
  for (const key of Object.keys(env)) {
    previousEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  let stdout = "";
  try {
    await runPluginInstall(parseArgs(["plugin:install", ...args]), {
      write(chunk) {
        stdout += chunk;
        return true;
      }
    });
    return { status: 0, stdout, stderr: "" };
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function strippedGuiEnv(overrides = {}) {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    ...overrides
  };
}

function startFakeObsidianHost(dir, guiEnv) {
  const host = path.join(dir, "obsidian-host.cjs");
  fs.writeFileSync(host, "setInterval(() => {}, 1000);\\n");
  return spawn(process.execPath, [host], {
    stdio: "ignore",
    env: strippedGuiEnv(guiEnv)
  });
}

function waitForProcessEnv(pid, expectedEnv) {
  if (!pid || process.platform !== "linux") return false;
  const deadline = Date.now() + 200;
  while (true) {
    try {
      const entries = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      return Object.entries(expectedEnv).every(([key, value]) => entries.includes(`${key}=${value}`));
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
      if (Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function setup() {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const log = path.join(dir, "obsidian.log");
  const fake = makeFakeObsidian(dir, vault);
  const env = trackSearchDaemonEnv({
    OPTSIDIAN_OBSIDIAN_BIN: fake,
    FAKE_VAULT: vault,
    FAKE_OBSIDIAN_LOG: log,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_RUNTIME_DIR: path.join(dir, "runtime"),
    OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR: path.join(dir, "runtime", "search-daemon")
  });
  return { dir, vault, env, log };
}

async function shutdownSearchDaemonEnv(env) {
  const runtimeDir = env.OPTSIDIAN_SEARCH_DAEMON_RUNTIME_DIR;
  if (!runtimeDir) return;
  try {
    const mergedEnv = { ...process.env, ...env };
    const { createOwnerRegistry } = await import(path.resolve("src/daemon/owner-registry.ts"));
    const registry = createOwnerRegistry({ runtimeDir, env: mergedEnv });
    const owner = registry.readOwner();
    if (!owner) return;

    try {
      const { createSearchDaemonClient } = await import(path.resolve("src/daemon/client.ts"));
      const client = createSearchDaemonClient({
        runtimeDir,
        binaryPath: cli,
        env: mergedEnv,
        readyTimeoutMs: 5000
      });
      await client.shutdown({ deadlineMs: 5000 });
    } catch {
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, "SIGTERM");
        } catch {}
      }
      try {
        registry.removeOwner(owner);
      } catch {}
    }
  } finally {
    searchDaemonCleanupEnvs.delete(runtimeDir);
  }
}

after(async () => {
  for (const env of Array.from(searchDaemonCleanupEnvs.values()).reverse()) {
    await shutdownSearchDaemonEnv(env);
  }
});

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

test("top-level and implemented command help stay local", async () => {
  const { env } = setup();
  const result = run(["--help"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Detailed help:/);
  assert.match(result.stdout, /optsidian <command> --help/);
  assert.match(result.stdout, /update\s+Update or repair the managed Optsidian install/);
  assert.match(result.stdout, /plugin:install\s+Install marketplace or custom Obsidian plugins/);
  assert.match(result.stdout, /Native passthrough:/);
  assert.match(result.stdout, /files, links, version, dev:console/);
  assert.match(result.stdout, /MCP tools: command_map, command_run, write, edit, apply_patch/);
  assert.doesNotMatch(result.stdout, /Addons:/);

  const bareTopLevelHelp = run(["help"], { env });
  assert.equal(bareTopLevelHelp.status, 2);
  assert.match(bareTopLevelHelp.stderr, /Use --help or help=true/);

  const bareReadHelp = run(["read", "help"], { env });
  assert.equal(bareReadHelp.status, 2);
  assert.match(bareReadHelp.stderr, /Missing required argument: path=<value>/);

  const { commandHelpText } = await import(path.resolve("src/cli/help.ts"));
  const pluginInstallHelp = commandHelpText("plugin:install");
  assert.match(pluginInstallHelp, /Command: plugin:install/);
  assert.match(pluginInstallHelp, /url=<git-url>/);
  assert.match(pluginInstallHelp, /id=<plugin-id> is native passthrough/);
});

test("top-level help includes native passthrough error verbatim when command listing fails", () => {
  const { env } = setup();
  const result = run(["--help"], { env: { ...env, FAKE_OBSIDIAN_HELP_FAIL: "Start the Obsidian GUI to use native help." } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Native passthrough:/);
  assert.match(result.stdout, /Start the Obsidian GUI to use native help\./);
});

test("plugin:install id delegates unchanged to native Obsidian", () => {
  const { env, log } = setup();
  const result = run(["plugin:install", "id=community-plugin", "enable"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native plugin:install id=community-plugin enable");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["plugin:install", "id=community-plugin", "enable"]);
});

test("plugin:install id preserves native failure when Obsidian is unavailable", () => {
  const dir = tempRoot();
  const fake = makeFailingObsidian(dir);
  const result = run(["plugin:install", "id=community-plugin"], { env: { OPTSIDIAN_OBSIDIAN_BIN: fake } });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /Obsidian is not running/);
});

test("plugin:install id rejects fixed vault paths before native passthrough", () => {
  const { env, vault } = setup();
  const result = run(["plugin:install", "id=community-plugin", `vault-path=${vault}`], { env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /vault-path=<path> only applies to custom plugin installs/);
});

test("plugin:install path installs and enables a local custom plugin", () => {
  const { dir, vault, env } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "enable", "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  const target = path.join(vault, ".obsidian", "plugins", "sample-plugin");
  assert.equal(payload.command, "plugin:install");
  assert.equal(payload.plugin.id, "sample-plugin");
  assert.equal(payload.plugin.name, "Fake Plugin");
  assert.equal(payload.plugin.version, "0.0.1");
  assert.equal(payload.plugin.path, target);
  assert.deepEqual(payload.source, { type: "local", path: fs.realpathSync(pluginRoot) });
  assert.equal(payload.enable.status, "enabled");
  assert.equal(payload.enable.changed, true);
  assert.equal(payload.refresh.status, "plugin-reloaded");
  assert.equal(fs.existsSync(path.join(target, "manifest.json")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "community-plugins.json"), "utf8")), ["sample-plugin"]);
});

test("plugin:install deploys only runtime files, never the source tree", async () => {
  const { dir, vault, env } = setup();
  const pluginRoot = makeFakePlugin(dir);
  fs.writeFileSync(path.join(pluginRoot, "styles.css"), "/* x */\n");
  fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n");
  fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "src", "main.ts"), "export {};\n");
  fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });

  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "enable", "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);

  const target = path.join(vault, ".obsidian", "plugins", "sample-plugin");
  assert.deepEqual(fs.readdirSync(target).sort(), ["main.js", "manifest.json", "styles.css"]);
  assert.equal(fs.existsSync(path.join(target, "package.json")), false);
  assert.equal(fs.existsSync(path.join(target, "src")), false);
  assert.equal(fs.existsSync(path.join(target, "node_modules")), false);
});

test("plugin:install preserves the vault's existing data.json (settings) across reinstall", async () => {
  const { dir, vault, env } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const target = path.join(vault, ".obsidian", "plugins", "sample-plugin");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "data.json"), JSON.stringify({ locale: "ko" }));

  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "data.json"), "utf8")), { locale: "ko" });
  assert.equal(fs.existsSync(path.join(target, "main.js")), true);
});

test("plugin:install path installs with a fixed vault path when native Obsidian is unavailable", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const fake = makeFailingObsidian(dir);
  const pluginRoot = makeFakePlugin(dir);
  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "enable", "format=json"], {
    env: { OPTSIDIAN_OBSIDIAN_BIN: fake }
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  const target = path.join(vault, ".obsidian", "plugins", "sample-plugin");
  assert.equal(payload.refresh.attempted, false);
  assert.equal(payload.refresh.status, "skipped");
  assert.match(payload.refresh.reason, /Native active vault is unavailable: Obsidian is not running/);
  assert.equal(fs.existsSync(path.join(target, "main.js")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "community-plugins.json"), "utf8")), ["sample-plugin"]);
});

test("plugin:install path uses OPTSIDIAN_VAULT_PATH when native Obsidian is unavailable", async () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const fake = makeFailingObsidian(dir);
  const pluginRoot = makeFakePlugin(dir);
  const result = await runPluginInstallDirect([`path=${pluginRoot}`, "format=json"], {
    env: { OPTSIDIAN_OBSIDIAN_BIN: fake, OPTSIDIAN_VAULT_PATH: vault }
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.vaultPath, fs.realpathSync(vault));
  assert.equal(payload.refresh.attempted, false);
  assert.equal(payload.refresh.status, "skipped");
  assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "sample-plugin", "main.js")), true);
});

test("plugin:install path without a fixed vault path fails before install when native Obsidian is unavailable", () => {
  const dir = tempRoot();
  const fake = makeFailingObsidian(dir);
  const pluginRoot = makeFakePlugin(dir);
  const result = run(["plugin:install", `path=${pluginRoot}`, "enable"], {
    env: { OPTSIDIAN_OBSIDIAN_BIN: fake }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Obsidian is not running/);
});

test("plugin:install validates enable config before copying plugin files", () => {
  const { dir, vault } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const obsidianDir = path.join(vault, ".obsidian");
  fs.mkdirSync(obsidianDir, { recursive: true });
  fs.writeFileSync(path.join(obsidianDir, "community-plugins.json"), "not json");

  const result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "enable"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid community-plugins\.json/);
  assert.equal(fs.existsSync(path.join(obsidianDir, "plugins", "sample-plugin")), false);
});

test("plugin:install url installs from a git subdirectory and reloads the active vault", async () => {
  const { dir, vault, env, log } = setup();
  const repo = makeGitPluginRepo(dir);
  const url = pathToFileURL(repo).href;
  const expectedCommit = gitHead(repo);
  const result = await runPluginInstallDirect([
    `url=${url}`,
    "ref=main",
    "dir=dist/obsidian-plugin",
    `vault-path=${vault}`,
    "enable",
    "format=json"
  ], { env });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source.type, "git");
  assert.equal(payload.source.url, url);
  assert.equal(payload.source.ref, "main");
  assert.equal(payload.source.dir, "dist/obsidian-plugin");
  assert.equal(payload.source.resolvedCommit, expectedCommit);
  assert.equal(payload.refresh.status, "plugin-reloaded");
  assert.equal(payload.refresh.command, "plugin:reload");
  assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "sample-plugin", "main.js")), true);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-2), ["vault", "info=path"]);
  assert.deepEqual(calls.at(-1), ["plugin:reload", "id=sample-plugin"]);
});

test("plugin:install url installs from a published GitHub release instead of cloning", async () => {
  const { vault, env } = setup();
  const server = await startGithubReleaseServer({
    tag: "1.4.0",
    assets: {
      "manifest.json": JSON.stringify({ id: "released-plugin", name: "Released", version: "1.4.0" }),
      "main.js": "module.exports = { released: true };\n",
      "styles.css": ".released {}\n"
    }
  });
  try {
    const result = await runPluginInstallDirect(
      ["url=https://github.com/acme/released", `vault-path=${vault}`, "enable", "format=json"],
      { env: { ...env, ...NO_PROXY_ENV, OPTSIDIAN_GITHUB_API_BASE: server.apiBase, GITHUB_TOKEN: "test-token" } }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source.type, "release");
    assert.equal(payload.source.url, "https://github.com/acme/released");
    assert.equal(payload.source.tag, "1.4.0");
    assert.equal(payload.plugin.id, "released-plugin");
    const pluginDir = path.join(vault, ".obsidian", "plugins", "released-plugin");
    assert.equal(fs.existsSync(path.join(pluginDir, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "main.js")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "styles.css")), true);
    assert.ok(
      server.requests.every((entry) => !entry.authorization),
      "custom plugin release lookup must not send GITHUB_TOKEN unless auth=true is explicit"
    );
  } finally {
    await server.close();
  }
});

test("plugin:install url installs from a GitHub Enterprise-style release API", async () => {
  const { vault, env } = setup();
  const server = await startGithubReleaseServer({
    tag: "3.0.0",
    assets: {
      "manifest.json": JSON.stringify({ id: "enterprise-plugin", name: "Enterprise", version: "3.0.0" }),
      "main.js": "module.exports = { enterprise: true };\n"
    }
  });
  try {
    const sourceUrl = `${server.apiBase}/acme/enterprise-plugin`;
    const result = await runPluginInstallDirect(
      [`url=${sourceUrl}`, `vault-path=${vault}`, "enable", "format=json"],
      { env: { ...env, ...NO_PROXY_ENV, GITHUB_TOKEN: "enterprise-token" } }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source.type, "release");
    assert.equal(payload.source.url, sourceUrl);
    assert.equal(payload.source.tag, "3.0.0");
    assert.equal(payload.plugin.id, "enterprise-plugin");
    assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "enterprise-plugin", "main.js")), true);
    assert.ok(
      server.requests.every((entry) => !entry.authorization),
      "GitHub Enterprise-style release lookup must not send GITHUB_TOKEN unless auth=true is explicit"
    );
  } finally {
    await server.close();
  }
});

test("plugin:install auth=true authenticates the asset API URL but drops auth on a cross-host CDN redirect", async () => {
  const { vault, env } = setup();
  const assets = {
    "manifest.json": JSON.stringify({ id: "private-plugin", name: "Private", version: "2.0.0" }),
    "main.js": "module.exports = { ok: true };\n"
  };
  const cdn = await startGithubReleaseServer({ assets });
  const api = await startGithubReleaseServer({ tag: "2.0.0", assets, assetRedirectBase: cdn.apiBase });
  try {
    const result = await runPluginInstallDirect(
      ["url=https://github.com/acme/private", "auth=true", `vault-path=${vault}`, "enable", "format=json"],
      { env: { ...env, ...NO_PROXY_ENV, OPTSIDIAN_GITHUB_API_BASE: api.apiBase, GITHUB_TOKEN: "secret-token" } }
    );
    assert.equal(result.status, 0, result.stderr);
    // The API asset URL (same host as the API base) carries the token...
    assert.ok(
      api.requests.some((entry) => entry.authorization === "Bearer secret-token"),
      "API asset request should carry the bearer token"
    );
    // ...but the redirected cross-host CDN request must NOT (a signed URL rejects a second auth mechanism).
    assert.ok(cdn.requests.length > 0, "CDN should receive the redirected download");
    assert.ok(
      cdn.requests.every((entry) => !entry.authorization),
      "cross-host CDN request must not carry the bearer token"
    );
    assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "private-plugin", "main.js")), true);
  } finally {
    await api.close();
    await cdn.close();
  }
});

test("plugin:install auth=true does not authenticate cross-host asset API URLs", async () => {
  const { vault, env } = setup();
  const assets = {
    "manifest.json": JSON.stringify({ id: "cross-host-plugin", name: "Cross Host", version: "2.1.0" }),
    "main.js": "module.exports = { ok: true };\n"
  };
  const assetHost = await startGithubReleaseServer({ assets });
  const api = await startGithubReleaseServer({ tag: "2.1.0", assets, assetUrlBase: assetHost.apiBase });
  try {
    const result = await runPluginInstallDirect(
      ["url=https://github.com/acme/cross-host", "auth=true", `vault-path=${vault}`, "enable", "format=json"],
      { env: { ...env, ...NO_PROXY_ENV, OPTSIDIAN_GITHUB_API_BASE: api.apiBase, GITHUB_TOKEN: "secret-token" } }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      api.requests.some((entry) => entry.authorization === "Bearer secret-token"),
      "release metadata request should carry the bearer token"
    );
    assert.ok(assetHost.requests.length > 0, "external asset host should receive downloads");
    assert.ok(
      assetHost.requests.every((entry) => !entry.authorization),
      "cross-host asset API URL must not carry the bearer token"
    );
    assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "cross-host-plugin", "main.js")), true);
  } finally {
    await api.close();
    await assetHost.close();
  }
});

test("plugin:install refresh is skipped when the active native vault differs", async () => {
  const { dir, vault, env, log } = setup();
  const otherVault = path.join(dir, "other-vault");
  fs.mkdirSync(otherVault, { recursive: true });
  const pluginRoot = makeFakePlugin(dir);
  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "format=json"], {
    env: { ...env, FAKE_VAULT: otherVault }
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.refresh.attempted, false);
  assert.equal(payload.refresh.status, "skipped");
  assert.match(payload.refresh.reason, /Native active vault is/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["vault", "info=path"]);
});

test("plugin:install reloads the app when native Obsidian has not discovered the new plugin yet", async () => {
  const { dir, vault, env } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "format=json"], {
    env: { ...env, FAKE_PLUGIN_RELOAD_NOT_FOUND: "1" }
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.refresh.attempted, true);
  assert.equal(payload.refresh.status, "app-reloaded");
  assert.equal(payload.refresh.command, "reload");
  assert.equal(fs.existsSync(path.join(vault, ".obsidian", "plugins", "sample-plugin", "main.js")), true);
});

test("plugin:install reloads the app when native Obsidian has not enabled the new plugin yet", async () => {
  const { dir, vault, env } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const result = await runPluginInstallDirect([`path=${pluginRoot}`, `vault-path=${vault}`, "format=json"], {
    env: { ...env, FAKE_PLUGIN_RELOAD_NOT_ENABLED: "1" }
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.refresh.attempted, true);
  assert.equal(payload.refresh.status, "app-reloaded");
  assert.equal(payload.refresh.command, "reload");
});

test("plugin:install rejects reload because refresh is best-effort", () => {
  const { dir, vault } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "reload"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unexpected plugin:install argument: reload/);
});

test("plugin:install rejects overlapping source and target directories", () => {
  const { vault } = setup();
  const targetRoot = makeFakePlugin(path.join(vault, ".obsidian", "plugins"));
  const result = run(["plugin:install", `path=${targetRoot}`, `vault-path=${vault}`]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source and target directories overlap/);
});

test("plugin:install rejects git-only options for local path installs", () => {
  const { dir, vault } = setup();
  const pluginRoot = makeFakePlugin(dir);
  let result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "ref=main"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ref=<git-ref> only applies/);

  result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "dir=dist"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /dir=<subdir> only applies/);

  result = run(["plugin:install", `path=${pluginRoot}`, `vault-path=${vault}`, "auth=true"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /auth=true only applies/);
});

test("plugin:install rejects combining native ids with custom sources", () => {
  const { dir, vault } = setup();
  const pluginRoot = makeFakePlugin(dir);
  const result = run(["plugin:install", "id=community-plugin", `path=${pluginRoot}`, `vault-path=${vault}`]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use only one plugin source selector/);
});

test("plugin:install normalizes scheme-less GitHub URLs", async () => {
  const { normalizeGitSource } = await import(path.resolve("src/cli/commands/plugin.ts"));

  assert.equal(normalizeGitSource("example-owner/example-plugin"), "https://github.com/example-owner/example-plugin");
  assert.equal(normalizeGitSource("github.com/user/sample-plugin"), "https://github.com/user/sample-plugin");
  assert.equal(normalizeGitSource("github.com/user/sample-plugin.git"), "https://github.com/user/sample-plugin.git");
  assert.equal(normalizeGitSource("github.example.test/user/sample-plugin"), "https://github.example.test/user/sample-plugin");
  assert.equal(normalizeGitSource("github:user/sample-plugin"), "https://github.com/user/sample-plugin");
});

test("top-level help recovers GUI env from a running Obsidian process when the child env is stripped", async (t) => {
  if (process.env.CI) {
    t.skip("real /proc sibling environment recovery is covered by unit tests and is not stable on CI runners");
    return;
  }
  const { dir, env } = setup();
  const guiEnv = {
    DISPLAY: ":optsidian-test",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/optsidian-test-bus",
    XDG_RUNTIME_DIR: "/tmp/optsidian-test-runtime"
  };
  const host = startFakeObsidianHost(dir, guiEnv);

  try {
    if (!waitForProcessEnv(host.pid, guiEnv)) {
      t.skip("process environment is not observable through /proc on this runner");
      return;
    }
    const result = run(["--help"], {
      mergeEnv: false,
      env: strippedGuiEnv({
        ...env,
        FAKE_REQUIRE_OBSIDIAN_GUI: "1"
      })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /files, links, version, dev:console/);
  } finally {
    host.kill("SIGTERM");
  }
});

test("policy table does not implement native-sufficient commands", async () => {
  const policy = await import(path.resolve("src/cli/policy.ts"));
  for (const command of policy.implementedCommands()) {
    assert.equal(policy.NATIVE_SUFFICIENT_COMMANDS.has(command), false, `${command} must not be both implemented and native-sufficient`);
  }
});

test("native command help delegates as `help <command>`, never running the command", () => {
  const { env, log } = setup();
  const result = run(["files", "--help"], { env });
  assert.equal(result.status, 0, result.stderr);
  // Native obsidian ignores `<command> --help` and runs the command; the safe per-command
  // help form is `obsidian help <command>`. optsidian must delegate that form, not the bare command.
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["help", "files"]);
  assert.ok(!calls.some((call) => call[0] === "files"), "the bare native command must never be delegated for --help");
  assert.match(result.stdout, /Obsidian CLI/);
});

test("destructive native command help never executes the command", () => {
  const { env, log } = setup();
  let result = run(["delete", "--help"], { env });
  assert.equal(result.status, 0, result.stderr);
  let calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["help", "delete"]);
  assert.ok(!calls.some((call) => call[0] === "delete"), "delete must never be executed for delete --help");

  const passthrough = setup();
  result = run(["delete", "help"], { env: passthrough.env });
  assert.equal(result.status, 0, result.stderr);
  calls = fs.readFileSync(passthrough.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["delete", "help"]);
  assert.ok(!calls.some((call) => call[0] === "help"), "bare help must not be rewritten to native help");
});

test("delete remains delegated to native Obsidian", () => {
  const { env, log } = setup();
  const result = run(["delete", "path=note.md"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native delete path=note.md");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["delete", "path=note.md"]);
});

test("native property commands remain delegated", () => {
  const { env, log } = setup();
  const result = run(["property:set", "path=note.md", "name=status", "value=active"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native property:set path=note.md name=status value=active");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-1), ["property:set", "path=note.md", "name=status", "value=active"]);
});

test("raw preserves native exit code", () => {
  const { env } = setup();
  const result = run(["raw", "fail"], { env });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /native failure/);
});

test("implemented commands use vault-path without native vault resolution", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "note.md"), "fixed vault\n");
  const fake = makeFailingObsidian(dir);

  const result = run(["read", `vault-path=${vault}`, "path=note.md"], {
    env: { OPTSIDIAN_OBSIDIAN_BIN: fake }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixed vault/);
});

test("implemented commands use OPTSIDIAN_VAULT_PATH without native vault resolution", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "note.md"), "env vault\n");
  const fake = makeFailingObsidian(dir);

  const result = run(["read", "path=note.md"], {
    env: { OPTSIDIAN_OBSIDIAN_BIN: fake, OPTSIDIAN_VAULT_PATH: vault }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /env vault/);
});

test("vault-path cannot be combined with native vault selection or native passthrough", () => {
  const { vault, env, log } = setup();

  let result = run(["read", `vault-path=${vault}`, "vault=Work", "path=note.md"], { env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use either vault-path=<path> or vault=<name>/);

  result = run(["read", "--vault-path", "path=note.md"], { env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use vault-path=<path> with optsidian CLI, not --vault-path/);

  result = run(["files", `vault-path=${vault}`], { env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /vault-path=<path> only applies to Optsidian-implemented commands/);
  assert.equal(fs.existsSync(log), false);
});

test("open-gui launches a fixed vault and waits for native readiness", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  const state = path.join(dir, "active-vault.txt");
  const log = path.join(dir, "obsidian-app.log");
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  const fakeNative = makeSwitchingObsidian(dir, state);
  const fakeApp = makeFakeObsidianApp(dir, state, log);

  const result = run(["open-gui", `vault-path=${vault}`, "format=json"], {
    env: {
      OPTSIDIAN_OBSIDIAN_BIN: fakeNative,
      OPTSIDIAN_OBSIDIAN_APP_BIN: fakeApp
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "open-gui");
  assert.equal(payload.wait, true);
  assert.equal(payload.vaultPath, fs.realpathSync(vault));
  assert.equal(payload.readyVaultPath, fs.realpathSync(vault));
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.match(calls[0][0], /^obsidian:\/\/open\?path=/);
  assert.equal(new URL(calls[0][0]).searchParams.get("path"), fs.realpathSync(vault));
});

test("open-gui keeps waiting when native readiness returns an error-shaped stdout", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  const state = path.join(dir, "active-vault.txt");
  const appLog = path.join(dir, "obsidian-app.log");
  const nativeLog = path.join(dir, "obsidian-native.log");
  fs.mkdirSync(vault, { recursive: true });
  const fakeNative = makeFlakyVaultObsidian(dir, vault);
  const fakeApp = makeFakeObsidianApp(dir, state, appLog);

  const result = run(["open-gui", "format=json"], {
    env: {
      OPTSIDIAN_OBSIDIAN_BIN: fakeNative,
      OPTSIDIAN_OBSIDIAN_APP_BIN: fakeApp,
      FAKE_DEFAULT_VAULT: vault,
      FAKE_OBSIDIAN_LOG: nativeLog
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.readyVaultPath, fs.realpathSync(vault));
  const nativeCalls = fs.readFileSync(nativeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(nativeCalls.filter((args) => args[0] === "vault" && args[1] === "info=path").length, 2);
});

test("open-gui supports default launch readiness and rejects vault name selection", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  const state = path.join(dir, "active-vault.txt");
  const log = path.join(dir, "obsidian-app.log");
  fs.mkdirSync(vault, { recursive: true });
  const fakeNative = makeSwitchingObsidian(dir, state);
  const fakeApp = makeFakeObsidianApp(dir, state, log);

  let result = run(["open-gui"], {
    env: {
      OPTSIDIAN_OBSIDIAN_BIN: fakeNative,
      OPTSIDIAN_OBSIDIAN_APP_BIN: fakeApp,
      FAKE_DEFAULT_VAULT: vault
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Requested Obsidian GUI launch/);
  assert.match(result.stdout, new RegExp(`native ready: ${vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls[0][0], "obsidian://open");

  result = run(["open-gui", "vault=Work"], {
    env: {
      OPTSIDIAN_OBSIDIAN_BIN: fakeNative,
      OPTSIDIAN_OBSIDIAN_APP_BIN: fakeApp
    }
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /open-gui supports vault-path=<path>, not vault=<name>/);
});

test("open-gui without wait returns even if the app process stays open", () => {
  const dir = tempRoot();
  const vault = path.join(dir, "vault");
  const state = path.join(dir, "active-vault.txt");
  const log = path.join(dir, "obsidian-app.log");
  const pidFile = path.join(dir, "obsidian-app.pid");
  fs.mkdirSync(vault, { recursive: true });
  const fakeApp = makeFakeObsidianApp(dir, state, log);

  try {
    const started = Date.now();
    const result = run(["open-gui", `vault-path=${vault}`, "no-wait", "format=json"], {
      env: {
        OPTSIDIAN_OBSIDIAN_APP_BIN: fakeApp,
        FAKE_APP_HANG: "1",
        FAKE_APP_PID_FILE: pidFile
      }
    });
    const duration = Date.now() - started;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).wait, false);
    assert.equal(duration < 1000, true, `open-gui no-wait took ${duration}ms`);
  } finally {
    cleanupPidFile(pidFile);
  }
});

test("open-gui rejects legacy wait and timeout arguments", () => {
  let result = run(["open-gui", "wait"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /waits by default/);

  result = run(["open-gui", "timeout=2"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fixed 30 second readiness timeout/);
});

test("explicit child GUI env is not overridden by recovered values", async () => {
  const { dir, env } = setup();
  const guiEnv = {
    DISPLAY: ":optsidian-test",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/optsidian-test-bus",
    XDG_RUNTIME_DIR: "/tmp/optsidian-test-runtime"
  };
  const host = startFakeObsidianHost(dir, guiEnv);

  try {
    const result = run(["files", "folder=Dashboard"], {
      mergeEnv: false,
      env: strippedGuiEnv({
        ...env,
        DISPLAY: ":wrong-display",
        FAKE_REQUIRE_OBSIDIAN_GUI: "1",
        FAKE_EXPECT_DISPLAY: guiEnv.DISPLAY,
        FAKE_EXPECT_DBUS: guiEnv.DBUS_SESSION_BUS_ADDRESS,
        FAKE_EXPECT_XDG: guiEnv.XDG_RUNTIME_DIR
      })
    });
    assert.equal(result.status, 7);
    assert.match(result.stderr, /unable to find Obsidian/i);
    // optsidian appends a sandbox-cause hint when the native CLI cannot reach Obsidian.
    assert.match(result.stderr, /sandbox/i);
  } finally {
    host.kill("SIGTERM");
  }
});

test("read returns line-numbered ranges with metadata", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "one\ntwo\nthree\nfour\n");
  const result = run(["read", "path=note.md", "lines=2:3"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /path: note\.md/);
  assert.match(result.stdout, /lines: 2-3\/4/);
  assert.match(result.stdout, /2\ttwo/);
  assert.match(result.stdout, /3\tthree/);
});

test("read caps JSON output by lines and reports empty files as zero lines", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "empty.md"), "");
  let result = run(["read", "path=empty.md", "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).range.total, 0);

  fs.writeFileSync(path.join(vault, "long.md"), "one\ntwo\nthree\nfour\nfive\n");
  result = run(["read", "path=long.md", "format=json", "max-lines=2"], { env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.range, { start: 1, end: 2, total: 5 });
  assert.equal(payload.numberedText, "1\tone\n2\ttwo");
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

test("search ranks notes and renders CLI output", async () => {
  const { vault, env } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cli-cache-"));
  fs.mkdirSync(path.join(vault, "Projects"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "Projects", "Alpha.md"),
    "---\ntitle: Alpha\ntags: [project, alpha]\naliases:\n  - Project Alpha\n---\n# Rollout\n\nBlocked by review.\n"
  );
  fs.writeFileSync(path.join(vault, "body.md"), "project alpha is mentioned only in body\n");

  let result = run(["search", "query=project alpha", "format=json", "limit=2", "debug=true"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "search");
  assert.match(payload.snapshotId, new RegExp(`^${SNAPSHOT_ID_PATTERN}$`));
  assert.deepEqual(Object.keys(payload).sort(), ["command", "debug", "matches", "ok", "snapshotId"]);
  assert.deepEqual(payload.debug.query.terms, ["project", "alpha"]);
  assert.equal(payload.debug.reranker, "unified-scalar-ac4-v1");
  assert.equal(payload.matches[0].path, "Projects/Alpha.md");
  assert.equal(payload.matches[0].title, "Alpha");
  assert.deepEqual(payload.matches[0].tags.sort(), ["alpha", "project"]);
  assert.equal(payload.matches[0].debug.bucket, "exact");
  assert.deepEqual(payload.matches[0].debug.queryTerms, ["project", "alpha"]);
  assert.equal(typeof payload.matches[0].debug.candidateScore, "number");
  assert.equal(payload.matches[0].debug.snapshotId, payload.snapshotId);
  assert.doesNotMatch(payload.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /title:|tags:|aliases:/i);

  result = run(["search", "query=project alpha", "path=Projects", "limit=2"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\. Projects\/Alpha\.md/);
  assert.match(result.stdout, /title: Alpha/);
  assert.match(result.stdout, /tags: project, alpha/);
  assert.doesNotMatch(result.stdout, /scope:|aliases:|matched:|score:/);

});

test("index mutation rendering stays stable", async () => {
  const { renderIndexResult } = await import(path.resolve("src/cli/render.ts"));
  assert.equal(renderIndexResult({ ok: true, command: "index", action: "rebuild" }), "Index rebuilt.\n");
  assert.equal(renderIndexResult({ ok: true, command: "index", action: "clear" }), "Index cleared.\n");
  assert.equal(renderIndexResult({
    ok: true,
    command: "index",
    action: "prune",
    dryRun: true,
    unusedDays: 30,
    cutoffAt: "2026-01-01T00:00:00.000Z",
    removedStores: [{ storeId: "0123456789abcdef", lastUsedAtMs: 1, bytes: 1536 }],
    skippedStores: [{ storeId: "fedcba9876543210", reason: "protected" }],
    removedBytes: 1536
  }), "Dry run. Would prune 1 search cache store, freeing 1.5 KiB. Skipped 1.\n");
  assert.equal(renderIndexResult({
    ok: true,
    ready: true,
    phase: "ready",
    nonce: "nonce",
    protocolVersion: 1,
    owner: {},
    metrics: { requests: 3, failures: 0, activeRequests: 0, startedAt: "2026-01-01T00:00:00.000Z" },
    pools: {},
    searchStore: {},
    vaults: [
      { vault: "/vault-a", state: "ready", snapshotId: "abc123", updatedAt: "2026-01-01T00:00:00.000Z" },
      { vault: "/vault-b", state: "loading", progress: { phase: "building", completed: 1, total: 2, current: "note.md" } }
    ]
  }), [
    "Search daemon ready.",
    "Phase: ready.",
    "Requests: 3, failures: 0, active: 0.",
    "Vaults:",
    "- ready: /vault-a (snapshot: abc123, updated: 2026-01-01T00:00:00.000Z)",
    "- loading: /vault-b (progress: building 1/2 note.md)",
    ""
  ].join("\n"));
});

test("index warm prepares discovered Obsidian registry vaults", async () => {
  const { dir, vault, env } = setup();
  const secondVault = path.join(dir, "second-vault");
  fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
  fs.mkdirSync(path.join(secondVault, "Notes"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Notes", "alpha.md"), "# Alpha\n\nwarm registry alpha\n");
  fs.writeFileSync(path.join(secondVault, "Notes", "beta.md"), "# Beta\n\nwarm registry beta\n");

  const registryDir = path.join(env.XDG_CONFIG_HOME, "obsidian");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "obsidian.json"),
    JSON.stringify({
      vaults: {
        first: { path: vault, open: true },
        second: { path: secondVault, open: false }
      }
    })
  );

  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cli-cache-"));
  let result = run(["index", "warm", "format=json"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.action, "warm");
  assert.deepEqual(
    payload.vaults.map((entry) => ({ vaultRoot: entry.vaultRoot, status: entry.status })),
    [
      { vaultRoot: fs.realpathSync(vault), status: "ready" },
      { vaultRoot: fs.realpathSync(secondVault), status: "ready" }
    ]
  );

  const overrideRegistry = path.join(dir, "override-obsidian.json");
  fs.writeFileSync(
    overrideRegistry,
    JSON.stringify({
      vaults: {
        secondOnly: { path: secondVault, open: true }
      }
    })
  );
  const { discoverObsidianVaultRoots } = await import(path.resolve("src/native/obsidian.ts"));
  assert.deepEqual(
    discoverObsidianVaultRoots({ env: { ...env, OBSIDIAN_CONFIG: overrideRegistry } }).vaults.map((entry) => entry.path),
    [fs.realpathSync(secondVault)]
  );
});


test("config command writes global settings and reads project-local overrides", () => {
  const project = tempRoot();
  const { env } = setup();

  let result = run(["config", "path"], { cwd: project, env });
  assert.equal(result.status, 0, result.stderr);
  const globalSettings = path.join(env.XDG_CONFIG_HOME, "optsidian", "settings.json");
  assert.equal(result.stdout.trim(), globalSettings);

  result = run(["config", "set", "search.extraLangs=ko", "format=json"], { cwd: project, env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).config.search.extraLangs, ["ko"]);
  assert.equal(fs.existsSync(path.join(project, ".optsidian", "settings.json")), false);

  result = run(["config", "set", "search.ngram=true", "format=json"], { cwd: project, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).config.search.ngram, true);

  const localSettings = path.join(project, ".optsidian", "settings.json");
  fs.mkdirSync(path.dirname(localSettings), { recursive: true });
  fs.writeFileSync(localSettings, '{\n  "search": {\n    "analyzer": "kiwi",\n    "extraLangs": ["ko"]\n  }\n}\n');

  result = run(["config", "get", "search.analyzer"], { cwd: project, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "search.analyzer: kiwi");
});

test("search requires query or tag and validates fields", () => {
  const { vault, env } = setup();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cli-cache-"));
  fs.writeFileSync(path.join(vault, "note.md"), "alpha help\n");

  let result = run(["search", "path=note.md"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /query=<text> or tag=<tag>/);

  result = run(["search", "query=alpha", "help"], { env: { ...env, XDG_CACHE_HOME: cache } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /either positional search terms or query=<text>/);
});

test("frontmatter command reads and mutates structured metadata", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "# Note\n");
  const values = path.join(vault, "aliases.json");
  fs.writeFileSync(values, "[\"Project Alpha\",\"Alpha\"]\n");

  let result = run(["frontmatter", "set", "path=note.md", "key=aliases", `value-json=@${values}`, "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).command, "frontmatter");

  result = run(["frontmatter", "read", "path=note.md", "format=json"], { env });
  assert.equal(result.status, 0, result.stderr);
  const read = JSON.parse(result.stdout);
  assert.deepEqual(read.frontmatter.aliases, ["Project Alpha", "Alpha"]);
});

test("write mutates only optimized commands", () => {
  const { vault, env } = setup();
  const result = run(["write", "path=note.md", "content=hello\\nthere"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "hello\nthere");
});

test("dry-run does not write", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "old\n");
  const result = run(["edit", "path=note.md", "replace=old", "with=new", "dry-run"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run/);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "old\n");
});

test("edit regex replacement text is literal", () => {
  const { vault, env } = setup();
  fs.writeFileSync(path.join(vault, "note.md"), "hello\nabc123\nabc456\n");
  const result = run(["edit", "path=note.md", "regex=abc\\d+", "with=$1", "all"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "hello\n$1\n$1\n");
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
