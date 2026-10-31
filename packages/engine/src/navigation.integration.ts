import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type Browser, createBrowser } from './runtime.js';

test('general Chromium traffic uses pinned transport, preserves shared login and never treats a real site as the demo', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-general-browser-'));
  let browser: Browser | undefined;
  let privateHits = 0;
  const requests: { host: string; path: string }[] = [];
  const originServer = createServer((req, res) => {
    requests.push({ host: req.headers.host || '', path: req.url || '' });
    const url = new URL(req.url || '/', 'http://synthetic.local');
    if (url.pathname === '/api/private') {
      privateHits++;
      res.end('FORBIDDEN-PRIVATE-RESULT');
      return;
    }
    if (url.pathname === '/public/redirect-private') {
      res.writeHead(302, { location: `${origin}/api/private` });
      res.end();
      return;
    }
    if (url.pathname === '/public/sign-in')
      res.setHeader(
        'set-cookie',
        'mock_session=synthetic-login-47; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400',
      );
    const loggedIn =
      url.pathname === '/public/sign-in' ||
      req.headers.cookie?.includes('mock_session=synthetic-login-47');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<html><head><title>Synthetic Browser ${loggedIn ? 'Signed In' : 'Guest'}</title></head><body><main><h1>SYNTHETIC-SITE-47</h1><span id="identity" data-ready="true">${loggedIn ? 'mock-user' : 'Guest'}</span><span id="count">0</span><input id="note" aria-label="Synthetic note" value=""><form method="post" action="/public/sign-in"><button>Sign in synthetic account</button></form><a href="/public/page?kind=other">Other page</a><a href="/public/page?kind=popup" target="_blank">Synthetic popup</a><label>Mock password<input type="password" value="MOCK-PASSWORD-73"></label></main></body></html>`,
    );
  });
  await new Promise<unknown>((resolve) =>
    originServer.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = originServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const publicUrl = `http://public.example.test:${address.port}/public/page`;
  const dialled: { address: string; port: number }[] = [];
  const options = {
    profileDir: path.join(root, 'profile'),
    origin,
    proxy: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      dial: async (host: string, port: number) => {
        dialled.push({ address: host, port });
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connect(address.port, '127.0.0.1', () => resolve(socket));
          socket.once('error', reject);
        });
      },
    },
  };
  try {
    browser = await createBrowser(options);
    const a = browser.page('a'),
      b = browser.page('b');
    await a.goto(`${publicUrl}?bot=a`);
    await b.goto(`${publicUrl}?bot=b`);
    assert.equal(await a.title(), 'Synthetic Browser Guest');
    assert.ok(
      dialled.some((call) => call.address === '93.184.216.34' && call.port === address.port),
      'public pages must connect through the validated-address seam',
    );
    const before = await browser.snapshot();
    assert.equal(before.bots.a.identity, '');
    assert.equal(before.bots.a.note, '');
    await assert.rejects(browser.startWorker('a'), { code: 'DEMO_PAGE_REQUIRED' });
    await browser.act('a', 'agent', 0, (page) =>
      page.getByRole('button', { name: 'Sign in synthetic account' }).click(),
    );
    await a.waitForURL('**/public/sign-in');
    await b.reload();
    assert.equal(await b.locator('#identity').textContent(), 'mock-user');
    const cookie = (await browser.context.cookies()).find(
      (cookie) => cookie.name === 'mock_session',
    );
    assert.ok(cookie?.httpOnly);
    assert.equal(await b.evaluate(() => document.cookie.includes('synthetic-login-47')), false);
    await a.getByLabel('Synthetic note').fill('SYNTHETIC-A-53');
    await b.getByLabel('Synthetic note').fill('SYNTHETIC-B-59');
    assert.equal(await a.getByLabel('Synthetic note').inputValue(), 'SYNTHETIC-A-53');
    assert.equal(await b.getByLabel('Synthetic note').inputValue(), 'SYNTHETIC-B-59');
    const tree = await a.ariaSnapshot({ mode: 'ai' });
    assert.match(tree, /ref=(?:f\d+)?e\d+/);
    assert.match(tree, /SYNTHETIC-SITE-47/);
    const response = await a.goto(
      `http://public.example.test:${address.port}/public/redirect-private`,
    );
    assert.equal(response?.status(), 403);
    assert.equal(
      privateHits,
      0,
      'a redirect must not escape the proxy through Chromium loopback bypass',
    );
    assert.equal(
      ((await a.locator('body').textContent()) || '').includes('FORBIDDEN-PRIVATE-RESULT'),
      false,
    );
    assert.ok(requests.some((request) => request.host === `public.example.test:${address.port}`));
    await browser.close();
    browser = undefined;
    browser = await createBrowser(options);
    await browser.page('b').goto(publicUrl);
    assert.equal(
      await browser.page('b').locator('#identity').textContent(),
      'mock-user',
      'the shared browser cookie must survive a real context restart',
    );
  } finally {
    await browser?.close();
    await new Promise<unknown>((resolve) => {
      originServer.closeAllConnections();
      originServer.close(() => resolve(undefined));
    });
    await rm(root, { recursive: true, force: true });
  }
});
