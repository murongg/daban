import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BrowserAck, BrowserView, HostBrowserStatus } from '@daban/protocol';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { HostBrowser } from './host-browser.js';
import { type Browser, type BrowserOptions, createBrowser } from './runtime.js';
import { WorkspaceFiles } from './workspace.js';

test('standalone real browser preserves synthetic login, fences takeover and keeps Bot tabs independent without Linux', {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-host-browser-live-'));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/login?alias=SYNTHETIC-USER')) {
      response.writeHead(303, {
        'set-cookie': 'synthetic_login=accepted; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400',
        location: '/signed-in',
      });
      response.end();
      return;
    }
    const signed = request.headers.cookie?.includes('synthetic_login=accepted');
    response.end(
      `<html><head><title>Synthetic browser</title></head><body><h1>${signed ? 'SYNTHETIC SIGNED IN' : 'SYNTHETIC GUEST'}</h1><form action="/login"><label>Synthetic alias<input name="alias"></label><button>Sign in synthetic account</button></form><button onclick="this.textContent='SYNTHETIC CLICKED'">Synthetic increment</button></body></html>`,
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://synthetic.example.test:${address.port}/`;
  let actual: Browser | undefined;
  const launch = async (options: BrowserOptions) => {
    actual = await createBrowser({
      ...options,
      proxy: {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        dial: async (address, port) => {
          assert.equal(address, '93.184.216.34');
          return connect({ host: '127.0.0.1', port });
        },
      },
    });
    return actual;
  };
  let host = new HostBrowser({ directory: root, launch });
  const connection = async (bot = 'mock-a') =>
    (await host.status()).connections.find((item) => item.bot === bot)!;
  const payload = (result: Awaited<ReturnType<AgentTools['invoke']>>) => {
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.content[0].type, 'text');
    return JSON.parse(result.content[0].text) as { id: string; text: string; completed?: number };
  };
  try {
    await host.request({ action: 'open', bot: 'mock-a' });
    let owner = await connection();
    assert.equal(owner.owner, 'human');
    const navigation = (await host.request({
      action: 'command',
      bot: owner.bot,
      request: {
        id: 'mock-navigation',
        instance: owner.state.instance,
        epoch: owner.epoch,
        action: 'navigate',
        tab: owner.state.active,
        url,
      },
    })) as BrowserAck;
    assert.equal(navigation.error, undefined);
    assert.ok(actual);
    const page = actual.page('mock-a');
    const box = await page.getByLabel('Synthetic alias').boundingBox();
    assert.ok(box);
    const view = (await host.request({ action: 'view', bot: 'mock-a' })) as BrowserView;
    assert.ok(view.image?.startsWith('data:image/jpeg;base64,'));
    for (const input of [
      { type: 'click' as const, x: box.x + 5, y: box.y + 5 },
      { type: 'text' as const, text: 'SYNTHETIC-USER' },
      { type: 'key' as const, key: 'Enter' },
    ])
      await host.request({
        action: 'input',
        bot: 'mock-a',
        epoch: view.epoch,
        binding: view.binding,
        input,
      });
    await page.getByRole('heading', { name: 'SYNTHETIC SIGNED IN' }).waitFor();
    const tools = new AgentTools(undefined, new WorkspaceFiles(root), {
      nativeOnly: true,
      hostBrowser: host.facade,
    });
    const run: AgentToolRun = {
      id: 'mock-live-run',
      bot: 'mock-a',
      model: 'deepseek-v4-pro',
      vision: false,
      abort: new AbortController(),
      toolCount: 0,
      limit: 12,
      seen: {},
      trace: [],
      workdir: root,
      canonicalRoot: await realpath(root),
      task: { requestId: 'mock-live-request', prompt: 'Inspect and click the synthetic page.' },
    };
    await tools.open(run);
    let waiting = true;
    const reading = tools.invoke(run, 'browser_snapshot', {}).then((value) => {
      waiting = false;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(waiting, true, 'a model must wait while the human controls the browser');
    owner = await connection();
    await host.request({
      action: 'control',
      bot: owner.bot,
      instance: owner.state.instance,
      epoch: owner.epoch,
      owner: 'agent',
    });
    const observation = payload(await reading);
    assert.match(observation.text, /SYNTHETIC SIGNED IN/);
    const ref = observation.text
      .split('\n')
      .find((line) => line.includes('Synthetic increment'))
      ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(ref);
    const result = payload(
      await tools.invoke(run, 'browser_act', {
        observation: observation.id,
        actions: [{ kind: 'click', ref }],
      }),
    );
    assert.equal(result.completed, 1);
    assert.equal(await page.getByRole('button', { name: 'SYNTHETIC CLICKED' }).count(), 1);
    await host.request({ action: 'open', bot: 'mock-b' });
    const second = await connection('mock-b');
    assert.notEqual(second.state.active, owner.state.active);
    assert.equal(
      (
        (await host.request({
          action: 'command',
          bot: second.bot,
          request: {
            id: 'mock-foreign-tab',
            instance: second.state.instance,
            epoch: second.epoch,
            action: 'select',
            tab: owner.state.active,
          },
        })) as BrowserAck
      ).error,
      'BROWSER_TAB_NOT_FOUND',
    );
    const forbidden = await tools.invoke(run, 'browser_navigate', {
      url: 'http://127.0.0.1:8766/api/state',
    });
    assert.equal(forbidden.isError, true);
    await tools.drain(run);
    await host.close();
    host = new HostBrowser({ directory: root, launch });
    const reopened = (await host.request({ action: 'open', bot: 'mock-a' })) as HostBrowserStatus;
    assert.equal(reopened.connections[0].owner, 'human');
    assert.ok(actual);
    const cookie = (await actual.context.cookies()).find((item) => item.name === 'synthetic_login');
    assert.equal(cookie?.value, 'accepted');
    assert.equal(cookie?.httpOnly, true);
    assert.equal(actual.page('mock-a').url(), 'about:blank');
    const restored = reopened.connections[0];
    assert.equal(
      restored.state.tabs.find((tab) => tab.id === restored.state.active)?.suspended,
      true,
    );
    const resumed = (await host.request({
      action: 'command',
      bot: 'mock-a',
      request: {
        id: 'mock-resume',
        action: 'resume',
        instance: restored.state.instance,
        epoch: restored.epoch,
        tab: restored.state.active,
      },
    })) as BrowserAck;
    assert.equal(resumed.error, undefined);
    await actual.page('mock-a').getByRole('heading', { name: 'SYNTHETIC SIGNED IN' }).waitFor();
    assert.equal(await actual.page('mock-a').evaluate(() => document.cookie), '');
  } finally {
    await host.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});
