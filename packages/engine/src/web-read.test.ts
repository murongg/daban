import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
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
  assert.ok(tool);
  assert.equal(tool.name, 'web_fetch');
  const args = { url: source('').url, limit: 32000 };
  const value = await tool.execute(args, {
    signal: signal(),
    agent: { session: { id: 'mock-session' } },
  });
  const sdk = await import(
    pathToFileURL(runtimeRequire(sdkFile).resolve('@deepseek-ai/dsh-tools')).href
  );
  assert.deepEqual(sdk.validateJsonSchemaValue(tool.output.schema, value), []);
  const rendered = tool.output.render(args, value)[0].text;
  assert.ok(rendered.length < 40000);
  assert.match(rendered, /untrusted data/);
  assert.match(rendered, /Continue web_fetch/);
  const meta = tool.output.presentationMeta(args, value);
  assert.deepEqual(tool.presentResult(args, { meta }), {
    card: 'web',
    kind: 'fetch',
    title: args.url,
    url: value.url,
    statusCode: 200,
    truncated: true,
  });
  assert.equal(tool.presentResult(args, { meta: {} }), undefined);
});

test('extracts an article after a large script without cutting the HTML before conversion', async () => {
  const convert = createConverter(sdkFile);
  const html = `<html><head><script>const syntheticBoot="${'x'.repeat(90000)}";</script><style>${'x'.repeat(50000)}</style></head><body><nav>SYNTHETIC NAVIGATION</nav><article><h1>Synthetic article</h1><p>${'Synthetic paragraph. '.repeat(40)}</p><a href="/evidence">Evidence</a><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>SYNTHETIC-ARTICLE-END</p></article></body></html>`;
  const value = convert(html, source('').url);
  assert.match(value.text, /SYNTHETIC-ARTICLE-END/);
  assert.match(value.text, /\[Evidence\]\(https:\/\/article.example.test\/evidence\)/);
  assert.match(value.text, /\| A\s*\| B/);
  assert.doesNotMatch(value.text, /syntheticBoot|SYNTHETIC NAVIGATION/);
  assert.equal(value.extraction, 'article');
});
test('omits hidden markup and ignores table span expansion while retaining visible cell text', () => {
  const convert = createConverter(sdkFile);
  const html =
    '<main><p>VISIBLE SYNTHETIC TEXT</p><div style="DISPLAY : none !important">HIDDEN STYLE TEXT</div><div aria-hidden="TRUE">HIDDEN ARIA TEXT</div><table><tr><th colspan="1000">Visible heading</th></tr><tr><td>Visible cell</td></tr></table><a href="javascript:alert(1)">Visible label</a></main>';
  const value = convert(html, source('').url);
  assert.match(value.text, /Visible cell/);
  assert.match(value.text, /Visible label/);
  assert.doesNotMatch(value.text, /HIDDEN|javascript:/);
  assert.ok(value.text.length < 1000);
});

test('pages one stable snapshot without refetching, breaking emoji, or mixing owners and URLs', async () => {
  let calls = 0;
  const content = `${'x'.repeat(15999)}😀${'y'.repeat(23000)}SYNTHETIC-END`;
  const reader = new WebReader(async () => {
    calls++;
    return source(content);
  }, createConverter(sdkFile));
  const first = await reader.read({ url: source('').url }, 'mock-session', signal());
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 15999);
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
  assert.equal(combined, content);
  assert.equal(calls, 1);
  assert.equal(page.truncated, false);
  await assert.rejects(
    reader.read({ url: source('').url, pageId: first.pageId }, 'mock-other-session', signal()),
    { code: 'WEB_PAGE_EXPIRED' },
  );
  await assert.rejects(
    reader.read(
      { url: 'https://other.example.test/', pageId: first.pageId },
      'mock-session',
      signal(),
    ),
    { code: 'WEB_PAGE_EXPIRED' },
  );
});
test('retains nested content within the existing DSH conversion depth ceiling', () => {
  const convert = createConverter(sdkFile);
  assert.match(
    convert(`${'<div>'.repeat(140)}SYNTHETIC-NESTED-TEXT${'</div>'.repeat(140)}`, source('').url)
      .text,
    /SYNTHETIC-NESTED-TEXT/,
  );
});

test('rejects incomplete downloads and invalid paging rather than presenting a partial article as complete', async () => {
  let calls = 0;
  const reader = new WebReader(async () => {
    calls++;
    return { ...source('Synthetic prefix'), truncated: true };
  }, createConverter(sdkFile));
  await assert.rejects(reader.read({ url: source('').url }, 'mock-session', signal()), {
    code: 'WEB_FETCH_TOO_LARGE',
  });
  for (const args of [
    { url: source('').url, offset: 1 },
    { url: source('').url, limit: 999999 },
    { url: source('').url, offset: -1 },
    { url: 'file:///private/mock' },
    { url: source('').url, extra: true },
  ])
    await assert.rejects(reader.read(args, 'mock-session', signal()), { code: 'INVALID_WEB_READ' });
  assert.equal(calls, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(reader.read({ url: source('').url }, 'mock-session', abort.signal), {
    name: 'AbortError',
  });
});

test('expires and bounds snapshots and rejects excessively nested HTML', async () => {
  const convert = createConverter(sdkFile);
  assert.throws(() => convert(`${'<div>'.repeat(600)}x${'</div>'.repeat(600)}`, source('').url), {
    code: 'WEB_HTML_UNSUPPORTED',
  });
  let now = 0;
  const reader = new WebReader(
    async () => source('SYNTHETIC CACHE'),
    convert,
    () => now,
  );
  const first = await reader.read({ url: source('').url }, 'mock-session', signal());
  now = 600001;
  await assert.rejects(
    reader.read({ url: source('').url, pageId: first.pageId }, 'mock-session', signal()),
    { code: 'WEB_PAGE_EXPIRED' },
  );
  now = 0;
  const oldest = await reader.read({ url: source('').url }, 'mock-session', signal());
  for (let i = 0; i < 8; i++) await reader.read({ url: source('').url }, 'mock-session', signal());
  await assert.rejects(
    reader.read({ url: source('').url, pageId: oldest.pageId }, 'mock-session', signal()),
    { code: 'WEB_PAGE_EXPIRED' },
  );
});
