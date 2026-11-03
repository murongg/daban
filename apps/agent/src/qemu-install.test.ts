import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { secureDirectory } from '@daban/engine/local-computer';
import { expect, test } from 'vitest';
import { parseQemuBundle, unpackQemuImage } from './qemu-install.js';
import { writeQemuRecord } from './qemu-store.js';

test('bundled QEMU payload rejects path escapes, wrong protocol and unbounded resources', () => {
  const image = {
    bytes: 10,
    sha256: 'a'.repeat(64),
    expandedBytes: 20,
    expandedSha256: 'b'.repeat(64),
  };
  const value = { version: 1, protocol: 44, image, toolsId: 'c'.repeat(64) };
  expect(parseQemuBundle(value)).toEqual(value);
  for (const unsafe of [
    { ...value, protocol: 43 },
    { ...value, source: '../disk' },
    { ...value, image: { ...image, bytes: 0 } },
    { ...value, image: { ...image, expandedBytes: 1024 ** 5 } },
  ])
    expect(() => parseQemuBundle(unsafe)).toThrow('QEMU_BUNDLE_INVALID');
});

test('image expansion checks both hashes and preserves a completed disk on retry', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-qemu-image-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const bundle = path.join(temporary, 'bundle');
  await mkdir(bundle);
  const raw = Buffer.from('SYNTHETIC QCOW2 CONTENT');
  const compressed = gzipSync(raw);
  await writeFile(path.join(bundle, 'desktop.qcow2.gz'), compressed);
  const image = {
    bytes: compressed.length,
    sha256: createHash('sha256').update(compressed).digest('hex'),
    expandedBytes: raw.length,
    expandedSha256: createHash('sha256').update(raw).digest('hex'),
  };
  await writeQemuRecord(path.join(root, 'origin.json'), { version: 1, bundle: 'a'.repeat(64) });
  await unpackQemuImage(bundle, root, image, new AbortController().signal);
  expect(await readFile(path.join(root, 'disk.qcow2'))).toEqual(raw);
  await writeFile(path.join(root, 'disk.qcow2'), 'SYNTHETIC GUEST WRITES');
  await expect(unpackQemuImage(bundle, root, image, new AbortController().signal)).rejects.toThrow(
    'QEMU_EXISTING_DISK',
  );
  expect(await readFile(path.join(root, 'disk.qcow2'), 'utf8')).toBe('SYNTHETIC GUEST WRITES');
  await rm(path.join(root, 'disk.qcow2'));
  await expect(
    unpackQemuImage(
      bundle,
      root,
      { ...image, expandedSha256: '0'.repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow('QEMU_ASSET_INTEGRITY');
  await expect(readFile(path.join(root, 'disk.qcow2'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('cancelling image extraction removes only its unpublished output and permits a fresh explicit retry', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-qemu-pause-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private')),
    bundle = path.join(temporary, 'bundle');
  await mkdir(bundle);
  const raw = Buffer.alloc(1024 ** 2, 47),
    compressed = gzipSync(raw);
  await writeFile(path.join(bundle, 'desktop.qcow2.gz'), compressed);
  const image = {
    bytes: compressed.length,
    sha256: createHash('sha256').update(compressed).digest('hex'),
    expandedBytes: raw.length,
    expandedSha256: createHash('sha256').update(raw).digest('hex'),
  };
  const cancellation = new AbortController();
  await expect(
    unpackQemuImage(bundle, root, image, cancellation.signal, () => cancellation.abort()),
  ).rejects.toThrow();
  await expect(readFile(path.join(root, 'disk.qcow2'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(bundle, 'desktop.qcow2.gz'))).toEqual(compressed);
  await unpackQemuImage(bundle, root, image, new AbortController().signal);
  expect(await readFile(path.join(root, 'disk.qcow2'))).toEqual(raw);
});
