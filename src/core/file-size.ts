import fs from 'node:fs';
import { UsageError } from '../errors.js';
import { DEFAULT_VAULT_FILE_MAX_BYTES, formatByteSize } from '../limits.js';

export function assertVaultFileWithinByteLimit(
  absPath: string,
  relPath: string,
  stat: fs.Stats = fs.statSync(absPath),
  maxBytes = DEFAULT_VAULT_FILE_MAX_BYTES,
): void {
  if (stat.size <= maxBytes) return;
  throw new UsageError(fileTooLargeMessage(relPath, stat.size, maxBytes));
}

export function vaultFileExceedsByteLimit(absPath: string, maxBytes = DEFAULT_VAULT_FILE_MAX_BYTES): boolean {
  return fs.statSync(absPath).size > maxBytes;
}

function fileTooLargeMessage(relPath: string, actualBytes: number, maxBytes: number): string {
  return `File ${relPath} is too large (${formatByteSize(actualBytes)}); maximum supported file size is ${formatByteSize(maxBytes)}`;
}
