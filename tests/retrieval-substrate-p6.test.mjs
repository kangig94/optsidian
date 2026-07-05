import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureLocalOnnxModelArtifact,
  inspectLocalOnnxModelArtifact,
  localOnnxManifestPath,
  localOnnxModelDir,
  localOnnxModelArtifactHash,
  localOnnxModelDescriptor,
} from '../src/core/search/dense/artifacts.ts';
import {
  LocalOnnxProvider,
  createOnnxSessionWithFallback,
  resolveLocalOnnxProviderSelection,
} from '../src/core/search/dense/local-onnx.ts';
import { ExclusiveClaim } from '../src/core/lifecycle/exclusive-claim.ts';
import { createProcessToken } from '../src/core/lifecycle/process-token.ts';
import { tokenizeRoutedText } from '../src/core/search/analyzer.ts';

const LOCAL_ONNX_REQUIRED_VRAM_BASELINE_FIXTURES = {
  'bge-m3': {
    requiredVramBytes: 4_294_967_296,
    artifactHash: 'cfcbb6240aa55fe29e0453106b12b928acf7687f82313ee98af59c6ff45fd295',
    recipe: {
      schemaVersion: 1,
      provider: {
        id: 'local-onnx',
        model: 'bge-m3',
        dim: 1024,
        version: '1',
      },
      recipeVersion: 'local-onnx-embedding-recipe-v1',
      projectionVersion: 'rendered-text-projection-v1',
      normalization: 'l2',
      modelArtifact: {
        modelId: 'BAAI/bge-m3',
        revision: '5617a9f61b028005a4858fdac845db406aefb181',
        sha256: 'cfcbb6240aa55fe29e0453106b12b928acf7687f82313ee98af59c6ff45fd295',
        files: [
          {
            path: 'onnx/model.onnx',
            sha256: 'f84251230831afb359ab26d9fd37d5936d4d9bb5d1d5410e66442f630f24435b',
            sizeBytes: 724_923,
          },
          {
            path: 'onnx/model.onnx_data',
            sha256: '1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4',
            sizeBytes: 2_266_820_608,
          },
          {
            path: 'onnx/config.json',
            sha256: 'f24afd5de914fba8c668426c43d208a1a54022500c63b2c160be20891686fce8',
            sizeBytes: 698,
          },
        ],
      },
      tokenizer: {
        sha256: '99f71a83a448cfaf4d8284927ce0194eabeea816d1a217e495a463a0e064d369',
        runtime: {
          name: '@huggingface/tokenizers',
          version: '0.1.3',
        },
        files: [
          {
            path: 'onnx/tokenizer.json',
            sha256: '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790',
            sizeBytes: 17_082_821,
          },
          {
            path: 'onnx/tokenizer_config.json',
            sha256: '7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4',
            sizeBytes: 1_173,
          },
          {
            path: 'onnx/special_tokens_map.json',
            sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835',
            sizeBytes: 964,
          },
        ],
      },
      onnx: {
        graphSha256: 'f84251230831afb359ab26d9fd37d5936d4d9bb5d1d5410e66442f630f24435b',
        opset: 11,
        runtime: {
          name: 'onnxruntime-node',
          version: '1.27.0',
        },
      },
      quantization: 'none',
      dtype: 'float32',
      dim: 1024,
      pooling: 'mean',
      maxTokens: 8192,
      chunking: {
        strategy: 'truncate',
        maxTokens: 8192,
        overlapTokens: 0,
      },
      inputTemplate: {
        default: '{text}',
        query: '{text}',
        document: '{text}',
      },
      renderedTextProjectionVersion: 'rendered-text-projection-v1',
    },
  },
  'multilingual-e5-small': {
    requiredVramBytes: 1_073_741_824,
    artifactHash: '92e59b5a5ff29836c9e37982781d7a49f48ef0c1a9fa2e7372b4eac7ffc8b1a4',
    recipe: {
      schemaVersion: 1,
      provider: {
        id: 'local-onnx',
        model: 'multilingual-e5-small',
        dim: 384,
        version: '1',
      },
      recipeVersion: 'local-onnx-embedding-recipe-v1',
      projectionVersion: 'rendered-text-projection-v1',
      normalization: 'l2',
      modelArtifact: {
        modelId: 'intfloat/multilingual-e5-small',
        revision: '614241f622f53c4eeff9890bdc4f31cfecc418b3',
        sha256: '92e59b5a5ff29836c9e37982781d7a49f48ef0c1a9fa2e7372b4eac7ffc8b1a4',
        files: [
          {
            path: 'onnx/model.onnx',
            sha256: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
            sizeBytes: 470_268_510,
          },
          {
            path: 'onnx/config.json',
            sha256: 'bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6',
            sizeBytes: 653,
          },
        ],
      },
      tokenizer: {
        sha256: 'a057440fddbca4c76c43d053abff6bd490a9cf8364ebd3f453973aeb9d846478',
        runtime: {
          name: '@huggingface/tokenizers',
          version: '0.1.3',
        },
        files: [
          {
            path: 'onnx/tokenizer.json',
            sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
            sizeBytes: 17_082_730,
          },
          {
            path: 'onnx/tokenizer_config.json',
            sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
            sizeBytes: 443,
          },
          {
            path: 'onnx/special_tokens_map.json',
            sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
            sizeBytes: 167,
          },
        ],
      },
      onnx: {
        graphSha256: 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665',
        opset: 11,
        runtime: {
          name: 'onnxruntime-node',
          version: '1.27.0',
        },
      },
      quantization: 'none',
      dtype: 'float32',
      dim: 384,
      pooling: 'mean',
      maxTokens: 512,
      chunking: {
        strategy: 'truncate',
        maxTokens: 512,
        overlapTokens: 0,
      },
      inputTemplate: {
        default: 'passage: {text}',
        query: 'query: {text}',
        document: 'passage: {text}',
      },
      renderedTextProjectionVersion: 'rendered-text-projection-v1',
    },
  },
};

