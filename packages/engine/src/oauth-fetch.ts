import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { Fault } from './control.js';
import type { McpFetchOptions } from './mcp-fetch.js';
import { dialAddress, resolvePublic } from './network.js';
export class OAuthFetch {
  constructor(
    readonly allowed: readonly string[],
    readonly options: McpFetchOptions = {},
  ) {}
  async request(
    value: string,
    input?: URLSearchParams | Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }> {
    let url: URL;
    try {
      url = new URL(value);
      if (
        !this.allowed.includes(url.href) ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error('invalid');
    } catch {
      throw new Fault('OAUTH_NETWORK_BLOCKED', 403);
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 15000);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolvePublic(host, signal, this.options.resolve).catch(() => {
      throw new Fault('OAUTH_NETWORK_BLOCKED', 403);
    });
    const port = Number(url.port || 443);
    const socket = await (this.options.dial
      ? this.options.dial(addresses[0].address, port, signal)
      : dialAddress(
          addresses[0].address,
          port,
          signal,
          this.options.upstream ? new URL(this.options.upstream) : undefined,
        ));
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () =>
      connect({
        socket,
        host,
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
        ...(this.options.ca ? { ca: this.options.ca } : {}),
      });
    const body =
      input === undefined
        ? undefined
        : input instanceof URLSearchParams
          ? input.toString()
          : JSON.stringify(input);
    if (body && Buffer.byteLength(body) > 32000) {
      socket.destroy();
      agent.destroy();
      throw new Fault('OAUTH_REQUEST_TOO_LARGE', 400);
    }
    const max = this.options.maxBytes ?? 256000;
    try {
      return await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        const req = request(
          {
            hostname: host,
            port,
            path: url.pathname,
            method: body === undefined ? 'GET' : 'POST',
            agent,
            headers: {
              accept: 'application/json',
              'accept-encoding': 'identity',
              connection: 'close',
              ...(body === undefined
                ? {}
                : {
                    'content-type':
                      input instanceof URLSearchParams
                        ? 'application/x-www-form-urlencoded'
                        : 'application/json',
                  }),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > max) response.destroy(new Fault('OAUTH_RESPONSE_TOO_LARGE', 502));
              else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => {
              try {
                const status = response.statusCode ?? 502;
                if (status >= 300 && status < 400) throw new Fault('OAUTH_REDIRECT_REFUSED', 502);
                if (
                  response.headers['content-encoding'] &&
                  response.headers['content-encoding'] !== 'identity'
                )
                  throw new Fault('OAUTH_INVALID_RESPONSE', 502);
                const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                resolve({ status, data });
              } catch (error) {
                reject(error instanceof Fault ? error : new Fault('OAUTH_INVALID_RESPONSE', 502));
              }
            });
          },
        );
        const cancel = () => req.destroy(new Fault('OAUTH_NETWORK_INTERRUPTED', 502));
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
  }
}
