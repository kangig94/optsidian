import crypto from "node:crypto";

export type EmbeddingVector = readonly number[];
export type EmbeddingInputKind = "query" | "document";

export type EmbeddingProviderIdentity = {
  id: string;
  model: string;
  dim: number;
  version: string;
};

export interface EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity;
  embed(text: string, options?: { inputKind?: EmbeddingInputKind }): EmbeddingVector | Promise<EmbeddingVector>;
}

export type DeterministicHashProviderOptions = {
  model?: string;
  dim?: number;
  fixtures?: ReadonlyMap<string, EmbeddingVector>;
};

export class DeterministicHashProvider implements EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity;
  private readonly fixtures: ReadonlyMap<string, EmbeddingVector>;

  constructor(options: DeterministicHashProviderOptions = {}) {
    const firstFixture = options.fixtures?.values().next().value;
    const dim = options.dim ?? (Array.isArray(firstFixture) ? firstFixture.length : undefined) ?? 8;
    if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error("DeterministicHashProvider dim must be a positive integer");
    this.identity = {
      id: "deterministic-hash",
      model: options.model ?? "content-hash-v1",
      dim,
      version: "1"
    };
    this.fixtures = options.fixtures ?? new Map();
  }

  embed(text: string): EmbeddingVector {
    const fixture = this.fixtures.get(text);
    if (fixture) return normalizeEmbeddingVector(fixture, this.identity.dim);
    return contentHashUnitVector(text, this.identity.dim);
  }
}

export function normalizeEmbeddingVector(vector: EmbeddingVector, expectedDim?: number): number[] {
  if (expectedDim !== undefined && vector.length !== expectedDim) {
    throw new Error(`embedding vector dimension ${vector.length} does not match expected dimension ${expectedDim}`);
  }
  if (vector.length === 0) throw new Error("embedding vector must not be empty");
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("embedding vector must contain only finite numbers");
    normSquared += value * value;
  }
  if (normSquared <= 0) throw new Error("embedding vector must not be all zero");
  const norm = Math.sqrt(normSquared);
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
  if (left.length !== right.length) throw new Error("embedding vectors must have the same dimension");
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return Math.max(-1, Math.min(1, sum));
}

export function denseAgreementFromCosine(cosine: number): number {
  if (!Number.isFinite(cosine)) return 0;
  return (Math.max(-1, Math.min(1, cosine)) + 1) / 2;
}

function contentHashUnitVector(text: string, dim: number): number[] {
  const values: number[] = [];
  let counter = 0;
  while (values.length < dim) {
    const hash = crypto.createHash("sha256")
      .update("optsidian-deterministic-hash-embedding-v1\0")
      .update(text.normalize("NFC"))
      .update("\0")
      .update(String(counter))
      .digest();
    counter += 1;
    for (const byte of hash) {
      values.push((byte / 255) * 2 - 1);
      if (values.length === dim) break;
    }
  }
  return normalizeEmbeddingVector(values, dim);
}
