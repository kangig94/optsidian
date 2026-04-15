export { applyVaultPatch } from "./apply-patch.js";
export { copyVaultPath } from "./copy.js";
export { editVaultFile } from "./edit.js";
export { grepVault } from "./grep.js";
export { mkdirVaultPath } from "./mkdir.js";
export { readVaultFile, DEFAULT_READ_MAX_CHARS } from "./read.js";
export { clearSearchIndex, getSearchIndexStatus, rebuildSearchIndex, searchVault } from "./search.js";
export { writeVaultFile } from "./write.js";
export type {
  ChangeCode,
  CopyParams,
  EditParams,
  EditSelector,
  FileChange,
  GrepLine,
  GrepMatch,
  GrepParams,
  GrepResult,
  LineRange,
  MkdirParams,
  MutationResult,
  PatchParams,
  ReadParams,
  ReadResult,
  SearchIndexMutationResult,
  SearchIndexStatusResult,
  SearchMatch,
  SearchParams,
  SearchResult,
  SearchSnippet,
  WriteParams
} from "./types.js";
