import type { LookupAddress } from 'node:dns';
import type { NetConnectOpts, Socket, TcpNetConnectOpts } from 'node:net';
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
  constructor(readonly routes: readonly WireRoute[]) {}
  async lookup(
    _host: string,
    _options: { all: true; order: 'verbatim' },
  ): Promise<LookupAddress[]> {
    throw new Error('WIRE_UNDECLARED_DNS');
  }
  dial(_options: NetConnectOpts, _open: (options: TcpNetConnectOpts) => Socket): Socket {
    throw new Error('WIRE_UNDECLARED_DIAL');
  }
  secure(_options: ConnectionOptions, _open: (options: ConnectionOptions) => TLSSocket): TLSSocket {
    throw new Error('WIRE_TLS_UNDECLARED');
  }
  async close() {}
}
