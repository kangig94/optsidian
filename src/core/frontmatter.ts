import fs from "node:fs";
import path from "node:path";
import { isMap, isNode, isSeq, parseDocument } from "yaml";
import type { Document, Node as YAMLNode } from "yaml";
import { UsageError } from "../errors.js";
import { resolveVaultPath } from "./path.js";
import { simpleDiff } from "./text.js";
import { atomicWriteFile } from "./write-file.js";
import type { FrontmatterMutationParams, FrontmatterReadParams, FrontmatterReadResult, FrontmatterValue, MutationResult } from "./types.js";

type FrontmatterSlice = {
  bom: string;
  eol: string;
  hasFrontmatter: boolean;
  yaml: string;
  body: string;
};

type ParsedFrontmatter = {
  slice: FrontmatterSlice;
  doc: Document;
};

export function readFrontmatter(vaultRoot: string, params: FrontmatterReadParams): FrontmatterReadResult {
  const target = resolveMarkdownFile(vaultRoot, params.path);
  const text = readUtf8PreserveBom(target.abs, target.rel);
  const slice = splitFrontmatter(text);
  const doc = parseFrontmatterDocument(slice.yaml);
  return {
    ok: true,
    command: "frontmatter",
    action: "read",
    path: target.rel,
    hasFrontmatter: slice.hasFrontmatter,
    frontmatter: documentToRecord(doc)
  };
}

export function setFrontmatter(vaultRoot: string, params: FrontmatterMutationParams): MutationResult {
  const value = requireFrontmatterValue(params);
  return mutateFrontmatter(vaultRoot, params, (doc) => {
    const before = doc.has(params.key) ? nodeToValue(doc.get(params.key, true)) : undefined;
    if (before !== undefined && valuesEqual(before, value)) return false;
    doc.set(params.key, value);
    return true;
  });
}

export function deleteFrontmatter(vaultRoot: string, params: FrontmatterMutationParams): MutationResult {
  return mutateFrontmatter(vaultRoot, params, (doc) => {
    if (!doc.delete(params.key)) {
      throw new UsageError(`Frontmatter key not found: ${params.key}`);
    }
    return true;
  });
}

export function addFrontmatterValue(vaultRoot: string, params: FrontmatterMutationParams): MutationResult {
  const value = requireFrontmatterValue(params);
  return mutateFrontmatter(vaultRoot, params, (doc) => {
    if (!doc.has(params.key)) {
      doc.set(params.key, [value]);
      return true;
    }
    const node = doc.get(params.key, true);
    if (!isSeq(node)) {
      throw new UsageError(`Frontmatter key is not a list: ${params.key}`);
    }
    if (node.items.some((item) => valuesEqual(nodeToValue(item), value))) return false;
    node.add(value);
    return true;
  });
}

export function removeFrontmatterValue(vaultRoot: string, params: FrontmatterMutationParams): MutationResult {
  const value = requireFrontmatterValue(params);
  return mutateFrontmatter(vaultRoot, params, (doc) => {
    if (!doc.has(params.key)) {
      throw new UsageError(`Frontmatter key not found: ${params.key}`);
    }
    const node = doc.get(params.key, true);
    if (!isSeq(node)) {
      throw new UsageError(`Frontmatter key is not a list: ${params.key}`);
    }
    const index = node.items.findIndex((item) => valuesEqual(nodeToValue(item), value));
    if (index === -1) {
      throw new UsageError(`Frontmatter list value not found for key: ${params.key}`);
    }
    node.items.splice(index, 1);
    return true;
  });
}

function mutateFrontmatter(vaultRoot: string, params: FrontmatterMutationParams, mutator: (doc: Document) => boolean): MutationResult {
  validateFrontmatterKey(params.key);
  const target = resolveMarkdownFile(vaultRoot, params.path);
  const before = readUtf8PreserveBom(target.abs, target.rel);
  const parsed = parseFrontmatter(before);
  const changed = mutator(parsed.doc);
  if (!changed) {
    return {
      ok: true,
      command: "frontmatter",
      dryRun: Boolean(params.dryRun),
      changes: [],
      message: "No changes."
    };
  }
  const after = renderFrontmatter(parsed.slice, parsed.doc);
  if (before === after) {
    return {
      ok: true,
      command: "frontmatter",
      dryRun: Boolean(params.dryRun),
      changes: [],
      message: "No changes."
    };
  }
  if (!params.dryRun) {
    atomicWriteFile(target.abs, after);
  }
  return {
    ok: true,
    command: "frontmatter",
    dryRun: Boolean(params.dryRun),
    changes: [{ code: "M", path: target.rel, before, after, diff: simpleDiff(target.rel, before, after) }]
  };
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const slice = splitFrontmatter(text);
  return { slice, doc: parseFrontmatterDocument(slice.yaml) };
}

