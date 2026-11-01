import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
import { loadHost, type ManagedHost } from '../electron/host';
import { parseCommand, trustedSender } from '../electron/ipc';
import { RuntimeClient } from '../electron/runtime';

// Isolated native acceptance: real renderer/preload/IPC and a disposable Linux service, with no user workspace cache.
const root = process.cwd();
const origin = process.env.DABAN_BROWSER_PREVIEW_ORIGIN;
const serverOrigin = process.env.DABAN_BROWSER_PREVIEW_SERVER;
const renderer = pathToFileURL(join(root, 'dist', 'index.html')).href;
app.setName('daban-browser-acceptance');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'daban-browser-client-')));
let client: RuntimeClient;
let host: ManagedHost | undefined;
let window: BrowserWindow;
let timer: ReturnType<typeof setInterval>;
let requested = 0,
  published = 0;
async function refresh() {
  const ticket = ++requested;
  const state = await client.status();
  if (ticket >= published && window && !window.isDestroyed()) {
    published = ticket;
    window.webContents.send('daban:runtime-state', state);
  }
  return state;
}
ipcMain.handle('daban:runtime', async (event, value) => {
  if (
    !trustedSender(
      {
        url: event.senderFrame?.url || '',
        mainFrame: event.senderFrame === event.sender.mainFrame,
        owned: !!window && event.sender === window.webContents,
      },
      renderer,
    )
  )
    return { ok: false, error: 'UNTRUSTED_SENDER' };
  try {
    const command = parseCommand(value),
      result = await client.invoke(command);
    if (
      !['status', 'browser.view', 'browser.state', 'browser.receipt', 'frame'].includes(
        command.type,
      )
    )
      await refresh();
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'RUNTIME_REQUEST_FAILED' };
  }
});
app
  .whenReady()
  .then(async () => {
    const configuration = process.env.DABAN_BROWSER_PREVIEW_HOST;
    if (configuration) {
      host = await loadHost(configuration, join(app.getPath('userData'), 's'));
      client = await host.connect();
    } else {
      assert.ok(origin && serverOrigin);
      client = new RuntimeClient({ origin, serverOrigin });
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window = new BrowserWindow({
      width: 1380,
      height: 860,
      minWidth: 920,
      minHeight: 640,
      title: 'Daban · 浏览器合成验收',
      webPreferences: {
        preload: join(root, 'dist-electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '浏览器验收',
          submenu: [
            {
              label: '宽屏验收',
              accelerator: 'CmdOrCtrl+Shift+1',
              click: () => window.setSize(1380, 860),
            },
            {
              label: '紧凑验收',
              accelerator: 'CmdOrCtrl+Shift+2',
              click: () => window.setSize(960, 720),
            },
            { label: '退出验收', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    await window.loadURL(renderer);
    timer = setInterval(() => {
      refresh().catch(() => {});
    }, 1000);
    window.on('closed', () => {
      clearInterval(timer);
      if (host)
        host.close().then(
          () => app.quit(),
          () => app.quit(),
        );
      else app.quit();
    });
    await refresh();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'PREVIEW_FAILED');
    app.quit();
  });
