import path from "node:path";
import { getValue, hasFlag, parsePositiveInt, type ParsedArgs } from "../args.js";
import { parseFormat, renderIndexResult } from "../render.js";
import { createSearchDaemonClient, type SearchDaemonClient } from "../../daemon/client.js";
import { discoverObsidianVaultRoots, resolveVaultPathInput } from "../../native/obsidian.js";
import { UsageError } from "../../errors.js";
import type { SearchIndexWarmResult, SearchIndexWarmVaultResult } from "../../core/types.js";
import type { StatusResult } from "../../daemon/protocol.js";
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
      process.stdout.write(renderIndexResult(await withVaultProgress(
        client,
        vaultRoot,
        () => client.rebuild({ vault: vaultRoot }),
        { enabled: shouldRenderProgress(format) }
      ), format));
      return;
    case "warm": {
      const discovery = indexWarmVaultRoots(args);
      process.stdout.write(renderIndexResult(await loadDiscoveredVaults(client, discovery, { enabled: shouldRenderProgress(format) }), format));
      return;
    }
    case "clear":
      if (!vaultRoot) throw new UsageError("index clear requires a vault");
      process.stdout.write(renderIndexResult(await client.clear({ vault: vaultRoot }), format));
      return;
    case "prune": {
      const unusedDays = parsePositiveInt(getValue(args, "unused-days"), "unused-days");
      process.stdout.write(renderIndexResult(await client.prune({
        ...(unusedDays === undefined ? {} : { unusedDays }),
        dryRun: hasFlag(args, "dry-run")
      }), format));
      return;
    }
    default:
      throw new UsageError("index action must be status, rebuild, warm, clear, or prune");
  }
}

async function loadDiscoveredVaults(
  client: SearchDaemonClient,
  discovery: { vaultRoots: string[]; warnings: string[] },
  progress: { enabled: boolean }
): Promise<SearchIndexWarmResult> {
  const vaults: SearchIndexWarmVaultResult[] = [];
  const warnings = [...discovery.warnings];

  for (const vaultRoot of discovery.vaultRoots) {
    try {
      const result = await withVaultProgress(
        client,
        vaultRoot,
        () => client.loadVault({ vault: vaultRoot }),
        progress
      );
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

async function withVaultProgress<T>(
  client: SearchDaemonClient,
  vaultRoot: string,
  run: () => Promise<T>,
  options: { enabled: boolean }
): Promise<T> {
  if (!options.enabled) return run();

  let lastLength = 0;
  let polling = false;
  const write = (line: string) => {
    const padded = line.padEnd(lastLength);
    lastLength = Math.max(lastLength, line.length);
    process.stderr.write(`\r${padded}`);
  };
  const clear = () => {
    if (lastLength > 0) process.stderr.write(`\r${" ".repeat(lastLength)}\r`);
  };
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      write(renderVaultProgress(await client.status({ deadlineMs: 1000 }), vaultRoot));
    } catch {
      write(`index loading ${vaultLabel(vaultRoot)}`);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, 500);
  timer.unref();
  void poll();
  try {
    return await run();
  } finally {
    clearInterval(timer);
    clear();
  }
}

function shouldRenderProgress(format: "text" | "json"): boolean {
  return format === "text" && process.stderr.isTTY === true;
}

function renderVaultProgress(status: StatusResult, vaultRoot: string): string {
  const resolved = path.resolve(vaultRoot);
  const vault = status.vaults.find((candidate) => path.resolve(candidate.vault) === resolved);
  if (!vault?.progress) return `index ${vault?.state ?? "loading"} ${vaultLabel(vaultRoot)}`;
  const progress = vault.progress;
  const completed = progress.completed ?? 0;
  const total = progress.total;
  const ratio = total && total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  const percent = total && total > 0 ? `${Math.floor(ratio * 100).toString().padStart(3)}%` : " --%";
  const counts = total === undefined ? String(completed) : `${completed}/${total}`;
  const current = progress.current ? ` ${truncateMiddle(progress.current, 36)}` : "";
  const message = progress.message ? ` ${progress.message}` : "";
  return `index ${progress.phase} ${progressBar(ratio, total !== undefined)} ${percent} ${counts} ${vaultLabel(vaultRoot)}${current}${message}`;
}

function progressBar(ratio: number, knownTotal: boolean): string {
  const width = 20;
  if (!knownTotal) return `[${".".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function vaultLabel(vaultRoot: string): string {
  const resolved = path.resolve(vaultRoot);
  return path.basename(resolved) || resolved;
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
