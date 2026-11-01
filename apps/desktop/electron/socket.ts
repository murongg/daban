import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function owner() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('RUNTIME_CONTROL_PATH_UNAVAILABLE');
  return uid;
}
export function controlSocket(logical: string, target: string) {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\daban-agent-${createHash('sha256')
      .update(JSON.stringify([resolve(logical), target]))
      .digest('hex')
      .slice(0, 32)}`;
  // OpenSSH appends a temporary suffix; leave headroom under macOS's 104-byte Unix address limit.
  if (Buffer.byteLength(logical) <= 80) return logical;
  const key = createHash('sha256')
    .update(JSON.stringify([resolve(logical), target]))
    .digest('hex')
    .slice(0, 32);
  return join('/tmp', `daban-${owner()}-${key}`, 's');
}
async function stat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}
export async function socketReady(socket: string) {
  if (process.platform === 'win32') return socket.startsWith('\\\\.\\pipe\\daban-agent-');
  const uid = owner();
  const folder = await stat(dirname(socket));
  if (!folder) return false;
  if (
    !folder.isDirectory() ||
    folder.isSymbolicLink() ||
    folder.uid !== uid ||
    (folder.mode & 0o777) !== 0o700
  )
    throw new Error('RUNTIME_CONTROL_PATH_UNSAFE');
  const file = await stat(socket);
  if (
    file &&
    (!file.isSocket() || file.uid !== uid || file.nlink !== 1 || (file.mode & 0o077) !== 0)
  )
    throw new Error('RUNTIME_CONTROL_PATH_UNSAFE');
  return true;
}
export async function prepareSocket(socket: string) {
  if (process.platform === 'win32') {
    if (!(await socketReady(socket))) throw new Error('RUNTIME_CONTROL_PATH_UNSAFE');
    return;
  }
  try {
    await fs.mkdir(dirname(socket), { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
  }
  // Never chmod, unlink or adopt an unsafe pre-existing entry in the shared temporary namespace.
  if (!(await socketReady(socket))) throw new Error('RUNTIME_CONTROL_PATH_UNAVAILABLE');
}
