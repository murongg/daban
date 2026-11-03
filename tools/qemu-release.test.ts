import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractArchive } from '@daban/engine/archive';
import { qemuIndex, qemuPayload } from '@daban/engine/component';
import { secureDirectory } from '@daban/engine/local-computer';
import { managedProtocol } from '@daban/protocol';
import { expect, test } from 'vitest';
import { archiveQemu } from './qemu-release.ts';

const reference = {
  version: 1,
  protocol: managedProtocol,
  bytes: 4096,
  sha256: 'a'.repeat(64),
  unpackedBytes: 8192,
  requiredBytes: 8 * 1024 ** 3,
};

test('Windows environment downloads use a fixed content-addressed release independently of host updates', () => {
  expect(qemuPayload(qemuIndex(reference))).toEqual({
    url: `https://github.com/murongg/daban/releases/download/qemu-${reference.sha256.slice(0, 24)}/Daban-linux-windows-x64.zip`,
    bytes: reference.bytes,
    sha256: reference.sha256,
  });
});

test.each([
  { ...reference, url: 'https://untrusted.example.test/environment.zip' },
  { ...reference, version: 2 },
  { ...reference, protocol: managedProtocol - 1 },
  { ...reference, bytes: 0 },
  { ...reference, bytes: 2 * 1024 ** 3 + 1 },
  { ...reference, sha256: 'invalid' },
  { ...reference, unpackedBytes: 0 },
  { ...reference, unpackedBytes: 16 * 1024 ** 3 },
  { ...reference, requiredBytes: 1024 },
  { ...reference, requiredBytes: Infinity },
])('rejects untrusted or incompatible environment references (%j)', (value) => {
  expect(() => qemuIndex(value)).toThrow('QEMU_DOWNLOAD_REFERENCE');
});

test('builds a verified environment archive with reproducible bytes and excludes mutable build disks', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-qemu-release-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const source = await secureDirectory(path.join(temporary, 'source'));
  await secureDirectory(path.join(source, 'tools'));
  const digest = (bytes: Buffer) => ({
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const executable = Buffer.from('SYNTHETIC EXECUTABLE');
  const files = {
    'qemu-img.exe': digest(executable),
    'qemu-system-x86_64.exe': digest(executable),
  };
  const manifest = Buffer.from(JSON.stringify({ version: 1, files }));
  for (const name of Object.keys(files))
    await writeFile(path.join(source, 'tools', name), executable);
  await writeFile(path.join(source, 'tools/manifest.json'), manifest);
  const image = Buffer.from('SYNTHETIC IMAGE');
  await writeFile(path.join(source, 'desktop.qcow2.gz'), image);
  await writeFile(path.join(source, 'desktop.qcow2'), 'MUTABLE BUILD DISK MUST STAY LOCAL');
  await writeFile(
    path.join(source, 'qemu.json'),
    JSON.stringify({
      version: 1,
      protocol: managedProtocol,
      toolsId: digest(manifest).sha256,
      image: { ...digest(image), expandedBytes: 4096, expandedSha256: 'b'.repeat(64) },
    }),
  );
  await writeFile(path.join(source, 'COMPONENTS.md'), 'SYNTHETIC LICENSE NOTICES');
  await writeFile(path.join(source, 'provenance.json'), '{"source":"synthetic"}');
  const first = await archiveQemu(source, path.join(temporary, 'first'));
  const second = await archiveQemu(source, path.join(temporary, 'second'));
  expect(first.reference).toEqual(second.reference);
  expect(await readFile(first.file)).toEqual(await readFile(second.file));
  expect(first.reference.requiredBytes).toBeGreaterThan(4 * 1024 ** 3);
  const restored = path.join(source, '../restored');
  await extractArchive(first.file, restored, {
    sha256: first.reference.sha256,
    maxBytes: first.reference.unpackedBytes,
  });
  await expect(readFile(path.join(restored, 'desktop.qcow2'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await writeFile(path.join(source, 'tools/qemu-img.exe'), 'TAMPERED');
  await expect(archiveQemu(source, path.join(temporary, 'bad'))).rejects.toThrow(
    'QEMU_ASSET_INTEGRITY',
  );
});
