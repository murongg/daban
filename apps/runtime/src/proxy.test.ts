import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import test from 'node:test';

import { createProxy, publicAddress } from './proxy.js';

async function listen(server: Server) {
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function get(proxy: string, target: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(proxy, { path: target, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
async function tunnel(proxy: string, authority: string) {
  return new Promise<{ status: number; socket: Duplex }>((resolve, reject) => {
    const req = request(proxy, { method: 'CONNECT', path: authority });
    req.on('connect', (response, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve({ status: response.statusCode || 0, socket });
    });
    req.on('error', reject);
    req.end();
  });
}
const close = (server: Server) =>
  new Promise<unknown>((resolve) => {
    server.close(() => resolve(undefined));
  });

test('browser proxy recognizes public addresses without accepting private, mapped or transition destinations', async () => {
  for (const value of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2400:3200::1'])
    assert.equal(publicAddress(value), true, value);
  for (const value of [
    'not-an-ip',
    '0.0.0.0',
    '10.2.3.4',
    '100.64.0.2',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.2.1',
    '192.0.2.8',
    '198.19.0.1',
    '198.51.100.2',
    '203.0.113.3',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fd00::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001::1',
    '3fff::1',
  ])
    assert.equal(publicAddress(value), false, value);
});

test('browser proxy pins a validated public IP and keeps only the exact fixture-origin path exception', async () => {
  const received: { path: string; host: string; proxyAuth?: string }[] = [];
  const originServer = createServer((req, res) => {
    received.push({
      path: req.url || '',
      host: req.headers.host || '',
      proxyAuth: req.headers['proxy-authorization'],
    });
    res.end('SYNTHETIC-PROXY-47');
  });
  const origin = await listen(originServer);
  const targetPort = Number(new URL(origin).port);
  const dialled: string[] = [];
  let addresses = [{ address: '93.184.216.34', family: 4 }];
  const proxy = await createProxy({
    fixtureOrigin: origin,
    resolve: async () => addresses,
    dial: async (address, port) => {
      dialled.push(`${address}:${port}`);
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(targetPort, '127.0.0.1', () => resolve(socket));
        socket.on('error', reject);
      });
    },
  });
  try {
    assert.deepEqual(
      await get(proxy.url, 'http://public.example.test/mock?item=47', {
        'proxy-authorization': 'Bearer synthetic-not-for-origin',
      }),
      { status: 200, text: 'SYNTHETIC-PROXY-47' },
    );
    assert.equal(dialled[0], '93.184.216.34:80');
    assert.deepEqual(received[0], {
      path: '/mock?item=47',
      host: 'public.example.test',
      proxyAuth: undefined,
    });
    assert.equal((await get(proxy.url, `${origin}/fixture/mock`)).status, 200);
    const calls = dialled.length;
    for (const url of [
      `${origin}/api/state`,
      `${origin}/fixture/../api/state`,
      `${origin}/fixture-malicious`,
      'http://127.1/api/state',
      'http://169.254.169.254/latest/meta-data/',
      'http://mock-user:mock-password@public.example.test/',
      'file:///etc/passwd',
      'https://public.example.test/',
    ])
      assert.equal((await get(proxy.url, url)).status, 403, url);
    addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    assert.equal((await get(proxy.url, 'http://mixed.example.test/')).status, 403);
    assert.equal(
      dialled.length,
      calls,
      'private and mixed answers must fail before a socket is opened',
    );
  } finally {
    await proxy.close();
    await close(originServer);
  }
});

test('browser CONNECT transport uses a pinned address and closes live tunnels when the proxy closes', async () => {
  const upstream = createTcpServer();
  const peers = new Set<Socket>();
  upstream.on('connection', (socket) => {
    peers.add(socket);
    socket.on('data', (data) => socket.write(`ACK:${data.toString('utf8')}`));
    socket.on('close', () => peers.delete(socket));
  });
  const origin = await listen(upstream);
  const dialled: string[] = [];
  const proxy = await createProxy({
    fixtureOrigin: 'http://127.0.0.1:18766',
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dial: async (address, port) => {
      dialled.push(`${address}:${port}`);
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(Number(new URL(origin).port), '127.0.0.1', () => resolve(socket));
        socket.on('error', reject);
      });
    },
  });
  try {
    const established = await tunnel(proxy.url, 'public.example.test:443');
    assert.equal(established.status, 200);
    assert.deepEqual(dialled, ['93.184.216.34:443']);
    const reply = new Promise<string>((resolve) =>
      established.socket.once('data', (data) => resolve(data.toString('utf8'))),
    );
    established.socket.write('MOCK-TUNNEL-53');
    assert.equal(await reply, 'ACK:MOCK-TUNNEL-53');
    const disconnected = new Promise<unknown>((resolve) =>
      established.socket.once('close', resolve),
    );
    await proxy.close();
    await disconnected;
  } finally {
    await proxy.close();
    for (const peer of peers) peer.destroy();
    await close(upstream);
  }
});

test('configured upstream receives only a pinned public CONNECT destination and its own synthetic credentials', async () => {
  const target = createServer((_req, res) => res.end('SYNTHETIC-UPSTREAM-59'));
  const targetOrigin = await listen(target);
  const hops: { authority: string; auth: string | undefined }[] = [];
  const sockets = new Set<Duplex>();
  const gateway = createServer();
  gateway.on('connect', (req, socket, head) => {
    hops.push({ authority: req.url || '', auth: req.headers['proxy-authorization'] });
    sockets.add(socket);
    socket.on('error', () => {});
    const destination = connect(Number(new URL(targetOrigin).port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) destination.write(head);
      socket.pipe(destination);
      destination.pipe(socket);
    });
    sockets.add(destination);
    destination.on('error', () => socket.destroy());
  });
  const gatewayOrigin = await listen(gateway);
  const proxy = await createProxy({
    fixtureOrigin: 'http://127.0.0.1:18766',
    upstream: gatewayOrigin.replace('http://', 'http://mock-user:mock-password@'),
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  try {
    assert.equal(
      (await get(proxy.url, 'http://public.example.test/mock')).text,
      'SYNTHETIC-UPSTREAM-59',
    );
    assert.deepEqual(hops, [
      {
        authority: '93.184.216.34:80',
        auth: `Basic ${Buffer.from('mock-user:mock-password').toString('base64')}`,
      },
    ]);
    assert.equal((await get(proxy.url, 'http://10.0.0.1/private')).status, 403);
    assert.equal(hops.length, 1);
  } finally {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await close(gateway);
    await close(target);
  }
});
