import { X509Certificate } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import {
  isRemoteSignal,
  type RemoteIceServer,
  type RemoteIdentity,
  type RemoteSignal,
  type RemoteSignalPayload,
  remoteMessageLimit,
  remoteServer,
} from '@daban/protocol';
import WebSocket from 'ws';
import { remoteProof, validRemoteIdentity } from './remote-crypto.js';

export interface RemoteSigner {
  identity: RemoteIdentity;
  sign(text: string): string;
}
export class SignalConnection {
  private socket?: WebSocket;
  private stopped = false;
  private registered = false;
  private retry?: ReturnType<typeof setTimeout>;
  private pending?: Promise<RemoteIceServer[]>;
  private ice: RemoteIceServer[] = [];
  constructor(
    private readonly options: {
      server: string;
      certificate: string;
      keys: RemoteSigner;
      signal(message: Extract<RemoteSignal, { type: 'signal' }>): unknown;
      left?(identity: RemoteIdentity): unknown;
      changed?(connected: boolean, error?: string): unknown;
    },
  ) {
    remoteServer(options.server);
  }
  get connected() {
    return this.registered;
  }
  start(): Promise<RemoteIceServer[]> {
    if (this.stopped) return Promise.reject(Error('REMOTE_CONNECTION_CLOSED'));
    if (this.registered) return Promise.resolve(this.ice);
    this.pending ??= this.open().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private open(): Promise<RemoteIceServer[]> {
    const url = new URL('/v1/signal', this.options.server);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const certificate = this.options.certificate
      ? new X509Certificate(this.options.certificate)
      : undefined;
    const socket = new WebSocket(url, {
      handshakeTimeout: certificate ? 3000 : 15000,
      maxPayload: remoteMessageLimit,
      perMessageDeflate: false,
      agent: certificate
        ? new HttpsAgent({
            ca: this.options.certificate,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            // The link pins this Host's leaf; a changed LAN address does not grant trust to another certificate.
            checkServerIdentity: (_hostname, peer) =>
              peer.fingerprint256 === certificate.fingerprint256
                ? undefined
                : Error('REMOTE_CERTIFICATE_CHANGED'),
          })
        : undefined,
    });
    const previous = this.socket;
    this.socket = socket;
    previous?.close();
    this.registered = false;
    let proved = false;
    return new Promise<RemoteIceServer[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Error('REMOTE_SIGNAL_TIMEOUT'));
        socket.close();
      }, 15_000);
      timeout.unref?.();
      socket.on('message', (bytes, binary) => {
        const data = bytes.toString();
        if (this.socket !== socket || this.stopped) return;
        try {
          if (binary || Buffer.byteLength(data) > remoteMessageLimit)
            throw Error('REMOTE_INVALID_MESSAGE');
          const message: unknown = JSON.parse(data);
          if (!isRemoteSignal(message)) throw Error('REMOTE_INVALID_MESSAGE');
          if (message.type === 'challenge' && !proved) {
            proved = true;
            socket.send(
              JSON.stringify({
                type: 'register',
                identity: this.options.keys.identity,
                signature: this.options.keys.sign(
                  remoteProof('register', [message.nonce, this.options.keys.identity.id]),
                ),
              }),
            );
          } else if (message.type === 'ready' && proved) {
            clearTimeout(timeout);
            this.registered = true;
            this.ice = message.iceServers;
            this.options.changed?.(true);
            resolve(this.ice);
          } else if (
            message.type === 'signal' &&
            'from' in message &&
            this.registered &&
            validRemoteIdentity(message.from)
          ) {
            this.options.signal(message);
          } else if (
            message.type === 'left' &&
            this.registered &&
            validRemoteIdentity(message.identity)
          ) {
            this.options.left?.(message.identity);
          } else if (message.type === 'error') {
            this.options.changed?.(this.registered, message.error);
            if (!this.registered) reject(Error(message.error));
          } else throw Error('REMOTE_INVALID_MESSAGE');
        } catch {
          reject(Error('REMOTE_INVALID_MESSAGE'));
          socket.close();
        }
      });
      socket.addEventListener('error', () => {
        reject(Error('REMOTE_SIGNAL_UNAVAILABLE'));
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        this.registered = false;
        reject(Error('REMOTE_SIGNAL_UNAVAILABLE'));
        this.options.changed?.(false);
        if (!this.stopped) {
          this.retry = setTimeout(() => {
            this.start().catch(() => {});
          }, 3000);
          this.retry.unref?.();
        }
      });
    });
  }
  send(to: string, session: string, payload: RemoteSignalPayload) {
    if (!this.registered || this.socket?.readyState !== WebSocket.OPEN)
      throw Error('REMOTE_SIGNAL_UNAVAILABLE');
    const message: RemoteSignal = { type: 'signal', to, session, payload };
    if (!isRemoteSignal(message)) throw Error('REMOTE_INVALID_MESSAGE');
    this.socket.send(JSON.stringify(message));
  }
  async data(to: string, session: string, payload: RemoteSignalPayload) {
    if (!this.options.certificate) throw Error('REMOTE_LAN_ONLY');
    const message: RemoteSignal = { type: 'signal', to, session, payload };
    if (!isRemoteSignal(message)) throw Error('REMOTE_INVALID_MESSAGE');
    const socket = this.socket;
    if (!this.registered || socket?.readyState !== WebSocket.OPEN)
      throw Error('REMOTE_SIGNAL_UNAVAILABLE');
    await new Promise<undefined>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve(undefined)));
    });
  }
  close() {
    this.stopped = true;
    this.registered = false;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
