import { loadCoralNeedleBinding } from "./binding.js";
import type { CoralNeedleBinding } from "./types.js";

type ProcessRequest = {
  id: number;
  type: string;
  payload?: Record<string, unknown>;
};

let binding: CoralNeedleBinding | undefined;

function activeBinding(): CoralNeedleBinding {
  binding ??= loadCoralNeedleBinding();
  return binding;
}

process.on("message", (message) => {
  void handleMessage(message as ProcessRequest);
});

async function handleMessage(message: ProcessRequest): Promise<void> {
  try {
    const result = await dispatch(message.type, message.payload ?? {});
    process.send?.({ id: message.id, ok: true, result });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: {
        code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function dispatch(type: string, payload: Record<string, unknown>): Promise<unknown> {
  const needle = activeBinding();
  if (type === "initStore") return needle.initStore(stringPayload(payload, "dbPath"));
  if (type === "setActiveSpec") return needle.setActiveSpec(payload.spec as never);
  if (type === "upsertChunks") return needle.upsertChunks(payload.chunks as never);
  if (type === "buildIndex") return needle.buildIndex(typeof payload.engineName === "string" ? payload.engineName : "auto");
  if (type === "searchVector") {
    return needle.searchVector(payload.queryVector as never, numberPayload(payload, "candidateK"));
  }
  if (type === "getStats") return needle.getStats?.() ?? {};
  if (type === "close") {
    await needle.close();
    process.disconnect?.();
    return undefined;
  }
  throw Object.assign(new Error(`unsupported coral-needle process job: ${type}`), { code: "BAD_REQUEST" });
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw Object.assign(new Error(`expected string payload field ${key}`), { code: "BAD_REQUEST" });
  }
  return value;
}

function numberPayload(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Object.assign(new Error(`expected numeric payload field ${key}`), { code: "BAD_REQUEST" });
  }
  return value;
}
