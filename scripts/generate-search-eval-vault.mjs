#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const args = parseArgs(process.argv.slice(2));
const vaultRoot = args.vault ?? process.env.OPTSIDIAN_VAULT_PATH;

if (!vaultRoot) usage("Missing vault path. Pass it as the first argument or set OPTSIDIAN_VAULT_PATH.");
if (!args.klueRepo) usage("Missing --klue-repo=<path>.");
if (!args.scifactDir) usage("Missing --scifact-dir=<path>.");

const resolvedVault = path.resolve(vaultRoot);
const klueRepo = path.resolve(args.klueRepo);
const scifactDir = resolveScifactDir(path.resolve(args.scifactDir));
const outputDir = args.outDir ? path.resolve(args.outDir) : path.join(resolvedVault, "SearchEval");

const KLUE_FULL_COUNTS = { ynat: 90, sts: 60, mrc: 90, wos: 60 };
const KLUE_SUBSET_COUNTS = { ynat: 30, sts: 20, mrc: 30, wos: 20 };
const MIXED_SMOKE60_COUNTS = { ynat: 9, sts: 6, mrc: 9, wos: 6, scifact: 30 };
const TASK_ORDER = ["ynat", "sts", "mrc", "wos"];

if (args.clean) {
  for (const rel of ["KLUE", "English"]) {
    removeInsideVault(rel);
  }
}

fs.mkdirSync(outputDir, { recursive: true });

const klueQueries300 = writeKlueNotesAndQueries();
const { englishQueries300, scifactQueriesById } = writeScifactNotesAndQueries();
const klueQueries100 = subsetKlueQueries(klueQueries300, KLUE_SUBSET_COUNTS);
const englishQueries100 = sampleEven(englishQueries300, 100);
const mixed200 = mixedQueries(klueQueries100, englishQueries100);
const mixed600 = mixedQueries(klueQueries300, englishQueries300);
const mixed600Smoke60 = mixedSmokeQueries(klueQueries300, englishQueries300);

writeSpec(path.join(outputDir, "klue100.queries.json"), klueQueries100);
writeSpec(path.join(outputDir, "klue300.queries.json"), klueQueries300);
writeSpec(path.join(outputDir, "english100.queries.json"), englishQueries100);
writeSpec(path.join(outputDir, "english300.queries.json"), englishQueries300);
writeSpec(path.join(outputDir, "mixed200.queries.json"), mixed200);
writeSpec(path.join(outputDir, "mixed600.queries.json"), mixed600);
writeSpec(path.join(outputDir, "mixed600.smoke60.queries.json"), mixed600Smoke60);
writeSpec(path.join(outputDir, "queries.json"), mixed600);
writeScifactQuerySnapshot(path.join(outputDir, "scifact-test-queries.jsonl"), scifactQueriesById);

console.log(`wrote KLUE notes and specs: ${klueQueries300.length} full, ${klueQueries100.length} subset`);
console.log(`wrote English/SciFact notes and specs: ${englishQueries300.length} full, ${englishQueries100.length} subset`);
console.log(`wrote ${path.join(outputDir, "mixed600.queries.json")} (${mixed600.length} queries)`);
console.log(`wrote ${path.join(outputDir, "mixed600.smoke60.queries.json")} (${mixed600Smoke60.length} queries)`);
console.log(`wrote ${path.join(outputDir, "mixed200.queries.json")} (${mixed200.length} queries)`);

function writeKlueNotesAndQueries() {
  const rowsByTask = {
    ynat: loadYnatRows(),
    sts: loadStsRows(),
    mrc: loadMrcRows(),
    wos: loadWosRows()
  };
  const queries = [];
  for (const task of TASK_ORDER) {
    const rows = sampleEven(rowsByTask[task], KLUE_FULL_COUNTS[task]);
    for (const row of rows) {
      const note = klueNote(row, task);
      writeNote(note.path, note.frontmatter, note.body);
      queries.push({
        task,
        query: note.query,
        expected: note.path,
        path: "KLUE",
        limit: 10
      });
    }
  }
  assertCount("KLUE300", queries, 300);
  return queries;
}

function loadYnatRows() {
  return readJson(path.join(klueRepo, "klue_benchmark/ynat-v1.1/ynat-v1.1_dev.json"));
}

