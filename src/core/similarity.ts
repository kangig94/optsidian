import { UsageError } from "../errors.js";
import { assertOptionalPositiveInteger } from "./validation.js";
import type {
  NormalizedSimilarityParams,
  SimilarityFilterValue,
  SimilarityFrontmatterFilter,
  SimilarityMarkdownProjection,
  SimilarityMode,
  SimilarityParams,
  SimilarityProjectionField,
  SimilarityReference,
  SimilarityResult
} from "./types.js";

const SIMILARITY_SCHEMA_VERSION = 1;
const DEFAULT_SIMILARITY_MODEL = "default";
const DEFAULT_SIMILARITY_TOP_K = 10;
const DEFAULT_SIMILARITY_MIN_SCORE = 0;
const SIMILARITY_PROJECTION_FIELDS: readonly SimilarityProjectionField[] = ["title", "body", "aliases", "headings", "tags"];

export function similarityUnavailableResult(_vaultRoot: string, params: SimilarityParams = {}): SimilarityResult {
  const request = normalizeSimilarityParams(params);
  const reason = "Vector similarity provider is not configured.";
  return {
    ok: true,
    command: "similarity",
    schemaVersion: SIMILARITY_SCHEMA_VERSION,
    available: false,
    status: "provider-unavailable",
    request,
    model: {
      requested: request.provider.model,
      resolved: null,
      metric: "cosine"
    },
    provider: {
      status: "unavailable",
      reason
    },
    results: [],
    cache: {
      key: null,
      hits: 0,
      misses: 0
    },
    fallback: {
      available: true,
      strategy: "lexical",
      reason: "Use existing lexical/search scoring until a vector provider is available."
    }
  };
}

export function normalizeSimilarityParams(params: SimilarityParams = {}): NormalizedSimilarityParams {
  if (!isRecord(params)) throw new UsageError("similarity request must be an object");
  if (params.provider !== undefined && !isRecord(params.provider)) throw new UsageError("provider must be an object");
  const mode = normalizeSimilarityMode(params.mode);
  const scope = normalizeSimilarityScope(params.scope);
  const projection = normalizeSimilarityProjection(params.projection);
  const provider = {
    model: normalizeProviderModel(params.provider?.model)
  };
  const left = normalizeSimilarityReference(params.left, "left");
  const right = normalizeSimilarityReference(params.right, "right");
  const topK = params.topK ?? DEFAULT_SIMILARITY_TOP_K;
  assertOptionalPositiveInteger(topK, "topK");
  const minScore = normalizeMinScore(params.minScore);
  validateSimilarityModeReferences(mode, left, right);
  return {
    mode,
    scope,
    projection,
    provider,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    topK,
    minScore
  };
}

function normalizeSimilarityMode(mode: SimilarityMode | undefined): SimilarityMode {
  if (mode === undefined) return "global";
  if (mode !== "global" && mode !== "left" && mode !== "pair") {
    throw new UsageError("similarity mode must be global, left, or pair");
  }
  return mode;
}

function normalizeSimilarityScope(scope: SimilarityParams["scope"]): NormalizedSimilarityParams["scope"] {
  if (scope !== undefined && !isRecord(scope)) throw new UsageError("scope must be an object");
  if (scope?.path !== undefined && typeof scope.path !== "string") throw new UsageError("scope.path must be a string");
  const frontmatter = scope?.frontmatter ?? [];
  if (!Array.isArray(frontmatter)) throw new UsageError("scope.frontmatter must be an array");
  return {
    ...(scope?.path?.trim() ? { path: scope.path.trim() } : {}),
    frontmatter: normalizeFrontmatterFilters(frontmatter)
  };
}

function normalizeFrontmatterFilters(filters: readonly SimilarityFrontmatterFilter[]): SimilarityFrontmatterFilter[] {
  return filters.map((filter, index) => {
    if (!isRecord(filter)) throw new UsageError(`scope.frontmatter[${index}] must be an object`);
    if (typeof filter.key !== "string") throw new UsageError(`scope.frontmatter[${index}].key must be a string`);
    const key = filter.key.trim();
    if (!key) throw new UsageError(`scope.frontmatter[${index}].key must not be empty`);
    if (filter.op !== "eq") throw new UsageError(`scope.frontmatter[${index}].op must be eq`);
    return {
      key,
      op: "eq",
      value: normalizeFilterValue(filter.value, `scope.frontmatter[${index}].value`)
    };
  });
}

