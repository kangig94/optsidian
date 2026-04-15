import { ParsedArgs } from "../args.js";
import { renderIndexResult } from "../render.js";
import { clearSearchIndex, getSearchIndexStatus, rebuildSearchIndex } from "../../core/search.js";
import { UsageError } from "../../errors.js";

export async function runIndex(args: ParsedArgs, vaultRoot: string): Promise<void> {
  const action = args.positionals[0] ?? "status";
  switch (action) {
    case "status":
      process.stdout.write(renderIndexResult(getSearchIndexStatus(vaultRoot)));
      return;
    case "rebuild":
      process.stdout.write(renderIndexResult(await rebuildSearchIndex(vaultRoot)));
      return;
    case "clear":
      process.stdout.write(renderIndexResult(clearSearchIndex(vaultRoot)));
      return;
    default:
      throw new UsageError("index action must be status, rebuild, or clear");
  }
}
