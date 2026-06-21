import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeError, UsageError } from "../errors.js";
import { readOptsidianSettings, type OptsidianSettings } from "./settings.js";

export type SearchAnalyzerIdentity = {
  name: string;
  version: string;
  baseline?: string;
  runtime?: string;
  node: string;
  icu?: string;
  model?: string;
  optionsHash?: string;
  declaredAnalyzers?: string[];
  activeAnalyzers?: string[];
};

export type SearchAnalyzer = {
  identity: SearchAnalyzerIdentity;
  tokenize(text: string): Promise<string[]>;
  tokenizeBatch(texts: readonly string[]): Promise<string[][]>;
};

type AnalyzerRequest = {
  id: number;
  method: "tokenizeBatch";
  params: {
    analyzer: SearchAnalyzerSelector;
    texts: string[];
  };
};

type SearchAnalyzerSelector = {
  name: string;
  version?: string;
  model?: string;
  optionsHash?: string;
  declaredAnalyzers?: string[];
  activeAnalyzers?: string[];
};

type AnalyzerResponse =
  | { id: number; result: { analyzer: SearchAnalyzerIdentity; tokens: string[][] } }
  | { id: number; error: { message: string } };

export type SearchDeclaredAnalyzer = "ko";

export const SEARCH_EXTRA_LANGS_ENV = "OPTSIDIAN_SEARCH_EXTRA_LANGS";

const ROUTER_VERSION = "script-router-v2";
const INTL_ANALYZER_VERSION = "intl-segmenter-latin-v2";
const DAEMON_PROTOCOL_VERSION = "v2";
const ANALYZER_MODE_ENV = "OPTSIDIAN_SEARCH_ANALYZER";
const ANALYZER_IDLE_ENV = "OPTSIDIAN_ANALYZER_IDLE_MS";
const ANALYZER_REQUEST_TIMEOUT_ENV = "OPTSIDIAN_ANALYZER_REQUEST_TIMEOUT_MS";
const ANALYZER_BIN_ENV = "OPTSIDIAN_ANALYZER_DAEMON_BIN";
const REGISTERED_ANALYZERS = ["ko"] as const satisfies readonly SearchDeclaredAnalyzer[];
const REGISTERED_ANALYZER_SET: ReadonlySet<string> = new Set(REGISTERED_ANALYZERS);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const STARTUP_TIMEOUT_MS = 2000;
const WORD_SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const COMBINING_MARKS_PATTERN = /\p{Mark}/gu;
const ASCII_ALPHA_PATTERN = /^[a-z]+$/;

let requestId = 0;

export function resolveSearchAnalyzer(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env)
): SearchAnalyzer {
  const mode = searchAnalyzerMode(env, settings);
  const declaredAnalyzers = parseDeclaredSearchAnalyzers(searchExtraLangsValue(env, settings));
  if (mode === "intl") return createRouterAnalyzer(declaredAnalyzers);
  if (mode === "intl-daemon") return createDaemonAnalyzer(env, settings, declaredAnalyzers);
  if (mode === "kiwi") {
    throw new UsageError(`${ANALYZER_MODE_ENV}=kiwi is not available. Use ${SEARCH_EXTRA_LANGS_ENV}=ko after a Korean analyzer backend is added.`);
  }
  throw new UsageError(`${ANALYZER_MODE_ENV} must be one of: intl, intl-daemon`);
}

