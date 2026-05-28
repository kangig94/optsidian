#!/usr/bin/env node
import { hasFlag, parseArgs } from "./cli/args.js";
import { delegateToObsidian } from "./cli/delegate.js";
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
import { runUpdate } from "./cli/commands/update.js";
import { runWrite } from "./cli/commands/write.js";
import { OPTSIDIAN_VERSION } from "./version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (argv[0] === "--version") {
    process.stdout.write(`${OPTSIDIAN_VERSION}\n`);
    return;
  }

  if (argv[0] === "raw") {
    delegateToObsidian(argv.slice(1));
  }

  const args = parseArgs(argv);
  const command = args.command;
  if (command && hasFlag(args, "help")) {
    if (commandPolicy(command) === "delegate") {
      rejectVaultPathForNative(args);
      delegateToObsidian(argv);
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
    delegateToObsidian(argv);
  }

  if (command === "update") {
    await runUpdate(args);
    return;
  }
  if (command === "open-gui") {
    await runOpenGui(args);
    return;
  }

  const vaultRoot = resolveVaultRoot(args);
  switch (command) {
    case "read":
      runRead(args, vaultRoot);
      return;
    case "grep":
      runGrep(args, vaultRoot);
      return;
    case "frontmatter":
      runFrontmatter(args, vaultRoot);
      return;
    case "search":
      await runSearch(args, vaultRoot);
      return;
    case "index":
      await runIndex(args, vaultRoot);
      return;
    case "edit":
      runEdit(args, vaultRoot);
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
      delegateToObsidian(argv);
  }
}

function rejectVaultPathForNative(args: ReturnType<typeof parseArgs>): void {
  if (hasVaultPathArg(args)) {
    throw new UsageError("vault-path=<path> only applies to Optsidian-implemented commands. Native Obsidian commands require the Obsidian GUI/native CLI context.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(isCliError(error) ? error.exitCode : 1);
});
