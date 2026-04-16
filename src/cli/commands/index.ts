import { getValue, ParsedArgs } from "../args.js";
import { parseFormat, renderIndexResult } from "../render.js";
import { clearSearchIndex, getSearchIndexStatus, rebuildSearchIndex } from "../../core/search.js";
import { UsageError } from "../../errors.js";

export async function runIndex(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const action = args.positionals[0] ?? "status";
  const format = parseFormat(getValue(args, "format"));
  switch (action) {
    case "status":
      process.stdout.write(renderIndexResult(getSearchIndexStatus(vaultRoot), format));
      return;
    case "rebuild":
      process.stdout.write(renderIndexResult(await rebuildSearchIndex(vaultRoot), format));
      return;
    case "clear":
      process.stdout.write(renderIndexResult(clearSearchIndex(vaultRoot), format));
      return;
    default:
      throw new UsageError("index action must be status, rebuild, or clear");
  }
}
