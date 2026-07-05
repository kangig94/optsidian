import type { ModelProviderPayload } from '../protocol.js';

export function stableProviderKey(payload: ModelProviderPayload): string {
  if (payload.kind === 'local-onnx') {
    return JSON.stringify({
      kind: payload.kind,
      model: payload.model ?? null,
      devicePolicy: payload.devicePolicy,
      executionProvider: payload.executionProvider ?? null,
      executionPolicy: {
        intraOpNumThreads: payload.executionPolicy.intraOpNumThreads,
        interOpNumThreads: payload.executionPolicy.interOpNumThreads,
      },
    });
  }
  return JSON.stringify(payload, (_key: string, value: unknown): unknown =>
    value instanceof Map ? Array.from((value as ReadonlyMap<unknown, unknown>).entries()) : value,
  );
}
