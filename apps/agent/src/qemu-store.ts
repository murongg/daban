import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { syncDirectory } from '@daban/engine/host';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';

async function metadata(file: string) {
  if (!path.isAbsolute(file)) throw Error('QEMU_STORE_UNSAFE');
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw Error('QEMU_STORE_UNSAFE');
  });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1048576))
    throw Error('QEMU_STORE_UNSAFE');
  return info;
}

export async function readQemuRecord(file: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const named = await metadata(file);
    if (!named) return undefined;
    await secureDirectory(path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw Error('QEMU_STORE_UNSAFE');
      },
    );
    if (!handle) continue;
    try {
      const info = await handle.stat();
      // A publisher may atomically replace progress while a reader is opening it. Revalidate the new name in full.
      if (named.ino !== info.ino || named.dev !== info.dev || info.nlink === 0) continue;
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 1048576 ||
        !(await privateMetadata(file, info, 0o600))
      )
        throw Error('QEMU_STORE_UNSAFE');
      try {
        return JSON.parse(await handle.readFile('utf8')) as unknown;
      } catch {
        throw Error('QEMU_STORE_UNSAFE');
      }
    } finally {
      await handle.close();
    }
  }
  throw Error('QEMU_STORE_UNSAFE');
}

export async function writeQemuRecord(file: string, value: unknown) {
  await metadata(file);
  const directory = await secureDirectory(path.dirname(file));
  const bytes = JSON.stringify(value);
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 1048576)
    throw Error('QEMU_STORE_UNSAFE');
  const temporary = path.join(directory, `.state-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      await metadata(file);
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))
        )
          throw error;
        // Windows can refuse replacement while an authenticated status reader or scanner holds the old file.
        // Keep the previous record intact and repeat all safety checks before retrying this same publication.
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
    const parent = await open(directory, 'r');
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
