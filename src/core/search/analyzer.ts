import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeError, UsageError } from "../../errors.js";
import { KIWI_MODEL_TYPE, KIWI_MODEL_VERSION, KIWI_NLP_VERSION } from "../kiwi/artifact.js";
import { getKiwiAnalyzerManager, type KiwiDeclaredAnalyzer } from "../kiwi/manager.js";
import { readOptsidianSettings, type OptsidianSettings } from "../settings.js";
import type { SearchAnalyzerRuntimeStatus } from "../types.js";

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
  degradedAnalyzer?: SearchAnalyzer;
  reconcileTargetAnalyzer?: SearchAnalyzer;
  isTerminalLoadError?(error: unknown): boolean;
  withLease?<T>(run: (analyzer: SearchAnalyzer) => T | Promise<T>, options?: SearchAnalyzerLeaseOptions): Promise<T>;
  tokenize(text: string): Promise<string[]>;
  tokenizeBatch(texts: readonly string[]): Promise<string[][]>;
};

export type SearchAnalyzerLeaseOptions = {
  wait?: boolean;
  installIfMissing?: boolean;
  loadTimeoutMs?: number;
};

export type SearchAnalyzerDegradedEvent = {
  error: unknown;
  analyzer: SearchAnalyzer;
  degradedAnalyzer: SearchAnalyzer;
  reason: "terminal-load-error";
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

type DaemonTokenizationOptions = {
  activeAnalyzers?: readonly SearchDeclaredAnalyzer[];
  requestTimeoutMs?: number;
};

export type SearchDeclaredAnalyzer = KiwiDeclaredAnalyzer;

export const SEARCH_EXTRA_LANGS_ENV = "OPTSIDIAN_SEARCH_EXTRA_LANGS";

const ROUTER_VERSION = "script-router-v2";
const INTL_ANALYZER_VERSION = "intl-segmenter-latin-v2";
const KIWI_TOKEN_FILTER_VERSION = "kiwi-pos-filter-v1";
const DAEMON_PROTOCOL_VERSION = "v3";
const ANALYZER_DAEMON_IDENTITY_MISMATCH = "Analyzer daemon identity does not match the active search analyzer";
const DAEMON_RUNTIME_IDENTITY = stableHash(
  stableStringify({
    protocol: DAEMON_PROTOCOL_VERSION,
    router: ROUTER_VERSION,
    intl: INTL_ANALYZER_VERSION,
    kiwiFilter: KIWI_TOKEN_FILTER_VERSION,
    node: process.versions.node,
    icu: process.versions.icu ?? null
  })
).slice(0, 16);
const ANALYZER_MODE_ENV = "OPTSIDIAN_SEARCH_ANALYZER";
const ANALYZER_IDLE_ENV = "OPTSIDIAN_ANALYZER_IDLE_MS";
const ANALYZER_REQUEST_TIMEOUT_ENV = "OPTSIDIAN_ANALYZER_REQUEST_TIMEOUT_MS";
const ANALYZER_BIN_ENV = "OPTSIDIAN_ANALYZER_DAEMON_BIN";
const REGISTERED_ANALYZERS = ["ko"] as const satisfies readonly SearchDeclaredAnalyzer[];
const REGISTERED_ANALYZER_SET: ReadonlySet<string> = new Set(REGISTERED_ANALYZERS);
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const STARTUP_TIMEOUT_MS = 2000;
const DAEMON_SOCKET_FIRST_LINE_TIMEOUT_MS = 250;
const WORD_SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const COMBINING_MARKS_PATTERN = /\p{Mark}/gu;
const ASCII_ALPHA_PATTERN = /^[a-z]+$/;

let requestId = 0;

export class SearchAnalyzerTerminalLoadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SearchAnalyzerTerminalLoadError";
    this.cause = cause;
    Object.setPrototypeOf(this, SearchAnalyzerTerminalLoadError.prototype);
  }
}

