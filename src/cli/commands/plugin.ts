import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getValue, hasFlag, ParsedArgs } from "../args.js";
import { delegateToObsidian } from "../delegate.js";
import { parseFormat, type OutputFormat } from "../render.js";
import { hasVaultPathArg, resolveVaultRoot } from "../vault.js";
import { captureObsidian, resolveObsidianVaultRoot } from "../../native/obsidian.js";
import { RuntimeError, UsageError } from "../../errors.js";
import { fetchReleasePlugin, parseGithubRepo } from "./plugin-release.js";

type PluginManifest = {
  id: string;
  name?: string;
  version?: string;
};

type PluginInstallSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; ref?: string; dir?: string; resolvedCommit: string }
  | { type: "release"; url: string; tag: string };

type RequestedPluginInstallSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; ref?: string; dir?: string };

type PluginInstallResult = {
  ok: true;
  command: "plugin:install";
  plugin: {
    id: string;
    name?: string;
    version?: string;
    path: string;
  };
  source: PluginInstallSource;
  vaultPath: string;
  enable: {
    requested: boolean;
    status: "enabled" | "skipped";
    changed?: boolean;
  };
  refresh: {
    attempted: boolean;
    status: "plugin-reloaded" | "app-reloaded" | "skipped";
    command?: "plugin:reload" | "reload";
    reason?: string;
  };
};

type EnablePlan = {
  result: PluginInstallResult["enable"];
  file?: string;
  next?: string[];
};

