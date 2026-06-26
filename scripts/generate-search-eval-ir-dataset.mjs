#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const vaultRoot = args.vault ?? process.env.OPTSIDIAN_VAULT_PATH;

if (!vaultRoot) usage("Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.");
if (args.datasets.length === 0) usage("Missing --dataset=<ir_datasets id>.");

const resolvedVault = path.resolve(vaultRoot);
const outputDir = args.outDir ? path.resolve(args.outDir) : path.join(resolvedVault, "SearchEval");
const workDir = args.workDir ? path.resolve(args.workDir) : path.join(outputDir, "ir-datasets");
const fixtureName = args.fixtureName ?? args.datasets.map((datasetId) => safeSegment(datasetId, 40)).join("__");
const allQueries = [];
const datasetReports = [];

if (args.clean) {
  removeInsideVault("IR");
}

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

for (const datasetId of args.datasets) {
  const datasetSlug = safeSegment(datasetId, 64);
  const exportPath = path.join(workDir, `${datasetSlug}.export.json`);
  runExporter(datasetId, exportPath);
  const payload = readJson(exportPath);
  const report = writeDatasetVault(payload, datasetSlug);
  datasetReports.push(report);
  allQueries.push(...report.queries.map((query) => ({ ...query, path: "IR" })));
  writeSpec(path.join(outputDir, `ir.${datasetSlug}.queries.json`), report.queries, {
    fixture: datasetSlug,
    datasets: [datasetId],
    scopedPath: report.root
  });
}

writeSpec(path.join(outputDir, `ir.${fixtureName}.queries.json`), allQueries, {
  fixture: fixtureName,
  datasets: args.datasets,
  scopedPath: "IR"
});
writeSpec(path.join(outputDir, "queries.json"), allQueries, {
  fixture: fixtureName,
  datasets: args.datasets,
  scopedPath: "IR"
});
writeSummary(path.join(outputDir, `ir.${fixtureName}.summary.json`), datasetReports);

console.log(`wrote IR dataset vault under ${path.join(resolvedVault, "IR")}`);
for (const report of datasetReports) {
  console.log(`wrote ${report.datasetId}: ${report.documentsWritten} notes, ${report.queries.length} queries`);
}
console.log(`wrote ${path.join(outputDir, `ir.${fixtureName}.queries.json`)} (${allQueries.length} queries)`);

function runExporter(datasetId, exportPath) {
  const exporter = path.join(repoRoot, "scripts", "export-ir-dataset.py");
  const uv = args.uv ?? process.env.UV ?? "uv";
  const uvArgs = [
    "run",
    "--with",
    "ir_datasets",
    "python",
    exporter,
    "--dataset",
    datasetId,
    "--output",
    exportPath,
    "--max-queries",
    String(args.maxQueries),
    "--max-qrels-per-query",
    String(args.maxQrelsPerQuery),
    "--min-relevance",
    String(args.minRelevance),
    "--max-background-docs",
    String(args.maxBackgroundDocs)
  ];
  const env = { ...process.env };
  if (args.irHome) env.IR_DATASETS_HOME = path.resolve(args.irHome);
  const result = spawnSync(uv, uvArgs, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error) {
    throw new Error(`Failed to run ${uv}: ${result.error.message}. Install uv and retry.`);
  }
  if (result.status !== 0) {
    throw new Error(`${uv} ${uvArgs.join(" ")} failed with exit code ${result.status}`);
  }
}