function splitFrontmatter(text: string): FrontmatterSlice {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? text.slice(1) : text;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const first = readLine(content, 0);
  if (!first || first.text.trim() !== "---") {
    return { bom, eol, hasFrontmatter: false, yaml: "", body: content };
  }

  let cursor = first.next;
  const yamlStart = cursor;
  while (cursor <= content.length) {
    const line = readLine(content, cursor);
    if (!line) break;
    const trimmed = line.text.trim();
    if (trimmed === "---" || trimmed === "...") {
      return {
        bom,
        eol,
        hasFrontmatter: true,
        yaml: content.slice(yamlStart, cursor),
        body: content.slice(line.next)
      };
    }
    if (line.next === cursor) break;
    cursor = line.next;
  }

  throw new UsageError("Frontmatter opening delimiter has no closing delimiter");
}

function readLine(text: string, start: number): { text: string; next: number } | undefined {
  if (start > text.length) return undefined;
  if (start === text.length) return { text: "", next: start };
  const lf = text.indexOf("\n", start);
  if (lf === -1) return { text: text.slice(start), next: text.length };
  const lineEnd = lf > start && text[lf - 1] === "\r" ? lf - 1 : lf;
  return { text: text.slice(start, lineEnd), next: lf + 1 };
}

function parseFrontmatterDocument(yamlText: string): Document {
  const doc = parseDocument(yamlText, {
    strict: true,
    stringKeys: true,
    keepSourceTokens: true
  });
  if (doc.errors.length > 0) {
    throw new UsageError(`Invalid frontmatter YAML: ${doc.errors.map((error) => error.message).join("; ")}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new UsageError("Frontmatter root must be a YAML mapping");
  }
  return doc;
}

function renderFrontmatter(slice: FrontmatterSlice, doc: Document): string {
  const yaml = documentToYaml(doc, slice.eol);
  return `${slice.bom}---${slice.eol}${yaml}---${slice.eol}${slice.body}`;
}

function documentToYaml(doc: Document, eol: string): string {
  if (Object.keys(documentToRecord(doc)).length === 0) return "";
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\r\n|\n/g, eol);
  return yaml.endsWith(eol) ? yaml : `${yaml}${eol}`;
}

function documentToRecord(doc: Document): Record<string, FrontmatterValue> {
  const value = doc.toJSON();
  if (value === null || value === undefined) return {};
  const normalized = normalizeFrontmatterValue(value, "frontmatter");
  if (!isPlainObject(normalized)) {
    throw new UsageError("Frontmatter root must be a YAML mapping");
  }
  return normalized;
}

function requireFrontmatterValue(params: FrontmatterMutationParams): FrontmatterValue {
  if (!("value" in params)) {
    throw new UsageError("Missing required frontmatter value");
  }
  return normalizeFrontmatterValue(params.value, "value");
}

function nodeToValue(node: unknown): FrontmatterValue {
  const value = isNode(node) ? JSON.parse(JSON.stringify(node as YAMLNode)) : node;
  return normalizeFrontmatterValue(value, "value");
}

function normalizeFrontmatterValue(value: unknown, label: string): FrontmatterValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UsageError(`${label} must be JSON-compatible`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeFrontmatterValue(item, `${label}[${index}]`));
  if (isPlainObject(value)) {
    const output: Record<string, FrontmatterValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = normalizeFrontmatterValue(item, `${label}.${key}`);
    }
    return output;
  }
  throw new UsageError(`${label} must be JSON-compatible`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateFrontmatterKey(key: string): void {
  if (!key.trim()) throw new UsageError("key must not be empty");
  if (/[\r\n]/.test(key)) throw new UsageError("key must be a single line");
}

function resolveMarkdownFile(vaultRoot: string, input: string): { abs: string; rel: string } {
  const target = resolveVaultPath(vaultRoot, input, { mustExist: true });
  if (!fs.statSync(target.abs).isFile()) {
    throw new UsageError(`Path is not a file: ${target.rel}`);
  }
  if (path.extname(target.rel).toLowerCase() !== ".md") {
    throw new UsageError(`Frontmatter tools only support Markdown files: ${target.rel}`);
  }
  return target;
}

function valuesEqual(a: FrontmatterValue, b: FrontmatterValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (!valuesEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) => valuesEqual(a[key], b[key]));
  }
  return false;
}

function readUtf8PreserveBom(abs: string, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(abs));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
