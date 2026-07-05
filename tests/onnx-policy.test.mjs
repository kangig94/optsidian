import assert from 'node:assert/strict';
import test from 'node:test';

import { EmbedScheduler, envForDaemonOnnxExecutionPolicy } from '../src/daemon/embed-scheduler.ts';
import { modelProviderPayloadForEmbeddingSetForTests } from '../src/daemon/search-store/service.ts';
import {
  admissionPolicy,
  residentModelKey as residentModelKeyForTests,
} from '../src/daemon/model-session/provider-key.ts';
import { candidateExecutionProviders, LocalOnnxProvider } from '../src/core/search/dense/local-onnx.ts';
import { embeddingSlotPlan } from '../src/daemon/pools.ts';

test('embedding slot plan gives the GPU slot the platform accelerator (CUDA on Linux, CoreML on macOS)', () => {
  const env = {};

  const linux = embeddingSlotPlan(env, 'linux');
  assert.equal(linux.gpuSlotIndex, 0);
  assert.equal(linux.cpuFallbackSlotIndex, 1);
  assert.deepEqual(linux.slotDevices[0], { kind: 'cuda', deviceId: 0 });
  assert.deepEqual(linux.slotDevices[1], { kind: 'cpu' });

  const linuxWithDeviceId = embeddingSlotPlan({ OPTSIDIAN_SEARCH_CUDA_DEVICE_ID: '3' }, 'linux');
  assert.deepEqual(linuxWithDeviceId.slotDevices[0], { kind: 'cuda', deviceId: 3 });

  const darwin = embeddingSlotPlan(env, 'darwin');
  assert.equal(darwin.gpuSlotIndex, 0);
  assert.equal(darwin.cpuFallbackSlotIndex, 1);
  assert.deepEqual(darwin.slotDevices[0], { kind: 'coreml' });
  assert.deepEqual(darwin.slotDevices[1], { kind: 'cpu' });

  // A non-local-onnx provider has no GPU accelerator slot at all.
  const remote = embeddingSlotPlan({ OPTSIDIAN_SEARCH_EMBEDDING_PROVIDER: 'openai' }, 'darwin');
  assert.equal(remote.gpuSlotIndex, undefined);
  assert.deepEqual(remote.slotDevices, [{ kind: 'cpu' }]);
});

test('ONNX execution policy is one resolved daemon value and propagates to OpenMP env', () => {
  const embedding = {
    encode: async () => ({ provider: { id: 'local-onnx', model: 'bge-m3', dim: 1024, version: '1' }, vectors: [] }),
    encodeGpu: async () => ({ provider: { id: 'local-onnx', model: 'bge-m3', dim: 1024, version: '1' }, vectors: [] }),
    encodeCpuFallback: async () => ({
      provider: { id: 'local-onnx', model: 'bge-m3', dim: 1024, version: '1' },
      vectors: [],
    }),
    hasGpuSlot: () => true,
    cancel: () => {},
    unload: async () => ({ unloaded: true }),
    modelStats: async () => ({ loaded: false }),
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

test('ONNX worker resident key and dense query provider payload split resident identity from admission policy', () => {
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
  const keys = new Set();
  const policies = new Set();
  for (const devicePolicy of ['auto', 'cpu', 'gpu']) {
    const buildPayload = {
      kind: 'local-onnx',
      model: 'bge-m3',
      executionPolicy: policy,
      devicePolicy,
    };
    const queryPayload = modelProviderPayloadForEmbeddingSetForTests(embeddingSet, policy, devicePolicy);

    assert.deepEqual(queryPayload, buildPayload);
    assert.equal(residentModelKeyForTests(queryPayload), residentModelKeyForTests(buildPayload));
    assert.equal(admissionPolicy(queryPayload), devicePolicy);
    keys.add(residentModelKeyForTests(queryPayload));
    policies.add(admissionPolicy(queryPayload));
    assert.notEqual(
      residentModelKeyForTests(queryPayload),
      residentModelKeyForTests({
        ...buildPayload,
        executionPolicy: { intraOpNumThreads: 4, interOpNumThreads: 1 },
      }),
    );
  }
  assert.equal(keys.size, 1);
  assert.deepEqual([...policies].sort(), ['auto', 'cpu', 'gpu']);
  assert.throws(
    () => modelProviderPayloadForEmbeddingSetForTests(embeddingSet, undefined, 'auto'),
    /requires a resolved ONNX execution policy/,
  );
  assert.throws(
    () => modelProviderPayloadForEmbeddingSetForTests(embeddingSet, policy, undefined),
    /requires a resolved model device policy/,
  );
});

test('strict GPU ONNX execution provider candidates do not include CPU fallback', () => {
  assert.deepEqual(candidateExecutionProviders('cuda', 'linux', false), ['cuda']);
  assert.deepEqual(candidateExecutionProviders('coreml', 'darwin', false), ['coreml']);
  assert.deepEqual(candidateExecutionProviders('auto', 'linux', false), ['cuda']);
  assert.deepEqual(candidateExecutionProviders('auto', 'darwin', false), ['coreml']);
  assert.deepEqual(candidateExecutionProviders('cpu', 'linux', false), ['cpu']);
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
