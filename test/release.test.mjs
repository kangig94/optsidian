import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("dist/optsidian");
const packageScript = path.resolve("scripts/package-release.mjs");
const installScript = path.resolve("scripts/install.sh");
const uninstallScript = path.resolve("scripts/uninstall.sh");
const packageVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version;
const newerVersion = nextPatchVersion(packageVersion);
const UPDATE_TOOLS = [];
const INSTALL_TOOLS = ["curl", "cp", "chmod", "mv", "uname", "mktemp", "mkdir", "rm", "head"];

function tempRoot(prefix = "optsidian-release-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function locateCommand(name) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  assert.equal(result.status, 0, `Missing required test command: ${name}`);
  return result.stdout.trim();
}

function linkCommand(binDir, name, target) {
  fs.symlinkSync(target, path.join(binDir, name));
}

function createToolBin(dir, options = {}) {
  const binDir = path.join(dir, options.name ?? "tool-bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (options.nodeVersion) {
    writeFakeNode(binDir, options.nodeVersion);
  } else {
    linkCommand(binDir, "node", process.execPath);
  }
  for (const tool of options.tools ?? []) {
    if (tool === "curl" && options.curlLog) {
      writeFakeCurl(binDir, options.curlLog);
      continue;
    }
    linkCommand(binDir, tool, locateCommand(tool));
  }
  if (options.codexLog) {
    writeFakeClient(binDir, "codex", options.codexLog);
  }
  if (options.claudeLog) {
    writeFakeClient(binDir, "claude", options.claudeLog);
  }
  if (options.obsidianLog) {
    writeFakeObsidian(binDir, options.obsidianLog);
  }
  return binDir;
}

function writeFakeCurl(binDir, logFile) {
  const file = path.join(binDir, "curl");
  const realCurl = locateCommand("curl");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.CURL_LOG_FILE) {
  fs.appendFileSync(process.env.CURL_LOG_FILE, JSON.stringify(args) + "\\n");
}
const result = spawnSync(${JSON.stringify(realCurl)}, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function runCliAsync(args, env) {
  return runProcessAsync(process.execPath, [cli, ...args], env);
}

function runBash(script, env) {
  return spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function runBashAsync(script, env) {
  return runProcessAsync("/bin/bash", [script], env);
}

function writeFakeClient(binDir, name, logFile) {
  const file = path.join(binDir, name);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("${name} 1.0.0");
  process.exit(0);
}
if (process.env.LOG_FILE) {
  fs.appendFileSync(process.env.LOG_FILE, JSON.stringify(args) + "\\n");
}
process.exit(0);
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function writeFakeObsidian(binDir, logFile) {
  const file = path.join(binDir, "obsidian");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.FAKE_OBSIDIAN_LOG) {
  fs.appendFileSync(process.env.FAKE_OBSIDIAN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
}
process.exit(0);
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function writeFakeNode(binDir, version) {
  const file = path.join(binDir, "node");
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("v${version}");
  process.exit(0);
}
console.error("unexpected fake node invocation: " + args.join(" "));
process.exit(99);
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function runProcessAsync(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        status: code,
        signal,
        stdout,
        stderr
      });
    });
  });
}

function makeReleaseBundle(dir, version, options = {}) {
  const label = options.label ?? version;
  const assetVersion = options.assetVersion ?? version;
  const contentLabel = options.contentLabel ?? assetVersion;
  const tag = `v${version}`;
  const stage = path.join(dir, `stage-${label}`);
  fs.mkdirSync(stage, { recursive: true });
  const optsidianAsset = { name: `optsidian-${tag}`, filePath: path.join(dir, `optsidian-${tag}`) };
  const optsidianMcpAsset = { name: `optsidian-mcp-${tag}`, filePath: path.join(dir, `optsidian-mcp-${tag}`) };
  fs.writeFileSync(
    optsidianAsset.filePath,
    `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("${assetVersion}"); process.exit(0); }\nconsole.log("optsidian ${contentLabel}")\n`
  );
  fs.writeFileSync(
    optsidianMcpAsset.filePath,
    `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("${assetVersion}"); process.exit(0); }\nconsole.log("optsidian-mcp ${contentLabel}")\n`
  );
  fs.chmodSync(optsidianAsset.filePath, 0o755);
  fs.chmodSync(optsidianMcpAsset.filePath, 0o755);

  const checksumsAsset = { name: `checksums-${tag}.txt`, filePath: path.join(dir, `checksums-${tag}.txt`) };
  fs.writeFileSync(
    checksumsAsset.filePath,
    [optsidianAsset, optsidianMcpAsset].map((asset) => `${sha256(asset.filePath)}  ${asset.name}`).join("\n").concat("\n")
  );

  return { tag, version, assets: [optsidianAsset, optsidianMcpAsset, checksumsAsset] };
}

