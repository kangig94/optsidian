import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

const repoRoot = process.cwd();

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-core-"));
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function tarSingleFile(filePath, content) {
  const contentBuffer = Buffer.from(content);
  const header = Buffer.alloc(512, 0);
  const name = Buffer.from(filePath);
  if (name.length > 100) throw new Error("tar test helper only supports short paths");
  name.copy(header, 0);
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(contentBuffer.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const padding = Buffer.alloc((512 - (contentBuffer.length % 512)) % 512, 0);
  return Buffer.concat([header, contentBuffer, padding, Buffer.alloc(1024, 0)]);
}

function recommitSearchIndexPair(paths) {
  const indexRaw = fs.readFileSync(paths.indexPath, "utf8");
  const manifestRaw = fs.readFileSync(paths.manifestPath, "utf8");
  fs.writeFileSync(paths.commitPath, `${JSON.stringify({
    cacheVersion: 1,
    indexSha256: sha256(indexRaw),
    manifestSha256: sha256(manifestRaw),
    writtenAt: new Date().toISOString()
  }, null, 2)}\n`);
}

async function core() {
  return import(path.join(repoRoot, "src/core/index.ts"));
}

async function withProcessEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withSearchProcess(cache, fn) {
  const previousCwd = process.cwd();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-project-"));
  process.chdir(project);
  try {
    return await withProcessEnv({ XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: path.join(project, "config") }, fn);
  } finally {
    process.chdir(previousCwd);
  }
}

test("markdown search parser extracts title aliases tags headings and body", async () => {
  const { parseMarkdownNote } = await import(path.join(repoRoot, "src/core/search/markdown.ts"));
  const doc = parseMarkdownNote(
    "Projects/alpha.md",
    `---
title: Alpha Project
aliases:
  - Project A
keywords:
  - Neural Search
tags: [project, alpha]
---
# Alpha Heading

Body with #rollout tag.
`
  );

  assert.equal(doc.title, "Alpha Project");
  assert.deepEqual(doc.aliases, ["Project A", "Neural Search"]);
  assert.deepEqual(doc.tags.sort(), ["alpha", "project", "rollout"]);
  assert.deepEqual(doc.headings, ["Alpha Heading"]);
  assert.match(doc.body, /Body with #rollout tag/);
});

test("search surface analyzer expands compound path title and acronym terms", async () => {
  const { surfaceSearchTerms } = await import(path.join(repoRoot, "src/core/search/analysis/index.ts"));
  const terms = surfaceSearchTerms("Research/HumanoidMotionTracking-DDPMScheduler Sim2Real.md");
  for (const term of ["research", "humanoidmotiontracking", "humanoid", "motion", "tracking", "ddpmscheduler", "ddpm", "scheduler", "sim2real", "sim", "real"]) {
    assert.ok(terms.includes(term), `expected ${term} in ${JSON.stringify(terms)}`);
  }
});

test("intl search analyzer segments CJK text for lexical search", async () => {
  const {
    analyzerIdentityKey,
    parseDeclaredSearchAnalyzers,
    resolveSearchAnalyzer,
    tokenizeIntlText,
    tokenizeRoutedText
  } = await import(path.join(repoRoot, "src/core/search/analyzer.ts"));

  assert.ok(tokenizeIntlText("検索方式を改善する").includes("検索"));
  assert.ok(tokenizeIntlText("中文搜索方式需要改善").includes("搜索"));
  assert.deepEqual(tokenizeIntlText("résumés running studies"), ["resum", "run", "studi"]);
  assert.deepEqual(tokenizeIntlText("한글"), ["한글"]);
  assert.deepEqual(tokenizeRoutedText("검색API", ["ko"]), ["검색", "api"]);
  assert.deepEqual(parseDeclaredSearchAnalyzers(" ko,KO , "), ["ko"]);
  const analyzer = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, {});
  assert.deepEqual(analyzer.identity.declaredAnalyzers, ["ko"]);
  assert.deepEqual(analyzer.identity.activeAnalyzers, ["ko"]);
  assert.equal(analyzer.identity.optionsHash, "kiwi-pos-filter-v1");
  assert.ok((await analyzer.tokenize("한국어 검색")).includes("한국어"));
  const envOverSettings = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "" }, { search: { extraLangs: ["ko"] } });
  assert.deepEqual(envOverSettings.identity.declaredAnalyzers, []);
  assert.deepEqual(resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_ANALYZER: "kiwi" }, { search: { analyzer: "intl" } }).identity.activeAnalyzers, ["ko"]);
  assert.equal(
    analyzerIdentityKey({ name: "custom", version: "1", node: "20", model: "m", runtime: "daemon" }),
    analyzerIdentityKey({ runtime: "daemon", model: "m", node: "20", version: "1", name: "custom" })
  );
  assert.throws(() => parseDeclaredSearchAnalyzers("ja"), /registered analyzers: ko/);
});

test("kiwi search token filter drops Korean function tokens", async () => {
  const { __filterKiwiTokensForTests } = await import(path.join(repoRoot, "src/core/kiwi/loader.ts"));

  assert.deepEqual(__filterKiwiTokensForTests([
    { str: "보행", tag: "NNG" },
    { str: "을", tag: "JKO" },
    { str: "하", tag: "XSV" },
    { str: "다", tag: "EF" }
  ]), ["보행"]);
  assert.deepEqual(__filterKiwiTokensForTests([
    { str: "만들", tag: "VV" },
    { str: "었다", tag: "EP" }
  ]), ["만들"]);
  assert.deepEqual(__filterKiwiTokensForTests([
    { str: "아니", tag: "VCN" },
    { str: "보", tag: "VX" },
    { str: "좋", tag: "VA" }
  ]), ["좋"]);
  assert.deepEqual(__filterKiwiTokensForTests([
    { str: "API", tag: "SL" },
    { str: "42", tag: "SN" },
    { str: ".", tag: "SF" }
  ]), ["API", "42"]);
});

