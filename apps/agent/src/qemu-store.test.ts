import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';

const hook = vi.hoisted(() => ({
  file: '',
  replace: undefined as undefined | (() => Promise<unknown>),
  busy: 0,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === hook.file && hook.busy > 0) {
        hook.busy--;
        throw Object.assign(Error('Synthetic Windows sharing violation'), { code: 'EPERM' });
      }
      return fs.rename(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === hook.file && typeof args[1] === 'number' && hook.replace) {
        const replace = hook.replace;
        hook.replace = undefined;
        await replace();
      }
      return fs.open(...args);
    },
  };
});

test.skipIf(process.platform !== 'win32')(
  'atomic publication tolerates a transient Windows sharing violation without deleting the previous record',
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mock-qemu-sharing-'));
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'private/progress.json');
    await writeQemuRecord(file, { phase: 'verifying' });
    hook.file = file;
    hook.busy = 1;
    await writeQemuRecord(file, { phase: 'waiting' });
    expect(await readQemuRecord(file)).toEqual({ phase: 'waiting' });
  },
);

test('an atomic progress replacement between stat and open is retried without admitting an unverified file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-qemu-atomic-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private/progress.json');
  await writeQemuRecord(file, { phase: 'creating' });
  hook.file = file;
  hook.replace = () => writeQemuRecord(file, { phase: 'waiting' });
  expect(await readQemuRecord(file)).toEqual({ phase: 'waiting' });
});

test('QEMU records persist privately, survive replacement, and reject links without modifying targets', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-qemu-record-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private/state.json');
  expect(await readQemuRecord(file)).toBeUndefined();
  await writeQemuRecord(file, { phase: 'created', id: 'mock-resource' });
  await writeQemuRecord(file, { phase: 'ready', id: 'mock-resource' });
  expect(await readQemuRecord(file)).toStrictEqual({ phase: 'ready', id: 'mock-resource' });
  await rm(file);
  const target = path.join(directory, 'mock-protected.json');
  await writeFile(target, 'SYNTHETIC PROTECTED');
  await symlink(target, file);
  await expect(readQemuRecord(file)).rejects.toThrow('QEMU_STORE_UNSAFE');
  await expect(writeQemuRecord(file, {})).rejects.toThrow('QEMU_STORE_UNSAFE');
  expect(await readFile(target, 'utf8')).toBe('SYNTHETIC PROTECTED');
});
