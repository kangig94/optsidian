import path from "node:path";
import { getValue, type ParsedArgs } from "../args.js";
import { parseFormat, renderIndexResult } from "../render.js";
import { createSearchDaemonClient, type SearchDaemonClient } from "../../daemon/client.js";
import { discoverObsidianVaultRoots, resolveVaultPathInput } from "../../native/obsidian.js";
import { UsageError } from "../../errors.js";
import type { SearchIndexWarmResult, SearchIndexWarmVaultResult } from "../../core/types.js";
import { hasVaultPathArg, resolveVaultRoot, vaultArg } from "../vault.js";

export async function runIndex(args: ParsedArgs, vaultRoot?: string): Promise<void> {
  const action = args.positionals[0] ?? "status";
  const format = parseFormat(getValue(args, "format"));
  const client = createSearchDaemonClient();
  switch (action) {
    case "status":
      process.stdout.write(renderIndexResult(await client.status(), format));
      return;
    case "rebuild":
      if (!vaultRoot) throw new UsageError("index rebuild requires a vault");
      process.stdout.write(renderIndexResult(await client.rebuild({ vault: vaultRoot }), format));
      return;
    case "warm": {
      const discovery = indexWarmVaultRoots(args);
      process.stdout.write(renderIndexResult(await loadDiscoveredVaults(client, discovery), format));
      return;
    }
    case "clear":
      if (!vaultRoot) throw new UsageError("index clear requires a vault");
      process.stdout.write(renderIndexResult(await client.clear({ vault: vaultRoot }), format));
      return;
    default:
      throw new UsageError("index action must be status, rebuild, warm, or clear");
  }
}

async function loadDiscoveredVaults(
  client: SearchDaemonClient,
  discovery: { vaultRoots: string[]; warnings: string[] }
): Promise<SearchIndexWarmResult> {
  const vaults: SearchIndexWarmVaultResult[] = [];
  const warnings = [...discovery.warnings];

  for (const vaultRoot of discovery.vaultRoots) {
    try {
      const result = await client.loadVault({ vault: vaultRoot });
      vaults.push(...result.vaults);
      if (result.warnings) warnings.push(...result.warnings);
    } catch (error) {
      vaults.push({
        vaultRoot: path.resolve(vaultRoot),
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    ok: true,
    command: "index",
    action: "warm",
    vaults,
    ...(warnings.length > 0 ? { warnings } : {})
  };
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
