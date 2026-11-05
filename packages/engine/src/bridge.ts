import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute } from 'node:path';
import { privateClientOptions } from './private-channel.js';

export interface BridgeConfig {
  url: string;
  capability?: string;
  socketPath?: string;
  certificateFile?: string;
}
export type BridgeFetch = (url: string, options: RequestInit) => Promise<Response>;
const responseLimit = 16 * 1024 * 1024;

async function unixRequest(config: BridgeConfig, body: string, signal: AbortSignal) {
  const url = new URL(config.url);
  if (
    !config.socketPath ||
    !isAbsolute(config.socketPath) ||
    config.socketPath.includes('\0') ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('BRIDGE_UNAVAILABLE');
  const tls = await privateClientOptions(config.certificateFile);
  return new Promise<Response>((resolve, reject) => {
    // An explicit socket is the authority boundary; an unavailable endpoint must never fall back to TCP.
    const send = process.platform === 'win32' ? httpsRequest : httpRequest;
    const request = send(
      {
        ...tls,
        socketPath: config.socketPath,
        // LLM proxy settings can configure the global agent; private callbacks must bypass it.
        agent: false,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          host: url.host,
          'content-type': 'application/json',
          ...(config.capability ? { authorization: `Bearer ${config.capability}` } : {}),
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > responseLimit) {
            // end can run before destroy's asynchronous error; reject while the limit violation is authoritative.
            reject(new Error('BRIDGE_UNAVAILABLE'));
            request.destroy(new Error('BRIDGE_UNAVAILABLE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const status = response.statusCode || 502;
            resolve(
              new Response(status === 202 || status === 204 ? null : Buffer.concat(chunks), {
                status,
              }),
            );
          } catch {
            reject(new Error('BRIDGE_UNAVAILABLE'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

export async function bridgeRequest(
  config: BridgeConfig,
  rpc: unknown,
  signal: AbortSignal,
  request: BridgeFetch = fetch,
  timeoutMs = 20000,
): Promise<unknown> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    bounded.throwIfAborted();
    const body = JSON.stringify(rpc);
    if (typeof body !== 'string' || Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new Error('BRIDGE_UNAVAILABLE');
    const response =
      config.socketPath === undefined
        ? await request(config.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(config.capability ? { authorization: `Bearer ${config.capability}` } : {}),
            },
            body,
            signal: bounded,
          })
        : await unixRequest(config, body, bounded);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('BRIDGE_UNAVAILABLE');
    }
    if (response.status === 202) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body) throw new Error('BRIDGE_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        bounded.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > responseLimit) throw new Error('BRIDGE_UNAVAILABLE');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    bounded.throwIfAborted();
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('BRIDGE_UNAVAILABLE');
    }
    return value;
  } catch {
    if (signal.aborted) throw new DOMException('Bridge request aborted', 'AbortError');
    throw new Error('BRIDGE_UNAVAILABLE');
  }
}

async function bridgeCall(
  config: BridgeConfig,
  method: string,
  params: unknown,
  signal: AbortSignal,
  request: BridgeFetch,
): Promise<unknown> {
  const value = await bridgeRequest(
    config,
    { jsonrpc: '2.0', id: randomUUID(), method, params },
    signal,
    request,
    20000,
  );
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'result') || 'error' in value) {
    throw new Error('BRIDGE_UNAVAILABLE');
  }
  return (value as { result: unknown }).result;
}
export async function callBridge(
  config: BridgeConfig,
  method: string,
  params: unknown,
  signal: AbortSignal,
  request: BridgeFetch = fetch,
): Promise<unknown> {
  return bridgeCall(config, method, params, signal, request);
}
