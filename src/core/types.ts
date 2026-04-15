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

export type SearchParams = {
  query: string;
  path?: string;
  context?: number;
  limit?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  all?: boolean;
  includeHidden?: boolean;
};

export type SearchLine = {
  line: number;
  text: string;
};

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
  contextBefore: SearchLine[];
  contextAfter: SearchLine[];
};

export type SearchResult = {
  ok: true;
  command: "search";
  query: string;
  matches: SearchMatch[];
  count: number;
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
