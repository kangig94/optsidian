import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PRIVATE_FILE_MODE, ensureExistingPrivateFileSync, ensurePrivateDirSync, writePrivateFileAtomicSync } from "../core/private-path.js";
import { RuntimeError } from "../errors.js";
import { DEFAULT_HTTP_RESPONSE_MAX_BYTES, formatByteSize } from "../limits.js";
import { OPTSIDIAN_VERSION } from "../version.js";

// Shared GitHub HTTP layer: a small GET that tolerates redirects and proxy environments
// (curl fallback) and carries a GitHub Accept header. Callers opt into auth when they need
// a token resolved from GITHUB_TOKEN or the user's local `gh`/`git` login.

const JSON_ACCEPT = "application/vnd.github+json";
// Release-asset bytes must be fetched from the API asset endpoint with an octet-stream Accept;
// that is the only form that works for a PRIVATE repo (browser_download_url 404s there).
const ASSET_ACCEPT = "application/octet-stream";

type FetchOptions = { accept?: string; redirects?: number; sendAuth?: boolean; timeoutMs?: number; maxBytes?: number };

export async function fetchJson(url: string, env: NodeJS.ProcessEnv, options: FetchOptions = {}): Promise<unknown> {
  const response = await requestBuffer(url, env, options);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new RuntimeError("Release metadata payload is invalid");
  }
}

export async function downloadFile(
  url: string,
  targetPath: string,
  env: NodeJS.ProcessEnv,
  options: Pick<FetchOptions, "sendAuth" | "timeoutMs" | "maxBytes"> = {}
): Promise<void> {
  const response = await requestBuffer(url, env, { accept: ASSET_ACCEPT, ...options });
  writePrivateFileAtomicSync(targetPath, response.body, "Optsidian download file");
}

export async function downloadFileStreaming(
  url: string,
  targetPath: string,
  env: NodeJS.ProcessEnv,
  options: Pick<FetchOptions, "accept" | "sendAuth" | "timeoutMs" | "maxBytes" | "redirects"> = {}
): Promise<void> {
  const accept = options.accept ?? ASSET_ACCEPT;
  const redirects = options.redirects ?? 0;
  const sendAuth = options.sendAuth ?? true;
  const maxBytes = options.maxBytes ?? DEFAULT_HTTP_RESPONSE_MAX_BYTES;
  if (hasProxyEnv(env)) {
    if (!hasCommand("curl", env)) {
      throw new RuntimeError("Proxy environment detected, but curl is not available for optsidian network access.");
    }
    await downloadFileStreamingWithCurl(url, targetPath, env, accept, sendAuth, redirects, maxBytes, options.timeoutMs);
    return;
  }
  await downloadFileStreamingDirect(url, targetPath, env, { accept, redirects, sendAuth, maxBytes, timeoutMs: options.timeoutMs });
}

export async function requestBuffer(
  url: string,
  env: NodeJS.ProcessEnv,
  options: FetchOptions = {}
): Promise<{ statusCode: number; body: Buffer }> {
  const accept = options.accept ?? JSON_ACCEPT;
  const redirects = options.redirects ?? 0;
  const sendAuth = options.sendAuth ?? true;
  const maxBytes = options.maxBytes ?? DEFAULT_HTTP_RESPONSE_MAX_BYTES;
  if (hasProxyEnv(env)) {
    if (!hasCommand("curl", env)) {
      throw new RuntimeError("Proxy environment detected, but curl is not available for optsidian network access.");
    }
    // curl -fsSL drops Authorization on a cross-host redirect by default, so an asset's
    // signed CDN URL is reached without our token.
    return requestBufferWithCurl(url, env, accept, sendAuth, redirects, maxBytes, options.timeoutMs);
  }
  return requestBufferDirect(url, env, { accept, redirects, sendAuth, maxBytes, timeoutMs: options.timeoutMs });
}

