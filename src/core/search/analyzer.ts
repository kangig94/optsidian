import crypto from "node:crypto";
import { UsageError } from "../../errors.js";
import { KIWI_MODEL_TYPE, KIWI_MODEL_VERSION, KIWI_NLP_VERSION } from "../kiwi/artifact.js";
import { getKiwiAnalyzerManager, type KiwiDeclaredAnalyzer } from "../kiwi/manager.js";
import { readOptsidianSettings, type OptsidianSettings } from "../settings.js";
import type { SearchAnalyzerRuntimeStatus } from "../types.js";

export type SearchEmbeddingModelIdentity = {
  id: string;
  sha256: string;
  opset: string;
  quantization: string;
  dim: number;
  pooling: string;
};

export type SearchAnalyzerIdentity = {
  name: string;
  version: string;
  runtime?: string;
  node: string;
  icu?: string;
  model?: string;
  embeddingModel?: SearchEmbeddingModelIdentity | null;
  declaredAnalyzers?: string[];
  activeAnalyzers?: string[];
};

export type SearchAnalyzerRuntime = {
  node: string;
  icu?: string;
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

export type SearchDeclaredAnalyzer = KiwiDeclaredAnalyzer;

export const SEARCH_EXTRA_LANGS_ENV = "OPTSIDIAN_SEARCH_EXTRA_LANGS";

// Single tokenizer-identity lever. Bump on any change to script routing, the Intl
// latin baseline, or the Kiwi POS filter. Kept distinct from INDEX_BUILD_VERSION
// because the analyzer identity is also the query-analysis cache key.
const ANALYZER_VERSION = "router-intl-kiwi-v1";
const ANALYZER_MODE_ENV = "OPTSIDIAN_SEARCH_ANALYZER";
const REGISTERED_ANALYZERS = ["ko"] as const satisfies readonly SearchDeclaredAnalyzer[];
const REGISTERED_ANALYZER_SET: ReadonlySet<string> = new Set(REGISTERED_ANALYZERS);
const WORD_SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const SCRIPT_RUN_PATTERN =
  /[\p{Script=Latin}\p{Mark}\p{Number}]+|[\p{Script=Hangul}\p{Mark}\p{Number}]+|[\p{Script=Han}\p{Mark}\p{Number}]+|[\p{Script=Hiragana}\p{Mark}\p{Number}]+|[\p{Script=Katakana}\p{Mark}\p{Number}]+|[\p{Letter}\p{Mark}\p{Number}]+/gu;
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const COMBINING_MARKS_PATTERN = /\p{Mark}/gu;
const ASCII_ALPHA_PATTERN = /^[a-z]+$/;
const HANGUL_SCRIPT_PATTERN = /\p{Script=Hangul}/u;

export class SearchAnalyzerTerminalLoadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SearchAnalyzerTerminalLoadError";
    this.cause = cause;
    Object.setPrototypeOf(this, SearchAnalyzerTerminalLoadError.prototype);
  }
}

export function isSearchAnalyzerTerminalLoadError(error: unknown): error is SearchAnalyzerTerminalLoadError {
  return error instanceof SearchAnalyzerTerminalLoadError;
}

export function resolveSearchAnalyzer(
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  runtime: SearchAnalyzerRuntime
): SearchAnalyzer {
  const mode = searchAnalyzerMode(env, settings);
  const parsedDeclaredAnalyzers = parseDeclaredSearchAnalyzers(searchExtraLangsValue(env, settings));
  const declaredAnalyzers = mode === "kiwi" && !parsedDeclaredAnalyzers.includes("ko")
    ? [...parsedDeclaredAnalyzers, "ko" as const]
    : parsedDeclaredAnalyzers;
  const baseline = createRouterAnalyzer(declaredAnalyzers, runtime);
  if (mode === "intl") {
    return declaredAnalyzers.includes("ko")
      ? createKiwiAnalyzer(env, settings, declaredAnalyzers, baseline, runtime)
      : baseline;
  }
  if (mode === "kiwi") {
    return createKiwiAnalyzer(env, settings, declaredAnalyzers, baseline, runtime);
  }
  throw new UsageError(`${ANALYZER_MODE_ENV} must be one of: intl, kiwi`);
}