test("kiwi analyzer manager supports non-blocking and blocking modes", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));

  const loadCalls = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: () => ({
      targetDir: "/tmp/kiwi-model",
      manifestPath: "/tmp/kiwi-model/manifest.json",
      installed: true,
      manifest: {
        packageId: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: "0.23.0",
        modelType: "cong-global",
        sourceUrl: "test",
        archiveSha256: "sha",
        archiveSizeBytes: 1,
        files: [],
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    loadAnalyzer: async (options) => {
      loadCalls.push(options);
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: "0.23.0",
          modelType: "cong-global"
        },
        tokens: (text) => [`kiwi:${text}`],
        dispose: async () => {}
      };
    }
  });

  try {
    const nonBlocking = await manager.withAnalyzerLease(
      {},
      ["ko"],
      { wait: false, installIfMissing: false },
      (lease) => ({
        hasAnalyzer: Boolean(lease.analyzer),
        activeAnalyzers: lease.activeAnalyzers
      })
    );
    assert.deepEqual(loadCalls, []);
    assert.equal(nonBlocking.hasAnalyzer, false);
    assert.deepEqual(nonBlocking.activeAnalyzers, []);

    const blocking = await manager.withAnalyzerLease(
      {},
      ["ko"],
      { wait: true, installIfMissing: true },
      (lease) => lease.analyzer?.tokens("한국어")
    );
    assert.deepEqual(blocking, ["kiwi:한국어"]);
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0].installIfMissing, true);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager does not share an in-flight load across cache envs", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  let releaseFirstLoad;
  const firstLoadGate = new Promise((resolve) => {
    releaseFirstLoad = resolve;
  });
  const loadCalls = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
      installed: true,
      manifest: {
        packageId: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: "0.23.0",
        modelType: "cong-global",
        sourceUrl: "test",
        archiveSha256: "sha",
        archiveSizeBytes: 1,
        files: [],
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    inspectWasmArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-wasm"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "manifest.json"),
      wasmPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "kiwi-wasm.wasm"),
      installed: true,
      manifest: {
        packageId: "kiwi-wasm",
        kiwiNlpVersion: "0.23.0",
        sourceUrl: "test",
        wasmSha256: "sha",
        wasmSizeBytes: 1,
        file: "kiwi-wasm.wasm",
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    loadAnalyzer: async ({ env }) => {
      loadCalls.push(env.XDG_CACHE_HOME);
      if (loadCalls.length === 1) await firstLoadGate;
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: env.XDG_CACHE_HOME,
          modelType: "cong-global"
        },
        tokens: (text) => [`${env.XDG_CACHE_HOME}:${text}`],
        dispose: async () => {}
      };
    }
  });

  try {
    const first = manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-a" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("검색")
    );
    while (loadCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-b" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("검색")
    );
    releaseFirstLoad();

    assert.deepEqual(await first, ["/tmp/kiwi-a:검색"]);
    assert.deepEqual(await second, ["/tmp/kiwi-b:검색"]);
    assert.deepEqual(loadCalls, ["/tmp/kiwi-a", "/tmp/kiwi-b"]);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager retires active leases before disposing old envs", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  const loadCalls = [];
  const disposals = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
      installed: true,
      manifest: {
        packageId: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: "0.23.0",
        modelType: "cong-global",
        sourceUrl: "test",
        archiveSha256: "sha",
        archiveSizeBytes: 1,
        files: [],
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    loadAnalyzer: async ({ env }) => {
      const key = env.XDG_CACHE_HOME;
      loadCalls.push(key);
      let disposed = false;
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: key,
          modelType: "cong-global"
        },
        tokens: (text) => {
          if (disposed) throw new Error(`${key} was disposed while leased`);
          return [`${key}:${text}`];
        },
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          disposals.push(key);
        }
      };
    }
  });

  try {
    const first = manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-a" },
      ["ko"],
      { wait: true, installIfMissing: true },
      async ({ analyzer }) => {
        const second = manager.withAnalyzerLease(
          { XDG_CACHE_HOME: "/tmp/kiwi-b" },
          ["ko"],
          { wait: true, installIfMissing: true },
          ({ analyzer: secondAnalyzer }) => secondAnalyzer.tokens("second")
        );
        while (loadCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(analyzer.tokens("still-active"), ["/tmp/kiwi-a:still-active"]);
        assert.deepEqual(disposals, []);
        assert.deepEqual(await second, ["/tmp/kiwi-b:second"]);
        return analyzer.tokens("done");
      }
    );

    assert.deepEqual(await first, ["/tmp/kiwi-a:done"]);
    assert.deepEqual(disposals, ["/tmp/kiwi-a"]);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager reports runtime status for the requested cache env", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  const inspectModes = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env, options = {}) => {
      inspectModes.push(options.verifyFiles ?? "digest");
      return {
        targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
        manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
        installed: true,
        manifest: {
          packageId: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: "0.23.0",
          modelType: "cong-global",
          sourceUrl: "test",
          archiveSha256: "sha",
          archiveSizeBytes: 1,
          files: [],
          installedAt: "2026-06-22T00:00:00.000Z"
        },
        missingFiles: []
      };
    },
    loadAnalyzer: async ({ env }) => ({
      identity: {
        engine: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: env.XDG_CACHE_HOME,
        modelType: "cong-global"
      },
      tokens: (text) => [`${env.XDG_CACHE_HOME}:${text}`],
      dispose: async () => {}
    })
  });

  try {
    await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-status-a" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("검색")
    );

    assert.deepEqual(inspectModes, []);
    assert.equal(manager.status({ XDG_CACHE_HOME: "/tmp/kiwi-status-a" }).state, "loaded");
    assert.equal(manager.status({ XDG_CACHE_HOME: "/tmp/kiwi-status-b" }).state, "unloaded");
    assert.deepEqual(inspectModes, ["metadata", "metadata"]);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager reuses active handles without rechecking model files", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  let inspectCalls = 0;
  let loadCalls = 0;
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env) => {
      inspectCalls += 1;
      return {
        targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
        manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
        installed: true,
        manifest: {
          packageId: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: "0.23.0",
          modelType: "cong-global",
          sourceUrl: "test",
          archiveSha256: "sha",
          archiveSizeBytes: 1,
          files: [],
          installedAt: "2026-06-22T00:00:00.000Z"
        },
        missingFiles: []
      };
    },
    loadAnalyzer: async ({ env }) => {
      loadCalls += 1;
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: env.XDG_CACHE_HOME,
          modelType: "cong-global"
        },
        tokens: (text) => [`${env.XDG_CACHE_HOME}:${text}`],
        dispose: async () => {}
      };
    }
  });

  try {
    const first = await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-active-reuse" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("first")
    );
    const second = await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-active-reuse" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("second")
    );

    assert.deepEqual(first, ["/tmp/kiwi-active-reuse:first"]);
    assert.deepEqual(second, ["/tmp/kiwi-active-reuse:second"]);
    assert.equal(loadCalls, 1);
    assert.equal(inspectCalls, 0);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager does not apply degraded state across cache envs", async () => {
  const { KiwiAnalyzerManager, KiwiAnalyzerTerminalLoadError } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  const loadCalls = [];
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
      installed: true,
      manifest: {
        packageId: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: "0.23.0",
        modelType: "cong-global",
        sourceUrl: "test",
        archiveSha256: "sha",
        archiveSizeBytes: 1,
        files: [],
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    inspectWasmArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-wasm"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "manifest.json"),
      wasmPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "kiwi-wasm.wasm"),
      installed: true,
      manifest: {
        packageId: "kiwi-wasm",
        kiwiNlpVersion: "0.23.0",
        sourceUrl: "test",
        wasmSha256: "sha",
        wasmSizeBytes: 1,
        file: "kiwi-wasm.wasm",
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    loadAnalyzer: async ({ env }) => {
      loadCalls.push(env.XDG_CACHE_HOME);
      if (env.XDG_CACHE_HOME === "/tmp/kiwi-degraded-a") {
        throw new Error("simulated load failure");
      }
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: env.XDG_CACHE_HOME,
          modelType: "cong-global"
        },
        tokens: (text) => [`${env.XDG_CACHE_HOME}:${text}`],
        dispose: async () => {}
      };
    }
  });

  try {
    await assert.rejects(
      () => manager.withAnalyzerLease(
        { XDG_CACHE_HOME: "/tmp/kiwi-degraded-a" },
        ["ko"],
        { wait: true, installIfMissing: true },
        ({ analyzer }) => analyzer.tokens("first")
      ),
      KiwiAnalyzerTerminalLoadError
    );
    assert.equal(manager.status({ XDG_CACHE_HOME: "/tmp/kiwi-degraded-a" }).state, "degraded");
    assert.equal(manager.status({ XDG_CACHE_HOME: "/tmp/kiwi-degraded-b" }).state, "unloaded");

    const second = await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-degraded-b" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("second")
    );
    assert.deepEqual(second, ["/tmp/kiwi-degraded-b:second"]);
    assert.deepEqual(loadCalls, ["/tmp/kiwi-degraded-a", "/tmp/kiwi-degraded-b"]);
  } finally {
    await manager.close();
  }
});

test("kiwi analyzer manager retries transient missing wasm failures", async () => {
  const { KiwiAnalyzerManager } = await import(path.join(repoRoot, "src/core/kiwi/manager.ts"));
  let wasmInstalled = false;
  let attempts = 0;
  const manager = new KiwiAnalyzerManager({
    inspectModelArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-model"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-model", "manifest.json"),
      installed: true,
      manifest: {
        packageId: "kiwi",
        kiwiNlpVersion: "0.23.0",
        modelVersion: "0.23.0",
        modelType: "cong-global",
        sourceUrl: "test",
        archiveSha256: "sha",
        archiveSizeBytes: 1,
        files: [],
        installedAt: "2026-06-22T00:00:00.000Z"
      },
      missingFiles: []
    }),
    inspectWasmArtifact: (env) => ({
      targetDir: path.join(env.XDG_CACHE_HOME, "kiwi-wasm"),
      manifestPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "manifest.json"),
      wasmPath: path.join(env.XDG_CACHE_HOME, "kiwi-wasm", "kiwi-wasm.wasm"),
      installed: wasmInstalled,
      manifest: wasmInstalled
        ? {
            packageId: "kiwi-wasm",
            kiwiNlpVersion: "0.23.0",
            sourceUrl: "test",
            wasmSha256: "sha",
            wasmSizeBytes: 1,
            file: "kiwi-wasm.wasm",
            installedAt: "2026-06-22T00:00:00.000Z"
          }
        : null,
      missingFiles: wasmInstalled ? [] : ["kiwi-wasm.wasm"]
    }),
    loadAnalyzer: async ({ env }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated wasm download failure");
      return {
        identity: {
          engine: "kiwi",
          kiwiNlpVersion: "0.23.0",
          modelVersion: env.XDG_CACHE_HOME,
          modelType: "cong-global"
        },
        tokens: (text) => [`${env.XDG_CACHE_HOME}:${text}`],
        dispose: async () => {}
      };
    }
  });

  try {
    await assert.rejects(
      () => manager.withAnalyzerLease(
        { XDG_CACHE_HOME: "/tmp/kiwi-missing-wasm" },
        ["ko"],
        { wait: true, installIfMissing: true },
        ({ analyzer }) => analyzer.tokens("first")
      ),
      /simulated wasm download failure/
    );
    assert.equal(manager.status({ XDG_CACHE_HOME: "/tmp/kiwi-missing-wasm" }).state, "unloaded");

    wasmInstalled = true;
    const second = await manager.withAnalyzerLease(
      { XDG_CACHE_HOME: "/tmp/kiwi-missing-wasm" },
      ["ko"],
      { wait: true, installIfMissing: true },
      ({ analyzer }) => analyzer.tokens("second")
    );
    assert.deepEqual(second, ["/tmp/kiwi-missing-wasm:second"]);
    assert.equal(attempts, 2);
  } finally {
    await manager.close();
  }
});

