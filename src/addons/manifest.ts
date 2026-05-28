import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";

export const ADDON_MANIFEST_FILE = "optsidian-addon.json";

export type AddonManifest = {
  id: string;
  name: string;
  version: string;
  cli: string;
  mcp?: string;
  obsidianPlugin?: {
    id: string;
    dir: string;
  };
};

export type InstalledAddon = {
  id: string;
  root: string;
  manifestPath: string;
  manifest: AddonManifest;
  cliPath: string;
};

export function loadAddonManifest(addonRoot: string): InstalledAddon {
  const inputRoot = path.resolve(addonRoot);
  if (!fs.existsSync(inputRoot)) {
    throw new UsageError(`Addon path does not exist: ${addonRoot}`);
  }
  if (!fs.statSync(inputRoot).isDirectory()) {
    throw new UsageError(`Addon path is not a directory: ${addonRoot}`);
  }
  const root = fs.realpathSync(inputRoot);
  const manifestPath = path.join(root, ADDON_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new UsageError(`Addon manifest not found: ${manifestPath}`);
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Invalid addon manifest JSON: ${message}`);
  }

  const manifest = validateManifest(parsed);
  validateOptionalManifestPaths(root, manifest);
  const cliPath = resolveManifestPath(root, manifest.cli, "cli");
  if (!fs.existsSync(cliPath)) {
    throw new UsageError(`Addon CLI entrypoint not found: ${cliPath}`);
  }
  if (!fs.statSync(cliPath).isFile()) {
    throw new UsageError(`Addon CLI entrypoint is not a file: ${cliPath}`);
  }
  const realCliPath = fs.realpathSync(cliPath);
  if (!isPathInside(root, realCliPath)) {
    throw new UsageError("Addon CLI entrypoint must stay inside the addon root");
  }

  return {
    id: manifest.id,
    root,
    manifestPath,
    manifest,
    cliPath: realCliPath
  };
}

function validateManifest(value: unknown): AddonManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("Addon manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const id = requireString(record, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new UsageError("Addon id must match /^[a-z][a-z0-9-]*$/");
  }
  const manifest: AddonManifest = {
    id,
    name: requireString(record, "name"),
    version: requireString(record, "version"),
    cli: requireString(record, "cli")
  };

  if (record.mcp !== undefined) {
    manifest.mcp = requireString(record, "mcp");
  }
  if (record.obsidianPlugin !== undefined) {
    if (!record.obsidianPlugin || typeof record.obsidianPlugin !== "object" || Array.isArray(record.obsidianPlugin)) {
      throw new UsageError("Addon obsidianPlugin must be a JSON object");
    }
    const plugin = record.obsidianPlugin as Record<string, unknown>;
    manifest.obsidianPlugin = {
      id: requireString(plugin, "id"),
      dir: requireString(plugin, "dir")
    };
  }

  return manifest;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`Addon manifest requires non-empty string field: ${key}`);
  }
  return value;
}

function resolveManifestPath(root: string, value: string, field: string): string {
  if (path.isAbsolute(value)) {
    throw new UsageError(`Addon manifest field ${field} must be relative to the addon root`);
  }
  const resolved = path.resolve(root, value);
  if (!isPathInside(root, resolved)) {
    throw new UsageError(`Addon manifest field ${field} must stay inside the addon root`);
  }
  return resolved;
}

function validateOptionalManifestPaths(root: string, manifest: AddonManifest): void {
  if (manifest.mcp !== undefined) {
    resolveManifestPath(root, manifest.mcp, "mcp");
  }
  if (manifest.obsidianPlugin !== undefined) {
    resolveManifestPath(root, manifest.obsidianPlugin.dir, "obsidianPlugin.dir");
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
