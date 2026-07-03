import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError } from '../errors.js';

const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

type PrivatePathKind = 'directory' | 'file';

export class PrivatePathError extends RuntimeError {
  readonly name = 'PrivatePathError';
}

export function isPrivatePathError(error: unknown): error is PrivatePathError {
  return error instanceof PrivatePathError;
}

export function ensurePrivateDirSync(dirPath: string, label = 'Optsidian directory'): void {
  const target = path.resolve(dirPath);
  try {
    fs.mkdirSync(target, { recursive: true, mode: PRIVATE_DIR_MODE });
    assertNotSymlink(target, label);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      throw new PrivatePathError(`${label} at ${target} is not a directory.`);
    }
    assertOwnedByCurrentUser(target, stat, label);
    chmodPrivateSync(target, PRIVATE_DIR_MODE, label, 'directory');
  } catch (error) {
    throw privatePathError(error, target, label);
  }
}

export function writePrivateFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  label = 'Optsidian file',
): void {
  const target = path.resolve(filePath);
  try {
    ensurePrivateDirSync(path.dirname(target), `${label} parent directory`);
    assertExistingPrivateFileTarget(target, label);
    fs.writeFileSync(target, data, { mode: PRIVATE_FILE_MODE });
    chmodPrivateSync(target, PRIVATE_FILE_MODE, label, 'file');
  } catch (error) {
    throw privatePathError(error, target, label);
  }
}

export function ensureExistingPrivateFileSync(filePath: string, label = 'Optsidian file'): boolean {
  const target = path.resolve(filePath);
  try {
    return ensureExistingPrivateFileTarget(target, label);
  } catch (error) {
    throw privatePathError(error, target, label);
  }
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  label = 'Optsidian file',
): void {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.optsidian-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    ensurePrivateDirSync(dir, `${label} parent directory`);
    assertExistingPrivateFileTarget(target, label);
    fs.writeFileSync(tmp, data, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    chmodPrivateSync(tmp, PRIVATE_FILE_MODE, `${label} temporary file`, 'file');
    fs.renameSync(tmp, target);
    chmodPrivateSync(target, PRIVATE_FILE_MODE, label, 'file');
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw privatePathError(error, target, label);
  }
}

export function fsyncFileSync(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDirSync(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (process.platform === 'win32' && errorCode(error) === 'EISDIR') return;
    throw error;
  }
}

function assertExistingPrivateFileTarget(filePath: string, label: string): void {
  ensureExistingPrivateFileTarget(filePath, label);
}

function ensureExistingPrivateFileTarget(filePath: string, label: string): boolean {
  let stat: fs.Stats;
  try {
    assertNotSymlink(filePath, label);
    stat = fs.statSync(filePath);
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
  if (!stat.isFile()) {
    throw new PrivatePathError(`${label} at ${filePath} is not a file.`);
  }
  assertOwnedByCurrentUser(filePath, stat, label);
  chmodPrivateSync(filePath, PRIVATE_FILE_MODE, label, 'file');
  return true;
}

function chmodPrivateSync(targetPath: string, mode: number, label: string, kind: PrivatePathKind): void {
  if (!strictPosixPermissionsSupported()) return;
  assertNotSymlink(targetPath, label);
  fs.chmodSync(targetPath, mode);
  assertNotSymlink(targetPath, label);
  const stat = fs.statSync(targetPath);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== mode) {
    throw new PrivatePathError(`${label} at ${targetPath} must be ${octal(mode)}, but is ${octal(actualMode)}.`);
  }
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new PrivatePathError(`${label} at ${targetPath} is not a directory.`);
  }
  if (kind === 'file' && !stat.isFile()) {
    throw new PrivatePathError(`${label} at ${targetPath} is not a file.`);
  }
}

function assertNotSymlink(targetPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (isNoEntryError(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new PrivatePathError(`${label} at ${targetPath} must not be a symlink.`);
  }
}

function assertOwnedByCurrentUser(targetPath: string, stat: fs.Stats, label: string): void {
  if (!strictPosixPermissionsSupported()) return;
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid === uid) return;
  throw new PrivatePathError(
    `${label} at ${targetPath} is owned by uid ${stat.uid}, but the current uid is ${uid}. ` + sudoHint(),
  );
}

function privatePathError(error: unknown, targetPath: string, label: string): Error {
  if (error instanceof PrivatePathError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const hint = code === 'EACCES' || code === 'EPERM' ? ` ${sudoHint()}` : '';
  return new PrivatePathError(`Cannot access ${label} at ${targetPath}: ${message}.${hint}`);
}

function sudoHint(): string {
  return 'This often happens when optsidian was previously run with sudo or the path is owned by another user. Fix the ownership/permissions or remove the path, then retry.';
}

function strictPosixPermissionsSupported(): boolean {
  return process.platform !== 'win32';
}

function octal(mode: number): string {
  return `0${mode.toString(8)}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isNoEntryError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