test("kiwi wasm binary installs at runtime instead of using a bundled wasm import", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const wasm = fs.readFileSync(path.join(repoRoot, "node_modules/kiwi-nlp/dist/kiwi-wasm.wasm"));
  const archive = zlib.gzipSync(tarSingleFile("package/dist/kiwi-wasm.wasm", wasm));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    };
  };
  const { loadKiwiWasmBinary } = await import(path.join(repoRoot, "src/core/kiwi/loader.ts"));
  const { inspectKiwiWasmArtifact } = await import(path.join(repoRoot, "src/core/kiwi/artifact.ts"));
  try {
    const env = { XDG_CACHE_HOME: cache };
    const binary = await loadKiwiWasmBinary(env);
    const state = inspectKiwiWasmArtifact(env);
    assert.ok(binary instanceof Uint8Array);
    assert.equal(binary.length, wasm.length);
    assert.equal(sha256(binary), sha256(wasm));
    assert.equal(state.installed, true);
    assert.equal(state.manifest.wasmSha256, sha256(wasm));
    assert.deepEqual(calls, ["https://registry.npmjs.org/kiwi-nlp/-/kiwi-nlp-0.23.0.tgz"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kiwi loader resolves direct and wrapped wasm initializer imports", async () => {
  const { __resolveKiwiWasmInitializerForTests } = await import(path.join(repoRoot, "src/core/kiwi/loader.ts"));
  const wasmModule = {
    FS: {},
    api: () => "null"
  };
  const initializer = async () => wasmModule;

  assert.equal(await __resolveKiwiWasmInitializerForTests(initializer)(), wasmModule);
  assert.equal(await __resolveKiwiWasmInitializerForTests({ default: initializer })(), wasmModule);
  assert.throws(() => __resolveKiwiWasmInitializerForTests({}), /Kiwi wasm initializer is not available/);
});

test("kiwi wasm install recovers stale install locks", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const wasm = fs.readFileSync(path.join(repoRoot, "node_modules/kiwi-nlp/dist/kiwi-wasm.wasm"));
  const archive = zlib.gzipSync(tarSingleFile("package/dist/kiwi-wasm.wasm", wasm));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
  });
  const {
    __setKiwiInstallLockStaleMsForTests,
    inspectKiwiWasmArtifact,
    kiwiDataDir
  } = await import(path.join(repoRoot, "src/core/kiwi/artifact.ts"));
  const { loadKiwiWasmBinary } = await import(path.join(repoRoot, "src/core/kiwi/loader.ts"));
  const env = { XDG_CACHE_HOME: cache };
  const lockDir = path.join(kiwiDataDir(env), "wasm-install.lock");

  fs.mkdirSync(lockDir, { recursive: true });
  const staleAt = new Date(Date.now() - 10_000);
  fs.utimesSync(lockDir, staleAt, staleAt);
  __setKiwiInstallLockStaleMsForTests(1);
  try {
    const binary = await loadKiwiWasmBinary(env);
    const state = inspectKiwiWasmArtifact(env);
    assert.equal(binary.length, wasm.length);
    assert.equal(state.installed, true);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    __setKiwiInstallLockStaleMsForTests(undefined);
    globalThis.fetch = originalFetch;
  }
});

test("kiwi wasm install repairs corrupt installed wasm files", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const wasm = fs.readFileSync(path.join(repoRoot, "node_modules/kiwi-nlp/dist/kiwi-wasm.wasm"));
  const archive = zlib.gzipSync(tarSingleFile("package/dist/kiwi-wasm.wasm", wasm));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    };
  };
  const {
    KIWI_NLP_VERSION,
    KIWI_WASM_FILE_NAME,
    KIWI_WASM_NPM_TARBALL_URL,
    KIWI_WASM_SHA256,
    KIWI_WASM_SIZE_BYTES,
    inspectKiwiWasmArtifact,
    kiwiWasmDir,
    kiwiWasmFilePath,
    kiwiWasmManifestPath
  } = await import(path.join(repoRoot, "src/core/kiwi/artifact.ts"));
  const { loadKiwiWasmBinary } = await import(path.join(repoRoot, "src/core/kiwi/loader.ts"));
  const env = { XDG_CACHE_HOME: cache };

  fs.mkdirSync(kiwiWasmDir(env), { recursive: true });
  fs.writeFileSync(kiwiWasmFilePath(env), "corrupt wasm");
  fs.writeFileSync(kiwiWasmManifestPath(env), `${JSON.stringify({
    packageId: "kiwi-wasm",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    sourceUrl: KIWI_WASM_NPM_TARBALL_URL,
    wasmSha256: KIWI_WASM_SHA256,
    wasmSizeBytes: KIWI_WASM_SIZE_BYTES,
    file: KIWI_WASM_FILE_NAME,
    installedAt: "2026-06-22T00:00:00.000Z"
  }, null, 2)}\n`);

  try {
    const before = inspectKiwiWasmArtifact(env);
    assert.equal(before.installed, false);
    assert.match(before.missingFiles.join(","), /size mismatch|digest mismatch/);

    const binary = await loadKiwiWasmBinary(env);
    const after = inspectKiwiWasmArtifact(env);
    assert.equal(binary.length, wasm.length);
    assert.equal(sha256(binary), sha256(wasm));
    assert.equal(after.installed, true);
    assert.deepEqual(calls, [KIWI_WASM_NPM_TARBALL_URL]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kiwi wasm inspection can skip digest for lightweight status", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const {
    KIWI_NLP_VERSION,
    KIWI_WASM_FILE_NAME,
    KIWI_WASM_NPM_TARBALL_URL,
    KIWI_WASM_SHA256,
    KIWI_WASM_SIZE_BYTES,
    inspectKiwiWasmArtifact,
    kiwiWasmDir,
    kiwiWasmFilePath,
    kiwiWasmManifestPath,
    readVerifiedKiwiWasmBinary
  } = await import(path.join(repoRoot, "src/core/kiwi/artifact.ts"));
  const env = { XDG_CACHE_HOME: cache };

  fs.mkdirSync(kiwiWasmDir(env), { recursive: true });
  fs.writeFileSync(kiwiWasmFilePath(env), Buffer.alloc(KIWI_WASM_SIZE_BYTES, 0));
  fs.writeFileSync(kiwiWasmManifestPath(env), `${JSON.stringify({
    packageId: "kiwi-wasm",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    sourceUrl: KIWI_WASM_NPM_TARBALL_URL,
    wasmSha256: KIWI_WASM_SHA256,
    wasmSizeBytes: KIWI_WASM_SIZE_BYTES,
    file: KIWI_WASM_FILE_NAME,
    installedAt: "2026-06-22T00:00:00.000Z"
  }, null, 2)}\n`);

  const metadataState = inspectKiwiWasmArtifact(env, { verifyFile: "metadata" });
  assert.equal(metadataState.installed, true);

  const digestState = inspectKiwiWasmArtifact(env);
  assert.equal(digestState.installed, false);
  assert.deepEqual(digestState.missingFiles, [`${KIWI_WASM_FILE_NAME} (digest mismatch)`]);
  assert.throws(() => readVerifiedKiwiWasmBinary(env), /digest mismatch/);
});

test("kiwi model inspection rejects corrupt installed model files", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  const {
    KIWI_MODEL_ARCHIVE_SIZE_BYTES,
    KIWI_MODEL_FILES,
    KIWI_MODEL_SHA256,
    KIWI_MODEL_TYPE,
    KIWI_MODEL_URL,
    KIWI_MODEL_VERSION,
    KIWI_NLP_VERSION,
    inspectKiwiModelArtifact,
    kiwiModelDir,
    kiwiModelFilePath,
    kiwiModelManifestPath,
    readVerifiedKiwiModelFiles
  } = await import(path.join(repoRoot, "src/core/kiwi/artifact.ts"));
  const env = { XDG_CACHE_HOME: cache };

  fs.mkdirSync(kiwiModelDir(env), { recursive: true });
  for (const fileName of KIWI_MODEL_FILES) {
    fs.writeFileSync(kiwiModelFilePath(fileName, env), "corrupt model");
  }
  fs.writeFileSync(kiwiModelManifestPath(env), `${JSON.stringify({
    packageId: "kiwi",
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE,
    sourceUrl: KIWI_MODEL_URL,
    archiveSha256: KIWI_MODEL_SHA256,
    archiveSizeBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES,
    files: [...KIWI_MODEL_FILES],
    installedAt: "2026-06-22T00:00:00.000Z"
  }, null, 2)}\n`);

  const metadataState = inspectKiwiModelArtifact(env, { verifyFiles: "metadata" });
  assert.equal(metadataState.installed, true);

  const state = inspectKiwiModelArtifact(env);
  assert.equal(state.installed, false);
  assert.equal(state.missingFiles.length, KIWI_MODEL_FILES.length);
  assert.match(state.missingFiles.join(","), /digest mismatch/);
  assert.throws(() => readVerifiedKiwiModelFiles(env), /digest mismatch/);
});

test("read caps by lines and pages without gaps", async () => {
  const vault = tempVault();
  const { readVaultFile, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "doc.md", content: `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n` });

  const first = readVaultFile(vault, { path: "doc.md", maxLines: 4 });
  assert.deepEqual(first.range, { start: 1, end: 4, total: 10 });
  assert.equal(first.truncated, true);
  assert.equal(first.numberedText.split("\n").length, 4);

  // a requested range wider than maxLines is capped to the actual returned end
  const windowed = readVaultFile(vault, { path: "doc.md", lines: { start: 5, end: 10 }, maxLines: 3 });
  assert.deepEqual(windowed.range, { start: 5, end: 7, total: 10 });
  assert.equal(windowed.truncated, true);

  // continuing from the reported end reads the remainder with no gap and no truncation
  const rest = readVaultFile(vault, { path: "doc.md", lines: { start: 8, end: 10 }, maxLines: 3 });
  assert.deepEqual(rest.range, { start: 8, end: 10, total: 10 });
  assert.equal(rest.truncated, false);
});

