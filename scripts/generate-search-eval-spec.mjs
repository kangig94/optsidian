#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const vaultRoot = args.vault ?? process.env.OPTSIDIAN_VAULT_PATH;

if (!vaultRoot) usage("Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.");

const resolvedVault = path.resolve(vaultRoot);
const outputDir = args.outDir ? path.resolve(args.outDir) : path.join(resolvedVault, "SearchEval");
const markdownFiles = listMarkdownFiles(resolvedVault);
const notes = markdownFiles.map((file) => readNote(resolvedVault, file));
const klueQueries300 = buildKlueQueries(notes);
const scifactQueries300 = await buildScifactQueries(notes, args);
const klueQueries100 = subsetKlueQueries(klueQueries300);
const scifactQueries100 = sampleEven(scifactQueries300, 100);
const mixed200 = mixedQueries(klueQueries100, scifactQueries100);
const mixed600 = mixedQueries(klueQueries300, scifactQueries300);

fs.mkdirSync(outputDir, { recursive: true });
writeSpec(path.join(outputDir, "klue100.queries.json"), klueQueries100);
writeSpec(path.join(outputDir, "klue300.queries.json"), klueQueries300);
writeSpec(path.join(outputDir, "english100.queries.json"), scifactQueries100);
writeSpec(path.join(outputDir, "english300.queries.json"), scifactQueries300);
writeSpec(path.join(outputDir, "mixed200.queries.json"), mixed200);
writeSpec(path.join(outputDir, "mixed600.queries.json"), mixed600);
writeSpec(path.join(outputDir, "queries.json"), mixed600);

console.log(`wrote ${path.join(outputDir, "klue100.queries.json")} (${klueQueries100.length} queries)`);
console.log(`wrote ${path.join(outputDir, "klue300.queries.json")} (${klueQueries300.length} queries)`);
console.log(`wrote ${path.join(outputDir, "english100.queries.json")} (${scifactQueries100.length} queries)`);
console.log(`wrote ${path.join(outputDir, "english300.queries.json")} (${scifactQueries300.length} queries)`);
console.log(`wrote ${path.join(outputDir, "mixed200.queries.json")} (${mixed200.length} queries)`);
console.log(`wrote ${path.join(outputDir, "mixed600.queries.json")} (${mixed600.length} queries)`);
console.log(`wrote ${path.join(outputDir, "queries.json")} (${mixed600.length} queries)`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(undefined, 0);
    if (arg.startsWith("--vault=")) {
      parsed.vault = arg.slice("--vault=".length);
    } else if (arg.startsWith("--vault-path=")) {
      parsed.vault = arg.slice("--vault-path=".length);
    } else if (arg.startsWith("vault-path=")) {
      parsed.vault = arg.slice("vault-path=".length);
    } else if (arg.startsWith("--out-dir=")) {
      parsed.outDir = arg.slice("--out-dir=".length);
    } else if (arg.startsWith("--scifact-queries-json=")) {
      parsed.scifactQueriesJson = arg.slice("--scifact-queries-json=".length);
    } else if (!parsed.vault) {
      parsed.vault = arg;
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function listMarkdownFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".obsidian" || entry.name === "SearchEval") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort(comparePath);
}

function readNote(root, filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error(`Missing frontmatter: ${filePath}`);
  return {
    path: slashPath(path.relative(root, filePath)),
    frontmatter: YAML.parse(match[1]),
    body: raw.slice(match[0].length)
  };
}

function buildKlueQueries(notes) {
  const byTask = new Map();
  for (const note of notes) {
    const task = note.frontmatter?.klue_task;
    if (!task) continue;
    if (!byTask.has(task)) byTask.set(task, []);
    byTask.get(task).push(note);
  }
  const taskOrder = ["ynat", "sts", "mrc", "wos"];
  const queries = [];
  for (const task of taskOrder) {
    const taskNotes = (byTask.get(task) ?? []).sort((left, right) => comparePath(left.path, right.path));
    for (const note of taskNotes) {
      queries.push({
        task,
        query: klueQuery(note, task),
        expected: note.path,
        path: "KLUE",
        limit: 10
      });
    }
  }
  assertCount("KLUE300", queries, 300);
  return queries;
}

function klueQuery(note, task) {
  if (task === "ynat") return requiredSection(note, "Headline");
  if (task === "sts") {
    const pair = requiredSection(note, "Sentence Pair");
    const sentence = pair.split(/\r?\n/).map((line) => line.match(/^2\.\s*(.+)$/)?.[1]).find(Boolean);
    if (!sentence) throw new Error(`Missing STS sentence 2: ${note.path}`);
    return sentence.trim();
  }
  if (task === "mrc") {
    const question = requiredSection(note, "Question");
    const answer = section(note.body, "Answer")?.trim();
    return answer ? `${question} ${answer}` : question;
  }
  if (task === "wos") {
    const dialogue = requiredSection(note, "Dialogue");
    const userTurns = dialogue
      .split(/\r?\n/)
      .map((line) => line.match(/^\d+\.\s*user:\s*(.+)$/)?.[1])
      .filter(Boolean);
    if (userTurns.length > 0) return userTurns[Math.floor(userTurns.length / 2)].trim();
    const firstTurn = dialogue.split(/\r?\n/).map((line) => line.match(/^\d+\.\s*(?:user|sys):\s*(.+)$/)?.[1]).find(Boolean);
    if (firstTurn) return firstTurn.trim();
    throw new Error(`Missing WOS dialogue turn: ${note.path}`);
  }
  throw new Error(`Unsupported KLUE task ${task}: ${note.path}`);
}

