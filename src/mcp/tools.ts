import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  applyVaultPatch,
  addFrontmatterValue,
  deleteFrontmatter,
  editVaultFile,
  removeFrontmatterValue,
  setFrontmatter,
  writeVaultFile
} from "../core/index.js";
import type { EditParams, EditSelector, FrontmatterValue, LineRange } from "../core/index.js";
import { usagePayload } from "../cli/help.js";
import { UsageError } from "../errors.js";
import { runTool } from "./result.js";

const usageArgsSchema = z.object({});

const lineRangeSchema = z.object({
  start: z.number().int().positive().describe("1-based inclusive start line"),
  end: z.number().int().positive().describe("1-based inclusive end line")
});

const frontmatterValueSchema = z.json().describe("JSON-compatible frontmatter value");

const frontmatterSetArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative Markdown file path"),
  key: z.string().min(1).describe("Top-level frontmatter key"),
  value: frontmatterValueSchema,
  dryRun: z.boolean().optional().describe("Return diff without writing")
});

const frontmatterDeleteArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative Markdown file path"),
  key: z.string().min(1).describe("Top-level frontmatter key"),
  dryRun: z.boolean().optional().describe("Return diff without writing")
});

const frontmatterListMutationArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative Markdown file path"),
  key: z.string().min(1).describe("Top-level frontmatter list key"),
  value: frontmatterValueSchema,
  dryRun: z.boolean().optional().describe("Return diff without writing")
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
export type FrontmatterSetToolArgs = z.infer<typeof frontmatterSetArgsSchema>;
export type FrontmatterDeleteToolArgs = z.infer<typeof frontmatterDeleteArgsSchema>;
export type FrontmatterListMutationToolArgs = z.infer<typeof frontmatterListMutationArgsSchema>;
export type WriteToolArgs = z.infer<typeof writeArgsSchema>;
export type EditToolArgs = z.infer<typeof editArgsSchema>;
export type PatchToolArgs = z.infer<typeof patchArgsSchema>;

export type OptsidianToolHandlers = {
  usage(args: UsageToolArgs): CallToolResult;
  frontmatter_set(args: FrontmatterSetToolArgs): CallToolResult;
  frontmatter_delete(args: FrontmatterDeleteToolArgs): CallToolResult;
  frontmatter_add(args: FrontmatterListMutationToolArgs): CallToolResult;
  frontmatter_remove(args: FrontmatterListMutationToolArgs): CallToolResult;
  write(args: WriteToolArgs): CallToolResult;
  edit(args: EditToolArgs): CallToolResult;
  apply_patch(args: PatchToolArgs): CallToolResult;
};

export function createToolHandlers(vaultRoot: string): OptsidianToolHandlers {
  return {
    usage: () => runTool(() => usagePayload()),
    frontmatter_set: (args) =>
      runTool(() => setFrontmatter(vaultRoot, { path: args.path, key: args.key, value: args.value as FrontmatterValue, dryRun: args.dryRun })),
    frontmatter_delete: (args) => runTool(() => deleteFrontmatter(vaultRoot, args)),
    frontmatter_add: (args) =>
      runTool(() => addFrontmatterValue(vaultRoot, { path: args.path, key: args.key, value: args.value as FrontmatterValue, dryRun: args.dryRun })),
    frontmatter_remove: (args) =>
      runTool(() => removeFrontmatterValue(vaultRoot, { path: args.path, key: args.key, value: args.value as FrontmatterValue, dryRun: args.dryRun })),
    write: (args) => runTool(() => writeVaultFile(vaultRoot, args)),
    edit: (args) => runTool(() => editVaultFile(vaultRoot, editArgsToParams(args))),
    apply_patch: (args) => runTool(() => applyVaultPatch(vaultRoot, args))
  };
}

export function registerOptsidianTools(server: McpServer, vaultRoot: string): void {
  const handlers = createToolHandlers(vaultRoot);
  server.registerTool(
    "usage",
    {
      description: "Return a short routing summary, tell agents to prefer MCP tools when available, and point detailed syntax to CLI help.",
      inputSchema: usageArgsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => handlers.usage(args)
  );
  server.registerTool(
    "frontmatter_set",
    {
      description: "Set a top-level YAML frontmatter key in a Markdown file inside the configured Obsidian vault.",
      inputSchema: frontmatterSetArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.frontmatter_set(args)
  );
  server.registerTool(
    "frontmatter_delete",
    {
      description: "Delete a top-level YAML frontmatter key from a Markdown file inside the configured Obsidian vault.",
      inputSchema: frontmatterDeleteArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.frontmatter_delete(args)
  );
  server.registerTool(
    "frontmatter_add",
    {
      description: "Append a JSON-compatible value to a top-level YAML frontmatter list key.",
      inputSchema: frontmatterListMutationArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.frontmatter_add(args)
  );
  server.registerTool(
    "frontmatter_remove",
    {
      description: "Remove a JSON-compatible value from a top-level YAML frontmatter list key.",
      inputSchema: frontmatterListMutationArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.frontmatter_remove(args)
  );
  server.registerTool(
    "write",
    {
      description: "Write a whole UTF-8 file inside the configured Obsidian vault.",
      inputSchema: writeArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.write(args)
  );
  server.registerTool(
    "edit",
    {
      description: "Edit one file inside the configured Obsidian vault using exactly one of replace, regex, line, or range.",
      inputSchema: editArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.edit(args)
  );
  server.registerTool(
    "apply_patch",
    {
      description: "Apply a Codex-style patch inside the configured Obsidian vault.",
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
