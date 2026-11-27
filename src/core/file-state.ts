import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileSystemUtils } from '../utils/file-system.js';
import { StoreError } from './store/errors.js';

const fs = nodeFs.promises;

/**
 * Shared machine-local state-file mechanics (extracted from the store
 * registry in slice 7.1, its second consumer). Callers own the
 * diagnostic data (code, target, wording); the factory owns the
 * shared mechanics - the fix strings describe the lock's own
 * behavior (stale-steal, creation), so their templates live here.
 */

export type FileLockErrorKind = 'create-failed' | 'timeout';

export interface FileLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface FileLockErrorInfo {
  lockPath: string;
  /** The original errno error for 'create-failed'. */
  cause?: unknown;
  /** Lock holder metadata parsed from the lock file on 'timeout', when readable. */
  owner?: FileLockMetadata;
}

export interface FileLockOptions {
  lockPath: string;
  errorFor: (kind: FileLockErrorKind, info: FileLockErrorInfo) => Error;
  /** File mode for the lock file (defaults to 0o600). */
  mode?: number;
  /** Maximum wait before timing out (defaults to 5000ms). */
  timeoutMs?: number;
}

export interface WriteFileAtomicallyOptions {
  /**
   * File permissions mode:
   * - number: explicit mode (e.g., 0o600)
   * - 'preserve': preserve existing target file mode, or use process umask for new files
   * - undefined: defaults to 0o600 for private state files
   */
  mode?: number | 'preserve';
}

export interface LockErrorData {
  /** Noun phrase for the create-failed message, e.g. "the registry lock file". */
  createSubject: string;
  /** The full timeout message, e.g. "Store registry is busy." */
  busyMessage: string;
  code: string;
  target: string;
}

/** One template for lock diagnostics; callers supply the data. */
export function makeLockErrorFactory(
  data: LockErrorData
): (kind: FileLockErrorKind, info: FileLockErrorInfo) => StoreError {
  return (kind, info) => {
    if (kind === 'create-failed') {
      // A permission or filesystem problem, not contention - say so.
      return new StoreError(
        `Cannot create ${data.createSubject} ${info.lockPath} (${(info.cause as NodeJS.ErrnoException)?.code ?? info.cause}).`,
        data.code,
        {
          target: data.target,
          fix: `Check permissions on ${path.dirname(info.lockPath)}.`,
        }
      );
    }

    return new StoreError(data.busyMessage, data.code, {
      target: data.target,
      fix: `Retry shortly; if this persists, delete the stale lock file ${info.lockPath}.`,
    });
  };
}

const LOCK_DEADLINE_MS = 5000;
const LOCK_POLL_MS = 25;
const PRIVATE_FILE_MODE = 0o600;
const TRANSIENT_FS_RETRY_DELAYS_MS = [15, 30, 60, 120] as const;
const lockOwnership = new WeakMap<nodeFs.promises.FileHandle, string>();

function isUnsupportedSyncError(error: unknown): boolean {
  return (
    isNodeErrorCode(error, 'EINVAL') ||
    isNodeErrorCode(error, 'ENOTSUP') ||
    isNodeErrorCode(error, 'ENOSYS')
  );
}

function isTransientWindowsFsError(error: unknown): boolean {
  return (
    isNodeErrorCode(error, 'EPERM') ||
    isNodeErrorCode(error, 'EACCES') ||
    isNodeErrorCode(error, 'EBUSY')
  );
}

async function retryTransientFsOp<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientWindowsFsError(error) || attempt >= TRANSIENT_FS_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(TRANSIENT_FS_RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
}

async function readExistingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
}