test('AC13 P6 provider selection defaults to BGE-M3 and selects multilingual-e5-small', () => {
  const defaultSelection = resolveLocalOnnxProviderSelection();
  assert.deepEqual(defaultSelection, { kind: 'local-onnx', model: 'bge-m3' });

  const e5Selection = resolveLocalOnnxProviderSelection({ search: { embeddingModel: 'multilingual-e5-small' } });
  assert.deepEqual(e5Selection, { kind: 'local-onnx', model: 'multilingual-e5-small' });

  const bge = new LocalOnnxProvider({ ...mockRuntimeOptions(1024), model: undefined });
  assert.equal(bge.identity.id, 'local-onnx');
  assert.equal(bge.identity.model, 'bge-m3');
  assert.equal(bge.identity.dim, 1024);
  assert.equal(bge.recipeIdentity.modelArtifact.modelId, 'BAAI/bge-m3');
  assert.equal(bge.recipeIdentity.tokenizer.runtime.name, '@huggingface/tokenizers');
  assert.equal(bge.recipeIdentity.onnx.runtime.name, 'onnxruntime-node');
  assert.equal(bge.recipeIdentity.quantization, 'none');
  assert.equal(bge.recipeIdentity.dtype, 'float32');
  assert.equal(bge.recipeIdentity.pooling, 'mean');
  assert.equal(bge.recipeIdentity.normalization, 'l2');
  assert.equal(bge.recipeIdentity.maxTokens, 8192);
  assert.equal(bge.recipeIdentity.renderedTextProjectionVersion, 'rendered-text-projection-v1');

  const e5 = new LocalOnnxProvider({ ...mockRuntimeOptions(384), model: 'e5-small' });
  assert.equal(e5.identity.model, 'multilingual-e5-small');
  assert.equal(e5.identity.dim, 384);
  assert.equal(e5.recipeIdentity.modelArtifact.modelId, 'intfloat/multilingual-e5-small');
  assert.equal(e5.recipeIdentity.inputTemplate.query, 'query: {text}');
  assert.equal(e5.recipeIdentity.inputTemplate.document, 'passage: {text}');
});