function searchAnalyzerMode(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string {
  const raw = env[ANALYZER_MODE_ENV] ?? settings.search?.analyzer ?? "intl";
  const mode = raw.trim().toLowerCase();
  return mode === "daemon-intl" ? "intl-daemon" : mode;
}

function searchExtraLangsValue(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string | undefined {
  if (env[SEARCH_EXTRA_LANGS_ENV] !== undefined) return env[SEARCH_EXTRA_LANGS_ENV];
  return settings.search?.extraLangs?.join(",");
}

function settingNumberValue(envValue: string | undefined, settingValue: number | undefined): string | undefined {
  if (envValue !== undefined) return envValue;
  return settingValue === undefined ? undefined : String(settingValue);
}

export function analyzerCacheKey(identity: SearchAnalyzerIdentity): string {
  const name = identity.name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "analyzer";
  if (name === "intl" || name === "router") return "intl";
  return `${name}-${stableHash(analyzerIdentityKey(identity)).slice(0, 12)}`;
}

export function analyzerIdentityKey(identity: SearchAnalyzerIdentity): string {
  return stableStringify(identity);
}

export function tokensToSearchText(tokens: readonly string[]): string {
  return unique(tokens).join(" ");
}

export function parseDeclaredSearchAnalyzers(raw: string | undefined): SearchDeclaredAnalyzer[] {
  if (raw === undefined || raw.trim() === "") return [];
  const declared = new Set<SearchDeclaredAnalyzer>();
  for (const part of raw.split(",")) {
    const code = part.trim().toLowerCase();
    if (!code) continue;
    if (!REGISTERED_ANALYZER_SET.has(code)) {
      throw new UsageError(`${SEARCH_EXTRA_LANGS_ENV} must include only registered analyzers: ${REGISTERED_ANALYZERS.join(", ")}`);
    }
    declared.add(code as SearchDeclaredAnalyzer);
  }
  return [...declared].sort((left, right) => left.localeCompare(right));
}

export function createServedSearchAnalyzer(identity: SearchAnalyzerIdentity): SearchAnalyzer | undefined {
  const name = identity.name.trim().toLowerCase();
  if (name !== "router" && name !== "intl") return undefined;
  if ((identity.activeAnalyzers ?? []).length > 0) return undefined;
  return createRouterAnalyzer(parseDeclaredSearchAnalyzers((identity.declaredAnalyzers ?? []).join(",")));
}

export function tokenizeIntlText(text: string): string[] {
  return tokenizeRoutedText(text, []);
}

export function tokenizeRoutedText(text: string, declaredAnalyzers: readonly SearchDeclaredAnalyzer[]): string[] {
  const normalized = normalizeAnalyzerInput(text);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const run of scriptRuns(normalized)) {
    tokens.push(...tokenizeScriptRun(run, declaredAnalyzers));
  }
  return unique(tokens.map((token) => normalizeToken(token.trim())).filter(Boolean));
}

function tokenizeScriptRun(run: ScriptRun, declaredAnalyzers: readonly SearchDeclaredAnalyzer[]): string[] {
  if (run.script === "hangul" && declaredAnalyzers.includes("ko")) {
    return tokenizeIntlRun(run.text);
  }
  return tokenizeIntlRun(run.text);
}

type ScriptRun = {
  script: "latin" | "hangul" | "han" | "hiragana" | "katakana" | "other";
  text: string;
};

function scriptRuns(text: string): ScriptRun[] {
  return [...text.matchAll(SCRIPT_RUN_PATTERN)].map((match) => ({
    script: scriptForRun(match[0]),
    text: match[0]
  }));
}

function scriptForRun(text: string): ScriptRun["script"] {
  if (/\p{Script=Hangul}/u.test(text)) return "hangul";
  if (/\p{Script=Han}/u.test(text)) return "han";
  if (/\p{Script=Hiragana}/u.test(text)) return "hiragana";
  if (/\p{Script=Katakana}/u.test(text)) return "katakana";
  if (/\p{Script=Latin}/u.test(text)) return "latin";
  return "other";
}

function tokenizeIntlRun(text: string): string[] {
  const segmenter = intlSegmenter();
  const tokens: string[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike !== true) continue;
      for (const run of segment.segment.matchAll(WORD_SCRIPT_RUN_PATTERN)) {
        tokens.push(run[0]);
      }
    }
  } else {
    for (const run of text.matchAll(WORD_SCRIPT_RUN_PATTERN)) {
      tokens.push(run[0]);
    }
  }
  return tokens;
}

function normalizeToken(token: string): string {
  let normalized = foldLatinDiacritics(token);
  if (ASCII_ALPHA_PATTERN.test(normalized)) {
    normalized = porterStemAscii(normalized);
  }
  return normalized;
}

function foldLatinRun(raw: string): string {
  return raw.normalize("NFD").replace(COMBINING_MARKS_PATTERN, "");
}

function foldLatinDiacritics(raw: string): string {
  let folded = "";
  let latinRun = "";

  for (const char of raw) {
    if (LATIN_SCRIPT_PATTERN.test(char)) {
      latinRun += char;
      continue;
    }

    if (latinRun && COMBINING_MARK_PATTERN.test(char)) {
      latinRun += char;
      continue;
    }

    if (latinRun) {
      folded += foldLatinRun(latinRun);
      latinRun = "";
    }
    folded += char;
  }

  if (latinRun) {
    folded += foldLatinRun(latinRun);
  }

  return folded;
}

