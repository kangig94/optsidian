import path from 'node:path';

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export function isValidContentHash(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_HASH_PATTERN.test(value);
}

export function assertValidContentHash(value: unknown, label = 'content hash'): asserts value is string {
  if (!isValidContentHash(value)) {
    throw new Error(`${label} must be a 64-character lowercase sha256 hex string`);
  }
}

export function safeSegmentPath(segmentsDir: string, segmentHash: string): string {
  assertValidContentHash(segmentHash, 'segmentHash');
  return path.join(segmentsDir, segmentHash);
}
