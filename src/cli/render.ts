import { UsageError } from '../errors.js';
import type {
  FrontmatterReadResult,
  GrepResult,
  MutationResult,
  ReadResult,
  SearchIndexMutationResult,
  SearchIndexPruneResult,
  SearchIndexStatusResult,
  SearchIndexWarmResult,
  RetrieveDenseSignal,
  SearchResult,
  SimilarityResult,
} from '../core/types.js';
import type { DaemonConcurrencyStatus, RefreshResult, StatusResult } from '../daemon/protocol.js';

export type OutputFormat = 'text' | 'json';

export function parseFormat(value: string | undefined): OutputFormat {
  const format = value ?? 'text';
  if (format !== 'text' && format !== 'json') {
    throw new UsageError('format must be text or json');
  }
  return format;
}

export function renderRead(result: ReadResult, format: OutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify({
      ok: result.ok,
      command: result.command,
      path: result.path,
      range: result.range,
      truncated: result.truncated,
      numberedText: result.numberedText,
    })}\n`;
  }
  return `path: ${result.path}\nlines: ${result.range.start}-${result.range.end}/${result.range.total}\ntruncated: ${result.truncated}\n\n${result.numberedText}\n`;
}

export function renderGrep(result: GrepResult, format: OutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }
  if (result.matches.length === 0) {
    return 'No matches found.\n';
  }
  const out: string[] = [`matches: ${result.matches.length}`];
  for (const match of result.matches) {
    for (const before of match.contextBefore) out.push(`${match.path}:${before.line}- | ${before.text}`);
    out.push(`${match.path}:${match.line}: | ${match.text}`);
    for (const after of match.contextAfter) out.push(`${match.path}:${after.line}+ | ${after.text}`);
  }
  return `${out.join('\n')}\n`;
}

export function renderSearch(result: SearchResult, format: OutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }
  const dense = result.dense ? [formatDenseSignal(result.dense)] : [];
  if (result.status === 'index-not-ready') {
    return `${['Search index not ready.', ...dense].join('\n')}\n`;
  }
  const warnings = (result.warnings ?? []).map((warning) => `warning: ${warning}`);
  if (result.matches.length === 0) {
    const prefix = [...dense, ...warnings];
    return `${prefix.length > 0 ? `${prefix.join('\n')}\n` : ''}No matches found.\n`;
  }
  const out: string[] = [...dense, ...warnings];
  if (out.length > 0) out.push('');
  result.matches.forEach((match, index) => {
    out.push(`${index + 1}. ${match.path}`);
    out.push(`title: ${match.title}`);
    if (match.tags.length > 0) out.push(`tags: ${match.tags.join(', ')}`);
    if (match.snippets.length > 0) {
      out.push('snippets:');
      for (const snippet of match.snippets) out.push(`  ${snippet.line} | ${snippet.text}`);
    }
    out.push('');
  });
  return `${out.join('\n')}`;
}

export function renderSimilarity(result: SimilarityResult, format: OutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }
  const dense = result.dense ? [formatDenseSignal(result.dense)] : [];
  if (result.status === 'index-not-ready') {
    return `${[`Similarity index not ready${result.reason ? `: ${result.reason}` : ''}.`, ...dense].join('\n')}\n`;
  }
  if (result.results.length === 0) {
    return `${dense.length > 0 ? `${dense.join('\n')}\n` : ''}No similar notes found.\n`;
  }
  const out: string[] = [...dense];
  if (out.length > 0) out.push('');
  result.results.forEach((match, index) => {
    out.push(`${index + 1}. ${match.path}`);
    out.push(`score: ${formatScore(match.score)}`);
    out.push(`title: ${match.title}`);
    if (match.tags.length > 0) out.push(`tags: ${match.tags.join(', ')}`);
    if (match.snippets.length > 0) {
      out.push('snippets:');
      for (const snippet of match.snippets) out.push(`  ${snippet.line} | ${snippet.text}`);
    }
    out.push('');
  });
  return out.join('\n');
}

export function renderFrontmatterRead(result: FrontmatterReadResult, format: OutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }
  return [
    `path: ${result.path}`,
    `frontmatter: ${result.hasFrontmatter ? 'present' : 'missing'}`,
    '',
    JSON.stringify(result.frontmatter, null, 2),
  ]
    .join('\n')
    .concat('\n');
}

export function renderIndexResult(
  result:
    | StatusResult
    | SearchIndexStatusResult
    | SearchIndexMutationResult
    | SearchIndexWarmResult
    | SearchIndexPruneResult
    | RefreshResult,
  format: OutputFormat = 'text',
): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }
  if (isDaemonStatusResult(result)) {
    const lines = [result.ready ? 'Search daemon ready.' : 'Search daemon not ready.'];
    lines.push(`Phase: ${result.phase}.`);
    lines.push(`Owner: incarnation ${result.incarnationId}, epoch ${result.epoch}, pid ${result.pid}.`);
    lines.push(
      `Requests: ${result.metrics.requests}, failures: ${result.metrics.failures}, active: ${result.metrics.activeRequests}.`,
    );
    appendConcurrencyLines(lines, result.concurrency);
    if (result.vaults.length === 0) {
      lines.push('Vaults: none.');
    } else {
      lines.push('Vaults:');
      for (const vault of result.vaults) {
        const details = [
          vault.snapshotId ? `snapshot: ${vault.snapshotId}` : '',
          vault.updatedAt ? `updated: ${vault.updatedAt}` : '',
          vault.progress ? `progress: ${renderIndexProgress(vault.progress)}` : '',
          vault.error ? `error: ${vault.error}` : '',
        ].filter(Boolean);
        lines.push(`- ${vault.state}: ${vault.vault}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
  if (result.action === 'status') {
    const lines = [
      result.ready ? (result.staleTier ? 'Index ready (stale analyzer tier).' : 'Index ready.') : 'Index missing.',
    ];
    if (result.projections.length > 0) {
      lines.push('Projections:');
      for (const projection of result.projections) {
        lines.push(
          `- ${projection.key}${projection.roles.length > 0 ? ` [${projection.roles.join(', ')}]` : ''}: ${renderProjectionState(projection)}`,
        );
      }
    }
    lines.push(renderAnalyzerStatus(result.analyzer));
    lines.push(renderWarmAccess(result.warmAccess));
    lines.push(renderWarmSchedule(result.warmSchedule));
    return `${lines.join('\n')}\n`;
  }
  if (result.action === 'rebuild') {
    return 'Index rebuilt.\n';
  }
  if (result.action === 'refresh') {
    return result.rebuilt ? 'Index refreshed.\n' : 'Index already fresh.\n';
  }
  if (result.action === 'warm') {
    const lines = (result.warnings ?? []).map((warning) => `warning: ${warning}`);
    if (result.vaults.length === 0) {
      lines.push('No vaults found to warm.');
      return `${lines.join('\n')}\n`;
    }
    const ready = result.vaults.filter((vault) => vault.status === 'ready').length;
    const failed = result.vaults.length - ready;
    lines.push(`Warmed ${ready} vault${ready === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}.`);
    for (const vault of result.vaults) {
      lines.push(
        `${vault.status === 'ready' ? 'ready' : 'failed'}: ${vault.vaultRoot}${vault.error ? ` (${vault.error})` : ''}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
  if (result.action === 'prune') {
    const count = result.removedStores.length;
    const storeLabel = count === 1 ? 'store' : 'stores';
    const skipped = result.skippedStores.length > 0 ? ` Skipped ${result.skippedStores.length}.` : '';
    if (result.dryRun) {
      return `Dry run. Would prune ${count} search cache ${storeLabel}, freeing ${formatBytes(result.removedBytes)}.${skipped}\n`;
    }
    return `Pruned ${count} search cache ${storeLabel}, freed ${formatBytes(result.removedBytes)}.${skipped}\n`;
  }
  return 'Index cleared.\n';
}

function appendConcurrencyLines(lines: string[], concurrency: DaemonConcurrencyStatus): void {
  if (concurrency.processRssBytes !== undefined) {
    lines.push(`RSS: ${(concurrency.processRssBytes / (1024 * 1024)).toFixed(1)} MB.`);
  }
  if (concurrency.pools.length > 0) {
    lines.push('Pools:');
    for (const pool of concurrency.pools) {
      const jobs: string[] = [];
      for (const slot of pool.slots) {
        if (slot.job) jobs.push(`${slot.job.type}${slot.job.vault ? `@${slot.job.vault}` : ''}`);
      }
      const detail = [
        `${pool.workers} workers`,
        `queued ${pool.queued}`,
        `active ${pool.active}`,
        jobs.length > 0 ? `jobs: ${jobs.join(', ')}` : '',
      ].filter(Boolean);
      lines.push(`- ${pool.pool}: ${detail.join(', ')}`);
    }
  }
  for (const lane of concurrency.embedLanes) {
    const running = lane.runningLane;
    const hasDepth = Object.values(lane.lanes).some((depth) => depth > 0);
    if (!running && !hasDepth) continue;
    const depths = Object.entries(lane.lanes)
      .map(([name, depth]) => `${name} ${depth}`)
      .join(', ');
    lines.push(`Embed lanes: ${depths}${running ? ` (running: ${running})` : ''}.`);
  }
  for (const cache of concurrency.caches) {
    const parts = [`query-analysis ${cache.queryAnalysis.hits}/${cache.queryAnalysis.misses} hit/miss`];
    if (cache.searchExecution) {
      parts.push(`search-execution ${cache.searchExecution.hits}/${cache.searchExecution.misses} hit/miss`);
    }
    lines.push(`Caches: ${parts.join('; ')}.`);
  }
}

function isDaemonStatusResult(
  result:
    | StatusResult
    | SearchIndexStatusResult
    | SearchIndexMutationResult
    | SearchIndexWarmResult
    | SearchIndexPruneResult
    | RefreshResult,
): result is StatusResult {
  return 'phase' in result && 'metrics' in result && 'vaults' in result;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  return `${rounded} ${units[unit]}`;
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '0';
  return score.toFixed(6).replace(/\.?0+$/u, '');
}

function formatDenseSignal(dense: RetrieveDenseSignal): string {
  const age = dense.generationAgeMs === null ? 'null' : `${dense.generationAgeMs}ms`;
  return `dense: state=${dense.state} pending=${dense.pendingCount} generationAge=${age}`;
}

function renderIndexProgress(progress: NonNullable<StatusResult['vaults'][number]['progress']>): string {
  const counts =
    progress.total === undefined ? String(progress.completed ?? 0) : `${progress.completed ?? 0}/${progress.total}`;
  return `${progress.phase} ${counts}${progress.current ? ` ${progress.current}` : ''}`;
}

function renderAnalyzerStatus(analyzer: SearchIndexStatusResult['analyzer']): string {
  const details = [
    `target: ${analyzer.targetTier}`,
    analyzer.declaredAnalyzers.length > 0 ? `declared: ${analyzer.declaredAnalyzers.join(',')}` : 'declared: none',
    analyzer.activeAnalyzers.length > 0 ? `active: ${analyzer.activeAnalyzers.join(',')}` : 'active: none',
  ];
  if (analyzer.kiwi) {
    details.push(`kiwi model: ${analyzer.kiwi.modelState}`);
    details.push(`kiwi analyzer: ${analyzer.kiwi.analyzerState}`);
    if (analyzer.kiwi.reason) details.push(`reason: ${analyzer.kiwi.reason}`);
  }
  return `Analyzer: ${details.join(', ')}.`;
}

function renderWarmAccess(access: SearchIndexStatusResult['warmAccess']): string {
  const details = [
    `max age: ${access.maxAgeDays}d`,
    access.lastAccessAt ? `last access: ${access.lastAccessAt}` : 'last access: none',
    access.expiresAt ? `expires: ${access.expiresAt}` : '',
  ].filter(Boolean);
  return `Background warm target: ${access.recent ? 'yes' : 'no'} (${details.join(', ')}).`;
}

function renderWarmSchedule(schedule: SearchIndexStatusResult['warmSchedule']): string {
  const details = [
    `interval: ${schedule.intervalMinutes}m`,
    schedule.lastAttemptAt ? `last attempt: ${schedule.lastAttemptAt}` : 'last attempt: none',
    schedule.nextAttemptAt ? `next eligible: ${schedule.nextAttemptAt}` : '',
  ].filter(Boolean);
  return `MCP warm throttle: ${schedule.throttled ? 'active' : 'inactive'} (${details.join(', ')}).`;
}

function renderProjectionState(projection: SearchIndexStatusResult['projections'][number]): string {
  const details = [
    projection.state,
    projection.compatible ? (projection.staleTier ? 'stale-tier' : 'compatible') : '',
    projection.documents !== undefined ? `documents: ${projection.documents}` : '',
    projection.files !== undefined ? `files: ${projection.files}` : '',
  ].filter(Boolean);
  return details.join(', ');
}

export function renderMutation(result: MutationResult, format: OutputFormat = 'text'): string {
  if (format === 'json') {
    return `${JSON.stringify(result)}\n`;
  }

  if (result.message && result.changes.length === 0) {
    return `${result.message}\n`;
  }

  if (result.dryRun) {
    if (result.command === 'copy') {
      const change = result.changes[0];
      const source = change?.from ? `${change.from} to ` : '';
      return `Dry run. Would copy ${source}${change?.path ?? ''}\n`;
    }
    if (result.command === 'mkdir') {
      const target = result.changes[0]?.path ?? '';
      return `Dry run. Would create directory ${target}\n`;
    }
    if (result.command === 'apply_patch') {
      return renderDryRunPatch(result);
    }
    const change = result.changes[0];
    const verb = result.command === 'write' && change?.code === 'A' ? 'create' : 'update';
    const diff = result.changes
      .map((item) => item.diff)
      .filter(Boolean)
      .join('\n');
    return `Dry run. Would ${verb} ${change?.path ?? ''}\n${diff}\n`;
  }

  if (result.command === 'mkdir') {
    return `Success. Created directory:\n${result.changes.map((change) => `${change.code} ${change.path}`).join('\n')}\n`;
  }

  return `Success. Updated the following files:\n${result.changes.map((change) => `${change.code} ${change.path}`).join('\n')}\n`;
}

function renderDryRunPatch(result: MutationResult): string {
  const out = [
    'Dry run. Would update the following files:',
    ...result.changes.map((change) => `${change.code} ${change.path}`),
  ];
  for (const change of result.changes) {
    if (change.diff) out.push(change.diff);
  }
  return `${out.join('\n')}\n`;
}
