import { getValue, ParsedArgs } from "../args.js";
import { installRelease, checkForUpdate } from "../../update/installer.js";
import { UsageError } from "../../errors.js";

export async function runUpdate(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? "install";
  const version = getValue(args, "version");

  switch (action) {
    case "install":
      process.stdout.write(renderInstallResult(await installRelease({ tag: version })));
      return;
    case "check":
      if (version !== undefined) {
        throw new UsageError("update check does not accept version=; use optsidian update version=<tag>");
      }
      process.stdout.write(renderCheckResult(await checkForUpdate()));
      return;
    default:
      if (action.startsWith("version=")) {
        process.stdout.write(renderInstallResult(await installRelease({ tag: action.slice("version=".length) })));
        return;
      }
      throw new UsageError("update action must be check or version=<tag>");
  }
}

function renderCheckResult(result: Awaited<ReturnType<typeof checkForUpdate>>): string {
  return [
    `current: ${result.currentVersion}`,
    `latest: ${result.targetTag}`,
    `managed-install: ${result.managedInstall}`,
    `update: ${result.repairNeeded ? "repair" : result.needsUpdate ? "available" : "current"}`,
    result.installPath ? `bin: ${result.installPath}` : undefined,
    result.guidance ? `note: ${result.guidance}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .concat("\n");
}

function renderInstallResult(result: Awaited<ReturnType<typeof installRelease>>): string {
  const lines = [
    result.status === "current"
      ? "Optsidian is up to date."
      : result.status === "repaired"
        ? `Repaired Optsidian ${result.targetTag}.`
        : `Updated Optsidian to ${result.targetTag}.`
  ];
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}
