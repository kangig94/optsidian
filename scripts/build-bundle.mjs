import esbuild from 'esbuild';
import fs from 'node:fs';

fs.rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
fs.mkdirSync(new URL('../dist', import.meta.url), { recursive: true });

await Promise.all([
  bundle('src/cli.ts', 'dist/optsidian'),
  bundle('src/mcp.ts', 'dist/optsidian-mcp'),
  bundle('src/daemon/vector-store/process-entry.ts', 'dist/daemon/vector-store/process-entry.js', {
    executable: false,
  }),
]);

function bundle(entryPoint, outfile, options = {}) {
  return esbuild
    .build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      packages: 'bundle',
      banner: {
        js: 'import { createRequire as __optsidianCreateRequire } from "node:module";\nconst require = __optsidianCreateRequire(import.meta.url);',
      },
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'info',
    })
    .then(() => {
      if (options.executable !== false) fs.chmodSync(outfile, 0o755);
    });
}