function makePackagedReleaseBundle(dir) {
  const outDir = path.join(dir, "packaged-release");
  const result = spawnSync(process.execPath, [packageScript, "--out-dir", outDir], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const tag = `v${packageVersion}`;
  return {
    tag,
    version: packageVersion,
    assets: [
      { name: `optsidian-${tag}`, filePath: path.join(outDir, `optsidian-${tag}`) },
      { name: `optsidian-mcp-${tag}`, filePath: path.join(outDir, `optsidian-mcp-${tag}`) },
      { name: `checksums-${tag}.txt`, filePath: path.join(outDir, `checksums-${tag}.txt`) }
    ]
  };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function startReleaseServer(releases, latestTag) {
  const latest = latestTag ?? releases[0].tag;
  let baseUrl = "";
  const byTag = new Map(releases.map((release) => [release.tag, release]));
  const byAsset = new Map(
    releases.flatMap((release) => release.assets.map((asset) => [asset.name, asset.filePath]))
  );

  const server = http.createServer((req, res) => {
    try {
      if (req.url === "/releases/latest") {
        const release = byTag.get(latest);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(releasePayload(baseUrl, release)));
        return;
      }
      if (req.url && req.url.startsWith("/releases/tags/")) {
        const tag = decodeURIComponent(req.url.slice("/releases/tags/".length));
        const release = byTag.get(tag);
        if (!release) {
          res.statusCode = 404;
          res.end("missing");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(releasePayload(baseUrl, release)));
        return;
      }
      if (req.url && req.url.startsWith("/assets/")) {
        const assetName = decodeURIComponent(req.url.slice("/assets/".length));
        const filePath = byAsset.get(assetName);
        if (!filePath) {
          res.statusCode = 404;
          res.end("missing");
          return;
        }
        res.setHeader("content-type", "application/octet-stream");
        res.end(fs.readFileSync(filePath));
        return;
      }
      res.statusCode = 404;
      res.end("missing");
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    apiBase: `${baseUrl}/releases`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function releasePayload(baseUrl, release) {
  return {
    tag_name: release.tag,
    draft: false,
    prerelease: false,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      browser_download_url: `${baseUrl}/assets/${asset.name}`
    }))
  };
}

function writeManagedInstall(cacheHome, homeDir, version, options = {}) {
  const stateBase = path.join(cacheHome, "optsidian");
  const binDir = options.binDir ?? path.join(homeDir, ".local", "bin");
  fs.mkdirSync(stateBase, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const optsidianPath = path.join(binDir, "optsidian");
  const mcpPath = path.join(binDir, "optsidian-mcp");
  if (options.validExecutables) {
    const executableVersion = options.executableVersion ?? version;
    const contentLabel = options.contentLabel ?? executableVersion;
    fs.writeFileSync(
      optsidianPath,
      `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("${executableVersion}"); process.exit(0); }\nconsole.log("optsidian ${contentLabel}")\n`
    );
    fs.writeFileSync(
      mcpPath,
      `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("${executableVersion}"); process.exit(0); }\nconsole.log("optsidian-mcp ${contentLabel}")\n`
    );
  } else {
    fs.writeFileSync(optsidianPath, `old-${version}\n`);
    fs.writeFileSync(mcpPath, `old-mcp-${version}\n`);
  }
  fs.chmodSync(optsidianPath, 0o755);
  fs.chmodSync(mcpPath, 0o755);
  fs.writeFileSync(
    path.join(stateBase, "install.json"),
    `${JSON.stringify(
      {
        version,
        tag: `v${version}`,
        binDir,
        optsidianPath,
        optsidianMcpPath: mcpPath,
        vaultPath: options.vaultPath,
        codexRegistered: false,
        claudeRegistered: false,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
  return { stateBase, binDir, optsidianPath, mcpPath };
}

test("package-release script creates the expected release asset contract", () => {
  const outDir = tempRoot("optsidian-package-");
  const result = spawnSync(process.execPath, [packageScript, "--out-dir", outDir], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const tag = `v${packageJson.version}`;
  const optsidianAsset = path.join(outDir, `optsidian-${tag}`);
  const optsidianMcpAsset = path.join(outDir, `optsidian-mcp-${tag}`);
  const checksumsAsset = path.join(outDir, `checksums-${tag}.txt`);
  assert.equal(fs.existsSync(optsidianAsset), true);
  assert.equal(fs.existsSync(optsidianMcpAsset), true);
  assert.equal(fs.existsSync(checksumsAsset), true);

  const checksums = fs.readFileSync(checksumsAsset, "utf8");
  assert.match(checksums, new RegExp(`  optsidian-${tag}$`, "m"));
  assert.match(checksums, new RegExp(`  optsidian-mcp-${tag}$`, "m"));
});

test("update check without managed install reports latest release and guidance", async () => {
  const dir = tempRoot();
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");

  try {
    const result = await runCliAsync(["update", "check"], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`current: ${packageVersion.replace(/\./g, "\\.")}`));
    assert.match(result.stdout, new RegExp(`latest: v${newerVersion.replace(/\./g, "\\.")}`));
    assert.match(result.stdout, /managed-install: false/);
    assert.match(result.stdout, /update: available/);
    assert.match(result.stdout, /note: Managed install metadata not found/);
  } finally {
    await server.close();
  }
});

test("update installs a requested release into the managed bin dir and refreshes available MCP clients", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  const codexLog = path.join(dir, "codex.log");
  const fakeBin = createToolBin(dir, { name: "update-bin", tools: UPDATE_TOOLS, codexLog });
  const managed = writeManagedInstall(cache, home, packageVersion, { vaultPath: vault });

  try {
    const result = await runCliAsync([`update`, `version=v${newerVersion}`], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: fakeBin,
      LOG_FILE: codexLog
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Updated Optsidian to v${newerVersion.replace(/\./g, "\\.")}\\.`));
    assert.equal(fs.readFileSync(managed.optsidianPath, "utf8").includes(`optsidian ${newerVersion}`), true);

    const manifest = JSON.parse(fs.readFileSync(path.join(cache, "optsidian", "install.json"), "utf8"));
    assert.equal(manifest.version, newerVersion);
    assert.equal(manifest.codexRegistered, true);
    assert.equal(manifest.claudeRegistered, false);

    const calls = fs.readFileSync(codexLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["mcp", "remove", "optsidian"]);
    assert.deepEqual(calls[1], ["mcp", "add", "optsidian", "--env", `OPTSIDIAN_VAULT_PATH=${vault}`, "--", managed.mcpPath]);
  } finally {
    await server.close();
  }
});