test('AC12 required VRAM metadata is excluded from local ONNX identity inputs', () => {
  for (const [model, fixture] of Object.entries(LOCAL_ONNX_REQUIRED_VRAM_BASELINE_FIXTURES)) {
    const descriptor = localOnnxModelDescriptor(model);
    const provider = new LocalOnnxProvider({ model });

    assert.equal(descriptor.requiredVramBytes, fixture.requiredVramBytes);
    assert.equal(localOnnxModelArtifactHash(descriptor), fixture.artifactHash);
    assert.equal(JSON.stringify(provider.recipeIdentity), JSON.stringify(fixture.recipe));
    assert.deepEqual(provider.recipeIdentity, fixture.recipe);
    assert.equal('requiredVramBytes' in provider.recipeIdentity, false);
    assert.equal('requiredVramBytes' in provider.recipeIdentity.modelArtifact, false);
  }
});

test('AC13 P6 ONNX execution provider falls back from unavailable accelerator to CPU', async () => {
  const calls = [];
  const { ort } = mockOrt({
    dim: 1024,
    failProviders: new Set(['cuda']),
    onCreate: (provider) => calls.push(provider),
  });
  const selection = await createOnnxSessionWithFallback({
    ort,
    modelPath: '/tmp/not-downloaded/model.onnx',
    executionProvider: 'auto',
    platform: 'linux',
  });
  assert.deepEqual(calls, ['cuda', 'cpu']);
  assert.equal(selection.executionProvider, 'cpu');
  assert.equal(selection.failures.length, 1);
  assert.match(selection.failures[0].message, /unavailable/);
});

test('P8 strict GPU ONNX execution provider failure does not fall back to CPU', async () => {
  const calls = [];
  const { ort } = mockOrt({
    dim: 1024,
    failProviders: new Set(['cuda']),
    onCreate: (provider) => calls.push(provider),
  });
  await assert.rejects(
    () =>
      createOnnxSessionWithFallback({
        ort,
        modelPath: '/tmp/not-downloaded/model.onnx',
        executionProvider: 'cuda',
        allowCpuFallback: false,
        platform: 'linux',
      }),
    (error) => error?.code === 'MODEL_DEVICE_UNAVAILABLE',
  );
  assert.deepEqual(calls, ['cuda']);
});

test('AC12 P6 dense path uses model-native tokenizer while lexical Hangul still routes through Kiwi', async () => {
  const hangul = '한국어 형태소 테스트';
  const kiwiCalls = [];
  const lexical = tokenizeRoutedText(hangul, ['ko'], {
    tokens(text) {
      kiwiCalls.push(text);
      return ['kiwimorph'];
    },
  });
  assert.deepEqual(kiwiCalls, ['한국어', '형태소', '테스트']);
  assert.deepEqual(lexical, ['kiwimorph']);

  const denseInputs = [];
  const tokenizer = {
    encode(text) {
      denseInputs.push(text);
      return {
        ids: [101, 102, 103],
        tokens: ['<s>', '한국어', '</s>'],
        attention_mask: [1, 1, 1],
      };
    },
  };
  const { ort } = mockOrt({ dim: 384 });
  const provider = new LocalOnnxProvider({
    model: 'multilingual-e5-small',
    ort,
    tokenizer,
    platform: 'linux',
  });

  const vector = await provider.embed(hangul, { inputKind: 'query' });
  assert.equal(vector.length, 384);
  assert.deepEqual(denseInputs, [`query: ${hangul}`]);
  assert.equal(
    denseInputs.some((input) => input.includes('kiwimorph')),
    false,
  );
});