test("vault access registry keeps recent realpaths only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-access-"));
  const cache = path.join(dir, "cache");
  const firstVault = path.join(dir, "vault");
  const secondVault = path.join(dir, "second-vault");
  const thirdVault = path.join(dir, "third-vault");
  fs.mkdirSync(firstVault, { recursive: true });
  fs.mkdirSync(secondVault, { recursive: true });
  fs.mkdirSync(thirdVault, { recursive: true });
  const env = { XDG_CACHE_HOME: cache };
  const dayMs = 24 * 60 * 60 * 1000;
  const { recordVaultAccess, recentVaultAccessRoots, vaultAccessPath, vaultAccessStatus } = await import(path.join(repoRoot, "src/core/vault-access.ts"));
  const firstReal = fs.realpathSync(firstVault);
  const secondReal = fs.realpathSync(secondVault);
  const thirdReal = fs.realpathSync(thirdVault);

  assert.equal(recordVaultAccess(firstVault, { env, nowMs: 0 }), firstReal);
  assert.equal(recordVaultAccess(secondVault, { env, nowMs: 6 * dayMs }), secondReal);
  assert.deepEqual(recentVaultAccessRoots({ env, nowMs: 6 * dayMs }), [secondReal, firstReal]);
  assert.deepEqual(recentVaultAccessRoots({
    env,
    nowMs: 6 * dayMs,
    settings: { search: { indexWarmAccessMaxAgeDays: 5 } }
  }), [secondReal]);

  assert.equal(recordVaultAccess(thirdVault, { env, nowMs: 8 * dayMs }), thirdReal);
  assert.deepEqual(recentVaultAccessRoots({ env, nowMs: 8 * dayMs }), [thirdReal, secondReal]);
  assert.equal(vaultAccessStatus(firstVault, {
    env,
    nowMs: 8 * dayMs,
    settings: { search: { indexWarmAccessMaxAgeDays: 5 } }
  }).recent, false);
  assert.deepEqual(recentVaultAccessRoots({
    env: { ...env, OPTSIDIAN_INDEX_WARM_ACCESS_MAX_AGE_DAYS: "10" },
    nowMs: 8 * dayMs,
    settings: { search: { indexWarmAccessMaxAgeDays: 5 } }
  }), [thirdReal, secondReal]);

  fs.rmSync(secondVault, { recursive: true, force: true });
  assert.deepEqual(recentVaultAccessRoots({ env, nowMs: 8 * dayMs }), [thirdReal]);
  const state = JSON.parse(fs.readFileSync(vaultAccessPath(env), "utf8"));
  assert.deepEqual(state.vaults.map((entry) => entry.realpath), [thirdReal, secondReal]);
});

test("core write/read preserves shell-sensitive raw payloads", async () => {
  const vault = tempVault();
  const { grepVault, readVaultFile, writeVaultFile } = await core();
  const raw = [
    "literal $HOME",
    "subshell $(echo hacked)",
    "backticks `uname -a`",
    "quotes 'single' \"double\"",
    "```bash",
    "echo \"$HOME\" && echo $(whoami)",
    "```",
    ""
  ].join("\n");

  const write = writeVaultFile(vault, { path: "raw.md", content: raw });
  assert.equal(write.ok, true);
  assert.equal(write.command, "write");
  assert.equal(write.changes[0].after, raw);
  assert.equal(fs.readFileSync(path.join(vault, "raw.md"), "utf8"), raw);

  const read = readVaultFile(vault, { path: "raw.md" });
  assert.equal(read.path, "raw.md");
  assert.match(read.numberedText, /\$HOME/);
  assert.match(read.numberedText, /\$\(echo hacked\)/);
  assert.match(read.numberedText, /`uname -a`/);

  const grep = grepVault(vault, { query: "$(whoami)" });
  assert.equal(grep.count, 1);
  assert.equal(grep.matches[0].text, "echo \"$HOME\" && echo $(whoami)");
});

test("core ranked search uses metadata fields and external cache", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { getSearchIndexStatus, searchVault, writeVaultFile } = await core();
    const { cachePaths, classifySearchManifestMismatch } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    writeVaultFile(vault, {
      path: "Projects/Alpha.md",
      content: `---
title: Alpha
tags:
  - project
  - alpha
aliases:
  - Project Alpha
---
# Rollout

The rollout is blocked by review.
`
    });
    writeVaultFile(vault, {
      path: "Archive/body.md",
      content: "This note only mentions project alpha in passing.\n"
    });

    const result = await searchVault(vault, { query: "project alpha", limit: 2 });
    assert.equal(result.command, "search");
    assert.equal(result.matches[0].path, "Projects/Alpha.md");
    assert.equal(result.matches[0].title, "Alpha");
    assert.deepEqual(result.matches[0].tags.sort(), ["alpha", "project"]);
    assert.deepEqual(Object.keys(result).sort(), ["command", "matches", "ok"]);
    assert.deepEqual(Object.keys(result.matches[0]).sort(), ["path", "snippets", "tags", "title"]);
    assert.match(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /Rollout|project|alpha/i);
    assert.doesNotMatch(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /title:|tags:|aliases:/i);
    const debugResult = await searchVault(vault, { query: "project alpha", limit: 1, debug: true });
    assert.deepEqual(Object.keys(debugResult).sort(), ["command", "debug", "matches", "ok"]);
    assert.deepEqual(debugResult.debug.query.terms, ["project", "alpha"]);
    assert.equal(debugResult.debug.reranker, "rrf-metadata-v2");
    assert.equal(debugResult.matches[0].debug.bucket, "exact");
    assert.deepEqual(debugResult.matches[0].debug.queryTerms, ["project", "alpha"]);
    assert.equal(typeof debugResult.matches[0].debug.oramaScore, "number");
    const analysisCache = JSON.parse(fs.readFileSync(cachePaths(vault).analysisPath, "utf8"));
    assert.equal(analysisCache.cacheVersion, 1);
    assert.equal(analysisCache.schemaVersion, undefined);
    assert.equal(analysisCache.analyzer.name, "router");
    assert.equal(analysisCache.analyzer.baseline, "intl-segmenter-latin-v2");
    assert.deepEqual(analysisCache.analyzer.activeAnalyzers, []);
    assert.ok(analysisCache.files["Projects/Alpha.md"].tokens.bodyTokens.length > 0);
    assert.ok(analysisCache.files["Projects/Alpha.md"].tokens.bodySurfaceTokens.length > 0);
    const manifest = JSON.parse(fs.readFileSync(cachePaths(vault).manifestPath, "utf8"));
    assert.equal(manifest.cacheVersion, 1);
    assert.equal(manifest.identitySchemaVersion, undefined);
    assert.equal(manifest.schemaVersion, undefined);
    assert.match(manifest.schemaDigest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.tokenizerTier, "intl");
    assert.deepEqual(manifest.declaredAnalyzers, []);
    assert.deepEqual(manifest.activeAnalyzers, []);
    assert.equal(manifest.nodeVersion, process.versions.node);
    assert.equal(manifest.icuVersion, process.versions.icu ?? null);
    assert.equal(classifySearchManifestMismatch(manifest, analysisCache.analyzer), "match");
    assert.equal(classifySearchManifestMismatch({}, analysisCache.analyzer), "incompatible");
    assert.equal(
      classifySearchManifestMismatch(manifest, { ...analysisCache.analyzer, activeAnalyzers: ["ko"] }),
      "tier-only-upgrade"
    );

    const scoped = await searchVault(vault, { query: "project alpha", path: "Projects", limit: 2 });
    assert.deepEqual(scoped.matches.map((match) => match.path), ["Projects/Alpha.md"]);

    const fieldFiltered = await searchVault(vault, { query: "review", fields: ["title"], limit: 2 });
    assert.equal(fieldFiltered.matches.length, 0);

    const tagFiltered = await searchVault(vault, { query: "project alpha", tags: ["project", "alpha"], limit: 2 });
    assert.deepEqual(tagFiltered.matches.map((match) => match.path), ["Projects/Alpha.md"]);

    const tagOnly = await searchVault(vault, { tags: ["project"], limit: 2 });
    assert.deepEqual(tagOnly.matches.map((match) => match.path), ["Projects/Alpha.md"]);

    writeVaultFile(vault, {
      path: "Projects/Beta.md",
      content: `---
tags: [project]
---
# Beta

Another project note.
`
    });
    await searchVault(vault, { query: "project", limit: 5 });
    const originalRead = fs.readFileSync;
    const noteReads = [];
    fs.readFileSync = function patchedRead(filePath, ...rest) {
      if (typeof filePath === "string" && filePath.endsWith(".md")) {
        noteReads.push(path.basename(filePath));
      }
      return originalRead.call(this, filePath, ...rest);
    };
    try {
      const limitedTagOnly = await searchVault(vault, { tags: ["project"], limit: 1 });
      assert.equal(limitedTagOnly.matches.length, 1);
      assert.deepEqual(noteReads.sort(), ["Alpha.md", "Beta.md"]);
    } finally {
      fs.readFileSync = originalRead;
    }

    const status = getSearchIndexStatus(vault);
    assert.equal(status.ready, true);

    await assert.rejects(() => searchVault(vault, { path: "Projects", limit: 2 }), /query=<text> or tag=<tag>/);
    await assert.rejects(() => searchVault(vault, { query: "review", fields: ["unknown"], limit: 2 }), /field must be one of/);
    await assert.rejects(() => searchVault(vault, { tags: ["project"], fields: ["title"], limit: 2 }), /field=<field> requires query=<text>/);
  });
});

