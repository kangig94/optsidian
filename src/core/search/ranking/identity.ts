import path from "node:path";
import type { SearchDocument } from "../markdown.js";
import { EXACT_PRIORITY, PHRASE_PRIORITY } from "../constants.js";
import type { QueryContext } from "../internal-types.js";

export function bestExactPriority(doc: SearchDocument, context: QueryContext): number {
  const priorities: number[] = [];
  if (context.allowed.has("title") && normalizeIdentityText(doc.title) === context.phrase) priorities.push(EXACT_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => normalizeIdentityText(alias) === context.phrase)) {
    priorities.push(EXACT_PRIORITY.alias);
  }
  if (context.allowed.has("path") && normalizeIdentityText(filenameStem(doc.path)) === context.phrase) {
    priorities.push(EXACT_PRIORITY.filenameStem);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

export function bestPhrasePriority(doc: SearchDocument, context: QueryContext): number {
  if (!context.phrase) return Number.POSITIVE_INFINITY;
  const priorities: number[] = [];
  if (context.allowed.has("title") && containsNormalizedPhrase(doc.title, context.phrase)) priorities.push(PHRASE_PRIORITY.title);
  if (context.allowed.has("aliases") && doc.aliases.some((alias) => containsNormalizedPhrase(alias, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.alias);
  }
  if (context.allowed.has("path") && containsNormalizedPhrase(filenameStem(doc.path), context.phrase)) {
    priorities.push(PHRASE_PRIORITY.filenameStem);
  }
  if (context.allowed.has("path") && pathSegments(doc.path).some((segment) => containsNormalizedPhrase(segment, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.pathSegment);
  }
  if (context.allowed.has("headings") && doc.headings.some((heading) => containsNormalizedPhrase(heading, context.phrase))) {
    priorities.push(PHRASE_PRIORITY.heading);
  }
  return priorities.length > 0 ? Math.min(...priorities) : Number.POSITIVE_INFINITY;
}

export function normalizeIdentityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/#/g, " ")
    .replace(/[._/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNormalizedPhrase(value: string, phrase: string): boolean {
  const normalized = normalizeIdentityText(value);
  return normalized.length > 0 && normalized.includes(phrase);
}

function filenameStem(relPath: string): string {
  return path.basename(relPath, path.extname(relPath));
}

function pathSegments(relPath: string): string[] {
  const dirname = path.dirname(relPath);
  if (!dirname || dirname === ".") return [];
  return dirname.split(/[\\/]+/).filter(Boolean);
}
