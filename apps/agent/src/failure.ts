import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const transferCodes = new Set([
  'MIGRATION_CACHE_CHANGED',
  'MIGRATION_CORRUPT_JOURNAL',
  'MIGRATION_CREDENTIAL_UNAVAILABLE',
  'MIGRATION_DESTINATION_CHANGED',
  'MIGRATION_DESTINATION_EXISTS',
  'MIGRATION_DUPLICATE_PATH',
  'MIGRATION_FILE_CHANGED',
  'MIGRATION_HELPER_CHANGED',
  'MIGRATION_INCOMPLETE_SQLITE',
  'MIGRATION_INTEGRITY_FAILED',
  'MIGRATION_INVALID_CHUNK',
  'MIGRATION_INVALID_MANIFEST',
  'MIGRATION_INVALID_PUBLIC_ROOT',
  'MIGRATION_INVALID_TARGET',
  'MIGRATION_LIMIT',
  'MIGRATION_MANIFEST_CHANGED',
  'MIGRATION_PUBLICATION_UNKNOWN',
  'MIGRATION_RESTORE_ACCOUNT',
  'MIGRATION_RESTORE_FAILED',
  'MIGRATION_RESTORE_UNCONFIRMED',
  'MIGRATION_SECRET_IN_PUBLIC',
  'MIGRATION_SIZE_MISMATCH',
  'MIGRATION_SOURCE_CHANGED',
  'MIGRATION_SOURCE_UNAVAILABLE',
  'MIGRATION_TARGET_CHANGED',
  'MIGRATION_TRANSPORT_FAILED',
  'MIGRATION_UNOWNED_STAGING',
  'MIGRATION_UNSAFE_ARCHIVE',
  'MIGRATION_UNSAFE_DIRECTORY',
  'MIGRATION_UNSAFE_FILE',
  'MIGRATION_UNSAFE_HELPER',
  'MIGRATION_UNSAFE_JOURNAL',
  'MIGRATION_UNSAFE_PUBLIC',
  'SOURCE_API_FAILED',
  'SOURCE_API_INVALID',
  'SOURCE_AUTH_FAILED',
  'SOURCE_BUSY',
  'SOURCE_CACHE_CHANGED',
  'SOURCE_CACHE_UNSAFE',
  'SOURCE_FILE_CHANGED',
  'SOURCE_HELPER_CHANGED',
  'SOURCE_HELPER_INVALID',
  'SOURCE_INVALID_CONFIG',
  'SOURCE_INVALID_MANIFEST',
  'SOURCE_INVALID_PATH',
  'SOURCE_INVALID_REQUEST',
  'SOURCE_INVALID_SCOPE',
  'SOURCE_LIMIT',
  'SOURCE_METADATA_INVALID',
  'SOURCE_NOT_FROZEN',
  'SOURCE_NOT_PREPARED',
  'SOURCE_NOT_RUNNING',
  'SOURCE_READER_FAILED',
  'SOURCE_READ_FAILED',
  'SOURCE_RECOVERY_CHANGED',
  'SOURCE_RECOVERY_INVALID',
  'SOURCE_RECOVERY_UNAVAILABLE',
  'SOURCE_ROLLBACK_UNKNOWN',
  'SOURCE_ROLLED_BACK',
  'SOURCE_ROOT_CHANGED',
  'SOURCE_SERVICE_FAILED',
  'SOURCE_SNAPSHOT_CHANGED',
  'SOURCE_SQLITE_INCOMPLETE',
  'SOURCE_STOP_UNKNOWN',
  'SOURCE_TRANSPORT_FAILED',
  'SOURCE_UNSAFE_FILE',
  'SOURCE_VM_CHANGED',
  'SOURCE_VM_STOPPED',
  'SOURCE_WRITE_FAILED',
]);

export function startupErrorCode(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  if (transferCodes.has(code)) return code;
  return /^(?:AGENT|EXECUTION|EXECUTOR|PROVISION|RECOVERY|RUNTIME|BUNDLE_MIGRATION|INVALID)_[A-Z0-9_]{1,80}$/.test(
    code,
  )
    ? code
    : 'AGENT_START_FAILED';
}
async function privateProgress(file: string) {
  const info = await lstat(file).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  return (
    !info ||
    (info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o777) === 0o600)
  );
}
export async function writeStartupFailure(dataRoot: string, error: unknown): Promise<boolean> {
  if (!path.isAbsolute(dataRoot) || dataRoot.includes('\0')) return false;
  let temporary: string | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(dataRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      return false;
    directory = await open(
      dataRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = await directory.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) return false;
    const root = await realpath(dataRoot);
    const file = path.join(root, 'progress.json');
    if (!(await privateProgress(file))) return false;
    temporary = path.join(root, `progress.json.${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({ required: true, phase: 'failed', error: startupErrorCode(error) }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await lstat(dataRoot);
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.isSymbolicLink() ||
      current.uid !== info.uid ||
      (current.mode & 0o777) !== 0o700 ||
      !(await privateProgress(file))
    )
      return false;
    await rename(temporary, file);
    await directory.sync();
    return true;
  } catch {
    return false;
  } finally {
    await directory?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
