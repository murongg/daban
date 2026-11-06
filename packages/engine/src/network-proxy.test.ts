import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { resolvePublic } from './network.js';

const transport = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  tls: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  request: transport.connect,
}));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));
vi.mock('node:tls', async (original) => ({
  ...(await original<typeof import('node:tls')>()),
  connect: transport.tls,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function mockProxyDns(
  options: { address?: string; status?: number; encoding?: string; large?: boolean } = {},
) {
  transport.lookup.mockResolvedValue([{ address: '198.18.0.2', family: 4 }]);
  const direct = vi.fn(async () => {
    throw new Error('synthetic direct DNS unavailable');
  });
  vi.stubGlobal('fetch', direct);
  const socket = new PassThrough();
  transport.tls.mockReturnValue(socket);
  transport.connect.mockImplementation(() => {
    const request = Object.assign(new EventEmitter(), {
      end: () => request.emit('connect', { statusCode: 200 }, socket, Buffer.alloc(0)),
      destroy: () => {},
    });
    return request;
  });
  transport.request.mockImplementation(
    (
      requestOptions: { agent: { createConnection: () => unknown } },
      callback: (response: EventEmitter) => unknown,
    ) => {
      requestOptions.agent.createConnection();
      const response = Object.assign(new EventEmitter(), {
        statusCode: options.status ?? 200,
        headers: options.encoding ? { 'content-encoding': options.encoding } : {},
        destroy: vi.fn(),
      });
      return Object.assign(new EventEmitter(), {
        end: () => {
          callback(response);
          response.emit(
            'data',
            Buffer.from(
              options.large
                ? 'x'.repeat(16385)
                : JSON.stringify({
                    Status: 0,
                    Answer: [{ type: 1, data: options.address ?? '8.8.8.8' }],
                  }),
            ),
          );
          response.emit('end');
        },
      });
    },
  );
  return { direct, socket };
}

test('proxy fake-IP DNS fallback uses CONNECT to the fixed public resolver and verifies its TLS name', async () => {
  const { direct, socket } = mockProxyDns();
  const upstream = new URL('http://mock-user:mock-password@127.0.0.1:19876');
  const result = await Reflect.apply(resolvePublic, undefined, [
    'supplier.example.test',
    new AbortController().signal,
    undefined,
    upstream,
  ]);
  expect(result).toEqual([{ address: '8.8.8.8', family: 4 }]);
  expect(direct).not.toHaveBeenCalled();
  expect(transport.connect.mock.calls[0][0]).toMatchObject({
    hostname: '127.0.0.1',
    path: '1.1.1.1:443',
    method: 'CONNECT',
    headers: {
      'proxy-authorization': `Basic ${Buffer.from('mock-user:mock-password').toString('base64')}`,
    },
  });
  expect(transport.tls).toHaveBeenCalledWith(
    expect.objectContaining({
      socket,
      servername: 'cloudflare-dns.com',
      rejectUnauthorized: true,
    }),
  );
  expect(transport.request.mock.calls[0][0]).toMatchObject({ hostname: 'cloudflare-dns.com' });
  expect(socket.destroyed).toBe(true);
});

test.each([
  { address: '127.0.0.1' },
  { address: '198.18.0.4' },
  { address: 'not-an-ip' },
  { status: 302 },
  { encoding: 'gzip' },
  { large: true },
])('proxy DNS refuses unsafe answers: %o', async (options) => {
  const { direct, socket } = mockProxyDns(options);
  await expect(
    resolvePublic(
      'supplier.example.test',
      new AbortController().signal,
      undefined,
      new URL('http://127.0.0.1:19876'),
    ),
  ).rejects.toBeDefined();
  expect(direct).not.toHaveBeenCalled();
  expect(socket.destroyed).toBe(true);
  expect(transport.connect).toHaveBeenCalledTimes(1);
});

test('a mixed fake/private OS answer cannot acquire a proxy DNS fallback', async () => {
  mockProxyDns();
  transport.lookup.mockResolvedValue([
    { address: '198.18.0.2', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    resolvePublic(
      'supplier.example.test',
      new AbortController().signal,
      undefined,
      new URL('http://127.0.0.1:19876'),
    ),
  ).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });
  expect(transport.connect).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
});