function normalizeFilterValue(value: SimilarityFilterValue, name: string): SimilarityFilterValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new UsageError(`${name} must be null, string, number, or boolean`);
}

function normalizeSimilarityProjection(projection: SimilarityParams["projection"]): NormalizedSimilarityParams["projection"] {
  if (projection !== undefined && !isRecord(projection)) throw new UsageError("projection must be an object");
  if (projection?.fields !== undefined && !Array.isArray(projection.fields)) {
    throw new UsageError("projection.fields must be an array");
  }
  if (projection?.stripFrontmatter !== undefined && typeof projection.stripFrontmatter !== "boolean") {
    throw new UsageError("projection.stripFrontmatter must be a boolean");
  }
  const fields = normalizeProjectionFields(projection?.fields);
  const stripFrontmatter = projection?.stripFrontmatter ?? true;
  const markdown = normalizeMarkdownProjection(projection?.markdown);
  return {
    fields,
    stripFrontmatter,
    markdown,
    version: similarityProjectionVersion(fields, stripFrontmatter, markdown)
  };
}

function normalizeProjectionFields(fields: readonly SimilarityProjectionField[] | undefined): SimilarityProjectionField[] {
  const raw = fields ?? ["title", "body"];
  const normalized: SimilarityProjectionField[] = [];
  for (const field of raw) {
    if (!SIMILARITY_PROJECTION_FIELDS.includes(field)) {
      throw new UsageError(`projection.fields must include only: ${SIMILARITY_PROJECTION_FIELDS.join(", ")}`);
    }
    if (!normalized.includes(field)) normalized.push(field);
  }
  if (normalized.length === 0) throw new UsageError("projection.fields must include at least one field");
  return normalized;
}

function normalizeMarkdownProjection(markdown: SimilarityMarkdownProjection | undefined): SimilarityMarkdownProjection {
  if (markdown === undefined) return "plain";
  if (markdown !== "plain" && markdown !== "raw") {
    throw new UsageError("projection.markdown must be plain or raw");
  }
  return markdown;
}

function similarityProjectionVersion(
  fields: readonly SimilarityProjectionField[],
  stripFrontmatter: boolean,
  markdown: SimilarityMarkdownProjection
): string {
  const frontmatter = stripFrontmatter ? "strip-frontmatter" : "include-frontmatter";
  return `${fields.join("-")}-${markdown}-${frontmatter}-v1`;
}

function normalizeProviderModel(model: string | undefined): string {
  if (model !== undefined && typeof model !== "string") throw new UsageError("provider.model must be a string");
  const normalized = model?.trim() || DEFAULT_SIMILARITY_MODEL;
  return normalized;
}

function normalizeSimilarityReference(reference: SimilarityReference | undefined, name: "left" | "right"): SimilarityReference | undefined {
  if (!reference) return undefined;
  if (!isRecord(reference)) throw new UsageError(`${name} must be an object`);
  if (reference.path !== undefined && typeof reference.path !== "string") throw new UsageError(`${name}.path must be a string`);
  if (reference.text !== undefined && typeof reference.text !== "string") throw new UsageError(`${name}.text must be a string`);
  if (reference.id !== undefined && typeof reference.id !== "string") throw new UsageError(`${name}.id must be a string`);
  const path = reference.path?.trim();
  const text = reference.text;
  const id = reference.id?.trim();
  if (!path && text === undefined) throw new UsageError(`${name} must include path or text`);
  if (path && text !== undefined) throw new UsageError(`${name} must use either path or text, not both`);
  return {
    ...(path ? { path } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(id ? { id } : {})
  };
}

function normalizeMinScore(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SIMILARITY_MIN_SCORE;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError("minScore must be a number between 0 and 1");
  }
  return value;
}

function validateSimilarityModeReferences(
  mode: SimilarityMode,
  left: SimilarityReference | undefined,
  right: SimilarityReference | undefined
): void {
  if (mode === "global") {
    if (left || right) throw new UsageError("similarity mode=global does not accept left or right");
    return;
  }
  if (mode === "left") {
    if (!left) throw new UsageError("similarity mode=left requires left=<path> or left-text=<text>");
    if (right) throw new UsageError("similarity mode=left does not accept right");
    return;
  }
  if (!left || !right) throw new UsageError("similarity mode=pair requires left and right");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
