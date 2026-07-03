import { buildEmbeddingSet } from '../../src/core/search/dense/embedding-set.ts';
import { DeterministicHashProvider } from '../../src/core/search/dense/provider.ts';

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
