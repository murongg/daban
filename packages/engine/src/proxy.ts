import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import {
  Agent,
  type ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { Fault } from './control.js';
import { dialAddress, resolvePublic } from './network.js';

export { publicAddress } from './network.js';

export interface ProxyOptions {
  fixtureOrigin: string;
  upstream?: string;
  resolve?: (host: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>;
  dial?: (address: string, port: number, signal: AbortSignal) => Promise<Duplex>;
}
const denied = () => new Fault('BROWSER_NETWORK_BLOCKED', 403);
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
export class PublicProxy {
  readonly server = createServer();
  private readonly sockets = new Set<Duplex>();
  private readonly pending = new Set<AbortController>();
  private readonly fixture: URL;
  private readonly upstream?: URL;
  private closed = false;
  url = '';
  constructor(private readonly options: ProxyOptions) {
    this.fixture = new URL(options.fixtureOrigin);
    if (
      this.fixture.protocol !== 'http:' ||
      this.fixture.hostname !== '127.0.0.1' ||
      this.fixture.username ||
      this.fixture.password ||
      this.fixture.pathname !== '/' ||
      this.fixture.search ||
      this.fixture.hash
    )
      throw denied();
    if (options.upstream) {
      try {
        const url = new URL(options.upstream);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        decodeURIComponent(url.username);
        decodeURIComponent(url.password);
        this.upstream = url;
      } catch {
        throw new Fault('BROWSER_PROXY_CONFIG_INVALID', 503);
      }
    }
    this.server.on('connection', (socket) => this.track(socket));
    this.server.on('request', (req, res) => {
      this.forward(req, res).catch((error) => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(error instanceof Fault ? error.status : 502, {
            'content-type': 'text/plain',
            connection: 'close',
          });
          res.end(
            error instanceof Fault ? 'BROWSER_NETWORK_BLOCKED' : 'BROWSER_NETWORK_UNAVAILABLE',
          );
        }
      });
    });
    this.server.on('connect', (req, socket, head) => {
      this.tunnel(req, socket, head).catch((error) => {
        if (!socket.destroyed)
          socket.end(
            `HTTP/1.1 ${error instanceof Fault ? 403 : 502} Connection Refused\r\nConnection: close\r\n\r\n`,
          );
      });
    });
    this.server.on('upgrade', (_req, socket) =>
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
    );
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 30000;
  }
  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  }
  async listen() {
    await new Promise<unknown>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Fault('BROWSER_PROXY_UNAVAILABLE', 503);
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }
  private async target(url: URL, signal: AbortSignal, connectRequest = false) {
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw denied();
    const host = hostname(url),
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const fixture =
      !connectRequest && url.origin === this.fixture.origin && url.pathname.startsWith('/fixture/');
    if (fixture) return { address: host, port, fixture };
    let addresses: LookupAddress[];
    try {
      addresses = await resolvePublic(host, signal, this.options.resolve || lookup);
    } catch (error) {
      if (error instanceof Fault && error.code === 'NETWORK_BLOCKED') throw denied();
      throw error;
    }
    return { address: addresses[0].address, port, fixture: false };
  }
  private async dial(
    target: { address: string; port: number; fixture: boolean },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw new Fault('BROWSER_PROXY_CLOSED', 503);
    // Connect to the validated IP, including through an upstream proxy; a second DNS lookup would allow rebinding.
    const socket = await (this.options.dial
      ? this.options.dial(target.address, target.port, signal)
      : dialAddress(
          target.address,
          target.port,
          signal,
          this.upstream && !target.fixture ? this.upstream : undefined,
        ));
    this.track(socket);
    if (this.closed || signal.aborted) {
      socket.destroy();
      throw new Fault('BROWSER_PROXY_CLOSED', 503);
    }
    return socket;
  }
  private async forward(req: IncomingMessage, res: ServerResponse) {
    const operation = new AbortController();
    this.pending.add(operation);
    let outgoing: ClientRequest | undefined;
    const abort = () => {
      operation.abort();
      outgoing?.destroy();
    };
    req.once('aborted', abort);
    try {
      let url: URL;
      try {
        url = new URL(req.url || '');
      } catch {
        throw denied();
      }
      if (url.protocol !== 'http:') throw denied();
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10000)]);
      const target = await this.target(url, signal),
        socket = await this.dial(target, signal);
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host, connection: 'close' };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      outgoing = request(
        {
          hostname: target.address,
          port: target.port,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          agent,
        },
        (response) => {
          res.writeHead(response.statusCode || 502, response.headers);
          response.pipe(res);
          response.once('error', () => res.destroy());
        },
      );
      outgoing.once('close', () => agent.destroy());
      outgoing.on('error', () => {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(502, { connection: 'close' });
          res.end('BROWSER_NETWORK_UNAVAILABLE');
        }
      });
      outgoing.setTimeout(30000, () => outgoing?.destroy());
      res.once('close', () => outgoing?.destroy());
      req.pipe(outgoing);
    } finally {
      this.pending.delete(operation);
      req.removeListener('aborted', abort);
    }
  }
  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer) {
    const operation = new AbortController();
    this.pending.add(operation);
    const cancel = () => operation.abort();
    client.once('close', cancel);
    try {
      let url: URL;
      try {
        url = new URL(`https://${req.url}`);
      } catch {
        throw denied();
      }
      if (url.pathname !== '/' || url.search || url.hash) throw denied();
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10000)]);
      const target = await this.target(url, signal, true),
        socket = await this.dial(target, signal);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.once('close', () => socket.destroy());
      socket.once('close', () => client.destroy());
      socket.pipe(client);
      client.pipe(socket);
    } finally {
      this.pending.delete(operation);
      client.removeListener('close', cancel);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const operation of this.pending) operation.abort();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<unknown>((resolve) => this.server.close(() => resolve(undefined)));
  }
}
export async function createProxy(options: ProxyOptions) {
  return await new PublicProxy(options).listen();
}
