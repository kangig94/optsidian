import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { RuntimeError } from "../errors.js";
import { OPTSIDIAN_VERSION } from "../version.js";

// Shared GitHub HTTP layer: a small GET that tolerates redirects and proxy environments
// (curl fallback) and carries a GitHub Accept header + a token resolved from GITHUB_TOKEN or
// the user's local `gh`/`git` login. Used by the self-updater and custom plugin release
// installs, including PRIVATE repos.

const JSON_ACCEPT = "application/vnd.github+json";
// Release-asset bytes must be fetched from the API asset endpoint with an octet-stream Accept;
// that is the only form that works for a PRIVATE repo (browser_download_url 404s there).
const ASSET_ACCEPT = "application/octet-stream";

type FetchOptions = { accept?: string; redirects?: number; sendAuth?: boolean };

export async function fetchJson(url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const response = await requestBuffer(url, env);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new RuntimeError("Release metadata payload is invalid");
  }
}

export async function downloadFile(url: string, targetPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const response = await requestBuffer(url, env, { accept: ASSET_ACCEPT });
  const tmpPath = `${targetPath}.download-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, response.body);
  fs.renameSync(tmpPath, targetPath);
}

export async function requestBuffer(
  url: string,
  env: NodeJS.ProcessEnv,
  options: FetchOptions = {}
): Promise<{ statusCode: number; body: Buffer }> {
  const accept = options.accept ?? JSON_ACCEPT;
  const redirects = options.redirects ?? 0;
  const sendAuth = options.sendAuth ?? true;
  if (hasProxyEnv(env)) {
    if (!hasCommand("curl", env)) {
      throw new RuntimeError("Proxy environment detected, but curl is not available for optsidian network access.");
    }
    // curl -fsSL drops Authorization on a cross-host redirect by default, so an asset's
    // signed CDN URL is reached without our token.
    return requestBufferWithCurl(url, env, accept, sendAuth);
  }
  return requestBufferDirect(url, env, { accept, redirects, sendAuth });
}

async function requestBufferDirect(
  url: string,
  env: NodeJS.ProcessEnv,
  options: Required<FetchOptions>
): Promise<{ statusCode: number; body: Buffer }> {
  const { accept, redirects, sendAuth } = options;
  if (redirects > 5) {
    throw new RuntimeError(`Too many redirects while fetching ${url}`);
  }

  const target = new URL(url);
  const requestImpl = target.protocol === "https:" ? https.request : http.request;
  const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const request = requestImpl(
        target,
        {
          method: "GET",
          headers: githubHeaders(env, accept, sendAuth),
          agent: false
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
          res.on("error", reject);
        }
      );
      request.on("error", reject);
      request.end();
    }
  );

  const statusCode = response.statusCode;
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    const location = response.headers.location;
    if (typeof location !== "string" || location.length === 0) {
      throw new RuntimeError(`Redirect response from ${url} did not include a location header`);
    }
    const nextUrl = new URL(location, target);
    // Never carry Authorization across a host change: a release asset's API URL redirects
    // to a signed CDN URL that rejects a second auth mechanism.
    return requestBuffer(nextUrl.toString(), env, {
      accept,
      redirects: redirects + 1,
      sendAuth: sendAuth && nextUrl.host === target.host
    });
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new RuntimeError(`Failed to fetch ${url} (${statusCode})`);
  }

  return {
    statusCode,
    body: response.body
  };
}

async function requestBufferWithCurl(
  url: string,
  env: NodeJS.ProcessEnv,
  accept: string,
  sendAuth: boolean
): Promise<{ statusCode: number; body: Buffer }> {
  const args = ["-fsSL", "-H", `Accept: ${accept}`, "-H", `User-Agent: optsidian/${OPTSIDIAN_VERSION}`];
  const token = sendAuth ? resolveGithubToken(env) : undefined;
  if (token) {
    args.push("-H", `Authorization: Bearer ${token}`);
  }
  args.push(url);
  const result = spawnSync("curl", args, {
    env
  });
  if (result.error) {
    throw new RuntimeError(`Failed to execute curl: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const message = (result.stderr || result.stdout || Buffer.from("curl failed")).toString("utf8").trim();
    throw new RuntimeError(message || `Failed to fetch ${url}`);
  }
  return {
    statusCode: 200,
    body: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  };
}

function githubHeaders(env: NodeJS.ProcessEnv, accept: string, sendAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": `optsidian/${OPTSIDIAN_VERSION}`,
    Connection: "close"
  };
  const token = sendAuth ? resolveGithubToken(env) : undefined;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Explicit GITHUB_TOKEN wins; otherwise fall back to the user's local login via `gh auth
// token` or `git credential fill`, so a private-repo release install works without manually
// exporting a token. The local lookup runs at most once per process.
let cachedLocalToken: string | null | undefined;

function resolveGithubToken(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.GITHUB_TOKEN?.trim();
  if (explicit) return explicit;
  if (cachedLocalToken === undefined) {
    cachedLocalToken = readLocalGithubToken(env);
  }
  return cachedLocalToken ?? undefined;
}

function readLocalGithubToken(env: NodeJS.ProcessEnv): string | null {
  const gh = spawnSync("gh", ["auth", "token"], { env, encoding: "utf8" });
  if (!gh.error && (gh.status ?? 1) === 0) {
    const token = (gh.stdout ?? "").trim();
    if (token) return token;
  }
  const cred = spawnSync("git", ["credential", "fill"], {
    env,
    encoding: "utf8",
    input: "protocol=https\nhost=github.com\n\n"
  });
  if (!cred.error && (cred.status ?? 1) === 0) {
    const match = /^password=(.+)$/m.exec(cred.stdout ?? "");
    const token = match?.[1]?.trim();
    if (token) return token;
  }
  return null;
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const searchPath = env.PATH || process.env.PATH || "";
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
