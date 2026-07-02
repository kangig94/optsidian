import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("core lifecycle modules do not import daemon, cli, or mcp adapters", () => {
  const violations = [];
  for (const filePath of tsFiles(path.join(repoRoot, "src/core/lifecycle"))) {
    for (const specifier of importSpecifiers(filePath)) {
      const resolved = resolveLocalImport(filePath, specifier);
      if (!resolved) continue;
      if (resolved.startsWith("src/daemon/") || resolved.startsWith("src/cli/") || resolved.startsWith("src/mcp/")) {
        violations.push(`${relative(filePath)} imports ${specifier} -> ${resolved}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("core kiwi modules do not import core search modules", () => {
  const violations = [];
  for (const filePath of tsFiles(path.join(repoRoot, "src/core/kiwi"))) {
    for (const specifier of importSpecifiers(filePath)) {
      const resolved = resolveLocalImport(filePath, specifier);
      if (!resolved) continue;
      if (resolved.startsWith("src/core/search/")) {
        violations.push(`${relative(filePath)} imports ${specifier} -> ${resolved}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

function tsFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) results.push(...tsFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(entryPath);
  }
  return results;
}

function importSpecifiers(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const specs = [];
  const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = importPattern.exec(source))) {
    specs.push(match[1] ?? match[2]);
  }
  return specs;
}

function resolveLocalImport(importerPath, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const importerDir = path.dirname(importerPath);
  const raw = path.resolve(importerDir, specifier);
  const candidates = [];
  if (raw.endsWith(".js")) candidates.push(`${raw.slice(0, -3)}.ts`);
  candidates.push(raw, `${raw}.ts`, path.join(raw, "index.ts"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return relative(candidate);
  }
  return relative(raw);
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
