import { randomBytes } from 'node:crypto';
import type { IncomingMessage, RequestListener } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import {
  isRemoteSignal,
  type RemoteIdentity,
  type RemoteSignal,
  remoteLanServer,
  remoteMessageLimit,
} from '@daban/protocol';
import WebSocket, { WebSocketServer } from 'ws';
import type { PairingHost } from './pairing.js';
import { remoteProof, validRemoteIdentity, verifyRemoteProof } from './remote-crypto.js';

export interface LanServerOptions {
  port: number;
  tls: { key: string; cert: string };
  owner: string;
  pairing?: PairingHost;
}
async function pairingBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    length += chunk.length;
    if (length > 2048) throw Error('REMOTE_CODE_INVALID');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function startLanSignal(options: LanServerOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.owner)) throw Error('REMOTE_LAN_CONFIG_INVALID');
  const alive = new WeakSet<WebSocket>();
  const peers = new Map<string, { socket: WebSocket; identity: RemoteIdentity }>();
  const left = (identity: RemoteIdentity) => {
    for (const peer of peers.values()) {
      const target =
        identity.id === options.owner
          ? peer.identity.id !== options.owner
          : peer.identity.id === options.owner;
      if (!target) continue;
      if (
        peer.socket.readyState === WebSocket.OPEN &&
        peer.socket.bufferedAmount < remoteMessageLimit * 8
      )
        peer.socket.send(JSON.stringify({ type: 'left', identity }));
      else peer.socket.terminate();
    }
  };
  const origins = new Map<string, { attempts: number; expires: number }>();
  const listener: RequestListener = (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      request.method === 'POST' &&
      options.pairing &&
      (request.url === '/v1/pair/start' || request.url === '/v1/pair/finish')
    ) {
      const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!remoteLanServer(`https://${address}`)) {
        response.writeHead(403).end();
        return;
      }
      pairingBody(request)
        .then((body) => {
          if (response.destroyed) return;
          let value: unknown;
          if (request.url === '/v1/pair/start') {
            if (
              !body ||
              typeof body !== 'object' ||
              Array.isArray(body) ||
              Object.keys(body).length
            )
              throw Error('REMOTE_CODE_INVALID');
            value = options.pairing!.begin();
          } else value = options.pairing!.finish(body);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(value));
        })
        .catch((cause) => {
          if (response.destroyed || response.headersSent) return;
          const error =
            cause instanceof Error &&
            /^REMOTE_CODE_(?:INVALID|EXPIRED|ATTEMPTS)$/.test(cause.message)
              ? cause.message
              : 'REMOTE_CODE_INVALID';
          response.writeHead(error === 'REMOTE_CODE_ATTEMPTS' ? 429 : 400, {
            'Content-Type': 'application/json',
          });
          response.end(JSON.stringify({ error }));
        });
    } else if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ service: 'daban-lan', version: 2 }));
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  const server = createSecureServer(
    { ...options.tls, minVersion: 'TLSv1.2', handshakeTimeout: 10000 },
    listener,
  );
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: remoteMessageLimit,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!remoteLanServer(`https://${address}`)) {
      socket.destroy();
      return;
    }
    if (request.url !== '/v1/signal' || sockets.clients.size >= 16) {
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
        if (++count > 4096) return refuse('REMOTE_RATE_LIMIT');
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
          identity = value.identity;
          clearTimeout(timeout);
          const previous = peers.get(identity.id);
          if (previous) {
            // Retire old sessions before the replacement connection can send a new handshake.
            left(previous.identity);
            previous.socket.close(1000, 'replaced');
          }
          peers.set(identity.id, { identity, socket });
          send({ type: 'ready', iceServers: [] });
          return;
        }
        if (value.type !== 'signal' || !('to' in value)) return refuse('REMOTE_INVALID_MESSAGE');
        // A LAN listener belongs to one Host; it cannot relay another device's workspace.
        if (value.to !== options.owner && identity.id !== options.owner)
          return refuse('REMOTE_LAN_ONLY');
        const target = peers.get(value.to);
        if (!target || target.socket.readyState !== WebSocket.OPEN) {
          send({ type: 'error', error: 'REMOTE_PEER_OFFLINE' });
          return;
        }
        if (target.socket.bufferedAmount >= remoteMessageLimit * 8)
          return refuse('REMOTE_BACKPRESSURE');
        socket.pause();
        target.socket.send(
          JSON.stringify({
            type: 'signal',
            from: identity,
            session: value.session,
            payload: value.payload,
          }),
          (error) => {
            socket.resume();
            if (error) socket.terminate();
          },
        );
      } catch {
        refuse('REMOTE_INVALID_MESSAGE');
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      if (identity && peers.get(identity.id)?.socket === socket) {
        peers.delete(identity.id);
        left(identity);
      }
    });
  });
  await new Promise<undefined>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => resolve(undefined));
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
  }, 5_000);
  sweep.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('CONNECT_LISTEN_FAILED');
  return {
    origin: `https://127.0.0.1:${address.port}`,
    port: address.port,
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
