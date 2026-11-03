import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EnvironmentImage } from '@daban/protocol';
import { expect, test } from 'vitest';
import { imageFile } from './image.js';

test('fetches and caches only the requested Linux image without creating a VM', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-optional-image-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const packDirectory = path.join(root, 'pack'),
    dataRoot = path.join(root, 'private');
  await mkdir(packDirectory);
  const bytes = Buffer.from('SYNTHETIC COMPRESSED IMAGE');
  const image: EnvironmentImage = {
    id: 'synthetic-image',
    file: 'system.raw.gz',
    url: 'https://example.test/image.gz',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    rawBytes: 100,
    rawSha256: 'a'.repeat(64),
  };
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const first = await imageFile({ packDirectory, dataRoot }, { image, fetcher });
  expect(await readFile(first)).toStrictEqual(bytes);
  expect(await imageFile({ packDirectory, dataRoot }, { image, fetcher })).toBe(first);
  expect(requests).toBe(1);
  await expect(lstat(path.join(dataRoot, 'execution'))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(packDirectory, image.file), 'SYNTHETIC LEGACY BUNDLED IMAGE');
  expect(await imageFile({ packDirectory, dataRoot }, { image, fetcher })).toBe(
    path.join(packDirectory, image.file),
  );
  expect(requests).toBe(1);
});
