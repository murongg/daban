import {
  isSearchProvider,
  isSearchStatus,
  isSearchUpdate,
  searchRequiresKey,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { SearchClient } from './search.js';

const provider = 'bing';
const page = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const hit = (url = 'https://source.example.test/report?q=a%20b&edition=1') =>
  `<li class="b_algo"><h2><a href="${url.replaceAll('&', '&amp;')}">Synthetic &amp; source</a></h2><div class="b_caption"><p>Synthetic <b>snippet</b></p></div></li>`;

test('Bing is a keyless provider in the public contract and cannot receive another provider credential', () => {
  expect(isSearchProvider(provider)).toBe(true);
  expect(searchRequiresKey(provider)).toBe(false);
  expect(isSearchUpdate({ requestId: 'mock-bing', revision: 0, enabled: true, provider })).toBe(
    true,
  );
  expect(
    isSearchUpdate({
      requestId: 'mock-bing',
      revision: 0,
      enabled: true,
      provider,
      key: 'synthetic-key',
    }),
  ).toBe(false);
  expect(
    isSearchStatus({
      revision: 0,
      checkRevision: 0,
      enabled: true,
      provider,
      credentialConfigured: false,
      credentialSource: 'none',
      health: 'ready',
    }),
  ).toBe(true);
});

test('Bing sends one browser-compatible GET without credentials and projects exact organic source URLs', async () => {
  const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    page(`<ol id="b_results">${hit()}</ol>`),
  );
  const result = await new SearchClient(request).query(provider, '', 'synthetic query');
  expect(result).toEqual({
    sources: [
      {
        url: 'https://source.example.test/report?q=a%20b&edition=1',
        title: 'Synthetic & source',
        snippet: 'Synthetic snippet',
      },
    ],
    truncated: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
  const [input, init] = request.mock.calls[0];
  expect(new URL(String(input)).origin + new URL(String(input)).pathname).toBe(
    'https://cn.bing.com/search',
  );
  expect([...new URL(String(input)).searchParams]).toEqual([['q', 'synthetic query']]);
  expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
  const headers = new Headers(init?.headers);
  expect(headers.get('user-agent')).toContain('Chrome/');
  expect(headers.get('accept-language')).toContain('zh-CN');
  expect(headers.get('accept')).toContain('text/html');
  for (const name of ['authorization', 'x-subscription-token', 'cookie'])
    expect(headers.has(name)).toBe(false);
});

test('Bing unwraps its declared redirect once and keeps destination query bytes unchanged', async () => {
  const target = 'https://source.example.test/report?q=a%20b&edition=synthetic';
  const encoded = Buffer.from(target).toString('base64url');
  const client = new SearchClient(async () =>
    page(`<ol id="b_results">${hit(`https://www.bing.com/ck/a?u=a1${encoded}&ntb=1`)}</ol>`),
  );
  expect((await client.query(provider, '', 'synthetic')).sources[0].url).toBe(target);
});

test('Bing prefers the result heading over an earlier site-label link', async () => {
  const body = hit().replace(
    '<h2>',
    '<a class="tilk" href="https://source.example.test/" aria-label="Synthetic site">Synthetic site</a><h2>',
  );
  const result = await new SearchClient(async () => page(`<ol id="b_results">${body}</ol>`)).query(
    provider,
    '',
    'synthetic',
  );
  expect(result.sources[0]).toMatchObject({
    url: 'https://source.example.test/report?q=a%20b&edition=1',
    title: 'Synthetic & source',
  });
});

test('Bing skips ads and bounds organic results', async () => {
  const client = new SearchClient(async () =>
    page(
      `<ol id="b_results"><li class="b_ad"><h2><a href="https://ads.example.test/">Synthetic ad</a></h2></li>${Array.from({ length: 6 }, (_, index) => hit(`https://source.example.test/${index}`)).join('')}</ol>`,
    ),
  );
  const result = await client.query(provider, '', 'synthetic');
  expect(result.sources).toHaveLength(5);
  expect(result.truncated).toBe(true);
  expect(
    result.sources.every((source) => source.url.startsWith('https://source.example.test/')),
  ).toBe(true);
});

test('only an explicit Bing no-results page is an empty search', async () => {
  const client = new SearchClient(async () =>
    page('<ol id="b_results"><li class="b_no">Synthetic no results</li></ol>'),
  );
  expect(await client.query(provider, '', 'synthetic')).toEqual({ sources: [], truncated: false });
  await expect(
    new SearchClient(async () => page('<div id="b_content">Synthetic loading shell</div>')).query(
      provider,
      '',
      'synthetic',
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
});

test.each([
  '<div id="b_captcha">Synthetic verification</div>',
  '<iframe src="https://verify.example.test/captcha"></iframe>',
])('Bing challenges are rejected without retry or fallback: %s', async (body) => {
  const request = vi.fn(async () => page(body));
  await expect(new SearchClient(request).query(provider, '', 'synthetic')).rejects.toMatchObject({
    code: 'SEARCH_FORBIDDEN',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([
  'http://127.0.0.1/private',
  'javascript:alert(1)',
  'https://www.bing.com/ck/a?u=a1%%%',
  `https://www.bing.com/ck/a?u=a1${Buffer.from('http://127.0.0.1/private').toString('base64url')}`,
])('Bing refuses unsafe or malformed destinations: %s', async (url) => {
  await expect(
    new SearchClient(async () => page(`<ol id="b_results">${hit(url)}</ol>`)).query(
      provider,
      '',
      'synthetic',
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
});

test('Bing preserves HTML work bounds and refuses keys before sending', async () => {
  const request = vi.fn(async () => page(`<ol id="b_results">${hit()}</ol>`));
  await expect(
    new SearchClient(request).query(provider, 'synthetic-secret', 'synthetic'),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CREDENTIAL' });
  expect(request).not.toHaveBeenCalled();
  for (const body of [
    'x'.repeat(1024 * 1024 + 1),
    `${'<div>'.repeat(600)}${hit()}${'</div>'.repeat(600)}`,
    `${'<i></i>'.repeat(50001)}<ol id="b_results">${hit()}</ol>`,
  ]) {
    await expect(
      new SearchClient(async () => page(body)).query(provider, '', 'synthetic'),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
  }
});
