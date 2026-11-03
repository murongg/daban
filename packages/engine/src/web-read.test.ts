import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { runtimeRequire } from './dsh.js';
import { apply, WebReader } from './web-read.js';
import { createConverter } from './webpage.js';

const sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
const signal = () => new AbortController().signal;
const source = (content: string, kind: 'text' | 'html' = 'text') => ({
  url: 'https://article.example.test/post',
  statusCode: 200,
  body: { kind, content },
  truncated: false,
});
test('registers a bounded DSH tool with canonical output, continuation guidance and replay-safe metadata', async () => {
  type Page = Awaited<ReturnType<WebReader['read']>>;
  let tool:
    | {
        name: string;
        execute: (
          args: unknown,
          exec: { signal: AbortSignal; agent: { session: { id: string } } },
        ) => Promise<Page>;
        output: {
          schema: unknown;
          render: (args: unknown, page: Page) => { text: string }[];
          presentationMeta: (args: unknown, page: Page) => unknown;
        };
        presentResult: (args: unknown, result: { meta: unknown }) => unknown;
      }
    | undefined;
  await apply(
    {
      web: { fetch: async () => source('Synthetic line.\n'.repeat(4000)) },
      tools: {
        register: (value) => {
          tool = value as typeof tool;
        },
        get: () => tool,
      },
      systemPrompt: { getSectionOrder: () => 1, section: () => {} },
    },
    { sdkFile },
  );
  expect.assert(tool);
  expect(tool.name).toBe('web_fetch');
  const args = { url: source('').url, limit: 32000 };
  const value = await tool.execute(args, {
    signal: signal(),
    agent: { session: { id: 'mock-session' } },
  });
  const sdk = await import(
    pathToFileURL(runtimeRequire(sdkFile).resolve('@deepseek-ai/dsh-tools')).href
  );
  expect(sdk.validateJsonSchemaValue(tool.output.schema, value)).toStrictEqual([]);
  const rendered = tool.output.render(args, value)[0].text;
  expect.assert(rendered.length < 40000);
  expect(rendered).toMatch(/untrusted data/);
  expect(rendered).toMatch(/Continue web_fetch/);
  const meta = tool.output.presentationMeta(args, value);
  expect(tool.presentResult(args, { meta })).toStrictEqual({
    card: 'web',
    kind: 'fetch',
    title: args.url,
    url: value.url,
    statusCode: 200,
    truncated: true,
  });
  expect(tool.presentResult(args, { meta: {} })).toBe(undefined);
});

test('extracts an article after a large script without cutting the HTML before conversion', async () => {
  const convert = createConverter(sdkFile);
  const html = `<html><head><script>const syntheticBoot="${'x'.repeat(90000)}";</script><style>${'x'.repeat(50000)}</style></head><body><nav>SYNTHETIC NAVIGATION</nav><article><h1>Synthetic article</h1><p>${'Synthetic paragraph. '.repeat(40)}</p><a href="/evidence">Evidence</a><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>SYNTHETIC-ARTICLE-END</p></article></body></html>`;
  const value = convert(html, source('').url);
  expect(value.text).toMatch(/SYNTHETIC-ARTICLE-END/);
  expect(value.text).toMatch(/\[Evidence\]\(https:\/\/article.example.test\/evidence\)/);
  expect(value.text).toMatch(/\| A\s*\| B/);
  expect(value.text).not.toMatch(/syntheticBoot|SYNTHETIC NAVIGATION/);
  expect(value.extraction).toBe('article');
});
test('omits hidden markup and ignores table span expansion while retaining visible cell text', () => {
  const convert = createConverter(sdkFile);
  const html =
    '<main><p>VISIBLE SYNTHETIC TEXT</p><div style="DISPLAY : none !important">HIDDEN STYLE TEXT</div><div aria-hidden="TRUE">HIDDEN ARIA TEXT</div><table><tr><th colspan="1000">Visible heading</th></tr><tr><td>Visible cell</td></tr></table><a href="javascript:alert(1)">Visible label</a></main>';
  const value = convert(html, source('').url);
  expect(value.text).toMatch(/Visible cell/);
  expect(value.text).toMatch(/Visible label/);
  expect(value.text).not.toMatch(/HIDDEN|javascript:/);
  expect.assert(value.text.length < 1000);
});

