import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeError } from '../errors.js';
import { runObsidianSync } from './launcher.js';

export {
  clearObsidianLaunchEnvCache,
  mergeObsidianLaunchEnv,
  obsidianBin,
  recoverLinuxGuiEnv,
  runObsidianSync,
  shouldRefreshObsidianLaunch,
} from './launcher.js';

export type ObsidianCapture = {
  stdout: string;
  stderr: string;
  status: number;
};

export type ObsidianVaultDiscoveryEntry = {
  path: string;
  source: 'active' | 'config';
  id?: string;
};

export type ObsidianVaultDiscoveryResult = {
  vaults: ObsidianVaultDiscoveryEntry[];
  warnings: string[];
};

const OBSIDIAN_CONFIG_PATH_ENV = 'OBSIDIAN_CONFIG';
const OPTSIDIAN_OBSIDIAN_CONFIG_PATH_ENV = 'OPTSIDIAN_OBSIDIAN_CONFIG_PATH';

export function captureObsidian(args: string[], env: NodeJS.ProcessEnv = process.env): ObsidianCapture {
  const result = runObsidianSync(args, { env });
  if (result.error) {
    throw new RuntimeError(`Failed to run obsidian: ${result.error.message}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

export function listObsidianCommands(env: NodeJS.ProcessEnv = process.env): string[] {
  const result = captureObsidian(['help'], env);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new RuntimeError(details || 'Failed to list Obsidian commands');
  }

  const commands: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^ {2}([a-z0-9][a-z0-9:_-]*)\s{2,}\S/.exec(line);
    if (!match) continue;
    commands.push(match[1]);
  }
  return commands;
}

export function resolveObsidianVaultRoot(options: { vault?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const argv = ['vault', 'info=path'];
  if (options.vault) argv.push(`vault=${options.vault}`);

  const result = captureObsidian(argv, options.env);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new RuntimeError(details || 'Failed to resolve Obsidian vault path');
  }

  const root = result.stdout.trim();
  if (!root) {
    throw new RuntimeError('Obsidian returned an empty vault path');
  }
  return resolveVaultPathInput(root);
}

export function resolveObsidianVaultRootWithFallback(
  options: { vault?: string; fallbackPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  try {
    return resolveObsidianVaultRoot({ vault: options.vault, env: options.env });
  } catch (error) {
    if (!options.fallbackPath) throw error;
    return resolveVaultPathInput(options.fallbackPath);
  }
}

export function discoverObsidianVaultRoots(options: { env?: NodeJS.ProcessEnv } = {}): ObsidianVaultDiscoveryResult {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const vaults: ObsidianVaultDiscoveryEntry[] = [];
  const obsidianConfigPath = env[OBSIDIAN_CONFIG_PATH_ENV]?.trim();
  const optsidianConfigPath = env[OPTSIDIAN_OBSIDIAN_CONFIG_PATH_ENV]?.trim();
  const explicitRegistry = Boolean(obsidianConfigPath ? obsidianConfigPath : optsidianConfigPath);

  for (const configPath of obsidianConfigPaths(env)) {
    vaults.push(...readObsidianConfigVaults(configPath, warnings));
  }

  if (!explicitRegistry) {
    try {
      vaults.push({ path: resolveObsidianVaultRoot({ env }), source: 'active' });
    } catch {
      // Active vault discovery depends on the Obsidian GUI/native CLI context.
      // Config-file discovery above is enough for non-interactive warm runs.
    }
  }

  return { vaults: dedupeDiscoveredVaults(vaults), warnings };
}

export function resolveVaultPathInput(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new RuntimeError(`Vault path does not exist: ${input}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new RuntimeError(`Vault path is not a directory: ${input}`);
  }
  return fs.realpathSync(resolved);
}

function obsidianConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const obsidianConfigPath = env[OBSIDIAN_CONFIG_PATH_ENV]?.trim();
  const optsidianConfigPath = env[OPTSIDIAN_OBSIDIAN_CONFIG_PATH_ENV]?.trim();
  const override = obsidianConfigPath ? obsidianConfigPath : optsidianConfigPath;
  if (override) return [path.resolve(override)];

  const home = os.homedir();
  const configured = env.XDG_CONFIG_HOME?.trim();
  const configHome = configured ? configured : path.join(os.homedir(), '.config');
  const candidates = [
    path.join(configHome, 'obsidian', 'obsidian.json'),
    path.join(home, '.config', 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
    path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
    env.APPDATA?.trim() ? path.join(env.APPDATA.trim(), 'obsidian', 'obsidian.json') : undefined,
  ];
  const first = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  return first ? [first] : [];
}

function readObsidianConfigVaults(configPath: string, warnings: string[]): ObsidianVaultDiscoveryEntry[] {
  if (!fs.existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    const vaults = isRecord(parsed) && isRecord(parsed.vaults) ? parsed.vaults : undefined;
    if (!vaults) return [];

    const discovered: ObsidianVaultDiscoveryEntry[] = [];
    for (const [id, entry] of Object.entries(vaults)) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.trim() === '') continue;
      try {
        discovered.push({ path: resolveVaultPathInput(entry.path), source: 'config', id });
      } catch (error) {
        warnings.push(`Skipping Obsidian vault ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return discovered;
  } catch (error) {
    warnings.push(
      `Cannot read Obsidian vault registry ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function dedupeDiscoveredVaults(vaults: readonly ObsidianVaultDiscoveryEntry[]): ObsidianVaultDiscoveryEntry[] {
  const seen = new Set<string>();
  const unique: ObsidianVaultDiscoveryEntry[] = [];
  for (const vault of vaults) {
    let key: string;
    try {
      key = fs.realpathSync(vault.path);
    } catch {
      key = path.resolve(vault.path);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...vault, path: key });
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
