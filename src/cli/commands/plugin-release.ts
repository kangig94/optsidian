import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadFile, fetchJson } from "../../net/github.js";

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

// An Obsidian plugin release ships these flat assets. manifest.json + main.js are
// required (loadPluginManifest enforces them); styles.css is optional.
const PLUGIN_ASSET_NAMES = ["manifest.json", "main.js", "styles.css"] as const;
const REQUIRED_ASSET_NAMES = ["manifest.json", "main.js"] as const;

const HTTP_OR_SSH_GITHUB = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SCP_GITHUB = /^[^@\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function githubApiBase(env: NodeJS.ProcessEnv): string {
  return (env.OPTSIDIAN_GITHUB_API_BASE || DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "");
}

// Extracts owner/repo from a normalized GitHub URL (https, ssh, or scp-like). Returns
// undefined for non-GitHub hosts, which signals the caller to clone instead.
export function parseGithubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = HTTP_OR_SSH_GITHUB.exec(url) ?? SCP_GITHUB.exec(url);
  if (!match) return undefined;
  const [, owner, repo] = match;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

type ReleasePlugin = { tag: string; dir: string };

// Tries to install from a published GitHub release. Returns the temp dir holding the
// downloaded plugin assets (caller owns cleanup), or null when no usable release exists
// — a missing release, a draft, or absent required assets — so the caller falls back to
// the git clone. A release that exists but whose asset download fails is a hard error.
export async function fetchReleasePlugin(options: {
  owner: string;
  repo: string;
  tag?: string;
  env: NodeJS.ProcessEnv;
}): Promise<ReleasePlugin | null> {
  const { owner, repo, tag, env } = options;
  const base = githubApiBase(env);
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const endpoint = tag
    ? `${base}/repos/${repoPath}/releases/tags/${encodeURIComponent(tag)}`
    : `${base}/repos/${repoPath}/releases/latest`;

  let payload: unknown;
  try {
    payload = await fetchJson(endpoint, env);
  } catch {
    // No published release (404), network failure, or invalid payload: fall back to the
    // git clone, which finds the plugin at the repo root (or dir=).
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const release = payload as Record<string, unknown>;
  if (release.draft === true) return null;

  const assets = readReleaseAssets(release);
  if (!REQUIRED_ASSET_NAMES.every((name) => assets.has(name))) return null;

  const releaseTag = typeof release.tag_name === "string" && release.tag_name.length > 0 ? release.tag_name : (tag ?? "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `optsidian-plugin-release-${process.pid}-`));
  try {
    for (const name of PLUGIN_ASSET_NAMES) {
      const downloadUrl = assets.get(name);
      if (downloadUrl) {
        await downloadFile(downloadUrl, path.join(dir, name), env);
      }
    }
    return { tag: releaseTag, dir };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function readReleaseAssets(release: Record<string, unknown>): Map<string, string> {
  const assets = new Map<string, string>();
  const list = Array.isArray(release.assets) ? release.assets : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const asset = item as Record<string, unknown>;
    // Prefer the API asset URL (works for private repos with octet-stream Accept); fall back
    // to browser_download_url for hosts that only expose it.
    const downloadUrl = typeof asset.url === "string"
      ? asset.url
      : typeof asset.browser_download_url === "string"
        ? asset.browser_download_url
        : undefined;
    if (typeof asset.name === "string" && downloadUrl) {
      assets.set(asset.name, downloadUrl);
    }
  }
  return assets;
}