test("core search uses analyzer tokens for CJK queries", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    writeVaultFile(vault, {
      path: "Notes/search-ja.md",
      content: "# メモ\n\n検索方式を改善する。\n"
    });
    const result = await searchVault(vault, { query: "検索", limit: 2 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/search-ja.md"]);
    assert.match(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /検索方式/);
  });
});

test("core search serves a valid Intl index during analyzer tier upgrades", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const { cachePaths, searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    writeVaultFile(vault, {
      path: "Notes/Stale.md",
      content: "# Stale Tier\n\nrésumés running studies\n"
    });

    await withProcessEnv({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, async () => {
      const result = await searchVault(vault, { query: "running", limit: 5 });
      assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Stale.md"]);
    });

    const manifestPath = cachePaths(vault).manifestPath;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.tokenizerTier, "intl");
    assert.deepEqual(manifest.declaredAnalyzers, ["ko"]);
    assert.deepEqual(manifest.activeAnalyzers, []);

    const targetAnalyzer = {
      identity: { ...manifest.analyzer, activeAnalyzers: ["ko"] },
      tokenize: async (text) => [`kiwi_${text}`],
      tokenizeBatch: async (texts) => texts.map((text) => [`kiwi_${text}`])
    };
    const reconcileRequests = [];

    const stale = await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, targetAnalyzer, (root, analyzer, reason) => {
      reconcileRequests.push({ root, identity: analyzer.identity, reason });
    });

    assert.deepEqual(stale.matches.map((match) => match.path), ["Notes/Stale.md"]);
    assert.deepEqual(stale.warnings, ["fts_index_stale_tier"]);
    assert.equal(reconcileRequests.length, 1);
    assert.equal(reconcileRequests[0].root, vault);
    assert.equal(reconcileRequests[0].reason, "stale-tier");
    assert.deepEqual(reconcileRequests[0].identity.activeAnalyzers, ["ko"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), manifest);
  });
});

test("core search waits for a ready target analyzer projection", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { writeVaultFile } = await core();
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    writeVaultFile(vault, {
      path: "Notes/Kiwi.md",
      content: "# Kiwi\n\nload-me marker\n"
    });

    const identity = {
      name: "custom-kiwi",
      version: "1",
      runtime: "test",
      node: process.versions.node,
      declaredAnalyzers: ["ko"],
      activeAnalyzers: ["ko"]
    };
    const tokenizeKiwi = (text) => (text.toLowerCase().match(/[a-z0-9-]+/g) ?? []).map((token) => `kiwi:${token}`);
    const tokenizeFallback = (text) => (text.toLowerCase().match(/[a-z0-9-]+/g) ?? []).map((token) => `fallback:${token}`);
    const loadedAnalyzer = {
      identity,
      tokenize: async (text) => tokenizeKiwi(text),
      tokenizeBatch: async (texts) => texts.map((text) => tokenizeKiwi(text))
    };
    const built = await searchVaultWithAnalyzer(vault, { query: "load-me", limit: 5 }, loadedAnalyzer);
    assert.deepEqual(built.matches.map((match) => match.path), ["Notes/Kiwi.md"]);

    const leaseOptions = [];
    const analyzerWithLease = {
      identity,
      withLease: async (run, options = {}) => {
        leaseOptions.push(options);
        const analyzer = options.wait === true
          ? loadedAnalyzer
          : {
              identity,
              tokenize: async (text) => tokenizeFallback(text),
              tokenizeBatch: async (texts) => texts.map((text) => tokenizeFallback(text))
            };
        return run(analyzer);
      },
      tokenize: async (text) => tokenizeFallback(text),
      tokenizeBatch: async (texts) => texts.map((text) => tokenizeFallback(text))
    };

    const result = await searchVaultWithAnalyzer(vault, { query: "load-me", limit: 5 }, analyzerWithLease);
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Kiwi.md"]);
    assert.equal(result.warnings, undefined);
    assert.equal(leaseOptions.length, 1);
    assert.deepEqual(leaseOptions[0], { wait: true, installIfMissing: true, loadTimeoutMs: 5000 });
  });
});

test("core search coalesces background reconcile requests until the child exits", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const { __setSearchReconcileChildSpawnerForTests, cachePaths, searchVaultWithAnalyzer } = await import(
      path.join(repoRoot, "src/core/search/index.ts")
    );
    writeVaultFile(vault, {
      path: "Notes/Coalesce.md",
      content: "# Coalesce\n\nrunning studies\n"
    });

    await withProcessEnv({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, async () => {
      const result = await searchVault(vault, { query: "running", limit: 5 });
      assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Coalesce.md"]);
    });

    const manifest = JSON.parse(fs.readFileSync(cachePaths(vault).manifestPath, "utf8"));
    const targetAnalyzer = {
      identity: { ...manifest.analyzer, activeAnalyzers: ["ko"] },
      tokenize: async (text) => [`kiwi_${text}`],
      tokenizeBatch: async (texts) => texts.map((text) => [`kiwi_${text}`])
    };
    const children = [];
    const spawns = [];

    __setSearchReconcileChildSpawnerForTests((bin, args) => {
      const handlers = new Map();
      const child = {
        once(event, handler) {
          handlers.set(event, handler);
          return child;
        },
        unref() {},
        emit(event) {
          handlers.get(event)?.();
        }
      };
      spawns.push({ bin, args });
      children.push(child);
      return child;
    });
    try {
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, targetAnalyzer);
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, targetAnalyzer);
      assert.equal(spawns.length, 1);
      assert.deepEqual(spawns[0].args, ["__search-reconcile", vault, "reason=stale-tier"]);

      children[0].emit("close");
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, targetAnalyzer);
      assert.equal(spawns.length, 2);
    } finally {
      __setSearchReconcileChildSpawnerForTests(undefined);
    }
  });
});

test("core reconcile uses a cross-process lock and recovers stale locks", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const {
      __setSearchReconcileLockStaleMsForTests,
      cachePaths,
      getSearchIndexStatus,
      reconcileSearchIndex,
      searchReconcileLockPath,
      searchReconcileStatusPath
    } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    writeVaultFile(vault, {
      path: "Notes/Locked.md",
      content: "# Locked\n\nalpha\n"
    });
    await searchVault(vault, { query: "alpha", limit: 5 });

    const manifestPath = cachePaths(vault).manifestPath;
    const before = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    writeVaultFile(vault, {
      path: "Notes/Locked.md",
      content: "# Locked\n\nalpha beta expanded\n",
      overwrite: true
    });

    const lockDir = searchReconcileLockPath(vault);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), '{"pid":12345,"startedAt":"2026-06-21T00:00:00.000Z","reason":"stale-tier"}\n');
    assert.deepEqual(getSearchIndexStatus(vault).reconcile, {
      active: true,
      stale: false,
      reason: "stale-tier",
      startedAt: "2026-06-21T00:00:00.000Z",
      pid: 12345
    });
    try {
      await reconcileSearchIndex(vault, "stale-tier");
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
    const skipped = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(skipped, before);

    await reconcileSearchIndex(vault, "stale-tier");
    const rebuilt = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(rebuilt.files["Notes/Locked.md"].size, fs.statSync(path.join(vault, "Notes/Locked.md")).size);
    assert.notEqual(rebuilt.files["Notes/Locked.md"].size, before.files["Notes/Locked.md"].size);

    writeVaultFile(vault, {
      path: "Notes/Locked.md",
      content: "# Locked\n\nalpha beta gamma expanded through stale lock\n",
      overwrite: true
    });
    fs.mkdirSync(lockDir, { recursive: true });
    const staleAt = new Date(Date.now() - 10_000);
    fs.utimesSync(lockDir, staleAt, staleAt);
    __setSearchReconcileLockStaleMsForTests(1);
    assert.deepEqual(getSearchIndexStatus(vault).reconcile, {
      active: true,
      stale: true
    });
    try {
      await reconcileSearchIndex(vault, "stale-tier");
    } finally {
      __setSearchReconcileLockStaleMsForTests(undefined);
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
    const staleRecovered = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(staleRecovered.files["Notes/Locked.md"].size, fs.statSync(path.join(vault, "Notes/Locked.md")).size);

    const statusPath = searchReconcileStatusPath(vault);
    const successStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.equal(successStatus.schemaVersion, 1);
    assert.equal(successStatus.lastRun.state, "success");
    assert.equal(successStatus.lastRun.reason, "stale-tier");
    assert.equal(successStatus.lastSuccess.state, "success");
    assert.equal(successStatus.lastFailure, undefined);
    assert.equal(getSearchIndexStatus(vault).reconcileStatus.lastRun.state, "success");

    const paths = cachePaths(vault);
    fs.rmSync(paths.indexPath, { recursive: true, force: true });
    fs.mkdirSync(paths.indexPath);
    await assert.rejects(() => reconcileSearchIndex(vault, "manual"));
    const failureStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.equal(failureStatus.schemaVersion, 1);
    assert.equal(failureStatus.recentRuns, undefined);
    assert.equal(failureStatus.lastRun.state, "failure");
    assert.equal(failureStatus.lastRun.reason, "manual");
    assert.ok(failureStatus.lastRun.error.length <= 2048);
    assert.equal(failureStatus.lastFailure.state, "failure");
    assert.deepEqual(failureStatus.lastSuccess, successStatus.lastSuccess);
    assert.equal(getSearchIndexStatus(vault).reconcileStatus.lastFailure.state, "failure");
  });
});

