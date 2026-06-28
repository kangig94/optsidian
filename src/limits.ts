export const DEFAULT_VAULT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_HTTP_RESPONSE_MAX_BYTES = 50 * 1024 * 1024;

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.ceil(bytes / (1024 * 1024))}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.ceil(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}
