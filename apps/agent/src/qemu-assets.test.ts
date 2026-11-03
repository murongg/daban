import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArchive } from '@daban/engine/archive';
import { secureDirectory } from '@daban/engine/local-computer';
import { managedProtocol } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { qemuResources, withQemuAssets } from './qemu-assets.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-qemu-download-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const source = await secureDirectory(path.join(root, 'source'));
  await writeFile(path.join(source, 'qemu.json'), 'SYNTHETIC MANIFEST');
  await writeFile(path.join(source, 'desktop.qcow2.gz'), 'SYNTHETIC IMAGE');
  const archive = path.join(root, 'environment.zip');
  const identity = await createArchive(source, archive);
  const bytes = await readFile(archive);
  const reference = {
    version: 1 as const,
    protocol: managedProtocol,
    ...identity,
    requiredBytes: 8 * 1024 ** 3,
  };
  const options = {
    dataRoot: await secureDirectory(path.join(root, 'agent')),
    bundleDirectory: path.join(root, 'missing'),
  };
  const requests: { url: string; range: string | null }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const range = new Headers(init?.headers).get('range');
    requests.push({ url: String(url), range });
    const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    return new Response(bytes.subarray(start), {
      status: start ? 206 : 200,
      headers: {
        'content-length': String(bytes.length - start),
        ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
      },
    });
  };
  return { temporary, source, bytes, reference, options, requests, fetcher };
}

test('status is network-free and installation reuses a verified content-addressed cache across host upgrades', async (t) => {
  const f = await fixture(t);
  const dependencies = { reference: f.reference, fetcher: f.fetcher };
  expect(await qemuResources(f.options, dependencies)).toMatchObject({
    downloadBytes: f.bytes.length,
    requiredBytes: f.reference.requiredBytes,
  });
  expect(f.requests).toEqual([]);
  let stage = '';
  const install = async (directory: string) => {
    stage = directory;
    expect(await readFile(path.join(directory, 'desktop.qcow2.gz'), 'utf8')).toBe(
      'SYNTHETIC IMAGE',
    );
  };
  await withQemuAssets(f.options, install, dependencies);
  await expect(readFile(path.join(stage, 'qemu.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await withQemuAssets(f.options, install, dependencies);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].url).toContain(`/qemu-${f.reference.sha256.slice(0, 24)}/`);
  const cache = path.join(f.options.dataRoot, 'qemu-cache', f.reference.sha256 + '.zip');
  await writeFile(cache, Buffer.alloc(f.bytes.length));
  await withQemuAssets(f.options, install, dependencies);
  expect(f.requests).toHaveLength(2);
});

test('a paused download keeps its partial bytes and resumes the exact range without publishing an environment', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let installed = false;
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(f.bytes.subarray(0, 40));
          stream.close();
        },
      }),
      { headers: { 'content-length': String(f.bytes.length) } },
    );
  await expect(
    withQemuAssets(
      {
        ...f.options,
        signal: controller.signal,
        progress: ({ received }) => {
          if (received >= 40) controller.abort();
        },
      },
      async () => {
        installed = true;
      },
      { reference: f.reference, fetcher },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(installed).toBe(false);
  expect(
    await readFile(path.join(f.options.dataRoot, 'qemu-cache', f.reference.sha256 + '.zip.part')),
  ).toEqual(f.bytes.subarray(0, 40));
  await withQemuAssets(
    f.options,
    async () => {
      installed = true;
    },
    { reference: f.reference, fetcher: f.fetcher },
  );
  expect(f.requests[0].range).toBe('bytes=40-');
  expect(installed).toBe(true);
});

test('bad bytes and rejected installers never publish a reusable extracted directory', async (t) => {
  const f = await fixture(t);
  let installed = false;
  await expect(
    withQemuAssets(
      f.options,
      async () => {
        installed = true;
      },
      { reference: f.reference, fetcher: async () => new Response(Buffer.alloc(f.bytes.length)) },
    ),
  ).rejects.toThrow('PAYLOAD_INTEGRITY');
  expect(installed).toBe(false);
  let stage = '';
  await expect(
    withQemuAssets(
      f.options,
      async (directory) => {
        stage = directory;
        throw Error('SYNTHETIC INSTALL FAILED');
      },
      { reference: f.reference, fetcher: f.fetcher },
    ),
  ).rejects.toThrow('SYNTHETIC INSTALL FAILED');
  await expect(readFile(path.join(stage, 'qemu.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('network failures produce a retryable download error without starting the installer', async (t) => {
  const f = await fixture(t);
  let installed = false;
  await expect(
    withQemuAssets(
      f.options,
      async () => {
        installed = true;
      },
      {
        reference: f.reference,
        fetcher: async () => {
          throw TypeError('SYNTHETIC NETWORK FAILURE');
        },
      },
    ),
  ).rejects.toThrow('QEMU_DOWNLOAD_FAILED');
  expect(installed).toBe(false);
});