test("core reconcile refreshes search index incrementally", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const { cachePaths, reconcileSearchIndex } = await import(path.join(repoRoot, "src/core/search/index.ts"));

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\n\nalpha original\n" });
    writeVaultFile(vault, { path: "Notes/Beta.md", content: "# Beta\n\nbeta stable\n" });
    let result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\n\nalpha changed\n", overwrite: true });
    const paths = cachePaths(vault);
    const betaPath = path.join(vault, "Notes", "Beta.md");
    fs.writeFileSync(betaPath, Buffer.from([0xc3, 0x28, 0x20, 0x62, 0x65, 0x74, 0x61]));
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    const betaStat = fs.statSync(betaPath);
    manifest.files["Notes/Beta.md"] = { mtimeMs: betaStat.mtimeMs, size: betaStat.size };
    fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    recommitSearchIndexPair(paths);

    await reconcileSearchIndex(vault, "manual");
    result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);
  });
});

test("core warm refreshes search index incrementally", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, warmSearchIndexes, writeVaultFile } = await core();
    const { cachePaths } = await import(path.join(repoRoot, "src/core/search/index.ts"));

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\n\nalpha original\n" });
    writeVaultFile(vault, { path: "Notes/Beta.md", content: "# Beta\n\nbeta stable\n" });
    let result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\n\nalpha changed\n", overwrite: true });
    const paths = cachePaths(vault);
    const betaPath = path.join(vault, "Notes", "Beta.md");
    fs.writeFileSync(betaPath, Buffer.from([0xc3, 0x28, 0x20, 0x62, 0x65, 0x74, 0x61]));
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    const betaStat = fs.statSync(betaPath);
    manifest.files["Notes/Beta.md"] = { mtimeMs: betaStat.mtimeMs, size: betaStat.size };
    fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    recommitSearchIndexPair(paths);

    const warm = await warmSearchIndexes([vault]);
    assert.deepEqual(warm.vaults.map((entry) => entry.status), ["ready"]);
    result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);
  });
});

test("core warm preserves input order with concurrency", async () => {
  const firstVault = tempVault();
  const secondVault = tempVault();
  const missingVault = path.join(os.tmpdir(), "optsidian-missing-" + Date.now());
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { warmSearchIndexes, writeVaultFile } = await core();
    writeVaultFile(firstVault, { path: "one.md", content: "# One\n\nalpha\n" });
    writeVaultFile(secondVault, { path: "two.md", content: "# Two\n\nbeta\n" });

    const warm = await warmSearchIndexes([missingVault, firstVault, secondVault], [], { concurrency: 2 });
    assert.deepEqual(warm.vaults.map((entry) => entry.vaultRoot), [
      path.resolve(missingVault),
      fs.realpathSync(firstVault),
      fs.realpathSync(secondVault)
    ]);
    assert.deepEqual(warm.vaults.map((entry) => entry.status), ["failed", "ready", "ready"]);
  });
});

test("core search index writer lock protects reads and recovers stale locks", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const {
      __setSearchIndexWriterLockStaleMsForTests,
      __setSearchIndexWriterLockWaitMsForTests,
      cachePaths,
      searchIndexWriterLockPath
    } = await import(path.join(repoRoot, "src/core/search/index.ts"));

    writeVaultFile(vault, {
      path: "Notes/Writer.md",
      content: "# Writer\n\nalpha\n"
    });
    await searchVault(vault, { query: "alpha", limit: 5 });

    const lockDir = searchIndexWriterLockPath(vault);
    fs.mkdirSync(lockDir, { recursive: true });
    __setSearchIndexWriterLockWaitMsForTests(1);
    try {
      const served = await searchVault(vault, { query: "alpha", limit: 5 });
      assert.deepEqual(served.matches.map((match) => match.path), ["Notes/Writer.md"]);
    } finally {
      __setSearchIndexWriterLockWaitMsForTests(undefined);
      fs.rmSync(lockDir, { recursive: true, force: true });
    }

    writeVaultFile(vault, {
      path: "Notes/Writer.md",
      content: "# Writer\n\nalpha beta\n",
      overwrite: true
    });
    fs.mkdirSync(lockDir, { recursive: true });
    const staleAt = new Date(Date.now() - 10_000);
    fs.utimesSync(lockDir, staleAt, staleAt);
    __setSearchIndexWriterLockStaleMsForTests(1);
    try {
      const result = await searchVault(vault, { query: "beta", limit: 5 });
      assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Writer.md"]);
    } finally {
      __setSearchIndexWriterLockStaleMsForTests(undefined);
      fs.rmSync(lockDir, { recursive: true, force: true });
    }

    const manifest = JSON.parse(fs.readFileSync(cachePaths(vault).manifestPath, "utf8"));
    assert.notEqual(manifest.files["Notes/Writer.md"].size, fs.statSync(path.join(vault, "Notes/Writer.md")).size);
  });
});

test("core search requires a committed index pair while a writer is active", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { rebuildSearchIndex, searchVault, writeVaultFile } = await core();
    const { cachePaths, searchIndexWriterLockPath } = await import(path.join(repoRoot, "src/core/search/index.ts"));

    writeVaultFile(vault, {
      path: "Notes/Commit.md",
      content: "# Commit\n\nalpha\n"
    });
    await searchVault(vault, { query: "alpha", limit: 5 });

    const paths = cachePaths(vault);
    const oldManifestRaw = fs.readFileSync(paths.manifestPath, "utf8");
    writeVaultFile(vault, {
      path: "Notes/Commit.md",
      content: "# Commit\n\nalpha beta expanded\n",
      overwrite: true
    });
    await rebuildSearchIndex(vault);
    fs.writeFileSync(paths.manifestPath, oldManifestRaw);

    const lockDir = searchIndexWriterLockPath(vault);
    fs.mkdirSync(lockDir, { recursive: true });
    try {
      const result = await searchVault(vault, { query: "beta", limit: 5 });
      assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Commit.md"]);
      assert.ok(result.warnings?.includes("fts_index_building"));
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

test("core search rebuilds an uncommitted persisted index pair after a torn write", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { rebuildSearchIndex, searchVault, writeVaultFile } = await core();
    const { cachePaths } = await import(path.join(repoRoot, "src/core/search/index.ts"));

    writeVaultFile(vault, {
      path: "Notes/Torn.md",
      content: "# Torn\n\nalpha\n"
    });
    await searchVault(vault, { query: "alpha", limit: 5 });

    const paths = cachePaths(vault);
    const oldManifestRaw = fs.readFileSync(paths.manifestPath, "utf8");
    writeVaultFile(vault, {
      path: "Notes/Torn.md",
      content: "# Torn\n\nalpha beta repaired\n",
      overwrite: true
    });
    await rebuildSearchIndex(vault);
    fs.writeFileSync(paths.manifestPath, oldManifestRaw);

    const result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Torn.md"]);
    const repairedManifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    assert.equal(repairedManifest.files["Notes/Torn.md"].size, fs.statSync(path.join(vault, "Notes", "Torn.md")).size);
  });
});

test("core search degrades terminal analyzer load failures to Intl", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { writeVaultFile } = await core();
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    const { resolveSearchAnalyzer, SearchAnalyzerTerminalLoadError } = await import(path.join(repoRoot, "src/core/search/analyzer.ts"));
    writeVaultFile(vault, {
      path: "Notes/Degraded.md",
      content: "# Degraded Analyzer\n\n한국어 검색 fallback marker\n"
    });

    const intlAnalyzer = resolveSearchAnalyzer({}, {});
    const degradedIdentity = { ...intlAnalyzer.identity, declaredAnalyzers: ["ko"], activeAnalyzers: [] };
    let fallbackLeases = 0;
    const degradedAnalyzer = {
      identity: degradedIdentity,
      withLease: async (run) => {
        fallbackLeases += 1;
        return run(intlAnalyzer);
      },
      tokenize: (text) => intlAnalyzer.tokenize(text),
      tokenizeBatch: (texts) => intlAnalyzer.tokenizeBatch(texts)
    };
    const terminalAnalyzer = {
      identity: { ...degradedIdentity, activeAnalyzers: ["ko"] },
      degradedAnalyzer,
      isTerminalLoadError: (error) => error instanceof SearchAnalyzerTerminalLoadError,
      withLease: async () => {
        throw new SearchAnalyzerTerminalLoadError("simulated analyzer load failure");
      },
      tokenize: async (text) => [`kiwi_${text}`],
      tokenizeBatch: async (texts) => texts.map((text) => [`kiwi_${text}`])
    };
    const reconcileRequests = [];

    const result = await searchVaultWithAnalyzer(vault, { query: "한국어 검색", limit: 5 }, terminalAnalyzer, (root, analyzer, reason) => {
      reconcileRequests.push({ root, identity: analyzer.identity, reason });
    });

    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Degraded.md"]);
    assert.equal(result.warnings, undefined);
    assert.equal(reconcileRequests.length, 1);
    assert.equal(reconcileRequests[0].root, vault);
    assert.equal(reconcileRequests[0].reason, "terminal-analyzer-failure");
    assert.deepEqual(reconcileRequests[0].identity.activeAnalyzers, []);
    assert.equal(fallbackLeases, 1);
  });
});

