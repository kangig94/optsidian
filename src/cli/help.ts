import { implementedCommands } from "./policy.js";
import { OPTSIDIAN_VERSION } from "../version.js";

export function helpText(): string {
  return `optsidian ${OPTSIDIAN_VERSION}

Usage: optsidian <command> [options]

Native-first policy:
  Commands already handled well by Obsidian are delegated unchanged.
  Optimized commands replace native behavior only when they add LLM-focused controls.
  Use "optsidian raw <args...>" to force native Obsidian CLI execution.

Optimized:
  read                  Read a vault file with line ranges and output caps
    path=<path>         Vault-relative path
    lines=a:b           1-based inclusive line range
    head=<n>            First n lines
    tail=<n>            Last n lines
    around=<text>       First matching line plus context
    context=<n>         Context lines for around (default: 3)
    max-chars=<n>       Output cap (default: 20000)
    format=text|json    Output format (default: text)

Extended:
  search                Ranked note search over title, tags, aliases, headings, path, and body
    query=<text>        Search query
    path=<dir|file>     Vault-relative search scope
    limit=<n>           Max notes (default: 10)
    format=text|json    Output format (default: text)

  index                 Manage the ranked search cache
    status              Show cache status (default)
    rebuild             Rebuild search cache
    clear               Delete search cache

  grep                  Find exact or regex line matches in vault text
    query=<text>        Query text or regex
    path=<dir|file>     Vault-relative grep root
    context=<n>         Context lines
    limit=<n>           Max matches (default: 50)
    case                Case-sensitive
    regex               Treat query as regex
    all                 Include non-Markdown files
    include-hidden      Include hidden directories except protected internals
    format=text|json    Output format (default: text)

  edit                  Exact, regex, line, or range replacement
  apply_patch           Codex-compatible patch application
  write                 Whole-file write with overwrite guard
  copy                  Copy files or directories within the vault
  mkdir                 Create a directory within the vault

Delegation:
  raw <args...>         Call native obsidian exactly
  <other command>       Delegated to native obsidian

Implemented commands: ${implementedCommands().join(", ")}
`;
}
