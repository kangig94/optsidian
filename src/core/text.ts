export type TextLines = {
  lines: string[];
  eol: string;
  finalNewline: boolean;
};

export function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function splitText(text: string): TextLines {
  if (text.length === 0) {
    return { lines: [], eol: "\n", finalNewline: false };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r\n|\n/);
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export function joinText(parts: TextLines): string {
  const body = parts.lines.join(parts.eol);
  return parts.finalNewline ? `${body}${parts.eol}` : body;
}

export function lineNumbered(lines: string[], startLine: number): string {
  const end = startLine + lines.length - 1;
  const width = String(Math.max(end, 1)).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`)
    .join("\n");
}

export function simpleDiff(pathLabel: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const oldLines = splitText(before).lines;
  const newLines = splitText(after).lines;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const from = Math.max(0, prefix - context);
  const oldTo = Math.min(oldLines.length - 1, oldSuffix + context);
  const newTo = Math.min(newLines.length - 1, newSuffix + context);
  const out = [`--- ${pathLabel}`, `+++ ${pathLabel}`, `@@`];
  for (let i = from; i < prefix; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = prefix; i <= oldSuffix; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = prefix; i <= newSuffix; i += 1) out.push(`+${newLines[i]}`);
  const suffixEnd = Math.max(oldTo, newTo);
  for (let i = oldSuffix + 1; i <= suffixEnd && i < oldLines.length; i += 1) {
    if (oldLines[i] === newLines[i - oldSuffix + newSuffix]) out.push(` ${oldLines[i]}`);
  }
  return out.join("\n");
}