test("update installs actual packaged release assets", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makePackagedReleaseBundle(dir);
  const server = await startReleaseServer([release], release.tag);
  const fakeBin = createToolBin(dir, { name: "update-real-asset-bin", tools: UPDATE_TOOLS });
  writeManagedInstall(cache, home, "0.0.9");

  try {
    const result = await runCliAsync([`update`, `version=v${packageVersion}`], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: fakeBin
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Updated Optsidian to v${packageVersion.replace(/\./g, "\\.")}\\.`));
  } finally {
    await server.close();
  }
});

test("update repairs a broken managed install even when already on the latest version", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, packageVersion);
  const server = await startReleaseServer([release], release.tag);
  const managed = writeManagedInstall(cache, home, packageVersion);
  fs.rmSync(managed.optsidianPath, { force: true });

  try {
    const check = await runCliAsync(["update", "check"], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-check-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /update: repair/);
    assert.match(check.stdout, /Managed install needs repair/);

    const result = await runCliAsync(["update"], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-repair-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Repaired Optsidian v${packageVersion.replace(/\./g, "\\.")}\\.`));
    assert.equal(fs.existsSync(managed.optsidianPath), true);
  } finally {
    await server.close();
  }
});

test("update rejects release assets whose embedded version does not match the requested tag", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion, { assetVersion: packageVersion });
  const server = await startReleaseServer([release], release.tag);
  writeManagedInstall(cache, home, packageVersion);

  try {
    const result = await runCliAsync([`update`, `version=v${newerVersion}`], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-version-mismatch-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version mismatch: expected/);
  } finally {
    await server.close();
  }
});

