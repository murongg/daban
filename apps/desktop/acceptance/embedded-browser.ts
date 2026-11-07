import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserState, disconnected, type RuntimeCommand } from '@daban/protocol';
import {
  app,
  BrowserWindow,
  session as electronSession,
  ipcMain,
  nativeImage,
  webContents,
} from 'electron';
import { chromium } from 'playwright';
import { BrowserHost } from '../electron/browser-host';
import { browserIpc } from '../electron/browser-ipc';
import { browserPartition } from '../shared/browser';

app.commandLine.appendSwitch('disable-quic');

async function verifyBrowser() {
  let stage = 'startup';
  const watchdog = setTimeout(() => {
    console.error(`Embedded browser verification timed out: ${stage}`);
    app.exit(1);
  }, 30000);
  const suppliedRoot =
    process.env.DABAN_BROWSER_SERVER_ROOT || process.env.DABAN_BROWSER_SMOKE_ROOT;
  const root = suppliedRoot || mkdtempSync(path.join(tmpdir(), 'synthetic-embedded-browser-'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Set the profile before yielding: Electron's network sandbox captures it at startup.
  app.setPath('userData', root);
  await app.whenReady();
  const host = new BrowserHost(root);
  let window: BrowserWindow | undefined;
  let closeIpc: (() => unknown) | undefined;
  let stopUi: (() => Promise<unknown>) | undefined;
  try {
    await host.start();
    if (process.env.DABAN_BROWSER_SERVER_ROOT) {
      clearTimeout(watchdog);
      if (process.env.DABAN_BROWSER_RESTART_CHECK === '1') {
        const endpoint = JSON.parse(
          await readFile(path.join(root, 'browser-bridge.json'), 'utf8'),
        ) as { origin: string; token: string };
        const response = await fetch(`${endpoint.origin}/configure`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ proxy: 'http://127.0.0.1:1' }),
        });
        assert.equal(response.status, 200);
        const partition = electronSession.fromPartition(browserPartition);
        assert.equal(partition.isPersistent(), true);
        const restored = await chromium.connectOverCDP(
          `${endpoint.origin.replace('http:', 'ws:')}/cdp`,
          { headers: { authorization: `Bearer ${endpoint.token}` }, timeout: 15000 },
        );
        const cookies = await restored.contexts()[0].cookies();
        await restored.close();
        assert.ok(
          cookies.some(
            (cookie) => cookie.name === 'synthetic_login' && cookie.value === 'accepted',
          ),
          'A saved login must survive a complete Electron restart',
        );
        console.log('EMBEDDED_BROWSER_RESTART_VERIFIED');
        return;
      }
      console.log('EMBEDDED_BROWSER_READY');
      process.stdin.resume();
      await new Promise<unknown>((resolve) => {
        process.stdin.once('data', () => resolve(undefined));
        process.stdin.once('end', () => resolve(undefined));
      });
      return;
    }
    const endpoint = JSON.parse(await readFile(path.join(root, 'browser-bridge.json'), 'utf8')) as {
      origin: string;
      token: string;
    };
    const headers = {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    };
    const configure = await fetch(`${endpoint.origin}/configure`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ proxy: 'http://127.0.0.1:1' }),
    });
    assert.equal(configure.status, 200);
    await electronSession.defaultSession.cookies.set({
      url: 'https://example.test',
      name: 'mock-privileged',
      value: 'must-not-be-visible',
    });
    const partition = electronSession.fromPartition(browserPartition);
    await partition.cookies.set({
      url: 'https://example.test',
      name: 'mock-browser',
      value: 'visible',
    });
    const browser = await chromium.connectOverCDP(
      endpoint.origin.replace('http:', 'ws:') + '/cdp',
      { headers, timeout: 15000 },
    );
    const context = browser.contexts()[0];
    const cookies = await context.cookies();
    assert.ok(cookies.some((cookie) => cookie.name === 'mock-browser'));
    assert.ok(!cookies.some((cookie) => cookie.name === 'mock-privileged'));
    const page = await context.newPage();
    stage = 'page content';
    await page.setContent(
      '<title>Synthetic browser verification</title><style>body{margin:36px;font:16px system-ui;color:#202020}h1{font-size:26px}p{color:#666}label{display:block;margin:20px 0}input{display:block;box-sizing:border-box;width:100%;max-width:400px;padding:10px;margin-top:8px;border:1px solid #bbb;border-radius:6px;font:inherit}</style><h1>Synthetic sign-in</h1><p>A local verification fixture. No external account is used.</p><label>Note<input id="note"></label><label>Code<input id="code" autocomplete="one-time-code"></label>',
    );
    await page.locator('#note').click({ timeout: 3000 });
    await page.locator('#note').fill('AI synthetic input');
    assert.equal(await page.locator('#note').inputValue(), 'AI synthetic input');
    const opened = page.waitForEvent('popup', { timeout: 3000 });
    opened.catch(() => {});
    stage = 'opening popup';
    await page.evaluate(() => {
      globalThis.window.open('about:blank', 'synthetic-popup');
    });
    const popup = await opened;
    stage = 'closing popup';
    assert.equal(await popup.opener(), page);
    await popup.close();
    stage = 'raw page session';
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    window = new BrowserWindow({
      width: 1180,
      height: 940,
      show: process.env.DABAN_EMBEDDED_VISIBLE === '1',
      webPreferences: {
        preload: path.resolve('dist-electron/preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await window.loadURL('data:text/html,<title>Synthetic Daban shell</title>');
    const control = async (epoch: number, owner: string) => {
      const result = await fetch(`${endpoint.origin}/control`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ bot: 'mock-bot', instance: 'mock-instance', epoch, owner }),
      });
      assert.equal(result.status, 200);
    };
    await control(2, 'human');
    stage = 'native presentation';
    assert.equal(
      await host.present(
        'mock-mount',
        'mock-bot',
        2,
        'mock-instance',
        targetInfo.targetId,
        window,
        { x: 20, y: 80, width: 700, height: 500 },
      ),
      true,
    );
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getTitle() === 'Synthetic browser verification');
    assert.ok(guest);
    await page.locator('#code').focus();
    await guest.insertText('合成验证码1234');
    assert.equal(await page.locator('#code').inputValue(), '合成验证码1234');
    assert.equal(await guest.executeJavaScript('typeof window.require'), 'undefined');
    const ui = path.resolve('outputs/embedded-browser/ui/index.html');
    const state: BrowserState = {
      bot: 'mock-bot',
      available: true,
      instance: 'mock-instance',
      revision: 1,
      active: 'mock-tab',
      tabs: [{ id: 'mock-tab', title: 'Synthetic sign-in', url: 'about:blank', generation: 0 }],
      pending: [],
    };
    let epoch = 2;
    let owner: 'human' | 'agent' = 'human';
    let closing = false;
    const shots = new Set<Promise<Buffer>>();
    stopUi = async () => {
      closing = true;
      await Promise.allSettled([...shots]);
    };
    const snapshot = () => ({
      ...disconnected('ready'),
      protocolVersion: 16,
      hostBrowser: {
        available: true,
        embedded: true,
        connections: [{ bot: state.bot, epoch, owner, state }],
      },
    });
    ipcMain.handle('daban:runtime', async (_event, value: RuntimeCommand) => {
      if (closing) return { ok: false, error: 'RUNTIME_CLOSED' };
      if (value.type === 'status' || value.type === 'connect')
        return { ok: true, value: snapshot() };
      if (value.type === 'hostBrowser') {
        if (value.request.action === 'state') return { ok: true, value: state };
        if (value.request.action === 'control') {
          epoch++;
          owner = value.request.owner;
          await control(epoch, owner);
          window!.webContents.send('daban:runtime-state', snapshot());
          return { ok: true, value: { epoch, owner } };
        }
        if (value.request.action === 'view') {
          const capture = page.screenshot({ type: 'jpeg', scale: 'css' });
          shots.add(capture);
          let image: Buffer;
          try {
            image = await capture;
          } finally {
            shots.delete(capture);
          }
          const size = nativeImage.createFromBuffer(image).getSize();
          return {
            ok: true,
            value: {
              bot: state.bot,
              epoch,
              binding: { instance: state.instance, tab: state.active, generation: 0 },
              image: `data:image/jpeg;base64,${image.toString('base64')}`,
              ...size,
            },
          };
        }
      }
      return { ok: false, error: 'SYNTHETIC_COMMAND_UNSUPPORTED' };
    });
    closeIpc = browserIpc(host, pathToFileURL(ui).href, async () => ({
      target: targetInfo.targetId,
    }));
    await window.loadFile(ui);
    window.setTitle('Daban browser — synthetic verification');
    window.show();
    const wait = async (expression: string) => {
      const deadline = Date.now() + 5000;
      while (!(await window!.webContents.executeJavaScript(expression))) {
        if (Date.now() > deadline) throw new Error('SYNTHETIC_UI_TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    await wait('!!document.querySelector(\'[data-native-browser="attached"]\')');
    await writeFile(
      path.resolve('outputs/embedded-browser/desktop-shell.png'),
      (await window.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-open-dialog]").click()',
    );
    await wait('!!document.querySelector(\'[data-native-browser="waiting"]\')');
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-close-dialog]").click()',
    );
    await wait('!!document.querySelector(\'[data-native-browser="attached"]\')');
    window.setSize(1000, 780);
    await wait('!!document.querySelector(\'[data-native-browser="attached"]\')');
    await window.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await writeFile(
      path.resolve('outputs/embedded-browser/compact-shell.png'),
      (await window.capturePage()).toPNG(),
    );
    if (process.env.DABAN_BROWSER_HOLD === '1') {
      clearTimeout(watchdog);
      console.log('EMBEDDED_BROWSER_UI_READY');
      process.stdin.resume();
      await new Promise<unknown>((resolve) => process.stdin.once('data', () => resolve(undefined)));
    }
    const rootSession = await browser.newBrowserCDPSession();
    await assert.rejects(
      rootSession.send('Target.attachToTarget', {
        targetId: 'mock-privileged-renderer',
        flatten: true,
      }),
    );
    guest.focus();
    assert.equal(guest.isFocused(), true);
    await window.webContents.executeJavaScript(
      'document.querySelector(".host-control-button").click()',
    );
    await wait('!document.querySelector("[data-native-browser]")');
    await wait('!!document.querySelector(".browser-live img")');
    assert.equal(
      guest.isFocused(),
      false,
      'Handback must remove native keyboard focus before the Bot resumes',
    );
    await assert.rejects(
      host.present('mock-mount', 'mock-bot', 2, 'mock-instance', targetInfo.targetId, window, {
        x: 20,
        y: 80,
        width: 700,
        height: 500,
      }),
    );
    await page.locator('#note').click({ timeout: 4000 });
    await page.locator('#note').fill('AI resumed after explicit handback');
    assert.equal(await page.locator('#note').inputValue(), 'AI resumed after explicit handback');
    await stopUi();
    await browser.close();
    console.log(
      'EMBEDDED_BROWSER_VERIFIED: owned CDP, direct CJK/OTP input, isolation and explicit handback',
    );
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed())
      console.error(
        'Synthetic UI state:',
        await window.webContents
          .executeJavaScript('document.body.innerText.slice(0, 1800)')
          .catch(() => 'unavailable'),
      );
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await stopUi?.();
    closeIpc?.();
    ipcMain.removeHandler('daban:runtime');
    host.hideAll();
    window?.destroy();
    await host.close();
    if (!suppliedRoot)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (process.exitCode) app.exit(Number(process.exitCode));
    else app.quit();
  }
}

verifyBrowser().catch((error) => {
  console.error(error);
  app.exit(1);
});
