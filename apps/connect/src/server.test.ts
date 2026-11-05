import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { remoteProof } from '@daban/engine/connect';
import { SignalConnection } from '@daban/engine/remote';
import type { RemoteIdentity, RemoteSignal } from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startConnect } from './server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function keys(name: string) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  const identity: RemoteIdentity = {
    name,
    id: createHash('sha256').update(publicKey).digest('hex'),
    publicKey: publicKey.toString('base64url'),
  };
  return {
    identity,
    sign: (text: string) => sign(null, Buffer.from(text), pair.privateKey).toString('base64url'),
  };
}
async function service() {
  const server = await startConnect({ port: 0, host: '127.0.0.1', maxConnections: 10 });
  cleanup.push(() => server.close());
  return server;
}
async function client(url: string, key = keys('Synthetic device')) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/signal`);
  const messages: RemoteSignal[] = [];
  const listeners: ((message: RemoteSignal) => unknown)[] = [];
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString()) as RemoteSignal;
    const waiting = listeners.shift();
    if (waiting) waiting(message);
    else messages.push(message);
  });
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift()!)
      : new Promise<RemoteSignal>((resolve) => listeners.push(resolve));
  cleanup.push(async () => {
    socket.terminate();
  });
  await once(socket, 'open');
  const challenge = await next();
  if (challenge.type !== 'challenge') throw Error('No challenge');
  socket.send(
    JSON.stringify({
      type: 'register',
      identity: key.identity,
      signature: key.sign(remoteProof('register', [challenge.nonce, key.identity.id])),
    }),
  );
  return { socket, next, key };
}

it('rejects an unenrolled device before issuing relay credentials', async () => {
  const enrolled = keys('Synthetic enrolled');
  const server = await startConnect({ port: 0, allowedDevices: [enrolled.identity.id] });
  cleanup.push(() => server.close());
  const allowed = await client(server.origin, enrolled);
  expect((await allowed.next()).type).toBe('ready');
  const denied = await client(server.origin);
  expect(await denied.next()).toEqual({ type: 'error', error: 'REMOTE_DEVICE_NOT_ENROLLED' });
});

it('authenticates both peers and forwards only bounded signaling with the proven sender', async () => {
  const server = await service();
  const first = await client(server.origin);
  const second = await client(server.origin);
  expect((await first.next()).type).toBe('ready');
  expect((await second.next()).type).toBe('ready');
  first.socket.send(
    JSON.stringify({
      type: 'signal',
      to: second.key.identity.id,
      session: 'synthetic-session',
      payload: { type: 'connect' },
    }),
  );
  expect(await second.next()).toEqual({
    type: 'signal',
    from: first.key.identity,
    session: 'synthetic-session',
    payload: { type: 'connect' },
  });
  expect((await fetch(`${server.origin}/health`)).status).toBe(200);
  expect((await fetch(`${server.origin}/exec`)).status).toBe(404);
});

it('cannot register somebody else’s key or use the relay as a command endpoint', async () => {
  const server = await service();
  const stolen = keys('Synthetic host');
  const attacker = keys('Synthetic attacker');
  const peer = await client(server.origin, { identity: stolen.identity, sign: attacker.sign });
  expect(await peer.next()).toEqual({ type: 'error', error: 'REMOTE_UNAUTHORIZED' });
  const valid = await client(server.origin);
  await valid.next();
  valid.socket.send(
    JSON.stringify({
      type: 'signal',
      to: stolen.identity.id,
      session: 'synthetic-session',
      payload: { type: 'execute', command: 'synthetic' },
    }),
  );
  expect(await valid.next()).toEqual({ type: 'error', error: 'REMOTE_INVALID_MESSAGE' });
});

it('only issues temporary TURN credentials after proof of device identity', async () => {
  const server = await startConnect({
    port: 0,
    host: '127.0.0.1',
    turn: {
      urls: ['turn:relay.example.test:3478'],
      secret: 'synthetic-shared-secret-of-sufficient-size',
    },
  });
  cleanup.push(() => server.close());
  const peer = await client(server.origin);
  const ready = await peer.next();
  expect(ready.type).toBe('ready');
  if (ready.type !== 'ready') return;
  expect(ready.iceServers[0].urls).toEqual(['turn:relay.example.test:3478']);
  expect(ready.iceServers[0].username).toContain(peer.key.identity.id);
  expect(ready.iceServers[0].credential).not.toContain('synthetic-shared-secret');
  const expires = Number(ready.iceServers[0].username?.split(':')[0]);
  expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
});

it('refreshes expiring TURN credentials before establishing another peer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const service = await startConnect({
    port: 0,
    turn: {
      urls: ['turn:relay.example.test:3478'],
      secret: 'synthetic-shared-secret-of-sufficient-size',
    },
  });
  cleanup.push(() => service.close());
  const peer = new SignalConnection({
    server: service.origin,
    keys: keys('Synthetic refresh'),
    signal: () => {},
  });
  cleanup.push(async () => peer.close());
  const first = await peer.start();
  vi.setSystemTime(Date.now() + 9 * 60_000);
  const next = await peer.start();
  expect(next[0].username).not.toBe(first[0].username);
});

it('connects the application signal client and cleans up without stopping a remote host', async () => {
  const server = await service();
  const a = keys('Synthetic application host');
  const b = keys('Synthetic application controller');
  let received: (message: RemoteSignal) => unknown = () => {};
  const message = new Promise<RemoteSignal>((resolve) => {
    received = resolve;
  });
  const host = new SignalConnection({ server: server.origin, keys: a, signal: received });
  const controller = new SignalConnection({ server: server.origin, keys: b, signal: () => {} });
  cleanup.push(async () => {
    host.close();
    controller.close();
  });
  await Promise.all([host.start(), controller.start()]);
  controller.send(a.identity.id, 'synthetic-session', { type: 'connect' });
  expect(await message).toEqual({
    type: 'signal',
    from: b.identity,
    session: 'synthetic-session',
    payload: { type: 'connect' },
  });
  controller.close();
  expect(host.connected).toBe(true);
});
