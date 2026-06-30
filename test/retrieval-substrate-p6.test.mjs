import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureLocalOnnxModelArtifact,
  inspectLocalOnnxModelArtifact,
  LocalOnnxProvider,
  createOnnxSessionWithFallback,
  localOnnxManifestPath,
  localOnnxModelDir,
  localOnnxModelDescriptor,
  resolveLocalOnnxProviderSelection
} from "../src/core/search/dense/index.ts";
import { tokenizeRoutedText } from "../src/core/search/analyzer.ts";

test("AC13 P6 provider selection defaults to BGE-M3 and selects multilingual-e5-small", () => {
  const defaultSelection = resolveLocalOnnxProviderSelection();
  assert.deepEqual(defaultSelection, { kind: "local-onnx", model: "bge-m3" });

  const e5Selection = resolveLocalOnnxProviderSelection({ search: { embeddingModel: "multilingual-e5-small" } });
  assert.deepEqual(e5Selection, { kind: "local-onnx", model: "multilingual-e5-small" });

  const bge = new LocalOnnxProvider({ ...mockRuntimeOptions(1024), model: undefined });
  assert.equal(bge.identity.id, "local-onnx");
  assert.equal(bge.identity.model, "bge-m3");
  assert.equal(bge.identity.dim, 1024);
  assert.equal(bge.recipeIdentity.modelArtifact.modelId, "BAAI/bge-m3");
  assert.equal(bge.recipeIdentity.tokenizer.runtime.name, "@huggingface/tokenizers");
  assert.equal(bge.recipeIdentity.onnx.runtime.name, "onnxruntime-node");
  assert.equal(bge.recipeIdentity.quantization, "none");
  assert.equal(bge.recipeIdentity.dtype, "float32");
  assert.equal(bge.recipeIdentity.pooling, "mean");
  assert.equal(bge.recipeIdentity.normalization, "l2");
  assert.equal(bge.recipeIdentity.maxTokens, 8192);
  assert.equal(bge.recipeIdentity.renderedTextProjectionVersion, "rendered-text-projection-v1");

  const e5 = new LocalOnnxProvider({ ...mockRuntimeOptions(384), model: "e5-small" });
  assert.equal(e5.identity.model, "multilingual-e5-small");
  assert.equal(e5.identity.dim, 384);
  assert.equal(e5.recipeIdentity.modelArtifact.modelId, "intfloat/multilingual-e5-small");
  assert.equal(e5.recipeIdentity.inputTemplate.query, "query: {text}");
  assert.equal(e5.recipeIdentity.inputTemplate.document, "passage: {text}");
});

test("AC13 P6 ONNX execution provider falls back from unavailable accelerator to CPU", async () => {
  const calls = [];
  const { ort } = mockOrt({
    dim: 1024,
    failProviders: new Set(["cuda"]),
    onCreate: (provider) => calls.push(provider)
  });
  const selection = await createOnnxSessionWithFallback({
    ort,
    modelPath: "/tmp/not-downloaded/model.onnx",
    executionProvider: "auto",
    platform: "linux"
  });
  assert.deepEqual(calls, ["cuda", "cpu"]);
  assert.equal(selection.executionProvider, "cpu");
  assert.equal(selection.failures.length, 1);
  assert.match(selection.failures[0].message, /unavailable/);
});

test("AC12 P6 dense path uses model-native tokenizer while lexical Hangul still routes through Kiwi", async () => {
  const hangul = "한국어 형태소 테스트";
  const kiwiCalls = [];
  const lexical = tokenizeRoutedText(hangul, ["ko"], {
    tokens(text) {
      kiwiCalls.push(text);
      return ["kiwimorph"];
    }
  });
  assert.deepEqual(kiwiCalls, ["한국어", "형태소", "테스트"]);
  assert.deepEqual(lexical, ["kiwimorph"]);

  const denseInputs = [];
  const tokenizer = {
    encode(text) {
      denseInputs.push(text);
      return {
        ids: [101, 102, 103],
        tokens: ["<s>", "한국어", "</s>"],
        attention_mask: [1, 1, 1]
      };
    }
  };
  const { ort } = mockOrt({ dim: 384 });
  const provider = new LocalOnnxProvider({
    model: "multilingual-e5-small",
    ort,
    tokenizer,
    platform: "linux"
  });

  const vector = await provider.embed(hangul, { inputKind: "query" });
  assert.equal(vector.length, 384);
  assert.deepEqual(denseInputs, [`query: ${hangul}`]);
  assert.equal(denseInputs.some((input) => input.includes("kiwimorph")), false);
});

