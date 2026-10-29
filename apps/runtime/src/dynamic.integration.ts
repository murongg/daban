import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Control, Fault } from './control.js';
import { type Browser, createBrowser } from './runtime.js';

type DynamicBrowser = Browser & {
  attach(bot: string): Promise<unknown>;
  detach(bot: string): Promise<unknown>;
};

test('a shared browser attaches and suspends arbitrary logical Bots without losing another Bot or its login', {
  skip: process.platform !== 'linux',
  timeout: 40000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-dynamic-browser-'));
  const server = createServer((req, res) => {
    if (req.url === '/fixture/login') {
      res.setHeader(
        'set-cookie',
        'demo_session=synthetic-dynamic; HttpOnly; SameSite=Strict; Path=/fixture',
      );
      res.end('ok');
      return;
    }
    if (req.url === '/fixture/session') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          user: /demo_session=synthetic-dynamic/.test(req.headers.cookie || '')
            ? 'SYNTHETIC-SHARED'
            : null,
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html><head><title>Synthetic dynamic page</title></head><body><h1>SYNTHETIC-DYNAMIC</h1><button id="login" onclick="fetch(\x27/fixture/login\x27,{method:\x27POST\x27}).then(()=>document.querySelector(\x27#identity\x27).textContent=\x27LOGIN-SAVED\x27)">Login synthetic</button><button id="check" onclick="fetch(\x27/fixture/session\x27).then(r=>r.json()).then(v=>document.querySelector(\x27#identity\x27).textContent=v.user)">Check synthetic session</button><output id="identity"></output><input id="note"></body></html>',
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`,
    control = new Control([]);
  let browser: DynamicBrowser | undefined;
  try {
    browser = (await Reflect.apply(createBrowser, undefined, [
      { profileDir: path.join(root, 'profile'), origin, bots: [], control },
    ])) as DynamicBrowser;
    assert.equal(browser.pages.size, 0);
    for (const bot of ['mock-custom-a', 'mock-custom-b']) {
      control.register(bot);
      await browser.attach(bot);
      const lease = control.activate(bot);
      await browser.tabs!.navigate(
        bot,
        'agent',
        lease.epoch,
        `${origin}/fixture/page?bot=${bot}`,
        new AbortController().signal,
        'mock-dynamic-run',
      );
    }
    await browser.page('mock-custom-a').locator('#login').click();
    await browser
      .page('mock-custom-a')
      .waitForFunction(() => document.querySelector('#identity')?.textContent === 'LOGIN-SAVED');
    await browser.page('mock-custom-b').locator('#check').click();
    await browser
      .page('mock-custom-b')
      .waitForFunction(
        () => document.querySelector('#identity')?.textContent === 'SYNTHETIC-SHARED',
      );
    assert.equal(
      (await browser.context.cookies()).find((cookie) => cookie.name === 'demo_session')?.value,
      'synthetic-dynamic',
    );
    await browser.page('mock-custom-b').locator('#note').fill('SYNTHETIC-B-PRESERVED');
    const before = await browser.tabs!.state('mock-custom-a');
    await control.revoke('mock-custom-a');
    await browser.detach('mock-custom-a');
    assert.equal(browser.pages.has('mock-custom-a'), false);
    assert.equal(browser.context.pages().length, 1);
    assert.equal(
      await browser.page('mock-custom-b').locator('#note').inputValue(),
      'SYNTHETIC-B-PRESERVED',
    );
    await browser.attach('mock-custom-a');
    control.activate('mock-custom-a');
    const restored = await browser.tabs!.state('mock-custom-a');
    assert.equal(restored.active, before.active);
    assert.equal(browser.page('mock-custom-a').url(), 'about:blank');
    assert.equal(restored.tabs.find((tab) => tab.id === restored.active)?.suspended, true);
    assert.equal(
      (await browser.context.cookies()).find((cookie) => cookie.name === 'demo_session')?.value,
      'synthetic-dynamic',
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('failed browser attachment retains unconfirmed page cleanup for an explicit retry', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-attach-rollback-'));
  const control = new Control([]);
  const browser = (await Reflect.apply(createBrowser, undefined, [
    { profileDir: path.join(root, 'profile'), origin: 'http://127.0.0.1:12345', bots: [], control },
  ])) as DynamicBrowser;
  const create = browser.context.newPage.bind(browser.context);
  let allowClose = false;
  t.mock.method(browser.context, 'newPage', async () => {
    const page = await create(),
      close = page.close.bind(page);
    t.mock.method(page, 'close', async (...args: Parameters<typeof close>) => {
      if (!allowClose) throw new Fault('SYNTHETIC_CLOSE_UNCONFIRMED');
      return close(...args);
    });
    return page;
  });
  t.mock.method(browser.tabs!, 'restore', async () => {
    throw new Fault('SYNTHETIC_RESTORE_FAILED');
  });
  try {
    control.register('mock-failed-owner');
    await assert.rejects(browser.attach('mock-failed-owner'), { code: 'SYNTHETIC_RESTORE_FAILED' });
    assert.equal(browser.pages.has('mock-failed-owner'), true);
    allowClose = true;
    await browser.detach('mock-failed-owner');
    assert.equal(browser.pages.has('mock-failed-owner'), false);
    assert.equal(browser.context.pages().length, 0);
  } finally {
    allowClose = true;
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