test('local ONNX rejected session load self-invalidates and retries', async () => {
  let attempts = 0;
  const { ort } = mockOrt({
    dim: 384,
    onCreate() {
      attempts += 1;
      if (attempts === 1) throw new Error('session create failed once');
    },
  });
  const provider = new LocalOnnxProvider({
    model: 'multilingual-e5-small',
    ort,
    tokenizer: {
      encode() {
        return { ids: [1], attention_mask: [1] };
      },
    },
    ensureArtifact: async () => {},
    executionProvider: 'cpu',
    platform: 'linux',
  });

  await assert.rejects(() => provider.embed('first'), /session create failed once/);
  const vector = await provider.embed('second');
  assert.equal(vector.length, 384);
  assert.equal(attempts, 2);
  await provider.close();
});

test('local ONNX GPU runtime device failure closes the resident session', async () => {
  let releaseCalls = 0;
  const { ort } = mockOrt({
    dim: 384,
    runError: new Error('CUDA out of memory during session.run'),
    onRelease: () => {
      releaseCalls += 1;
    },
  });
  const provider = new LocalOnnxProvider({
    model: 'multilingual-e5-small',
    ort,
    tokenizer: {
      encode() {
        return { ids: [1], attention_mask: [1] };
      },
    },
    ensureArtifact: async () => {},
    executionProvider: 'cuda',
    allowCpuFallback: false,
    platform: 'linux',
  });

  await provider.load();
  assert.equal(provider.executionProvider, 'cuda');
  await assert.rejects(() => provider.embed('first'), /CUDA out of memory/);
  assert.equal(releaseCalls, 1);
  assert.equal(provider.executionProvider, undefined);
});

test('local ONNX close serializes concurrent callers during session creation', async () => {
  const createStarted = deferred();
  const createGate = deferred();
  const releaseGate = deferred();
  let releaseCalls = 0;
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const provider = new LocalOnnxProvider({
    model: 'multilingual-e5-small',
    ort: {
      Tensor,
      InferenceSession: {
        async create() {
          createStarted.resolve();
          await createGate.promise;
          return {
            inputNames: ['input_ids', 'attention_mask'],
            async run() {
              return {};
            },
            async release() {
              releaseCalls += 1;
              await releaseGate.promise;
            },
          };
        },
      },
    },
    tokenizer: {
      encode() {
        return { ids: [1], attention_mask: [1] };
      },
    },
    ensureArtifact: async () => {},
    executionProvider: 'cpu',
    platform: 'linux',
  });

  const load = provider.load().then(
    () => undefined,
    (error) => error,
  );
  await createStarted.promise;
  let closeDone = false;
  const closeA = provider.close().then(() => {
    closeDone = true;
  });
  const closeB = provider.close();
  createGate.resolve();
  await delay(20);
  assert.equal(closeDone, false, 'close callers must wait for late-produced session release');
  assert.equal(releaseCalls, 1);
  releaseGate.resolve();
  await Promise.all([closeA, closeB]);
  assert.match(String((await load)?.message), /cancelled/);
  assert.equal(releaseCalls, 1);
});

test('AC13 P6 README documents Linux GPU requirements and graceful CPU fallback', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /Dense Search GPU Runtime/);
  assert.match(readme, /CUDA 12\.x/);
  assert.match(readme, /cuDNN 9/);
  assert.match(readme, /cudnn9-cuda-12/);
  assert.match(readme, /CPU-only/);
  assert.match(readme, /CoreML\/Metal/);
  assert.match(readme, /cu12 build/);
  assert.match(readme, /onnxruntime-node/);
});