function loadStsRows() {
  return readJson(path.join(klueRepo, "klue_benchmark/klue-sts-v1.1/klue-sts-v1.1_dev.json"));
}

function loadWosRows() {
  return readJson(path.join(klueRepo, "klue_benchmark/wos-v1.1/wos-v1.1_dev.json"));
}

function loadMrcRows() {
  const payload = readJson(path.join(klueRepo, "klue_benchmark/klue-mrc-v1.1/klue-mrc-v1.1_dev.json"));
  const rows = [];
  for (const article of payload.data ?? []) {
    for (const paragraph of article.paragraphs ?? []) {
      for (const qa of paragraph.qas ?? []) {
        if (qa.is_impossible) continue;
        rows.push({
          ...qa,
          title: article.title,
          context: paragraph.context,
          news_category: article.news_category,
          source: article.source
        });
      }
    }
  }
  return rows;
}

function klueNote(row, task) {
  if (task === "ynat") return ynatNote(row);
  if (task === "sts") return stsNote(row);
  if (task === "mrc") return mrcNote(row);
  if (task === "wos") return wosNote(row);
  throw new Error(`Unsupported KLUE task: ${task}`);
}

function ynatNote(row) {
  const title = row.title;
  const frontmatter = klueFrontmatter({
    title,
    aliases: [row.guid, row.label, row.predefined_news_category].filter(Boolean),
    tags: ["klue-ynat", row.label].filter(Boolean),
    guid: row.guid,
    task: "ynat"
  });
  const body = [
    `# ${title}`,
    "",
    "- KLUE task: YNAT",
    `- News category: ${row.label ?? "unknown"}`,
    `- Predefined category: ${row.predefined_news_category ?? "unknown"}`,
    row.date ? `- Date: ${row.date}` : undefined,
    row.url ? `- URL: ${row.url}` : undefined,
    "",
    "## Headline",
    "",
    title
  ].filter((line) => line !== undefined).join("\n");
  return { path: `KLUE/YNAT/${row.guid}.md`, frontmatter, body, query: title };
}

function stsNote(row) {
  const title = `KLUE STS ${row.guid}`;
  const frontmatter = klueFrontmatter({
    title,
    aliases: [row.guid, row.source].filter(Boolean),
    tags: ["klue-sts"],
    guid: row.guid,
    task: "sts"
  });
  const body = [
    `# ${title}`,
    "",
    `- Source: ${row.source ?? "unknown"}`,
    `- Similarity label: ${row.labels?.label ?? "unknown"}`,
    `- Binary label: ${row.labels?.["binary-label"] ?? "unknown"}`,
    "",
    "## Sentence Pair",
    "",
    `1. ${row.sentence1}`,
    `2. ${row.sentence2}`
  ].join("\n");
  return { path: `KLUE/STS/${row.guid}.md`, frontmatter, body, query: row.sentence2 };
}

function mrcNote(row) {
  const answers = unique((row.answers ?? []).map((answer) => answer.text).filter(Boolean));
  const title = row.title;
  const frontmatter = klueFrontmatter({
    title,
    aliases: [row.guid, ...answers].filter(Boolean),
    tags: ["klue-mrc", row.news_category].filter(Boolean),
    guid: row.guid,
    task: "mrc"
  });
  const answerText = answers.join(", ");
  const body = [
    `# ${title}`,
    "",
    "- KLUE task: MRC",
    `- News category: ${row.news_category ?? "unknown"}`,
    `- Source: ${row.source ?? "unknown"}`,
    `- Question: ${row.question}`,
    answerText ? `- Answer: ${answerText}` : undefined,
    "",
    "## Question",
    "",
    row.question,
    "",
    "## Answer",
    "",
    answerText,
    "",
    "## Context",
    "",
    row.context
  ].filter((line) => line !== undefined).join("\n");
  const query = answerText ? `${row.question} ${answerText}` : row.question;
  return { path: `KLUE/MRC/${row.guid}.md`, frontmatter, body, query };
}

