import path from "node:path";
import type { SearchDocument } from "../markdown.js";
import { surfaceSearchTerms } from "../analysis/channels.js";
import { EXACT_PRIORITY, PHRASE_PRIORITY } from "../constants.js";
import type { QueryContext } from "../internal-types.js";

export function bestExactPriority(doc: SearchDocument, context: QueryContext): number {
  const priorities: number[] = [];
  if (context.allowed.has("title") && hasExactIdentityPhrase(doc.title, context.phrases)) priorities.push(EXACT_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => hasExactIdentityPhrase(alias, context.phrases))) {
    priorities.push(EXACT_PRIORITY.alias);
  }
  if (context.allowed.has("path") && hasExactIdentityPhrase(filenameStem(doc.path), context.phrases)) {
    priorities.push(EXACT_PRIORITY.filenameStem);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

export function bestPhrasePriority(doc: SearchDocument, context: QueryContext): number {
  if (context.phrases.length === 0) return Number.POSITIVE_INFINITY;
  const priorities: number[] = [];
  if (context.allowed.has("title") && containsAnyIdentityPhrase(doc.title, context.phrases)) priorities.push(PHRASE_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => containsAnyIdentityPhrase(alias, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.alias);
  }
  if (context.allowed.has("path") && containsAnyIdentityPhrase(filenameStem(doc.path), context.phrases)) {
    priorities.push(PHRASE_PRIORITY.filenameStem);
  }
  if (context.allowed.has("path") && pathSegments(doc.path).some((segment) => containsAnyIdentityPhrase(segment, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.pathSegment);
  }
  if (context.allowed.has("headings") && doc.headings.some((heading) => containsAnyIdentityPhrase(heading, context.phrases))) {
    priorities.push(PHRASE_PRIORITY.heading);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

export function normalizeIdentityText(value: string): string {
  return identityPhraseCandidates(value)[0] ?? "";
}

export function identityPhraseCandidates(value: string): string[] {
  const cleaned = value.replace(/["']/g, "").replace(/#/g, " ").normalize("NFKC");
  const terms = surfaceSearchTerms(cleaned);
  if (terms.length === 0) return [];
  if (!hasExplicitTermBoundary(cleaned) && terms.length > 1) {
    return uniqueIdentityPhrases([terms[0], terms.slice(1).join(" ")]);
  }
  return uniqueIdentityPhrases([terms.join(" ")]);
}

function hasExactIdentityPhrase(value: string, phrases: readonly string[]): boolean {
  const available = new Set(identityPhraseCandidates(value));
  const compactAvailable = new Set([...available].map(compactIdentityPhrase).filter(Boolean));
  return phrases.some((phrase) => available.has(phrase) || compactAvailable.has(compactIdentityPhrase(phrase)));
}

function containsAnyIdentityPhrase(value: string, phrases: readonly string[]): boolean {
  const candidates = identityPhraseCandidates(value);
  return candidates.some((candidate) => {
    const compactCandidate = compactIdentityPhrase(candidate);
    return phrases.some((phrase) => candidate.includes(phrase) || compactCandidate.includes(compactIdentityPhrase(phrase)));
  });
}

function compactIdentityPhrase(value: string): string {
  return value.replace(/\s+/gu, "");
}

function hasExplicitTermBoundary(value: string): boolean {
  return /[\s._/\\-]+/u.test(value);
}

function uniqueIdentityPhrases(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function filenameStem(relPath: string): string {
  return path.basename(relPath, path.extname(relPath));
}

function pathSegments(relPath: string): string[] {
  const dirname = path.dirname(relPath);
  if (!dirname || dirname === ".") return [];
  return dirname.split(/[\\/]+/).filter(Boolean);
}
