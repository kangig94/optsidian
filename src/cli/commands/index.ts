import { getValue, ParsedArgs } from "../args.js";
import { parseFormat, renderIndexResult } from "../render.js";
import { clearSearchIndex, getSearchIndexStatus, rebuildSearchIndex, warmSearchIndexes } from "../../core/search.js";
import { discoverObsidianVaultRoots, resolveVaultPathInput } from "../../native/obsidian.js";
import { UsageError } from "../../errors.js";
import { hasVaultPathArg, resolveVaultRoot, vaultArg } from "../vault.js";

export async function runIndex(args: ParsedArgs, vaultRoot?: string): Promise<void> {
  const action = args.positionals[0] ?? "status";
  const format = parseFormat(getValue(args, "format"));
  switch (action) {
    case "status":
      if (!vaultRoot) throw new UsageError("index status requires a vault");
      process.stdout.write(renderIndexResult(getSearchIndexStatus(vaultRoot), format));
      return;
    case "rebuild":
      if (!vaultRoot) throw new UsageError("index rebuild requires a vault");
      process.stdout.write(renderIndexResult(await rebuildSearchIndex(vaultRoot), format));
      return;
    case "warm": {
      const discovery = indexWarmVaultRoots(args);
      process.stdout.write(renderIndexResult(await warmSearchIndexes(discovery.vaultRoots, discovery.warnings), format));
      return;
    }
    case "clear":
      if (!vaultRoot) throw new UsageError("index clear requires a vault");
      process.stdout.write(renderIndexResult(await clearSearchIndex(vaultRoot), format));
      return;
    default:
      throw new UsageError("index action must be status, rebuild, warm, or clear");
  }
}

function indexWarmVaultRoots(args: ParsedArgs): { vaultRoots: string[]; warnings: string[] } {
  if (hasVaultPathArg(args) || vaultArg(args)) {
    return { vaultRoots: [resolveVaultRoot(args)], warnings: [] };
  }

  const vaultRoots: string[] = [];
  const warnings: string[] = [];
  const fixedVault = process.env.OPTSIDIAN_VAULT_PATH?.trim();
  if (fixedVault) {
    try {
      vaultRoots.push(resolveVaultPathInput(fixedVault));
    } catch (error) {
      warnings.push(`Skipping OPTSIDIAN_VAULT_PATH: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const discovered = discoverObsidianVaultRoots();
  vaultRoots.push(...discovered.vaults.map((vault) => vault.path));
  warnings.push(...discovered.warnings);
  return { vaultRoots, warnings };
}
