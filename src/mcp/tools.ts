import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { applyVaultPatch, editVaultFile, writeVaultFile } from '../core/index.js';
import type { EditParams, EditSelector, LineRange } from '../core/index.js';
import { usagePayload } from '../cli/help.js';
import { UsageError } from '../errors.js';
import { runAsyncTool, runTool, type ToolPayload } from './result.js';

const usageArgsSchema = z.object({});

const lineRangeSchema = z.object({
  start: z.number().int().positive().describe('1-based inclusive start line'),
  end: z.number().int().positive().describe('1-based inclusive end line'),
});

const writeArgsSchema = z.object({
  path: z.string().min(1).describe('Vault-relative file path'),
  content: z.string().describe('Raw file content'),
  overwrite: z.boolean().optional().describe('Allow replacing an existing file'),
  dryRun: z.boolean().optional().describe('Return diff without writing'),
});

const editArgsSchema = z.object({
  path: z.string().min(1).describe('Vault-relative file path'),
  replace: z.string().optional().describe('Exact text to replace'),
  regex: z.string().optional().describe('Regex pattern to replace'),
  line: z.number().int().positive().optional().describe('1-based line number to replace'),
  range: lineRangeSchema.optional().describe('1-based inclusive range to replace'),
  with: z.string().describe('Raw replacement text'),
  all: z.boolean().optional().describe('Replace all exact/regex matches'),
  dryRun: z.boolean().optional().describe('Return diff without writing'),
});

const patchArgsSchema = z.object({
  patch: z.string().describe('Codex-style patch text'),
  dryRun: z.boolean().optional().describe('Return diff without writing'),
});

const commandRunArgsSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      'Optsidian or native/plugin command verb to run, e.g. "para-zk:create-llm-wiki", "read", or "search". Same as the CLI command word.',
    ),
  args: z
    .array(z.string())
    .optional()
    .describe(
      'Argument tokens passed through verbatim as argv (no shell parsing), e.g. ["title=Diffusion Policy", "key=body", "format=json"]. Add format=json yourself when you want JSON.',
    ),
});

export type UsageToolArgs = z.infer<typeof usageArgsSchema>;
export type WriteToolArgs = z.infer<typeof writeArgsSchema>;
export type EditToolArgs = z.infer<typeof editArgsSchema>;
export type PatchToolArgs = z.infer<typeof patchArgsSchema>;
export type CommandRunToolArgs = z.infer<typeof commandRunArgsSchema>;

export type OptsidianToolHandlers = {
  command_map(args: UsageToolArgs): CallToolResult;
  command_run(args: CommandRunToolArgs): CallToolResult;
  write(args: WriteToolArgs): CallToolResult;
  edit(args: EditToolArgs): Promise<CallToolResult>;
  apply_patch(args: PatchToolArgs): CallToolResult;
};

export function createToolHandlers(resolveVaultRoot: () => string, onToolCall?: () => void): OptsidianToolHandlers {
  const afterTool = () => {
    onToolCall?.();
  };
  return {
    command_map: () => runTool(() => usagePayload()),
    command_run: (args) =>
      runTool(() => {
        const result = runOptsidianCommand(args);
        afterTool();
        return result;
      }),
    write: (args) =>
      runTool(() => {
        const result = writeVaultFile(resolveVaultRoot(), args);
        afterTool();
        return result;
      }),
    edit: (args) =>
      runAsyncTool(async () => {
        const result = await editVaultFile(resolveVaultRoot(), editArgsToParams(args));
        afterTool();
        return result;
      }),
    apply_patch: (args) =>
      runTool(() => {
        const result = applyVaultPatch(resolveVaultRoot(), args);
        afterTool();
        return result;
      }),
  };
}

// Run any optsidian command (CLI-only or native-delegated) by invoking the sibling
// optsidian CLI as a child process. The MCP server runs outside the host Bash sandbox,
// so the child inherits that: native-delegated commands (para-zk:*, other plugin
// commands) reach the running Obsidian over its unix socket, and CLI-only commands
// (read/search/similarity/grep/frontmatter) read the vault — identically to the real CLI. This is
// the only tool that drives native/plugin commands; the file-mutation tools above do not.
function runOptsidianCommand(args: CommandRunToolArgs): ToolPayload {
  const cliBin = fileURLToPath(new URL('optsidian', import.meta.url));
  const argv = [cliBin, args.command, ...(args.args ?? [])];
  const result = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    return {
      ok: false,
      command: args.command,
      exit_code: 1,
      stdout: result.stdout ?? '',
      stderr: result.error.message,
    };
  }
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return {
    ok: exitCode === 0,
    command: args.command,
    exit_code: exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function registerOptsidianTools(
  server: McpServer,
  resolveVaultRoot: () => string,
  onToolCall?: () => void,
): void {
  const handlers = createToolHandlers(resolveVaultRoot, onToolCall);
  server.registerTool(
    'command_map',
    {
      description:
        'Call this first when you need Optsidian commands beyond the MCP mutation tools. Shows CLI-only commands, MCP tools, and native delegated commands.',
      inputSchema: usageArgsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => handlers.command_map(args),
  );
  server.registerTool(
    'command_run',
    {
      description:
        'Run any Optsidian command (CLI-only like read/search/similarity/grep/frontmatter, or native-delegated like para-zk:* and other plugin commands) and capture its output. Use this when you need a command beyond the file-mutation tools — it reaches the running Obsidian. Pass the command verb in `command` and key=value tokens in `args` (argv, no shell). Returns {ok, command, exit_code, stdout, stderr}.',
      inputSchema: commandRunArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => handlers.command_run(args),
  );
  server.registerTool(
    'write',
    {
      description: 'Whole-file write inside the configured Obsidian vault.',
      inputSchema: writeArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handlers.write(args),
  );
  server.registerTool(
    'edit',
    {
      description:
        'Targeted file edit inside the configured Obsidian vault using exactly one of replace, regex, line, or range.',
      inputSchema: editArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handlers.edit(args),
  );
  server.registerTool(
    'apply_patch',
    {
      description: 'Patch-based mutation inside the configured Obsidian vault.',
      inputSchema: patchArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handlers.apply_patch(args),
  );
}

function editArgsToParams(args: EditToolArgs): EditParams {
  return {
    path: args.path,
    selector: editSelector(args),
    replacement: args.with,
    all: args.all,
    dryRun: args.dryRun,
  };
}

function editSelector(args: EditToolArgs): EditSelector {
  const selectors = [
    args.replace !== undefined,
    args.regex !== undefined,
    args.line !== undefined,
    args.range !== undefined,
  ].filter(Boolean).length;
  if (selectors !== 1) {
    throw new UsageError('Use exactly one of replace, regex, line, or range');
  }
  if (args.replace !== undefined) return { kind: 'replace', value: args.replace };
  if (args.regex !== undefined) return { kind: 'regex', value: args.regex };
  if (args.line !== undefined) return { kind: 'line', value: args.line };
  return { kind: 'range', value: args.range as LineRange };
}
