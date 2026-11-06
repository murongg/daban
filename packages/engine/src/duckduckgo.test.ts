import type { SearchProvider } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { SearchClient } from './search.js';

const provider = 'duckduckgo' as SearchProvider;
const page = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const hit = (
  url = 'https://source.example.test/original?x=1&y=2',
  title = 'Synthetic &amp; title',
  snippet = 'Synthetic <b>snippet</b>',
) =>
  `<tr><td>1.</td><td><a class="result-link" href="${url.replaceAll('&', '&amp;')}">${title}</a></td></tr><tr><td></td><td class="result-snippet">${snippet}</td></tr>`;

test('DuckDuckGo sends one keyless fixed-site HTML request and returns normalized sources', async () => {
  const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    page(`<table>${hit()}</table>`),
  );
  const client = new SearchClient(request);
  expect(await client.query(provider, '', 'synthetic query')).toEqual({
    sources: [
      {
        url: 'https://source.example.test/original?x=1&y=2',
        title: 'Synthetic & title',
        snippet: 'Synthetic snippet',
      },
    ],
    truncated: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
  const [input, init] = request.mock.calls[0];
  const url = new URL(String(input));
  expect(url.origin + url.pathname).toBe('https://lite.duckduckgo.com/lite/');
  expect([...url.searchParams]).toEqual([['q', 'synthetic query']]);
  const headers = new Headers(init?.headers);
  for (const name of ['authorization', 'x-subscription-token', 'cookie'])
    expect(headers.has(name)).toBe(false);
  expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
});

test('DuckDuckGo unwraps only declared result redirects and preserves the exact destination query', async () => {
  const target = 'https://source.example.test/report?edition=a%20b&scope=synthetic';
  const client = new SearchClient(async () =>
    page(
      `<table>${hit(`//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=synthetic`)}</table>`,
    ),
  );
  expect((await client.query(provider, '', 'synthetic')).sources[0].url).toBe(target);
});

test('DuckDuckGo applies the five-source output bound and reports truncation', async () => {
  const client = new SearchClient(async () =>
    page(
      `<table>${Array.from({ length: 6 }, (_, i) => hit(`https://source.example.test/${i}`)).join('')}</table>`,
    ),
  );
  const result = await client.query(provider, '', 'synthetic');
  expect(result.sources).toHaveLength(5);
  expect(result.truncated).toBe(true);
});

test('explicit no-results is successful but arbitrary or malformed HTML is not an empty search', async () => {
  const empty = new SearchClient(async () =>
    page('<div class="no-results">No results found for synthetic query.</div>'),
  );
  expect(await empty.query(provider, '', 'synthetic')).toEqual({ sources: [], truncated: false });
  const invalid = new SearchClient(async () => page('<p>Synthetic maintenance page</p>'));
  await expect(invalid.query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_INVALID_RESPONSE',
  });
});

test('challenge pages are refused without retries or another supplier request', async () => {
  const request = vi.fn(async () =>
    page(
      '<form id="challenge-form" action="//duckduckgo.com/anomaly.js"><p>Synthetic verification</p></form>',
    ),
  );
  await expect(new SearchClient(request).query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_FORBIDDEN',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([
  'http://127.0.0.1/private',
  'javascript:alert(1)',
  'https://source.example.test/\nprivate',
])('unsafe result URLs fail closed: %s', async (url) => {
  await expect(
    new SearchClient(async () => page(`<table>${hit(url)}</table>`)).query(
      provider,
      '',
      'synthetic',
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
});

test('DuckDuckGo refuses credentials before dispatch and preserves the original final-send gate', async () => {
  const request = vi.fn(async () => page(`<table>${hit()}</table>`));
  const client = new SearchClient(request);
  await expect(
    client.query(provider, 'synthetic-other-provider-key', 'synthetic'),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CREDENTIAL' });
  expect(request).not.toHaveBeenCalled();
  const refusal = new Error('SYNTHETIC_RETIRED_OWNER');
  await expect(
    client.query(provider, '', 'synthetic', undefined, 5, () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(request).not.toHaveBeenCalled();
});

test('oversized and deeply nested HTML are bounded without granting source authority', async () => {
  const large = new SearchClient(async () => page('x'.repeat(1024 * 1024 + 1)));
  await expect(large.query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_INVALID_RESPONSE',
  });
  const nested = new SearchClient(async () =>
    page(`${'<div>'.repeat(600)}${hit()}${'</div>'.repeat(600)}`),
  );
  await expect(nested.query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_INVALID_RESPONSE',
  });
});

test('ordinary DuckDuckGo destination pages are valid sources rather than malformed redirect wrappers', async () => {
  const client = new SearchClient(async () =>
    page(`<table>${hit('https://duckduckgo.com/about')}</table>`),
  );
  expect((await client.query(provider, '', 'synthetic')).sources[0].url).toBe(
    'https://duckduckgo.com/about',
  );
});

test('large flat DOMs cannot consume unbounded selector work', async () => {
  const client = new SearchClient(async () =>
    page(`${'<i></i>'.repeat(50001)}<table>${hit()}</table>`),
  );
  await expect(client.query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_INVALID_RESPONSE',
  });
});

test.each(['deepseek', 'brave', 'duckduckgo'] as const)(
  'a lost response stream stays an unknown transport failure for %s',
  async (selected) => {
    const request = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('SYNTHETIC_STREAM_LOST'));
            },
          }),
          {
            headers: {
              'content-type': selected === 'duckduckgo' ? 'text/html' : 'application/json',
            },
          },
        ),
    );
    await expect(
      new SearchClient(request).query(
        selected,
        selected === 'duckduckgo' ? '' : 'synthetic-key',
        'synthetic',
      ),
    ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    expect(request).toHaveBeenCalledTimes(1);
  },
);