test('AC13 P6 local ONNX artifact inspection detects missing manifest mismatch and digest mismatch', () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor();
  const missing = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor });
  assert.equal(missing.installed, false);
  assert.equal(missing.manifest, null);
  assert.deepEqual(
    missing.missingFiles,
    descriptor.files.map((file) => file.path),
  );

  const modelDir = localOnnxModelDir(descriptor.key, env);
  fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
  for (const file of descriptor.files) {
    fs.writeFileSync(path.join(modelDir, file.path), Buffer.alloc(file.sizeBytes, 1));
  }
  fs.writeFileSync(
    localOnnxManifestPath(descriptor.key, env),
    JSON.stringify({
      packageId: 'dense-onnx',
      modelKey: descriptor.key,
      modelId: 'wrong',
      revision: descriptor.revision,
      sourceBaseUrl: 'wrong',
      files: [],
      modelArtifactSha256: 'wrong',
      tokenizerArtifactSha256: 'wrong',
      installedAt: new Date().toISOString(),
    }),
  );
  const mismatch = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor, verifyFiles: 'metadata' });
  assert.equal(mismatch.installed, false);
  assert.equal(mismatch.manifest, null);
  assert.deepEqual(mismatch.missingFiles, []);

  const digest = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor, verifyFiles: 'digest' });
  assert.equal(digest.installed, false);
  assert.ok(digest.missingFiles.every((entry) => entry.includes('digest mismatch')));
});

test('AC13 P6 local ONNX artifact install verifies digests replaces staging and cleans failed staging', async () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor({
    'onnx/model.onnx': Buffer.from('model-v1'),
    'onnx/tokenizer.json': Buffer.from('tokenizer-v1'),
  });
  const downloads = new Map(descriptor.files.map((file) => [file.path, file.content]));
  const result = await ensureLocalOnnxModelArtifact(descriptor.key, env, {
    descriptor,
    forceInstall: true,
    downloadFile: async (url, target) => {
      const rel = [...downloads.keys()].find((candidate) => url.endsWith(candidate));
      if (!rel) throw new Error(`unexpected download URL ${url}`);
      fs.writeFileSync(target, downloads.get(rel));
    },
  });
  assert.equal(result.status, 'installed');
  const modelDir = localOnnxModelDir(descriptor.key, env);
  assert.equal(fs.readFileSync(path.join(modelDir, 'onnx/model.onnx'), 'utf8'), 'model-v1');
  assert.equal(inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor }).installed, true);
  assert.equal(stagingClaimCount(path.join(root, 'cache', 'optsidian', 'dense-onnx', 'staging')), 0);

  const replacement = tinyDescriptor({
    'onnx/model.onnx': Buffer.from('model-v2'),
    'onnx/tokenizer.json': Buffer.from('tokenizer-v2'),
  });
  const replacementDownloads = new Map(replacement.files.map((file) => [file.path, file.content]));
  const replaced = await ensureLocalOnnxModelArtifact(replacement.key, env, {
    descriptor: replacement,
    forceInstall: true,
    downloadFile: async (url, target) => {
      const rel = [...replacementDownloads.keys()].find((candidate) => url.endsWith(candidate));
      fs.writeFileSync(target, replacementDownloads.get(rel));
    },
  });
  assert.equal(replaced.status, 'installed');
  assert.equal(fs.readFileSync(path.join(modelDir, 'onnx/model.onnx'), 'utf8'), 'model-v2');

  const failed = await ensureLocalOnnxModelArtifact(replacement.key, env, {
    descriptor: replacement,
    forceInstall: true,
    downloadFile: async (url, target) => {
      if (url.endsWith('model.onnx')) fs.writeFileSync(target, replacementDownloads.get('onnx/model.onnx'));
      else throw new Error('download failed');
    },
  });
  assert.equal(failed.status, 'error');
  assert.equal(fs.readFileSync(path.join(modelDir, 'onnx/model.onnx'), 'utf8'), 'model-v2');
  assert.equal(stagingClaimCount(path.join(root, 'cache', 'optsidian', 'dense-onnx', 'staging')), 0);
});

