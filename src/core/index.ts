export { applyVaultPatch } from "./apply-patch.js";
export { copyVaultPath } from "./copy.js";
export { editVaultFile } from "./edit.js";
export { mkdirVaultPath } from "./mkdir.js";
export { readVaultFile, DEFAULT_READ_MAX_CHARS } from "./read.js";
export { searchVault } from "./search.js";
export { writeVaultFile } from "./write.js";
export type {
  ChangeCode,
  CopyParams,
  EditParams,
  EditSelector,
  FileChange,
  LineRange,
  MkdirParams,
  MutationResult,
  PatchParams,
  ReadParams,
  ReadResult,
  SearchLine,
  SearchMatch,
  SearchParams,
  SearchResult,
  WriteParams
} from "./types.js";
