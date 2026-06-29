import {
  getValue,
  parsePositiveInt,
  readRawValueOrFile,
  readValueOrFile,
  type ParsedArgs
} from "../args.js";
import { parseFormat, renderSimilarity } from "../render.js";
import { similarityUnavailableResult } from "../../core/similarity.js";
import type {
  SimilarityFilterValue,
  SimilarityFrontmatterFilter,
  SimilarityMarkdownProjection,
  SimilarityMode,
  SimilarityParams,
  SimilarityProjectionField,
  SimilarityReference
} from "../../core/types.js";
import { UsageError } from "../../errors.js";

const SIMILARITY_FIELDS = ["title", "body", "aliases", "headings", "tags"] as const;

export function runSimilarity(args: ParsedArgs, vaultRoot: string): void {
  const result = similarityUnavailableResult(vaultRoot, similarityRequestFromArgs(args));
  process.stdout.write(renderSimilarity(result, parseFormat(getValue(args, "format"))));
}

export function similarityRequestFromArgs(args: ParsedArgs): SimilarityParams {
  if (args.positionals.length > 0) {
    throw new UsageError("similarity does not accept positional arguments; use key=value arguments");
  }
  const requestJson = getValue(args, "request-json");
  if (requestJson !== undefined) return parseRequestJson(requestJson);
  const scope = similarityScopeFromArgs(args);
  const projection = similarityProjectionFromArgs(args);
  const provider = getValue(args, "model") !== undefined
    ? { model: getValue(args, "model") }
    : undefined;
  const left = similarityReferenceFromArgs(args, "left");
  const right = similarityReferenceFromArgs(args, "right");
  return {
    mode: parseSimilarityMode(getValue(args, "mode")),
    ...(scope ? { scope } : {}),
    ...(projection ? { projection } : {}),
    ...(provider ? { provider } : {}),
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    ...(getValue(args, "top-k") !== undefined ? { topK: parsePositiveInt(getValue(args, "top-k"), "top-k") } : {}),
    ...(getValue(args, "min-score") !== undefined ? { minScore: parseScore(getValue(args, "min-score"), "min-score") } : {})
  };
}

function parseRequestJson(value: string): SimilarityParams {
  const raw = readRawValueOrFile(value);
  try {
    const parsed = JSON.parse(raw) as SimilarityParams;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError("request-json must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid request-json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSimilarityMode(value: string | undefined): SimilarityMode | undefined {
  if (value === undefined) return undefined;
  const mode = value.trim().toLowerCase();
  if (mode !== "global" && mode !== "left" && mode !== "pair") {
    throw new UsageError("mode must be global, left, or pair");
  }
  return mode;
}

function similarityScopeFromArgs(args: ParsedArgs): SimilarityParams["scope"] | undefined {
  const path = getValue(args, "path")?.trim();
  const frontmatter = frontmatterFilterFromArgs(args);
  if (!path && !frontmatter) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(frontmatter ? { frontmatter: [frontmatter] } : {})
  };
}

function frontmatterFilterFromArgs(args: ParsedArgs): SimilarityFrontmatterFilter | undefined {
  const key = getValue(args, "frontmatter-key")?.trim();
  const value = getValue(args, "frontmatter-value");
  const valueJson = getValue(args, "frontmatter-value-json");
  if (!key && value === undefined && valueJson === undefined) return undefined;
  if (!key) throw new UsageError("frontmatter-key=<key> is required when filtering by frontmatter");
  if (value !== undefined && valueJson !== undefined) {
    throw new UsageError("Use either frontmatter-value=<value> or frontmatter-value-json=<json>, not both");
  }
  if (value === undefined && valueJson === undefined) {
    throw new UsageError("frontmatter filter requires frontmatter-value=<value> or frontmatter-value-json=<json>");
  }
  return {
    key,
    op: "eq",
    value: valueJson !== undefined ? parseFilterValueJson(valueJson) : value as string
  };
}

function parseFilterValueJson(value: string): SimilarityFilterValue {
  const raw = readRawValueOrFile(value);
  try {
    const parsed = JSON.parse(raw) as SimilarityFilterValue;
    if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return parsed;
    }
    throw new UsageError("frontmatter-value-json must be null, string, number, or boolean");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid frontmatter-value-json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function similarityProjectionFromArgs(args: ParsedArgs): SimilarityParams["projection"] | undefined {
  const fields = projectionFieldsFromArgs(args);
  const stripFrontmatter = booleanValue(getValue(args, "strip-frontmatter"), "strip-frontmatter");
  const markdown = markdownProjection(getValue(args, "markdown"));
  if (!fields && stripFrontmatter === undefined && markdown === undefined) return undefined;
  return {
    ...(fields ? { fields } : {}),
    ...(stripFrontmatter !== undefined ? { stripFrontmatter } : {}),
    ...(markdown ? { markdown } : {})
  };
}

function projectionFieldsFromArgs(args: ParsedArgs): SimilarityProjectionField[] | undefined {
  const raw = getValue(args, "field") ?? getValue(args, "fields");
  if (raw === undefined) return undefined;
  const fields = raw.split(",").map((field) => field.trim()).filter(Boolean);
  if (fields.length === 0) throw new UsageError(`field must include at least one of: ${SIMILARITY_FIELDS.join(", ")}`);
  for (const field of fields) {
    if (!SIMILARITY_FIELDS.includes(field as SimilarityProjectionField)) {
      throw new UsageError(`field must be one of: ${SIMILARITY_FIELDS.join(", ")}`);
    }
  }
  return fields as SimilarityProjectionField[];
}

function booleanValue(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new UsageError(`${name} must be true or false`);
}

function markdownProjection(value: string | undefined): SimilarityMarkdownProjection | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized !== "plain" && normalized !== "raw") {
    throw new UsageError("markdown must be plain or raw");
  }
  return normalized;
}

function similarityReferenceFromArgs(args: ParsedArgs, side: "left" | "right"): SimilarityReference | undefined {
  const path = getValue(args, side)?.trim();
  const text = getValue(args, `${side}-text`);
  const id = getValue(args, `${side}-id`)?.trim();
  if (!path && text === undefined && !id) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(text !== undefined ? { text: readValueOrFile(text) } : {}),
    ...(id ? { id } : {})
  };
}

function parseScore(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${name} must be a number`);
  return parsed;
}
