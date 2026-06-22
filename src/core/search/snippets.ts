import fs from "node:fs";
import { resolveVaultPath } from "../path.js";
import type { SearchAnalyzer } from "./analyzer.js";
import { decodeUtf8, splitText } from "../text.js";
import type { SearchSnippet } from "../types.js";
import {
  analyzeSearchText,
  tokenChannelsOverlap,
  type SearchTokenChannelTerms
} from "./analysis/index.js";

export async function snippetsForDocument(
  vaultRoot: string,
  relPath: string,
  query: string | undefined,
  queryTerms: string[],
  queryChannels: SearchTokenChannelTerms | undefined,
  analyzer: SearchAnalyzer
): Promise<SearchSnippet[]> {
  try {
    const abs = resolveVaultPath(vaultRoot, relPath, { mustExist: true }).abs;
    const lines = splitText(decodeUtf8(fs.readFileSync(abs), relPath)).lines;
    const bodyStart = bodyStartLine(lines);
    const terms = query ? queryTerms : [];
    const channels = query ? queryChannels : undefined;
    const headingSnippets = await matchingSnippets(lines, terms, channels, bodyStart, analyzer, (line) => /^#{1,6}\s+/.test(line));
    const bodySnippets = await matchingSnippets(lines, terms, channels, bodyStart, analyzer, (line) => !/^#{1,6}\s+/.test(line));
    const snippets = uniqueSnippets(bodySnippets.length > 0 ? [...headingSnippets.slice(0, 1), ...bodySnippets] : headingSnippets).slice(
      0,
      3
    );
    if (snippets.length > 0) return snippets;
    const headingIndex = lines.findIndex((line, index) => index >= bodyStart && /^#{1,6}\s+/.test(line));
    if (headingIndex >= 0) return [{ line: headingIndex + 1, text: lines[headingIndex] }];
    const nonEmptyIndex = lines.findIndex((line, index) => index >= bodyStart && line.trim().length > 0);
    if (nonEmptyIndex >= 0) return [{ line: nonEmptyIndex + 1, text: lines[nonEmptyIndex] }];
    return [];
  } catch {
    return [];
  }
}

function bodyStartLine(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "---" || trimmed === "...") return index + 1;
  }
  return 0;
}

async function matchingSnippets(
  lines: string[],
  terms: string[],
  queryChannels: SearchTokenChannelTerms | undefined,
  start: number,
  analyzer: SearchAnalyzer,
  predicate: (line: string) => boolean
): Promise<SearchSnippet[]> {
  const candidates: SearchSnippet[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (predicate(line)) {
      candidates.push({ line: index + 1, text: line });
    }
  }
  if (terms.length === 0 || candidates.length === 0) return [];
  const tokenized = await analyzer.tokenizeBatch(candidates.map((candidate) => candidate.text));
  return candidates.filter((candidate, index) => {
    const tokens = tokenized[index] ?? [];
    if (tokensMatchTerms(tokens, terms)) return true;
    if (!queryChannels) return false;
    return tokenChannelsOverlap(analyzeSearchText(candidate.text, tokens).channels, queryChannels);
  });
}

function uniqueSnippets(snippets: SearchSnippet[]): SearchSnippet[] {
  const seen = new Set<number>();
  const result: SearchSnippet[] = [];
  for (const snippet of snippets) {
    if (seen.has(snippet.line)) continue;
    seen.add(snippet.line);
    result.push(snippet);
  }
  return result;
}

function tokensMatchTerms(tokens: readonly string[], terms: readonly string[]): boolean {
  const available = new Set(tokens);
  return terms.some((term) => available.has(term));
}
