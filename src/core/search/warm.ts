import path from "node:path";
import { RuntimeError } from "../../errors.js";
import { vaultRealpath } from "../path.js";
import {
  analyzerCacheKey,
  analyzerIdentityKey,
  resolveSearchAnalyzer,
  withSearchAnalyzerLease,
  type SearchAnalyzer
} from "./analyzer.js";
import type {
  SearchIndexWarmResult,
  SearchIndexWarmVaultResult
} from "../types.js";
import { cachePaths } from "./cache-paths.js";
import type { SearchIndexWarmOptions } from "./internal-types.js";
import { withSearchIndexWriterLock } from "./locks.js";
import { baselineAnalyzerForSearch } from "./planner.js";
import { loadOrBuildIndexForWrite } from "./persistence.js";

export async function warmSearchIndexes(
  vaultRoots: readonly string[],
  warnings: readonly string[] = [],
  options: SearchIndexWarmOptions = {}
): Promise<SearchIndexWarmResult> {
  const seen = new Set<string>();
  const items: Array<{ root: string } | { result: SearchIndexWarmVaultResult }> = [];

  for (const vaultRoot of vaultRoots) {
    let root: string;
    try {
      root = vaultRealpath(vaultRoot);
    } catch (error) {
      items.push({ result: {
        vaultRoot: path.resolve(vaultRoot),
        status: "failed",
        error: errorMessage(error)
      } });
      continue;
    }

    if (seen.has(root)) continue;
    seen.add(root);
    items.push({ root });
  }

  const results = new Array<SearchIndexWarmVaultResult>(items.length);
  const warmItem = async (item: { root: string } | { result: SearchIndexWarmVaultResult }): Promise<SearchIndexWarmVaultResult> => {
    if ("result" in item) return item.result;
    try {
      await ensureSearchIndex(item.root, options);
      return { vaultRoot: item.root, status: "ready" };
    } catch (error) {
      return {
        vaultRoot: item.root,
        status: "failed",
        error: errorMessage(error)
      };
    }
  };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, items.length || 1));
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await warmItem(items[index]);
    }
  });
  await Promise.all(workers);

  for (const result of results) {
    if (!result) {
      throw new RuntimeError("Search index warm worker did not produce a result");
    }
  }

  return {
    ok: true,
    command: "index",
    action: "warm",
    vaults: results,
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {})
  };
}

async function ensureSearchIndex(vaultRoot: string, options: SearchIndexWarmOptions = {}): Promise<void> {
  const analyzer = resolveSearchAnalyzer();
  await ensureSearchIndexWithAnalyzer(vaultRoot, analyzer, options);
}

export async function ensureSearchIndexWithAnalyzer(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  options: SearchIndexWarmOptions = {}
): Promise<void> {
  const baselineAnalyzer = baselineAnalyzerForSearch(analyzer);
  if (baselineAnalyzer && analyzerIdentityKey(baselineAnalyzer.identity) !== analyzerIdentityKey(analyzer.identity)) {
    await ensureSearchIndexWithLeasedAnalyzer(vaultRoot, baselineAnalyzer, options);
  }
  await withSearchAnalyzerLease(
    analyzer,
    (leasedAnalyzer) => ensureSearchIndexWithLeasedAnalyzer(vaultRoot, leasedAnalyzer, options),
    undefined,
    { wait: true, installIfMissing: true }
  );
}

async function ensureSearchIndexWithLeasedAnalyzer(
  vaultRoot: string,
  analyzer: SearchAnalyzer,
  options: SearchIndexWarmOptions = {}
): Promise<void> {
  const paths = cachePaths(vaultRoot, analyzerCacheKey(analyzer.identity));
  await withSearchIndexWriterLock(paths.cacheDir, vaultRoot, analyzer, "ensure", async () => {
    await loadOrBuildIndexForWrite(vaultRoot, analyzer, noSearchReconcile, paths, {
      serveStaleTier: false,
      fastNoop: options.fastNoop === true
    });
  });
}

function noSearchReconcile(): void {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
