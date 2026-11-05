import type { LookupAddress } from 'node:dns';
import type { NetConnectOpts, Socket, TcpNetConnectOpts } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ConnectionOptions, TLSSocket } from 'node:tls';

export interface WireRoute {
  hostname: string;
  address: '8.8.8.8' | '8.8.4.4';
  destinationPort: number;
  ca: Buffer;
  resolved?: '127.0.0.1';
}

export class WireBridge {
  readonly dials: { address: string; port: number }[] = [];
  readonly handshakes: string[] = [];
  readonly tlsErrors: string[] = [];
  private readonly routes: readonly WireRoute[];
  private readonly sockets = new Map<Duplex, WireRoute>();
  private closed = false;
  constructor(routes: readonly WireRoute[]) {
    if (
      !routes.length ||
      new Set(routes.map((route) => route.hostname)).size !== routes.length ||
      new Set(routes.map((route) => route.address)).size !== routes.length ||
      routes.some(
        (route) =>
          !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(route.hostname) ||
          !['8.8.8.8', '8.8.4.4'].includes(route.address) ||
          !Number.isSafeInteger(route.destinationPort) ||
          route.destinationPort < 1 ||
          route.destinationPort > 65535 ||
          !Buffer.isBuffer(route.ca) ||
          !route.ca.length ||
          (route.resolved !== undefined && route.resolved !== '127.0.0.1'),
      )
    )
      throw new Error('WIRE_INVALID_ROUTE');
    this.routes = routes.map((route) => ({ ...route, ca: Buffer.from(route.ca) }));
  }
  private live() {
    if (this.closed) throw new Error('WIRE_CLOSED');
  }
  async lookup(host: string, options: { all: true; order: 'verbatim' }): Promise<LookupAddress[]> {
    this.live();
    const route = this.routes.find((route) => route.hostname === host);
    if (!route || options.all !== true || options.order !== 'verbatim')
      throw new Error('WIRE_UNDECLARED_DNS');
    // Never trigger the fake-IP fallback, which would introduce an undeclared second resolver.
    return [{ address: route.resolved ?? route.address, family: 4 }];
  }
  dial(options: NetConnectOpts, open: (options: TcpNetConnectOpts) => Socket): Socket {
    this.live();
    const route =
      'port' in options && options.port === 443
        ? this.routes.find((route) => route.address === options.host)
        : undefined;
    if (!route || Object.keys(options).some((key) => !['host', 'port'].includes(key)))
      throw new Error('WIRE_UNDECLARED_DIAL');
    this.dials.push({ address: route.address, port: 443 });
    const socket = open({ host: '127.0.0.1', port: route.destinationPort });
    this.sockets.set(socket, route);
    return socket;
  }
  secure(options: ConnectionOptions, open: (options: ConnectionOptions) => TLSSocket): TLSSocket {
    this.live();
    const route = options.socket ? this.sockets.get(options.socket) : undefined;
    if (
      !route ||
      options.servername !== route.hostname ||
      options.rejectUnauthorized !== true ||
      (options.host !== undefined && options.host !== route.hostname) ||
      Object.keys(options).some(
        (key) => !['socket', 'host', 'servername', 'rejectUnauthorized'].includes(key),
      )
    )
      throw new Error('WIRE_TLS_UNDECLARED');
    // Bind CA injection to this exact mapped socket/SNI; Node still verifies chain and hostname.
    const socket = open({ ...options, ca: route.ca });
    this.sockets.set(socket, route);
    socket.once('secureConnect', () => {
      if (socket.authorized) this.handshakes.push(route.hostname);
      else socket.destroy(new Error('WIRE_TLS_UNAUTHORIZED'));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.tlsErrors.push(error.code ?? error.name);
    });
    return socket;
  }
  async close() {
    this.closed = true;
    for (const socket of this.sockets.keys()) socket.destroy();
    this.sockets.clear();
  }
}
