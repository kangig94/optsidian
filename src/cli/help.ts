import { listObsidianCommands } from "../native/obsidian.js";
import { EXTENDED_COMMANDS, OPTIMIZED_COMMANDS, implementedCommands } from "./policy.js";
import { OPTSIDIAN_VERSION } from "../version.js";

type ImplementedCommand = (typeof OPTIMIZED_COMMANDS)[number] | (typeof EXTENDED_COMMANDS)[number];

type HelpOption = {
  name: string;
  description: string;
};

type CommandHelp = {
  summary: string;
  usage: string[];
  options: HelpOption[];
  notes?: string[];
};

export const CLI_ONLY_COMMANDS = ["read", "search", "grep", "index", "config", "copy", "mkdir", "open-gui", "update", "frontmatter", "plugin:install"] as const;
export const MCP_TOOL_NAMES = ["command_map", "command_run", "write", "edit", "apply_patch"] as const;

const COMMAND_HELP: Record<ImplementedCommand, CommandHelp> = {
  read: {
    summary: "Read a vault file with line ranges and output caps",
    usage: [
      "optsidian read path=<path> [lines=a:b|head=n|tail=n|around=<text>] [context=n] [max-lines=n] [format=text|json]"
    ],
    options: [
      { name: "path=<path>", description: "Vault-relative file path" },
      { name: "lines=a:b", description: "1-based inclusive line range" },
      { name: "head=<n>", description: "First n lines" },
      { name: "tail=<n>", description: "Last n lines" },
      { name: "around=<text>", description: "First line containing this text plus context" },
      { name: "context=<n>", description: "Context lines for around (default: 3)" },
      { name: "max-lines=<n>", description: "Max lines returned; range.end is the actual last line so paging never skips (default: 2000)" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ],
    notes: ["Use only one of lines=, head=, tail=, or around=."]
  },
  search: {
    summary: "Ranked note search over title, tags, aliases, headings, path, and body",
    usage: [
      "optsidian search query=<text> [tag=<tag>[,<tag>...]] [path=<dir|file>] [field=<field>[,<field>...]] [limit=<n>] [format=text|json]",
      "optsidian search tag=<tag>[,<tag>...] [path=<dir|file>] [limit=<n>] [format=text|json]"
    ],
    options: [
      { name: "query=<text>", description: "Ranked note search query" },
      { name: "tag=<tag,...>", description: "Exact tag filter; multiple tags use AND semantics" },
      { name: "path=<dir|file>", description: "Vault-relative search scope" },
      { name: "field=<field,...>", description: "Restrict query matching to title, aliases, tags, headings, path, or body" },
      { name: "limit=<n>", description: "Maximum notes to return (default: 10)" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ],
    notes: [
      "Search is CLI-only. Use MCP command_map for routing and CLI help discovery.",
      "query is required unless tag= is provided.",
      "field= is only valid when query= is present.",
      "Search indexes analyzer tokens; default baseline is Intl.Segmenter plus Latin folding and ASCII stemming.",
      "CLI search wakes the background index daemon for vaults Optsidian accessed in the last 7 days unless OPTSIDIAN_INDEX_DAEMON=0.",
      "Search output returns note path, title, tags, and body snippets only."
    ]
  },
  index: {
    summary: "Manage the ranked search cache",
    usage: [
      "optsidian index [status] [format=text|json]",
      "optsidian index rebuild [format=text|json]",
      "optsidian index warm [format=text|json]",
      "optsidian index clear [format=text|json]"
    ],
    options: [{ name: "format=text|json", description: "Output format (default: text)" }],
    notes: [
      "The search cache lives outside the vault; tokenizer projections live under indexes/<tier-key>/.",
      "warm explicitly discovers Obsidian's vault registry and ensures indexes ahead of first search, using incremental updates when possible.",
      "The background index daemon warms only vaults Optsidian accessed in the last 7 days and exits after 5 minutes idle; tune OPTSIDIAN_INDEX_DAEMON_IDLE_MS and OPTSIDIAN_INDEX_DAEMON_POLL_MS.",
      "The cache records schema, Node/ICU, tokenizer tier, and analyzer identity, then rebuilds when they change.",
      "During analyzer tier upgrades, a valid Intl-tier index can be served while a background reconcile rebuilds the target tier.",
      "Small stale file diffs are searched through an in-memory Intl overlay; tune with OPTSIDIAN_SEARCH_OVERLAY_MAX_FILES and OPTSIDIAN_SEARCH_OVERLAY_MAX_BYTES.",
      "OPTSIDIAN_SEARCH_EXTRA_LANGS=ko is parsed, but currently falls back to Intl because no Korean backend ships yet.",
      "status reports cache readiness plus stale-tier, reconcile-lock, and last reconcile result diagnostics when present."
    ]
  },
  config: {
    summary: "Read or update global Optsidian config",
    usage: [
      "optsidian config [list] [format=text|json]",
      "optsidian config path [format=text|json]",
      "optsidian config get <key> [format=text|json]",
      "optsidian config set <key>=<value> [format=text|json]",
      "optsidian config unset <key> [format=text|json]"
    ],
    options: [
      { name: "search.analyzer=intl|intl-daemon", description: "Use the in-process analyzer or daemon-backed analyzer" },
      { name: "search.extraLangs=ko", description: "Declare future language analyzers; currently ko falls back to Intl" },
      { name: "search.analyzerIdleMs=<ms>", description: "Daemon idle timeout" },
      { name: "search.analyzerRequestTimeoutMs=<ms>", description: "Daemon request timeout" },
      { name: "search.overlayMaxFiles=<n>", description: "Maximum changed files searched through foreground Intl overlay" },
      { name: "search.overlayMaxBytes=<n>", description: "Maximum changed bytes searched through foreground Intl overlay" },
      { name: "search.indexWarmIntervalMinutes=<minutes>", description: "Minimum interval between MCP-triggered index warm attempts" },
      { name: "search.indexWarmAccessMaxAgeDays=<days>", description: "Recently accessed vault retention window for background index warm" },
      { name: "search.indexWarmConcurrency=<n>", description: "Background index warm concurrency" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ],
    notes: [
      "Config is written to $XDG_CONFIG_HOME/optsidian/settings.json, or ~/.config/optsidian/settings.json.",
      "A project-local .optsidian/settings.json is read as an override when present, but this command does not create or edit it.",
      "Environment variables still override file settings."
    ]
  },
  grep: {
    summary: "Find exact or regex line matches in vault text",
    usage: [
      "optsidian grep query=<text> [path=<dir|file>] [context=<n>] [limit=<n>] [case] [regex] [all] [include-hidden] [format=text|json]"
    ],
    options: [
      { name: "query=<text>", description: "Text or regex query" },
      { name: "path=<dir|file>", description: "Vault-relative grep root" },
      { name: "context=<n>", description: "Context lines around each match (default: 0)" },
      { name: "limit=<n>", description: "Maximum matches to return (default: 50)" },
      { name: "case", description: "Use case-sensitive matching" },
      { name: "regex", description: "Treat query as a regular expression" },
      { name: "all", description: "Include non-Markdown files" },
      { name: "include-hidden", description: "Include hidden directories except protected internals" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ]
  },
  frontmatter: {
    summary: "Read or mutate YAML frontmatter in Markdown files",
    usage: [
      "optsidian frontmatter read path=<path> [format=text|json]",
      "optsidian frontmatter set path=<path> key=<name> (value=<text>|value-json=<json>) [dry-run] [format=text|json]",
      "optsidian frontmatter delete path=<path> key=<name> [dry-run] [format=text|json]",
      "optsidian frontmatter add path=<path> key=<name> (value=<text>|value-json=<json>) [dry-run] [format=text|json]",
      "optsidian frontmatter remove path=<path> key=<name> (value=<text>|value-json=<json>) [dry-run] [format=text|json]"
    ],
    options: [
      { name: "path=<path>", description: "Vault-relative Markdown file path" },
      { name: "key=<name>", description: "Top-level frontmatter key for mutation actions" },
      { name: "value=<text>", description: "String value, or @file" },
      { name: "value-json=<json>", description: "JSON value, or @file" },
      { name: "dry-run", description: "Return a diff without writing" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ],
    notes: [
      "frontmatter is CLI-only."
    ]
  },
  edit: {
    summary: "Exact, regex, line, or range replacement",
    usage: [
      "optsidian edit path=<path> replace=<text> with=<text|@file> [all] [dry-run]",
      "optsidian edit path=<path> regex=<pattern> with=<text|@file> [all] [dry-run]",
      "optsidian edit path=<path> line=<n> with=<text|@file> [dry-run]",
      "optsidian edit path=<path> range=a:b with=<text|@file> [dry-run]"
    ],
    options: [
      { name: "path=<path>", description: "Vault-relative file path" },
      { name: "replace=<text>", description: "Exact text selector" },
      { name: "regex=<pattern>", description: "Regular expression selector" },
      { name: "line=<n>", description: "1-based line number selector" },
      { name: "range=a:b", description: "1-based inclusive line range selector" },
      { name: "with=<text|@file>", description: "Replacement text, or @file" },
      { name: "all", description: "Replace all exact/regex matches" },
      { name: "dry-run", description: "Return a diff without writing" }
    ],
    notes: ["Use exactly one of replace=, regex=, line=, or range=."]
  },
  apply_patch: {
    summary: "Codex-compatible patch application",
    usage: ["optsidian apply_patch patch=<text|@file> [dry-run]", "optsidian apply_patch [dry-run] < patch.diff"],
    options: [
      { name: "patch=<text|@file>", description: "Patch text inline or loaded from a file" },
      { name: "dry-run", description: "Return patch diffs without writing" }
    ],
    notes: ["If patch= is omitted, optsidian reads patch text from stdin."]
  },
  write: {
    summary: "Whole-file write with overwrite guard",
    usage: ["optsidian write path=<path> content=<text|@file> [overwrite] [dry-run]"],
    options: [
      { name: "path=<path>", description: "Vault-relative file path" },
      { name: "content=<text|@file>", description: "Raw UTF-8 file content inline or from @file" },
      { name: "overwrite", description: "Allow replacing an existing file" },
      { name: "dry-run", description: "Return a diff without writing" }
    ],
    notes: ["Use content=@file for shell-sensitive payloads."]
  },
  copy: {
    summary: "Copy files or directories within the vault",
    usage: ["optsidian copy from=<path> to=<path> [recursive] [overwrite] [dry-run]"],
    options: [
      { name: "from=<path>", description: "Vault-relative source path" },
      { name: "to=<path>", description: "Vault-relative destination path" },
      { name: "recursive", description: "Required when copying directories" },
      { name: "overwrite", description: "Allow replacing an existing destination" },
      { name: "dry-run", description: "Report the copy without writing" }
    ]
  },
  mkdir: {
    summary: "Create a directory within the vault",
    usage: ["optsidian mkdir path=<path> [parents=false] [dry-run]"],
    options: [
      { name: "path=<path>", description: "Vault-relative directory path" },
      { name: "parents=false", description: "Disable parent directory creation (default: true)" },
      { name: "dry-run", description: "Report directory creation without writing" }
    ]
  },
  "open-gui": {
    summary: "Launch the Obsidian GUI (opens your last-opened vault by default) for native and plugin commands",
    usage: [
      "optsidian open-gui [no-wait] [format=text|json]",
      "optsidian open-gui vault-path=<path> [no-wait] [format=text|json]"
    ],
    options: [
      { name: "vault-path=<path>", description: "Open a SPECIFIC vault instead of the last-opened one. Normally omit this: bare `optsidian open-gui` is the default usage and opens the last-opened vault. Use vault-path only when you must target a particular vault." },
      { name: "no-wait", description: "Return immediately after requesting launch" },
      { name: "format=text|json", description: "Output format (default: text)" }
    ],
    notes: [
      "open-gui is CLI-only.",
      "Default usage is bare `optsidian open-gui` (no vault-path): Obsidian launches and opens its last-opened vault. Pass vault-path only to force a specific vault.",
      "By default, open-gui waits up to 30 seconds for native vault resolution; with no vault-path it resolves as soon as any vault is ready.",
      "With no-wait, launch is fire-and-forget and native CLI readiness is not guaranteed.",
      "Opening a vault path can change the active vault seen by later native commands.",
      "When Obsidian is installed at the standard location (/opt/Obsidian on Linux, /Applications/Obsidian.app on macOS), open-gui launches the GUI binary directly so a cold start works even without a working obsidian:// URI handler.",
      "Set OPTSIDIAN_OBSIDIAN_APP_BIN=/path/to/obsidian to override the discovered binary or point at a non-standard install."
    ]
  },
  update: {
    summary: "Update or repair the managed Optsidian install",
    usage: ["optsidian update"],
    options: [],
    notes: [
      "update is CLI-only.",
      "Managed updates require an install manifest created by scripts/install.sh.",
      "Run optsidian update at any time. It installs newer releases and repairs the current release when needed."
    ]
  },
  "plugin:install": {
    summary: "Install marketplace or custom Obsidian plugins",
    usage: [
      "optsidian plugin:install id=<plugin-id> [enable]",
      "optsidian plugin:install url=<git-url> [ref=<git-ref>] [dir=<subdir>] [vault-path=<path>] [enable] [format=text|json]",
      "optsidian plugin:install path=<plugin-dir> [vault-path=<path>] [enable] [format=text|json]"
    ],
    options: [
      { name: "id=<plugin-id>", description: "Native marketplace plugin id; passed through unchanged" },
      { name: "url=<git-url>", description: "GitHub/GitHub Enterprise repo shorthand or git URL; prefers a published release, falls back to cloning" },
      { name: "path=<plugin-dir>", description: "Local directory containing manifest.json and main.js" },
      { name: "ref=<git-ref>", description: "Release tag (preferred) or git branch/commit for url= installs" },
      { name: "dir=<subdir>", description: "Plugin subdirectory inside the git source (forces a clone)" },
      { name: "enable", description: "Add the plugin id to community-plugins.json for custom installs" },
      { name: "format=text|json", description: "Output format for custom installs (default: text)" }
    ],
    notes: [
      "id=<plugin-id> is native passthrough.",
      "url= and path= are Optsidian custom-source extensions.",
      "GitHub-compatible url= installs prefer the latest published release; without one (or with dir=) they clone the repo.",
      "Custom installs try a best-effort native refresh when the target vault is active.",
      "plugin:enable, plugin:disable, plugin:reload, and plugin:uninstall remain native commands."
    ]
  }
};

export function helpText(): string {
  const nativePassthrough = nativePassthroughCommands();
  const lines = [
    `optsidian ${OPTSIDIAN_VERSION}`,
    "",
    "Usage: optsidian <command> [options]",
    "",
    "Native-first policy:",
    "  optsidian implements the commands listed below; any other command — including",
    "  plugin commands like para-zk:* — is delegated to Obsidian as-is. Run it directly:",
    "  optsidian <command> [args...]  (no \"raw\" needed).",
    '  Use "optsidian raw <args...>" only to force Obsidian\'s version of a command that',
    "  optsidian also implements (i.e. to bypass the optsidian implementation).",
    "",
    "Detailed help:",
    "  optsidian <command> --help    Show implemented help or delegate native help",
  ];
  appendTopLevelVaultSelection(lines);
  lines.push("", "Optimized:");

  for (const command of OPTIMIZED_COMMANDS) {
    lines.push(`  ${command.padEnd(20)} ${COMMAND_HELP[command].summary}`);
  }

  lines.push("", "Extended:");
  for (const command of EXTENDED_COMMANDS) {
    lines.push(`  ${command.padEnd(20)} ${COMMAND_HELP[command].summary}`);
  }

  lines.push(
    "",
    `CLI-only: ${CLI_ONLY_COMMANDS.join(", ")}`,
    `MCP tools: ${MCP_TOOL_NAMES.join(", ")}`,
    "",
    "Native passthrough:"
  );

  if (nativePassthrough.commands.length > 0) {
    lines.push(...formatCommandList(nativePassthrough.commands));
  } else if (nativePassthrough.error) {
    lines.push(...formatHelpMessage(nativePassthrough.error));
  } else {
    lines.push("  unavailable");
  }

  lines.push("");

  return lines.join("\n");
}

export function commandHelpText(command: string): string | undefined {
  if (!isImplementedCommand(command)) return undefined;
  const entry = COMMAND_HELP[command];
  const lines = [`optsidian ${OPTSIDIAN_VERSION}`, "", `Command: ${command}`, "", "Usage:"];

  for (const usage of entry.usage) {
    lines.push(`  ${usage}`);
  }

  if (entry.options.length > 0) {
    lines.push("", "Arguments:");
    for (const option of entry.options) {
      lines.push(`  ${option.name.padEnd(18)} ${option.description}`);
    }
  }

  if (command === "open-gui") {
    appendOpenGuiVaultSelection(lines);
  } else if (command !== "update") {
    appendTopLevelVaultSelection(lines);
  }

  if (entry.notes && entry.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of entry.notes) {
      lines.push(`  ${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function usagePayload(): {
  ok: true;
  command: "command_map";
  routing: {
    cliOnly: string[];
    mcpTools: string[];
    nativeCommands: string[];
    nativeCommandsError?: string;
  };
  preference: {
    rule: string;
    reason: string;
  };
  help: {
    topLevel: string;
    command: string;
    nativeCommand: string;
  };
} {
  const nativePassthrough = nativePassthroughCommands();
  return {
    ok: true,
    command: "command_map",
    routing: {
      cliOnly: [...CLI_ONLY_COMMANDS],
      mcpTools: [...MCP_TOOL_NAMES],
      nativeCommands: [...nativePassthrough.commands],
      ...(nativePassthrough.error ? { nativeCommandsError: nativePassthrough.error } : {})
    },
    preference: {
      rule: "Prefer Optsidian for Obsidian vault work. Use Optsidian CLI commands for CLI-only and native passthrough operations.",
      reason: "Optsidian keeps routing consistent and avoids shell expansion and quoting bugs when a structured mutation tool is available."
    },
    help: {
      topLevel: "optsidian --help",
      command: "optsidian <command> --help",
      nativeCommand: "optsidian <native-command> [args]"
    }
  };
}

function appendTopLevelVaultSelection(lines: string[]): void {
  lines.push(
    "",
    "Vault selection:",
    "  vault-path=<path>   Fixed vault root for Optsidian-implemented commands",
    "  vault=<name>        Obsidian vault name resolved through native CLI",
    "  OPTSIDIAN_VAULT_PATH=<path> Fixed vault root for Optsidian-implemented commands",
    "  Native passthrough uses the active Obsidian window's vault."
  );
}

function appendOpenGuiVaultSelection(lines: string[]): void {
  lines.push(
    "",
    "Vault selection:",
    "  vault-path=<path>   Vault root to open through the Obsidian URI handler",
    "  OPTSIDIAN_VAULT_PATH=<path> Vault root to open when vault-path is omitted",
    "  Focusing an Obsidian window changes the active vault seen by native commands."
  );
}

function isImplementedCommand(command: string): command is ImplementedCommand {
  return Object.prototype.hasOwnProperty.call(COMMAND_HELP, command);
}

function nativePassthroughCommands(): { commands: string[]; error?: string } {
  try {
    const blocked = new Set<string>([...implementedCommands(), "help"]);
    return {
      commands: listObsidianCommands().filter((command) => !blocked.has(command))
    };
  } catch (error) {
    return {
      commands: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatCommandList(commands: string[]): string[] {
  const lines: string[] = [];
  let current = "  ";
  for (const command of commands) {
    const token = current.trim().length === 0 ? command : `, ${command}`;
    if (current.length + token.length > 100) {
      lines.push(current);
      current = `  ${command}`;
      continue;
    }
    current += token;
  }
  if (current.trim().length > 0) {
    lines.push(current);
  }
  return lines;
}

function formatHelpMessage(message: string): string[] {
  return message
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `  ${line}`);
}