function writeDatasetVault(payload, datasetSlug) {
  const datasetId = payload.dataset?.id;
  if (!datasetId) throw new Error("Exporter payload is missing dataset.id");
  const root = `IR/${datasetSlug}`;
  const documentPathById = new Map();
  let documentsWritten = 0;

  for (const document of payload.documents ?? []) {
    const docId = String(document.docId);
    const fields = document.fields ?? {};
    const relPath = `${root}/${safeSegment(docId, 96)}.md`;
    documentPathById.set(docId, relPath);
    writeNote(relPath, noteFrontmatter({ datasetId, docId, fields }), noteBody({ datasetId, docId, fields }));
    documentsWritten += 1;
  }

  const queries = [];
  for (const query of payload.queries ?? []) {
    const relevance = {};
    for (const qrel of query.qrels ?? []) {
      const relPath = documentPathById.get(String(qrel.doc_id));
      if (!relPath) continue;
      relevance[relPath] = qrel.relevance;
    }
    const positives = Object.entries(relevance)
      .filter(([, score]) => Number(score) > 0)
      .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]));
    if (positives.length === 0) continue;
    queries.push({
      task: datasetId,
      dataset: datasetId,
      queryId: String(query.queryId),
      query: query.text,
      expected: positives[0][0],
      relevance,
      path: root,
      limit: 10
    });
  }

  return {
    datasetId,
    root,
    sourceCounts: payload.dataset,
    exportOptions: payload.options,
    irDatasetsVersion: payload.irDatasetsVersion,
    documentsWritten,
    missingDocIds: payload.missingDocIds ?? [],
    queries
  };
}

function noteFrontmatter({ datasetId, docId, fields }) {
  const title = titleForDoc(docId, fields);
  const language = languageForDataset(datasetId);
  const metadata = {};
  for (const key of ["url", "pubmed_id"]) {
    if (fields[key] !== undefined && fields[key] !== null && String(fields[key]).trim()) metadata[key] = fields[key];
  }
  return {
    title,
    aliases: unique([docId]),
    tags: unique(["search-eval", "ir-dataset", language ? `ir-${language}` : undefined]),
    source: `ir_datasets:${datasetId}`,
    ir_dataset: datasetId,
    source_doc_id: docId,
    language,
    split: splitForDataset(datasetId),
    ...metadata
  };
}

function noteBody({ datasetId, docId, fields }) {
  const title = titleForDoc(docId, fields);
  const text = bodyText(fields);
  const lines = [
    `# ${title}`,
    "",
    `- IR dataset: ${datasetId}`,
    `- Source doc id: ${docId}`,
    fields.url ? `- URL: ${fields.url}` : undefined,
    "",
    "## Text",
    "",
    text || "(empty text)"
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

function titleForDoc(docId, fields) {
  const title = typeof fields.title === "string" ? fields.title.trim() : "";
  if (title) return title;
  return `IR document ${docId}`;
}

function bodyText(fields) {
  const parts = [];
  for (const key of ["text", "body", "abstract", "narrative"]) {
    const value = fields[key];
    const text = textValue(value);
    if (text) parts.push(text);
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(fields)) {
      if (["doc_id", "title", "url", "pubmed_id"].includes(key)) continue;
      const text = textValue(value);
      if (text) parts.push(text);
    }
  }
  return unique(parts).join("\n\n");
}

function textValue(value) {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(textValue).filter(Boolean).join("\n");
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function writeNote(relPath, frontmatter, body) {
  const filePath = path.join(resolvedVault, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.trimEnd()}\n`);
}

function writeSpec(filePath, queries, metadata) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 2, ...metadata, queries }, null, 2)}\n`);
}

function writeSummary(filePath, reports) {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: "scripts/generate-search-eval-ir-dataset.mjs",
    uv: args.uv ?? process.env.UV ?? "uv",
    datasets: reports.map(({ queries, ...report }) => ({
      ...report,
      queriesWritten: queries.length
    }))
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function removeInsideVault(relPath) {
  const target = path.resolve(resolvedVault, relPath);
  const relative = path.relative(resolvedVault, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing to remove outside vault: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function languageForDataset(datasetId) {
  const parts = datasetId.split("/");
  if (parts.includes("ko")) return "ko";
  if (parts.includes("en")) return "en";
  if (datasetId.startsWith("beir/")) return "en";
  return undefined;
}

function splitForDataset(datasetId) {
  const parts = datasetId.split("/").filter(Boolean);
  return parts.at(-1);
}

function safeSegment(value, maxLength) {
  const raw = String(value);
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  const normalized = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_") || "item";
  const limit = Math.max(1, maxLength - hash.length - 1);
  const base = normalized.slice(0, limit).replace(/[._-]+$/g, "") || "item";
  return `${base}-${hash}`;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).length > 0))];
}

