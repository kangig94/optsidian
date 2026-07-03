import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOptsidianTools } from './tools.js';
import { OPTSIDIAN_VERSION } from '../version.js';

export function createOptsidianMcpServer(options: {
  resolveVaultRoot: () => string;
  version?: string;
  onToolCall?: () => void;
}): McpServer {
  const server = new McpServer({
    name: 'optsidian',
    version: options.version ?? OPTSIDIAN_VERSION,
  });
  registerOptsidianTools(server, options.resolveVaultRoot, options.onToolCall);
  return server;
}
