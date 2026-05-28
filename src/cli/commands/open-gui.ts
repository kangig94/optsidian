import { getValue, hasFlag, ParsedArgs, parsePositiveInt } from "../args.js";
import { parseFormat } from "../render.js";
import { UsageError } from "../../errors.js";
import { openObsidianGui, type OpenObsidianGuiResult } from "../../native/gui.js";
import { vaultPathArg } from "../vault.js";

export async function runOpenGui(args: ParsedArgs): Promise<void> {
  if (getValue(args, "vault") !== undefined) {
    throw new UsageError("open-gui supports vault-path=<path>, not vault=<name>");
  }
  const timeout = parsePositiveInt(getValue(args, "timeout"), "timeout");
  const envVaultPath = process.env.OPTSIDIAN_VAULT_PATH || undefined;
  const result = await openObsidianGui({
    vaultPath: vaultPathArg(args) ?? envVaultPath,
    wait: hasFlag(args, "wait"),
    timeoutMs: timeout ? timeout * 1000 : undefined
  });
  process.stdout.write(renderOpenGui(result, parseFormat(getValue(args, "format"))));
}

function renderOpenGui(result: OpenObsidianGuiResult, format: "text" | "json"): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  const lines = [
    "Requested Obsidian GUI launch.",
    `launcher: ${result.launcher}`
  ];
  if (result.vaultPath) {
    lines.push(`vault: ${result.vaultPath}`);
  }
  if (result.readyVaultPath) {
    lines.push(`native ready: ${result.readyVaultPath}`);
  } else if (result.wait) {
    lines.push("native ready: pending");
  }
  return `${lines.join("\n")}\n`;
}
