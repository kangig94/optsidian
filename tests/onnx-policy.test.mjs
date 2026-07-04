import assert from 'node:assert/strict';
import test from 'node:test';

import { EmbedScheduler, envForDaemonOnnxExecutionPolicy } from '../src/daemon/embed-scheduler.ts';
import { modelProviderPayloadForEmbeddingSetForTests } from '../src/daemon/search-store/service.ts';
import { stableProviderKeyForTests } from '../src/daemon/worker-entry.ts';
import { LocalOnnxProvider } from '../src/core/search/dense/local-onnx.ts';

test('ONNX execution policy is one resolved daemon value and propagates to OpenMP env', () => {
  const embedding = {
    encode: async () => ({ provider: { id: 'local-onnx', model: 'bge-m3', dim: 1024, version: '1' }, vectors: [] }),
    cancel: () => {},
    unload: async () => ({ unloaded: true }),
    stats: () => ({ loaded: false }),
    close: async () => {},
  };
  const vectorManager = {
    close: async () => {},
    statsForTests: () => ({}),
  };
  const scheduler = new EmbedScheduler({
    env: {
      ...process.env,
      OPTSIDIAN_SEARCH_ONNX_INTRA_OP_THREADS: '2',
      OPTSIDIAN_SEARCH_ONNX_OPENMP: '1',
    },
    embedding,
    ownsEmbedding: false,
    vectorManager,
    ownsVectorManager: false,
  });

  assert.deepEqual(scheduler.onnxExecutionPolicy, { intraOpNumThreads: 2, interOpNumThreads: 1 });
  assert.equal(
    envForDaemonOnnxExecutionPolicy({ OPTSIDIAN_SEARCH_ONNX_OPENMP: '1' }, scheduler.onnxExecutionPolicy)
      .OMP_NUM_THREADS,
    '2',
  );
});

test('ONNX worker key and dense query provider payload use the same execution policy', () => {
  const policy = { intraOpNumThreads: 3, interOpNumThreads: 1 };
  const embeddingSet = {
    recipe: {
      provider: {
        id: 'local-onnx',
        model: 'bge-m3',
        dim: 1024,
        version: '1',
      },
    },
    model: 'bge-m3',
    dim: 1024,
  };
  const buildPayload = {
    kind: 'local-onnx',
    model: 'bge-m3',
    executionPolicy: policy,
  };
  const queryPayload = modelProviderPayloadForEmbeddingSetForTests(embeddingSet, policy);

  assert.deepEqual(queryPayload, buildPayload);
  assert.equal(stableProviderKeyForTests(queryPayload), stableProviderKeyForTests(buildPayload));
  assert.notEqual(
    stableProviderKeyForTests(queryPayload),
    stableProviderKeyForTests({
      ...buildPayload,
      executionPolicy: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    }),
  );
  assert.throws(
    () => modelProviderPayloadForEmbeddingSetForTests(embeddingSet, undefined),
    /requires a resolved ONNX execution policy/,
  );
});

test('LocalOnnxProvider keeps a single in-process session for repeated encodes under one policy', async () => {
  const dim = 1024;
  const createOptions = [];
  const releases = [];
  const ort = {
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: {
      async create(_modelPath, options) {
        createOptions.push(options);
        return {
          inputNames: ['input_ids', 'attention_mask'],
          outputNames: ['last_hidden_state'],
          async run() {
            const data = new Float32Array(dim);
            data[0] = 1;
            return {
              last_hidden_state: {
                data,
                dims: [1, 1, dim],
              },
            };
          },
          release() {
            releases.push('release');
          },
        };
      },
    },
  };
  const tokenizer = {
    encode() {
      return {
        ids: [1],
        attention_mask: [1],
      };
    },
  };
  const provider = new LocalOnnxProvider({
    executionProvider: 'cpu',
    executionPolicy: { intraOpNumThreads: 3, interOpNumThreads: 1 },
    ort,
    tokenizer,
  });

  await provider.embed('alpha', { inputKind: 'query' });
  await provider.embed('beta', { inputKind: 'document' });
  assert.equal(createOptions.length, 1);
  assert.deepEqual(createOptions[0], {
    executionProviders: ['cpu'],
    intraOpNumThreads: 3,
    interOpNumThreads: 1,
  });
  await provider.close();
  assert.deepEqual(releases, ['release']);
});