class AnalyzerDaemonIdentityMismatchError extends RuntimeError {
  constructor() {
    super(ANALYZER_DAEMON_IDENTITY_MISMATCH);
    this.name = "AnalyzerDaemonIdentityMismatchError";
    Object.setPrototypeOf(this, AnalyzerDaemonIdentityMismatchError.prototype);
  }
}

export function isSearchAnalyzerTerminalLoadError(error: unknown): error is SearchAnalyzerTerminalLoadError {
  return error instanceof SearchAnalyzerTerminalLoadError;
}

export function resolveSearchAnalyzer(
  env: NodeJS.ProcessEnv = process.env,
  settings: OptsidianSettings = readOptsidianSettings(process.cwd(), env)
): SearchAnalyzer {
  const mode = searchAnalyzerMode(env, settings);
  const parsedDeclaredAnalyzers = parseDeclaredSearchAnalyzers(searchExtraLangsValue(env, settings));
  const declaredAnalyzers = mode === "kiwi" && !parsedDeclaredAnalyzers.includes("ko")
    ? [...parsedDeclaredAnalyzers, "ko" as const]
    : parsedDeclaredAnalyzers;
  const baseline = mode === "intl-daemon"
    ? createDaemonAnalyzer(env, settings, declaredAnalyzers)
    : createRouterAnalyzer(declaredAnalyzers);
  if (mode === "intl" || mode === "intl-daemon") {
    return declaredAnalyzers.includes("ko")
      ? createKiwiAnalyzer(env, settings, declaredAnalyzers, baseline)
      : baseline;
  }
  if (mode === "kiwi") {
    return createKiwiAnalyzer(env, settings, declaredAnalyzers, baseline);
  }
  throw new UsageError(`${ANALYZER_MODE_ENV} must be one of: intl, intl-daemon, kiwi`);
}

