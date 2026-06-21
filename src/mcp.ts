#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuntimeError, isCliError } from "./errors.js";
import { maybePokeSearchIndexDaemonWarmForMcp } from "./core/search-index-schedule.js";
import { recordVaultAccess } from "./core/vault-access.js";
import { mcpHelpText, parseMcpArgs } from "./mcp/config.js";
import { createOptsidianMcpServer } from "./mcp/server.js";
import { resolveObsidianVaultRoot, resolveVaultPathInput } from "./native/obsidian.js";
import { OPTSIDIAN_VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = parseMcpArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(mcpHelpText());
    return;
  }
  if (config.version) {
    process.stdout.write(`${OPTSIDIAN_VERSION}\n`);
    return;
  }

  const resolveVaultRoot = createMcpVaultResolver(config);
  const maybeWarmIndex = createMcpIndexWarmTrigger(config);
  if (config.vaultPath) maybeWarmIndex();
  const server = createOptsidianMcpServer({ resolveVaultRoot, onToolCall: maybeWarmIndex });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createMcpVaultResolver(config: ReturnType<typeof parseMcpArgs>): () => string {
  return () => {
    if (config.vaultPath) return rememberVaultAccess(resolveVaultPathInput(config.vaultPath));
    try {
      return rememberVaultAccess(resolveObsidianVaultRoot());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(
        `Vault is not configured for this MCP session. Launch the Obsidian GUI, or configure optsidian-mcp with --vault-path <path> or OPTSIDIAN_VAULT_PATH=<path>. Native resolution failed: ${reason}`
      );
    }
  };
}

function rememberVaultAccess(vaultRoot: string): string {
  recordVaultAccess(vaultRoot);
  return vaultRoot;
}

function createMcpIndexWarmTrigger(config: ReturnType<typeof parseMcpArgs>): () => void {
  const cliBin = fileURLToPath(new URL("optsidian", import.meta.url));
  return () => {
    try {
      const vaultPath = config.vaultPath ? rememberVaultAccess(resolveVaultPathInput(config.vaultPath)) : undefined;
      maybePokeSearchIndexDaemonWarmForMcp({
        vaultPath,
        cliBin
      });
    } catch {
      // Index warmup is opportunistic; MCP startup and tool calls must remain foreground-stable.
    }
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(isCliError(error) ? error.exitCode : 1);
});
