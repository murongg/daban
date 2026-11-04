import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SearchProvider } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { SearchClient } from './search.js';

const transport = vi.hoisted(() => ({ resolve: vi.fn(), dial: vi.fn(), request: vi.fn() }));
vi.mock('./network.js', async (original) => ({
  ...(await original<typeof import('./network.js')>()),
  resolvePublic: transport.resolve,
  dialAddress: transport.dial,
}));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));

const secret = 'synthetic-search-key';
const url = 'https://source.example.test/original?q=one%20two&order=2&order=1';
const deepseekResult = () => ({
  results: [
    {
      url,
      title: 'Synthetic result',
      snippet: 'Synthetic summary',
      date: '2026-01-02T00:00:00Z',
      content: 'This page must not be fetched or projected.',
    },
  ],
});
const braveResult = () => ({
  web: {
    results: [
      {
        url,
        title: 'Synthetic result',
        description: 'Synthetic summary',
        page_age: '2026-01-02T00:00:00Z',
      },
    ],
  },
  news: { results: [{ url: 'https://news.example.test/ignored' }] },
});

test('DeepSeek sends one bounded official request without original question or localization', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(deepseekResult()));
  const result = await new SearchClient(request).query('deepseek', secret, 'synthetic query');
  expect(request).toHaveBeenCalledTimes(1);
  const [destination, init] = request.mock.calls[0];
  expect(String(destination)).toBe('https://api.deepseek.com/v1/tools/search');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
  expect(new Headers(init?.headers).has('cookie')).toBe(false);
  expect(init?.redirect).toBe('error');
  expect(init?.credentials).toBe('omit');
  expect(JSON.parse(String(init?.body))).toStrictEqual({
    query: 'synthetic query',
    count: 5,
    need_content: false,
  });
  expect(result).toStrictEqual({
    sources: [
      {
        url,
        title: 'Synthetic result',
        snippet: 'Synthetic summary',
        publishedAt: '2026-01-02T00:00:00Z',
      },
    ],
    truncated: false,
  });
});

test('Brave sends only a web query and uses its own header without a DeepSeek bearer', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(braveResult()));
  const result = await new SearchClient(request).query(
    'brave',
    secret,
    'synthetic query',
    undefined,
    3,
  );
  expect(request).toHaveBeenCalledTimes(1);
  const [destination, init] = request.mock.calls[0];
  const endpoint = new URL(String(destination));
  expect(endpoint.origin + endpoint.pathname).toBe(
    'https://api.search.brave.com/res/v1/web/search',
  );
  expect(Object.fromEntries(endpoint.searchParams)).toStrictEqual({
    q: 'synthetic query',
    count: '3',
    result_filter: 'web',
  });
  expect(init?.method).toBe('GET');
  expect(init?.body).toBeUndefined();
  const headers = new Headers(init?.headers);
  expect(headers.get('x-subscription-token')).toBe(secret);
  expect(headers.has('authorization')).toBe(false);
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0]).toStrictEqual({
    url,
    title: 'Synthetic result',
    snippet: 'Synthetic summary',
    publishedAt: '2026-01-02T00:00:00Z',
  });
});

test('Unicode query limits count code points and never silently truncate the accepted query', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ results: [] }));
  const client = new SearchClient(request);
  await client.query('deepseek', secret, '😀'.repeat(128));
  expect(JSON.parse(String(request.mock.calls[0][1]?.body)).query).toBe('😀'.repeat(128));
  await expect(client.query('deepseek', secret, '😀'.repeat(129))).rejects.toMatchObject({
    code: 'SEARCH_QUERY_TOO_LONG',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test('Brave query characters and words are rejected before any request', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json(braveResult()));
  const client = new SearchClient(request);
  await client.query('brave', secret, '😀'.repeat(600));
  for (const query of ['😀'.repeat(601), Array.from({ length: 76 }, () => 'x').join(' ')])
    await expect(client.query('brave', secret, query)).rejects.toMatchObject({
      code: 'SEARCH_QUERY_TOO_LONG',
    });
  expect(request).toHaveBeenCalledTimes(1);
});

test('blank queries, invalid keys and result bounds cannot dispatch paid searches', async () => {
  const request = vi.fn<typeof fetch>();
  const client = new SearchClient(request);
  for (const query of ['', ' \t\n'])
    await expect(client.query('deepseek', secret, query)).rejects.toMatchObject({
      code: 'SEARCH_INVALID_QUERY',
    });
  await expect(client.query('deepseek', 'key\nheader', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_INVALID_CREDENTIAL',
  });
  for (const maxResults of [0, 6, 1.5, Number.NaN])
    await expect(
      client.query('deepseek', secret, 'synthetic', undefined, maxResults),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
  expect(request).not.toHaveBeenCalled();
});

test('empty search results are success and over-returned results are capped to five', async () => {
  for (const provider of ['deepseek', 'brave'] as const) {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(provider === 'deepseek' ? { results: [] } : { web: { results: [] } }),
    );
    expect(await new SearchClient(request).query(provider, secret, 'synthetic')).toStrictEqual({
      sources: [],
      truncated: false,
    });
  }
  const results = Array.from({ length: 7 }, (_, index) => ({
    ...deepseekResult().results[0],
    url: `https://source.example.test/result-${index}`,
  }));
  const request = vi.fn<typeof fetch>(async () => Response.json({ results }));
  const result = await new SearchClient(request).query('deepseek', secret, 'synthetic');
  expect(result.sources).toHaveLength(5);
  expect(result.truncated).toBe(true);
});