test("AC13 P6 README documents Linux GPU requirements and graceful CPU fallback", () => {
  const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /Dense Search GPU Runtime/);
  assert.match(readme, /CUDA 12\.x/);
  assert.match(readme, /cuDNN 9/);
  assert.match(readme, /cudnn9-cuda-12/);
  assert.match(readme, /CPU-only/);
  assert.match(readme, /CoreML\/Metal/);
  assert.match(readme, /cu12 build/);
  assert.match(readme, /onnxruntime-node/);
});

test("AC13 P6 local ONNX artifact inspection detects missing manifest mismatch and digest mismatch", () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor();
  const missing = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor });
  assert.equal(missing.installed, false);
  assert.equal(missing.manifest, null);
  assert.deepEqual(missing.missingFiles, descriptor.files.map((file) => file.path));

  const modelDir = localOnnxModelDir(descriptor.key, env);
  fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  for (const file of descriptor.files) {
    fs.writeFileSync(path.join(modelDir, file.path), Buffer.alloc(file.sizeBytes, 1));
  }
  fs.writeFileSync(localOnnxManifestPath(descriptor.key, env), JSON.stringify({
    packageId: "dense-onnx",
    modelKey: descriptor.key,
    modelId: "wrong",
    revision: descriptor.revision,
    sourceBaseUrl: "wrong",
    files: [],
    modelArtifactSha256: "wrong",
    tokenizerArtifactSha256: "wrong",
    installedAt: new Date().toISOString()
  }));
  const mismatch = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor, verifyFiles: "metadata" });
  assert.equal(mismatch.installed, false);
  assert.equal(mismatch.manifest, null);
  assert.deepEqual(mismatch.missingFiles, []);

  const digest = inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor, verifyFiles: "digest" });
  assert.equal(digest.installed, false);
  assert.ok(digest.missingFiles.every((entry) => entry.includes("digest mismatch")));
});

test("AC13 P6 local ONNX artifact install verifies digests replaces staging and cleans failed staging", async () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor({
    "onnx/model.onnx": Buffer.from("model-v1"),
    "onnx/tokenizer.json": Buffer.from("tokenizer-v1")
  });
  const downloads = new Map(descriptor.files.map((file) => [file.path, file.content]));
  const result = await ensureLocalOnnxModelArtifact(descriptor.key, env, {
    descriptor,
    forceInstall: true,
    downloadFile: async (url, target) => {
      const rel = [...downloads.keys()].find((candidate) => url.endsWith(candidate));
      if (!rel) throw new Error(`unexpected download URL ${url}`);
      fs.writeFileSync(target, downloads.get(rel));
    }
  });
  assert.equal(result.status, "installed");
  const modelDir = localOnnxModelDir(descriptor.key, env);
  assert.equal(fs.readFileSync(path.join(modelDir, "onnx/model.onnx"), "utf8"), "model-v1");
  assert.equal(inspectLocalOnnxModelArtifact(descriptor.key, env, { descriptor }).installed, true);
  assert.equal(fs.readdirSync(path.dirname(modelDir)).some((entry) => entry.endsWith(".part")), false);

  const replacement = tinyDescriptor({
    "onnx/model.onnx": Buffer.from("model-v2"),
    "onnx/tokenizer.json": Buffer.from("tokenizer-v2")
  });
  const replacementDownloads = new Map(replacement.files.map((file) => [file.path, file.content]));
  const replaced = await ensureLocalOnnxModelArtifact(replacement.key, env, {
    descriptor: replacement,
    forceInstall: true,
    downloadFile: async (url, target) => {
      const rel = [...replacementDownloads.keys()].find((candidate) => url.endsWith(candidate));
      fs.writeFileSync(target, replacementDownloads.get(rel));
    }
  });
  assert.equal(replaced.status, "installed");
  assert.equal(fs.readFileSync(path.join(modelDir, "onnx/model.onnx"), "utf8"), "model-v2");

  const failed = await ensureLocalOnnxModelArtifact(replacement.key, env, {
    descriptor: replacement,
    forceInstall: true,
    downloadFile: async (url, target) => {
      if (url.endsWith("model.onnx")) fs.writeFileSync(target, replacementDownloads.get("onnx/model.onnx"));
      else throw new Error("download failed");
    }
  });
  assert.equal(failed.status, "error");
  assert.equal(fs.readFileSync(path.join(modelDir, "onnx/model.onnx"), "utf8"), "model-v2");
  assert.equal(fs.readdirSync(path.dirname(modelDir)).some((entry) => entry.endsWith(".part")), false);
});

