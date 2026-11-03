import { expect, test, vi } from 'vitest';
import {
  componentAsset,
  componentIndex,
  componentPayload,
  componentTag,
  linuxIndex,
  linuxPayload,
} from './component.js';

const id = '1'.repeat(64);
const mac = { platform: 'darwin', arch: 'arm64', bytes: 1024, sha256: 'a'.repeat(64) };
const win = { platform: 'win32', arch: 'x64', bytes: 2048, sha256: 'b'.repeat(64) };

test('a host control protocol update does not invalidate the independently sealed QEMU environment', async () => {
  vi.resetModules();
  vi.doMock('@daban/protocol', async (original) => ({
    ...(await original<typeof import('@daban/protocol')>()),
    managedProtocol: 999,
  }));
  try {
    const { qemuIndex, windowsEnvironment } = await import('./component.js');
    const reference = {
      version: 1,
      protocol: windowsEnvironment.protocol,
      bytes: 4096,
      sha256: 'a'.repeat(64),
      unpackedBytes: 8192,
      requiredBytes: 8 * 1024 ** 3,
    };
    expect(qemuIndex(reference)).toEqual(reference);
    expect(() => qemuIndex({ ...reference, protocol: 999 })).toThrow('QEMU_DOWNLOAD_REFERENCE');
  } finally {
    vi.doUnmock('@daban/protocol');
    vi.resetModules();
  }
});

test('pins the optional Linux bundle and its signed Lima archive without accepting URL overrides', () => {
  const reference = {
    version: 1,
    id,
    lima: { bytes: 512, sha256: 'c'.repeat(64) },
    executor: { bytes: 128, sha256: 'd'.repeat(64) },
  };
  expect(linuxPayload(linuxIndex(reference, id), 'lima')).toStrictEqual({
    url: `https://github.com/murongg/daban/releases/download/runtime-${id.slice(0, 24)}/Daban-lima-macos-arm64.tar.gz`,
    bytes: 512,
    sha256: 'c'.repeat(64),
  });
  for (const value of [
    { ...reference, id: '2'.repeat(64) },
    { ...reference, url: 'https://example.test/override' },
    { ...reference, lima: { ...reference.lima, bytes: 0 } },
    { ...reference, executor: { ...reference.executor, sha256: 'invalid' } },
    { ...reference, lima: { ...reference.lima, sha256: 'invalid' } },
  ])
    expect(() => linuxIndex(value, id)).toThrowError(/COMPONENT_MANIFEST/);
});

test('pins component identity and constructs only fixed repository release URLs', () => {
  const index = componentIndex({ version: 1, id, assets: [mac, win] }, id);
  const selected = componentAsset(index, 'darwin', 'arm64');
  expect(componentTag(id)).toBe(`runtime-${id.slice(0, 24)}`);
  expect(componentPayload(id, selected)).toStrictEqual({
    url: `https://github.com/murongg/daban/releases/download/runtime-${id.slice(0, 24)}/Daban-runtime-macos-arm64.zip`,
    bytes: 1024,
    sha256: 'a'.repeat(64),
  });
  expect(componentAsset(index, 'win32', 'x64').bytes).toBe(2048);
});

test('rejects mismatched sources, duplicate platforms and invalid or executable URL overrides', () => {
  for (const value of [
    { version: 1, id: '2'.repeat(64), assets: [mac] },
    { version: 1, id, assets: [mac, mac] },
    { version: 1, id, assets: [{ ...mac, url: 'https://example.test/untrusted.zip' }] },
    { version: 1, id, assets: [{ ...mac, bytes: -1 }] },
    { version: 1, id, assets: [{ ...mac, sha256: 'invalid' }] },
    { version: 1, id, assets: [{ ...mac, platform: 'linux' }] },
    { version: 1, id, assets: [] },
  ])
    expect(() => componentIndex(value, id)).toThrowError(/COMPONENT_MANIFEST/);
  const index = componentIndex({ version: 1, id, assets: [mac] }, id);
  expect(() => componentAsset(index, 'win32', 'x64')).toThrowError(/COMPONENT_PLATFORM/);
  expect(() => componentTag('../escape')).toThrowError(/COMPONENT_MANIFEST/);
});
