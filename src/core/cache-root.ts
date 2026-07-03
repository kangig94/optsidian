import os from 'node:os';
import path from 'node:path';

export function optsidianCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_CACHE_HOME?.trim();
  const base = configured ? configured : path.join(os.homedir(), '.cache');
  return path.join(base, 'optsidian');
}
