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

function searchDocument(overrides = {}) {
  return {
    id: overrides.path ?? "note.md",
    path: overrides.path ?? "note.md",
    title: overrides.title ?? "Test Note",
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    headings: overrides.headings ?? [],
    body: overrides.body ?? "",
    pathTokens: "",
    titleTokens: "",
    aliasesTokens: "",
    tagsTokens: "",
    headingsTokens: "",
    bodyTokens: "",
    pathSurfaceTokens: "",
    titleSurfaceTokens: "",
    aliasesSurfaceTokens: "",
    tagsSurfaceTokens: "",
    headingsSurfaceTokens: "",
    bodySurfaceTokens: "",
    pathNgramTokens: "",
    titleNgramTokens: "",
    aliasesNgramTokens: "",
    tagsNgramTokens: "",
    headingsNgramTokens: "",
    bodyNgramTokens: "",
    ...overrides
  };
}

async function core() {
  return import(path.join(repoRoot, "src/core/index.ts"));
}

test("settings helpers normalize supported config keys and apply local overrides", async () => {
  const {
    configPathResult,
    getConfigValue,
    readOptsidianSettings,
    setConfigValue,
    unsetConfigValue
  } = await import(path.join(repoRoot, "src/core/settings.ts"));
  const project = tempVault();
  const env = { XDG_CONFIG_HOME: path.join(project, "config") };
  const globalSettings = path.join(env.XDG_CONFIG_HOME, "optsidian", "settings.json");

  assert.equal(configPathResult(project, env).path, globalSettings);

  const cases = [
    ["search.analyzer", "kiwi", "kiwi"],
    ["search.extraLangs", "ko, KO", ["ko"]],
    ["search.queryWorkers", "2", 2],
    ["search.indexWorkers", "2", 2],
    ["search.snapshotRetentionCount", "3", 3],
    ["search.queryCacheSize", "0", 0],
    ["search.memoryBudgetCount", "4", 4],
    ["search.memoryBudgetBytes", "1048576", 1048576],
    ["search.daemonIdleMs", "0", 0]
  ];

  for (const [key, raw, expected] of cases) {
    const result = setConfigValue(project, key, raw, env);
    assert.equal(result.path, globalSettings);
    assert.deepEqual(result.value, expected);
    assert.deepEqual(getConfigValue(project, key, env).value, expected);
  }

  const expectedGlobalSearch = {
    analyzer: "kiwi",
    extraLangs: ["ko"],
    queryWorkers: 2,
    indexWorkers: 2,
    snapshotRetentionCount: 3,
    queryCacheSize: 0,
    memoryBudgetCount: 4,
    memoryBudgetBytes: 1048576,
    daemonIdleMs: 0
  };
  assert.deepEqual(readOptsidianSettings(project, env), { search: expectedGlobalSearch });

  const localSettings = path.join(project, ".optsidian", "settings.json");
  fs.mkdirSync(path.dirname(localSettings), { recursive: true });
  fs.writeFileSync(localSettings, '{\n  "search": {\n    "analyzer": "intl",\n    "queryWorkers": 5\n  }\n}\n');

  assert.deepEqual(readOptsidianSettings(project, env).search, {
    analyzer: "intl",
    extraLangs: ["ko"],
    queryWorkers: 5,
    indexWorkers: 2,
    snapshotRetentionCount: 3,
    queryCacheSize: 0,
    memoryBudgetCount: 4,
    memoryBudgetBytes: 1048576,
    daemonIdleMs: 0
  });
  assert.equal(getConfigValue(project, "search.analyzer", env).value, "intl");

  const localSettingsBefore = fs.readFileSync(localSettings, "utf8");
  const updatedGlobal = setConfigValue(project, "search.analyzer", "intl", env);
  assert.equal(updatedGlobal.config.search.analyzer, "intl");
  assert.equal(fs.readFileSync(localSettings, "utf8"), localSettingsBefore);
  assert.equal(getConfigValue(project, "search.analyzer", env).value, "intl");

  const remainingGlobalSearch = { ...expectedGlobalSearch, analyzer: "intl" };
  for (const key of cases.map(([settingKey]) => settingKey)) {
    const result = unsetConfigValue(project, key, env);
    delete remainingGlobalSearch[key.slice("search.".length)];
    if (Object.keys(remainingGlobalSearch).length > 0) {
      assert.deepEqual(result.config, { search: { ...remainingGlobalSearch } });
    } else assert.deepEqual(result.config, {});
  }
});

