import type { FileHandle } from 'node:fs/promises';

export async function syncDirectory(directory: Pick<FileHandle, 'sync'>) {
  // Node cannot fsync directories on Windows. Callers still flush file contents before the atomic rename.
  if (process.platform !== 'win32') await directory.sync();
}
