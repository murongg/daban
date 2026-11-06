import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SearchClient } from './search.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

const transport = vi.hoisted(() => ({
  resolve: vi.fn(),
  dial: vi.fn(),
  request: vi.fn(),
  tls: vi.fn(),
}));
vi.mock('node:tls', async (original) => ({
  ...(await original<typeof import('node:tls')>()),
  connect: transport.tls,
}));
vi.mock('./network.js', async (original) => ({
  ...(await original<typeof import('./network.js')>()),
  resolvePublic: transport.resolve,
  dialAddress: transport.dial,
}));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));

const roots: string[] = [];
beforeEach(() => {
  for (const key of [
    'DSH_NETWORK_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ])
    vi.stubEnv(key, '');
  transport.resolve.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  transport.dial.mockImplementation(async () => new PassThrough());
  transport.tls.mockImplementation(() => {
    const tls = new PassThrough();
    queueMicrotask(() => tls.emit('secureConnect'));
    return tls;
  });
  transport.request.mockImplementation(
    (_input: unknown, callback: (response: EventEmitter) => unknown) => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
      });
      const request = Object.assign(new EventEmitter(), {
        end: () => {
          callback(response);
          response.emit('data', Buffer.from('<p class="no-results">Synthetic empty result</p>'));
          response.emit('end');
        },
        destroy: (error?: Error) => {
          if (error) request.emit('error', error);
        },
      });
      return request;
    },
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const query = (client = new SearchClient()) => client.query('duckduckgo', '', 'synthetic query');

test.each(['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'DSH_NETWORK_PROXY'])(
  '%s routes both search DNS and the pinned public socket through the configured proxy',
  async (name) => {
    const upstream = new URL('http://mock-user:mock-password@127.0.0.1:19876');
    vi.stubEnv(name, upstream.href);
    await query();
    expect(transport.resolve).toHaveBeenCalledWith(
      'lite.duckduckgo.com',
      expect.any(AbortSignal),
      undefined,
      upstream,
    );
    expect(transport.dial).toHaveBeenCalledWith('8.8.8.8', 443, expect.any(AbortSignal), upstream);
    const options = transport.request.mock.calls[0][0];
    expect(options.headers['proxy-authorization']).toBeUndefined();
    expect(options.hostname).toBe('lite.duckduckgo.com');
    expect(transport.request).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['*', true],
  ['lite.duckduckgo.com', true],
  ['duckduckgo.com', true],
  ['.duckduckgo.com', true],
  ['*.duckduckgo.com:443', true],
  ['duckduckgo.com:80', false],
  ['other.example.test', false],
  ['duckduckgo.co', false],
] as const)('NO_PROXY=%s bypasses only matching destinations (%s)', async (bypass, direct) => {
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:19876');
  vi.stubEnv('NO_PROXY', bypass);
  await query();
  expect(transport.dial.mock.calls[0][3]).toEqual(
    direct ? undefined : new URL('http://127.0.0.1:19876'),
  );
});

async function settings(proxy: unknown, raw = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-proxy-'));
  roots.push(root);
  await writeFile(path.join(root, 'network.json'), raw ? String(proxy) : JSON.stringify({ proxy }));
  const models = new ModelSettings(path.join(root, 'models.json'));
  return new SearchSettings(path.join(root, 'search.json'), models);
}

test.each(['http://127.0.0.1:19877', null])(
  'the Host network file is authoritative, including an explicit disabled proxy: %s',
  async (proxy) => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:19876');
    const search = await settings(proxy);
    await search.query(await search.capture(), 'synthetic query');
    expect(transport.dial.mock.calls[0][3]).toEqual(proxy ? new URL(proxy) : undefined);
  },
);

test.each(['socks5://127.0.0.1:19876', 'http://127.0.0.1:19876/path', 'malformed'])(
  'an invalid environment proxy fails closed without a direct request: %s',
  async (proxy) => {
    vi.stubEnv('https_proxy', proxy);
    await expect(query()).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    expect(transport.dial).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  },
);

test.each([42, '{malformed'])('an invalid Host network file fails closed: %s', async (value) => {
  const search = await settings(value, typeof value === 'string');
  await expect(search.query(await search.capture(), 'synthetic query')).rejects.toMatchObject({
    code: 'SEARCH_UNAVAILABLE',
  });
  expect(transport.dial).not.toHaveBeenCalled();
});
