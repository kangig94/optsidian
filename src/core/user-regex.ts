import { UsageError } from '../errors.js';
import { ensureRe2Runtime, getRe2ClassSync, type Re2Regex } from './re2-runtime.js';

const DEFAULT_USER_REGEX_MAX_LENGTH = 1024;
const DEFAULT_EDIT_REGEX_MAX_MATCHES = 10_000;

export type RegexMatch = {
  index: number;
  text: string;
};

export async function ensureUserRegexRuntime(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await ensureRe2Runtime(env);
}

export function compileUserRegex(
  pattern: string,
  flags: string,
  label = 'regex',
  env: NodeJS.ProcessEnv = process.env,
): Re2Regex {
  if (pattern.length > DEFAULT_USER_REGEX_MAX_LENGTH) {
    throw new UsageError(`${label} exceeds ${DEFAULT_USER_REGEX_MAX_LENGTH} character limit`);
  }
  const normalizedFlags = normalizeFlags(flags);
  const RE2 = getRe2ClassSync(env);
  try {
    return new RE2(pattern, normalizedFlags);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function collectRegexMatches(
  regex: Re2Regex,
  text: string,
  maxMatches = DEFAULT_EDIT_REGEX_MAX_MATCHES,
): RegexMatch[] {
  const matches: RegexMatch[] = [];
  regex.lastIndex = 0;
  while (true) {
    const match = regex.exec(text);
    if (!match) return matches;
    const index = typeof match.index === 'number' ? match.index : 0;
    const value = String(match[0] ?? '');
    matches.push({ index, text: value });
    if (matches.length > maxMatches) {
      throw new UsageError(`regex matched more than ${maxMatches} times; narrow the pattern`);
    }
    if (value.length === 0) {
      regex.lastIndex = advanceStringIndex(text, index);
    }
  }
}

function normalizeFlags(flags: string): string {
  const seen = new Set<string>();
  let normalized = '';
  for (const flag of `${flags}u`) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    normalized += flag;
  }
  return normalized;
}

function advanceStringIndex(input: string, index: number): number {
  if (index >= input.length) return index + 1;
  const first = input.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff || index + 1 >= input.length) return index + 1;
  const second = input.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}
