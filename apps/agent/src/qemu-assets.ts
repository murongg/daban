import { lstat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractArchive } from '@daban/engine/archive';
import {
  type QemuIndex,
  qemuIndex,
  qemuPayload,
  windowsEnvironment,
} from '@daban/engine/component';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import { downloadPayload, type PayloadOptions } from '@daban/engine/payload';
import { readQemuBundle } from './qemu-install.js';

interface Options {
  dataRoot: string;
  bundleDirectory: string;
  signal?: AbortSignal;
  progress?: PayloadOptions['progress'];
  extracting?: () => Promise<unknown>;
}
interface Dependencies {
  reference?: QemuIndex;
  fetcher?: typeof fetch;
}
async function bundled(directory: string) {
  return lstat(path.join(directory, 'qemu.json')).then(
    () => true,
    (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
}
async function retainedBytes(root: string, reference: QemuIndex) {
  const cache = path.join(root, 'qemu-cache');
  const exists = await lstat(cache).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (!exists) return 0;
  await secureDirectory(cache);
  let retained = 0;
  for (const suffix of ['.zip', '.zip.part']) {
    const file = path.join(cache, reference.sha256 + suffix);
    const info = await lstat(file).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw Error('QEMU_ASSET_UNSAFE');
    if (!(await privateMetadata(file, info, 0o600))) {
      // A status observation may race the verified .part -> .zip rename. Live unsafe objects still fail closed.
      const current = await lstat(file).catch((error) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          return undefined;
        throw error;
      });
      if (!current) continue;
      throw Error('QEMU_ASSET_UNSAFE');
    }
    retained = Math.max(retained, Math.min(info.size, reference.bytes));
  }
  return retained;
}
export async function qemuResources(options: Options, dependencies: Dependencies = {}) {
  if (await bundled(options.bundleDirectory)) {
    const bundle = await readQemuBundle(options.bundleDirectory);
    return { requiredBytes: bundle.image.expandedBytes + 4 * 1024 ** 3, downloadBytes: 0 };
  }
  const reference = qemuIndex(dependencies.reference ?? windowsEnvironment);
  // Retained bytes already consume free space. Count only the remaining reservation on pause/retry;
  // a corrupt cache is removed before replacement, so the download still fits this budget.
  const retained = await retainedBytes(options.dataRoot, reference);
  return { requiredBytes: reference.requiredBytes - retained, downloadBytes: reference.bytes };
}

export async function withQemuAssets<T>(
  options: Options,
  install: (directory: string) => Promise<T>,
  dependencies: Dependencies = {},
) {
  options.signal?.throwIfAborted();
  if (await bundled(options.bundleDirectory)) return install(options.bundleDirectory);
  const reference = qemuIndex(dependencies.reference ?? windowsEnvironment);
  const cache = await secureDirectory(path.join(options.dataRoot, 'qemu-cache'));
  const archive = await downloadPayload(
    path.join(cache, reference.sha256 + '.zip'),
    qemuPayload(reference),
    {
      fetcher: dependencies.fetcher,
      signal: options.signal,
      progress: options.progress,
    },
  ).catch((error) => {
    options.signal?.throwIfAborted();
    if (error instanceof TypeError || (error instanceof Error && !/^[A-Z_]+$/.test(error.message)))
      throw Error('QEMU_DOWNLOAD_FAILED');
    throw error;
  });
  options.signal?.throwIfAborted();
  await options.extracting?.();
  const stage = await mkdtemp(path.join(cache, '.stage-'));
  const cleanup = async () => {
    if (path.dirname(path.resolve(stage)) !== path.resolve(cache)) throw Error('QEMU_STAGE_UNSAFE');
    await rm(stage, { recursive: true, force: true });
  };
  try {
    await secureDirectory(stage);
    const bytes = await extractArchive(archive, stage, {
      sha256: reference.sha256,
      maxBytes: reference.unpackedBytes,
      signal: options.signal,
    });
    if (bytes !== reference.unpackedBytes) throw Error('QEMU_ASSET_INTEGRITY');
    options.signal?.throwIfAborted();
    return await install(stage);
  } finally {
    // Only disposable extraction files live here; verified ZIPs and resumable downloads survive a pause.
    await cleanup();
  }
}