function wosNote(row) {
  const domains = row.domains ?? [];
  const title = `KLUE WOS ${row.guid}${domains.length > 0 ? ` ${domains.join(" ")}` : ""}`;
  const frontmatter = klueFrontmatter({
    title,
    aliases: [row.guid, ...domains.map((domain) => `WOS ${domain}`)],
    tags: ["klue-wos", ...domains],
    guid: row.guid,
    task: "wos"
  });
  const dialogue = (row.dialogue ?? []).map((turn, index) => {
    const lines = [`${index + 1}. ${turn.role}: ${turn.text}`];
    if (Array.isArray(turn.state) && turn.state.length > 0) lines.push(`  - state: ${turn.state.join("; ")}`);
    return lines.join("\n");
  }).join("\n");
  const query = wosQuery(row);
  const body = [
    `# ${title}`,
    "",
    "- KLUE task: WOS dialogue state tracking",
    `- Domains: ${domains.join(", ")}`,
    "",
    "## Dialogue",
    "",
    dialogue
  ].join("\n");
  return { path: `KLUE/WOS/${row.guid}.md`, frontmatter, body, query };
}

function wosQuery(row) {
  const userTurns = (row.dialogue ?? []).filter((turn) => turn.role === "user" && turn.text).map((turn) => turn.text);
  if (userTurns.length > 0) return userTurns[Math.floor(userTurns.length / 2)].trim();
  const firstTurn = (row.dialogue ?? []).find((turn) => turn.text);
  if (firstTurn) return firstTurn.text.trim();
  throw new Error(`Missing WOS dialogue turn: ${row.guid}`);
}

function klueFrontmatter({ title, aliases, tags, guid, task }) {
  return {
    title,
    aliases: unique(aliases),
    tags: unique(["search-eval", "klue300", "klue", ...tags]),
    source: klueSource(task),
    source_url: "https://github.com/KLUE-benchmark/KLUE",
    source_license: "CC BY-SA 4.0",
    guid,
    klue_task: task
  };
}

function klueSource(task) {
  if (task === "ynat") return "KLUE YNAT v1.1 dev";
  if (task === "sts") return "KLUE STS v1.1 dev";
  if (task === "mrc") return "KLUE MRC v1.1 dev / wikipedia";
  if (task === "wos") return "KLUE WOS v1.1 dev";
  return `KLUE ${task} v1.1 dev`;
}

function writeScifactNotesAndQueries() {
  const corpusById = readJsonlMap(path.join(scifactDir, "corpus.jsonl"));
  const queryById = readJsonlMap(path.join(scifactDir, "queries.jsonl"));
  const qrelsByQuery = readQrels(path.join(scifactDir, "qrels/test.tsv"));
  const queryIds = [...qrelsByQuery.keys()].sort(numericCompare).slice(0, 300);
  assertCount("English300 query ids", queryIds, 300);
  const queries = [];
  const noteQueriesByCorpusId = new Map();
  for (const queryId of queryIds) {
    const qrel = chooseQrel(qrelsByQuery.get(queryId) ?? []);
    const corpus = corpusById.get(qrel.corpusId);
    const query = queryById.get(queryId);
    if (!corpus) throw new Error(`Missing SciFact corpus id ${qrel.corpusId}`);
    if (!query) throw new Error(`Missing SciFact query id ${queryId}`);
    const expected = `English/SciFact/${qrel.corpusId}.md`;
    queries.push({
      task: "scifact",
      query: query.text,
      expected,
      path: "English",
      limit: 10
    });
    if (!noteQueriesByCorpusId.has(qrel.corpusId)) noteQueriesByCorpusId.set(qrel.corpusId, []);
    noteQueriesByCorpusId.get(qrel.corpusId).push({ queryId, score: qrel.score });
  }
  for (const [corpusId, queryRefs] of [...noteQueriesByCorpusId.entries()].sort((left, right) => numericCompare(left[0], right[0]))) {
    const corpus = corpusById.get(corpusId);
    const frontmatter = {
      title: corpus.title,
      aliases: unique([corpusId, ...queryRefs.map((ref) => ref.queryId)]),
      tags: ["search-eval", "english300", "english", "beir", "scifact"],
      source: "BEIR/scifact",
      source_url: "https://huggingface.co/datasets/BeIR/scifact",
      source_license: "CC BY-SA 4.0",
      beir_id: corpusId,
      beir_query_ids: queryRefs.map((ref) => ref.queryId),
      beir_qrel_scores: Object.fromEntries(queryRefs.map((ref) => [ref.queryId, String(ref.score)]))
    };
    const body = [
      `# ${corpus.title}`,
      "",
      "- BEIR dataset: SciFact",
      `- Corpus id: ${corpusId}`,
      `- Query ids: ${queryRefs.map((ref) => ref.queryId).join(", ")}`,
      "",
      "## Abstract",
      "",
      corpus.text
    ].join("\n");
    writeNote(`English/SciFact/${corpusId}.md`, frontmatter, body);
  }
  return { englishQueries300: queries, scifactQueriesById: queryById };
}