async function requestBufferDirect(
  url: string,
  env: NodeJS.ProcessEnv,
  options: Required<Omit<FetchOptions, "timeoutMs">> & { timeoutMs?: number }
): Promise<{ statusCode: number; body: Buffer }> {
  const { accept, redirects, sendAuth, maxBytes, timeoutMs } = options;
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
          headers: githubHeaders(env, accept, sendAuth, credentialHostForUrl(target)),
          agent: false
        },
        (res) => {
          let settled = false;
          let totalBytes = 0;
          const chunks: Buffer[] = [];
          const contentLength = parseContentLength(res.headers);
          if (contentLength !== undefined && contentLength > maxBytes) {
            const error = responseTooLargeError(url, maxBytes, contentLength);
            settled = true;
            res.resume();
            request.destroy(error);
            reject(error);
            return;
          }
          res.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
              const error = responseTooLargeError(url, maxBytes, totalBytes);
              settled = true;
              res.destroy(error);
              request.destroy(error);
              reject(error);
              return;
            }
            chunks.push(buffer);
          });
          res.on("end", () => {
            if (settled) return;
            settled = true;
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks)
            });
          });
          res.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      );
      if (timeoutMs !== undefined) {
        request.setTimeout(timeoutMs, () => {
          request.destroy(new RuntimeError(`Timed out fetching ${url}`));
        });
      }
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
      sendAuth: sendAuth && nextUrl.host === target.host,
      maxBytes,
      timeoutMs
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

async function downloadFileStreamingDirect(
  url: string,
  targetPath: string,
  env: NodeJS.ProcessEnv,
  options: Required<Omit<FetchOptions, "timeoutMs">> & { timeoutMs?: number }
): Promise<void> {
  const { accept, redirects, sendAuth, maxBytes, timeoutMs } = options;
  if (redirects > 5) {
    throw new RuntimeError(`Too many redirects while fetching ${url}`);
  }

  const target = new URL(url);
  const requestImpl = target.protocol === "https:" ? https.request : http.request;
  const output = prepareStreamingTarget(targetPath);
  let keepOutput = false;
  try {
    const redirect = await new Promise<string | undefined>((resolve, reject) => {
      const request = requestImpl(
        target,
        {
          method: "GET",
          headers: githubHeaders(env, accept, sendAuth, credentialHostForUrl(target)),
          agent: false
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const location = res.headers.location;
            res.resume();
            if (typeof location !== "string" || location.length === 0) {
              reject(new RuntimeError(`Redirect response from ${url} did not include a location header`));
              return;
            }
            resolve(new URL(location, target).toString());
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            res.resume();
            reject(new RuntimeError(`Failed to fetch ${url} (${statusCode})`));
            return;
          }
          const contentLength = parseContentLength(res.headers);
          if (contentLength !== undefined && contentLength > maxBytes) {
            const error = responseTooLargeError(url, maxBytes, contentLength);
            res.resume();
            reject(error);
            return;
          }
          let settled = false;
          let totalBytes = 0;
          const stream = fs.createWriteStream(output.tmpPath, { fd: output.fd, autoClose: true });
          output.fd = undefined;
          res.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
              settled = true;
              const error = responseTooLargeError(url, maxBytes, totalBytes);
              res.destroy(error);
              stream.destroy(error);
            }
          });
          res.on("error", (error) => {
            if (settled) return;
            settled = true;
            stream.destroy(error);
          });
          stream.on("error", (error) => {
            if (settled) {
              reject(error);
              return;
            }
            settled = true;
            reject(error);
          });
          stream.on("finish", () => {
            if (settled) return;
            settled = true;
            resolve(undefined);
          });
          res.pipe(stream);
        }
      );
      if (timeoutMs !== undefined) {
        request.setTimeout(timeoutMs, () => {
          request.destroy(new RuntimeError(`Timed out fetching ${url}`));
        });
      }
      request.on("error", reject);
      request.end();
    });
    if (redirect) {
      fs.rmSync(output.tmpPath, { force: true });
      const nextUrl = new URL(redirect);
      await downloadFileStreamingDirect(redirect, targetPath, env, {
        accept,
        redirects: redirects + 1,
        sendAuth: sendAuth && nextUrl.host === target.host,
        maxBytes,
        timeoutMs
      });
      return;
    }
    fs.renameSync(output.tmpPath, path.resolve(targetPath));
    fs.chmodSync(path.resolve(targetPath), PRIVATE_FILE_MODE);
    keepOutput = true;
  } finally {
    if (output.fd !== undefined) fs.closeSync(output.fd);
    if (!keepOutput) fs.rmSync(output.tmpPath, { force: true });
  }
}

