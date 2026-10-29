import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Computers } from './computers.js';
import { Machine } from './machine.js';

test('real per-Bot Linux stacks allocate lazily, share login, stop independently and safely reuse the released slot', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-managed-machines-'));
  const server = createServer((req, res) => {
    if (req.url === '/fixture/login') {
      res.setHeader(
        'set-cookie',
        'demo_session=synthetic-machine; HttpOnly; SameSite=Strict; Path=/fixture',
      );
      res.end('ok');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html><head><title>Synthetic machine page</title></head><body><button id="login" onclick="fetch(\x27/fixture/login\x27,{method:\x27POST\x27}).then(()=>document.querySelector(\x27#identity\x27).textContent=\x27LOGIN-SAVED\x27)">Login synthetic</button><output id="identity"></output><input id="note"></body></html>',
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const driver = new Machine({
    dir: path.join(root, 'desktops'),
    profileDir: path.join(root, 'profile'),
    origin,
    displayBase: 61,
  });
  const computers = new Computers({
    file: path.join(root, 'computers.sqlite'),
    boot: 'mock-linux-boot',
    limit: 2,
    driver,
    registered: async (bot) => ['mock-a', 'mock-b', 'mock-c'].includes(bot),
    busy: () => false,
    drain: async () => {},
  });
  try {
    await computers.ready;
    assert.equal(driver.hasBrowser('mock-a'), false);
    assert.equal(computers.status().items.length, 0);
    const [a, b] = await Promise.all([
      computers.operate({ id: 'mock-a-connect', bot: 'mock-a', action: 'connect', revision: 0 }),
      computers.operate({ id: 'mock-b-connect', bot: 'mock-b', action: 'connect', revision: 0 }),
    ]);
    assert.equal(a.state.phase, 'connected');
    assert.equal(b.state.phase, 'connected');
    assert.notEqual(a.state.instance, b.state.instance);
    const old = computers.resource('mock-a'),
      other = computers.resource('mock-b');
    const oldDisplay = old.native.screens.screen('mock-a').display;
    assert.notEqual(oldDisplay, other.native.screens.screen('mock-b').display);
    const browser = driver.browserFor('mock-a');
    assert.equal(browser, driver.browserFor('mock-b'));
    for (const bot of ['mock-a', 'mock-b'])
      await browser.tabs!.navigate(
        bot,
        'agent',
        computers.control.state(bot).epoch,
        `${origin}/fixture/page?bot=${bot}`,
        new AbortController().signal,
        'mock-machine-run',
      );
    await browser.page('mock-a').locator('#login').click();
    await browser
      .page('mock-a')
      .waitForFunction(() => document.querySelector('#identity')?.textContent === 'LOGIN-SAVED');
    await browser.page('mock-b').locator('#note').fill('SYNTHETIC-B-UNCHANGED');
    const human = await computers.control.transfer(
      'mock-a',
      computers.control.state('mock-a').epoch,
      'human',
    );
    await old.native.openApp('mock-a', human.epoch, 'terminal', a.state.instance);
    await old.native.input(
      'mock-a',
      human.epoch,
      { type: 'text', text: 'printf MACHINE-A-47 > machine-a.txt' },
      a.state.instance,
    );
    await old.native.input('mock-a', human.epoch, { type: 'key', key: 'Return' }, a.state.instance);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if (
          (await readFile(path.join(root, 'desktops/shared/machine-a.txt'), 'utf8')) ===
          'MACHINE-A-47'
        )
          break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(
      await readFile(path.join(root, 'desktops/shared/machine-a.txt'), 'utf8'),
      'MACHINE-A-47',
    );
    await assert.rejects(
      computers.operate({ id: 'mock-c-full', bot: 'mock-c', action: 'connect', revision: 0 }),
      { code: 'COMPUTER_CAPACITY' },
    );
    await computers.operate({
      id: 'mock-a-stop',
      bot: 'mock-a',
      action: 'stop',
      revision: a.state.revision,
      instance: a.state.instance,
      confirmation: 'close-apps',
    });
    assert.equal(old.alive(), false);
    assert.equal(other.alive(), true);
    assert.equal(
      await browser.page('mock-b').locator('#note').inputValue(),
      'SYNTHETIC-B-UNCHANGED',
    );
    const c = await computers.operate({
      id: 'mock-c-connect',
      bot: 'mock-c',
      action: 'connect',
      revision: 0,
    });
    assert.equal(computers.resource('mock-c').native.screens.screen('mock-c').display, oldDisplay);
    assert.notEqual(c.state.instance, a.state.instance);
    await assert.rejects(
      old.native.input(
        'mock-a',
        human.epoch,
        { type: 'text', text: 'NEVER-TYPE' },
        a.state.instance,
      ),
      { code: 'COMPUTER_NOT_CONNECTED' },
    );
    assert.equal(
      (await browser.context.cookies()).find((cookie) => cookie.name === 'demo_session')?.value,
      'synthetic-machine',
    );
  } finally {
    try {
      await computers.close();
    } finally {
      server.closeAllConnections();
      await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true });
    }
  }
});
