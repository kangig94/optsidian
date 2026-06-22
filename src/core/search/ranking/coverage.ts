import type { SearchDocument } from "../markdown.js";
import { COVERAGE_FIELD_WEIGHT, type CoverageField } from "../constants.js";
import type { QueryContext } from "../internal-types.js";

export function metadataCoverage(doc: SearchDocument, context: QueryContext): { terms: number; fieldScore: number } {
  if (context.terms.length === 0) return { terms: 0, fieldScore: 0 };
  const values: Array<[CoverageField, string[]]> = [
    ["title", context.allowed.has("title") ? fieldTokens(doc.titleTokens) : []],
    ["aliases", context.allowed.has("aliases") ? fieldTokens(doc.aliasesTokens) : []],
    ["tags", context.allowed.has("tags") ? fieldTokens(doc.tagsTokens) : []],
    ["headings", context.allowed.has("headings") ? fieldTokens(doc.headingsTokens) : []],
    ["path", context.allowed.has("path") ? fieldTokens(doc.pathTokens) : []]
  ];

  let matchedTerms = 0;
  let fieldScore = 0;
  for (const term of context.terms) {
    let matched = false;
    for (const [field, entries] of values) {
      if (entries.includes(term)) {
        matched = true;
        fieldScore += COVERAGE_FIELD_WEIGHT[field];
      }
    }
    if (matched) matchedTerms += 1;
  }

  return { terms: matchedTerms, fieldScore };
}

function fieldTokens(value: string): string[] {
  return value.split(" ").filter(Boolean);
}
