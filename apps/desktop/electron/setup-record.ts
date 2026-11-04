import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { privateMetadata } from '@daban/engine/local-computer';

export async function readSetupRecord(root: string, name: 'progress.json' | 'cancel.json') {
  const entry = join(root, name);
  let identity: Stats;
  let file: Awaited<ReturnType<typeof fs.open>>;
  try {
    // Windows ignores O_NOFOLLOW, so bind the handle to the inspected regular entry as well.
    identity = await fs.lstat(entry);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
      throw new Error('SETUP_STORE');
    file = await fs.open(entry, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error('SETUP_STORE');
  }
  try {
    const info = await file.stat();
    // Atomic replacement can unlink an in-flight observation; intent files must still pass every check.
    const replaced = identity.dev !== info.dev || identity.ino !== info.ino;
    if (name === 'progress.json' && (info.nlink === 0 || replaced)) return undefined;
    if (
      !info.isFile() ||
      replaced ||
      info.nlink !== 1 ||
      !(await privateMetadata(entry, info, 0o600)) ||
      info.size > 16384
    )
      throw new Error('SETUP_STORE');
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw new Error('SETUP_STORE');
    try {
      return {
        value: JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown,
        revision: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`,
      };
    } catch (error) {
      // Older producers may truncate progress before writing its next complete observation.
      if (name === 'progress.json' && error instanceof SyntaxError) return undefined;
      throw error;
    }
  } finally {
    await file.close();
  }
}
