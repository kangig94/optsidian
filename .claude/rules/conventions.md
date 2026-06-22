# Conventions

**Commits**: Imperative, capitalized subject lines with no conventional-commit prefix (e.g. "Improve Korean search and restructure modules", "Move search core into module directory").

**Naming**: kebab-case for CLI command names and source file names (`apply-patch.ts`, `write-file.ts`); camelCase for TypeScript identifiers; SCREAMING_SNAKE_CASE for module-level constants (`SEARCH_SCHEMA_VERSION`, `EXTENDED_COMMANDS`).

**Modules**: ESM only (`"type": "module"`). Imports use NodeNext resolution with explicit extensions where required; `verbatimModuleSyntax` is on, so use `import type` for type-only imports.

**Tests**: `node:test`, run via `tsx` against the TypeScript source. Test files live in `test/` as `*.test.mjs`. `npm test` runs `typecheck → build → test` in that order — a typecheck or build failure fails the test run.

**Formatting**: No linter or formatter is configured. TypeScript `strict` (plus `erasableSyntaxOnly`) is the gate — `npm run typecheck` must pass with zero errors.
