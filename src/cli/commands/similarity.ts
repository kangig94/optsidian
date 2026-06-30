import {
  getValue,
  parsePositiveInt,
  readRawValueOrFile,
  readValueOrFile,
  type ParsedArgs
} from "../args.js";
import { parseFormat, renderSimilarity } from "../render.js";
import { normalizeSimilarityParams } from "../../core/similarity.js";
import { createSearchDaemonClient } from "../../daemon/client.js";
import type {
  RetrieveOrigin,
  RetrieveResult,
  SimilarityFilterValue,
  SimilarityFrontmatterFilter,
  SimilarityMarkdownProjection,
  SimilarityMode,
  SimilarityParams,
  SimilarityProjectionField,
  SimilarityReference,
  SimilarityResult
} from "../../core/types.js";
import { UsageError } from "../../errors.js";

const SIMILARITY_FIELDS = ["title", "body", "aliases", "headings", "tags"] as const;
const DEFAULT_RETRIEVE_PROJECTION_VERSION = "title-body-plain-strip-frontmatter-v1";

export async function runSimilarity(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const request = normalizeSimilarityParams(similarityRequestFromArgs(args));
  const result = similarityResultFromRetrieve(
    await createSearchDaemonClient().retrieve({
      vault: vaultRoot,
      ...retrievePayloadFromSimilarity(request)
    }),
    request
  );
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
  const paths = scopePathsFromArgs(args);
  const pathGlob = pathGlobFromArgs(args);
  const frontmatter = frontmatterFilterFromArgs(args);
  if (!path && !paths && !pathGlob && !frontmatter) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(paths ? { paths } : {}),
    ...(pathGlob ? { pathGlob } : {}),
    ...(frontmatter ? { frontmatter: [frontmatter] } : {})
  };
}

function scopePathsFromArgs(args: ParsedArgs): string[] | undefined {
  const raw = getValue(args, "paths");
  const rawJson = getValue(args, "paths-json");
  if (raw !== undefined && rawJson !== undefined) throw new UsageError("Use either paths=<path,...> or paths-json=<json>, not both");
  if (rawJson !== undefined) return parsePathsJson(rawJson);
  if (raw === undefined) return undefined;
  const paths = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (paths.length === 0) throw new UsageError("paths must include at least one path");
  return paths;
}

function parsePathsJson(value: string): string[] {
  const raw = readRawValueOrFile(value);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new UsageError("paths-json must be a JSON array");
    return parsed.map((item, index) => {
      if (typeof item !== "string") throw new UsageError(`paths-json[${index}] must be a string`);
      return item;
    });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid paths-json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pathGlobFromArgs(args: ParsedArgs): string | undefined {
  const raw = getValue(args, "path-glob");
  if (raw === undefined) return undefined;
  const pathGlob = raw.trim();
  if (!pathGlob) throw new UsageError("path-glob must not be empty");
  return pathGlob;
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

export function retrievePayloadFromSimilarity(request: ReturnType<typeof normalizeSimilarityParams>) {
  assertRetrieveSupportedSimilarityRequest(request);
  const origin: RetrieveOrigin = request.mode === "left"
    ? request.left?.text !== undefined ? "text" : "note"
    : request.mode === "pair" ? "pair" : "global";
  return {
    origin,
    text: request.left?.text,
    sourcePath: request.left?.path,
    path: request.scope.path,
    left: request.left,
    right: request.right,
    topK: request.topK,
    limit: request.topK,
    minScore: request.minScore,
    providerModel: request.provider.model === "default" ? undefined : request.provider.model,
    query: request.left?.text
  };
}

function assertRetrieveSupportedSimilarityRequest(request: ReturnType<typeof normalizeSimilarityParams>): void {
  if (request.mode === "global") {
    throw new UsageError("similarity mode=global is not supported by Retrieve yet; use mode=left or mode=pair");
  }
  if (request.scope.paths.length > 0) {
    throw new UsageError("similarity scope.paths is not supported by Retrieve yet; use path=<directory-or-file>");
  }
  if (request.scope.pathGlob) {
    throw new UsageError("similarity path-glob is not supported by Retrieve yet; use path=<directory-or-file>");
  }
  if (request.scope.frontmatter.length > 0) {
    throw new UsageError("similarity frontmatter filters are not supported by Retrieve yet");
  }
  if (request.projection.version !== DEFAULT_RETRIEVE_PROJECTION_VERSION) {
    throw new UsageError("similarity projection flags are not supported by Retrieve yet; use the default title+body plain projection");
  }
  if (request.mode === "pair" && (request.left?.text !== undefined || request.right?.text !== undefined)) {
    throw new UsageError("similarity mode=pair requires left=<path> and right=<path>; pair text inputs are not supported by Retrieve yet");
  }
}

export function similarityResultFromRetrieve(
  retrieve: RetrieveResult,
  request: ReturnType<typeof normalizeSimilarityParams>
): SimilarityResult {
  return {
    ok: true,
    command: "similarity",
    schemaVersion: 1,
    available: retrieve.available,
    status: retrieve.status,
    origin: retrieve.origin,
    request,
    matches: retrieve.matches,
    results: retrieve.results.map((result) => ({
      path: result.path,
      title: result.title,
      score: result.score,
      tags: result.tags,
      snippets: result.snippets,
      ...(result.debug ? { debug: result.debug } : {})
    })),
    ...(retrieve.status === "ready" ? {
      snapshotId: retrieve.snapshotId,
      retrievalSnapshotId: retrieve.retrievalSnapshotId
    } : { reason: retrieve.reason }),
    ...(retrieve.warnings ? { warnings: retrieve.warnings } : {})
  };
}
