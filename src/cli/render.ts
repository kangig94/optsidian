import { UsageError } from "../errors.js";
import type { GrepResult, MutationResult, ReadResult, SearchIndexMutationResult, SearchIndexStatusResult, SearchResult } from "../core/types.js";

export type OutputFormat = "text" | "json";

export function parseFormat(value: string | undefined): OutputFormat {
  const format = value ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError("format must be text or json");
  }
  return format;
}

export function renderRead(result: ReadResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify({
      ok: result.ok,
      command: result.command,
      path: result.path,
      range: result.range,
      truncated: result.truncated,
      content: result.content
    })}\n`;
  }
  return `path: ${result.path}\nlines: ${result.range.start}-${result.range.end}/${result.range.total}\ntruncated: ${result.truncated}\n\n${result.numberedText}\n`;
}

export function renderGrep(result: GrepResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  if (result.matches.length === 0) {
    return "No matches found.\n";
  }
  const out: string[] = [`matches: ${result.matches.length}`];
  for (const match of result.matches) {
    for (const before of match.contextBefore) out.push(`${match.path}:${before.line}- | ${before.text}`);
    out.push(`${match.path}:${match.line}: | ${match.text}`);
    for (const after of match.contextAfter) out.push(`${match.path}:${after.line}+ | ${after.text}`);
  }
  return `${out.join("\n")}\n`;
}

export function renderSearch(result: SearchResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  if (result.matches.length === 0) {
    return `query: ${result.query}\ncount: 0\nindex: ${result.index.status}\n\nNo matches found.\n`;
  }
  const out = [`query: ${result.query}`, `count: ${result.matches.length}`, `index: ${result.index.status}`, ""];
  result.matches.forEach((match, index) => {
    out.push(`${index + 1}. ${match.path}`);
    out.push(`score: ${match.score}`);
    out.push(`title: ${match.title}`);
    if (match.tags.length > 0) out.push(`tags: ${match.tags.join(", ")}`);
    if (match.matchedFields.length > 0) out.push(`matched: ${match.matchedFields.join(", ")}`);
    if (match.snippets.length > 0) {
      out.push("snippets:");
      for (const snippet of match.snippets) out.push(`  ${snippet.line} | ${snippet.text}`);
    }
    out.push("");
  });
  return `${out.join("\n")}`;
}

export function renderIndexResult(result: SearchIndexStatusResult | SearchIndexMutationResult): string {
  if (result.action === "status") {
    return [
      `index: ${result.ready ? "ready" : "missing"}`,
      `stale: ${result.stale}`,
      `documents: ${result.documents}`,
      result.builtAt ? `built: ${result.builtAt}` : undefined,
      `cache: ${result.cacheDir}`,
      result.reason ? `reason: ${result.reason}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
      .concat("\n");
  }
  if (result.action === "rebuild") {
    return `index: rebuilt\ndocuments: ${result.documents}\nbuilt: ${result.builtAt ?? ""}\ncache: ${result.cacheDir}\n`;
  }
  return `index: cleared\ncache: ${result.cacheDir}\n`;
}

export function renderMutation(result: MutationResult): string {
  if (result.message && result.changes.length === 0) {
    return `${result.message}\n`;
  }

  if (result.dryRun) {
    if (result.command === "copy") {
      const change = result.changes[0];
      const source = change?.from ? `${change.from} to ` : "";
      return `Dry run. Would copy ${source}${change?.path ?? ""}\n`;
    }
    if (result.command === "mkdir") {
      const target = result.changes[0]?.path ?? "";
      return `Dry run. Would create directory ${target}\n`;
    }
    if (result.command === "apply_patch") {
      return renderDryRunPatch(result);
    }
    const change = result.changes[0];
    const verb = result.command === "write" && change?.code === "A" ? "create" : "update";
    const diff = result.changes.map((item) => item.diff).filter(Boolean).join("\n");
    return `Dry run. Would ${verb} ${change?.path ?? ""}\n${diff}\n`;
  }

  if (result.command === "mkdir") {
    return `Success. Created directory:\n${result.changes.map((change) => `${change.code} ${change.path}`).join("\n")}\n`;
  }

  return `Success. Updated the following files:\n${result.changes.map((change) => `${change.code} ${change.path}`).join("\n")}\n`;
}

function renderDryRunPatch(result: MutationResult): string {
  const out = ["Dry run. Would update the following files:", ...result.changes.map((change) => `${change.code} ${change.path}`)];
  for (const change of result.changes) {
    if (change.diff) out.push(change.diff);
  }
  return `${out.join("\n")}\n`;
}
