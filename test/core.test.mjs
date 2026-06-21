import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-core-"));
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
  const { parseMarkdownNote } = await import(path.join(repoRoot, "src/core/search-parse.ts"));
  const doc = parseMarkdownNote(
    "Projects/alpha.md",
    `---
title: Alpha Project
aliases:
  - Project A
tags: [project, alpha]
---
# Alpha Heading

Body with #rollout tag.
`
  );

  assert.equal(doc.title, "Alpha Project");
  assert.deepEqual(doc.aliases, ["Project A"]);
  assert.deepEqual(doc.tags.sort(), ["alpha", "project", "rollout"]);
  assert.deepEqual(doc.headings, ["Alpha Heading"]);
  assert.match(doc.body, /Body with #rollout tag/);
});

test("intl search analyzer segments CJK text for lexical search", async () => {
  const {
    analyzerIdentityKey,
    parseDeclaredSearchAnalyzers,
    resolveSearchAnalyzer,
    tokenizeIntlText,
    tokenizeRoutedText
  } = await import(path.join(repoRoot, "src/core/search-analyzer.ts"));

  assert.ok(tokenizeIntlText("検索方式を改善する").includes("検索"));
  assert.ok(tokenizeIntlText("中文搜索方式需要改善").includes("搜索"));
  assert.deepEqual(tokenizeIntlText("résumés running studies"), ["resum", "run", "studi"]);
  assert.deepEqual(tokenizeIntlText("한글"), ["한글"]);
  assert.deepEqual(tokenizeRoutedText("검색API", ["ko"]), ["검색", "api"]);
  assert.deepEqual(parseDeclaredSearchAnalyzers(" ko,KO , "), ["ko"]);
  const analyzer = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, {});
  assert.deepEqual(analyzer.identity.declaredAnalyzers, ["ko"]);
  assert.deepEqual(analyzer.identity.activeAnalyzers, []);
  assert.ok((await analyzer.tokenize("한국어 검색")).includes("한국어"));
  const envOverSettings = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "" }, { search: { extraLangs: ["ko"] } });
  assert.deepEqual(envOverSettings.identity.declaredAnalyzers, []);
  assert.throws(
    () => resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_ANALYZER: "kiwi" }, { search: { analyzer: "intl" } }),
    /kiwi is not available/
  );
  assert.equal(
    analyzerIdentityKey({ name: "custom", version: "1", node: "20", model: "m", runtime: "daemon" }),
    analyzerIdentityKey({ runtime: "daemon", model: "m", node: "20", version: "1", name: "custom" })
  );
  assert.throws(() => parseDeclaredSearchAnalyzers("ja"), /registered analyzers: ko/);
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
    const { cachePaths, classifySearchManifestMismatch } = await import(path.join(repoRoot, "src/core/search.ts"));
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
    const analysisCache = JSON.parse(fs.readFileSync(cachePaths(vault).analysisPath, "utf8"));
    assert.equal(analysisCache.analyzer.name, "router");
    assert.equal(analysisCache.analyzer.baseline, "intl-segmenter-latin-v2");
    assert.deepEqual(analysisCache.analyzer.activeAnalyzers, []);
    assert.ok(analysisCache.files["Projects/Alpha.md"].tokens.bodyTokens.length > 0);
    const manifest = JSON.parse(fs.readFileSync(cachePaths(vault).manifestPath, "utf8"));
    assert.equal(manifest.identitySchemaVersion, 1);
    assert.equal(manifest.schemaVersion, 3);
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
      assert.equal(noteReads.length, 1);
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
    const { cachePaths, searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search.ts"));
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

    const futureAnalyzer = {
      identity: { ...manifest.analyzer, activeAnalyzers: ["ko"] },
      tokenize: async (text) => [`kiwi_${text}`],
      tokenizeBatch: async (texts) => texts.map((text) => [`kiwi_${text}`])
    };
    const reconcileRequests = [];

    const stale = await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, futureAnalyzer, (root, analyzer, reason) => {
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

test("core search coalesces background reconcile requests until the child exits", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { searchVault, writeVaultFile } = await core();
    const { __setSearchReconcileChildSpawnerForTests, cachePaths, searchVaultWithAnalyzer } = await import(
      path.join(repoRoot, "src/core/search.ts")
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
    const futureAnalyzer = {
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
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, futureAnalyzer);
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, futureAnalyzer);
      assert.equal(spawns.length, 1);
      assert.deepEqual(spawns[0].args, ["__search-reconcile", vault, "reason=stale-tier"]);

      children[0].emit("close");
      await searchVaultWithAnalyzer(vault, { query: "running", limit: 5 }, futureAnalyzer);
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
    } = await import(path.join(repoRoot, "src/core/search.ts"));
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

test("core search degrades terminal analyzer load failures to Intl", async () => {
  const vault = tempVault();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-cache-"));
  await withSearchProcess(cache, async () => {
    const { writeVaultFile } = await core();
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search.ts"));
    const { resolveSearchAnalyzer, SearchAnalyzerTerminalLoadError } = await import(path.join(repoRoot, "src/core/search-analyzer.ts"));
    writeVaultFile(vault, {
      path: "Notes/Degraded.md",
      content: "# Degraded Analyzer\n\n한국어 검색 fallback marker\n"
    });

    const intlAnalyzer = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, {});
    let fallbackLeases = 0;
    const degradedAnalyzer = {
      identity: intlAnalyzer.identity,
      withLease: async (run) => {
        fallbackLeases += 1;
        return run(intlAnalyzer);
      },
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
    const { searchVaultWithAnalyzer } = await import(path.join(repoRoot, "src/core/search.ts"));
    const { resolveSearchAnalyzer, SearchAnalyzerTerminalLoadError } = await import(path.join(repoRoot, "src/core/search-analyzer.ts"));
    writeVaultFile(vault, {
      path: "Notes/Observer.md",
      content: "# Observer Failure\n\n한국어 검색 observer fallback\n"
    });

    const degradedAnalyzer = resolveSearchAnalyzer({ OPTSIDIAN_SEARCH_EXTRA_LANGS: "ko" }, {});
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

test("core search updates cache incrementally across add change rename delete and parse failure", async () => {
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
