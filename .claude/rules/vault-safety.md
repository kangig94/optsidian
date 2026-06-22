---
paths:
  - "src/core/write.ts"
  - "src/core/write-file.ts"
  - "src/core/edit.ts"
  - "src/core/apply-patch.ts"
  - "src/core/frontmatter.ts"
  - "src/core/copy.ts"
  - "src/core/mkdir.ts"
  - "src/core/path.ts"
  - "src/core/vault-access.ts"
  - "src/core/validation.ts"
---
# Vault Safety

Iron law: **a mutation must never corrupt or escape the user's vault.** These files are the only
code allowed to write into a vault; treat every change here as touching user data.

## Principles

- **Atomic writes.** All writes go through the low-level temp-file-plus-rename path (`write-file.ts`); a write is never observable half-complete. Higher-level `write.ts` adds the vault resolve, the directory check, the overwrite guard, and the diff.
- **Path resolution is mandatory.** Every path resolves through `resolveVaultPath` (`path.ts`): relative paths resolve from the vault root (not cwd), absolute paths are allowed only if they resolve inside the vault, existing paths are checked with `realpath`, and symlink escapes are rejected. Never bypass it.
- **Patches refuse to clobber.** In `apply-patch.ts`, an `Add` refuses an existing file and a `Move` refuses to overwrite the destination (unless it is the same file). The patch overlay is in-memory; per-file writes are atomic but intentionally non-transactional (Codex semantics).
- **Frontmatter is byte-preserving.** `frontmatter.ts` preserves the BOM, the line endings, and the body bytes exactly; it rejects invalid YAML, duplicate keys, and non-mapping roots.

## DO / DON'T

| DO | DON'T |
|----|-------|
| Route every new file path through `resolveVaultPath` before any I/O | Build a path with `path.join(cwd, ...)` and write to it |
| Write via the atomic temp+rename helper | `fs.writeFile` a vault path directly, leaving partial state on crash |
| Preserve BOM/EOL/body bytes when editing frontmatter | Re-serialize the whole document and lose trailing newlines or comments |
| Keep `Add` refusing existing files and `Move` refusing overwrite | Relax the clobber guards "for convenience" |
| Validate int/range inputs via `validation.ts` before use | Trust caller-supplied offsets/lengths unchecked |