async function readLockMetadata(lockPath: string): Promise<FileLockMetadata | undefined> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FileLockMetadata> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.createdAt === 'string'
    ) {
      return {
        token: parsed.token,
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: parsed.createdAt,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function lockTokenMatches(rawContent: string, expectedToken: string): boolean {
  if (rawContent === expectedToken) return true;
  try {
    const parsed = JSON.parse(rawContent) as Partial<FileLockMetadata> | null;
    return typeof parsed?.token === 'string' && parsed.token === expectedToken;
  } catch {
    return false;
  }
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// Deliberately not FileSystemUtils.directoryExists: that variant
// debug-logs non-ENOENT failures, which is noise inside prompt
// validators, and pathIsFile has no FileSystemUtils equivalent - the
// silent symmetric pair lives here.
export async function pathIsDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function writeFileAtomically(
  filePath: string,
  content: string,
  options?: WriteFileAtomicallyOptions
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await FileSystemUtils.createDirectory(dirPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  const preservedMode =
    options?.mode === 'preserve' ? await readExistingMode(filePath) : undefined;
  const openMode =
    typeof options?.mode === 'number'
      ? options.mode
      : options?.mode === 'preserve'
        ? (preservedMode ?? 0o666)
        : PRIVATE_FILE_MODE;

  try {
    const handle = await fs.open(tempPath, 'wx', openMode);
    try {
      await handle.writeFile(content, 'utf-8');
      if (preservedMode !== undefined) {
        await handle.chmod(preservedMode).catch(() => undefined);
      }
      try {
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedSyncError(error)) {
          throw error;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await retryTransientFsOp(() => fs.rename(tempPath, filePath));
  } catch (error) {
    await retryTransientFsOp(() => fs.rm(tempPath, { force: true })).catch(() => undefined);
    throw error;
  }
}

export async function acquireFileLock(
  options: FileLockOptions
): Promise<nodeFs.promises.FileHandle> {
  const { lockPath, errorFor, mode = PRIVATE_FILE_MODE, timeoutMs = LOCK_DEADLINE_MS } = options;
  const lockDir = path.dirname(lockPath);
  await FileSystemUtils.createDirectory(lockDir);
  if (!(await FileSystemUtils.canWriteFile(lockDir))) {
    throw errorFor('create-failed', { lockPath, cause: 'EACCES' });
  }
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const lock = await fs.open(lockPath, 'wx', mode);
      const ownershipToken = `${process.pid}:${randomUUID()}`;
      const metadata: FileLockMetadata = {
        token: ownershipToken,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        await lock.writeFile(JSON.stringify(metadata), 'utf-8');
        try {
          await lock.sync();
        } catch (error) {
          // Some FUSE and network filesystems support exclusive lock files but
          // explicitly do not implement fsync. The token is still visible to
          // cooperating processes, so do not make those projects unusable.
          if (!isUnsupportedSyncError(error)) {
            throw error;
          }
        }
      } catch (error) {
        await lock.close().catch(() => undefined);
        await retryTransientFsOp(() => fs.rm(lockPath, { force: true })).catch(() => undefined);
        throw error;
      }
      lockOwnership.set(lock, ownershipToken);
      return lock;
    } catch (error) {
      if (!isNodeErrorCode(error, 'EEXIST')) {
        // A permission or filesystem problem, not contention - say so.
        throw errorFor('create-failed', { lockPath, cause: error });
      }

      // Never steal by age: unlinking a supposedly stale path can race with
      // its replacement and erase a live owner's lock. The timeout diagnostic
      // gives the user an explicit recovery path for genuinely orphaned locks.
      if (Date.now() >= deadline) {
        const owner = await readLockMetadata(lockPath);
        throw errorFor('timeout', { lockPath, ...(owner ? { owner } : {}) });
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

export async function releaseFileLock(
  lock: nodeFs.promises.FileHandle,
  lockPath: string
): Promise<void> {
  const ownershipToken = lockOwnership.get(lock);
  lockOwnership.delete(lock);
  await lock.close().catch(() => undefined);

  if (ownershipToken === undefined) {
    return;
  }

  try {
    const currentContent = await fs.readFile(lockPath, 'utf-8');
    if (lockTokenMatches(currentContent, ownershipToken)) {
      await retryTransientFsOp(() => fs.rm(lockPath, { force: true }));
    }
  } catch {
    // The lock was already removed or replaced with an unreadable path.
    // In either case, this owner must not remove anything else.
  }
}
