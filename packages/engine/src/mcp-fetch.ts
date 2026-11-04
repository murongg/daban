import type { LookupAddress } from 'node:dns';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as secureConnect } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Fault } from './control.js';
import { dialAddress, resolvePublic } from './network.js';

export interface McpFetchOptions {
  resolve?: (host: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>;
  dial?: (address: string, port: number, signal: AbortSignal) => Promise<Duplex>;
  upstream?: string;
  ca?: Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  onDispatch?: () => unknown | Promise<unknown>;
  assertAuthority?: () => unknown;
}
export class McpFetch {
  private readonly endpoint: URL;
  private readonly upstream?: URL;
  private sentTool = false;
  constructor(
    endpoint: string,
    private readonly options: McpFetchOptions = {},
  ) {
    try {
      this.endpoint = new URL(endpoint);
      if (
        this.endpoint.protocol !== 'https:' ||
        this.endpoint.username ||
        this.endpoint.password ||
        this.endpoint.hash
      )
        throw new Error('invalid endpoint');
      if (options.upstream) {
        const proxy = new URL(options.upstream);
        if (
          !['http:', 'https:'].includes(proxy.protocol) ||
          proxy.pathname !== '/' ||
          proxy.search ||
          proxy.hash
        )
          throw new Error('invalid proxy');
        this.upstream = proxy;
      }
    } catch {
      throw new Fault('MCP_NETWORK_BLOCKED', 403);
    }
  }
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const original = input instanceof Request ? input : undefined;
    const url = new URL(original?.url ?? String(input));
    if (url.href !== this.endpoint.href) throw new Fault('MCP_NETWORK_BLOCKED', 403);
    const method = (init.method ?? original?.method ?? 'GET').toUpperCase();
    // Legacy GET notification streams are optional; this client offers request-scoped results only.
    if (method === 'GET') return new Response(null, { status: 405 });
    if (!['POST', 'DELETE'].includes(method)) throw new Fault('MCP_NETWORK_BLOCKED', 403);
    const signal = AbortSignal.any([
      ...(original ? [original.signal] : []),
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(this.options.timeoutMs ?? 20000),
    ]);
    signal.throwIfAborted();
    const body =
      init.body === undefined
        ? original
          ? await original.text()
          : ''
        : typeof init.body === 'string'
          ? init.body
          : undefined;
    if (body === undefined || Buffer.byteLength(body) > 128000)
      throw new Fault('MCP_REQUEST_TOO_LARGE', 400);
    let tool = false;
    if (body) {
      try {
        const value: unknown = JSON.parse(body);
        tool =
          !!value &&
          typeof value === 'object' &&
          'method' in value &&
          value.method === 'tools/call';
      } catch {
        throw new Fault('MCP_INVALID_REQUEST', 400);
      }
    }
    const headers = new Headers(original?.headers);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    if (headers.has('cookie') || headers.has('proxy-authorization'))
      throw new Fault('MCP_NETWORK_BLOCKED', 403);
    headers.set('host', url.host);
    headers.set('accept-encoding', 'identity');
    headers.set('connection', 'close');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: LookupAddress[];
    try {
      addresses = await resolvePublic(host, signal, this.options.resolve);
    } catch {
      throw new Fault('MCP_NETWORK_BLOCKED', 403);
    }
    if (tool) {
      if (this.sentTool) throw new Fault('MCP_REPLAY_BLOCKED');
      if (!this.options.onDispatch) throw new Fault('MCP_APPROVAL_REQUIRED');
      // The receipt commits before a tool request can leave the host. SDK auth/version retries cannot replay an effect.
      this.sentTool = true;
      await this.options.onDispatch();
    }
    signal.throwIfAborted();
    const port = Number(url.port || 443),
      address = addresses[0].address;
    const socket = await (this.options.dial
      ? this.options.dial(address, port, signal)
      : dialAddress(address, port, signal, this.upstream));
    const agent = new HttpsAgent({ keepAlive: false });
    agent.createConnection = () =>
      secureConnect({
        socket,
        host,
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
        ...(this.options.ca ? { ca: this.options.ca } : {}),
      });
    const limit = this.options.maxBytes ?? 1024 * 1024;
    try {
      signal.throwIfAborted();
      // Dialing can outlive consent; this synchronous guard precedes the actual HTTP request.
      if (tool) this.options.assertAuthority?.();
      return await new Promise<Response>((resolve, reject) => {
        const req = httpsRequest(
          {
            hostname: host,
            port,
            method,
            path: url.pathname + url.search,
            headers: Object.fromEntries(headers),
            agent,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > limit) {
                response.destroy(new Fault('MCP_RESPONSE_TOO_LARGE', 502));
                return;
              }
              chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => {
              try {
                const status = response.statusCode ?? 502;
                if (status >= 300 && status < 400 && status !== 304)
                  throw new Fault('MCP_REDIRECT_REFUSED', 502);
                let data = Buffer.concat(chunks);
                const encoding = response.headers['content-encoding'];
                if (encoding && encoding !== 'identity') {
                  const decode =
                    encoding === 'gzip'
                      ? gunzipSync
                      : encoding === 'br'
                        ? brotliDecompressSync
                        : encoding === 'deflate'
                          ? inflateSync
                          : undefined;
                  if (!decode) throw new Fault('MCP_INVALID_RESPONSE', 502);
                  try {
                    data = decode(data, { maxOutputLength: limit + 1 });
                  } catch {
                    throw new Fault('MCP_RESPONSE_TOO_LARGE', 502);
                  }
                }
                if (data.length > limit) throw new Fault('MCP_RESPONSE_TOO_LARGE', 502);
                const output = new Headers();
                for (const [name, values] of Object.entries(response.headers))
                  if (
                    values !== undefined &&
                    !['content-encoding', 'content-length', 'set-cookie'].includes(name)
                  )
                    for (const value of Array.isArray(values) ? values : [values])
                      output.append(name, value);
                const result = new Response(
                  [204, 205, 304].includes(status) ? null : new Uint8Array(data),
                  { status, headers: output },
                );
                Object.defineProperty(result, 'url', { value: url.href });
                resolve(result);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        const cancel = () => req.destroy(new Fault('MCP_CANCELLED'));
        signal.addEventListener('abort', cancel, { once: true });
        req.once('error', reject);
        req.once('close', () => signal.removeEventListener('abort', cancel));
        if (signal.aborted) cancel();
        else req.end(body);
      });
    } finally {
      socket.destroy();
      agent.destroy();
    }
  };
}
