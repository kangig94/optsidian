import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RuntimeError, UsageError } from "../errors.js";
import { type InstalledAddon, loadAddonManifest } from "./manifest.js";

const REGISTRY_FILE = "registry.json";
const REGISTRY_VERSION = 1;

type AddonRegistry = {
  version: 1;
  addons: Record<string, AddonRegistryEntry>;
};

type AddonRegistryEntry = {
  root: string;
  source: AddonSource;
};

export type AddonSource =
  | { type: "local" }
  | { type: "git"; url: string; ref?: string };

export type AddonSummary = {
  id: string;
  name: string;
  version: string;
  root: string;
  source: AddonSource;
};

export function addonHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPTSIDIAN_ADDON_HOME) return path.resolve(env.OPTSIDIAN_ADDON_HOME);
  const dataHome = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "optsidian", "addons");
}

export type GitInstallOptions = {
  ref?: string;
  validateAddon?: (addon: InstalledAddon) => void;
};

export function normalizeGitSource(input: string): string | undefined {
  if (/^(https?|ssh|git|file):\/\//.test(input)) return input;
  if (/^[^@\s]+@[^:\s]+:.+/.test(input)) return input;
  if (/^github\.com\/[^\s]+$/.test(input)) return `https://${input}`;
  if (/^github:[^\s]+\/[^\s]+$/.test(input)) return `https://github.com/${input.slice("github:".length)}`;
  if (/\.git(?:[#?].*)?$/.test(input) && !fs.existsSync(path.resolve(input))) return input;
  return undefined;
}

export function installLocalAddon(addonRoot: string, env: NodeJS.ProcessEnv = process.env): InstalledAddon {
  const addon = loadAddonManifest(addonRoot);
  const registry = readRegistry(env);
  registry.addons[addon.id] = { root: addon.root, source: { type: "local" } };
  writeRegistry(registry, env);
  return addon;
}

export function installGitAddon(url: string, options: GitInstallOptions = {}, env: NodeJS.ProcessEnv = process.env): InstalledAddon {
  const home = addonHome(env);
  const tempRoot = path.join(home, "tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = path.join(tempRoot, `git-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  try {
    runGit(["clone", url, tempDir], env);
    if (options.ref) {
      runGit(["-C", tempDir, "checkout", options.ref], env);
    }
    const candidate = loadAddonManifest(tempDir);
    options.validateAddon?.(candidate);

    const targetRoot = path.join(gitSourcesDir(env), candidate.id);
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(tempDir, targetRoot);

    const addon = loadAddonManifest(targetRoot);
    const registry = readRegistry(env);
    registry.addons[addon.id] = {
      root: addon.root,
      source: {
        type: "git",
        url,
        ...(options.ref ? { ref: options.ref } : {})
      }
    };
    writeRegistry(registry, env);
    return addon;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function removeAddon(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const registry = readRegistry(env);
  const entry = registry.addons[id];
  const existed = Object.prototype.hasOwnProperty.call(registry.addons, id);
  if (existed) {
    delete registry.addons[id];
    writeRegistry(registry, env);
    if (entry?.source.type === "git" && isManagedGitSourceRoot(entry.root, env)) {
      fs.rmSync(entry.root, { recursive: true, force: true });
    }
  }
  return existed;
}

export function findInstalledAddon(id: string | undefined, env: NodeJS.ProcessEnv = process.env): InstalledAddon | undefined {
  if (!id) return undefined;
  const root = readRegistry(env).addons[id]?.root;
  if (!root) return undefined;
  return loadRegisteredAddon(id, root);
}

export function findInstalledAddonSafe(id: string | undefined, env: NodeJS.ProcessEnv = process.env): InstalledAddon | undefined {
  try {
    return findInstalledAddon(id, env);
  } catch {
    return undefined;
  }
}

export function findInstalledAddonForRoute(id: string | undefined, env: NodeJS.ProcessEnv = process.env): InstalledAddon | undefined {
  if (!id) return undefined;
  let root: string | undefined;
  try {
    root = readRegistry(env).addons[id]?.root;
  } catch {
    return undefined;
  }
  if (!root) return undefined;
  return loadRegisteredAddon(id, root);
}

export function listInstalledAddons(env: NodeJS.ProcessEnv = process.env): InstalledAddon[] {
  const registry = readRegistry(env);
  return Object.keys(registry.addons)
    .sort()
    .map((id) => loadRegisteredAddon(id, registry.addons[id].root));
}

export function listAddonSummaries(env: NodeJS.ProcessEnv = process.env): AddonSummary[] {
  const registry = readRegistry(env);
  return Object.keys(registry.addons)
    .sort()
    .map((id) => {
      const entry = registry.addons[id];
      const addon = loadRegisteredAddon(id, entry.root);
      return {
        id: addon.id,
        name: addon.manifest.name,
        version: addon.manifest.version,
        root: addon.root,
        source: entry.source
      };
    });
}

export function listAddonSummariesSafe(env: NodeJS.ProcessEnv = process.env): AddonSummary[] {
  try {
    return listAddonSummaries(env);
  } catch {
    return [];
  }
}

function registryPath(env: NodeJS.ProcessEnv): string {
  return path.join(addonHome(env), REGISTRY_FILE);
}

function gitSourcesDir(env: NodeJS.ProcessEnv): string {
  return path.join(addonHome(env), "sources");
}

function readRegistry(env: NodeJS.ProcessEnv): AddonRegistry {
  const file = registryPath(env);
  if (!fs.existsSync(file)) {
    return { version: REGISTRY_VERSION, addons: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Invalid addon registry JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("Addon registry must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== REGISTRY_VERSION) {
    throw new UsageError(`Unsupported addon registry version: ${String(record.version)}`);
  }
  if (!record.addons || typeof record.addons !== "object" || Array.isArray(record.addons)) {
    throw new UsageError("Addon registry must contain an addons object");
  }

  const addons: AddonRegistry["addons"] = {};
  for (const [id, entry] of Object.entries(record.addons as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UsageError(`Invalid addon registry entry: ${id}`);
    }
    const root = (entry as Record<string, unknown>).root;
    if (typeof root !== "string" || root.length === 0) {
      throw new UsageError(`Invalid addon root for registry entry: ${id}`);
    }
    addons[id] = { root, source: parseAddonSource(id, entry as Record<string, unknown>) };
  }

  return { version: REGISTRY_VERSION, addons };
}

function writeRegistry(registry: AddonRegistry, env: NodeJS.ProcessEnv): void {
  const file = registryPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tempFile, file);
}

function loadRegisteredAddon(id: string, root: string): InstalledAddon {
  const addon = loadAddonManifest(root);
  if (addon.id !== id) {
    throw new UsageError(`Addon registry entry ${id} points to addon manifest id ${addon.id}`);
  }
  return addon;
}

function parseAddonSource(id: string, entry: Record<string, unknown>): AddonSource {
  const raw = entry.source;
  if (raw === undefined) return { type: "local" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Invalid addon source for registry entry: ${id}`);
  }
  const source = raw as Record<string, unknown>;
  if (source.type === "local") return { type: "local" };
  if (source.type === "git") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      throw new UsageError(`Invalid git addon url for registry entry: ${id}`);
    }
    if (source.ref !== undefined && (typeof source.ref !== "string" || source.ref.length === 0)) {
      throw new UsageError(`Invalid git addon ref for registry entry: ${id}`);
    }
    return {
      type: "git",
      url: source.url,
      ...(source.ref ? { ref: source.ref } : {})
    };
  }
  throw new UsageError(`Invalid addon source type for registry entry: ${id}`);
}

function runGit(args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
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
}

function isManagedGitSourceRoot(root: string, env: NodeJS.ProcessEnv): boolean {
  const sources = fs.existsSync(gitSourcesDir(env)) ? fs.realpathSync(gitSourcesDir(env)) : path.resolve(gitSourcesDir(env));
  const candidate = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const relative = path.relative(sources, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
