function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logSearchDaemonProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error && error.stack ? error.stack : errorMessage(error);
  try {
    process.stderr.write(`[optsidian search daemon] ${kind}: ${message}\n`);
  } catch {
    // Ignore stderr failures while reporting process-level errors.
  }
}

export function superviseBackground(unit: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result) {
      void result.catch((error: unknown) => {
        logSearchDaemonProcessError(`background unit "${unit}" failed`, error);
      });
    }
  } catch (error) {
    logSearchDaemonProcessError(`background unit "${unit}" failed`, error);
  }
}