function chooseQrel(qrels) {
  if (qrels.length === 0) throw new Error("Cannot choose from empty qrels");
  return [...qrels].sort((left, right) => right.score - left.score || numericCompare(left.corpusId, right.corpusId))[0];
}

function readQrels(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).slice(1);
  const byQuery = new Map();
  for (const line of lines) {
    const [queryId, corpusId, scoreRaw] = line.split(/\t/);
    if (!queryId || !corpusId) continue;
    if (!byQuery.has(queryId)) byQuery.set(queryId, []);
    byQuery.get(queryId).push({ queryId, corpusId, score: Number(scoreRaw) });
  }
  return byQuery;
}

function readJsonlMap(filePath) {
  const map = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    map.set(String(row._id), row);
  }
  return map;
}

function subsetKlueQueries(queries, counts) {
  const output = [];
  for (const task of TASK_ORDER) {
    const taskQueries = queries.filter((query) => query.task === task);
    output.push(...sampleEven(taskQueries, counts[task]));
  }
  assertCount("KLUE100", output, 100);
  return output;
}

function mixedQueries(klueQueries, englishQueries) {
  return [
    ...klueQueries.map(({ path: _path, ...query }) => query),
    ...englishQueries.map(({ path: _path, ...query }) => query)
  ];
}

function mixedSmokeQueries(klueQueries, englishQueries) {
  const scopedQueries = [];
  for (const task of TASK_ORDER) {
    scopedQueries.push(...sampleEven(klueQueries.filter((query) => query.task === task), MIXED_SMOKE60_COUNTS[task]));
  }
  scopedQueries.push(...sampleEven(englishQueries.filter((query) => query.task === "scifact"), MIXED_SMOKE60_COUNTS.scifact));
  const output = scopedQueries.map(({ path: _path, ...query }) => query);
  assertCount("Mixed600 smoke60", output, 60);
  return output;
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

function writeNote(relPath, frontmatter, body) {
  const filePath = path.join(resolvedVault, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.trimEnd()}\n`);
}

function writeSpec(filePath, queries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ queries }, null, 2)}\n`);
}

function writeScifactQuerySnapshot(filePath, queryById) {
  const lines = [...queryById.values()]
    .sort((left, right) => numericCompare(left._id, right._id))
    .map((row) => JSON.stringify(row));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveScifactDir(input) {
  if (fs.existsSync(path.join(input, "corpus.jsonl"))) return input;
  if (fs.existsSync(path.join(input, "scifact/corpus.jsonl"))) return path.join(input, "scifact");
  throw new Error(`Could not find BEIR SciFact corpus.jsonl under ${input}`);
}

function removeInsideVault(relPath) {
  const target = path.resolve(resolvedVault, relPath);
  const relative = path.relative(resolvedVault, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing to remove outside vault: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && String(value).length > 0))];
}

function assertCount(label, rows, expected) {
  if (rows.length !== expected) throw new Error(`${label} count mismatch: expected ${expected}, got ${rows.length}`);
}

function numericCompare(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right));
}

function parseArgs(argv) {
  const parsed = {};
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
    } else if (arg.startsWith("--klue-repo=")) {
      parsed.klueRepo = arg.slice("--klue-repo=".length);
    } else if (arg.startsWith("--scifact-dir=")) {
      parsed.scifactDir = arg.slice("--scifact-dir=".length);
    } else if (arg.startsWith("--out-dir=")) {
      parsed.outDir = arg.slice("--out-dir=".length);
    } else if (!parsed.vault) {
      parsed.vault = arg;
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error("Usage: node scripts/generate-search-eval-vault.mjs <vault-path> --klue-repo=<KLUE repo> --scifact-dir=<BEIR scifact dir> [--clean] [--out-dir=<dir>]");
  console.error("       npm run search:eval:vault -- <vault-path> --klue-repo=/path/to/KLUE --scifact-dir=/path/to/scifact [--clean]");
  process.exit(code);
}
