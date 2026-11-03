import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isVmConnection, type VmConnection } from '@daban/protocol';
import { syncDirectory } from './durability.js';
import { privateMetadata, secureDirectory } from './private-files.js';

export function validateVmConnection(value: unknown): asserts value is VmConnection {
  if (!isVmConnection(value) || !path.isAbsolute(value.identityFile))
    throw new Error('VM_CONFIG_INVALID');
  const key = Buffer.from(value.hostKey.split(' ')[1], 'base64');
  if (
    key.length !== 51 ||
    !key.subarray(0, 19).equals(Buffer.from('0000000b7373682d6564323535313900000020', 'hex'))
  )
    throw new Error('VM_CONFIG_INVALID');
}

export function vmConnectionTarget(connection: VmConnection) {
  validateVmConnection(connection);
  // DHCP and the selected identity file can change without rebinding recovery to another guest.
  return createHash('sha256')
    .update(
      JSON.stringify([
        connection.provider,
        connection.vmId.toLowerCase(),
        connection.user,
        connection.hostKey,
      ]),
    )
    .digest('hex');
}

async function metadata(file: string) {
  const info = await lstat(file).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error('VM_CONFIG_UNSAFE');
  });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384))
    throw new Error('VM_CONFIG_UNSAFE');
  return info;
}

export async function readVmConnection(file: string): Promise<VmConnection | undefined> {
  if (!path.isAbsolute(file)) throw new Error('VM_CONFIG_INVALID');
  const identity = await metadata(file);
  if (!identity) return undefined;
  await secureDirectory(path.dirname(file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      !(await privateMetadata(file, info, 0o600))
    )
      throw new Error('VM_CONFIG_UNSAFE');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    validateVmConnection(value);
    return value;
  } finally {
    await handle.close();
  }
}

export async function saveVmConnection(file: string, connection: VmConnection) {
  validateVmConnection(connection);
  if (!path.isAbsolute(file)) throw new Error('VM_CONFIG_INVALID');
  await metadata(file);
  const root = await secureDirectory(path.dirname(file));
  const temporary = path.join(root, `runtime-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(connection));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await metadata(file);
    await rename(temporary, file);
    const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