function searchAnalyzerMode(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string {
  const raw = env[ANALYZER_MODE_ENV] ?? settings.search?.analyzer ?? "intl";
  return raw.trim().toLowerCase();
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
  const activeAnalyzers = normalizeAnalyzerNames(identity.activeAnalyzers ?? []);
  if ((name === "intl" || name === "router") && activeAnalyzers.length === 0) return "intl";
  const tier = activeAnalyzers.includes("ko") ? "kiwi" : name;
  return `${tier}-${stableHash(analyzerIdentityKey(identity)).slice(0, 12)}`;
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

function normalizeDeclaredSearchAnalyzers(values: readonly SearchDeclaredAnalyzer[]): SearchDeclaredAnalyzer[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function createServedSearchAnalyzer(identity: SearchAnalyzerIdentity): SearchAnalyzer | undefined {
  const name = identity.name.trim().toLowerCase();
  if (name !== "router" && name !== "intl") return undefined;
  if ((identity.activeAnalyzers ?? []).length > 0) return undefined;
  return createRouterAnalyzer(parseDeclaredSearchAnalyzers((identity.declaredAnalyzers ?? []).join(",")));
}

export async function withSearchAnalyzerLease<T>(
  analyzer: SearchAnalyzer,
  run: (analyzer: SearchAnalyzer) => T | Promise<T>,
  onDegraded?: (event: SearchAnalyzerDegradedEvent) => void | Promise<void>,
  options: SearchAnalyzerLeaseOptions = {}
): Promise<T> {
  try {
    return analyzer.withLease ? await analyzer.withLease(run, options) : await run(analyzer);
  } catch (error) {
    const degradedAnalyzer = analyzer.degradedAnalyzer;
    if (!isTerminalAnalyzerError(analyzer, error) || !degradedAnalyzer || degradedAnalyzer === analyzer) {
      throw error;
    }
    const event: SearchAnalyzerDegradedEvent = {
      error,
      analyzer,
      degradedAnalyzer,
      reason: "terminal-load-error"
    };
    notifySearchAnalyzerDegraded(onDegraded, event);
    return withSearchAnalyzerLease(degradedAnalyzer, run, onDegraded, options);
  }
}

function isTerminalAnalyzerError(analyzer: SearchAnalyzer, error: unknown): boolean {
  return analyzer.isTerminalLoadError?.(error) === true || isSearchAnalyzerTerminalLoadError(error);
}

function notifySearchAnalyzerDegraded(
  onDegraded: ((event: SearchAnalyzerDegradedEvent) => void | Promise<void>) | undefined,
  event: SearchAnalyzerDegradedEvent
): void {
  if (!onDegraded) return;
  void Promise.resolve()
    .then(() => onDegraded(event))
    .catch(() => {});
}

function normalizeAnalyzerNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function tokenizeIntlText(text: string): string[] {
  return tokenizeRoutedText(text, []);
}

export function tokenizeRoutedText(text: string, declaredAnalyzers: readonly SearchDeclaredAnalyzer[], kiwi?: { tokens(text: string): string[] } | null): string[] {
  const normalized = normalizeAnalyzerInput(text);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const run of scriptRuns(normalized)) {
    tokens.push(...tokenizeScriptRun(run, declaredAnalyzers, kiwi));
  }
  return unique(tokens.map((token) => normalizeToken(token.trim())).filter(Boolean));
}

function tokenizeScriptRun(run: ScriptRun, declaredAnalyzers: readonly SearchDeclaredAnalyzer[], kiwi?: { tokens(text: string): string[] } | null): string[] {
  if (run.script === "hangul" && declaredAnalyzers.includes("ko") && kiwi) {
    return kiwi.tokens(run.text);
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
  const allSockets = new Set<net.Socket>();
  const sockets = new Set<net.Socket>();
  let closing = false;
  let activeRequests = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = net.createServer((socket) => {
    clearIdleTimer();
    allSockets.add(socket);
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let receivedRequest = false;
    const firstLineTimer = setTimeout(() => socket.destroy(), DAEMON_SOCKET_FIRST_LINE_TIMEOUT_MS);
    firstLineTimer.unref();
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      if (newline < 0 || receivedRequest) return;
      clearTimeout(firstLineTimer);
      receivedRequest = true;
      const line = buffer.slice(0, newline);
      sockets.delete(socket);
      activeRequests += 1;
      void handleAnalyzerLine(socket, line, env).finally(() => {
        activeRequests -= 1;
        armIdleTimer();
      });
    });
    socket.on("close", () => {
      allSockets.delete(socket);
      sockets.delete(socket);
      armIdleTimer();
    });
    socket.on("finish", () => {
      allSockets.delete(socket);
      sockets.delete(socket);
      armIdleTimer();
    });
    socket.on("error", () => {
      allSockets.delete(socket);
      sockets.delete(socket);
      armIdleTimer();
    });
    armIdleTimer();
  });

  function armIdleTimer(): void {
    if (closing || sockets.size > 0 || activeRequests > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeDaemon();
    }, idleMs);
    idleTimer.unref();
  }

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function closeDaemon(): void {
    if (closing) return;
    closing = true;
    clearIdleTimer();
    cleanupSocket();
    server.close();
    for (const socket of allSockets) socket.destroy();
  }

  function cleanupSocket(): void {
    if (process.platform !== "win32") {
      fs.rmSync(paths.socketPath, { force: true });
    }
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
  cleanupSocket();
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

function createKiwiAnalyzer(
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  degradedAnalyzer: SearchAnalyzer
): SearchAnalyzer {
  const normalizedDeclared = normalizeDeclaredSearchAnalyzers(declaredAnalyzers);
  const manager = getKiwiAnalyzerManager();
  const identity = kiwiRouterIdentity(normalizedDeclared, normalizedDeclared.includes("ko") ? ["ko"] : []);
  let targetAnalyzer: SearchAnalyzer;
  const createLeasedAnalyzer = (activeAnalyzers: readonly SearchDeclaredAnalyzer[], kiwi: { tokens(text: string): string[] } | null): SearchAnalyzer => {
    const active = normalizeDeclaredSearchAnalyzers(activeAnalyzers);
    if (!active.includes("ko")) {
      return {
        ...degradedAnalyzer,
        reconcileTargetAnalyzer: targetAnalyzer
      };
    }
    return {
      identity: kiwiRouterIdentity(normalizedDeclared, active),
      degradedAnalyzer,
      isTerminalLoadError: (error) => manager.isTerminalLoadError(error),
      tokenize: async (text) => tokenizeRoutedText(text, normalizedDeclared, kiwi),
      tokenizeBatch: async (texts) => texts.map((text) => tokenizeRoutedText(text, normalizedDeclared, kiwi))
    };
  };
  const createDaemonLeasedAnalyzer = (): SearchAnalyzer => ({
    identity,
    degradedAnalyzer,
    isTerminalLoadError: (error) => manager.isTerminalLoadError(error),
    tokenize: async (text) => (await requestDaemonTokenization([text], normalizedDeclared, env, settings, {
      activeAnalyzers: ["ko"]
    }))[0] ?? [],
    tokenizeBatch: async (texts) => requestDaemonTokenization([...texts], normalizedDeclared, env, settings, {
      activeAnalyzers: ["ko"]
    })
  });

  targetAnalyzer = {
    identity,
    degradedAnalyzer,
    isTerminalLoadError: (error) => manager.isTerminalLoadError(error),
    withLease: async (run, options = {}) => {
      if (options.wait !== true) return run(createLeasedAnalyzer([], null));
      try {
        await requestDaemonTokenization([""], normalizedDeclared, env, settings, {
          activeAnalyzers: ["ko"],
          requestTimeoutMs: options.loadTimeoutMs
        });
        return run(createDaemonLeasedAnalyzer());
      } catch {
        return run(createLeasedAnalyzer([], null));
      }
    },
    tokenize: async (text) => degradedAnalyzer.tokenize(text),
    tokenizeBatch: async (texts) => degradedAnalyzer.tokenizeBatch(texts)
  };
  return targetAnalyzer;
}

function kiwiRouterIdentity(
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  activeAnalyzers: readonly SearchDeclaredAnalyzer[]
): SearchAnalyzerIdentity {
  return {
    ...routerIdentity(declaredAnalyzers, activeAnalyzers),
    model: `kiwi-nlp:${KIWI_NLP_VERSION}:model:${KIWI_MODEL_VERSION}:${KIWI_MODEL_TYPE}`,
    optionsHash: KIWI_TOKEN_FILTER_VERSION
  };
}

export function searchAnalyzerRuntimeStatus(
  analyzer: SearchAnalyzer,
  env: NodeJS.ProcessEnv = process.env
): SearchAnalyzerRuntimeStatus {
  const declaredAnalyzers = normalizeAnalyzerNames(analyzer.identity.declaredAnalyzers ?? []);
  const activeAnalyzers = normalizeAnalyzerNames(analyzer.identity.activeAnalyzers ?? []);
  const targetTier = activeAnalyzers.includes("ko") ? "kiwi" : "intl";
  if (targetTier !== "kiwi") {
    return { targetTier, declaredAnalyzers, activeAnalyzers };
  }

  const managerStatus = getKiwiAnalyzerManager().status(env);
  const analyzerState = managerStatus.state === "unloaded" && isAnalyzerDaemonRunning(env) ? "daemon" : managerStatus.state;
  return {
    targetTier,
    declaredAnalyzers,
    activeAnalyzers,
    kiwi: {
      modelState: managerStatus.model.installed ? "installed" : "missing",
      modelPath: managerStatus.model.targetDir,
      missingFiles: managerStatus.model.missingFiles,
      analyzerState,
      leaseCount: managerStatus.leaseCount,
      ...(managerStatus.state === "degraded" ? { reason: managerStatus.reason } : {})
    }
  };
}

function isAnalyzerDaemonRunning(env: NodeJS.ProcessEnv): boolean {
  return fs.existsSync(analyzerDaemonPaths(env).socketPath);
}

async function requestDaemonTokenization(
  texts: string[],
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  options: DaemonTokenizationOptions = {}
): Promise<string[][]> {
  if (texts.length === 0) return [];
  const deadline = options.requestTimeoutMs === undefined ? undefined : Date.now() + options.requestTimeoutMs;
  try {
    return await requestRunningDaemon(texts, declaredAnalyzers, env, settings, optionsWithRemainingTimeout(options, deadline));
  } catch (error) {
    cleanupStaleSocketForError(error, env);
    spawnAnalyzerDaemon(env);
  }

  const startedAt = Date.now();
  const startupTimeoutMs = options.requestTimeoutMs ?? STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() - startedAt < startupTimeoutMs) {
    const remaining = remainingTimeoutMs(deadline);
    if (remaining !== undefined && remaining < 1) break;
    await sleep(Math.min(50, remaining ?? 50));
    try {
      return await requestRunningDaemon(texts, declaredAnalyzers, env, settings, optionsWithRemainingTimeout(options, deadline));
    } catch (error) {
      lastError = error;
    }
  }
  throw new RuntimeError(`Analyzer daemon is unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function optionsWithRemainingTimeout(
  options: DaemonTokenizationOptions,
  deadline: number | undefined
): DaemonTokenizationOptions {
  const requestTimeoutMs = remainingTimeoutMs(deadline) ?? options.requestTimeoutMs;
  return requestTimeoutMs === options.requestTimeoutMs ? options : { ...options, requestTimeoutMs };
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  return deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
}

async function requestRunningDaemon(
  texts: string[],
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  options: DaemonTokenizationOptions
): Promise<string[][]> {
  const paths = analyzerDaemonPaths(env);
  const id = ++requestId;
  const activeAnalyzers = normalizeDeclaredSearchAnalyzers(options.activeAnalyzers ?? []);
  const request: AnalyzerRequest = {
    id,
    method: "tokenizeBatch",
    params: {
      analyzer: { name: "router", declaredAnalyzers: [...declaredAnalyzers], activeAnalyzers },
      texts
    }
  };
  const response = await sendAnalyzerRequest(paths.socketPath, request, env, settings, options.requestTimeoutMs);
  if ("error" in response) {
    throw new RuntimeError(response.error.message);
  }
  const expectedIdentity = analyzerIdentityKey(
    activeAnalyzers.includes("ko")
      ? kiwiRouterIdentity(declaredAnalyzers, activeAnalyzers)
      : routerIdentity(declaredAnalyzers, [])
  );
  const actualIdentity = analyzerIdentityKey(response.result.analyzer);
  if (actualIdentity !== expectedIdentity) {
    throw new AnalyzerDaemonIdentityMismatchError();
  }
  return response.result.tokens;
}

function sendAnalyzerRequest(
  socketPath: string,
  request: AnalyzerRequest,
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  requestTimeoutMs?: number
): Promise<AnalyzerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeError("Analyzer daemon request timed out"));
    }, requestTimeoutMs ?? parseRequestTimeoutMs(settingNumberValue(env[ANALYZER_REQUEST_TIMEOUT_ENV], settings.search?.analyzerRequestTimeoutMs)));
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

async function handleAnalyzerLine(socket: net.Socket, line: string, env: NodeJS.ProcessEnv): Promise<void> {
  let request: AnalyzerRequest | undefined;
  try {
    request = JSON.parse(line) as AnalyzerRequest;
    if (request.method !== "tokenizeBatch" || !Array.isArray(request.params.texts)) {
      throw new Error("unsupported analyzer request");
    }
    const declaredAnalyzers = parseSelectorDeclaredAnalyzers(request.params.analyzer);
    const activeAnalyzers = parseSelectorActiveAnalyzers(request.params.analyzer);
    const result = activeAnalyzers.includes("ko")
      ? await tokenizeWithKiwiDaemonLease(request.params.texts, declaredAnalyzers, activeAnalyzers, env)
      : {
          analyzer: routerIdentity(declaredAnalyzers, []),
          tokens: request.params.texts.map((text) => tokenizeRoutedText(String(text), declaredAnalyzers))
        };
    endAnalyzerResponse(socket, { id: request.id, result });
  } catch (error) {
    const id = typeof request?.id === "number" ? request.id : 0;
    endAnalyzerResponse(socket, { id, error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

function endAnalyzerResponse(socket: net.Socket, response: AnalyzerResponse): void {
  socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
  const timer = setTimeout(() => socket.destroy(), 100);
  timer.unref();
}

function parseSelectorDeclaredAnalyzers(selector: SearchAnalyzerSelector): SearchDeclaredAnalyzer[] {
  if (selector.name !== "router" && selector.name !== "intl") {
    throw new Error("unsupported analyzer request");
  }
  return parseDeclaredSearchAnalyzers((selector.declaredAnalyzers ?? []).join(","));
}

function parseSelectorActiveAnalyzers(selector: SearchAnalyzerSelector): SearchDeclaredAnalyzer[] {
  if (selector.name !== "router" && selector.name !== "intl") {
    throw new Error("unsupported analyzer request");
  }
  return parseDeclaredSearchAnalyzers((selector.activeAnalyzers ?? []).join(","));
}

async function tokenizeWithKiwiDaemonLease(
  texts: readonly string[],
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  activeAnalyzers: readonly SearchDeclaredAnalyzer[],
  env: NodeJS.ProcessEnv
): Promise<{ analyzer: SearchAnalyzerIdentity; tokens: string[][] }> {
  const manager = getKiwiAnalyzerManager();
  const normalizedDeclared = normalizeDeclaredSearchAnalyzers(declaredAnalyzers);
  const normalizedActive = normalizeDeclaredSearchAnalyzers(activeAnalyzers);
  return manager.withAnalyzerLease(
    env,
    normalizedDeclared,
    { wait: true, installIfMissing: true },
    (lease) => {
      const active = lease.analyzer ? normalizedActive : normalizedActive.filter((name) => name !== "ko");
      return {
        analyzer: active.includes("ko") ? kiwiRouterIdentity(normalizedDeclared, active) : routerIdentity(normalizedDeclared, []),
        tokens: texts.map((text) => tokenizeRoutedText(String(text), normalizedDeclared, lease.analyzer))
      };
    }
  );
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
    const key = stableHash(`${runtimeDir}:${DAEMON_PROTOCOL_VERSION}:${DAEMON_RUNTIME_IDENTITY}`).slice(0, 16);
    return { runtimeDir, socketPath: `\\\\.\\pipe\\optsidian-analyzer-${key}` };
  }
  return { runtimeDir, socketPath: path.join(runtimeDir, `analyzer-${DAEMON_PROTOCOL_VERSION}-${DAEMON_RUNTIME_IDENTITY}.sock`) };
}

function cleanupStaleSocketForError(error: unknown, env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") return;
  if (!isStaleDaemonSocketError(error)) return;
  const { socketPath } = analyzerDaemonPaths(env);
  fs.rmSync(socketPath, { force: true });
}

export function __analyzerDaemonSocketPathForTests(env: NodeJS.ProcessEnv = process.env): string {
  return analyzerDaemonPaths(env).socketPath;
}

function isStaleDaemonSocketError(error: unknown): boolean {
  return isConnectionRefused(error) || isAnalyzerDaemonIdentityMismatch(error);
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ECONNREFUSED";
}

function isAnalyzerDaemonIdentityMismatch(error: unknown): boolean {
  return error instanceof AnalyzerDaemonIdentityMismatchError || (error instanceof Error && error.message === ANALYZER_DAEMON_IDENTITY_MISMATCH);
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
