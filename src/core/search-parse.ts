import path from "node:path";

export type SearchDocument = {
  id: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: string[];
  body: string;
};

type Frontmatter = {
  title?: string;
  aliases: string[];
  tags: string[];
};

export function parseMarkdownNote(relPath: string, content: string): SearchDocument {
  const parsed = splitFrontmatter(content);
  const headings = extractHeadings(parsed.body);
  const firstH1 = headings.find((heading) => heading.level === 1)?.text;
  const title = parsed.frontmatter.title || firstH1 || filenameTitle(relPath);
  const inlineTags = extractInlineTags(parsed.body);
  return {
    id: relPath,
    path: relPath,
    title,
    aliases: parsed.frontmatter.aliases,
    tags: unique([...parsed.frontmatter.tags, ...inlineTags]),
    headings: headings.map((heading) => heading.text),
    body: parsed.body
  };
}

function splitFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: { aliases: [], tags: [] }, body: content };
  }

  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed !== "---" && trimmed !== "...") continue;
    const yaml = lines.slice(1, index);
    return {
      frontmatter: parseSimpleFrontmatter(yaml),
      body: lines.slice(index + 1).join("\n")
    };
  }

  return { frontmatter: { aliases: [], tags: [] }, body: content };
}

function parseSimpleFrontmatter(lines: string[]): Frontmatter {
  const output: Frontmatter = { aliases: [], tags: [] };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const raw = match[2].trim();
    if (key === "title" && raw) {
      output.title = stripQuotes(raw);
      continue;
    }
    if (key !== "tags" && key !== "aliases" && key !== "alias") continue;

    const block: string[] = [];
    let next = index + 1;
    while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
      block.push(lines[next].replace(/^\s+-\s+/, ""));
      next += 1;
    }
    if (block.length > 0) {
      index = next - 1;
    }

    const values = block.length > 0 ? block : parseInlineList(raw);
    if (key === "tags") output.tags.push(...values.map(normalizeTag).filter(Boolean));
    else output.aliases.push(...values.map(stripQuotes).filter(Boolean));
  }
  output.aliases = unique(output.aliases);
  output.tags = unique(output.tags);
  return output;
}

function parseInlineList(raw: string): string[] {
  if (!raw) return [];
  const value = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return value.split(",").map(stripQuotes).map((item) => item.trim()).filter(Boolean);
}

function extractHeadings(content: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2].trim() });
  }
  return headings;
}

function extractInlineTags(content: string): string[] {
  const tags: string[] = [];
  const regex = /(^|[\s([>{])#([\p{L}\p{N}_/-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    tags.push(normalizeTag(match[2]));
  }
  return unique(tags.filter(Boolean));
}

function filenameTitle(relPath: string): string {
  return path.basename(relPath, path.extname(relPath)).replace(/[_-]+/g, " ").trim() || relPath;
}

function normalizeTag(value: string): string {
  return stripQuotes(value).replace(/^#+/, "").trim();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