test('the documented nullable Brave web container is a successful empty result', async () => {
  for (const body of [{ type: 'search', web: null }, { type: 'search' }]) {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...body,
        news: { results: [{ url: 'https://news.example.test/ignored' }] },
      }),
    );
    expect(await new SearchClient(request).query('brave', secret, 'synthetic')).toStrictEqual({
      sources: [],
      truncated: false,
    });
  }
});

test('source URLs retain their exact path and query but private, malformed and credential URLs are rejected', async () => {
  for (const source of [
    'file:///etc/passwd',
    'https://name:secret@source.example.test/a',
    'http://127.0.0.1/a',
    'http://2130706433/a',
    'http://[::1]/a',
    'http://[::ffff:127.0.0.1]/a',
    'http://169.254.169.254/a',
    'http://10.0.0.2/a',
    'https://localhost/a',
    'https://host.local/a',
    'https://private/a',
    'https://source.example.test/\nmodified',
    `https://source.example.test/?key=${secret}`,
    'https://source.example.test/?key=%73ynthetic-search-key',
  ]) {
    const value = deepseekResult();
    value.results[0].url = source;
    const request = vi.fn<typeof fetch>(async () => Response.json(value));
    await expect(
      new SearchClient(request).query('deepseek', secret, 'synthetic'),
    ).rejects.toMatchObject({
      code: 'SEARCH_INVALID_RESPONSE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
});

test('provider-controlled text is bounded and redacted without projecting unused page content', async () => {
  const value = deepseekResult();
  value.results[0].title = `${secret} ${'T'.repeat(1000)}`;
  value.results[0].snippet = `Bearer synthetic-other-secret ${secret} ${'S'.repeat(6000)}`;
  value.results[0].content = secret;
  const request = vi.fn<typeof fetch>(async () => Response.json(value));
  const result = await new SearchClient(request).query('deepseek', secret, 'synthetic');
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('synthetic-other-secret');
  expect(result.sources[0].title!.length).toBeLessThanOrEqual(500);
  expect(result.sources[0].snippet!.length).toBeLessThanOrEqual(2000);
  expect(result.sources[0]).not.toHaveProperty('content');
});

test('a valid provider timestamp cannot reflect even a short credential into source metadata', async () => {
  const value = deepseekResult();
  value.results[0].date = '2042-01-02T00:00:00Z';
  const request = vi.fn<typeof fetch>(async () => Response.json(value));
  await expect(
    new SearchClient(request).query('deepseek', '2042', 'synthetic'),
  ).rejects.toMatchObject({
    code: 'SEARCH_INVALID_RESPONSE',
  });
});

test.each([
  [401, 'SEARCH_UNAUTHORIZED'],
  [403, 'SEARCH_FORBIDDEN'],
  [429, 'SEARCH_RATE_LIMITED'],
  [500, 'SEARCH_UNAVAILABLE'],
  [503, 'SEARCH_UNAVAILABLE'],
  [302, 'SEARCH_UNAVAILABLE'],
])('HTTP %s is classified as %s and is never retried or reflected', async (status, code) => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(`${secret}: private provider error`, {
        status,
        headers: { 'retry-after': '12' },
      }),
  );
  try {
    await new SearchClient(request).query('brave', secret, 'synthetic');
    expect.fail('Expected provider failure');
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('private provider error');
    if (status === 429) expect(error).toHaveProperty('retryAfter', 12);
  }
  expect(request).toHaveBeenCalledTimes(1);
});

test('untrusted Retry-After headers are not returned as UI text', async () => {
  for (const retryAfter of ['-3', '9999999999999999999999', secret, '12 seconds', '1.5']) {
    const request = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
    );
    await expect(
      new SearchClient(request).query('brave', secret, 'synthetic'),
    ).rejects.toMatchObject({
      code: 'SEARCH_RATE_LIMITED',
      retryAfter: undefined,
    });
  }
});

test('DNS and TLS exceptions are stable unavailable errors without retries or secret-bearing causes', async () => {
  for (const reason of ['SYNTHETIC_DNS', 'SYNTHETIC_TLS']) {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error(`${reason} ${secret}`);
    });
    await expect(
      new SearchClient(request).query('deepseek', secret, 'synthetic'),
    ).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
      message: 'SEARCH_UNAVAILABLE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
});

