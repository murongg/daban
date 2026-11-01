import { once } from 'node:events';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, join } from 'node:path';
import { privateClientOptions, privateMetadata } from '@daban/engine/local-computer';
import { botBundleLimit } from '@daban/protocol';
import { socketReady } from './socket';

const origin = 'http://127.0.0.1:8766';
// User uploads can contain 100 MiB of originals before base64 encoding and JSON framing.
const uploadLimit = Math.ceil(botBundleLimit / 3) * 4 + 4 * 1024 * 1024;
const aborted = () => new DOMException('Agent request aborted', 'AbortError');

export async function readAgentToken(dataRoot: string) {
  // Returning undefined would authorize RuntimeClient's legacy HTML-token fallback.
  const uid = process.getuid?.();
  if ((process.platform !== 'win32' && uid === undefined) || !isAbsolute(dataRoot))
    throw new Error('AGENT_AUTH_UNAVAILABLE');
  try {
    for (const folder of [dataRoot, join(dataRoot, 'model')]) {
      const info = await fs.lstat(folder);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !(await privateMetadata(folder, info, 0o700))
      )
        throw new Error('AGENT_AUTH_UNAVAILABLE');
    }
    const file = await fs.open(
      join(dataRoot, 'model/control-token'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        !(await privateMetadata(join(dataRoot, 'model/control-token'), info, 0o600)) ||
        info.nlink !== 1 ||
        info.size < 64 ||
        info.size > 65
      )
        throw new Error('AGENT_AUTH_UNAVAILABLE');
      const bytes = Buffer.alloc(66);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, bytesRead).toString('utf8');
      if (!/^[a-f0-9]{64}\n?$/.test(value)) throw new Error('AGENT_AUTH_UNAVAILABLE');
      return value.trim();
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('AGENT_AUTH_UNAVAILABLE');
  }
}

export function unixFetch(
  socketPath: string,
  options: { maxBytes?: number; certificateFile?: string } = {},
) {
  const limit = options.maxBytes ?? uploadLimit;
  if (
    !isAbsolute(socketPath) ||
    socketPath.includes('\0') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > uploadLimit
  )
    throw new Error('AGENT_REQUEST_DENIED');
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    let target: URL;
    try {
      target = new URL(url);
      if (target.origin !== origin || target.username || target.password || target.hash)
        throw new Error('AGENT_REQUEST_DENIED');
    } catch {
      throw new Error('AGENT_REQUEST_DENIED');
    }
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      // Reviewed power operations run separately bounded stop, VM-start and executor-start commands.
      AbortSignal.timeout(600000),
    ]);
    if (signal.aborted) throw aborted();
    const value = init.body;
    if (
      (typeof value === 'string' && Buffer.byteLength(value) > limit) ||
      (value instanceof ArrayBuffer && value.byteLength > limit) ||
      (ArrayBuffer.isView(value) && value.byteLength > limit) ||
      (value instanceof Blob && value.size > limit)
    )
      throw new Error('AGENT_REQUEST_TOO_LARGE');
    try {
      if (!(await socketReady(socketPath))) throw new Error('AGENT_SOCKET_UNSAFE');
      if (process.platform !== 'win32') {
        const info = await fs.lstat(socketPath);
        if (!info.isSocket()) throw new Error('AGENT_SOCKET_UNSAFE');
      }
    } catch {
      throw new Error('AGENT_SOCKET_UNSAFE');
    }
    if (signal.aborted) throw aborted();
    const body = value === undefined || value === null ? undefined : new Response(value);
    const reader = body?.body?.getReader();
    const headers = new Headers(init.headers);
    headers.set('host', new URL(origin).host);
    if (body?.headers.has('content-type') && !headers.has('content-type'))
      headers.set('content-type', body.headers.get('content-type')!);
    const tls = await privateClientOptions(options.certificateFile);
    const request = process.platform === 'win32' ? httpsRequest : httpRequest;
    let requestError = 'AGENT_REQUEST_UNAVAILABLE';
    try {
      return await new Promise<Response>((done, reject) => {
        const connection = request(
          {
            ...tls,
            socketPath,
            // Model proxy configuration must never reroute this private control connection.
            agent: false,
            method: init.method || 'GET',
            path: target.pathname + target.search,
            headers: Object.fromEntries(headers),
            signal,
          },
          (response) => {
            let size = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                requestError = 'AGENT_RESPONSE_TOO_LARGE';
                reject(new Error(requestError));
                connection.destroy(new Error(requestError));
                return;
              }
              chunks.push(chunk);
            });
            response.once('error', () =>
              reject(signal.aborted ? aborted() : new Error(requestError)),
            );
            response.once('end', () => {
              try {
                const returned = new Headers();
                for (const [name, values] of Object.entries(response.headers))
                  if (values !== undefined)
                    for (const entry of Array.isArray(values) ? values : [values])
                      returned.append(name, entry);
                const status = response.statusCode || 502;
                done(
                  new Response(
                    [204, 205, 304].includes(status) || init.method === 'HEAD'
                      ? null
                      : Buffer.concat(chunks),
                    { status, headers: returned },
                  ),
                );
              } catch {
                reject(new Error('AGENT_REQUEST_UNAVAILABLE'));
              }
            });
          },
        );
        const cancelBody = () => {
          reader?.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancelBody, { once: true });
        connection.once('close', () => {
          signal.removeEventListener('abort', cancelBody);
          cancelBody();
        });
        connection.once('error', () =>
          reject(signal.aborted ? aborted() : new Error(requestError)),
        );
        const send = async () => {
          let size = 0;
          if (reader)
            for (;;) {
              if (signal.aborted) throw aborted();
              const next = await reader.read();
              if (next.done) break;
              // Non-byte stream chunks would bypass byteLength accounting before Node writes them.
              if (
                !ArrayBuffer.isView(next.value) ||
                Object.prototype.toString.call(next.value) !== '[object Uint8Array]'
              )
                throw new Error(requestError);
              size += next.value.byteLength;
              if (size > limit) {
                requestError = 'AGENT_REQUEST_TOO_LARGE';
                throw new Error(requestError);
              }
              if (!connection.write(next.value)) await once(connection, 'drain', { signal });
            }
          connection.end();
        };
        send().catch(() => connection.destroy(new Error(requestError)));
      });
    } catch {
      if (signal.aborted) throw aborted();
      throw new Error(requestError);
    } finally {
      reader?.cancel().catch(() => {});
    }
  };
}
