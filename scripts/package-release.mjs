#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distDir = path.join(rootDir, "dist");
const outDir = parseOutDir(process.argv.slice(2));

const assets = [
  { source: path.join(distDir, "optsidian"), name: `optsidian-${tag}` },
  { source: path.join(distDir, "optsidian-mcp"), name: `optsidian-mcp-${tag}` }
];
const checksumsName = `checksums-${tag}.txt`;

fs.mkdirSync(outDir, { recursive: true });
for (const asset of assets) {
  assertExecutable(asset.source);
  const dest = path.join(outDir, asset.name);
  fs.copyFileSync(asset.source, dest);
  fs.chmodSync(dest, 0o755);
}

fs.writeFileSync(
  path.join(outDir, checksumsName),
  `${assets
    .map((asset) => `${sha256(path.join(outDir, asset.name))}  ${asset.name}`)
    .join("\n")}\n`
);

for (const asset of assets) {
  process.stdout.write(`${path.join(outDir, asset.name)}\n`);
}
process.stdout.write(`${path.join(outDir, checksumsName)}\n`);

function parseOutDir(argv) {
  if (argv.length === 0) return path.join(rootDir, "release");
  if (argv.length === 2 && argv[0] === "--out-dir") return path.resolve(argv[1]);
  throw new Error("Usage: node scripts/package-release.mjs [--out-dir <path>]");
}

function assertExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing bundled output: ${filePath}`);
  }
  fs.accessSync(filePath, fs.constants.X_OK);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