test("core search isolates terminal analyzer degrade observer failures", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { writeVaultFile } = await core();
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    const { resolveSearchAnalyzer, SearchAnalyzerTerminalLoadError } = await import(path.join(repoRoot, "src/core/search/analyzer.ts"));
    writeVaultFile(vault, {
      path: "Notes/Observer.md",
      content: "# Observer Failure\n\n한국어 검색 observer fallback\n"
    });

    const intlAnalyzer = resolveSearchAnalyzer({}, {});
    const degradedAnalyzer = {
      identity: { ...intlAnalyzer.identity, declaredAnalyzers: ["ko"], activeAnalyzers: [] },
      tokenize: (text) => intlAnalyzer.tokenize(text),
      tokenizeBatch: (texts) => intlAnalyzer.tokenizeBatch(texts)
    };
    const terminalAnalyzer = {
      identity: { ...degradedAnalyzer.identity, activeAnalyzers: ["ko"] },
      degradedAnalyzer,
      isTerminalLoadError: (error) => error instanceof SearchAnalyzerTerminalLoadError,
      withLease: async () => {
        throw new SearchAnalyzerTerminalLoadError("simulated analyzer load failure");
      },
      tokenize: async (text) => [`kiwi_${text}`],
      tokenizeBatch: async (texts) => texts.map((text) => [`kiwi_${text}`])
    };
    let observerCalls = 0;

    const result = await searchVaultWithAnalyzer(vault, { query: "한국어 검색", limit: 5 }, terminalAnalyzer, () => {
      observerCalls += 1;
      throw new Error("observer failure must be isolated");
    });

    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Observer.md"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observerCalls, 1);
  });
});

test("core search overlays file changes across add change rename delete and parse failure", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { getSearchIndexStatus, searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\nproject alpha\n" });
    let result = await searchVault(vault, { query: "alpha", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Alpha.md"]);

    writeVaultFile(vault, { path: "Notes/Beta.md", content: "# Beta\nproject beta\n" });
    result = await searchVault(vault, { query: "beta", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);

    writeVaultFile(vault, { path: "Notes/Beta.md", content: "# Gamma\nproject gamma\n", overwrite: true });
    result = await searchVault(vault, { query: "gamma", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Beta.md"]);

    fs.renameSync(path.join(vault, "Notes", "Beta.md"), path.join(vault, "Notes", "Renamed.md"));
    result = await searchVault(vault, { query: "gamma", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Renamed.md"]);

    fs.rmSync(path.join(vault, "Notes", "Renamed.md"));
    result = await searchVault(vault, { query: "gamma", limit: 5 });
    assert.equal(result.matches.length, 0);

    fs.writeFileSync(path.join(vault, "Notes", "Alpha.md"), Buffer.from([0xc3, 0x28]));
    result = await searchVault(vault, { query: "alpha", limit: 5 });
    assert.equal(result.matches.length, 0);
    result = await searchVault(vault, { query: "alpha", limit: 5 });
    assert.equal(result.matches.length, 0);

    assert.equal(getSearchIndexStatus(vault).ready, true);
  });
});

test("core search reports a stale manifest when file diff is too large for overlay", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\nproject alpha\n" });
    let result = await searchVault(vault, { query: "alpha", limit: 5 });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Alpha.md"]);

    writeVaultFile(vault, { path: "Notes/Beta.md", content: "# Beta\nproject beta\n" });
    result = await withProcessEnv({ OPTSIDIAN_SEARCH_OVERLAY_MAX_FILES: "0" }, () =>
      searchVault(vault, { query: "beta", limit: 5 })
    );
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.warnings, ["fts_index_stale_manifest"]);
  });
});

test("core search retries a small overlay when analyzer tokenization fails once", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { writeVaultFile } = await core();
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search/index.ts"));
    const { resolveSearchAnalyzer } = await import(path.join(repoRoot, "src/core/search/analyzer.ts"));
    const analyzer = resolveSearchAnalyzer({}, {});

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Alpha\nproject alpha\n" });
    let result = await searchVaultWithAnalyzer(vault, { query: "alpha", limit: 5 }, analyzer);
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Alpha.md"]);

    let failNextBatch = true;
    const flakyAnalyzer = {
      ...analyzer,
      tokenizeBatch: async (texts) => {
        if (failNextBatch) {
          failNextBatch = false;
          throw new Error("simulated incremental analyzer failure");
        }
        return analyzer.tokenizeBatch(texts);
      }
    };

    writeVaultFile(vault, { path: "Notes/Alpha.md", content: "# Beta\nproject beta\n", overwrite: true });
    result = await searchVaultWithAnalyzer(vault, { query: "beta", limit: 5 }, flakyAnalyzer);
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/Alpha.md"]);
    assert.equal(failNextBatch, false);
  });
});

test("core reranking favors note identity over body-only mentions and respects field scope", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, {
      path: "Notes/Project Alpha.md",
      content: `---
title: Project Alpha
aliases:
  - Launch Alpha
---
Minimal body.
`
    });
    writeVaultFile(vault, {
      path: "Notes/Body Mention.md",
      content: "project alpha appears repeatedly in the body.\nproject alpha appears repeatedly in the body.\n"
    });
    writeVaultFile(vault, {
      path: "Reference/Alpha Checklist.md",
      content: "# Reference\nMinimal body.\n"
    });
    writeVaultFile(vault, {
      path: "Notes/Checklist Body.md",
      content: "alpha checklist appears repeatedly in the body.\nalpha checklist appears repeatedly in the body.\n"
    });
    writeVaultFile(vault, {
      path: "Roadmap/Plan.md",
      content: "# Plan\nMinimal body.\n"
    });
    writeVaultFile(vault, {
      path: "Notes/Roadmap Body.md",
      content: "roadmap roadmap roadmap roadmap\n"
    });

    let result = await searchVault(vault, { query: "project alpha", limit: 3 });
    assert.equal(result.matches[0].path, "Notes/Project Alpha.md");

    result = await searchVault(vault, { query: "launch alpha", limit: 3 });
    assert.equal(result.matches[0].path, "Notes/Project Alpha.md");

    result = await searchVault(vault, { query: "alpha checklist", limit: 3 });
    assert.equal(result.matches[0].path, "Reference/Alpha Checklist.md");

    result = await searchVault(vault, { query: "roadmap", limit: 3 });
    assert.equal(result.matches[0].path, "Notes/Roadmap Body.md");

    result = await searchVault(vault, { query: "roadmap", fields: ["body"], limit: 3 });
    assert.equal(result.matches[0].path, "Notes/Roadmap Body.md");
  });
});

test("core search expands compound metadata and uses cautious ranking fallbacks", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, {
      path: "Research/HumanoidMotionTracking.md",
      content: `---
keywords:
  - Motion Policy
---
# Controller

Tracking policy notes.
`
    });
    writeVaultFile(vault, {
      path: "Notes/Body Mention.md",
      content: "motion tracking appears repeatedly in body.\nmotion tracking appears repeatedly in body.\n"
    });
    writeVaultFile(vault, {
      path: "Bodies/Near.md",
      content: "alpha zettelkasten\n"
    });
    writeVaultFile(vault, {
      path: "Bodies/Far.md",
      content: "alpha filler filler filler filler filler zettelkasten\n"
    });

    let result = await searchVault(vault, { query: "motion tracking", limit: 3 });
    assert.equal(result.matches[0].path, "Research/HumanoidMotionTracking.md");

    result = await searchVault(vault, { query: "HumanoidMotionTracking", limit: 3, debug: true });
    assert.equal(result.matches[0].path, "Research/HumanoidMotionTracking.md");
    assert.equal(result.matches[0].debug.bucket, "exact");

    result = await searchVault(vault, { query: "motion policy", limit: 3 });
    assert.equal(result.matches[0].path, "Research/HumanoidMotionTracking.md");

    result = await searchVault(vault, { query: "alpha zettelkasten", fields: ["body"], limit: 3 });
    assert.equal(result.matches[0].path, "Bodies/Near.md");

    result = await searchVault(vault, { query: "trackng", limit: 3 });
    assert.equal(result.matches[0].path, "Research/HumanoidMotionTracking.md");
  });
});

test("core search uses Korean ngram channel for attached forms", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, {
      path: "Notes/search-ko.md",
      content: "# 기록\n\n한국어 검색하면서 발견한 내용을 정리한다.\n"
    });

    const result = await searchVault(vault, { query: "검색", limit: 5, debug: true });
    assert.deepEqual(result.matches.map((match) => match.path), ["Notes/search-ko.md"]);
    assert.match(result.matches[0].snippets.map((snippet) => snippet.text).join("\n"), /검색하면서/);
    assert.ok(result.debug?.query?.channels?.ngram?.includes("검색"));
    assert.ok(result.matches[0].debug?.matchedChannels?.includes("ngram"));

    const attachedQuery = await searchVault(vault, { query: "한국어검색", limit: 5 });
    assert.deepEqual(attachedQuery.matches.map((match) => match.path), ["Notes/search-ko.md"]);
  });
});

