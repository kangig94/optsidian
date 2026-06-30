#!/usr/bin/env node
import { isMainThread, workerData } from "node:worker_threads";
import { parseArgs } from "./cli/args.js";
import { runDelegatedObsidian } from "./cli/delegate.js";
import { UsageError, isCliError } from "./errors.js";
import { commandHelpText, helpText } from "./cli/help.js";
import { commandPolicy } from "./cli/policy.js";
import { hasVaultPathArg, resolveVaultRoot } from "./cli/vault.js";
import { runApplyPatch } from "./cli/commands/apply-patch.js";
import { runCopy } from "./cli/commands/copy.js";
import { runEdit } from "./cli/commands/edit.js";
import { runFrontmatter } from "./cli/commands/frontmatter.js";
import { runGrep } from "./cli/commands/grep.js";
import { runIndex } from "./cli/commands/index.js";
import { runMkdir } from "./cli/commands/mkdir.js";
import { runOpenGui } from "./cli/commands/open-gui.js";
import { runRead } from "./cli/commands/read.js";
import { runSearch } from "./cli/commands/search.js";
import { runSimilarity } from "./cli/commands/similarity.js";
import { runConfig } from "./cli/commands/config.js";
import { runUpdate } from "./cli/commands/update.js";
import { runWrite } from "./cli/commands/write.js";
import { runPluginInstall } from "./cli/commands/plugin.js";
import { runSearchDaemon } from "./daemon/server.js";
import { runSearchDaemonWorker } from "./daemon/worker-entry.js";
import { maybeCheckForUpdateNotice } from "./update/installer.js";
import { OPTSIDIAN_VERSION } from "./version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  await runMain(argv);
  await writeUpdateNoticeIfNeeded(argv);
}

async function runMain(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || (argv.length === 1 && argv[0] === "help=true")) {
    process.stdout.write(helpText());
    return;
  }
  if (argv[0] === "help") {
    throw new UsageError("Use --help or help=true for help");
  }
  if (argv[0] === "--version") {
    process.stdout.write(`${OPTSIDIAN_VERSION}\n`);
    return;
  }
  if (argv[0] === "__search-daemon") {
    await runSearchDaemon({ argv: argv.slice(1) });
    return;
  }

  if (argv[0] === "raw") {
    await delegateToObsidianAndExit(argv.slice(1), argv);
  }

  const args = parseArgs(argv);
  const command = args.command;
  if (command && isCommandHelpRequest(args)) {
    if (commandPolicy(command) === "delegate") {
      rejectVaultPathForNative(args);
      await delegateToObsidianAndExit(["help", command], argv);
    }
    const text = commandHelpText(command);
    if (!text) {
      throw new Error(`Missing help text for implemented command: ${command}`);
    }
    process.stdout.write(text);
    return;
  }
  if (commandPolicy(command) === "delegate") {
    rejectVaultPathForNative(args);
    await delegateToObsidianAndExit(argv, argv);
  }

  if (command === "update") {
    await runUpdate(args);
    return;
  }
  if (command === "open-gui") {
    await runOpenGui(args);
    return;
  }
  if (command === "plugin:install") {
    await runPluginInstall(args);
    return;
  }
  if (command === "config") {
    runConfig(args);
    return;
  }
  if (command === "index" && args.positionals[0] === "warm") {
    await runIndex(args);
    return;
  }

  const vaultRoot = resolveVaultRoot(args);
  switch (command) {
    case "read":
      runRead(args, vaultRoot);
      return;
    case "grep":
      await runGrep(args, vaultRoot);
      return;
    case "frontmatter":
      runFrontmatter(args, vaultRoot);
      return;
    case "search":
      await runSearch(args, vaultRoot);
      return;
    case "similarity":
      await runSimilarity(args, vaultRoot);
      return;
    case "index":
      await runIndex(args, vaultRoot);
      return;
    case "edit":
      await runEdit(args, vaultRoot);
      return;
    case "write":
      runWrite(args, vaultRoot);
      return;
    case "copy":
      runCopy(args, vaultRoot);
      return;
    case "mkdir":
      runMkdir(args, vaultRoot);
      return;
    case "apply_patch":
      runApplyPatch(args, vaultRoot);
      return;
    default:
      await delegateToObsidianAndExit(argv, argv);
  }
}

async function delegateToObsidianAndExit(args: string[], originalArgv: string[]): Promise<never> {
  const status = runDelegatedObsidian(args);
  if (status === 0) {
    await writeUpdateNoticeIfNeeded(originalArgv);
  }
  process.exit(status);
}

async function writeUpdateNoticeIfNeeded(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!shouldCheckForUpdateNotice(argv)) return;
  const notice = await maybeCheckForUpdateNotice({
    env,
    diagnostic: (message) => process.stderr.write(`warning: ${message}\n`)
  });
  if (notice) {
    process.stderr.write(`${notice.message}\n`);
  }
}

function shouldCheckForUpdateNotice(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const command = argv[0];
  if (command === "--help" || command === "--version" || command === "help" || command === "__search-daemon" || command === "update") {
    return false;
  }
  return !argv.includes("--help") && !argv.includes("help=true");
}

function isCommandHelpRequest(args: ReturnType<typeof parseArgs>): boolean {
  return args.raw.includes("--help") || args.values.get("help") === "true";
}

function rejectVaultPathForNative(args: ReturnType<typeof parseArgs>): void {
  if (hasVaultPathArg(args)) {
    throw new UsageError("vault-path=<path> only applies to Optsidian-implemented commands. Native Obsidian commands require the Obsidian GUI/native CLI context.");
  }
}

if (!isMainThread && (workerData as { optsidianSearchWorker?: boolean } | null)?.optsidianSearchWorker === true) {
  runSearchDaemonWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Search daemon worker error: ${message}\n`);
    process.exit(1);
  });
} else {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(isCliError(error) ? error.exitCode : 1);
  });
}
