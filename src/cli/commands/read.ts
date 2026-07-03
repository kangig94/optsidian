import { getValue, hasFlag, parseLineRange, parsePositiveInt, requireValue, type ParsedArgs } from '../args.js';
import { DEFAULT_READ_MAX_LINES, readVaultFile } from '../../core/read.js';
import { UsageError } from '../../errors.js';
import { parseFormat, renderRead } from '../render.js';

export function runRead(args: ParsedArgs, vaultRoot: string): void {
  const explicitLines = getValue(args, 'lines');
  const head = parsePositiveInt(getValue(args, 'head'), 'head');
  const tail = parsePositiveInt(getValue(args, 'tail'), 'tail');
  const around = getValue(args, 'around');
  const context = parsePositiveInt(getValue(args, 'context'), 'context') ?? 3;
  const maxLines = parsePositiveInt(getValue(args, 'max-lines'), 'max-lines') ?? DEFAULT_READ_MAX_LINES;
  if (hasFlag(args, 'json')) {
    throw new UsageError('Use format=json, not json');
  }
  const result = readVaultFile(vaultRoot, {
    path: requireValue(args, 'path'),
    lines: explicitLines ? parseLineRange(explicitLines) : undefined,
    head,
    tail,
    around,
    context,
    maxLines,
  });
  process.stdout.write(renderRead(result, parseFormat(getValue(args, 'format'))));
}
