import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOptsidianTools } from "./tools.js";
import { OPTSIDIAN_VERSION } from "../version.js";

export function createOptsidianMcpServer(options: { vaultRoot: string; version?: string }): McpServer {
  const server = new McpServer({
    name: "optsidian",
    version: options.version ?? OPTSIDIAN_VERSION
  });
  registerOptsidianTools(server, options.vaultRoot);
  return server;
}