function isAsciiConsonant(word: string, index: number): boolean {
  const char = word[index];
  if (char === "a" || char === "e" || char === "i" || char === "o" || char === "u") return false;
  if (char === "y") return index === 0 ? true : !isAsciiConsonant(word, index - 1);
  return true;
}

function asciiMeasure(word: string): number {
  let measure = 0;
  let sawVowel = false;
  for (let index = 0; index < word.length; index += 1) {
    if (isAsciiConsonant(word, index)) {
      if (sawVowel) {
        measure += 1;
        sawVowel = false;
      }
      continue;
    }
    sawVowel = true;
  }
  return measure;
}

function containsAsciiVowel(word: string): boolean {
  for (let index = 0; index < word.length; index += 1) {
    if (!isAsciiConsonant(word, index)) return true;
  }
  return false;
}

function endsWithDoubleAsciiConsonant(word: string): boolean {
  const last = word.length - 1;
  if (last < 1 || word[last] !== word[last - 1]) return false;
  return isAsciiConsonant(word, last);
}

function isAsciiCvc(word: string): boolean {
  const last = word.length - 1;
  if (last < 2) return false;
  const finalChar = word[last];
  return (
    isAsciiConsonant(word, last) &&
    !isAsciiConsonant(word, last - 1) &&
    isAsciiConsonant(word, last - 2) &&
    finalChar !== "w" &&
    finalChar !== "x" &&
    finalChar !== "y"
  );
}

function replaceSuffixByMeasure(word: string, suffix: string, replacement: string, minMeasureExclusive: number): string | null {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, -suffix.length);
  if (asciiMeasure(stem) <= minMeasureExclusive) return null;
  return `${stem}${replacement}`;
}

function porterStep1a(word: string): string {
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ies")) return word.slice(0, -2);
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function porterStep1b(word: string): string {
  const eedReplacement = replaceSuffixByMeasure(word, "eed", "ee", 0);
  if (eedReplacement !== null) return eedReplacement;
  if (word.endsWith("eed")) return word;

  for (const suffix of ["ed", "ing"] as const) {
    if (!word.endsWith(suffix)) continue;
    let stem = word.slice(0, -suffix.length);
    if (!containsAsciiVowel(stem)) return word;
    if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) {
      stem += "e";
    } else if (endsWithDoubleAsciiConsonant(stem)) {
      const finalChar = stem[stem.length - 1];
      if (finalChar !== "l" && finalChar !== "s" && finalChar !== "z") {
        stem = stem.slice(0, -1);
      }
    } else if (asciiMeasure(stem) === 1 && isAsciiCvc(stem)) {
      stem += "e";
    }
    return stem;
  }

  return word;
}

function porterStep1c(word: string): string {
  if (!word.endsWith("y")) return word;
  const stem = word.slice(0, -1);
  return containsAsciiVowel(stem) ? `${stem}i` : word;
}

const PORTER_STEP2_SUFFIXES: ReadonlyArray<readonly [suffix: string, replacement: string]> = [
  ["ization", "ize"],
  ["ational", "ate"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["iveness", "ive"],
  ["tional", "tion"],
  ["biliti", "ble"],
  ["alism", "al"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["alli", "al"],
  ["entli", "ent"],
  ["ousli", "ous"],
  ["bli", "ble"],
  ["eli", "e"],
  ["logi", "log"]
];

const PORTER_STEP3_SUFFIXES: ReadonlyArray<readonly [suffix: string, replacement: string]> = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""]
];

const PORTER_STEP4_SUFFIXES = [
  "ement",
  "ance",
  "ence",
  "able",
  "ible",
  "ment",
  "ant",
  "ent",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
  "al",
  "er",
  "ic",
  "ou"
] as const;

function applyPorterSuffixes(word: string, suffixes: ReadonlyArray<readonly [suffix: string, replacement: string]>): string {
  for (const [suffix, replacement] of suffixes) {
    const replaced = replaceSuffixByMeasure(word, suffix, replacement, 0);
    if (replaced !== null) return replaced;
  }
  return word;
}

function porterStep4(word: string): string {
  if (word.endsWith("ion")) {
    const stem = word.slice(0, -3);
    if (asciiMeasure(stem) > 1 && (stem.endsWith("s") || stem.endsWith("t"))) return stem;
    return word;
  }

  for (const suffix of PORTER_STEP4_SUFFIXES) {
    const replaced = replaceSuffixByMeasure(word, suffix, "", 1);
    if (replaced !== null) return replaced;
  }

  return word;
}