test('AC13 P6 local ONNX artifact install claim timeout is native-free', async () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor();
  const claimDir = path.join(root, 'cache', 'optsidian', 'dense-onnx', `${descriptor.key}.install.claim`);
  const holder = await ExclusiveClaim.acquire(claimDir, {
    token: createProcessToken(),
    claimId: 'live-holder',
    timeoutMs: 0,
  });
  const result = await ensureLocalOnnxModelArtifact(descriptor.key, env, {
    descriptor,
    forceInstall: true,
    lockTimeoutMs: 10,
    lockPollMs: 1,
    downloadFile: async () => {
      throw new Error('download should not start while locked');
    },
  });
  holder.release();
  assert.equal(result.status, 'error');
  assert.match(result.message, /Exclusive claim is held by live pid/);
});

test('AC13 P6 optional real local ONNX smoke', { skip: process.env.OPTSIDIAN_RUN_REAL_ONNX_TEST !== '1' }, async () => {
  const provider = new LocalOnnxProvider({ model: process.env.OPTSIDIAN_REAL_ONNX_MODEL ?? 'multilingual-e5-small' });
  const vector = await provider.embed('real model smoke', { inputKind: 'query' });
  assert.equal(vector.length, localOnnxModelDescriptor(provider.identity.model).dim);
  await provider.close();
});

function tempRoot(prefix = 'optsidian-retrieval-p6-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testEnv(root) {
  return {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  };
}

function stagingClaimCount(stagingRoot) {
  if (!fs.existsSync(stagingRoot)) return 0;
  let count = 0;
  for (const namespace of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!namespace.isDirectory()) continue;
    const namespaceDir = path.join(stagingRoot, namespace.name);
    count += fs.readdirSync(namespaceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  }
  return count;
}

function tinyDescriptor(
  contents = {
    'onnx/model.onnx': Buffer.from('model'),
    'onnx/tokenizer.json': Buffer.from('tokenizer'),
  },
) {
  const files = Object.entries(contents).map(([filePath, content]) => ({
    path: filePath,
    role: filePath.endsWith('.onnx') ? 'model' : 'tokenizer',
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    ...(filePath.endsWith('.onnx') ? { requiredForSession: true } : { requiredForTokenizer: true }),
    content,
  }));
  return {
    key: 'multilingual-e5-small',
    modelId: 'test/tiny',
    revision: 'tiny-revision',
    displayName: 'tiny',
    dim: 2,
    maxTokens: 8,
    pooling: 'mean',
    normalization: 'l2',
    quantization: 'none',
    dtype: 'float32',
    opset: 11,
    requiredVramBytes: 134_217_728,
    inputTemplate: {
      default: '{text}',
      query: '{text}',
      document: '{text}',
    },
    files,
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockRuntimeOptions(dim) {
  const { ort } = mockOrt({ dim });
  return {
    ort,
    tokenizer: {
      encode() {
        return { ids: [1], attention_mask: [1] };
      },
    },
    platform: 'linux',
  };
}

function mockOrt(options) {
  const failProviders = options.failProviders ?? new Set();
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  return {
    ort: {
      Tensor,
      InferenceSession: {
        async create(_modelPath, createOptions) {
          const provider = createOptions.executionProviders[0];
          options.onCreate?.(provider);
          if (failProviders.has(provider)) throw new Error(`${provider} unavailable`);
          return {
            inputNames: ['input_ids', 'attention_mask'],
            outputNames: ['last_hidden_state'],
            async run(feeds) {
              if (options.runError) throw options.runError;
              const sequenceLength = Number(feeds.attention_mask.dims[1]);
              const data = new Float32Array(sequenceLength * options.dim);
              for (let token = 0; token < sequenceLength; token += 1) data[token * options.dim] = 1;
              return {
                last_hidden_state: {
                  data,
                  dims: [1, sequenceLength, options.dim],
                },
              };
            },
            async release() {
              await options.onRelease?.(provider);
            },
          };
        },
      },
    },
  };
}
