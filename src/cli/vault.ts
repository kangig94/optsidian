import { ParsedArgs } from "./args.js";
import { resolveObsidianVaultRoot } from "../native/obsidian.js";

export function vaultArg(args: ParsedArgs): string | undefined {
  return args.values.get("vault");
}

export function resolveVaultRoot(args: ParsedArgs): string {
  return resolveObsidianVaultRoot({ vault: vaultArg(args) });
}