function porterStep5a(word: string): string {
  if (!word.endsWith("e")) return word;
  const stem = word.slice(0, -1);
  const measure = asciiMeasure(stem);
  if (measure > 1 || (measure === 1 && !isAsciiCvc(stem))) return stem;
  return word;
}

function porterStep5b(word: string): string {
  if (asciiMeasure(word) > 1 && endsWithDoubleAsciiConsonant(word) && word.endsWith("l")) {
    return word.slice(0, -1);
  }
  return word;
}

function porterStemAscii(word: string): string {
  if (word.length < 3) return word;
  let stem = porterStep1a(word);
  stem = porterStep1b(stem);
  stem = porterStep1c(stem);
  stem = applyPorterSuffixes(stem, PORTER_STEP2_SUFFIXES);
  stem = applyPorterSuffixes(stem, PORTER_STEP3_SUFFIXES);
  stem = porterStep4(stem);
  stem = porterStep5a(stem);
  stem = porterStep5b(stem);
  return stem;
}

export async function runSearchAnalyzerDaemon(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env)
): Promise<void> {
  const paths = analyzerDaemonPaths(env);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const idleMs = parseIdleMs(settingNumberValue(env[ANALYZER_IDLE_ENV], settings.search?.analyzerIdleMs));
  const sockets = new Set<net.Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  const server = net.createServer((socket) => {
    clearIdleTimer();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleAnalyzerLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      armIdleTimer();
    });
    socket.on("error", () => {
      sockets.delete(socket);
      armIdleTimer();
    });
    armIdleTimer();
  });

  function armIdleTimer(): void {
    if (sockets.size > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      server.close();
      for (const socket of sockets) socket.destroy();
    }, idleMs);
    idleTimer.unref();
  }

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.off("error", reject);
      armIdleTimer();
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  if (process.platform !== "win32") {
    fs.rmSync(paths.socketPath, { force: true });
  }
}

function createRouterAnalyzer(declaredAnalyzers: readonly SearchDeclaredAnalyzer[]): SearchAnalyzer {
  const identity = routerIdentity(declaredAnalyzers, []);
  return {
    identity,
    tokenize: async (text) => tokenizeRoutedText(text, declaredAnalyzers),
    tokenizeBatch: async (texts) => texts.map((text) => tokenizeRoutedText(text, declaredAnalyzers))
  };
}

function createDaemonAnalyzer(
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[]
): SearchAnalyzer {
  const identity = routerIdentity(declaredAnalyzers, []);
  return {
    identity,
    tokenize: async (text) => (await requestDaemonTokenization([text], declaredAnalyzers, env, settings))[0] ?? [],
    tokenizeBatch: async (texts) => requestDaemonTokenization([...texts], declaredAnalyzers, env, settings)
  };
}