async function buildScifactQueries(notes, options) {
  const scifactNotes = notes
    .filter((note) => note.frontmatter?.source === "BEIR/scifact")
    .sort((left, right) => numericCompare(left.frontmatter.beir_id, right.frontmatter.beir_id));
  const queryById = options.scifactQueriesJson
    ? readScifactQueriesJson(path.resolve(options.scifactQueriesJson))
    : await fetchScifactQueries();
  const queries = [];
  for (const note of scifactNotes) {
    for (const queryId of scifactQueryIds(note)) {
      const query = queryById.get(queryId);
      if (!query) throw new Error(`Missing SciFact query text for query id ${queryId}: ${note.path}`);
      queries.push({
        queryId,
        task: "scifact",
        query,
        expected: note.path,
        path: "English",
        limit: 10
      });
    }
  }
  queries.sort((left, right) => numericCompare(left.queryId, right.queryId));
  const output = queries.map(({ queryId: _queryId, ...query }) => query);
  assertCount("English300", output, 300);
  return output;
}

function scifactQueryIds(note) {
  if (Array.isArray(note.frontmatter?.beir_query_ids)) return note.frontmatter.beir_query_ids.map(String);
  if (note.frontmatter?.beir_query_id !== undefined) return [String(note.frontmatter.beir_query_id)];
  return [];
}

function readScifactQueriesJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = filePath.endsWith(".jsonl")
    ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : jsonRows(JSON.parse(raw), filePath);
  return new Map(rows.map((row) => {
    const value = row.row ?? row;
    return [String(value._id ?? value.id), String(value.text ?? value.query)];
  }));
}

function jsonRows(payload, filePath) {
  const rows = Array.isArray(payload) ? payload : payload.rows;
  if (!Array.isArray(rows)) throw new Error(`SciFact query JSON must be an array, JSONL, or contain rows[]: ${filePath}`);
  return rows;
}

async function fetchScifactQueries() {
  const queryById = new Map();
  const pageLength = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", "BeIR/scifact");
    url.searchParams.set("config", "queries");
    url.searchParams.set("split", "queries");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(pageLength));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch SciFact queries: ${response.status} ${response.statusText}`);
    const payload = await response.json();
    total = payload.num_rows_total ?? total;
    const rows = payload.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      queryById.set(String(row.row._id), String(row.row.text));
    }
    offset += rows.length;
  }
  return queryById;
}

function requiredSection(note, heading) {
  const value = section(note.body, heading)?.trim();
  if (!value) throw new Error(`Missing section "${heading}": ${note.path}`);
  return value;
}

function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join("\n").trim();
}

function writeSpec(filePath, queries) {
  fs.writeFileSync(filePath, `${JSON.stringify({ queries }, null, 2)}\n`);
}

function subsetKlueQueries(queries) {
  const counts = { ynat: 30, sts: 20, mrc: 30, wos: 20 };
  const output = [];
  for (const task of ["ynat", "sts", "mrc", "wos"]) {
    output.push(...sampleEven(queries.filter((query) => query.task === task), counts[task]));
  }
  assertCount("KLUE100", output, 100);
  return output;
}

function mixedQueries(klueQueries, scifactQueries) {
  return [
    ...klueQueries.map(({ path: _path, ...query }) => query),
    ...scifactQueries.map(({ path: _path, ...query }) => query)
  ];
}

function sampleEven(rows, count) {
  if (count > rows.length) throw new Error(`Cannot sample ${count} rows from ${rows.length}`);
  if (count === rows.length) return [...rows];
  if (count === 1) return [rows[0]];
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    let sourceIndex = Math.round(index * (rows.length - 1) / (count - 1));
    while (seen.has(sourceIndex) && sourceIndex < rows.length - 1) sourceIndex += 1;
    while (seen.has(sourceIndex) && sourceIndex > 0) sourceIndex -= 1;
    if (seen.has(sourceIndex)) throw new Error(`Duplicate sample index ${sourceIndex}`);
    seen.add(sourceIndex);
    selected.push(rows[sourceIndex]);
  }
  return selected;
}

function assertCount(label, queries, expected) {
  if (queries.length !== expected) throw new Error(`${label} query count mismatch: expected ${expected}, got ${queries.length}`);
}

function numericCompare(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

function comparePath(left, right) {
  return left.localeCompare(right);
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error("Usage: node scripts/generate-search-eval-spec.mjs <vault-path> [--out-dir=<dir>] [--scifact-queries-json=<file>]");
  console.error("       npm run search:eval:spec -- <vault-path> [--out-dir=<dir>] [--scifact-queries-json=<file>]");
  process.exit(code);
}
