import { link, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { expect, type TestContext, test } from 'vitest';
import { createArchive, extractArchive } from './archive.js';
import { secureDirectory } from './private-files.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-environment-archive-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const source = await secureDirectory(path.join(root, 'source'));
  const target = await secureDirectory(path.join(root, 'target'));
  const archive = path.join(root, 'environment.zip');
  return {
    root,
    source,
    target,
    archive,
    unpack: async (
      options: { maxBytes: number; maxFiles?: number; signal?: AbortSignal; sha256?: string },
      destination = target,
    ) =>
      extractArchive(archive, destination, {
        ...options,
        sha256:
          options.sha256 ??
          createHash('sha256')
            .update(await readFile(archive))
            .digest('hex'),
      }),
  };
}

test('environment archives are deterministic and restore regular private files without overwriting data', async (t) => {
  const f = await fixture(t);
  await secureDirectory(path.join(f.source, 'tools'));
  await writeFile(path.join(f.source, 'tools/mock.exe'), 'SYNTHETIC EXECUTABLE');
  await writeFile(path.join(f.source, 'image.gz'), 'SYNTHETIC COMPRESSED IMAGE');
  const first = await createArchive(f.source, f.archive);
  await utimes(path.join(f.source, 'image.gz'), new Date(), new Date());
  const second = path.join(f.root, 'again.zip');
  await createArchive(f.source, second);
  expect(await readFile(second)).toEqual(await readFile(f.archive));
  expect(first.unpackedBytes).toBe(46);
  await f.unpack({ maxBytes: 1024 });
  expect(await readFile(path.join(f.target, 'tools/mock.exe'), 'utf8')).toBe(
    'SYNTHETIC EXECUTABLE',
  );
  await expect(f.unpack({ maxBytes: 1024 })).rejects.toThrow('ARCHIVE_UNSAFE');
  expect(await readFile(path.join(f.target, 'image.gz'), 'utf8')).toBe(
    'SYNTHETIC COMPRESSED IMAGE',
  );
});

test('stored binary files may contain ZIP descriptor signatures and remain byte-for-byte intact', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(256 * 1024, 65);
  // A streaming data-descriptor scanner cannot distinguish these image bytes from ZIP framing.
  bytes.writeUInt32LE(0x08074b50, 100000);
  await writeFile(path.join(f.source, 'image.gz'), bytes);
  await createArchive(f.source, f.archive);
  await f.unpack({ maxBytes: bytes.length });
  expect(await readFile(path.join(f.target, 'image.gz'))).toEqual(bytes);
});

test.for([
  '../escape',
  '/absolute',
  'C:/escape',
  '..\\escape',
  'file:stream',
  'CON.txt',
  'trailing.',
  'dir /file',
])('environment extraction rejects unsafe archive paths (%s)', async (name, t) => {
  const f = await fixture(t);
  await writeFile(f.archive, zipSync({ [name]: strToU8('SYNTHETIC') }, { level: 0 }));
  await expect(f.unpack({ maxBytes: 1024 })).rejects.toThrow('ARCHIVE_UNSAFE');
  await expect(lstat(path.join(f.root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('environment extraction bounds bytes and entries, rejects truncated ZIPs and supports cancellation', async (t) => {
  const f = await fixture(t);
  const bytes = zipSync({ 'data.txt': strToU8('SYNTHETIC DATA') }, { level: 0 });
  await writeFile(f.archive, bytes);
  await expect(f.unpack({ maxBytes: 1 })).rejects.toThrow('ARCHIVE_LIMIT');
  const empty = await secureDirectory(path.join(f.root, 'empty'));
  await writeFile(f.archive, bytes.subarray(0, bytes.length - 4));
  await expect(f.unpack({ maxBytes: 1024 }, empty)).rejects.toThrow('ARCHIVE_CORRUPT');
  await writeFile(f.archive, zipSync({ a: strToU8('A'), b: strToU8('B') }, { level: 0 }));
  await expect(f.unpack({ maxBytes: 1024, maxFiles: 1 }, empty)).rejects.toThrow('ARCHIVE_LIMIT');
  const controller = new AbortController();
  controller.abort(Error('SYNTHETIC CANCELLED'));
  await expect(f.unpack({ maxBytes: 1024, signal: controller.signal }, empty)).rejects.toThrow(
    'SYNTHETIC CANCELLED',
  );
});

test('archive construction refuses source links and duplicate Windows paths', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.source, 'data.txt');
  await writeFile(file, 'SYNTHETIC');
  await link(file, path.join(f.source, 'alias.txt'));
  await expect(createArchive(f.source, f.archive)).rejects.toThrow('ARCHIVE_UNSAFE');
  await rm(path.join(f.source, 'alias.txt'));
  await symlink(
    f.target,
    path.join(f.source, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(createArchive(f.source, f.archive)).rejects.toThrow('ARCHIVE_UNSAFE');
  await writeFile(
    f.archive,
    zipSync({ 'same.txt': strToU8('A'), 'SAME.TXT': strToU8('B') }, { level: 0 }),
  );
  await expect(f.unpack({ maxBytes: 1024 })).rejects.toThrow('ARCHIVE_UNSAFE');
});

import { createHash } from 'node:crypto';
