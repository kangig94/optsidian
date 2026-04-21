import { UsageError } from "../errors.js";
import { OPTSIDIAN_VERSION } from "../version.js";
import { MCP_TOOL_NAMES } from "../cli/help.js";

export type McpConfig = {
  help: boolean;
  version: boolean;
  vaultPath?: string;
};

export function parseMcpArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): McpConfig {
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

  return { help, version, vaultPath };
}

export function mcpHelpText(): string {
  return `optsidian-mcp ${OPTSIDIAN_VERSION}

Usage: optsidian-mcp [--version] [--vault-path <path>]

Runs the Optsidian MCP server over stdio.

Vault resolution:
  --vault-path <path>   Fixed vault root for all mutation tool calls
  OPTSIDIAN_VAULT_PATH Fixed vault root for all mutation tool calls
  OPTSIDIAN_OBSIDIAN_BIN Override native obsidian binary path

Tools:
  ${MCP_TOOL_NAMES.join(", ")}

Detailed CLI help:
  optsidian --help
  optsidian <command> --help
`;
}
