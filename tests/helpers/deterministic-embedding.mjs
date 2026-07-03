import { DeterministicHashProvider, buildEmbeddingSet } from '../../src/core/search/dense/index.ts';

export { DeterministicHashProvider, buildEmbeddingSet };

export function createDeterministicEmbeddingSetBuilder(options = {}) {
  const provider = new DeterministicHashProvider(options);
  return {
    providerIdentity: provider.identity,
    build: (input) =>
      buildEmbeddingSet({
        provider,
        documents: input.documents,
      }),
  };
}