async function requestBufferWithCurl(
  url: string,
  env: NodeJS.ProcessEnv,
  accept: string,
  sendAuth: boolean,
  redirects: number,
  maxBytes: number,
  timeoutMs?: number
): Promise<{ statusCode: number; body: Buffer }> {
  if (redirects > 5) {
    throw new RuntimeError(`Too many redirects while fetching ${url}`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `optsidian-curl-${process.pid}-`));
  ensurePrivateDirSync(tempDir, "Optsidian curl temp directory");
  const headerPath = path.join(tempDir, "headers");
  const bodyPath = path.join(tempDir, "body");
  try {
    const args = [
      "-sS",
      "-D",
      headerPath,
      "-o",
      bodyPath,
      "--max-filesize",
      String(maxBytes),
      "-H",
      `Accept: ${accept}`,
      "-H",
      `User-Agent: optsidian/${OPTSIDIAN_VERSION}`
    ];
    if (timeoutMs !== undefined) {
      args.push("--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
    }
    const target = new URL(url);
    const token = sendAuth ? resolveGithubToken(env, credentialHostForUrl(target)) : undefined;
    if (token) {
      args.push("-H", `Authorization: Bearer ${token}`);
    }
    args.push(url);
    const result = spawnSync("curl", args, { env });
    if (result.error) {
      throw new RuntimeError(`Failed to execute curl: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      if (result.status === 63) {
        throw responseTooLargeError(url, maxBytes);
      }
      const message = (result.stderr || result.stdout || Buffer.from("curl failed")).toString("utf8").trim();
      throw new RuntimeError(message || `Failed to fetch ${url}`);
    }

    const headers = ensureExistingPrivateFileSync(headerPath, "Optsidian curl header file") ? fs.readFileSync(headerPath, "utf8") : "";
    const statusCode = curlStatusCode(headers);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = curlLocation(headers);
      if (!location) {
        throw new RuntimeError(`Redirect response from ${url} did not include a location header`);
      }
      const nextUrl = new URL(location, target);
      return requestBuffer(nextUrl.toString(), env, {
        accept,
        redirects: redirects + 1,
        sendAuth: sendAuth && nextUrl.host === target.host,
        maxBytes,
        timeoutMs
      });
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new RuntimeError(`Failed to fetch ${url} (${statusCode})`);
    }
    return {
      statusCode,
      body: readDownloadedBody(bodyPath, url, maxBytes)
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function downloadFileStreamingWithCurl(
  url: string,
  targetPath: string,
  env: NodeJS.ProcessEnv,
  accept: string,
  sendAuth: boolean,
  redirects: number,
  maxBytes: number,
  timeoutMs?: number
): Promise<void> {
  if (redirects > 5) {
    throw new RuntimeError(`Too many redirects while fetching ${url}`);
  }
  const output = prepareStreamingTarget(targetPath);
  if (output.fd !== undefined) fs.closeSync(output.fd);
  output.fd = undefined;
  const headerPath = `${output.tmpPath}.headers`;
  try {
    const args = [
      "-sS",
      "-D",
      headerPath,
      "-o",
      output.tmpPath,
      "--max-filesize",
      String(maxBytes),
      "-H",
      `Accept: ${accept}`,
      "-H",
      `User-Agent: optsidian/${OPTSIDIAN_VERSION}`
    ];
    if (timeoutMs !== undefined) {
      args.push("--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
    }
    const target = new URL(url);
    const token = sendAuth ? resolveGithubToken(env, credentialHostForUrl(target)) : undefined;
    if (token) {
      args.push("-H", `Authorization: Bearer ${token}`);
    }
    args.push(url);
    const result = spawnSync("curl", args, { env });
    if (result.error) {
      throw new RuntimeError(`Failed to execute curl: ${result.error.message}`);
    }
    if ((result.status ?? 1) !== 0) {
      if (result.status === 63) {
        throw responseTooLargeError(url, maxBytes);
      }
      const message = (result.stderr || result.stdout || Buffer.from("curl failed")).toString("utf8").trim();
      throw new RuntimeError(message || `Failed to fetch ${url}`);
    }

    const headers = ensureExistingPrivateFileSync(headerPath, "Optsidian curl header file") ? fs.readFileSync(headerPath, "utf8") : "";
    const statusCode = curlStatusCode(headers);
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = curlLocation(headers);
      if (!location) {
        throw new RuntimeError(`Redirect response from ${url} did not include a location header`);
      }
      fs.rmSync(output.tmpPath, { force: true });
      const nextUrl = new URL(location, target);
      await downloadFileStreamingWithCurl(
        nextUrl.toString(),
        targetPath,
        env,
        accept,
        sendAuth && nextUrl.host === target.host,
        redirects + 1,
        maxBytes,
        timeoutMs
      );
      return;
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new RuntimeError(`Failed to fetch ${url} (${statusCode})`);
    }
    const stat = fs.statSync(output.tmpPath);
    if (stat.size > maxBytes) throw responseTooLargeError(url, maxBytes, stat.size);
    fs.renameSync(output.tmpPath, path.resolve(targetPath));
    fs.chmodSync(path.resolve(targetPath), PRIVATE_FILE_MODE);
  } finally {
    fs.rmSync(headerPath, { force: true });
    fs.rmSync(output.tmpPath, { force: true });
  }
}

function prepareStreamingTarget(targetPath: string): { tmpPath: string; fd: number | undefined } {
  const target = path.resolve(targetPath);
  const dir = path.dirname(target);
  ensurePrivateDirSync(dir, "Optsidian download file parent directory");
  const tmpPath = path.join(dir, `.optsidian-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.download`);
  const fd = fs.openSync(tmpPath, "wx", PRIVATE_FILE_MODE);
  return { tmpPath, fd };
}

function readDownloadedBody(bodyPath: string, url: string, maxBytes: number): Buffer {
  if (!ensureExistingPrivateFileSync(bodyPath, "Optsidian curl body file")) return Buffer.alloc(0);
  const stat = fs.statSync(bodyPath);
  if (stat.size > maxBytes) {
    throw responseTooLargeError(url, maxBytes, stat.size);
  }
  return fs.readFileSync(bodyPath);
}

function parseContentLength(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function responseTooLargeError(url: string, maxBytes: number, actualBytes?: number): RuntimeError {
  const actual = actualBytes === undefined ? "" : ` (${formatByteSize(actualBytes)})`;
  return new RuntimeError(`Response from ${url} exceeded ${formatByteSize(maxBytes)} limit${actual}`);
}

function curlStatusCode(headers: string): number {
  const matches = [...headers.matchAll(/^HTTP\/\S+\s+(\d{3})\b/gim)];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : 0;
}

function curlLocation(headers: string): string | undefined {
  const blocks = headers.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+\s+\d{3}\b/im.test(block));
  const last = blocks.at(-1) ?? headers;
  const match = /^location:\s*(.+)$/im.exec(last);
  return match?.[1]?.trim();
}

function githubHeaders(env: NodeJS.ProcessEnv, accept: string, sendAuth: boolean, credentialHost: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": `optsidian/${OPTSIDIAN_VERSION}`,
    Connection: "close"
  };
  const token = sendAuth ? resolveGithubToken(env, credentialHost) : undefined;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Explicit GITHUB_TOKEN wins; otherwise fall back to the user's local login via `gh auth
// token` or `git credential fill`. The local lookup runs at most once per host per process.
const cachedLocalTokens = new Map<string, string | null>();

function resolveGithubToken(env: NodeJS.ProcessEnv, credentialHost: string): string | undefined {
  const explicit = env.GITHUB_TOKEN?.trim();
  if (explicit) return explicit;
  const host = credentialHost || "github.com";
  if (!cachedLocalTokens.has(host)) {
    cachedLocalTokens.set(host, readLocalGithubToken(env, host));
  }
  return cachedLocalTokens.get(host) ?? undefined;
}

function readLocalGithubToken(env: NodeJS.ProcessEnv, credentialHost: string): string | null {
  const credentialEnv = nonInteractiveCredentialEnv(env);
  const ghArgs = credentialHost === "github.com" ? ["auth", "token"] : ["auth", "token", "--hostname", credentialHost];
  const gh = spawnSync("gh", ghArgs, { env: credentialEnv, encoding: "utf8" });
  if (!gh.error && (gh.status ?? 1) === 0) {
    const token = (gh.stdout ?? "").trim();
    if (token) return token;
  }
  const cred = spawnSync("git", ["credential", "fill"], {
    env: credentialEnv,
    encoding: "utf8",
    input: `protocol=https\nhost=${credentialHost}\n\n`
  });
  if (!cred.error && (cred.status ?? 1) === 0) {
    const match = /^password=(.+)$/m.exec(cred.stdout ?? "");
    const token = match?.[1]?.trim();
    if (token) return token;
  }
  return null;
}

function nonInteractiveCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GCM_INTERACTIVE: "Never",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function credentialHostForUrl(url: URL): string {
  if (url.hostname.toLowerCase() === "api.github.com") return "github.com";
  return url.host || url.hostname;
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const searchPath = env.PATH ? env.PATH : process.env.PATH ? process.env.PATH : "";
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
