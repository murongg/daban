import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Desktop } from './desktop.js';
import type { Prototype } from './server.js';
import { startPrototype } from './server.js';

test('a registered logical Bot can open its GTK browser and perform a lease-bound native login', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-logical-viewer-'));
  const bot = 'mock-logical-viewer';
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: { dir: path.join(root, 'desktops'), displayBase: 91, limit: 2 },
  });
  try {
    assert.ok(app.models);
    await app.models.profiles.register({
      id: bot,
      name: '合成逻辑屏幕',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const connected = await app.runtime.operate({
      id: 'mock-viewer-connect',
      bot,
      action: 'connect',
      revision: 0,
    });
    assert.equal(connected.state.phase, 'connected');
    const browser = app.runtime.browserFor(bot);
    await browser.tabs!.navigate(
      bot,
      'agent',
      app.runtime.control.state(bot).epoch,
      `${app.url}/fixture/page?bot=${bot}`,
      new AbortController().signal,
      'mock-viewer-page',
    );
    const lease = await app.runtime.transfer(
      bot,
      app.runtime.control.state(bot).epoch,
      'human',
      connected.state.instance,
    );
    await app.runtime.openApp(bot, lease.epoch, 'browser', connected.state.instance);
    const layout = JSON.parse(
      await readFile(path.join(root, 'desktops', bot, 'viewer-layout.json'), 'utf8'),
    ) as { x: number; y: number; width: number; height: number; owner: string; epoch: number };
    assert.equal(layout.owner, 'human');
    assert.equal(layout.epoch, lease.epoch);
    const box = await browser.page(bot).locator('#login').boundingBox();
    assert.ok(box);
    await app.runtime.input(
      bot,
      lease.epoch,
      {
        type: 'click',
        x: layout.x + ((box.x + box.width / 2) * layout.width) / 960,
        y: layout.y + ((box.y + box.height / 2) * layout.height) / 640,
      },
      connected.state.instance,
    );
    await browser
      .page(bot)
      .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real native HTTP actions and frames bind Bot, screen instance and lease across a full runtime restart', {
  skip: process.platform !== 'linux',
  timeout: 40000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-instance-'));
  let app: Prototype<Desktop> | undefined;
  const options = {
    profileDir: path.join(root, 'profile'),
    port: 0,
    desktop: { dir: path.join(root, 'desktops'), displayBase: 41 },
  };
  const call = async (route: string, data?: unknown) => {
    assert.ok(app);
    const response = await fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'x-prototype-token': app.token,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return {
      status: response.status,
      value: response.headers.get('content-type')?.startsWith('image/jpeg')
        ? Buffer.from(await response.arrayBuffer())
        : await response.json(),
    };
  };
  try {
    app = await startPrototype(options);
    const before = app.runtime.screens.instance('a');
    const human = await call('/api/bots/a/control', { epoch: 0, owner: 'human', instance: before });
    assert.equal(human.status, 200);
    const lease = human.value.epoch;
    const state = (await call('/api/state')).value;
    assert.equal(state.clientProtocol, 18);
    assert.equal(state.bots.a.instance, before);
    assert.notEqual(state.bots.b.instance, before);
    assert.equal((await call(`/api/bots/a/frame?instance=${before}&epoch=${lease}`)).status, 200);
    assert.equal((await call('/api/bots/a/frame')).status, 400);
    assert.equal(
      (await call(`/api/bots/a/frame?instance=${before}&epoch=${lease}&extra=1`)).status,
      400,
    );
    assert.equal(
      (await call('/api/bots/a/app', { epoch: lease, app: 'terminal', instance: before })).status,
      200,
    );
    assert.equal(
      (
        await call('/api/bots/a/input', {
          epoch: lease,
          input: { type: 'key', key: 'Escape' },
          instance: before,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('/api/bots/a/input', {
          epoch: lease,
          input: { type: 'key', key: 'Escape' },
          instance: state.bots.b.instance,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call('/api/bots/a/control', { epoch: lease, owner: 'agent', instance: before }))
        .status,
      200,
    );
    const retired = app.runtime;
    await app.close();
    app = await startPrototype(options);
    const after = app.runtime.screens.instance('a');
    assert.notEqual(after, before);
    await assert.rejects(retired.transfer('a', retired.control.state('a').epoch, 'human', before), {
      code: 'COMPUTER_NOT_CONNECTED',
    });
    const current = (
      await call('/api/bots/a/control', { epoch: 0, owner: 'human', instance: after })
    ).value;
    for (const [route, data] of [
      [
        '/api/bots/a/input',
        { epoch: current.epoch, input: { type: 'text', text: 'NEVER-TYPE' }, instance: before },
      ],
      ['/api/bots/a/app', { epoch: current.epoch, app: 'terminal', instance: before }],
      ['/api/bots/a/control', { epoch: current.epoch, owner: 'agent', instance: before }],
    ] as const) {
      const result = await call(route, data);
      assert.equal(result.status, 409);
      assert.equal(result.value.error, 'DESKTOP_VIEW_STALE');
    }
    assert.equal(
      (await call(`/api/bots/a/frame?instance=${before}&epoch=${current.epoch}`)).value.error,
      'DESKTOP_VIEW_STALE',
    );
    assert.equal(app.runtime.control.state('a').owner, 'human');
    const other = (
      await call('/api/bots/b/control', {
        epoch: 0,
        owner: 'human',
        instance: app.runtime.screens.instance('b'),
      })
    ).value;
    assert.equal(
      (
        await call('/api/bots/b/app', {
          epoch: other.epoch,
          app: 'files',
          instance: app.runtime.screens.instance('b'),
        })
      ).status,
      200,
    );
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