test("AC6 search query and Hangul ngram analysis are length-bounded", async () => {
  const { UsageError } = await import(path.join(repoRoot, "src/errors.ts"));
  const { MAX_SEARCH_QUERY_LENGTH, normalizeSearchParams } = await import(path.join(repoRoot, "src/core/search/params.ts"));
  const { ngramSearchTerms } = await import(path.join(repoRoot, "src/core/search/analysis/korean.ts"));

  const maxQuery = "a".repeat(MAX_SEARCH_QUERY_LENGTH);
  assert.equal(normalizeSearchParams({ query: maxQuery }).query, maxQuery);

  assert.throws(
    () => normalizeSearchParams({ query: `${maxQuery}a` }),
    (error) => error instanceof UsageError && /4096 characters or fewer/.test(error.message)
  );
  assert.throws(() => normalizeSearchParams({ path: "note.md" }), /query=<text> or tag=<tag>/);
  assert.throws(() => normalizeSearchParams({ query: "alpha", fields: ["unknown"] }), /field must be one of/);
  assert.throws(() => normalizeSearchParams({ tags: ["project"], fields: ["body"] }), /field=<field> requires query=<text>/);

  assert.deepEqual(ngramSearchTerms(["검색어"]), ["검색", "색어", "검색어"]);

  let longHangulTerms;
  assert.doesNotThrow(() => {
    longHangulTerms = ngramSearchTerms(["가".repeat(130000)]);
  });
  assert.ok(longHangulTerms.length <= 8192);
});

test("body ngram field text can be capped without changing other channels", async () => {
  const { BODY_NGRAM_SHORT_MAX_TERMS } = await import(path.join(repoRoot, "src/core/search/analysis/budget.ts"));
  const { searchFieldTokenTexts } = await import(path.join(repoRoot, "src/core/search/analysis/fields.ts"));
  const longHangul = Array.from({ length: BODY_NGRAM_SHORT_MAX_TERMS + 100 }, (_, index) =>
    String.fromCodePoint(0xac00 + index)
  ).join("");

  const uncapped = searchFieldTokenTexts(longHangul, ["형태소"]);
  const capped = searchFieldTokenTexts(longHangul, ["형태소"], { ngramMaxTerms: BODY_NGRAM_SHORT_MAX_TERMS });

  assert.equal(capped.morph, "형태소");
  assert.ok(uncapped.ngram.split(" ").length > BODY_NGRAM_SHORT_MAX_TERMS);
  assert.equal(capped.ngram.split(" ").length, BODY_NGRAM_SHORT_MAX_TERMS);
});

test("body index budget samples oversized bodies across the full text", async () => {
  const {
    BODY_FULL_ANALYSIS_MAX_CHARS,
    BODY_LEXICAL_SAMPLE_MAX_CHARS,
    bodyIndexBudgetForText
  } = await import(path.join(repoRoot, "src/core/search/analysis/budget.ts"));
  const body = [
    "front-marker",
    "가".repeat(BODY_FULL_ANALYSIS_MAX_CHARS + 1000),
    "tail-marker"
  ].join("\n");

  const budget = bodyIndexBudgetForText(body);

  assert.equal(budget.tier, "long");
  assert.ok(budget.bodyLexicalText.length <= BODY_LEXICAL_SAMPLE_MAX_CHARS);
  assert.match(budget.bodyLexicalText, /front-marker/);
  assert.match(budget.bodyLexicalText, /tail-marker/);
});


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

