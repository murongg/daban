import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { downloadPayload, type PayloadOptions } from '@daban/engine/payload';
import { type EnvironmentImage, environmentImage } from '@daban/protocol';

export async function imageFile(
  options: {
    dataRoot: string;
    packDirectory: string;
    signal?: AbortSignal;
    progress?: PayloadOptions['progress'];
  },
  dependencies: { image?: EnvironmentImage; fetcher?: typeof fetch } = {},
) {
  options.signal?.throwIfAborted();
  const image = dependencies.image ?? environmentImage;
  const bundled = path.join(options.packDirectory, image.file);
  const existing = await lstat(bundled).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw Error('AGENT_IMAGE_INTEGRITY');
    // Legacy bundles remain usable; materializeImage verifies compressed and raw hashes before VM creation.
    return bundled;
  }
  const cache = await secureDirectory(path.join(options.dataRoot, 'image-cache'));
  return downloadPayload(path.join(cache, image.sha256 + '.gz'), image, {
    fetcher: dependencies.fetcher,
    signal: options.signal,
    progress: options.progress,
  });
}