test('cancellation before dispatch and cancellation of an in-flight request never publish sources', async () => {
  const request = vi.fn<typeof fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
  const before = new AbortController();
  before.abort();
  await expect(
    new SearchClient(request).query('brave', secret, 'synthetic', before.signal),
  ).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  expect(request).not.toHaveBeenCalled();
  const during = new AbortController();
  const pending = new SearchClient(request).query('brave', secret, 'synthetic', during.signal);
  during.abort();
  await expect(pending).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  expect(request).toHaveBeenCalledTimes(1);
});

test('the search deadline bounds dispatch and response consumption', async () => {
  const request = vi.fn<typeof fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
  await expect(
    new SearchClient(request, 5).query('deepseek', secret, 'synthetic'),
  ).rejects.toMatchObject({
    code: 'SEARCH_TIMEOUT',
  });
  const stalled = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>()));
  await expect(
    new SearchClient(stalled, 5).query('brave', secret, 'synthetic'),
  ).rejects.toMatchObject({
    code: 'SEARCH_TIMEOUT',
  });
});

test('late responses from an uncooperative transport cannot survive cancellation', async () => {
  const abort = new AbortController();
  const request = vi.fn<typeof fetch>(async () => {
    abort.abort();
    return Response.json(deepseekResult());
  });
  await expect(
    new SearchClient(request).query('deepseek', secret, 'synthetic', abort.signal),
  ).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
});

test('an immediately rejected transport remains observed when cancellation wins the dispatch race', async () => {
  const abort = new AbortController();
  const request = vi.fn<typeof fetch>(async () => {
    abort.abort();
    throw new Error('synthetic transport stopped');
  });
  await expect(
    new SearchClient(request).query('deepseek', secret, 'synthetic', abort.signal),
  ).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  await new Promise<unknown>((resolve) => setImmediate(() => resolve(undefined)));
});

test('a stalled response cancellation cannot extend the search deadline', async () => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => new Promise<undefined>(() => {}),
        }),
      ),
  );
  const missedDeadline = new Promise<string>((resolve) => {
    setTimeout(() => resolve('MISSED_DEADLINE'), 100);
  });
  await expect(
    Promise.race([
      new SearchClient(request, 5).query('deepseek', secret, 'synthetic'),
      missedDeadline,
    ]),
  ).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
});

test('invalid JSON, malformed source structures, excessive nesting and oversized bodies are rejected', async () => {
  const deeplyNested = `${'{"nested":'.repeat(30)}null${'}'.repeat(30)}`;
  for (const body of [
    '{broken',
    '{"web":[]}',
    '{"results":null}',
    '{"results":[{"url":123,"title":"synthetic","snippet":"summary"}]}',
    '{"results":[{"url":"https://source.example.test","title":null,"snippet":"summary"}]}',
    deeplyNested,
    JSON.stringify({ results: [], ignored: 'x'.repeat(1024 * 1024) }),
  ]) {
    const request = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(
      new SearchClient(request).query('deepseek', secret, 'synthetic'),
    ).rejects.toMatchObject({
      code: 'SEARCH_INVALID_RESPONSE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
});

test('the default transport pins the validated public dial and refuses response redirects', async () => {
  const socket = new PassThrough();
  transport.resolve.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  transport.dial.mockResolvedValue(socket);
  let options: Record<string, unknown> | undefined;
  transport.request.mockImplementation(
    (input: Record<string, unknown>, callback: (value: EventEmitter) => unknown) => {
      options = input;
      const response = Object.assign(new EventEmitter(), {
        statusCode: 302,
        headers: { location: 'https://attacker.example.test/collect' },
        destroy: vi.fn(),
      });
      const request = Object.assign(new EventEmitter(), {
        end: () => {
          callback(response);
          response.emit('end');
        },
        destroy: (error: unknown) => request.emit('error', error),
      });
      return request;
    },
  );
  await expect(new SearchClient().query('deepseek', secret, 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_UNAVAILABLE',
  });
  expect(transport.resolve).toHaveBeenCalledWith('api.deepseek.com', expect.any(AbortSignal));
  expect(transport.dial).toHaveBeenCalledWith('8.8.8.8', 443, expect.any(AbortSignal));
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(options?.hostname).toBe('api.deepseek.com');
  expect(options?.path).toBe('/v1/tools/search');
  expect(socket.destroyed).toBe(true);
});

test('unknown runtime providers never receive a credential', async () => {
  const request = vi.fn<typeof fetch>();
  await expect(
    new SearchClient(request).query('unknown' as SearchProvider, secret, 'synthetic'),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_PROVIDER' });
  expect(request).not.toHaveBeenCalled();
});
