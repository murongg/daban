import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { privateMetadata, secureDirectory } from './private-files.js';

export interface Payload {
  url: string;
  bytes: number;
  sha256: string;
}
export interface PayloadOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  progress?: (value: { received: number; total: number }) => unknown;
}
const active = new Map<string, { identity: string; result: Promise<string> }>();
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw Error('PAYLOAD_DESCRIPTOR');
  return url.href;
}
async function owned(file: string) {
  const info = await lstat(file).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (
    info &&
    (!info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      !(await privateMetadata(file, info, 0o600)))
  )
    throw Error('PAYLOAD_UNSAFE');
  return info;
}
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
async function digest(file: string, expected: Stats, signal?: AbortSignal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!sameFile(before, expected) || before.nlink !== 1) throw Error('PAYLOAD_UNSAFE');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error('PAYLOAD_UNSAFE');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
async function removeOwned(file: string, identity: Stats) {
  const info = await owned(file);
  if (!info || !sameFile(info, identity)) throw Error('PAYLOAD_UNSAFE');
  await unlink(file);
}
export async function payloadResponse(
  source: string,
  options: Pick<PayloadOptions, 'fetcher' | 'signal'> = {},
  offset = 0,
) {
  let url = secureUrl(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    options.signal?.throwIfAborted();
    const response = await (options.fetcher ?? fetch)(url, {
      signal: options.signal,
      credentials: 'omit',
      redirect: 'manual',
      ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw Error('PAYLOAD_DOWNLOAD_FAILED');
    url = secureUrl(new URL(location, url).href);
  }
  throw Error('PAYLOAD_DOWNLOAD_FAILED');
}
export async function downloadPayload(file: string, asset: Payload, options: PayloadOptions = {}) {
  try {
    secureUrl(asset.url);
    if (
      !path.isAbsolute(file) ||
      file.includes('\0') ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > 4 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw Error('PAYLOAD_DESCRIPTOR');
  } catch {
    throw Error('PAYLOAD_DESCRIPTOR');
  }
  options.signal?.throwIfAborted();
  const key = path.resolve(file),
    identity = JSON.stringify([asset.url, asset.bytes, asset.sha256]),
    pending = active.get(key);
  if (pending) {
    if (pending.identity !== identity) throw Error('PAYLOAD_BUSY');
    return pending.result;
  }
  const result = download(file, asset, options).finally(() => active.delete(key));
  active.set(key, { identity, result });
  return result;
}
async function download(file: string, asset: Payload, options: PayloadOptions) {
  const dir = await secureDirectory(path.dirname(file)),
    parent = await lstat(dir),
    target = path.join(dir, path.basename(file)),
    partial = target + '.part';
  const cached = await owned(target);
  if (cached) {
    if (
      cached.size === asset.bytes &&
      (await digest(target, cached, options.signal)) === asset.sha256
    ) {
      options.progress?.({ received: asset.bytes, total: asset.bytes });
      return target;
    }
    await removeOwned(target, cached);
  }
  const prior = await owned(partial);
  const handle = await open(
    partial,
    prior ? constants.O_RDWR | constants.O_NOFOLLOW : 'wx+',
    0o600,
  );
  const original = await handle.stat();
  let invalid = false,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if ((prior && !sameFile(prior, original)) || original.nlink !== 1)
      throw Error('PAYLOAD_UNSAFE');
    let received = original.size;
    if (received > asset.bytes) {
      await handle.truncate(0);
      received = 0;
    }
    if (received < asset.bytes) {
      const response = await payloadResponse(asset.url, options, received);
      reader = response.body?.getReader();
      if (response.status === 200) {
        await handle.truncate(0);
        received = 0;
      } else if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        if (
          !match ||
          Number(match[1]) !== received ||
          Number(match[2]) !== asset.bytes - 1 ||
          Number(match[3]) !== asset.bytes
        )
          throw Error('PAYLOAD_RANGE');
      } else throw Error('PAYLOAD_DOWNLOAD_FAILED');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes - received))
        throw Error('PAYLOAD_LENGTH');
      if (!reader) throw Error('PAYLOAD_DOWNLOAD_FAILED');
      options.progress?.({ received, total: asset.bytes });
      let percent = Math.floor((received / asset.bytes) * 100);
      for (;;) {
        options.signal?.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        if (received + part.value.byteLength > asset.bytes) {
          invalid = true;
          throw Error('PAYLOAD_LENGTH');
        }
        let offset = 0;
        while (offset < part.value.byteLength) {
          const written = await handle.write(
            part.value,
            offset,
            part.value.byteLength - offset,
            received + offset,
          );
          if (!written.bytesWritten) throw Error('PAYLOAD_WRITE');
          offset += written.bytesWritten;
        }
        received += part.value.byteLength;
        const next = Math.floor((received / asset.bytes) * 100);
        if (next !== percent) {
          percent = next;
          options.progress?.({ received, total: asset.bytes });
        }
      }
    }
    options.signal?.throwIfAborted();
    if (received !== asset.bytes) throw Error('PAYLOAD_INCOMPLETE');
    await handle.sync();
    if ((await digest(partial, await handle.stat(), options.signal)) !== asset.sha256) {
      invalid = true;
      throw Error('PAYLOAD_INTEGRITY');
    }
  } finally {
    await reader?.cancel().catch(() => {});
    await handle.close();
    if (invalid) await removeOwned(partial, original);
  }
  const current = await owned(partial),
    directory = await lstat(dir);
  if (
    !current ||
    !sameFile(current, original) ||
    !sameFile(parent, directory) ||
    directory.isSymbolicLink()
  )
    throw Error('PAYLOAD_UNSAFE');
  // Only a complete verified file becomes a cache hit; interrupted streams remain resumable data.
  await rename(partial, target);
  options.progress?.({ received: asset.bytes, total: asset.bytes });
  return target;
}