test('pages one stable snapshot without refetching, breaking emoji, or mixing owners and URLs', async () => {
  let calls = 0;
  const content = `${'x'.repeat(15999)}😀${'y'.repeat(23000)}SYNTHETIC-END`;
  const reader = new WebReader(async () => {
    calls++;
    return source(content);
  }, createConverter(sdkFile));
  const first = await reader.read({ url: source('').url }, 'mock-session', signal());
  expect(first.offset).toBe(0);
  expect(first.nextOffset).toBe(15999);
  let combined = first.content;
  let page = first;
  while (page.nextOffset !== undefined) {
    page = await reader.read(
      { url: source('').url, pageId: first.pageId, offset: page.nextOffset },
      'mock-session',
      signal(),
    );
    combined += page.content;
  }
  expect(combined).toBe(content);
  expect(calls).toBe(1);
  expect(page.truncated).toBe(false);
  await expect(
    reader.read({ url: source('').url, pageId: first.pageId }, 'mock-other-session', signal()),
  ).rejects.toMatchObject({ code: 'WEB_PAGE_EXPIRED' });
  await expect(
    reader.read(
      { url: 'https://other.example.test/', pageId: first.pageId },
      'mock-session',
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'WEB_PAGE_EXPIRED' });
});
test('retains nested content within the existing DSH conversion depth ceiling', () => {
  const convert = createConverter(sdkFile);
  expect(
    convert(`${'<div>'.repeat(140)}SYNTHETIC-NESTED-TEXT${'</div>'.repeat(140)}`, source('').url)
      .text,
  ).toMatch(/SYNTHETIC-NESTED-TEXT/);
});

test('rejects incomplete downloads and invalid paging rather than presenting a partial article as complete', async () => {
  let calls = 0;
  const reader = new WebReader(async () => {
    calls++;
    return { ...source('Synthetic prefix'), truncated: true };
  }, createConverter(sdkFile));
  await expect(
    reader.read({ url: source('').url }, 'mock-session', signal()),
  ).rejects.toMatchObject({
    code: 'WEB_FETCH_TOO_LARGE',
  });
  for (const args of [
    { url: source('').url, offset: 1 },
    { url: source('').url, limit: 999999 },
    { url: source('').url, offset: -1 },
    { url: 'file:///private/mock' },
    { url: source('').url, extra: true },
  ])
    await expect(reader.read(args, 'mock-session', signal())).rejects.toMatchObject({
      code: 'INVALID_WEB_READ',
    });
  expect(calls).toBe(1);
  const abort = new AbortController();
  abort.abort();
  await expect(
    reader.read({ url: source('').url }, 'mock-session', abort.signal),
  ).rejects.toMatchObject({
    name: 'AbortError',
  });
});

test('expires and bounds snapshots and rejects excessively nested HTML', async () => {
  const convert = createConverter(sdkFile);
  expect(() =>
    convert(`${'<div>'.repeat(600)}x${'</div>'.repeat(600)}`, source('').url),
  ).toThrowError(
    expect.objectContaining({
      code: 'WEB_HTML_UNSUPPORTED',
    }),
  );
  let now = 0;
  const reader = new WebReader(
    async () => source('SYNTHETIC CACHE'),
    convert,
    () => now,
  );
  const first = await reader.read({ url: source('').url }, 'mock-session', signal());
  now = 600001;
  await expect(
    reader.read({ url: source('').url, pageId: first.pageId }, 'mock-session', signal()),
  ).rejects.toMatchObject({ code: 'WEB_PAGE_EXPIRED' });
  now = 0;
  const oldest = await reader.read({ url: source('').url }, 'mock-session', signal());
  for (let i = 0; i < 8; i++) await reader.read({ url: source('').url }, 'mock-session', signal());
  await expect(
    reader.read({ url: source('').url, pageId: oldest.pageId }, 'mock-session', signal()),
  ).rejects.toMatchObject({ code: 'WEB_PAGE_EXPIRED' });
});
