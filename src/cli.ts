#!/usr/bin/env node
import { parseArgs } from "./cli/args.js";
import { delegateToObsidian } from "./cli/delegate.js";
import { isCliError } from "./errors.js";
import { helpText } from "./cli/help.js";
import { commandPolicy } from "./cli/policy.js";
import { resolveVaultRoot } from "./cli/vault.js";
import { runApplyPatch } from "./cli/commands/apply-patch.js";
import { runCopy } from "./cli/commands/copy.js";
import { runEdit } from "./cli/commands/edit.js";
import { runMkdir } from "./cli/commands/mkdir.js";
import { runRead } from "./cli/commands/read.js";
import { runSearch } from "./cli/commands/search.js";
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
  if (commandPolicy(command) === "delegate") {
    delegateToObsidian(argv);
  }

  const vaultRoot = resolveVaultRoot(args);
  switch (command) {
    case "read":
      runRead(args, vaultRoot);
      return;
    case "search":
      runSearch(args, vaultRoot, 0);
      return;
    case "search:context":
      runSearch(args, vaultRoot, 2);
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(isCliError(error) ? error.exitCode : 1);
});
