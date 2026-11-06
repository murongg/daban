import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import { afterEach, expect, test, vi } from 'vitest';
import { SearchClient } from './search.js';
import { tlsFixture } from './tls.fixture.js';

const transport = vi.hoisted(() => ({ ca: [] as Buffer[], tls: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '198.18.0.2', family: 4 }],
}));
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>();
  return {
    ...actual,
    connect: (options: ConnectionOptions) => {
      transport.tls(options);
      return actual.connect({ ...options, ca: transport.ca });
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  transport.ca = [];
});

test('synthetic CONNECT and verified TLS carry fake-IP DNS and one search, but never forward proxy credentials or trust an unverified origin', async () => {
  let searches = 0;
  const supplier = await tlsFixture(async (req, res) => {
    searches++;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/lite/');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(Buffer.from(chunk));
    expect([...new URLSearchParams(Buffer.concat(body).toString('utf8'))]).toEqual([
      ['q', 'synthetic query'],
    ]);
    expect(req.headers.host).toBe('lite.duckduckgo.com');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['proxy-authorization']).toBeUndefined();
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<table><tr><td><a class="result-link" href="https://source.example.test/page">Synthetic source</a></td></tr></table>',
    );
  }, 'lite.duckduckgo.com');
  const resolver = await tlsFixture((req, res) => {
    expect(req.url).toBe('/dns-query?name=lite.duckduckgo.com&type=A');
    expect(req.headers['proxy-authorization']).toBeUndefined();
    res.setHeader('content-type', 'application/dns-json');
    res.end(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] }));
  }, 'cloudflare-dns.com');
  const peers = new Set<Duplex>();
  const hops: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    hops.push(req.url ?? '');
    expect(req.headers['proxy-authorization']).toBe(
      `Basic ${Buffer.from('mock-user:mock-password').toString('base64')}`,
    );
    const endpoint = req.url === '1.1.1.1:443' ? resolver.endpoint : supplier.endpoint;
    expect(['1.1.1.1:443', '8.8.8.8:443']).toContain(req.url);
    const target = connect(Number(new URL(endpoint).port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    for (const peer of [socket, target]) {
      peers.add(peer);
      peer.on('error', () => socket.destroy());
    }
  });
  await new Promise<undefined>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic proxy listener missing');
  for (const key of ['DSH_NETWORK_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, '');
  vi.stubEnv('https_proxy', `http://mock-user:mock-password@127.0.0.1:${address.port}`);
  transport.ca = [supplier.ca, resolver.ca];
  try {
    expect(await new SearchClient().query('duckduckgo', '', 'synthetic query')).toMatchObject({
      sources: [{ url: 'https://source.example.test/page', title: 'Synthetic source' }],
    });
    expect(hops).toEqual(['1.1.1.1:443', '8.8.8.8:443']);
    expect(transport.tls.mock.calls.map(([options]) => options.servername)).toEqual([
      'cloudflare-dns.com',
      'lite.duckduckgo.com',
    ]);
    expect(transport.tls.mock.calls.every(([options]) => options.rejectUnauthorized === true)).toBe(
      true,
    );
    transport.ca = [resolver.ca];
    await expect(
      new SearchClient().query('duckduckgo', '', 'synthetic query'),
    ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    expect(searches).toBe(1);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<undefined>((resolve) => proxy.close(() => resolve(undefined)));
    await Promise.all([resolver.close(), supplier.close()]);
  }
});
