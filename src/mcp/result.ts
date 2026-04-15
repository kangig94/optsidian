import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeError, UsageError } from "../errors.js";

export type ToolPayload = Record<string, unknown>;

export function toolResult(payload: ToolPayload): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

export function toolError(error: unknown): CallToolResult {
  const payload = {
    ok: false,
    errorType: errorType(error),
    message: error instanceof Error ? error.message : String(error)
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

export function runTool(fn: () => ToolPayload): CallToolResult {
  try {
    return toolResult(fn());
  } catch (error) {
    return toolError(error);
  }
}

export async function runAsyncTool(fn: () => ToolPayload | Promise<ToolPayload>): Promise<CallToolResult> {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolError(error);
  }
}

function errorType(error: unknown): "usage" | "runtime" | "internal" {
  if (error instanceof UsageError) return "usage";
  if (error instanceof RuntimeError) return "runtime";
  return "internal";
}
