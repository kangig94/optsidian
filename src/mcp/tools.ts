import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  applyVaultPatch,
  copyVaultPath,
  editVaultFile,
  grepVault,
  mkdirVaultPath,
  readVaultFile,
  writeVaultFile
} from "../core/index.js";
import type { EditParams, EditSelector, LineRange } from "../core/index.js";
import { UsageError } from "../errors.js";
import { runTool } from "./result.js";

const lineRangeSchema = z.object({
  start: z.number().int().positive().describe("1-based inclusive start line"),
  end: z.number().int().positive().describe("1-based inclusive end line")
});

const readArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative file path"),
  lines: lineRangeSchema.optional().describe("1-based inclusive line range"),
  head: z.number().int().positive().optional().describe("First n lines"),
  tail: z.number().int().positive().optional().describe("Last n lines"),
  around: z.string().optional().describe("First line containing this text plus context"),
  context: z.number().int().nonnegative().optional().describe("Context lines for around"),
  maxChars: z.number().int().positive().optional().describe("Maximum returned characters")
});

const grepArgsSchema = z.object({
  query: z.string().describe("Text or regex query"),
  path: z.string().min(1).optional().describe("Vault-relative file or directory grep root"),
  context: z.number().int().nonnegative().optional().describe("Context lines around matches"),
  limit: z.number().int().positive().optional().describe("Maximum number of matches"),
  case: z.boolean().optional().describe("Use case-sensitive matching"),
  regex: z.boolean().optional().describe("Treat query as a regular expression"),
  all: z.boolean().optional().describe("Include non-Markdown files"),
  includeHidden: z.boolean().optional().describe("Include hidden directories except protected internals")
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

const copyArgsSchema = z.object({
  from: z.string().min(1).describe("Vault-relative source path"),
  to: z.string().min(1).describe("Vault-relative destination path"),
  recursive: z.boolean().optional().describe("Required for copying directories"),
  overwrite: z.boolean().optional().describe("Allow replacing an existing destination"),
  dryRun: z.boolean().optional().describe("Report copy without writing")
});

const mkdirArgsSchema = z.object({
  path: z.string().min(1).describe("Vault-relative directory path"),
  parents: z.boolean().optional().describe("Create parent directories; default true"),
  dryRun: z.boolean().optional().describe("Report directory creation without writing")
});

export type ReadToolArgs = z.infer<typeof readArgsSchema>;
export type GrepToolArgs = z.infer<typeof grepArgsSchema>;
export type WriteToolArgs = z.infer<typeof writeArgsSchema>;
export type EditToolArgs = z.infer<typeof editArgsSchema>;
export type PatchToolArgs = z.infer<typeof patchArgsSchema>;
export type CopyToolArgs = z.infer<typeof copyArgsSchema>;
export type MkdirToolArgs = z.infer<typeof mkdirArgsSchema>;

export type OptsidianToolHandlers = {
  read(args: ReadToolArgs): CallToolResult;
  grep(args: GrepToolArgs): CallToolResult;
  write(args: WriteToolArgs): CallToolResult;
  edit(args: EditToolArgs): CallToolResult;
  apply_patch(args: PatchToolArgs): CallToolResult;
  copy(args: CopyToolArgs): CallToolResult;
  mkdir(args: MkdirToolArgs): CallToolResult;
};

export function createToolHandlers(vaultRoot: string): OptsidianToolHandlers {
  return {
    read: (args) => runTool(() => readVaultFile(vaultRoot, args)),
    grep: (args) =>
      runTool(() =>
        grepVault(vaultRoot, {
          query: args.query,
          path: args.path,
          context: args.context,
          limit: args.limit,
          caseSensitive: args.case,
          regex: args.regex,
          all: args.all,
          includeHidden: args.includeHidden
        })
      ),
    write: (args) => runTool(() => writeVaultFile(vaultRoot, args)),
    edit: (args) => runTool(() => editVaultFile(vaultRoot, editArgsToParams(args))),
    apply_patch: (args) => runTool(() => applyVaultPatch(vaultRoot, args)),
    copy: (args) => runTool(() => copyVaultPath(vaultRoot, args)),
    mkdir: (args) => runTool(() => mkdirVaultPath(vaultRoot, args))
  };
}

export function registerOptsidianTools(server: McpServer, vaultRoot: string): void {
  const handlers = createToolHandlers(vaultRoot);
  server.registerTool(
    "read",
    {
      description: "Read a UTF-8 file inside the configured Obsidian vault with optional line range, head, tail, around, and output cap controls.",
      inputSchema: readArgsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => handlers.read(args)
  );
  server.registerTool(
    "grep",
    {
      description: "Find exact or regex line matches inside the configured Obsidian vault.",
      inputSchema: grepArgsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => handlers.grep(args)
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
  server.registerTool(
    "copy",
    {
      description: "Copy a file or directory inside the configured Obsidian vault.",
      inputSchema: copyArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (args) => handlers.copy(args)
  );
  server.registerTool(
    "mkdir",
    {
      description: "Create a directory inside the configured Obsidian vault.",
      inputSchema: mkdirArgsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args) => handlers.mkdir(args)
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
