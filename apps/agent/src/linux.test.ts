import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { linuxAssets } from './linux.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-linux-assets-'));
  const entry = path.join(root, 'host');
  await mkdir(entry);
  const files = {
    lima: Buffer.from('SYNTHETIC LIMA'),
    executor: Buffer.from('SYNTHETIC EXECUTOR'),
  };
  const asset = (bytes: Buffer) => ({
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const reference = {
    version: 1,
    id: 'a'.repeat(64),
    lima: asset(files.lima),
    executor: asset(files.executor),
  };
  await writeFile(path.join(entry, 'linux.json'), JSON.stringify(reference));
  let requests = 0;
  const fetcher: typeof fetch = async (url) => {
    requests++;
    const bytes = String(url).includes('Daban-lima-') ? files.lima : files.executor;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  return {
    root,
    entry,
    files,
    reference,
    fetcher,
    requests: () => requests,
    dataRoot: path.join(root, 'private'),
  };
}

test('downloads Linux assets only when requested, reuses verified bytes, and repairs tampered cache contents', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const options = { dataRoot: f.dataRoot, entryDirectory: f.entry };
  expect(f.requests()).toBe(0);
  const first = await linuxAssets(options, { fetcher: f.fetcher });
  expect(await readFile(first.executorArchive, 'utf8')).toBe('SYNTHETIC EXECUTOR');
  expect(await readFile(first.limaArchive!, 'utf8')).toBe('SYNTHETIC LIMA');
  expect(first.limaDigest).toBe(f.reference.lima.sha256);
  await expect(lstat(path.join(f.dataRoot, 'execution'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await linuxAssets(options, { fetcher: f.fetcher })).toStrictEqual(first);
  expect(f.requests()).toBe(2);
  await writeFile(first.executorArchive, 'TAMPERED EXECUTOR');
  const repaired = await linuxAssets(options, { fetcher: f.fetcher });
  expect(await readFile(repaired.executorArchive, 'utf8')).toBe('SYNTHETIC EXECUTOR');
  expect(f.requests()).toBe(3);
});

test('rejects a corrupt download before publishing executable assets', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await expect(
    linuxAssets(
      { dataRoot: f.dataRoot, entryDirectory: f.entry },
      {
        fetcher: async () =>
          new Response(Buffer.alloc(f.files.lima.length), {
            headers: { 'content-length': String(f.files.lima.length) },
          }),
      },
    ),
  ).rejects.toThrowError(/PAYLOAD_INTEGRITY/);
  await expect(
    lstat(path.join(f.dataRoot, 'linux-cache', f.reference.lima.sha256 + '.tar.gz')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('keeps legacy bundled paths usable without any network request', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await rm(path.join(f.entry, 'linux.json'));
  const result = await linuxAssets(
    { dataRoot: f.dataRoot, entryDirectory: f.entry },
    { fetcher: f.fetcher },
  );
  expect(result.packDirectory).toBe(path.join(f.entry, '../environment'));
  expect(result.executorArchive).toBe(path.join(f.entry, 'executor.tar.gz'));
  expect(f.requests()).toBe(0);
});

test('a paused Linux download does not request bytes', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    linuxAssets(
      { dataRoot: f.dataRoot, entryDirectory: f.entry, signal: cancellation.signal },
      { fetcher: f.fetcher },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.requests()).toBe(0);
});
