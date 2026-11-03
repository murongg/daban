import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { linuxIndex, linuxPayload } from '@daban/engine/component';
import { downloadPayload, type PayloadOptions } from '@daban/engine/payload';

export async function linuxAssets(
  options: {
    dataRoot: string;
    entryDirectory: string;
    signal?: AbortSignal;
    progress?: PayloadOptions['progress'];
  },
  dependencies: { fetcher?: typeof fetch } = {},
) {
  options.signal?.throwIfAborted();
  const packDirectory = path.join(options.entryDirectory, '../environment');
  const handle = await open(
    path.join(options.entryDirectory, 'linux.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (!handle) {
    // Older signed distributions keep their Linux resources beside the agent.
    return { packDirectory, executorArchive: path.join(options.entryDirectory, 'executor.tar.gz') };
  }
  let value: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw Error('COMPONENT_MANIFEST');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string')
    throw Error('COMPONENT_MANIFEST');
  // This reference is sealed inside the signed host runtime; downloads cannot choose their own hashes or URLs.
  const reference = linuxIndex(value, value.id);
  const fetchAsset = async (kind: 'lima' | 'executor') =>
    downloadPayload(
      path.join(options.dataRoot, 'linux-cache', reference[kind].sha256 + '.tar.gz'),
      linuxPayload(reference, kind),
      { fetcher: dependencies.fetcher, signal: options.signal, progress: options.progress },
    );
  const limaArchive = await fetchAsset('lima');
  const executorArchive = await fetchAsset('executor');
  return { packDirectory, limaArchive, limaDigest: reference.lima.sha256, executorArchive };
}