export async function runPluginInstall(args: ParsedArgs): Promise<void> {
  const hasCustomSource = args.values.has("url") || args.values.has("path");
  if (!hasCustomSource) {
    if (hasVaultPathArg(args)) {
      throw new UsageError("vault-path=<path> only applies to custom plugin installs. Native plugin:install id=<id> uses Obsidian's native vault context.");
    }
    delegateToObsidian([args.command ?? "plugin:install", ...args.raw]);
  }

  if (args.values.has("id")) {
    throw new UsageError("Use only one plugin source selector: id=<id>, url=<git-url>, or path=<plugin-dir>");
  }
  if (args.values.has("url") && args.values.has("path")) {
    throw new UsageError("Use either url=<git-url> or path=<plugin-dir>, not both");
  }
  const unexpected = args.positionals.find((value) => value !== "enable");
  if (unexpected) {
    throw new UsageError(`Unexpected plugin:install argument: ${unexpected}`);
  }

  const format = parseFormat(getValue(args, "format"));
  const vaultPath = resolveVaultRoot(args);
  const requestedSource = resolveInstallSource(args);
  let tempRoot: string | undefined;
  try {
    const materialized = await materializeSource(requestedSource);
    tempRoot = materialized.tempRoot;
    const source = materialized.source;
    const plugin = loadPluginManifest(materialized.pluginRoot);
    const obsidianDir = ensureObsidianDir(vaultPath);
    const targetRoot = path.join(obsidianDir, "plugins", plugin.manifest.id);
    if (pathsOverlap(plugin.root, targetRoot)) {
      throw new RuntimeError("Refusing to install plugin because source and target directories overlap");
    }
    const enablePlan = prepareEnable(obsidianDir, plugin.manifest.id, hasFlag(args, "enable"));

    installPluginRuntime(plugin.root, targetRoot);
    commitEnable(enablePlan);
    const refresh = refreshResult(vaultPath, plugin.manifest.id);
    const result: PluginInstallResult = {
      ok: true,
      command: "plugin:install",
      plugin: {
        id: plugin.manifest.id,
        ...(plugin.manifest.name ? { name: plugin.manifest.name } : {}),
        ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
        path: targetRoot
      },
      source,
      vaultPath,
      enable: enablePlan.result,
      refresh
    };
    process.stdout.write(renderPluginInstall(result, format));
  } finally {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function resolveInstallSource(args: ParsedArgs): RequestedPluginInstallSource {
  const pathValue = getValue(args, "path");
  const urlValue = getValue(args, "url");
  const ref = optionalValue(args, "ref");
  const dir = optionalValue(args, "dir");
  if (pathValue !== undefined) {
    if (pathValue.length === 0) throw new UsageError("path=<plugin-dir> requires a value");
    if (ref) throw new UsageError("ref=<git-ref> only applies to url=<git-url> plugin installs");
    if (dir) throw new UsageError("dir=<subdir> only applies to url=<git-url> plugin installs");
    return { type: "local", path: resolveExistingDirectory(pathValue, "Plugin path") };
  }
  if (urlValue === undefined || urlValue.length === 0) {
    throw new UsageError("Custom plugin install requires url=<git-url> or path=<plugin-dir>");
  }
  return {
    type: "git",
    url: normalizeGitSource(urlValue),
    ...(ref ? { ref } : {}),
    ...(dir ? { dir } : {})
  };
}

function optionalValue(args: ParsedArgs, key: string): string | undefined {
  const value = getValue(args, key);
  if (value === "") {
    throw new UsageError(`${key}= requires a value`);
  }
  return value;
}

export function normalizeGitSource(input: string): string {
  if (/^(https?|ssh|git|file):\/\//.test(input)) return input;
  if (/^[^@\s]+@[^:\s]+:.+/.test(input)) return input;
  if (/^github:[^\s]+\/[^\s]+$/.test(input)) return `https://github.com/${input.slice("github:".length)}`;
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\.git)?$/.test(input)) return `https://github.com/${input}`;
  if (/^[A-Za-z0-9.-]+(?::\d+)?\/[^\s]+\/[^\s]+(?:\.git)?\/?$/.test(input)) return `https://${input}`;
  return input;
}

async function materializeSource(requested: RequestedPluginInstallSource): Promise<{
  source: PluginInstallSource;
  pluginRoot: string;
  tempRoot?: string;
}> {
  if (requested.type === "local") {
    return { source: requested, pluginRoot: requested.path };
  }
  // Prefer a published GitHub release (the official distribution); fall back to a clone of
  // the repo (root, or dir= for a monorepo subdir) when no usable release is available.
  const repo = requested.dir ? undefined : parseGithubRepo(requested.url);
  if (repo) {
    const release = await fetchReleasePlugin({
      owner: repo.owner,
      repo: repo.repo,
      host: repo.host,
      apiProtocol: repo.apiProtocol,
      env: process.env,
      ...(requested.ref ? { tag: requested.ref } : {})
    });
    if (release) {
      return {
        source: { type: "release", url: requested.url, tag: release.tag },
        pluginRoot: release.dir,
        tempRoot: release.dir
      };
    }
  }
  const cloneRoot = clonePluginSource(requested.url, requested.ref);
  const pluginRoot = requested.dir ? resolveSourceSubdir(cloneRoot, requested.dir) : cloneRoot;
  return {
    source: {
      type: "git",
      url: requested.url,
      ...(requested.ref ? { ref: requested.ref } : {}),
      ...(requested.dir ? { dir: requested.dir } : {}),
      resolvedCommit: resolveGitHead(cloneRoot)
    },
    pluginRoot,
    tempRoot: cloneRoot
  };
}

function clonePluginSource(url: string, ref: string | undefined): string {
  const tempRoot = path.join(os.tmpdir(), `optsidian-plugin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    runGit(["clone", url, tempRoot]);
    if (ref) {
      runGit(["-C", tempRoot, "checkout", ref]);
    }
    return tempRoot;
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveGitHead(repoRoot: string): string {
  return runGit(["-C", repoRoot, "rev-parse", "HEAD"]);
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  if (result.error) {
    throw new RuntimeError(`Failed to run git: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const details = (result.stderr || result.stdout || `git ${args[0]} failed`).trim();
    throw new RuntimeError(details);
  }
  return result.stdout.trim();
}

function resolveSourceSubdir(root: string, dir: string): string {
  if (path.isAbsolute(dir)) {
    throw new UsageError("dir=<subdir> must be relative");
  }
  const resolved = path.resolve(root, dir);
  if (!isPathInside(path.resolve(root), resolved)) {
    throw new UsageError("dir=<subdir> must stay inside the cloned repository");
  }
  return resolveExistingDirectory(resolved, "Plugin subdirectory");
}

function loadPluginManifest(pluginRoot: string): { root: string; manifest: PluginManifest } {
  const root = resolveExistingDirectory(pluginRoot, "Plugin path");
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new UsageError(`Plugin manifest not found: ${manifestPath}`);
  }
  if (!fs.existsSync(path.join(root, "main.js"))) {
    throw new UsageError(`Plugin entrypoint not found: ${path.join(root, "main.js")}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Invalid plugin manifest JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("Plugin manifest must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0 || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new UsageError("Plugin manifest requires a safe non-empty string id");
  }
  return {
    root,
    manifest: {
      id,
      ...(typeof record.name === "string" && record.name.length > 0 ? { name: record.name } : {}),
      ...(typeof record.version === "string" && record.version.length > 0 ? { version: record.version } : {})
    }
  };
}

function resolveExistingDirectory(input: string, label: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new RuntimeError(`${label} does not exist: ${input}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new RuntimeError(`${label} is not a directory: ${input}`);
  }
  return fs.realpathSync(resolved);
}

function ensureObsidianDir(vaultPath: string): string {
  const obsidianDir = path.join(vaultPath, ".obsidian");
  if (fs.existsSync(obsidianDir) && !fs.statSync(obsidianDir).isDirectory()) {
    throw new RuntimeError(`.obsidian exists but is not a directory: ${obsidianDir}`);
  }
  fs.mkdirSync(obsidianDir, { recursive: true });
  return obsidianDir;
}

// An Obsidian plugin only needs its prebuilt runtime files. Deploying the repo's
// source (src/, package.json, node_modules, docs, .git) is what makes tools and
// agents think the installed plugin must be `npm install`-ed/built to work, so we
// install ONLY these files. The swap stays atomic via a temp dir + rename.
const PLUGIN_RUNTIME_FILES = ["manifest.json", "main.js", "styles.css", "data.json"];

function installPluginRuntime(sourceRoot: string, targetRoot: string): void {
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  const tempTarget = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  const backupTarget = `${targetRoot}.backup-${process.pid}-${Date.now()}`;
  const hadTarget = fs.existsSync(targetRoot);
  let movedExisting = false;
  try {
    fs.rmSync(tempTarget, { recursive: true, force: true });
    fs.mkdirSync(tempTarget, { recursive: true });
    for (const name of PLUGIN_RUNTIME_FILES) {
      const file = path.join(sourceRoot, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.copyFileSync(file, path.join(tempTarget, name));
      }
    }
    // data.json is the plugin's saved settings in the vault, not shipped by the
    // source — preserve the existing one across reinstall.
    if (hadTarget) {
      const existingData = path.join(targetRoot, "data.json");
      if (fs.existsSync(existingData) && fs.statSync(existingData).isFile()) {
        fs.copyFileSync(existingData, path.join(tempTarget, "data.json"));
      }
    }
    if (hadTarget) {
      fs.renameSync(targetRoot, backupTarget);
      movedExisting = true;
    }
    fs.renameSync(tempTarget, targetRoot);
    fs.rmSync(backupTarget, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tempTarget, { recursive: true, force: true });
    if (movedExisting) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
      fs.renameSync(backupTarget, targetRoot);
    }
    throw error;
  }
}