function searchAnalyzerMode(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string {
  const raw = env[ANALYZER_MODE_ENV] ?? settings.search?.analyzer ?? "intl";
  return raw.trim().toLowerCase();
}

function searchExtraLangsValue(env: NodeJS.ProcessEnv, settings: OptsidianSettings): string | undefined {
  if (env[SEARCH_EXTRA_LANGS_ENV] !== undefined) return env[SEARCH_EXTRA_LANGS_ENV];
  return settings.search?.extraLangs?.join(",");
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
  return createRouterAnalyzer(parseDeclaredSearchAnalyzers((identity.declaredAnalyzers ?? []).join(",")), {
    node: identity.node,
    ...(identity.icu ? { icu: identity.icu } : {})
  });
}

export function createInlineQueryAnalyzer(identity: SearchAnalyzerIdentity, rawQuery: string): SearchAnalyzer | undefined {
  const served = createServedSearchAnalyzer(identity);
  if (served) return served;
  const name = identity.name.trim().toLowerCase();
  if (name !== "router" && name !== "intl") return undefined;
  if (searchTextNeedsBlockingAnalyzer(rawQuery, identity)) return undefined;
  return createRouterAnalyzer(parseDeclaredSearchAnalyzers((identity.declaredAnalyzers ?? []).join(",")), {
    node: identity.node,
    ...(identity.icu ? { icu: identity.icu } : {})
  });
}

export function searchTextNeedsBlockingAnalyzer(text: string, identity: SearchAnalyzerIdentity): boolean {
  const activeAnalyzers = normalizeAnalyzerNames(identity.activeAnalyzers ?? []);
  if (!activeAnalyzers.includes("ko")) return false;
  return searchTextContainsHangul(text);
}

export function searchTextContainsHangul(text: string): boolean {
  return HANGUL_SCRIPT_PATTERN.test(text);
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

function createRouterAnalyzer(declaredAnalyzers: readonly SearchDeclaredAnalyzer[], runtime: SearchAnalyzerRuntime): SearchAnalyzer {
  const identity = routerIdentity(declaredAnalyzers, [], runtime);
  return {
    identity,
    tokenize: async (text) => tokenizeRoutedText(text, declaredAnalyzers),
    tokenizeBatch: async (texts) => texts.map((text) => tokenizeRoutedText(text, declaredAnalyzers))
  };
}

function createKiwiAnalyzer(
  env: NodeJS.ProcessEnv,
  settings: OptsidianSettings,
  declaredAnalyzers: readonly SearchDeclaredAnalyzer[],
  degradedAnalyzer: SearchAnalyzer,
  runtime: SearchAnalyzerRuntime
): SearchAnalyzer {
  const normalizedDeclared = normalizeDeclaredSearchAnalyzers(declaredAnalyzers);
  const manager = getKiwiAnalyzerManager();
  const identity = kiwiRouterIdentity(normalizedDeclared, normalizedDeclared.includes("ko") ? ["ko"] : [], runtime);
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
      identity: kiwiRouterIdentity(normalizedDeclared, active, runtime),
      degradedAnalyzer,
      isTerminalLoadError: (error) => manager.isTerminalLoadError(error),
      tokenize: async (text) => tokenizeRoutedText(text, normalizedDeclared, kiwi),
      tokenizeBatch: async (texts) => texts.map((text) => tokenizeRoutedText(text, normalizedDeclared, kiwi))
    };
  };

  targetAnalyzer = {
    identity,
    degradedAnalyzer,
    isTerminalLoadError: (error) => manager.isTerminalLoadError(error),
    withLease: async (run, options = {}) => {
      if (options.wait !== true) return run(createLeasedAnalyzer([], null));
      try {
        return await manager.withAnalyzerLease(
          env,
          normalizedDeclared,
          { wait: true, installIfMissing: options.installIfMissing ?? true },
          (lease) => run(createLeasedAnalyzer(lease.activeAnalyzers, lease.analyzer))
        );
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
  activeAnalyzers: readonly SearchDeclaredAnalyzer[],
  runtime: SearchAnalyzerRuntime
): SearchAnalyzerIdentity {
  return {
    ...routerIdentity(declaredAnalyzers, activeAnalyzers, runtime),
    model: `kiwi-nlp:${KIWI_NLP_VERSION}:model:${KIWI_MODEL_VERSION}:${KIWI_MODEL_TYPE}`
  };
}

export function searchAnalyzerRuntimeStatus(
  analyzer: SearchAnalyzer,
  env: NodeJS.ProcessEnv
): SearchAnalyzerRuntimeStatus {
  const declaredAnalyzers = normalizeAnalyzerNames(analyzer.identity.declaredAnalyzers ?? []);
  const activeAnalyzers = normalizeAnalyzerNames(analyzer.identity.activeAnalyzers ?? []);
  const targetTier = activeAnalyzers.includes("ko") ? "kiwi" : "intl";
  if (targetTier !== "kiwi") {
    return { targetTier, declaredAnalyzers, activeAnalyzers };
  }

  const managerStatus = getKiwiAnalyzerManager().status(env);
  return {
    targetTier,
    declaredAnalyzers,
    activeAnalyzers,
    kiwi: {
      modelState: managerStatus.model.installed ? "installed" : "missing",
      modelPath: managerStatus.model.targetDir,
      missingFiles: managerStatus.model.missingFiles,
      analyzerState: managerStatus.state,
      leaseCount: managerStatus.leaseCount,
      ...(managerStatus.state === "degraded" ? { reason: managerStatus.reason } : {})
    }
  };
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
  activeAnalyzers: readonly SearchDeclaredAnalyzer[],
  runtime: SearchAnalyzerRuntime
): SearchAnalyzerIdentity {
  return {
    name: "router",
    version: ANALYZER_VERSION,
    runtime: "node-intl",
    node: runtime.node,
    ...(runtime.icu ? { icu: runtime.icu } : {}),
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
