import { windowsEnvironment } from './qemu-reference.js';

export { windowsEnvironment };

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
export interface LinuxIndex {
  version: 1;
  id: string;
  lima: Pick<Payload, 'bytes' | 'sha256'>;
  executor: Pick<Payload, 'bytes' | 'sha256'>;
}
export interface QemuIndex {
  version: 1;
  protocol: number;
  bytes: number;
  sha256: string;
  unpackedBytes: number;
  requiredBytes: number;
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
export function componentIndex(value: unknown, id?: string): ComponentIndex {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['version', 'id', 'assets'].includes(key)) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    (id !== undefined && value.id !== id) ||
    !Array.isArray(value.assets) ||
    !value.assets.length ||
    value.assets.length > 2
  )
    throw Error('COMPONENT_MANIFEST');
  componentTag(value.id);
  const assets = value.assets.map(asset);
  if (new Set(assets.map((item) => `${item.platform}:${item.arch}`)).size !== assets.length)
    throw Error('COMPONENT_MANIFEST');
  return { version: 1, id: value.id, assets };
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

export function linuxIndex(value: unknown, id: string): LinuxIndex {
  componentTag(id);
  if (!record(value) || Object.keys(value).length !== 4 || value.version !== 1 || value.id !== id)
    throw Error('COMPONENT_MANIFEST');
  const payload = (item: unknown) => {
    if (!record(item) || Object.keys(item).length !== 2) throw Error('COMPONENT_MANIFEST');
    const checked = asset({ ...item, platform: 'darwin', arch: 'arm64' });
    return { bytes: checked.bytes, sha256: checked.sha256 };
  };
  return { version: 1, id, lima: payload(value.lima), executor: payload(value.executor) };
}
export function linuxFilename(kind: 'lima' | 'executor') {
  return kind === 'lima' ? 'Daban-lima-macos-arm64.tar.gz' : 'Daban-executor-linux-arm64.tar.gz';
}
export function linuxPayload(index: LinuxIndex, kind: 'lima' | 'executor'): Payload {
  const checked = linuxIndex(index, index.id);
  return {
    url: `https://github.com/murongg/daban/releases/download/${componentTag(checked.id)}/${linuxFilename(kind)}`,
    ...checked[kind],
  };
}

export function qemuIndex(value: unknown): QemuIndex {
  if (
    !record(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 1 ||
    // This is the sealed guest's stamp; host chat changes do not change its executor interface.
    value.protocol !== windowsEnvironment.protocol ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > 2 * 1024 ** 3 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.unpackedBytes !== 'number' ||
    !Number.isSafeInteger(value.unpackedBytes) ||
    value.unpackedBytes <= 0 ||
    value.unpackedBytes > 8 * 1024 ** 3 ||
    typeof value.requiredBytes !== 'number' ||
    !Number.isSafeInteger(value.requiredBytes) ||
    value.requiredBytes < value.unpackedBytes + 4 * 1024 ** 3 ||
    value.requiredBytes > 128 * 1024 ** 3
  )
    throw Error('QEMU_DOWNLOAD_REFERENCE');
  return value as unknown as QemuIndex;
}
export function qemuFilename() {
  return 'Daban-linux-windows-x64.zip';
}
export function qemuTag(index: QemuIndex) {
  return `qemu-${qemuIndex(index).sha256.slice(0, 24)}`;
}
export function qemuPayload(index: QemuIndex): Payload {
  const checked = qemuIndex(index);
  // Environment identity follows its bytes, so host upgrades retain the same resumable download cache.
  return {
    url: `https://github.com/murongg/daban/releases/download/${qemuTag(checked)}/${qemuFilename()}`,
    bytes: checked.bytes,
    sha256: checked.sha256,
  };
}
