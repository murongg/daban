import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { componentIndex } from '@daban/engine/component';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import type { SetupStatus } from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { componentPaths } from './component-install';
import { Components, readComponentReference } from './components';

const hooks = vi.hoisted(() => ({ pointer: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]).endsWith('current.json')) await hooks.pointer?.();
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.pointer = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-runtime-preparation-'));
  roots.push(root);
  // Fresh private children receive Windows ACLs; mkdtemp inherits the shared temp ACL.
  const directory = await secureDirectory(path.join(root, 'private'));
  const bytes = Buffer.from('SYNTHETIC VERIFIED COMPONENT ARCHIVE'),
    id = 'a'.repeat(64);
  const options = {
    directory,
    platform: 'darwin' as const,
    arch: 'arm64',
    publisher: path.join(directory, 'SyntheticClient.app'),
    reference: componentIndex(
      {
        version: 1,
        id,
        assets: [
          {
            platform: 'darwin',
            arch: 'arm64',
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      id,
    ),
    fetcher: vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
    ),
  };
  const extract = vi.fn(async (_archive: string, target: string) => {
    const paths = componentPaths(target, 'darwin');
    await mkdir(path.dirname(paths.entry), { recursive: true });
    await mkdir(path.dirname(paths.executable), { recursive: true });
    await writeFile(paths.entry, 'SYNTHETIC HOST MAIN');
    await writeFile(paths.executable, 'SYNTHETIC NODE', { mode: 0o700 });
  });
  const verify = vi.fn(async (input: { directory: string }) => {
    const files = componentPaths(input.directory, 'darwin');
    await lstat(files.entry);
    await lstat(files.executable);
  });
  return { options, bytes, extract, verify };
}

it('prepares a component once and checks its cached installation again after restart', async () => {
  const f = await fixture(),
    changes: SetupStatus[] = [];
  const first = new Components(f.options, f);
  const files = await first.prepare((status) => changes.push(status));
  expect(await readFile(files.entry, 'utf8')).toBe('SYNTHETIC HOST MAIN');
  expect(changes.some((item) => item.phase === 'downloading')).toBe(true);
  expect(first.status()).toMatchObject({ required: false, target: 'agent', phase: 'complete' });
  await expect(first.cancel()).resolves.toMatchObject({ phase: 'complete', required: false });
  const next = new Components(f.options, f);
  expect(await next.prepare()).toEqual(files);
  expect(f.options.fetcher).toHaveBeenCalledTimes(1);
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(f.verify).toHaveBeenCalledTimes(2);
});

it('prepares the bundled runtime offline and applies the same archive integrity and installation verification', async () => {
  const f = await fixture();
  const archive = path.join(f.options.directory, 'bundled.zip');
  await writeFile(archive, f.bytes);
  const source = new Components({ ...f.options, bundledArchive: archive }, f);
  await source.prepare();
  expect(f.options.fetcher).not.toHaveBeenCalled();
  expect(f.verify).toHaveBeenCalledTimes(1);
  const cached = Reflect.get(source, 'archive') as string;
  expect(await privateMetadata(cached, await lstat(cached), 0o600)).toBe(true);
  const broken = await fixture();
  await writeFile(archive, 'SYNTHETIC CORRUPTION');
  await expect(
    new Components({ ...broken.options, bundledArchive: archive }, broken).prepare(),
  ).rejects.toThrow('COMPONENT_INTEGRITY');
  expect(broken.extract).not.toHaveBeenCalled();
});

it('repairs a damaged cache into a new generation without rewriting the old executable', async () => {
  const f = await fixture(),
    first = new Components(f.options, f);
  const old = await first.prepare();
  await rm(old.entry);
  const next = new Components(f.options, f),
    files = await next.prepare();
  expect(files.entry).not.toBe(old.entry);
  expect(await readFile(old.executable, 'utf8')).toBe('SYNTHETIC NODE');
  expect(await readFile(files.entry, 'utf8')).toBe('SYNTHETIC HOST MAIN');
  expect(f.options.fetcher).toHaveBeenCalledTimes(1);
});

it('never publishes a component whose trust verification fails', async () => {
  const f = await fixture();
  f.verify.mockRejectedValueOnce(new Error('COMPONENT_SIGNATURE'));
  const source = new Components(f.options, f);
  await expect(source.prepare()).rejects.toThrow('COMPONENT_SIGNATURE');
  expect(source.status()).toMatchObject({
    required: true,
    phase: 'failed',
    error: 'COMPONENT_SIGNATURE',
  });
});

it('persists an explicit pause and resumes partial bytes only after the user continues', async () => {
  const f = await fixture();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  f.options.fetcher.mockImplementationOnce(async (_input: unknown, init?: RequestInit) => {
    init?.signal?.addEventListener('abort', () => stream?.error(new Error('SYNTHETIC_ABORT')));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(f.bytes.subarray(0, 5));
        },
      }),
      { headers: { 'content-length': String(f.bytes.length) } },
    );
  });
  const source = new Components(f.options, f);
  let paused: Promise<SetupStatus> | undefined;
  await expect(
    source.prepare((status) => {
      if (status.downloaded === 5 && !paused) paused = source.cancel();
    }),
  ).rejects.toThrow('COMPONENT_PAUSED');
  await paused;
  expect(source.status().phase).toBe('cancelled');
  const reopened = new Components(f.options, f);
  await expect(reopened.prepare()).rejects.toThrow('COMPONENT_PAUSED');
  expect(f.options.fetcher).toHaveBeenCalledTimes(1);
  f.options.fetcher.mockImplementationOnce(async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('range')).toBe('bytes=5-');
    return new Response(f.bytes.subarray(5), {
      status: 206,
      headers: {
        'content-range': `bytes 5-${f.bytes.length - 1}/${f.bytes.length}`,
        'content-length': String(f.bytes.length - 5),
      },
    });
  });
  await reopened.resume();
  expect(reopened.status().phase).toBe('complete');
});

it('loads a bounded reference from application resources', async () => {
  const f = await fixture();
  const file = path.join(f.options.directory, 'runtime.json');
  expect(await readComponentReference(file)).toBeUndefined();
  await writeFile(file, JSON.stringify(f.options.reference));
  expect(await readComponentReference(file)).toEqual(f.options.reference);
  await writeFile(
    file,
    JSON.stringify({ ...f.options.reference, url: 'https://example.test/untrusted' }),
  );
  await expect(readComponentReference(file)).rejects.toThrow();
});

it('a pause at atomic publication prevents launch and keeps the verified cache for continuation', async () => {
  const f = await fixture();
  let signal: AbortSignal | undefined;
  const owner = new Components(f.options, {
    extract: f.extract,
    verify: async (options) => {
      signal = options.signal;
      await f.verify(options);
    },
  });
  let pause: Promise<SetupStatus> | undefined;
  hooks.pointer = async () => {
    pause = owner.cancel();
    if (!signal?.aborted)
      await new Promise<unknown>((resolve) =>
        signal!.addEventListener('abort', () => resolve(undefined), { once: true }),
      );
  };
  await expect(owner.prepare()).rejects.toThrow('COMPONENT_PAUSED');
  await pause;
  hooks.pointer = undefined;
  const files = await owner.resume();
  expect(await readFile(files.entry, 'utf8')).toBe('SYNTHETIC HOST MAIN');
  expect(f.options.fetcher).toHaveBeenCalledTimes(1);
  await owner.close();
});
