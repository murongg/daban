import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type BrowserAck,
  type BrowserView,
  type HostBrowserStatus,
  isHostBrowserStatus,
} from '@daban/protocol';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { HostBrowser } from './host-browser.js';
import { NativeWorkspace } from './native-workspace.js';
import { type Browser, type BrowserOptions, createBrowser } from './runtime.js';

test('standalone browser preserves login, transfers task reports and supports fenced canvas input without Linux', {
  timeout: 60000,
}, async () => {
  const suppliedRoot = process.env.DABAN_EMBEDDED_BROWSER_ROOT;
  const root = suppliedRoot || (await mkdtemp(path.join(tmpdir(), 'synthetic-host-browser-live-')));
  let uploaded = false;
  const server = createServer(async (request, response) => {
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
    if (request.url === '/frame') {
      response.end('<label>Synthetic frame OTP<input autocomplete="one-time-code"></label>');
      return;
    }
    if (request.url === '/report') {
      assert.ok(signed, 'report downloads reuse the signed-in browser session');
      response.setHeader('content-type', 'text/csv');
      response.setHeader('content-disposition', 'attachment; filename="synthetic-report.csv"');
      response.end('region,amount\nSYNTHETIC-NORTH,47\nSYNTHETIC-SOUTH,53\n');
      return;
    }
    if (request.method === 'POST' && request.url === '/upload-report') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      uploaded =
        !!signed && body.includes('SYNTHETIC-TOTAL,100') && body.includes('filename="summary.csv"');
    }
    response.end(
      `<html><head><title>Synthetic browser</title></head><body><h1>${uploaded ? 'SYNTHETIC UPLOAD ACCEPTED' : signed ? 'SYNTHETIC SIGNED IN' : 'SYNTHETIC GUEST'}</h1><form action="/login"><label>Synthetic alias<input name="alias"></label><button>Sign in synthetic account</button></form><button onclick="this.textContent='SYNTHETIC CLICKED'">Synthetic increment</button><a href="/report">Download synthetic report</a><form method="POST" action="/upload-report" enctype="multipart/form-data"><input type="file" name="report" aria-label="Synthetic report upload"><button>Submit synthetic report</button></form><label>Synthetic password<input type="password"></label><label>Synthetic OTP<input autocomplete="one-time-code"></label></body></html>`,
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
    if (suppliedRoot)
      assert.equal(actual.embedded, true, 'The native workflow must not fall back to headless');
    return actual;
  };
  const profile = path.join(root, 'browser');
  const workspace = new NativeWorkspace(path.join(root, 'workspace'));
  await workspace.prepare();
  const directory = await workspace.create(['mock-live-run']);
  await directory.close();
  let host = new HostBrowser({ directory: profile, launch });
  const connection = async (bot = 'mock-a') =>
    (await host.status()).connections.find((item) => item.bot === bot)!;
  const payload = (result: Awaited<ReturnType<AgentTools['invoke']>>) => {
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.content[0].type, 'text');
    return JSON.parse(result.content[0].text) as {
      id: string;
      text: string;
      completed?: number;
      content?: string;
      observation?: { id: string; text: string };
      file?: { path: string; bytes: number };
    };
  };
  const ref = (text: string, label: string) => {
    const result = text
      .split('\n')
      .find((line) => line.includes(label))
      ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(result, `Missing synthetic ref: ${label}`);
    return result;
  };
  try {
    await host.request({ action: 'open', bot: 'mock-a' });
    let owner = await connection();
    assert.equal(owner.owner, 'human');
    assert.ok(actual);
    const unavailable = new URL('/synthetic-network-failure', url).href;
    await actual.page('mock-a').route(unavailable, (route) => route.abort('connectionclosed'));
    const errorDocument = actual.page('mock-a').waitForEvent('framenavigated', {
      predicate: (frame) =>
        frame === actual!.page('mock-a').mainFrame() &&
        frame.url() === 'chrome-error://chromewebdata/',
    });
    const failed = (await host.request({
      action: 'command',
      bot: owner.bot,
      request: {
        id: 'mock-failed-navigation',
        instance: owner.state.instance,
        epoch: owner.epoch,
        action: 'navigate',
        tab: owner.state.active,
        url: unavailable,
      },
    })) as BrowserAck;
    assert.equal(failed.error, 'BROWSER_NAVIGATION_FAILED');
    assert.equal(failed.uncertain, true);
    await errorDocument;
    assert.equal(isHostBrowserStatus(await host.status()), true);
    assert.equal(failed.state.tabs[0].url, unavailable);
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
    const tools = new AgentTools(undefined, workspace, {
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
      limit: 40,
      seen: {},
      trace: [],
      workdir: directory.path,
      canonicalRoot: await realpath(directory.path),
      task: {
        requestId: 'mock-live-request',
        prompt:
          'Download the synthetic report, total it and upload summary.csv. Inspect the synthetic canvas.',
      },
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
    const button = observation.text
      .split('\n')
      .find((line) => line.includes('Synthetic increment'))
      ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
    assert.ok(button);
    const clicked = await tools.invoke(run, 'browser_act', {
      observation: observation.id,
      actions: [{ kind: 'click', ref: button }],
    });
    const result = payload(clicked);
    assert.equal(result.completed, 1);
    assert.equal(await page.getByRole('button', { name: 'SYNTHETIC CLICKED' }).count(), 1);
    const reportPage = payload(await tools.invoke(run, 'browser_snapshot', {}));
    const downloaded = payload(
      await tools.invoke(run, 'browser_download', {
        observation: reportPage.id,
        ref: ref(reportPage.text, 'Download synthetic report'),
        name: 'report.csv',
      }),
    );
    assert.equal(downloaded.file?.path, path.join(directory.canonical, 'report.csv'));
    const report = payload(await tools.invoke(run, 'read_file', { path: '/workspace/report.csv' }));
    assert.ok(report.content);
    const total = report.content
      .trim()
      .split('\n')
      .slice(1)
      .reduce((sum, line) => sum + Number(line.split(',')[1]), 0);
    assert.equal(total, 100);
    payload(
      await tools.invoke(run, 'write_file', {
        path: 'summary.csv',
        content: `item,total\nSYNTHETIC-TOTAL,${total}\n`,
      }),
    );
    const uploadPage = payload(await tools.invoke(run, 'browser_snapshot', {}));
    const attached = payload(
      await tools.invoke(run, 'browser_upload', {
        observation: uploadPage.id,
        ref: ref(uploadPage.text, 'Synthetic report upload'),
        path: '/workspace/summary.csv',
      }),
    );
    assert.ok(attached.observation);
    payload(
      await tools.invoke(run, 'browser_act', {
        observation: attached.observation.id,
        actions: [
          { kind: 'click', ref: ref(attached.observation.text, 'Submit synthetic report') },
        ],
      }),
    );
    assert.equal(uploaded, true);
    assert.equal(await page.getByRole('heading', { name: 'SYNTHETIC UPLOAD ACCEPTED' }).count(), 1);

    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.id = 'synthetic-canvas';
      canvas.width = 180;
      canvas.height = 70;
      const result = document.createElement('p');
      result.id = 'synthetic-canvas-result';
      result.textContent = 'SYNTHETIC CANVAS READY';
      canvas.getContext('2d')!.fillRect(0, 0, 180, 70);
      canvas.addEventListener('click', () => {
        result.textContent = 'SYNTHETIC CANVAS CLICKED';
      });
      document.body.prepend(canvas, result);
      const shadow = document.createElement('div');
      shadow.id = 'synthetic-shadow';
      shadow.attachShadow({ mode: 'open' }).innerHTML =
        '<input type="password" aria-label="Synthetic shadow password">';
      const frame = document.createElement('iframe');
      frame.id = 'synthetic-frame';
      frame.src = '/frame';
      document.body.append(shadow, frame);
    });
    await page.frameLocator('#synthetic-frame').getByLabel('Synthetic frame OTP').waitFor();
    const visual: AgentToolRun = {
      ...run,
      id: 'mock-visual-live-run',
      model: 'deepseek-flash',
      vision: true,
      toolCount: 0,
      seen: {},
      trace: [],
      abort: new AbortController(),
    };
    await tools.open(visual);
    await page.getByLabel('Synthetic OTP').fill('SYNTHETIC HUMAN OTP');
    await page.getByLabel('Synthetic password').fill('SYNTHETIC HUMAN PASSWORD');
    await page.getByRole('heading', { name: 'SYNTHETIC UPLOAD ACCEPTED' }).click();
    const humanView = (await host.request({ action: 'view', bot: 'mock-a' })) as BrowserView;
    const firstShot = await tools.invoke(visual, 'screenshot', { surface: 'browser' });
    assert.ok(!firstShot.isError, JSON.stringify(firstShot));
    const dimensions = JSON.parse(
      firstShot.content[0].type === 'text' ? firstShot.content[0].text : '{}',
    ) as { width: number; height: number };
    assert.equal(
      dimensions.width,
      960,
      'AI screenshots and pointer input must use CSS pixels, including Retina displays',
    );
    assert.equal(dimensions.height, 640);
    const modelImage = firstShot.content.find((part) => part.type === 'image');
    assert.ok(modelImage?.type === 'image');
    assert.equal(
      modelImage.data === humanView.image?.slice('data:image/jpeg;base64,'.length),
      false,
      'Model screenshots mask protected inputs while the human view stays interactive',
    );
    await page.getByLabel('Synthetic OTP').fill('');
    await page.getByLabel('Synthetic password').fill('');
    const canvas = await page.locator('#synthetic-canvas').boundingBox();
    assert.ok(canvas);
    const click = {
      surface: 'browser',
      actions: [{ type: 'click', x: canvas.x + 20, y: canvas.y + 20 }],
    };
    assert.ok(!(await tools.invoke(visual, 'act', click, 'mock-canvas-click')).isError);
    assert.equal(
      await page.locator('#synthetic-canvas-result').textContent(),
      'SYNTHETIC CANVAS CLICKED',
    );
    assert.ok((await tools.invoke(visual, 'act', click, 'mock-canvas-click')).isError);
    await page.evaluate(() => {
      document.hasFocus = () => false;
    });
    for (const input of [
      page.getByLabel('Synthetic password'),
      page.getByLabel('Synthetic OTP'),
      page.locator('#synthetic-shadow input'),
      page.frameLocator('#synthetic-frame').getByLabel('Synthetic frame OTP'),
    ]) {
      await input.focus();
      await tools.invoke(visual, 'screenshot', { surface: 'browser' });
      const secret = await tools.invoke(visual, 'act', {
        surface: 'browser',
        actions: [{ type: 'text', text: 'SYNTHETIC-MUST-NOT-ENTER' }],
      });
      assert.equal(secret.isError, true, 'Protected input must require human takeover');
      assert.match(JSON.stringify(secret), /BROWSER_HUMAN_REQUIRED/);
      assert.equal(await input.inputValue(), '');
      await tools.invoke(visual, 'screenshot', { surface: 'browser' });
      const pressed = await tools.invoke(visual, 'act', {
        surface: 'browser',
        actions: [{ type: 'key', key: 'Enter' }],
      });
      assert.ok(pressed.isError);
      assert.match(JSON.stringify(pressed), /BROWSER_HUMAN_REQUIRED/);
    }
    await page.getByLabel('Synthetic alias').focus();
    await tools.invoke(visual, 'screenshot', { surface: 'browser' });
    assert.ok(
      !(
        await tools.invoke(visual, 'act', {
          surface: 'browser',
          actions: [{ type: 'text', text: 'SYNTHETIC ORDINARY INPUT' }],
        })
      ).isError,
    );
    assert.equal(await page.getByLabel('Synthetic alias').inputValue(), 'SYNTHETIC ORDINARY INPUT');
    await page.evaluate(() => {
      const label = document.createElement('label');
      label.id = 'synthetic-verification';
      label.textContent = 'Synthetic CAPTCHA';
      const input = document.createElement('input');
      input.name = 'captcha';
      label.append(input);
      document.body.prepend(label);
    });
    const verification = await tools.invoke(visual, 'browser_snapshot', {});
    assert.match(
      JSON.stringify(verification),
      /humanRequired/,
      'A visible CAPTCHA must ask for human verification',
    );
    const blockedShot = await tools.invoke(visual, 'screenshot', { surface: 'browser' });
    assert.ok(blockedShot.isError, 'Do not offer a CAPTCHA image to the model for solving');
    owner = await connection();
    await host.request({
      action: 'control',
      bot: owner.bot,
      instance: owner.state.instance,
      epoch: owner.epoch,
      owner: 'human',
    });
    await page.getByLabel('Synthetic CAPTCHA').fill('SYNTHETIC HUMAN CODE');
    assert.equal(await page.getByLabel('Synthetic CAPTCHA').inputValue(), 'SYNTHETIC HUMAN CODE');
    await page.locator('#synthetic-verification').evaluate((element) => element.remove());
    owner = await connection();
    await host.request({
      action: 'control',
      bot: owner.bot,
      instance: owner.state.instance,
      epoch: owner.epoch,
      owner: 'agent',
    });
    await tools.invoke(visual, 'screenshot', { surface: 'browser' });
    owner = await connection();
    const handover = await host.request({
      action: 'control',
      bot: owner.bot,
      instance: owner.state.instance,
      epoch: owner.epoch,
      owner: 'human',
    });
    assert.ok(handover);
    const held = tools.invoke(visual, 'act', click);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(visual.waitingForComputer, true);
    owner = await connection();
    await host.request({
      action: 'control',
      bot: owner.bot,
      instance: owner.state.instance,
      epoch: owner.epoch,
      owner: 'agent',
    });
    assert.ok((await held).isError, 'handback requires a new screenshot before coordinate input');
    await tools.invoke(visual, 'screenshot', { surface: 'browser' });
    assert.ok(!(await tools.invoke(visual, 'act', click)).isError);
    owner = await connection();
    await tools.drain(visual);
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
    host = new HostBrowser({ directory: profile, launch });
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
    await actual
      .page('mock-a')
      .getByRole('heading', { name: 'SYNTHETIC UPLOAD ACCEPTED' })
      .waitFor();
    assert.equal(await actual.page('mock-a').evaluate(() => document.cookie), '');
  } finally {
    await host.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    if (!suppliedRoot) await rm(root, { recursive: true, force: true });
  }
});
