import type { ParsedArgs } from "./args.js";
import { UsageError } from "../errors.js";
import { recordVaultAccess } from "../core/vault-access.js";
import { resolveObsidianVaultRoot, resolveVaultPathInput } from "../native/obsidian.js";

export function vaultArg(args: ParsedArgs): string | undefined {
  return args.values.get("vault");
}

export function hasVaultPathArg(args: ParsedArgs): boolean {
  return args.values.has("vault-path") || args.flags.has("vault-path");
}

export function vaultPathArg(args: ParsedArgs): string | undefined {
  if (args.flags.has("vault-path")) {
    throw new UsageError("Use vault-path=<path> with optsidian CLI, not --vault-path");
  }
  const value = args.values.get("vault-path");
  if (value === "") {
    throw new UsageError("vault-path=<path> requires a value");
  }
  return value;
}

export function resolveVaultRoot(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): string {
  const vault = vaultArg(args);
  const explicitVaultPath = vaultPathArg(args);
  const envVaultPath = env.OPTSIDIAN_VAULT_PATH ? env.OPTSIDIAN_VAULT_PATH : undefined;
  const vaultPath = explicitVaultPath ?? envVaultPath;
  if (vaultPath && vault) {
    throw new UsageError("Use either vault-path=<path> or vault=<name>, not both");
  }
  if (vaultPath) {
    return rememberVaultAccess(resolveVaultPathInput(vaultPath), env);
  }
  return rememberVaultAccess(resolveObsidianVaultRoot({ vault, env }), env);
}

function rememberVaultAccess(vaultRoot: string, env: NodeJS.ProcessEnv): string {
  recordVaultAccess(vaultRoot, { env });
  return vaultRoot;
}