function parseArgs(argv) {
  const parsed = {
    datasets: [],
    maxQueries: 50,
    maxQrelsPerQuery: 0,
    minRelevance: 1,
    maxBackgroundDocs: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(undefined, 0);
    if (arg === "--clean") {
      parsed.clean = true;
    } else if (arg.startsWith("--vault=")) {
      parsed.vault = arg.slice("--vault=".length);
    } else if (arg.startsWith("--vault-path=")) {
      parsed.vault = arg.slice("--vault-path=".length);
    } else if (arg.startsWith("vault-path=")) {
      parsed.vault = arg.slice("vault-path=".length);
    } else if (arg.startsWith("--dataset=")) {
      parsed.datasets.push(...arg.slice("--dataset=".length).split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg.startsWith("--datasets=")) {
      parsed.datasets.push(...arg.slice("--datasets=".length).split(",").map((value) => value.trim()).filter(Boolean));
    } else if (arg.startsWith("--max-queries=")) {
      parsed.maxQueries = parseNonnegativeInt(arg.slice("--max-queries=".length), "max-queries");
    } else if (arg.startsWith("--max-qrels-per-query=")) {
      parsed.maxQrelsPerQuery = parseAllOrNonnegativeInt(arg.slice("--max-qrels-per-query=".length), "max-qrels-per-query");
    } else if (arg.startsWith("--min-relevance=")) {
      parsed.minRelevance = Number(arg.slice("--min-relevance=".length));
      if (!Number.isFinite(parsed.minRelevance)) usage("--min-relevance must be numeric");
    } else if (arg.startsWith("--background-docs=")) {
      parsed.maxBackgroundDocs = parseNonnegativeInt(arg.slice("--background-docs=".length), "background-docs");
    } else if (arg.startsWith("--max-background-docs=")) {
      parsed.maxBackgroundDocs = parseNonnegativeInt(arg.slice("--max-background-docs=".length), "max-background-docs");
    } else if (arg.startsWith("--fixture-name=")) {
      parsed.fixtureName = safeSegment(arg.slice("--fixture-name=".length), 80);
    } else if (arg.startsWith("--out-dir=")) {
      parsed.outDir = arg.slice("--out-dir=".length);
    } else if (arg.startsWith("--work-dir=")) {
      parsed.workDir = arg.slice("--work-dir=".length);
    } else if (arg.startsWith("--ir-home=")) {
      parsed.irHome = arg.slice("--ir-home=".length);
    } else if (arg.startsWith("--uv=")) {
      parsed.uv = arg.slice("--uv=".length);
    } else if (!parsed.vault) {
      parsed.vault = arg;
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseAllOrNonnegativeInt(value, name) {
  if (value === "all") return 0;
  return parseNonnegativeInt(value, name);
}

function parseNonnegativeInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) usage(`--${name} must be a non-negative integer`);
  return number;
}

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error("Usage: node scripts/generate-search-eval-ir-dataset.mjs <vault-path> --dataset=<ir_datasets id> [--dataset=<id> ...] [--clean]");
  console.error("       npm run search:eval:ir-vault -- <vault-path> --dataset=miracl/ko/dev --dataset=beir/nfcorpus/test --max-queries=50");
  console.error("       Options: [--max-qrels-per-query=<n|all>] [--background-docs=<n>] [--ir-home=<dir>] [--uv=<uv>]");
  process.exit(code);
}
