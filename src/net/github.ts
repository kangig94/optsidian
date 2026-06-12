import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { RuntimeError } from "../errors.js";
import { OPTSIDIAN_VERSION } from "../version.js";

// Shared GitHub HTTP layer: a small GET that tolerates redirects and proxy
// environments (curl fallback) and carries the GitHub Accept header + optional
// GITHUB_TOKEN. Used by both the self-updater and custom plugin release installs.

export async function fetchJson(url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const response = await requestBuffer(url, env);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new RuntimeError("Release metadata payload is invalid");
  }
}

export async function downloadFile(url: string, targetPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const response = await requestBuffer(url, env);
  const tmpPath = `${targetPath}.download-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, response.body);
  fs.renameSync(tmpPath, targetPath);
}

export async function requestBuffer(
  url: string,
  env: NodeJS.ProcessEnv,
  redirects = 0
): Promise<{ statusCode: number; body: Buffer }> {
  if (hasProxyEnv(env)) {
    if (!hasCommand("curl", env)) {
      throw new RuntimeError("Proxy environment detected, but curl is not available for optsidian network access.");
    }
    return requestBufferWithCurl(url, env);
  }
  return requestBufferDirect(url, env, redirects);
}

async function requestBufferDirect(
  url: string,
  env: NodeJS.ProcessEnv,
  redirects = 0
): Promise<{ statusCode: number; body: Buffer }> {
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
          headers: githubHeaders(env),
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
    return requestBuffer(new URL(location, target).toString(), env, redirects + 1);
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new RuntimeError(`Failed to fetch ${url} (${statusCode})`);
  }

  return {
    statusCode,
    body: response.body
  };
}

async function requestBufferWithCurl(url: string, env: NodeJS.ProcessEnv): Promise<{ statusCode: number; body: Buffer }> {
  const args = ["-fsSL", "-H", "Accept: application/vnd.github+json", "-H", `User-Agent: optsidian/${OPTSIDIAN_VERSION}`];
  if (env.GITHUB_TOKEN) {
    args.push("-H", `Authorization: Bearer ${env.GITHUB_TOKEN}`);
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

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `optsidian/${OPTSIDIAN_VERSION}`,
    Connection: "close"
  };
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
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
