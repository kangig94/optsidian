import { getValue, hasFlag, ParsedArgs, readRawValueOrFile, readValueOrFile, requireValue } from "../args.js";
import { parseFormat, renderFrontmatterRead, renderMutation } from "../render.js";
import {
  addFrontmatterValue,
  deleteFrontmatter,
  readFrontmatter,
  removeFrontmatterValue,
  setFrontmatter
} from "../../core/frontmatter.js";
import type { FrontmatterValue } from "../../core/types.js";
import { UsageError } from "../../errors.js";

export function runFrontmatter(args: ParsedArgs, vaultRoot: string): void {
  const action = args.positionals[0];
  const format = parseFormat(getValue(args, "format"));
  switch (action) {
    case "read": {
      const result = readFrontmatter(vaultRoot, { path: requireValue(args, "path") });
      process.stdout.write(renderFrontmatterRead(result, format));
      return;
    }
    case "set": {
      const result = setFrontmatter(vaultRoot, {
        path: requireValue(args, "path"),
        key: requireValue(args, "key"),
        value: parseFrontmatterValue(args),
        dryRun: hasFlag(args, "dry-run")
      });
      process.stdout.write(renderMutation(result, format));
      return;
    }
    case "delete": {
      const result = deleteFrontmatter(vaultRoot, {
        path: requireValue(args, "path"),
        key: requireValue(args, "key"),
        dryRun: hasFlag(args, "dry-run")
      });
      process.stdout.write(renderMutation(result, format));
      return;
    }
    case "add": {
      const result = addFrontmatterValue(vaultRoot, {
        path: requireValue(args, "path"),
        key: requireValue(args, "key"),
        value: parseFrontmatterValue(args),
        dryRun: hasFlag(args, "dry-run")
      });
      process.stdout.write(renderMutation(result, format));
      return;
    }
    case "remove": {
      const result = removeFrontmatterValue(vaultRoot, {
        path: requireValue(args, "path"),
        key: requireValue(args, "key"),
        value: parseFrontmatterValue(args),
        dryRun: hasFlag(args, "dry-run")
      });
      process.stdout.write(renderMutation(result, format));
      return;
    }
    default:
      throw new UsageError("frontmatter action must be one of read, set, delete, add, or remove");
  }
}

function parseFrontmatterValue(args: ParsedArgs): FrontmatterValue {
  const rawValue = getValue(args, "value");
  const rawJson = getValue(args, "value-json");
  if (rawValue !== undefined && rawJson !== undefined) {
    throw new UsageError("Use only one of value= or value-json=");
  }
  if (rawValue !== undefined) return readValueOrFile(rawValue);
  if (rawJson === undefined) throw new UsageError("Missing required argument: value=<text>|value-json=<json>");
  const json = readRawValueOrFile(rawJson);
  try {
    return JSON.parse(json) as FrontmatterValue;
  } catch (error) {
    throw new UsageError(`Invalid value-json: ${(error as Error).message}`);
  }
}
