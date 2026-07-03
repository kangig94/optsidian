export type ParsedNoteLinkKind = 'wikilink' | 'markdown';

export type UnresolvedNoteLink = {
  kind: ParsedNoteLinkKind;
  embed: boolean;
  rawTarget: string;
  targetPath: string;
  label: string;
};

export type ParsedNoteLinks = {
  renderedText: string;
  unresolvedLinks: UnresolvedNoteLink[];
};

export function parseNoteLinks(body: string): ParsedNoteLinks {
  const unresolvedLinks: UnresolvedNoteLink[] = [];
  let renderedText = '';
  let index = 0;

  while (index < body.length) {
    const wiki = parseWikilinkAt(body, index);
    if (wiki) {
      renderedText += wiki.label;
      unresolvedLinks.push(wiki.link);
      index = wiki.end;
      continue;
    }

    const markdown = parseMarkdownLinkAt(body, index);
    if (markdown) {
      renderedText += markdown.label;
      if (markdown.link) unresolvedLinks.push(markdown.link);
      index = markdown.end;
      continue;
    }

    renderedText += body[index];
    index += 1;
  }

  return { renderedText, unresolvedLinks };
}

export function noteLinkTargetPath(rawTarget: string): string {
  const strippedAnchor = splitTargetAnchor(rawTarget).path;
  return stripBlockId(stripQuery(strippedAnchor)).trim();
}

function parseWikilinkAt(
  body: string,
  index: number,
): { end: number; label: string; link: UnresolvedNoteLink } | undefined {
  const embed = body[index] === '!' && body.startsWith('[[', index + 1);
  const openIndex = embed ? index + 1 : index;
  if (!body.startsWith('[[', openIndex)) return undefined;

  const closeIndex = body.indexOf(']]', openIndex + 2);
  if (closeIndex < 0) return undefined;

  const inner = body.slice(openIndex + 2, closeIndex);
  const pipeIndex = findUnescaped(inner, '|');
  const rawTarget = unescapeLinkEscapes((pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner).trim());
  const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : '';
  const label = cleanedLabel(alias || labelForTarget(rawTarget));
  return {
    end: closeIndex + 2,
    label,
    link: {
      kind: 'wikilink',
      embed,
      rawTarget,
      targetPath: noteLinkTargetPath(rawTarget),
      label,
    },
  };
}

function parseMarkdownLinkAt(
  body: string,
  index: number,
): { end: number; label: string; link?: UnresolvedNoteLink } | undefined {
  const embed = body[index] === '!' && body[index + 1] === '[';
  const openIndex = embed ? index + 1 : index;
  if (body[openIndex] !== '[') return undefined;
  if (body.startsWith('[[', openIndex)) return undefined;

  const labelEnd = findClosingDelimited(body, openIndex, '[', ']');
  if (labelEnd < 0 || body[labelEnd + 1] !== '(') return undefined;

  const targetOpen = labelEnd + 1;
  const targetEnd = findClosingDelimited(body, targetOpen, '(', ')');
  if (targetEnd < 0) return undefined;

  const displayText = cleanedLabel(body.slice(openIndex + 1, labelEnd));
  const rawTarget = markdownDestination(body.slice(targetOpen + 1, targetEnd));
  const label = displayText || cleanedLabel(labelForTarget(rawTarget));
  const link = rawTarget
    ? {
        kind: 'markdown' as const,
        embed,
        rawTarget,
        targetPath: noteLinkTargetPath(rawTarget),
        label,
      }
    : undefined;
  return {
    end: targetEnd + 1,
    label,
    ...(link ? { link } : {}),
  };
}

function findUnescaped(value: string, needle: string): number {
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === needle) return index;
  }
  return -1;
}

function findClosingDelimited(value: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let escaped = false;
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function markdownDestination(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('<')) {
    const end = findUnescaped(trimmed.slice(1), '>');
    if (end >= 0) return unescapeLinkEscapes(trimmed.slice(1, end + 1).trim());
  }
  const titled = /^(.+?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/u.exec(trimmed);
  return unescapeLinkEscapes((titled?.[1] ?? trimmed).trim());
}

function labelForTarget(rawTarget: string): string {
  const { path, anchor } = splitTargetAnchor(rawTarget);
  const pathLabel = basenameWithoutExtension(stripBlockId(stripQuery(path)));
  const headingLabel = headingAnchorLabel(anchor);
  return [pathLabel, headingLabel].filter(Boolean).join(' ').trim() || headingLabel || pathLabel;
}

function splitTargetAnchor(rawTarget: string): { path: string; anchor: string } {
  const trimmed = rawTarget.trim();
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) return { path: trimmed, anchor: '' };
  return {
    path: trimmed.slice(0, hashIndex),
    anchor: trimmed.slice(hashIndex + 1),
  };
}

function headingAnchorLabel(anchor: string): string {
  return stripBlockId(anchor.replace(/#/gu, ' ')).replace(/\s+/gu, ' ').trim();
}

function stripQuery(value: string): string {
  const queryIndex = value.indexOf('?');
  return queryIndex < 0 ? value : value.slice(0, queryIndex);
}

function stripBlockId(value: string): string {
  return value
    .replace(/\^[^\s#|)\]]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function basenameWithoutExtension(targetPath: string): string {
  const normalized = decodePathLabel(targetPath).replace(/\\/gu, '/').replace(/\/+$/gu, '');
  const basename = normalized.split('/').filter(Boolean).pop() ?? '';
  return basename.replace(/\.[^.]+$/u, '').trim();
}

function decodePathLabel(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanedLabel(value: string): string {
  if (!value) return '';
  return unescapeLinkEscapes(parseNoteLinks(value).renderedText).replace(/\s+/gu, ' ').trim();
}

function unescapeLinkEscapes(value: string): string {
  return value.replace(/\\([\\[\]()<>|#!"'])/gu, '$1');
}