async function requestDaemonTokenization(
  texts: string[],
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings
): Promise<string[][]> {
  if (texts.length === 0) return [];
  try {
    return await requestRunningDaemon(texts, declaredAnalyzers, env, settings);
  } catch (error) {
    cleanupStaleSocketForError(error, env);
    spawnAnalyzerDaemon(env);
  }

  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    await sleep(50);
    try {
      return await requestRunningDaemon(texts, declaredAnalyzers, env, settings);
    } catch (error) {
      lastError = error;
    }
  }
  throw new RuntimeError(`Analyzer daemon is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function requestRunningDaemon(
  texts: string[],
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings
): Promise<string[][]> {
  const paths = analyzerDaemonPaths(env);
  const id = ++requestId;
  const request: AnalyzerRequest = {
    id,
    method: "tokenizeBatch",
    params: {
      analyzer: { name: "router", declaredAnalyzers: [...declaredAnalyzers], activeAnalyzers: [] },
      texts
    }
  };
  const response = await sendAnalyzerRequest(paths.socketPath, request, env, settings);
  if ("error" in response) {
    throw new RuntimeError(response.error.message);
  }
  const expectedIdentity = analyzerIdentityKey(routerIdentity(declaredAnalyzers, []));
  const actualIdentity = analyzerIdentityKey(response.result.analyzer);
  if (actualIdentity !== expectedIdentity) {
    throw new RuntimeError("Analyzer daemon identity does not match the active search analyzer");
  }
  return response.result.tokens;
}

function sendAnalyzerRequest(
  socketPath: string,
  request: AnalyzerRequest,
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings
): Promise<AnalyzerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeError("Analyzer daemon request timed out"));
    }, parseRequestTimeoutMs(settingNumberValue(env[ANALYZER_REQUEST_TIMEOUT_ENV], settings.search?.analyzerRequestTimeoutMs)));
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as AnalyzerResponse);
      } catch (error) {
        reject(new RuntimeError(`Analyzer daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function handleAnalyzerLine(socket: net.Socket, line: string): void {
  let request: AnalyzerRequest | undefined;
  try {
    request = JSON.parse(line) as AnalyzerRequest;
    if (request.method !== "tokenizeBatch" || !Array.isArray(request.params.texts)) {
      throw new Error("unsupported analyzer request");
    }
    const declaredAnalyzers = parseSelectorDeclaredAnalyzers(request.params.analyzer);
    const tokens = request.params.texts.map((text) => tokenizeRoutedText(String(text), declaredAnalyzers));
    socket.write(`${JSON.stringify({ id: request.id, result: { analyzer: routerIdentity(declaredAnalyzers, []), tokens } })}\n`);
  } catch (error) {
    const id = typeof request?.id === "number" ? request.id : 0;
    socket.write(`${JSON.stringify({ id, error: { message: error instanceof Error ? error.message : String(error) } })}\n`);
  }
}

function parseSelectorDeclaredAnalyzers(selector: SearchAnalyzerSelector): SearchDeclaredAnalyzer[] {
  if (selector.name !== "router" && selector.name !== "intl") {
    throw new Error("unsupported analyzer request");
  }
  return parseDeclaredSearchAnalyzers((selector.declaredAnalyzers ?? []).join(","));
}

function spawnAnalyzerDaemon(env: NodeJS.ProcessEnv): void {
  const bin = env[ANALYZER_BIN_ENV] || process.argv[1];
  if (!bin) throw new RuntimeError(`Cannot start analyzer daemon: ${ANALYZER_BIN_ENV} is unset and process.argv[1] is unavailable`);
  const child = spawn(process.execPath, [bin, "__analyzer-daemon"], {
    detached: true,
    stdio: "ignore",
    env
  });
  child.unref();
}

function analyzerDaemonPaths(env: NodeJS.ProcessEnv): { runtimeDir: string; socketPath: string } {
  const base = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `optsidian-${process.getuid?.() ?? "user"}`);
  const runtimeDir = path.join(base, "optsidian");
  if (process.platform === "win32") {
    const key = stableHash(`${runtimeDir}:${DAEMON_PROTOCOL_VERSION}`).slice(0, 16);
    return { runtimeDir, socketPath: `\\\\.\\pipe\\optsidian-analyzer-${key}` };
  }
  return { runtimeDir, socketPath: path.join(runtimeDir, `analyzer-${DAEMON_PROTOCOL_VERSION}.sock`) };
}

function cleanupStaleSocketForError(error: unknown, env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") return;
  if (!isConnectionRefused(error)) return;
  const { socketPath } = analyzerDaemonPaths(env);
  fs.rmSync(socketPath, { force: true });
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ECONNREFUSED";
}

function parseIdleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MS;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${ANALYZER_IDLE_ENV} must be a non-negative integer`);
  return Math.max(1, Number(raw));
}

function parseRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${ANALYZER_REQUEST_TIMEOUT_ENV} must be a non-negative integer`);
  return Math.max(1, Number(raw));
}

function normalizeAnalyzerInput(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[#._/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function intlSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== "function") return undefined;
  return new Intl.Segmenter(undefined, { granularity: "word" });
}

function routerIdentity(
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  activeAnalyzers: readonly SearchDeclaredAnalyzer[]
): SearchAnalyzerIdentity {
  return {
    name: "router",
    version: ROUTER_VERSION,
    baseline: INTL_ANALYZER_VERSION,
    runtime: "node-intl",
    node: process.versions.node,
    ...(process.versions.icu ? { icu: process.versions.icu } : {}),
    declaredAnalyzers: [...declaredAnalyzers].sort((left, right) => left.localeCompare(right)),
    activeAnalyzers: [...activeAnalyzers].sort((left, right) => left.localeCompare(right))
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
