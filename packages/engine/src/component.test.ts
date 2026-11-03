import assert from 'node:assert/strict';
import test from 'node:test';
import { componentAsset, componentIndex, componentPayload, componentTag } from './component.js';

const id = '1'.repeat(64);
const mac = { platform: 'darwin', arch: 'arm64', bytes: 1024, sha256: 'a'.repeat(64) };
const win = { platform: 'win32', arch: 'x64', bytes: 2048, sha256: 'b'.repeat(64) };

test('pins component identity and constructs only fixed repository release URLs', () => {
  const index = componentIndex({ version: 1, id, assets: [mac, win] }, id);
  const selected = componentAsset(index, 'darwin', 'arm64');
  assert.equal(componentTag(id), `runtime-${id.slice(0, 24)}`);
  assert.deepEqual(componentPayload(id, selected), {
    url: `https://github.com/murongg/daban/releases/download/runtime-${id.slice(0, 24)}/Daban-runtime-macos-arm64.zip`,
    bytes: 1024,
    sha256: 'a'.repeat(64),
  });
  assert.equal(componentAsset(index, 'win32', 'x64').bytes, 2048);
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
    assert.throws(() => componentIndex(value, id), /COMPONENT_MANIFEST/);
  const index = componentIndex({ version: 1, id, assets: [mac] }, id);
  assert.throws(() => componentAsset(index, 'win32', 'x64'), /COMPONENT_PLATFORM/);
  assert.throws(() => componentTag('../escape'), /COMPONENT_MANIFEST/);
});
