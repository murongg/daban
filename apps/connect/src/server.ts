import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { remoteProof, validRemoteIdentity, verifyRemoteProof } from '@daban/engine/connect';
import {
  isRemoteSignal,
  type RemoteIdentity,
  type RemoteSignal,
  remoteMessageLimit,
} from '@daban/protocol';
import WebSocket, { WebSocketServer } from 'ws';

export interface ConnectOptions {
  host?: string;
  port?: number;
  maxConnections?: number;
  allowedDevices?: readonly string[];
  turn?: { urls: string[]; secret: string };
}
export async function startConnect(options: ConnectOptions = {}) {
  if (
    options.turn &&
    (options.turn.secret.length < 32 ||
      options.turn.urls.length > 4 ||
      !options.turn.urls.every((url) => /^(stun|turn|turns):[^\s]{1,1000}$/.test(url)))
  )
    throw Error('CONNECT_INVALID_TURN');
  const alive = new WeakSet<WebSocket>();
  const peers = new Map<string, { socket: WebSocket; identity: RemoteIdentity }>();
  const origins = new Map<string, { attempts: number; expires: number }>();
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ service: 'daban-connect', version: 1 }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: remoteMessageLimit,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/signal' || sockets.clients.size >= (options.maxConnections ?? 1000)) {
      socket.destroy();
      return;
    }
    const ip = request.socket.remoteAddress ?? '';
    const previous = origins.get(ip);
    const rate =
      previous && previous.expires > Date.now()
        ? previous
        : { attempts: 0, expires: Date.now() + 600_000 };
    if (++rate.attempts > 120 || (!origins.has(ip) && origins.size >= 10_000)) {
      socket.destroy();
      return;
    }
    origins.set(ip, rate);
    sockets.handleUpgrade(request, socket, head, (websocket) =>
      sockets.emit('connection', websocket),
    );
  });
  sockets.on('connection', (socket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    const challenge = randomBytes(32).toString('hex');
    let identity: RemoteIdentity | undefined;
    let count = 0;
    let period = Date.now();
    const send = (message: RemoteSignal) => {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < remoteMessageLimit * 2)
        socket.send(JSON.stringify(message));
      else socket.terminate();
    };
    const refuse = (error: string) => {
      send({ type: 'error', error });
      socket.close(1008, error);
    };
    const timeout = setTimeout(() => {
      if (!identity) refuse('REMOTE_AUTH_TIMEOUT');
    }, 15_000);
    timeout.unref();
    send({ type: 'challenge', nonce: challenge });
    socket.on('error', () => socket.terminate());
    socket.on('message', (bytes, binary) => {
      try {
        if (binary) return refuse('REMOTE_INVALID_MESSAGE');
        if (Date.now() - period > 1000) {
          period = Date.now();
          count = 0;
        }
        if (++count > 256) return refuse('REMOTE_RATE_LIMIT');
        const value: unknown = JSON.parse(bytes.toString());
        if (!isRemoteSignal(value)) return refuse('REMOTE_INVALID_MESSAGE');
        if (!identity) {
          if (
            value.type !== 'register' ||
            !validRemoteIdentity(value.identity) ||
            !verifyRemoteProof(
              value.identity,
              remoteProof('register', [challenge, value.identity.id]),
              value.signature,
            )
          )
            return refuse('REMOTE_UNAUTHORIZED');
          if (options.allowedDevices && !options.allowedDevices.includes(value.identity.id))
            return refuse('REMOTE_DEVICE_NOT_ENROLLED');
          identity = value.identity;
          clearTimeout(timeout);
          peers.get(identity.id)?.socket.close(1000, 'replaced');
          peers.set(identity.id, { identity, socket });
          const username = `${Math.floor(Date.now() / 1000) + 600}:${identity.id}`;
          send({
            type: 'ready',
            iceServers: options.turn
              ? [
                  {
                    urls: options.turn.urls,
                    username,
                    credential: createHmac('sha1', options.turn.secret)
                      .update(username)
                      .digest('base64'),
                  },
                ]
              : [],
          });
          return;
        }
        if (value.type !== 'signal' || !('to' in value)) return refuse('REMOTE_INVALID_MESSAGE');
        const target = peers.get(value.to);
        if (!target || target.socket.readyState !== WebSocket.OPEN) {
          send({ type: 'error', error: 'REMOTE_PEER_OFFLINE' });
          return;
        }
        if (target.socket.bufferedAmount >= remoteMessageLimit * 2)
          return refuse('REMOTE_BACKPRESSURE');
        target.socket.send(
          JSON.stringify({
            type: 'signal',
            from: identity,
            session: value.session,
            payload: value.payload,
          }),
        );
      } catch {
        refuse('REMOTE_INVALID_MESSAGE');
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      if (identity && peers.get(identity.id)?.socket === socket) peers.delete(identity.id);
    });
  });
  const sweep = setInterval(() => {
    for (const [ip, rate] of origins) if (rate.expires < Date.now()) origins.delete(ip);
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 30_000);
  sweep.unref();
  await new Promise<undefined>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('CONNECT_LISTEN_FAILED');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      clearInterval(sweep);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<undefined>((resolve) => sockets.close(() => resolve(undefined)));
      await new Promise<undefined>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    },
  };
}
