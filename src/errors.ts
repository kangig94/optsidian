export class UsageError extends Error {
  readonly exitCode = 2;
}

export class RuntimeError extends Error {
  readonly exitCode = 1;
}

export function isCliError(error: unknown): error is UsageError | RuntimeError {
  return error instanceof UsageError || error instanceof RuntimeError;
}
