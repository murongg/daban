import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBrowserAck, isBrowserState, isBrowserView } from '@daban/protocol';
import { type Browser, createBrowser } from './runtime.js';
import { startPrototype } from './server.js';

test('browser startup is blank and restores owned suspended tabs without repeating external navigation', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-recovery-'));
  let browser: Browser | undefined,
    requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader('content-type', 'text/html');
    res.end(
      `<html><head><title>Synthetic ${req.url}</title></head><body><span id="identity" data-ready="true">Guest</span><span id="count">0</span><input id="note"><h1>RECOVERY-47</h1></body></html>`,
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`,
    options = { profileDir: path.join(root, 'profile'), origin };
  try {
    browser = await createBrowser(options);
    assert.equal(browser.page('a').url(), 'about:blank');
    assert.equal(browser.page('b').url(), 'about:blank');
    assert.equal(requests, 0);
    const tabs = browser.tabs!;
    await tabs.navigate(
      'a',
      'agent',
      0,
      `${origin}/fixture/first`,
      new AbortController().signal,
      'mock-recovery-run',
    );
    await tabs.command(
      'a',
      'agent',
      0,
      { action: 'open', url: `${origin}/fixture/second` },
      new AbortController().signal,
      'mock-recovery-run',
    );
    const before = await tabs.state('a');
    assert.equal(before.tabs.length, 2);
    await browser.close();
    browser = undefined;
    const count = requests;
    browser = await createBrowser(options);
    const restored = await browser.tabs!.state('a');
    assert.deepEqual(
      restored.tabs.map((tab) => tab.id),
      before.tabs.map((tab) => tab.id),
    );
    assert.equal(restored.active, before.active);
    assert.equal(requests, count, 'restoring a registry must not replay an old URL');
    assert.equal(browser.page('a').url(), 'about:blank');
    const saved = restored.tabs.find((tab) => tab.id === restored.active)! as unknown as {
      restoreUrl?: string;
      suspended?: boolean;
    };
    assert.equal(saved.suspended, true);
    assert.equal(saved.restoreUrl, `${origin}/fixture/second`);
    await browser.tabs!.command(
      'a',
      'agent',
      0,
      { action: 'resume', tab: restored.active },
      new AbortController().signal,
      'mock-explicit-resume',
    );
    assert.equal(browser.page('a').url(), `${origin}/fixture/second`);
    assert.equal(requests, count + 1);
  } finally {
    await browser?.close();
    await new Promise<unknown>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    });
    await rm(root, { recursive: true, force: true });
  }
});

test('owned browser HTTP commands, receipts and bound input share the human lease without replay', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-http-'));
  const app = await startPrototype({ profileDir: path.join(root, 'profile'), port: 0 });
  const call = async (route: string, data?: unknown, authorized = true) => {
    const response = await fetch(`${app.url}${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(authorized ? { 'x-prototype-token': app.token } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await call('/api/bots/a/browser-state', undefined, false)).status, 403);
    const status = await call('/api/state');
    assert.equal(status.value.clientProtocol, 18);
    assert.ok(isBrowserState(status.value.browsers.a));
    const initial = await call('/api/bots/a/browser-state');
    assert.ok(isBrowserState(initial.value));
    assert.equal(initial.value.bot, 'a');
    const lease = (await call('/api/bots/a/control', { epoch: 0, owner: 'human' })).value;
    assert.equal(
      (
        await call('/api/bots/a/browser-input', {
          epoch: lease.epoch,
          input: { type: 'click', x: 1, y: 1 },
        })
      ).status,
      400,
      'the old route cannot bypass the observed-page binding',
    );
    const request = {
      epoch: lease.epoch,
      instance: initial.value.instance,
      id: 'mock-http-open',
      action: 'open',
      url: `${app.url}/fixture/page?bot=a`,
    };
    const opened = await call('/api/bots/a/browser-command', request);
    assert.equal(opened.status, 200);
    assert.ok(isBrowserAck(opened.value));
    assert.equal(opened.value.state.tabs.length, 2);
    assert.equal((await call('/api/bots/a/browser-command', request)).value.state.tabs.length, 2);
    assert.equal(
      (await call('/api/bots/a/browser-command', { ...request, secret: 'unexpected' })).status,
      400,
    );
    const frame = await call('/api/bots/a/browser-view');
    assert.ok(isBrowserView(frame.value));
    assert.equal(frame.value.epoch, lease.epoch);
    const page = app.runtime.page('a'),
      box = await page.locator('#note').boundingBox();
    assert.ok(box);
    const input = (value: unknown) =>
      call('/api/bots/a/browser-bound-input', {
        epoch: lease.epoch,
        binding: frame.value.binding,
        input: value,
      });
    assert.equal((await input({ type: 'click', x: box.x + 5, y: box.y + 5 })).status, 200);
    assert.equal((await input({ type: 'text', text: 'SYNTHETIC-BOUND-71' })).status, 200);
    assert.equal(await page.locator('#note').inputValue(), 'SYNTHETIC-BOUND-71');
    assert.equal(
      (
        await call('/api/bots/b/browser-bound-input', {
          epoch: 0,
          binding: frame.value.binding,
          input: { type: 'click', x: 1, y: 1 },
        })
      ).status,
      409,
    );
    await call('/api/bots/a/browser-command', {
      epoch: lease.epoch,
      instance: initial.value.instance,
      id: 'mock-http-select',
      action: 'select',
      tab: initial.value.active,
    });
    assert.equal((await input({ type: 'text', text: 'must-not-land' })).status, 409);
    assert.equal(await page.locator('#note').inputValue(), 'SYNTHETIC-BOUND-71');
    await call('/api/bots/a/control', { epoch: lease.epoch, owner: 'agent' });
    const receipt = await call('/api/bots/a/browser-receipt', { id: request.id });
    assert.equal(receipt.value.phase, 'settled');
    assert.equal(
      (await call('/api/bots/a/browser-command', request)).status,
      200,
      'a settled retry is a read after returning control',
    );
    assert.equal(
      (await call('/api/bots/b/browser-receipt', { id: request.id })).value.phase,
      'unknown',
    );
    assert.equal(
      (await call('/api/bots/a/browser-command', { ...request, id: 'mock-denied' })).value.error,
      'STALE_CONTROL',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
