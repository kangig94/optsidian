import { getValue, type ParsedArgs } from '../args.js';
import { installRelease, checkForUpdate } from '../../update/installer.js';
import { UsageError } from '../../errors.js';

type OutputWriter = {
  write(chunk: string): unknown;
};

type UpdateCommandOptions = {
  env?: NodeJS.ProcessEnv;
  output?: OutputWriter;
};

export async function runUpdate(args: ParsedArgs, options: UpdateCommandOptions = {}): Promise<void> {
  const action = args.positionals[0] ?? 'install';
  const version = getValue(args, 'version');
  const env = options.env ?? process.env;
  const output = options.output ?? process.stdout;

  switch (action) {
    case 'install':
      output.write(renderInstallResult(await installRelease({ tag: version, env })));
      return;
    case 'check':
      if (version !== undefined) {
        throw new UsageError('update check does not accept version=; use optsidian update version=<tag>');
      }
      output.write(renderCheckResult(await checkForUpdate({ env })));
      return;
    default:
      if (action.startsWith('version=')) {
        output.write(renderInstallResult(await installRelease({ tag: action.slice('version='.length), env })));
        return;
      }
      throw new UsageError('update action must be check or version=<tag>');
  }
}

function renderCheckResult(result: Awaited<ReturnType<typeof checkForUpdate>>): string {
  return [
    `current: ${result.currentVersion}`,
    `latest: ${result.targetTag}`,
    `managed-install: ${result.managedInstall}`,
    `update: ${result.repairNeeded ? 'repair' : result.needsUpdate ? 'available' : 'current'}`,
    result.installPath ? `bin: ${result.installPath}` : undefined,
    result.guidance ? `note: ${result.guidance}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .concat('\n');
}

function renderInstallResult(result: Awaited<ReturnType<typeof installRelease>>): string {
  const lines = [
    result.status === 'current'
      ? 'Optsidian is up to date.'
      : result.status === 'repaired'
        ? `Repaired Optsidian ${result.targetTag}.`
        : `Updated Optsidian to ${result.targetTag}.`,
  ];
  for (const warning of result.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}
