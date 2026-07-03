import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadFile, fetchJson } from '../../net/github.js';

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

// An Obsidian plugin release ships these flat assets. manifest.json + main.js are
// required (loadPluginManifest enforces them); styles.css is optional.
const PLUGIN_ASSET_NAMES = ['manifest.json', 'main.js', 'styles.css'] as const;
const REQUIRED_ASSET_NAMES = ['manifest.json', 'main.js'] as const;

const SCP_GIT_REPO = /^[^@\s]+@([^:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

type GithubRepo = {
  host: string;
  owner: string;
  repo: string;
  apiProtocol: 'http' | 'https';
};

function githubApiBase(env: NodeJS.ProcessEnv, repo: Pick<GithubRepo, 'host' | 'apiProtocol'>): string {
  const override = env.OPTSIDIAN_GITHUB_API_BASE;
  if (override) return override.replace(/\/+$/, '');
  if (isGithubDotCom(repo.host)) return DEFAULT_GITHUB_API_BASE;
  return `${repo.apiProtocol}://${repo.host}/api/v3`;
}

// Extracts host/owner/repo from a normalized GitHub-compatible URL (https, ssh, git,
// or scp-like). Any host is allowed: GitHub Enterprise uses the same releases API
// shape under /api/v3. If that API is not present, the caller falls back to clone.
export function parseGithubRepo(url: string): GithubRepo | undefined {
  const parsed = parseUrlRepo(url) ?? parseScpRepo(url);
  if (!parsed || !parsed.owner || !parsed.repo || !parsed.host) return undefined;
  return parsed;
}

type ReleasePlugin = { tag: string; dir: string };

// Tries to install from a published GitHub release. Auth is opt-in because url=
// accepts GitHub-compatible hosts. Returns the temp dir holding the
// downloaded plugin assets (caller owns cleanup), or null when no usable release exists
// — a missing release, a draft, or absent required assets — so the caller falls back to
// the git clone. A release that exists but whose asset download fails is a hard error.
export async function fetchReleasePlugin(options: {
  host: string;
  owner: string;
  repo: string;
  apiProtocol: 'http' | 'https';
  tag?: string;
  auth?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<ReleasePlugin | null> {
  const { host, owner, repo, apiProtocol, tag, env } = options;
  const sendAuth = options.auth === true;
  const base = githubApiBase(env, { host, apiProtocol });
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const endpoint = tag
    ? `${base}/repos/${repoPath}/releases/tags/${encodeURIComponent(tag)}`
    : `${base}/repos/${repoPath}/releases/latest`;

  let payload: unknown;
  try {
    payload = await fetchJson(endpoint, env, { sendAuth });
  } catch {
    // No published release (404), network failure, or invalid payload: fall back to the
    // git clone, which finds the plugin at the repo root (or dir=).
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  const release = payload as Record<string, unknown>;
  if (release.draft === true) return null;

  const assets = readReleaseAssets(release);
  if (!REQUIRED_ASSET_NAMES.every((name) => assets.has(name))) return null;

  const releaseTag =
    typeof release.tag_name === 'string' && release.tag_name.length > 0 ? release.tag_name : (tag ?? '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `optsidian-plugin-release-${process.pid}-`));
  try {
    for (const name of PLUGIN_ASSET_NAMES) {
      const downloadUrl = assets.get(name);
      if (downloadUrl) {
        await downloadFile(downloadUrl, path.join(dir, name), env, {
          sendAuth: shouldAuthenticateAssetDownload(endpoint, downloadUrl, sendAuth),
        });
      }
    }
    return { tag: releaseTag, dir };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function parseUrlRepo(input: string): GithubRepo | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return undefined;
  const [owner, rawRepo] = parts;
  const repo = stripGitSuffix(rawRepo ?? '');
  if (!owner || !repo) return undefined;
  const host = url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.hostname;
  return {
    host,
    owner,
    repo,
    apiProtocol: url.protocol === 'http:' ? 'http' : 'https',
  };
}

function parseScpRepo(input: string): GithubRepo | undefined {
  const match = SCP_GIT_REPO.exec(input);
  if (!match) return undefined;
  const [, host, owner, rawRepo] = match;
  const repo = stripGitSuffix(rawRepo ?? '');
  if (!host || !owner || !repo) return undefined;
  return { host, owner, repo, apiProtocol: 'https' };
}

function stripGitSuffix(input: string): string {
  return input.endsWith('.git') ? input.slice(0, -'.git'.length) : input;
}

function isGithubDotCom(host: string): boolean {
  return host.toLowerCase() === 'github.com' || host.toLowerCase() === 'www.github.com';
}

function shouldAuthenticateAssetDownload(endpoint: string, downloadUrl: string, sendAuth: boolean): boolean {
  if (!sendAuth) return false;
  try {
    const endpointUrl = new URL(endpoint);
    const assetUrl = new URL(downloadUrl, endpointUrl);
    return credentialHostForReleaseUrl(assetUrl) === credentialHostForReleaseUrl(endpointUrl);
  } catch {
    return false;
  }
}

function credentialHostForReleaseUrl(url: URL): string {
  if (url.hostname.toLowerCase() === 'api.github.com') return 'github.com';
  return url.host || url.hostname;
}

function readReleaseAssets(release: Record<string, unknown>): Map<string, string> {
  const assets = new Map<string, string>();
  const list = Array.isArray(release.assets) ? release.assets : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const asset = item as Record<string, unknown>;
    // Prefer the API asset URL (works for private repos with octet-stream Accept); fall back
    // to browser_download_url for hosts that only expose it.
    const downloadUrl =
      typeof asset.url === 'string'
        ? asset.url
        : typeof asset.browser_download_url === 'string'
          ? asset.browser_download_url
          : undefined;
    if (typeof asset.name === 'string' && downloadUrl) {
      assets.set(asset.name, downloadUrl);
    }
  }
  return assets;
}
