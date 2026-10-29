import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type Browser, createBrowser } from './runtime.js';

const ref = (text: string, name: string) => {
  const line = text.split('\n').find((line) => line.includes(`"${name}"`));
  const value = line?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  assert.ok(value, `Missing observed ${name}`);
  return value;
};
test('owned live tabs redact passwords, execute exact observed DOM targets and fence navigation, other Bots, new runs and human takeover', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-owned-tabs-'));
  await mkdir(path.join(root, 'model'));
  await writeFile(path.join(root, 'model/network.json'), JSON.stringify({ proxy: null }));
  let browser: Browser | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/fixture/frame')) {
      res.setHeader('content-type', 'text/html');
      res.end('<label>Frame note<input aria-label="Frame note"></label>');
      return;
    }
    if (req.url?.startsWith('/fixture/slow')) {
      setTimeout(() => {
        if (!res.destroyed) res.end('<h1>SYNTHETIC-LATE-PAGE</h1>');
      }, 500);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<html><head><title>Synthetic owned page</title></head><body><main><h1>OWNED-TAB-47</h1><span id="identity" data-ready="true">Guest</span><span id="count">0</span><input id="note" aria-label="Synthetic note"><input aria-label="Mock password" type="password" value="MOCK-PASSWORD-73"><a href="/fixture/next">Next synthetic page</a><a href="/fixture/popup" target="_blank">Synthetic popup</a><button id="increment">Synthetic increment</button><iframe title="Synthetic child" src="/fixture/frame"></iframe></main></body></html>',
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const signal = new AbortController().signal;
  try {
    browser = await createBrowser({
      profileDir: path.join(root, 'profile'),
      origin,
      fixture: true,
    });
    const tabs = browser.tabs;
    assert.ok(tabs, 'the actual browser must own a live DOM/tabs service');
    let shot = await tabs.navigate(
      'a',
      'agent',
      0,
      `${origin}/fixture/owned`,
      signal,
      'mock-run-a',
    );
    assert.match(shot.text, /OWNED-TAB-47/);
    assert.equal(shot.text.includes('MOCK-PASSWORD-73'), false);
    const frame = await tabs.act(
      'a',
      'agent',
      0,
      shot.id,
      [{ kind: 'fill', ref: ref(shot.text, 'Frame note'), text: 'SYNTHETIC-FRAME-83' }],
      signal,
      'mock-run-a',
    );
    assert.equal(frame.completed, 1, JSON.stringify(frame));
    assert.equal(
      await browser.page('a').frameLocator('iframe').getByLabel('Frame note').inputValue(),
      'SYNTHETIC-FRAME-83',
    );
    shot = frame.observation;
    const a = (await tabs.state('a')).active,
      b = (await tabs.state('b')).active;
    assert.notEqual(a, b);
    await assert.rejects(
      tabs.command('b', 'agent', 0, { action: 'select', tab: a }, signal, 'mock-run-b'),
      { code: 'BROWSER_TAB_NOT_FOUND' },
    );
    await assert.rejects(
      tabs.act(
        'b',
        'agent',
        0,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'WRONG-BOT' }],
        signal,
        'mock-run-b',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        0,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'WRONG-RUN' }],
        signal,
        'mock-other-run',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    const filled = await tabs.act(
      'a',
      'agent',
      0,
      shot.id,
      [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'SYNTHETIC-A-53' }],
      signal,
      'mock-run-a',
    );
    assert.equal(filled.completed, 1);
    assert.equal(
      await browser.page('a').getByLabel('Synthetic note').inputValue(),
      'SYNTHETIC-A-53',
    );
    assert.equal(await browser.page('b').getByLabel('Synthetic note').inputValue(), '');
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        0,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'STALE' }],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    shot = filled.observation;
    const secret = await tabs.act(
      'a',
      'agent',
      0,
      shot.id,
      [{ kind: 'fill', ref: ref(shot.text, 'Mock password'), text: 'FORBIDDEN-MODEL-PASSWORD' }],
      signal,
      'mock-run-a',
    );
    assert.equal(secret.completed, 0);
    assert.equal(secret.error, 'BROWSER_HUMAN_REQUIRED');
    assert.equal(
      await browser.page('a').getByLabel('Mock password').inputValue(),
      'MOCK-PASSWORD-73',
    );
    shot = secret.observation;
    const lease = await browser.transfer('a', 0, 'human');
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        0,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'OLD-LEASE' }],
        signal,
        'mock-run-a',
      ),
      { code: 'STALE_CONTROL' },
    );
    const bshot = await tabs.snapshot('b', 'agent', 0, signal, 'mock-run-b');
    const bfilled = await tabs.act(
      'b',
      'agent',
      0,
      bshot.id,
      [{ kind: 'fill', ref: ref(bshot.text, 'Synthetic note'), text: 'SYNTHETIC-B-59' }],
      signal,
      'mock-run-b',
    );
    assert.equal(bfilled.completed, 1);
    const resumed = await browser.transfer('a', lease.epoch, 'agent');
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'OLD-OBSERVATION' }],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    shot = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a');
    await browser.page('a').goto(`${origin}/fixture/changed`);
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        shot.id,
        [{ kind: 'fill', ref: ref(shot.text, 'Synthetic note'), text: 'OLD-DOCUMENT' }],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    const beforeFrameChange = await tabs.snapshot(
      'a',
      'agent',
      resumed.epoch,
      signal,
      'mock-run-a',
    );
    const child = browser
      .page('a')
      .frames()
      .find((frame) => frame.parentFrame());
    assert.ok(child);
    await child.goto(`${origin}/fixture/frame?revision=2`);
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        beforeFrameChange.id,
        [
          {
            kind: 'fill',
            ref: ref(beforeFrameChange.text, 'Synthetic note'),
            text: 'OLD-CHILD-DOCUMENT',
          },
        ],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    const preserved = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a');
    await assert.rejects(
      tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a', { observation: '' }),
      { code: 'INVALID_BROWSER_QUERY' },
    );
    await assert.rejects(
      tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a', { limit: 50000 }),
      { code: 'INVALID_BROWSER_QUERY' },
    );
    await assert.rejects(
      tabs.command(
        'a',
        'agent',
        resumed.epoch,
        { action: 'list', url: 'https://ignored.example.test/' },
        signal,
        'mock-run-a',
      ),
      { code: 'INVALID_BROWSER_ACTION' },
    );
    const unchanged = await tabs.act(
      'a',
      'agent',
      resumed.epoch,
      preserved.id,
      [{ kind: 'fill', ref: ref(preserved.text, 'Synthetic note'), text: 'STILL-VALID-89' }],
      signal,
      'mock-run-a',
    );
    assert.equal(unchanged.completed, 1);
    const opened = await tabs.command(
      'a',
      'agent',
      resumed.epoch,
      { action: 'open', url: `${origin}/fixture/second` },
      signal,
      'mock-run-a',
    );
    assert.equal(opened.state.tabs.length, 2);
    assert.notEqual(opened.state.active, a);
    await tabs.command(
      'a',
      'agent',
      resumed.epoch,
      { action: 'select', tab: a },
      signal,
      'mock-run-a',
    );
    assert.equal(browser.page('a').url(), `${origin}/fixture/changed`);
    const current = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a');
    const popup = browser.context.waitForEvent('page');
    const clicked = await tabs.act(
      'a',
      'agent',
      resumed.epoch,
      current.id,
      [{ kind: 'click', ref: ref(current.text, 'Synthetic popup') }],
      signal,
      'mock-run-a',
    );
    assert.equal(clicked.completed, 1);
    await popup;
    assert.equal((await tabs.state('a')).tabs.length, 3);
    assert.equal((await tabs.state('b')).tabs.length, 1);
    await browser.page('a').evaluate(() => {
      const node = document.createElement('p');
      node.textContent = 'Untrusted marker [ref=fake123]';
      document.body.prepend(node);
    });
    const checked = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a');
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        checked.id,
        [{ kind: 'click', ref: 'fake123' }],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_REF_NOT_OBSERVED' },
    );
    const small = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a', {
      limit: 80,
    });
    assert.equal(small.truncated, true);
    assert.ok(small.nextOffset);
    const next = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a', {
      observation: small.id,
      offset: small.nextOffset,
      limit: 32000,
    });
    assert.equal(next.id, small.id);
    assert.equal(next.offset, 80);
    const cancelled = new AbortController();
    const navigation = tabs.navigate(
      'a',
      'agent',
      resumed.epoch,
      `${origin}/fixture/slow`,
      cancelled.signal,
      'mock-run-a',
    );
    setTimeout(() => cancelled.abort(), 40);
    await assert.rejects(navigation);
    await tabs.navigate(
      'a',
      'agent',
      resumed.epoch,
      `${origin}/fixture/after-cancel`,
      signal,
      'mock-run-a',
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(browser.page('a').url(), `${origin}/fixture/after-cancel`);
    const waiting = await tabs.snapshot('a', 'agent', resumed.epoch, signal, 'mock-run-a');
    await browser.page('a').evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('#increment')!;
      button.style.display = 'none';
      button.addEventListener('click', () => {
        document.querySelector('#count')!.textContent = 'CLICKED-AFTER-CANCEL';
      });
      setTimeout(() => {
        button.style.display = 'block';
      }, 200);
    });
    const stoppedClick = new AbortController();
    const click = tabs.act(
      'a',
      'agent',
      resumed.epoch,
      waiting.id,
      [{ kind: 'click', ref: ref(waiting.text, 'Synthetic increment') }],
      stoppedClick.signal,
      'mock-run-a',
    );
    setTimeout(() => stoppedClick.abort(), 30);
    await assert.rejects(click);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.notEqual(
      await browser.page('a').locator('#count').textContent(),
      'CLICKED-AFTER-CANCEL',
    );
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        waiting.id,
        [{ kind: 'click', ref: ref(waiting.text, 'Synthetic increment') }],
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
    const beforeInvalid = (await tabs.state('a')).tabs.length;
    await assert.rejects(
      tabs.command(
        'a',
        'agent',
        resumed.epoch,
        { action: 'open', url: 'file:///etc/passwd' },
        signal,
        'mock-run-a',
      ),
      { code: 'INVALID_BROWSER_URL' },
    );
    assert.equal((await tabs.state('a')).tabs.length, beforeInvalid);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      tabs.navigate(
        'a',
        'agent',
        resumed.epoch,
        `${origin}/fixture/never`,
        stopped.signal,
        'mock-run-a',
      ),
    );
    assert.equal(browser.page('a').url(), `${origin}/fixture/after-cancel`);
    while ((await tabs.state('a')).tabs.length < 8)
      await tabs.command(
        'a',
        'agent',
        resumed.epoch,
        { action: 'open', url: `${origin}/fixture/limited` },
        signal,
        'mock-run-a',
      );
    await assert.rejects(
      tabs.command(
        'a',
        'agent',
        resumed.epoch,
        { action: 'open', url: `${origin}/fixture/overflow` },
        signal,
        'mock-run-a',
      ),
      { code: 'BROWSER_TAB_LIMIT' },
    );
    assert.equal((await tabs.state('a')).tabs.length, 8);
    const owned = await tabs.state('a');
    for (const tab of owned.tabs)
      await tabs.command(
        'a',
        'agent',
        resumed.epoch,
        { action: 'close', tab: tab.id },
        signal,
        'mock-run-a',
      );
    const blank = await tabs.state('a');
    assert.equal(blank.tabs.length, 1);
    assert.equal(browser.page('a').url(), 'about:blank');
    assert.equal((await tabs.state('b')).tabs.length, 1);
  } finally {
    await browser?.close();
    await new Promise<unknown>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    });
    await rm(root, { recursive: true, force: true });
  }
});