function prepareEnable(obsidianDir: string, pluginId: string, requested: boolean): EnablePlan {
  if (!requested) {
    return { result: { requested: false, status: "skipped" } };
  }
  const file = path.join(obsidianDir, "community-plugins.json");
  const current = readCommunityPlugins(file);
  const changed = !current.includes(pluginId);
  return {
    result: { requested: true, status: "enabled", changed },
    ...(changed ? { file, next: [...current, pluginId] } : {})
  };
}

function commitEnable(plan: EnablePlan): void {
  if (plan.file && plan.next) {
    fs.writeFileSync(plan.file, `${JSON.stringify(plan.next, null, 2)}\n`);
  }
}

function readCommunityPlugins(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(`Invalid community-plugins.json: ${message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new RuntimeError("community-plugins.json must contain an array of plugin ids");
  }
  return parsed;
}

function refreshResult(vaultPath: string, pluginId: string): PluginInstallResult["refresh"] {
  let activeVault: string;
  try {
    activeVault = resolveObsidianVaultRoot();
  } catch (error) {
    return {
      attempted: false,
      status: "skipped",
      reason: `Native active vault is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!sameExistingPath(activeVault, vaultPath)) {
    return {
      attempted: false,
      status: "skipped",
      reason: `Native active vault is ${activeVault}, not ${vaultPath}`
    };
  }

  let result: ReturnType<typeof captureObsidian>;
  try {
    result = captureObsidian(["plugin:reload", `id=${pluginId}`]);
  } catch (error) {
    return {
      attempted: true,
      status: "skipped",
      command: "plugin:reload",
      reason: `Native plugin refresh is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const details = (result.stderr || result.stdout).trim();
  if (nativeSucceeded(result)) {
    return { attempted: true, status: "plugin-reloaded", command: "plugin:reload" };
  }
  if (!shouldFallbackToAppReload(details, pluginId)) {
    return { attempted: true, status: "skipped", command: "plugin:reload", reason: details || "Native plugin:reload failed" };
  }

  let fallback: ReturnType<typeof captureObsidian>;
  try {
    fallback = captureObsidian(["reload"]);
  } catch (error) {
    return {
      attempted: true,
      status: "skipped",
      command: "reload",
      reason: `Native app reload is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (nativeSucceeded(fallback)) {
    return { attempted: true, status: "app-reloaded", command: "reload" };
  }
  return {
    attempted: true,
    status: "skipped",
    command: "reload",
    reason: nativeDetails(fallback) || `Native plugin:reload could not find ${pluginId} and app reload failed`
  };
}

function shouldFallbackToAppReload(details: string, pluginId: string): boolean {
  return details.includes(`Plugin "${pluginId}" not found`) || details.includes(`Plugin "${pluginId}" is not enabled`);
}

function nativeSucceeded(result: { stdout: string; stderr: string; status: number }): boolean {
  const details = nativeDetails(result);
  return result.status === 0 && !/^Error:/m.test(details);
}

function nativeDetails(result: { stdout: string; stderr: string; status: number }): string {
  return (result.stderr || result.stdout).trim();
}

function renderPluginInstall(result: PluginInstallResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  return [
    `Installed plugin ${result.plugin.id}.`,
    ...(result.plugin.name ? [`name: ${result.plugin.name}`] : []),
    ...(result.plugin.version ? [`version: ${result.plugin.version}`] : []),
    `source: ${formatSource(result.source)}`,
    `vault: ${result.vaultPath}`,
    `path: ${result.plugin.path}`,
    `enable: ${result.enable.status}${result.enable.changed === undefined ? "" : result.enable.changed ? " changed" : " unchanged"}`,
    `refresh: ${result.refresh.status}${result.refresh.command ? ` via ${result.refresh.command}` : ""}${result.refresh.reason ? ` (${result.refresh.reason})` : ""}`
  ].join("\n").concat("\n");
}

function formatSource(source: PluginInstallSource): string {
  if (source.type === "local") return `local ${source.path}`;
  if (source.type === "release") return `release ${source.url}@${source.tag}`;
  const ref = source.ref ? `#${source.ref}` : "";
  const dir = source.dir ? ` dir=${source.dir}` : "";
  return `git ${source.url}${ref}${dir} commit=${shortCommit(source.resolvedCommit)}`;
}

function shortCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function pathsOverlap(a: string, b: string): boolean {
  const left = existingOrResolvedPath(a);
  const right = existingOrResolvedPath(b);
  return isPathInside(left, right) || isPathInside(right, left);
}

function sameExistingPath(a: string, b: string): boolean {
  return existingOrResolvedPath(a) === existingOrResolvedPath(b);
}

function existingOrResolvedPath(input: string): string {
  return fs.existsSync(input) ? fs.realpathSync(input) : path.resolve(input);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