test("AC13 P6 local ONNX artifact install lock timeout is native-free", async () => {
  const root = tempRoot();
  const env = testEnv(root);
  const descriptor = tinyDescriptor();
  const lockDir = path.join(root, "cache", "optsidian", "dense-onnx", `${descriptor.key}.install.lock`);
  fs.mkdirSync(lockDir, { recursive: true });
  const result = await ensureLocalOnnxModelArtifact(descriptor.key, env, {
    descriptor,
    forceInstall: true,
    lockTimeoutMs: 10,
    lockPollMs: 1,
    downloadFile: async () => {
      throw new Error("download should not start while locked");
    }
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /Timed out waiting/);
});

test("AC13 P6 optional real local ONNX smoke", { skip: process.env.OPTSIDIAN_RUN_REAL_ONNX_TEST !== "1" }, async () => {
  const provider = new LocalOnnxProvider({ model: process.env.OPTSIDIAN_REAL_ONNX_MODEL ?? "multilingual-e5-small" });
  const vector = await provider.embed("real model smoke", { inputKind: "query" });
  assert.equal(vector.length, localOnnxModelDescriptor(provider.identity.model).dim);
  await provider.close();
});

function tempRoot(prefix = "optsidian-retrieval-p6-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testEnv(root) {
  return {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config")
  };
}

function tinyDescriptor(contents = {
  "onnx/model.onnx": Buffer.from("model"),
  "onnx/tokenizer.json": Buffer.from("tokenizer")
}) {
  const files = Object.entries(contents).map(([filePath, content]) => ({
    path: filePath,
    role: filePath.endsWith(".onnx") ? "model" : "tokenizer",
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    ...(filePath.endsWith(".onnx") ? { requiredForSession: true } : { requiredForTokenizer: true }),
    content
  }));
  return {
    key: "multilingual-e5-small",
    modelId: "test/tiny",
    revision: "tiny-revision",
    displayName: "tiny",
    dim: 2,
    maxTokens: 8,
    pooling: "mean",
    normalization: "l2",
    quantization: "none",
    dtype: "float32",
    opset: 11,
    inputTemplate: {
      default: "{text}",
      query: "{text}",
      document: "{text}"
    },
    files
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mockRuntimeOptions(dim) {
  const { ort } = mockOrt({ dim });
  return {
    ort,
    tokenizer: {
      encode() {
        return { ids: [1], attention_mask: [1] };
      }
    },
    platform: "linux"
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
            inputNames: ["input_ids", "attention_mask"],
            outputNames: ["last_hidden_state"],
            async run(feeds) {
              const sequenceLength = Number(feeds.attention_mask.dims[1]);
              const data = new Float32Array(sequenceLength * options.dim);
              for (let token = 0; token < sequenceLength; token += 1) data[token * options.dim] = 1;
              return {
                last_hidden_state: {
                  data,
                  dims: [1, sequenceLength, options.dim]
                }
              };
            }
          };
        }
      }
    }
  };
}