test("update repairs a managed install when same-version release checksums changed", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, packageVersion, { label: "remote", contentLabel: "remote" });
  const server = await startReleaseServer([release], release.tag);
  const managed = writeManagedInstall(cache, home, packageVersion, {
    validExecutables: true,
    executableVersion: packageVersion,
    contentLabel: "local"
  });

  try {
    const check = await runCliAsync(["update", "check"], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-checksum-check-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /update: repair/);
    assert.match(check.stdout, /checksum differs from release/);

    const result = await runCliAsync(["update"], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-checksum-repair-bin", tools: UPDATE_TOOLS })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Repaired Optsidian v${packageVersion.replace(/\./g, "\\.")}\\.`));
    assert.match(fs.readFileSync(managed.optsidianPath, "utf8"), /optsidian remote/);
  } finally {
    await server.close();
  }
});

test("update uses curl transport when proxy environment is configured", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  const curlLog = path.join(dir, "curl.log");
  writeManagedInstall(cache, home, packageVersion);

  try {
    const result = await runCliAsync([`update`, `version=v${newerVersion}`], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-proxy-bin", tools: ["curl"], curlLog }),
      CURL_LOG_FILE: curlLog,
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Updated Optsidian to v${newerVersion.replace(/\./g, "\\.")}\\.`));
    const calls = fs.readFileSync(curlLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((args) => args.includes(`${server.apiBase}/tags/${encodeURIComponent(`v${newerVersion}`)}`)));
  } finally {
    await server.close();
  }
});

test("update fails clearly when proxy environment is configured without curl", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  writeManagedInstall(cache, home, packageVersion);

  try {
    const result = await runCliAsync([`update`, `version=v${newerVersion}`], {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: createToolBin(dir, { name: "update-proxy-no-curl-bin", tools: UPDATE_TOOLS }),
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Proxy environment detected, but curl is not available/);
  } finally {
    await server.close();
  }
});

test("install.sh installs the latest release and succeeds without MCP clients", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  const obsidianLog = path.join(dir, "obsidian.log");
  const toolBin = createToolBin(dir, { name: "install-bin", tools: INSTALL_TOOLS, obsidianLog });

  try {
    const result = await runBashAsync(installScript, {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: toolBin,
      FAKE_OBSIDIAN_LOG: obsidianLog
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Installed v${newerVersion.replace(/\./g, "\\.")}\\.`));
    assert.match(result.stdout, /No supported MCP client detected/);

    const binDir = path.join(home, ".local", "bin");
    assert.equal(fs.existsSync(path.join(binDir, "optsidian")), true);
    assert.equal(fs.existsSync(path.join(binDir, "optsidian-mcp")), true);

    const manifest = JSON.parse(fs.readFileSync(path.join(cache, "optsidian", "install.json"), "utf8"));
    assert.equal(manifest.version, newerVersion);
    assert.equal(manifest.codexRegistered, false);
    assert.equal(manifest.claudeRegistered, false);
    assert.equal(fs.existsSync(obsidianLog), false);
  } finally {
    await server.close();
  }
});

