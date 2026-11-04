import {
  isRemoteSignal,
  type RemoteIceServer,
  type RemoteIdentity,
  type RemoteSignal,
  type RemoteSignalPayload,
  remoteMessageLimit,
  remoteServer,
} from '@daban/protocol';
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
  private renewAt = 0;
  constructor(
    private readonly options: {
      server: string;
      keys: RemoteSigner;
      signal(message: Extract<RemoteSignal, { type: 'signal' }>): unknown;
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
    if (this.registered && Date.now() < this.renewAt) return Promise.resolve(this.ice);
    this.pending ??= this.open().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private open(): Promise<RemoteIceServer[]> {
    const url = new URL('/v1/signal', this.options.server);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
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
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket || this.stopped) return;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > remoteMessageLimit)
            throw Error('REMOTE_INVALID_MESSAGE');
          const message: unknown = JSON.parse(event.data);
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
            // Connect issues ten-minute TURN credentials; new peers must not reuse an expired allocation secret.
            this.renewAt = Date.now() + 8 * 60_000;
            this.options.changed?.(true);
            resolve(this.ice);
          } else if (
            message.type === 'signal' &&
            'from' in message &&
            this.registered &&
            validRemoteIdentity(message.from)
          ) {
            this.options.signal(message);
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
  close() {
    this.stopped = true;
    this.registered = false;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
