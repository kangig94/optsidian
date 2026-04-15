#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isCliError } from "./errors.js";
import { mcpHelpText, parseMcpArgs } from "./mcp/config.js";
import { createOptsidianMcpServer } from "./mcp/server.js";
import { resolveObsidianVaultRootWithFallback } from "./native/obsidian.js";
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

  const vaultRoot = resolveObsidianVaultRootWithFallback({ vault: config.vault, fallbackPath: config.vaultPath });
  const server = createOptsidianMcpServer({ vaultRoot });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(isCliError(error) ? error.exitCode : 1);
});
