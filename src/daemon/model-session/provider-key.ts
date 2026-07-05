import type { ModelProviderPayload } from '../protocol.js';
import type { SearchModelDevicePolicy } from '../runtime-profile.js';

export type ResidentModelKey = string;
export type AdmissionPolicy = SearchModelDevicePolicy;

export function residentModelKey(payload: ModelProviderPayload): ResidentModelKey {
  if (payload.kind === 'local-onnx') {
    return JSON.stringify({
      kind: payload.kind,
      model: payload.model ?? null,
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

export function admissionPolicy(payload: ModelProviderPayload): AdmissionPolicy {
  if (payload.kind === 'local-onnx') return payload.devicePolicy;
  return 'cpu';
}
