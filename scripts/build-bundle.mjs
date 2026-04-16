import esbuild from "esbuild";
import fs from "node:fs";

fs.rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
fs.mkdirSync(new URL("../dist", import.meta.url), { recursive: true });

await Promise.all([
  bundle("src/cli.ts", "dist/optsidian"),
  bundle("src/mcp.ts", "dist/optsidian-mcp")
]);

function bundle(entryPoint, outfile) {
  return esbuild
    .build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      packages: "bundle",
      banner: {
        js: 'import { createRequire as __optsidianCreateRequire } from "node:module";\nconst require = __optsidianCreateRequire(import.meta.url);'
      },
      sourcemap: false,
      legalComments: "none",
      logLevel: "info"
    })
    .then(() => {
      fs.chmodSync(outfile, 0o755);
    });
}