test("core reranking treats compact Korean queries as spaced metadata identity", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, {
      path: "Notes/Korean Metadata.md",
      content: "# 정책 학습\n\nMetadata title should rank above body-only ngram hits.\n"
    });
    writeVaultFile(vault, {
      path: "Notes/Korean Body.md",
      content: "정책 학습 내용이 본문에서 반복된다.\n정책 학습 내용이 본문에서 반복된다.\n"
    });

    const result = await searchVault(vault, { query: "정책학습", limit: 3, debug: true });
    assert.equal(result.matches[0].path, "Notes/Korean Metadata.md");
    assert.equal(result.matches[0].debug.bucket, "exact");
    assert.equal(result.matches[0].debug.exactPriority, 0);
    assert.ok(result.matches[0].debug.matchedChannels?.includes("ngram"));
  });
});

test("core reranking uses ngram metadata coverage for compact Korean queries", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();

    writeVaultFile(vault, {
      path: "Notes/Korean Metadata.md",
      content: "# 정책과 학습\n\nMetadata title should rank above body-only ngram hits.\n"
    });
    writeVaultFile(vault, {
      path: "Notes/Korean Body.md",
      content: "정책 학습 내용이 본문에서 반복된다.\n정책 학습 내용이 본문에서 반복된다.\n"
    });

    const result = await searchVault(vault, { query: "정책학습", limit: 3, debug: true });
    assert.equal(result.matches[0].path, "Notes/Korean Metadata.md");
    assert.equal(result.matches[0].debug.bucket, "coverage");
    assert.ok(result.matches[0].debug.coverageTerms > 0);
    assert.ok(result.matches[0].debug.matchedChannels?.includes("ngram"));
  });
});

test("core frontmatter reads and mutates structured YAML while preserving body", async () => {
  const vault = tempVault();
  const {
    addFrontmatterValue,
    deleteFrontmatter,
    readFrontmatter,
    removeFrontmatterValue,
    setFrontmatter
  } = await core();
  fs.writeFileSync(
    path.join(vault, "note.md"),
    "\uFEFF---\r\nstatus: draft\r\ntags:\r\n  - project\r\n---\r\n# Title\r\nBody\r\n"
  );

  let read = readFrontmatter(vault, { path: "note.md" });
  assert.equal(read.hasFrontmatter, true);
  assert.equal(read.frontmatter.status, "draft");
  assert.deepEqual(read.frontmatter.tags, ["project"]);

  const set = setFrontmatter(vault, { path: "note.md", key: "priority", value: 3 });
  assert.equal(set.command, "frontmatter");
  let content = fs.readFileSync(path.join(vault, "note.md"), "utf8");
  assert.ok(content.startsWith("\uFEFF---\r\n"));
  assert.match(content, /priority: 3\r\n/);
  assert.ok(content.endsWith("# Title\r\nBody\r\n"));

  addFrontmatterValue(vault, { path: "note.md", key: "tags", value: "alpha" });
  const duplicate = addFrontmatterValue(vault, { path: "note.md", key: "tags", value: "alpha" });
  assert.equal(duplicate.changes.length, 0);
  removeFrontmatterValue(vault, { path: "note.md", key: "tags", value: "project" });
  deleteFrontmatter(vault, { path: "note.md", key: "priority" });

  read = readFrontmatter(vault, { path: "note.md" });
  assert.deepEqual(read.frontmatter.tags, ["alpha"]);
  assert.equal(read.frontmatter.priority, undefined);
});

test("core frontmatter creates blocks and rejects unsafe YAML shapes", async () => {
  const vault = tempVault();
  const { addFrontmatterValue, readFrontmatter, setFrontmatter } = await core();
  fs.writeFileSync(path.join(vault, "plain.md"), "# Plain\n");

  setFrontmatter(vault, { path: "plain.md", key: "status", value: "active", dryRun: true });
  assert.equal(fs.readFileSync(path.join(vault, "plain.md"), "utf8"), "# Plain\n");
  setFrontmatter(vault, { path: "plain.md", key: "status", value: "active" });
  assert.equal(fs.readFileSync(path.join(vault, "plain.md"), "utf8"), "---\nstatus: active\n---\n# Plain\n");
  assert.deepEqual(readFrontmatter(vault, { path: "plain.md" }).frontmatter, { status: "active" });

  fs.writeFileSync(path.join(vault, "duplicate.md"), "---\na: 1\na: 2\n---\nBody\n");
  assert.throws(() => setFrontmatter(vault, { path: "duplicate.md", key: "b", value: true }), /Map keys must be unique/);

  fs.writeFileSync(path.join(vault, "list-root.md"), "---\n- a\n---\nBody\n");
  assert.throws(() => setFrontmatter(vault, { path: "list-root.md", key: "b", value: true }), /YAML mapping/);

  fs.writeFileSync(path.join(vault, "scalar-list.md"), "---\ntags: project\n---\nBody\n");
  assert.throws(() => addFrontmatterValue(vault, { path: "scalar-list.md", key: "tags", value: "alpha" }), /not a list/);

  fs.writeFileSync(path.join(vault, "note.txt"), "status: active\n");
  assert.throws(() => readFrontmatter(vault, { path: "note.txt" }), /Markdown files/);
});

test("core edit treats replacement and selectors as literal data", async () => {
  const vault = tempVault();
  const { editVaultFile, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "note.md", content: "alpha $HOME\nbeta\n" });

  const edit = editVaultFile(vault, {
    path: "note.md",
    selector: { kind: "replace", value: "alpha $HOME" },
    replacement: "literal $(date) and `id`"
  });

  assert.equal(edit.command, "edit");
  assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "literal $(date) and `id`\nbeta\n");
});

test("core apply_patch accepts raw patch text without shell staging", async () => {
  const vault = tempVault();
  const { applyVaultPatch } = await core();
  const patch = `*** Begin Patch
*** Add File: patch.md
+# Raw payload
+$HOME
+$(whoami)
+\`pwd\`
+\`\`\`ts
+const value = "$HOME";
+\`\`\`
*** End Patch
`;

  const result = applyVaultPatch(vault, { patch });
  assert.equal(result.command, "apply_patch");
  assert.deepEqual(result.changes.map((change) => [change.code, change.path]), [["A", "patch.md"]]);
  assert.equal(
    fs.readFileSync(path.join(vault, "patch.md"), "utf8"),
    "# Raw payload\n$HOME\n$(whoami)\n`pwd`\n```ts\nconst value = \"$HOME\";\n```\n"
  );
});

test("core validates adapter-independent numeric parameters", async () => {
  const vault = tempVault();
  const { editVaultFile, grepVault, readVaultFile, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "note.md", content: "one\ntwo\n" });

  assert.throws(() => readVaultFile(vault, { path: "note.md", head: 0 }), /head must be a positive integer/);
  assert.throws(() => readVaultFile(vault, { path: "note.md", lines: { start: 3, end: 2 } }), /lines\.end must be >= lines\.start/);
  assert.throws(() => grepVault(vault, { query: "one", context: -1 }), /context must be a non-negative integer/);
  assert.throws(
    () => editVaultFile(vault, { path: "note.md", selector: { kind: "range", value: { start: 2, end: 1 } }, replacement: "x" }),
    /range\.end must be >= range\.start/
  );
});

test("core copy reports overwrite as modification", async () => {
  const vault = tempVault();
  const { copyVaultPath, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "source.md", content: "new\n" });
  writeVaultFile(vault, { path: "dest.md", content: "old\n" });

  const result = copyVaultPath(vault, { from: "source.md", to: "dest.md", overwrite: true });
  assert.equal(result.changes[0].code, "M");
  assert.equal(fs.readFileSync(path.join(vault, "dest.md"), "utf8"), "new\n");
});

test("core apply_patch refuses unsafe overwrites", async () => {
  const vault = tempVault();
  const { applyVaultPatch, writeVaultFile } = await core();
  writeVaultFile(vault, { path: "existing.md", content: "old\n" });
  writeVaultFile(vault, { path: "source.md", content: "source\n" });
  writeVaultFile(vault, { path: "target.md", content: "target\n" });

  assert.throws(
    () => applyVaultPatch(vault, { patch: "*** Begin Patch\n*** Add File: existing.md\n+new\n*** End Patch\n" }),
    /Refusing to add existing file/
  );
  assert.equal(fs.readFileSync(path.join(vault, "existing.md"), "utf8"), "old\n");

  const moveOverExisting = `*** Begin Patch
*** Update File: source.md
*** Move to: target.md
@@
-source
+moved
*** End Patch
`;
  assert.throws(() => applyVaultPatch(vault, { patch: moveOverExisting }), /Refusing to move over existing file/);
  assert.equal(fs.readFileSync(path.join(vault, "source.md"), "utf8"), "source\n");
  assert.equal(fs.readFileSync(path.join(vault, "target.md"), "utf8"), "target\n");
});
