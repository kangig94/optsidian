import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { applyVaultPatch, editVaultFile, writeVaultFile } from "../core/index.js";
import type { EditParams, EditSelector, LineRange } from "../core/index.js";
import { usagePayload } from "../cli/help.js";
import { UsageError } from "../errors.js";
import { runTool } from "./result.js";

const usageArgsSchema = z.object({});

const lineRangeSchema = z.object({
  start: z.number().int().positive().describe("1-based inclusive start line"),
  end: z.number().int().positive().describe("1-based inclusive end line")
});

const writeArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative file path"),
  content: z.string().describe("Raw file content"),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file"),
  dryRun: z.boolean().optional().describe("Return diff without writing")
});

const editArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative file path"),
  replace: z.string().optional().describe("Exact text to replace"),
  regex: z.string().optional().describe("Regex pattern to replace"),
  line: z.number().int().positive().optional().describe("1-based line number to replace"),
  range: lineRangeSchema.optional().describe("1-based inclusive range to replace"),
  with: z.string().describe("Raw replacement text"),
  all: z.boolean().optional().describe("Replace all exact/regex matches"),
  dryRun: z.boolean().optional().describe("Return diff without writing")
});

const patchArgsSchema = z.object({
  patch: z.string().describe("Codex-style patch text"),
  dryRun: z.boolean().optional().describe("Return diff without writing")
});

export type UsageToolArgs = z.infer<typeof usageArgsSchema>;
export type WriteToolArgs = z.infer<typeof writeArgsSchema>;
export type EditToolArgs = z.infer<typeof editArgsSchema>;
export type PatchToolArgs = z.infer<typeof patchArgsSchema>;

export type OptsidianToolHandlers = {
  command_map(args: UsageToolArgs): CallToolResult;
  write(args: WriteToolArgs): CallToolResult;
  edit(args: EditToolArgs): CallToolResult;
  apply_patch(args: PatchToolArgs): CallToolResult;
};

export function createToolHandlers(resolveVaultRoot: () => string): OptsidianToolHandlers {
  return {
    command_map: () => runTool(() => usagePayload()),
    write: (args) => runTool(() => writeVaultFile(resolveVaultRoot(), args)),
    edit: (args) => runTool(() => editVaultFile(resolveVaultRoot(), editArgsToParams(args))),
    apply_patch: (args) => runTool(() => applyVaultPatch(resolveVaultRoot(), args))
  };
}

export function registerOptsidianTools(server: McpServer, resolveVaultRoot: () => string): void {
  const handlers = createToolHandlers(resolveVaultRoot);
  server.registerTool(
    "command_map",
    {
      description:
        "Call this first when you need Optsidian commands beyond the MCP mutation tools. Shows which Optsidian commands are CLI-only and which tools are exposed over MCP.",
      inputSchema: usageArgsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => handlers.command_map(args)
  );
  server.registerTool(
    "write",
    {
      description: "Whole-file write inside the configured Obsidian vault.",
      inputSchema: writeArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.write(args)
  );
  server.registerTool(
    "edit",
    {
      description: "Targeted file edit inside the configured Obsidian vault using exactly one of replace, regex, line, or range.",
      inputSchema: editArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.edit(args)
  );
  server.registerTool(
    "apply_patch",
    {
      description: "Patch-based mutation inside the configured Obsidian vault.",
      inputSchema: patchArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.apply_patch(args)
  );
}

function editArgsToParams(args: EditToolArgs): EditParams {
  return {
    path: args.path,
    selector: editSelector(args),
    replacement: args.with,
    all: args.all,
    dryRun: args.dryRun
  };
}

function editSelector(args: EditToolArgs): EditSelector {
  const selectors = [args.replace !== undefined, args.regex !== undefined, args.line !== undefined, args.range !== undefined].filter(Boolean).length;
  if (selectors !== 1) {
    throw new UsageError("Use exactly one of replace, regex, line, or range");
  }
  if (args.replace !== undefined) return { kind: "replace", value: args.replace };
  if (args.regex !== undefined) return { kind: "regex", value: args.regex };
  if (args.line !== undefined) return { kind: "line", value: args.line };
  return { kind: "range", value: args.range as LineRange };
}
