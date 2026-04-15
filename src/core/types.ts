export type LineRange = {
  start: number;
  end: number;
};

export type ReadParams = {
  path: string;
  lines?: LineRange;
  head?: number;
  tail?: number;
  around?: string;
  context?: number;
  maxChars?: number;
};

export type ReadResult = {
  ok: true;
  command: "read";
  path: string;
  range: {
    start: number;
    end: number;
    total: number;
  };
  truncated: boolean;
  content: string;
  numberedText: string;
};

export type GrepParams = {
  query: string;
  path?: string;
  context?: number;
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  all?: boolean;
  includeHidden?: boolean;
};

export type GrepLine = {
  line: number;
  text: string;
};

export type GrepMatch = {
  path: string;
  line: number;
  text: string;
  contextBefore: GrepLine[];
  contextAfter: GrepLine[];
};

export type GrepResult = {
  ok: true;
  command: "grep";
  query: string;
  matches: GrepMatch[];
  count: number;
};

export type SearchParams = {
  query: string;
  path?: string;
  limit?: number;
};

export type SearchSnippet = {
  line: number;
  text: string;
};

export type SearchMatch = {
  path: string;
  score: number;
  title: string;
  tags: string[];
  matchedFields: string[];
  snippets: SearchSnippet[];
};

export type SearchResult = {
  ok: true;
  command: "search";
  query: string;
  count: number;
  index: {
    status: "fresh" | "rebuilt" | "scoped";
    documents: number;
    builtAt?: string;
  };
  matches: SearchMatch[];
};

export type SearchIndexStatusResult = {
  ok: true;
  command: "index";
  action: "status";
  ready: boolean;
  stale: boolean;
  cacheDir: string;
  documents: number;
  builtAt?: string;
  reason?: string;
};

export type SearchIndexMutationResult = {
  ok: true;
  command: "index";
  action: "rebuild" | "clear";
  cacheDir: string;
  documents: number;
  builtAt?: string;
};

export type ChangeCode = "A" | "M" | "D";

export type FileChange = {
  code: ChangeCode;
  path: string;
  from?: string;
  before?: string;
  after?: string;
  diff?: string;
};

export type MutationResult = {
  ok: true;
  command: "edit" | "write" | "copy" | "mkdir" | "apply_patch";
  dryRun: boolean;
  changes: FileChange[];
  message?: string;
};

export type EditSelector =
  | { kind: "replace"; value: string }
  | { kind: "regex"; value: string }
  | { kind: "line"; value: number }
  | { kind: "range"; value: LineRange };

export type EditParams = {
  path: string;
  selector: EditSelector;
  replacement: string;
  all?: boolean;
  dryRun?: boolean;
};

export type WriteParams = {
  path: string;
  content: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type CopyParams = {
  from: string;
  to: string;
  recursive?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
};

export type MkdirParams = {
  path: string;
  parents?: boolean;
  dryRun?: boolean;
};

export type PatchParams = {
  patch: string;
  dryRun?: boolean;
};
