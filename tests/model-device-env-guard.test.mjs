import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = [
  ['OPTSIDIAN_SEARCH_MODEL', 'REQUIRED', 'VRAM_MB'].join('_'),
  ['OPTSIDIAN_SEARCH_MODEL', 'FREE', 'VRAM_MB'].join('_'),
];
const scanRoots = ['src', 'tests', 'docs', 'README.md'];

test('removed model VRAM env vars are absent from source tests and docs', () => {
  const hits = [];
  for (const rel of scanRoots) {
    const absolute = path.join(repoRoot, rel);
    for (const file of filesUnder(absolute)) {
      const body = fs.readFileSync(file, 'utf8');
      for (const name of forbidden) {
        if (body.includes(name)) hits.push(`${path.relative(repoRoot, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

function* filesUnder(absolute) {
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    yield absolute;
    return;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) yield* filesUnder(child);
    else if (entry.isFile()) yield child;
  }
}
