import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBrowserState } from '@daban/protocol';
import type { Computers } from './computers.js';
import type { ModelRuns } from './model.js';
import { startPrototype } from './server.js';

test('managed19 API starts the ordinary Agent without graphics and connects only registered idle logical Bots', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-managed-api-'));
  const app = (await Reflect.apply(startPrototype, undefined, [
    {
      profileDir: path.join(root, 'profile'),
      port: 0,
      computers: { dir: path.join(root, 'desktops'), displayBase: 71, limit: 2 },
    },
  ])) as {
    url: string;
    token: string;
    runtime: Computers;
    models?: ModelRuns;
    close: () => Promise<unknown>;
  };
  const call = async (route: string, data?: unknown) => {
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
    assert.ok(app.models);
    const initial = await call('/api/state');
    assert.equal(initial.value.clientProtocol, 33);
    assert.equal(initial.value.mode, 'agent');
    assert.deepEqual(initial.value.bots, {});
    assert.equal(initial.value.computers.available, true);
    assert.deepEqual(initial.value.computers.items, []);
    assert.equal(
      (
        await call('/api/computers/action', {
          id: 'mock-unknown-connect',
          bot: 'mock-unregistered',
          action: 'connect',
          revision: 0,
        })
      ).value.error,
      'COMPUTER_BOT_NOT_FOUND',
    );
    for (const bot of ['mock-managed-a', 'mock-managed-b']) {
      assert.equal(
        (
          await call('/api/bots', {
            id: bot,
            name: `合成 ${bot}`,
            instructions: '',
            memory: 'SYNTHETIC-MEMORY-PRESERVED',
            color: 'mint',
          })
        ).status,
        200,
      );
      assert.equal(app.models.tools.hasComputer(bot, 'deepseek-flash'), false);
    }
    const request = {
      id: 'mock-managed-a-connect',
      bot: 'mock-managed-a',
      action: 'connect',
      revision: 0,
    };
    const a = (await call('/api/computers/action', request)).value;
    assert.equal(a.state.phase, 'connected');
    assert.equal(
      (await call('/api/computers/action', request)).value.state.instance,
      a.state.instance,
    );
    assert.equal(
      (await call('/api/computers/action', { ...request, bot: 'mock-managed-b' })).value.error,
      'COMPUTER_REQUEST_ID_REUSED',
    );
    assert.equal(
      (await call('/api/computers/receipt', { id: request.id, bot: request.bot })).value.receipt
        .phase,
      'settled',
    );
    const b = (
      await call('/api/computers/action', {
        id: 'mock-managed-b-connect',
        bot: 'mock-managed-b',
        action: 'connect',
        revision: 0,
      })
    ).value;
    const state = (await call('/api/state')).value;
    assert.ok(isBrowserState(state.browsers?.[request.bot]));
    assert.equal(state.bots[request.bot].instance, a.state.instance);
    assert.notEqual(state.bots['mock-managed-b'].instance, a.state.instance);
    assert.equal(app.models.tools.hasComputer(request.bot, 'deepseek-flash'), true);
    const lease = (
      await call(`/api/bots/${request.bot}/control`, {
        epoch: state.bots[request.bot].epoch,
        owner: 'human',
        instance: a.state.instance,
      })
    ).value;
    const page = app.runtime.browserFor(request.bot).page(request.bot);
    const dialog = page
      .evaluate(() => window.prompt('SYNTHETIC-MANAGED-PROMPT', ''))
      .catch(() => null);
    async function pending(kind: 'dialog' | 'files') {
      for (let attempt = 0; attempt < 50; attempt++) {
        const snapshot = (await call('/api/state')).value;
        const browser = snapshot.browsers?.[request.bot];
        assert.ok(isBrowserState(browser));
        const prompt = browser.pending?.find((item) => item.kind === kind);
        if (prompt) return { browser, prompt };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('SYNTHETIC_GLOBAL_REQUEST_NOT_PUBLISHED');
    }
    const opened = await pending('dialog');
    assert.equal(
      (
        await call(`/api/bots/${request.bot}/browser-answer`, {
          id: 'mock-managed-answer',
          epoch: lease.epoch,
          kind: 'dialog',
          binding: {
            instance: opened.browser.instance,
            tab: opened.prompt.tab,
            generation: opened.prompt.generation,
          },
          prompt: opened.prompt.id,
          accept: true,
          text: 'SYNTHETIC-MANAGED-ANSWER',
        })
      ).status,
      200,
    );
    assert.equal(await dialog, 'SYNTHETIC-MANAGED-ANSWER');
    await page.setContent('<input type="file" id="synthetic-file">');
    await page.locator('#synthetic-file').click();
    const picker = await pending('files');
    assert.equal(
      (
        await call(`/api/bots/${request.bot}/browser-answer`, {
          id: 'mock-managed-picker-answer',
          epoch: lease.epoch,
          kind: 'files',
          binding: {
            instance: picker.browser.instance,
            tab: picker.prompt.tab,
            generation: picker.prompt.generation,
          },
          prompt: picker.prompt.id,
          files: [
            {
              name: 'synthetic.txt',
              data: Buffer.from('SYNTHETIC-MANAGED-FILE').toString('base64'),
              mimeType: 'text/plain',
            },
          ],
        })
      ).status,
      200,
    );
    assert.equal(
      await page
        .locator('#synthetic-file')
        .evaluate((element) => (element as HTMLInputElement).files?.[0]?.name),
      'synthetic.txt',
    );
    const settled = (await call('/api/state')).value;
    assert.equal(settled.browsers[request.bot].pending.length, 0);
    assert.equal(settled.browsers['mock-managed-b'].pending.length, 0);
    assert.equal(
      (
        await call(
          `/api/bots/${request.bot}/frame?instance=${a.state.instance}&epoch=${lease.epoch}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/api/bots/${request.bot}/app`, {
          epoch: lease.epoch,
          app: 'terminal',
          instance: a.state.instance,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/api/bots/${request.bot}/input`, {
          epoch: lease.epoch,
          input: { type: 'key', key: 'Escape' },
          instance: b.state.instance,
        })
      ).status,
      409,
    );
    const native = app.runtime.resource(request.bot).native;
    const xserver = native.screens.children[0];
    const exited = new Promise<unknown>((resolve) => xserver.once('exit', resolve));
    process.kill(xserver.pid!, 'SIGTERM');
    await exited;
    const degraded = (await call('/api/state')).value;
    assert.equal(
      degraded.computers.items.find((item: { bot: string }) => item.bot === request.bot).phase,
      'failed',
    );
    assert.equal(degraded.bots[request.bot], undefined);
    assert.equal(degraded.bots['mock-managed-b'].instance, b.state.instance);
    assert.equal((await call('/api/files')).status, 200);
    assert.equal((await call('/api/bots')).status, 200);
    assert.equal(app.models.tools.hasComputer(request.bot, 'deepseek-flash'), false);
    const stopped = (
      await call('/api/computers/action', {
        id: 'mock-managed-a-stop',
        bot: request.bot,
        action: 'stop',
        revision: a.state.revision,
        instance: a.state.instance,
        confirmation: 'close-apps',
      })
    ).value;
    assert.equal(stopped.state.phase, 'disconnected');
    assert.equal(
      (await app.models.profiles.get(request.bot))?.memory,
      'SYNTHETIC-MEMORY-PRESERVED',
    );
    const reconnect = (
      await call('/api/computers/action', {
        id: 'mock-managed-a-reconnect',
        bot: request.bot,
        action: 'connect',
        revision: stopped.state.revision,
      })
    ).value;
    assert.notEqual(reconnect.state.instance, a.state.instance);
    assert.equal(
      (await call(`/api/bots/${request.bot}/frame?instance=${a.state.instance}&epoch=1`)).value
        .error,
      'DESKTOP_VIEW_STALE',
    );
  } finally {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
