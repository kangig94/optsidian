import { UsageError } from "../errors.js";
import { OPTSIDIAN_VERSION } from "../version.js";

export type McpConfig = {
  help: boolean;
  version: boolean;
  vault?: string;
  vaultPath?: string;
};

export function parseMcpArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): McpConfig {
  let vault = env.OPTSIDIAN_VAULT || undefined;
  let vaultPath = env.OPTSIDIAN_VAULT_PATH || undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version") {
      version = true;
      continue;
    }
    if (token === "--vault") {
      const value = argv[index + 1];
      if (!value) throw new UsageError("--vault requires a value");
      vault = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--vault=")) {
      const value = token.slice("--vault=".length);
      if (!value) throw new UsageError("--vault requires a value");
      vault = value;
      continue;
    }
    if (token === "--vault-path") {
      const value = argv[index + 1];
      if (!value) throw new UsageError("--vault-path requires a value");
      vaultPath = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--vault-path=")) {
      const value = token.slice("--vault-path=".length);
      if (!value) throw new UsageError("--vault-path requires a value");
      vaultPath = value;
      continue;
    }
    throw new UsageError(`Unknown optsidian-mcp argument: ${token}`);
  }

  return { help, version, vault, vaultPath };
}

export function mcpHelpText(): string {
  return `optsidian-mcp ${OPTSIDIAN_VERSION}

Usage: optsidian-mcp [--version] [--vault <name>] [--vault-path <path>]

Runs the Optsidian MCP server over stdio.

Vault resolution:
  --vault <name>        Forward vault=<name> to native Obsidian vault resolution
  --vault-path <path>   Fallback vault root if native resolution fails
  OPTSIDIAN_VAULT      Default vault name when --vault is omitted
  OPTSIDIAN_VAULT_PATH Fallback vault root if native resolution fails
  OPTSIDIAN_OBSIDIAN_BIN Override native obsidian binary path

Tools:
  read, grep, write, edit, apply_patch, copy, mkdir
`;
}
