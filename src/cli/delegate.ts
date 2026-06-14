import { runObsidianSync, shouldRefreshObsidianLaunch } from "../native/obsidian.js";
import { RuntimeError } from "../errors.js";

// The native Obsidian CLI prints "unable to find Obsidian" and exits non-zero whenever it
// cannot reach the running app. A common, non-obvious cause is a command sandbox blocking the
// connection to Obsidian's local socket even while Obsidian is running — so surface that remedy.
const OBSIDIAN_UNREACHABLE_HINT =
  "optsidian: if Obsidian is running, a command sandbox may be blocking the connection to its " +
  "local socket. Run through the optsidian MCP server (it is unsandboxed), or disable the sandbox for this command.";

export function delegateToObsidian(args: string[]): never {
  // Capture stderr (rather than inheriting it) so we can detect the unreachable message and
  // append the hint; stdin/stdout stay inherited for normal passthrough.
  const result = runObsidianSync(args, { stdio: ["inherit", "inherit", "pipe"] });
  if (result.error) {
    throw new RuntimeError(`Failed to run obsidian: ${result.error.message}`);
  }
  const stderr = result.stderr ?? "";
  if (stderr) {
    process.stderr.write(stderr);
  }
  if ((result.status ?? 0) !== 0 && shouldRefreshObsidianLaunch(stderr)) {
    process.stderr.write(`${stderr.endsWith("\n") ? "" : "\n"}${OBSIDIAN_UNREACHABLE_HINT}\n`);
  }
  process.exit(result.status ?? 1);
}
