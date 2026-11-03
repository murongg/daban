import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { secureDirectory } from './private-files.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
async function inventory(root: string, materialized: boolean, signal?: AbortSignal) {
  if (process.platform === 'win32') await secureDirectory(root);
  const identity = await lstat(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw Error('COMPONENT_UNSAFE');
  const base = await realpath(root),
    files = new Map<string, Stats>();
  let count = 0;
  async function walk(dir: string, depth: number) {
    signal?.throwIfAborted();
    if (depth > 64) throw Error('COMPONENT_UNSAFE');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > 100000) throw Error('COMPONENT_UNSAFE');
      const file = path.join(dir, entry.name),
        info = await lstat(file);
      if (
        process.platform !== 'win32' &&
        (info.uid !== process.getuid?.() || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0))
      )
        throw Error('COMPONENT_UNSAFE');
      if (info.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (materialized || !resolved.startsWith(base + path.sep)) throw Error('COMPONENT_UNSAFE');
      } else if (info.isDirectory()) await walk(file, depth + 1);
      else if (info.isFile() && info.nlink === 1)
        files.set(path.relative(base, file).split(path.sep).join('/'), info);
      else throw Error('COMPONENT_UNSAFE');
    }
  }
  await walk(base, 0);
  if (!same(identity, await lstat(root))) throw Error('COMPONENT_UNSAFE');
  return { base, files };
}
export async function verifyComponentTree(root: string, signal?: AbortSignal) {
  return (await inventory(root, false, signal)).base;
}
export async function verifyHostFiles(root: string, manifest: unknown, signal?: AbortSignal) {
  if (
    !record(manifest) ||
    typeof manifest.node !== 'string' ||
    typeof manifest.dsh !== 'string' ||
    !record(manifest.files)
  )
    throw Error('COMPONENT_INTEGRITY');
  const expected = new Map<string, string>();
  for (const [name, digest] of Object.entries(manifest.files)) {
    const normalized = name.replaceAll('\\', '/');
    if (
      !normalized ||
      Array.from(normalized).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ':',
      ) ||
      normalized.split('/').some((part) => !part || part === '..' || part === '.') ||
      expected.has(normalized) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw Error('COMPONENT_INTEGRITY');
    expected.set(normalized, digest);
  }
  if (!expected.has('main.js') || !expected.has('node/node.exe') || expected.size > 100000)
    throw Error('COMPONENT_INTEGRITY');
  const { base, files } = await inventory(root, true, signal);
  files.delete('manifest.json');
  if (files.size !== expected.size || [...files.keys()].some((name) => !expected.has(name)))
    throw Error('COMPONENT_INTEGRITY');
  const entries = [...expected];
  let index = 0;
  let failed = false;
  // This manifest comes from the hash-verified archive, never from the mutable installed copy.
  async function verify(name: string, digest: string) {
    signal?.throwIfAborted();
    const file = path.join(base, ...name.split('/'));
    if ((await realpath(file)) !== file) throw Error('COMPONENT_UNSAFE');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!same(before, files.get(name)!) || before.nlink !== 1) throw Error('COMPONENT_UNSAFE');
      const hash = createHash('sha256');
      for await (const bytes of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(bytes);
      }
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        hash.digest('hex') !== digest
      )
        throw Error('COMPONENT_INTEGRITY');
    } finally {
      await handle.close();
    }
  }
  // Drain every worker before returning: callers may immediately remove a failed installation.
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (!failed && index < entries.length) {
        const [name, digest] = entries[index++];
        try {
          await verify(name, digest);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = workers.find((worker) => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
