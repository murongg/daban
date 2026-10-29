import * as crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { managedProtocol } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import {
  type Manifest,
  manifest,
  type Preparation,
  resourcesReady,
  run,
  unpack,
} from './environment';

it('requires durable ownership of empty preparation before extraction or image writes', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-preparation-permit-'));
  const resources = path.join(root, 'resources'),
    destination = path.join(root, 'owned');
  await fs.mkdir(resources);
  await fs.mkdir(destination, { mode: 0o700 });
  const raw = Buffer.from('SYNTHETIC IMAGE'),
    image = gzipSync(raw),
    archive = Buffer.from('SYNTHETIC TOOLS');
  const hash = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
  const value: Manifest = {
    version: 1,
    id: 'mock',
    platform: 'darwin',
    arch: 'arm64',
    versions: { lima: '2.2.1', node: '24.22.1', dsh: '0.2.1-rc.3', protocol: 27 },
    cpus: 2,
    memoryGiB: 3,
    diskGiB: 16,
    user: { name: 'daban', uid: 2000 },
    image: {
      file: 'system.raw.gz',
      bytes: image.length,
      sha256: hash(image),
      rawBytes: raw.length,
      rawSha256: hash(raw),
    },
    lima: { file: 'lima.tar.gz', bytes: archive.length, sha256: hash(archive) },
  };
  await fs.writeFile(path.join(resources, value.image.file), image);
  await fs.writeFile(path.join(resources, value.lima.file), archive);
  const owner = vi.fn(async (entry?: Preparation) => {
    if (!entry) return;
    const item = path.join(destination, entry.name),
      info = await fs.lstat(item);
    expect(info.ino).toBe(entry.ino);
    expect(info.dev).toBe(entry.dev);
    if (entry.kind === 'image') expect(info.size).toBe(0);
    else expect(await fs.readdir(item)).toEqual([]);
    throw new Error('SYNTHETIC_RECEIPT_FAILED');
  });
  const execute = vi.fn(async () => ({ code: 0, stdout: '' })),
    progress = vi.fn();
  try {
    await expect(
      resourcesReady(resources, destination, value, new AbortController().signal, execute, owner),
    ).rejects.toThrow();
    expect(owner.mock.calls.some(([entry]) => entry?.kind === 'tools')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      unpack(resources, destination, value, new AbortController().signal, progress, owner),
    ).rejects.toThrow();
    expect(owner.mock.calls.some(([entry]) => entry?.kind === 'image')).toBe(true);
    expect(progress).not.toHaveBeenCalled();
    expect(await fs.readdir(destination)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('accepts current and previous verified image protocols, binding the ID to the declared version', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-image-protocol-'));
  const digest = '1'.repeat(64);
  const value = {
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    cpus: 2,
    memoryGiB: 3,
    diskGiB: 16,
    versions: { lima: '2.2.1', node: '24.22.1', dsh: '0.2.1-rc.3', protocol: 27 },
    id: `daban-27-${digest.slice(0, 16)}`,
    user: { name: 'daban', uid: 2000 },
    image: {
      file: 'system.raw.gz',
      bytes: 1,
      rawBytes: 16 * 1024 ** 3,
      rawSha256: digest,
      sha256: digest,
    },
    lima: { file: 'lima.tar.gz', bytes: 1, sha256: digest },
  };
  const save = async () => fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(value));
  try {
    await save();
    expect((await manifest(root)).versions.protocol).toBe(27);
    value.versions.protocol = 26;
    await save();
    await expect(manifest(root)).rejects.toThrow('SETUP_PAYLOAD');
    value.id = `daban-26-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(26);
    value.versions.protocol = 28;
    value.id = `daban-28-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(28);
    value.versions.protocol = 29;
    value.id = `daban-29-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(29);
    value.versions.protocol = 30;
    value.id = `daban-30-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(30);
    value.versions.protocol = 31;
    value.id = `daban-31-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(31);
    value.versions.protocol = 32;
    value.id = `daban-32-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(32);
    value.versions.protocol = 33;
    value.id = `daban-33-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(33);
    value.versions.protocol = managedProtocol;
    value.id = `daban-${managedProtocol}-${digest.slice(0, 16)}`;
    await save();
    expect((await manifest(root)).versions.protocol).toBe(managedProtocol);
    value.versions.protocol = managedProtocol + 1;
    value.id = `daban-${managedProtocol + 1}-${digest.slice(0, 16)}`;
    await save();
    await expect(manifest(root)).rejects.toThrow('SETUP_PAYLOAD');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const uuids = vi.hoisted(() => ({ value: '' }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuids.value || actual.randomUUID() };
});

it('permits a real child only after its durable process receipt, and a failed receipt cannot execute it', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-setup-gate-'));
  const marker = path.join(root, 'marker');
  const receipt = path.join(root, 'receipt');
  const args = ['-c', 'test -f "$1" && printf SYNTHETIC > "$2"', 'mock', receipt, marker];
  try {
    await expect(
      run('/bin/sh', args, {
        permit: async () => {
          throw new Error('SYNTHETIC RECEIPT FAILED');
        },
      }),
    ).rejects.toThrow('SYNTHETIC RECEIPT FAILED');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await run('/bin/sh', args, {
      permit: async (identity) => {
        expect(identity.pid).toBeGreaterThan(1);
        expect(identity.started).not.toBe('');
        await fs.writeFile(receipt, 'SYNTHETIC DURABLE RECEIPT');
      },
    });
    expect(result.code).toBe(0);
    expect(await fs.readFile(marker, 'utf8')).toBe('SYNTHETIC');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('handles a child disappearing while its permit is being persisted without an unhandled pipe error', async () => {
  const result = await run('/usr/bin/true', [], {
    permit: async (identity) => {
      process.kill(identity.pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  expect(result.code).not.toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
});

it.each(['file', 'directory'])(
  'never removes a pre-existing temporary %s when exclusive allocation fails',
  async (kind) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-setup-collision-'));
    const id = '11111111-1111-4111-8111-111111111111';
    const resources = path.join(root, 'resources');
    const destination = path.join(root, 'destination');
    await fs.mkdir(resources);
    await fs.mkdir(destination);
    const raw = Buffer.from('SYNTHETIC RAW');
    const compressed = gzipSync(raw);
    const archive = Buffer.from('SYNTHETIC ARCHIVE');
    const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(resources, 'system.raw.gz'), compressed);
    await fs.writeFile(path.join(resources, 'lima.tar.gz'), archive);
    const value = {
      version: 1 as const,
      id: 'mock',
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      versions: { lima: '2.2.1', node: '24.22.1', dsh: '0.2.1-rc.3', protocol: 26 },
      cpus: 2,
      memoryGiB: 3,
      diskGiB: 16,
      user: { name: 'daban', uid: 2000 },
      image: {
        file: 'system.raw.gz',
        bytes: compressed.length,
        sha256: hash(compressed),
        rawBytes: raw.length,
        rawSha256: hash(raw),
      },
      lima: { file: 'lima.tar.gz', bytes: archive.length, sha256: hash(archive) },
    };
    const file = path.join(destination, `image-${id}.part`);
    const folder = path.join(destination, `tools-${id}`);
    await fs.writeFile(file, 'SYNTHETIC PROTECTED FILE');
    await fs.mkdir(folder, { mode: 0o700 });
    await fs.writeFile(path.join(folder, 'protected'), 'SYNTHETIC PROTECTED DIRECTORY');
    uuids.value = id;
    try {
      if (kind === 'file') {
        await expect(
          unpack(resources, destination, value, new AbortController().signal, () => {}),
        ).rejects.toBeDefined();
      } else {
        await expect(
          resourcesReady(resources, destination, value, new AbortController().signal, async () => ({
            code: 1,
            stdout: '',
          })),
        ).rejects.toBeDefined();
      }
      expect(await fs.readFile(file, 'utf8')).toBe('SYNTHETIC PROTECTED FILE');
      expect(await fs.readFile(path.join(folder, 'protected'), 'utf8')).toBe(
        'SYNTHETIC PROTECTED DIRECTORY',
      );
    } finally {
      uuids.value = '';
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
