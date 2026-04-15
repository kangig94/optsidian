import { UsageError } from "../errors.js";
import type { LineRange } from "./types.js";

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`${name} must be a positive integer`);
  }
}

export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageError(`${name} must be a non-negative integer`);
  }
}

export function assertLineRange(value: LineRange, name: string): void {
  assertPositiveInteger(value.start, `${name}.start`);
  assertPositiveInteger(value.end, `${name}.end`);
  if (value.end < value.start) {
    throw new UsageError(`${name}.end must be >= ${name}.start`);
  }
}

export function assertOptionalPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined) assertPositiveInteger(value, name);
}

export function assertOptionalNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined) assertNonNegativeInteger(value, name);
}
