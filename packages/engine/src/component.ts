import type { Payload } from './payload.js';

export interface ComponentAsset {
  platform: 'darwin' | 'win32';
  arch: 'arm64' | 'x64';
  bytes: number;
  sha256: string;
}
export interface ComponentIndex {
  version: 1;
  id: string;
  assets: ComponentAsset[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function asset(value: unknown): ComponentAsset {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some((key) => !['platform', 'arch', 'bytes', 'sha256'].includes(key)) ||
    !(
      (value.platform === 'darwin' && value.arch === 'arm64') ||
      (value.platform === 'win32' && value.arch === 'x64')
    ) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > 2 * 1024 ** 3 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw Error('COMPONENT_MANIFEST');
  return { platform: value.platform, arch: value.arch, bytes: value.bytes, sha256: value.sha256 };
}
export function componentTag(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('COMPONENT_MANIFEST');
  return `runtime-${id.slice(0, 24)}`;
}
export function componentIndex(value: unknown, id: string): ComponentIndex {
  componentTag(id);
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['version', 'id', 'assets'].includes(key)) ||
    value.version !== 1 ||
    value.id !== id ||
    !Array.isArray(value.assets) ||
    !value.assets.length ||
    value.assets.length > 2
  )
    throw Error('COMPONENT_MANIFEST');
  const assets = value.assets.map(asset);
  if (new Set(assets.map((item) => `${item.platform}:${item.arch}`)).size !== assets.length)
    throw Error('COMPONENT_MANIFEST');
  return { version: 1, id, assets };
}
export function componentAsset(index: ComponentIndex, platform: string, arch: string) {
  const found = index.assets.find((item) => item.platform === platform && item.arch === arch);
  if (!found) throw Error('COMPONENT_PLATFORM');
  return found;
}
export function componentFilename(value: ComponentAsset) {
  const item = asset(value);
  return `Daban-runtime-${item.platform === 'darwin' ? 'macos' : 'windows'}-${item.arch}.zip`;
}
export function componentPayload(id: string, value: ComponentAsset): Payload {
  const tag = componentTag(id),
    item = asset(value);
  return {
    url: `https://github.com/murongg/daban/releases/download/${tag}/${componentFilename(item)}`,
    bytes: item.bytes,
    sha256: item.sha256,
  };
}
