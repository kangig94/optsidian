import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.js";

export type ParsedArgs = {
  command: string | undefined;
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
  raw: string[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...raw] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (const token of raw) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      values.set(token.slice(0, eq), token.slice(eq + 1));
    } else if (token.startsWith("--")) {
      flags.add(token.slice(2));
    } else if (token.length > 0) {
      flags.add(token);
      positionals.push(token);
    }
  }

  return { command, values, flags, positionals, raw };
}

export function getValue(args: ParsedArgs, key: string): string | undefined {
  return args.values.get(key);
}

export function requireValue(args: ParsedArgs, key: string): string {
  const value = getValue(args, key);
  if (value === undefined) {
    throw new UsageError(`Missing required argument: ${key}=<value>`);
  }
  return value;
}

export function hasFlag(args: ParsedArgs, key: string): boolean {
  return args.flags.has(key) || args.values.get(key) === "true";
}

export function readValueOrFile(value: string, cwd = process.cwd()): string {
  if (!value.startsWith("@")) {
    return decodeCliEscapes(value);
  }
  const filePath = value.slice(1);
  if (!filePath) {
    throw new UsageError("@file value must include a path");
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  return fs.readFileSync(resolved, "utf8");
}

export function decodeCliEscapes(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseLineRange(value: string): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    throw new UsageError("range/lines must use the form a:b");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end < start) {
    throw new UsageError("range/lines must be 1-based and end must be >= start");
  }
  return { start, end };
}