test("reranker does not let weak metadata ngram coverage outrank stronger body retrieval", async () => {
  const { rankBucketName, rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/index.ts"));
  const strongBody = searchDocument({
    path: "STS/strong-body.md",
    bodyNgramTokens: "숙소"
  });
  const weakMetadata = searchDocument({
    path: "WOS/weak-metadata.md",
    titleNgramTokens: "숙소",
    tagsNgramTokens: "숙소"
  });
  const queryChannels = {
    morph: [],
    surface: [],
    ngram: ["숙소"]
  };

  const ranked = rerankCandidatesWithSignals(
    "숙소",
    ["숙소"],
    [
      { document: strongBody, score: 10, queryChannels },
      { document: weakMetadata, score: 9, queryChannels }
    ],
    undefined,
    new Map()
  );

  assert.equal(ranked[0].path, "STS/strong-body.md");
  assert.equal(rankBucketName(ranked[0].bucket), "base");
  assert.equal(ranked[1].coverageTerms, 0.3);
  assert.equal(rankBucketName(ranked[1].bucket), "base");
});

test("reranker ignores weak English function words for metadata coverage", async () => {
  const { rankBucketName, rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/index.ts"));
  const strongBody = searchDocument({
    path: "SciFact/strong-body.md",
    bodyTokens: "aspirin inhibit product pge2",
    bodySurfaceTokens: "aspirin inhibits production pge2 pge"
  });
  const weakMetadata = searchDocument({
    path: "SciFact/weak-title.md",
    titleTokens: "the of in",
    titleSurfaceTokens: "the of in"
  });
  const queryChannels = {
    morph: ["aspirin", "inhibit", "the", "product", "of", "pge2"],
    surface: ["aspirin", "inhibits", "the", "production", "of", "pge2", "pge"],
    ngram: []
  };

  const ranked = rerankCandidatesWithSignals(
    "Aspirin inhibits the production of PGE2.",
    queryChannels.morph,
    [
      { document: strongBody, score: 10, queryChannels },
      { document: weakMetadata, score: 9, queryChannels }
    ],
    undefined,
    new Map()
  );

  assert.equal(ranked[0].path, "SciFact/strong-body.md");
  assert.equal(ranked[1].coverageTerms, 0);
  assert.equal(rankBucketName(ranked[1].bucket), "base");
});

test("reranker keeps English polarity terms eligible for metadata coverage", async () => {
  const { rankBucketName, rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/index.ts"));
  const polarityMetadata = searchDocument({
    path: "SciFact/not-title.md",
    titleTokens: "not"
  });
  const queryChannels = {
    morph: ["not"],
    surface: [],
    ngram: []
  };

  const ranked = rerankCandidatesWithSignals(
    "not",
    queryChannels.morph,
    [{ document: polarityMetadata, score: 1, queryChannels }],
    undefined,
    new Map()
  );

  assert.equal(ranked[0].coverageTerms, 1);
  assert.notEqual(rankBucketName(ranked[0].bucket), "base");
});

test("reranker uses body signal to break comparable metadata coverage ties", async () => {
  const { rerankCandidatesWithSignals } = await import(path.join(repoRoot, "src/core/search/ranking/index.ts"));
  const weakBody = searchDocument({
    path: "SciFact/weak-body.md",
    titleTokens: "aspirin"
  });
  const strongBody = searchDocument({
    path: "SciFact/strong-body.md",
    titleTokens: "aspirin"
  });

  const ranked = rerankCandidatesWithSignals(
    "Aspirin inhibits the production of PGE2.",
    ["aspirin", "inhibit", "product", "pge2"],
    [
      { document: weakBody, score: 10 },
      { document: strongBody, score: 9 }
    ],
    undefined,
    new Map([
      ["SciFact/weak-body.md", { rarityScore: 0, proximityScore: 0, bodyScore: 0 }],
      ["SciFact/strong-body.md", { rarityScore: 0, proximityScore: 0, bodyScore: 1 }]
    ])
  );

  assert.equal(ranked[0].path, "SciFact/strong-body.md");
  assert.equal(ranked[0].bodyScore, 1);
});

test("intl search analyzer segments CJK text for lexical search", async () => {
  const {
    analyzerIdentityKey,
    createInlineQueryAnalyzer,
    parseDeclaredSearchAnalyzers,
    resolveSearchAnalyzer,
    searchTextNeedsBlockingAnalyzer,
    tokenizeIntlText,
    tokenizeRoutedText
  } = await import(path.join(repoRoot, "src/core/search/analyzer.ts"));

  assert.ok(tokenizeIntlText("検索方式を改善する").includes("検索"));
  assert.ok(tokenizeIntlText("中文搜索方式需要改善").includes("搜索"));
  assert.deepEqual(tokenizeIntlText("résumés running studies"), ["resum", "run", "studi"]);
  assert.deepEqual(tokenizeIntlText("한글"), ["한글"]);
  assert.deepEqual(tokenizeRoutedText("검색API", ["ko"]), ["검색", "api"]);
  assert.deepEqual(parseDeclaredSearchAnalyzers(" ko,KO , "), ["ko"]);
  const runtime = { node: "test", icu: "test" };
  const analyzer = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, {}, runtime);
  assert.deepEqual(analyzer.identity.declaredAnalyzers, ["ko"]);
  assert.deepEqual(analyzer.identity.activeAnalyzers, ["ko"]);
  assert.match(analyzer.identity.model ?? "", /^kiwi-nlp:/);
  assert.equal(searchTextNeedsBlockingAnalyzer("scifact evidence", analyzer.identity), false);
  assert.equal(searchTextNeedsBlockingAnalyzer("한국어 검색", analyzer.identity), true);
  assert.ok(createInlineQueryAnalyzer(analyzer.identity, "scifact evidence"));
  assert.equal(createInlineQueryAnalyzer(analyzer.identity, "한국어 검색"), undefined);
  assert.ok((await analyzer.tokenize("한국어 검색")).includes("한국어"));
  const envOverSettings = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "" }, { search: { extraLangs: ["ko"] } }, runtime);
  assert.deepEqual(envOverSettings.identity.declaredAnalyzers, []);
  assert.deepEqual(resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_ANALYZER: "kiwi" }, { search: { analyzer: "intl" } }, runtime).identity.activeAnalyzers, ["ko"]);
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
    env: { ...env, OPTSIDIAN_SEARCH_VAULT_ACCESS_MAX_AGE_DAYS: "5" },
    nowMs: 6 * dayMs
  }), [secondReal]);

  assert.equal(recordVaultAccess(thirdVault, { env, nowMs: 8 * dayMs }), thirdReal);
  assert.deepEqual(recentVaultAccessRoots({ env, nowMs: 8 * dayMs }), [thirdReal, secondReal]);
  assert.equal(vaultAccessStatus(firstVault, {
    env: { ...env, OPTSIDIAN_SEARCH_VAULT_ACCESS_MAX_AGE_DAYS: "5" },
    nowMs: 8 * dayMs
  }).recent, false);
  assert.deepEqual(recentVaultAccessRoots({
    env: { ...env, OPTSIDIAN_SEARCH_VAULT_ACCESS_MAX_AGE_DAYS: "10" },
    nowMs: 8 * dayMs
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