test("install.sh installs actual packaged release assets", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makePackagedReleaseBundle(dir);
  const server = await startReleaseServer([release], release.tag);
  const toolBin = createToolBin(dir, { name: "install-real-asset-bin", tools: INSTALL_TOOLS });

  try {
    const result = await runBashAsync(installScript, {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: toolBin
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Installed v${packageVersion.replace(/\./g, "\\.")}\\.`));
  } finally {
    await server.close();
  }
});

test("install.sh rejects Node.js versions older than 20", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const toolBin = createToolBin(dir, { name: "install-old-node", tools: INSTALL_TOOLS, nodeVersion: "18.19.0" });

  const result = await runBashAsync(installScript, {
    HOME: home,
    XDG_CACHE_HOME: cache,
    PATH: toolBin
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Node\.js 20 or newer is required/);
});

test("install.sh rejects release assets whose embedded version does not match the release tag", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion, { assetVersion: packageVersion });
  const server = await startReleaseServer([release], release.tag);
  const toolBin = createToolBin(dir, { name: "install-version-mismatch-bin", tools: INSTALL_TOOLS });

  try {
    const result = await runBashAsync(installScript, {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: toolBin
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version mismatch: expected/);
  } finally {
    await server.close();
  }
});

test("install.sh registers only the available MCP client", async () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const release = makeReleaseBundle(dir, newerVersion);
  const server = await startReleaseServer([release], release.tag);
  const codexLog = path.join(dir, "codex.log");
  const fakeBin = createToolBin(dir, { name: "install-bin", tools: INSTALL_TOOLS, codexLog });

  try {
    const result = await runBashAsync(installScript, {
      HOME: home,
      XDG_CACHE_HOME: cache,
      OPTSIDIAN_RELEASE_API_BASE: server.apiBase,
      PATH: fakeBin,
      LOG_FILE: codexLog
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registering 'optsidian' with Codex/);
    assert.doesNotMatch(result.stdout, /Claude Code/);

    const manifest = JSON.parse(fs.readFileSync(path.join(cache, "optsidian", "install.json"), "utf8"));
    assert.equal(manifest.codexRegistered, true);
    assert.equal(manifest.claudeRegistered, false);

    const calls = fs.readFileSync(codexLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["mcp", "remove", "optsidian"]);
    assert.deepEqual(calls[1], ["mcp", "add", "optsidian", "--", path.join(home, ".local", "bin", "optsidian-mcp")]);
  } finally {
    await server.close();
  }
});

test("uninstall.sh removes binaries from the manifest-recorded bin dir", () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const customBin = path.join(dir, "custom-bin");
  const stateBase = path.join(cache, "optsidian");
  fs.mkdirSync(customBin, { recursive: true });
  fs.mkdirSync(path.join(stateBase, "releases"), { recursive: true });
  fs.writeFileSync(path.join(customBin, "optsidian"), "x");
  fs.writeFileSync(path.join(customBin, "optsidian-mcp"), "y");
  fs.writeFileSync(
    path.join(stateBase, "install.json"),
    `${JSON.stringify(
      {
        version: packageVersion,
        tag: `v${packageVersion}`,
        binDir: customBin,
        optsidianPath: path.join(customBin, "optsidian"),
        optsidianMcpPath: path.join(customBin, "optsidian-mcp"),
        codexRegistered: false,
        claudeRegistered: false,
        installedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );

  const result = runBash(uninstallScript, {
    HOME: home,
    XDG_CACHE_HOME: cache,
    PATH: createToolBin(dir, { name: "uninstall-custom-bin", tools: ["rm"] })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(customBin, "optsidian")), false);
  assert.equal(fs.existsSync(path.join(customBin, "optsidian-mcp")), false);
  assert.equal(fs.existsSync(path.join(stateBase, "install.json")), false);
});

test("uninstall.sh removes managed install state and binaries", () => {
  const dir = tempRoot();
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const binDir = path.join(home, ".local", "bin");
  const stateBase = path.join(cache, "optsidian");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(stateBase, "releases"), { recursive: true });
  fs.writeFileSync(path.join(binDir, "optsidian"), "x");
  fs.writeFileSync(path.join(binDir, "optsidian-mcp"), "y");
  fs.writeFileSync(path.join(stateBase, "install.json"), "{}\n");
  fs.writeFileSync(path.join(stateBase, "releases", "asset.bin"), "z");

  const result = runBash(uninstallScript, {
    HOME: home,
    XDG_CACHE_HOME: cache,
    PATH: createToolBin(dir, { name: "uninstall-bin", tools: ["rm"] })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(binDir, "optsidian")), false);
  assert.equal(fs.existsSync(path.join(binDir, "optsidian-mcp")), false);
  assert.equal(fs.existsSync(path.join(stateBase, "install.json")), false);
  assert.equal(fs.existsSync(path.join(stateBase, "releases")), false);
});

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid package version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
