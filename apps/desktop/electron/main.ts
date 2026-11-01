import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, Notification, session } from 'electron';
import { noticeIpc } from './notification-ipc';
import { Notifications } from './notifications';
import { runtimeService } from './service';

app.setName('Daban');
app.setPath('userData', join(app.getPath('appData'), 'daban-preview'));
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('dev.daban.app');
let mainWindow: BrowserWindow | undefined;
let windowReady = false;
let nativeLaunchId: string | undefined;
app.on('ready', (_event, launchInfo) => {
  const value: unknown = launchInfo;
  if (
    value &&
    typeof value === 'object' &&
    'identifier' in value &&
    typeof value.identifier === 'string'
  )
    nativeLaunchId = value.identifier;
});

function createWindow() {
  const window = new BrowserWindow({
    title: 'Daban',
    icon: join(__dirname, '..', 'dist', 'app-icon.png'),
    width: 1380,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#f8f8f7',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 20, y: 28 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = window;
  windowReady = false;
  window.setMenuBarVisibility(false);
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      windowReady = false;
    }
    service?.releaseInputs().catch(() => console.error('Desktop input cleanup failed'));
  });
  window.once('ready-to-show', () => {
    if (mainWindow === window) windowReady = true;
    window.show();
  });
  window.on('focus', () =>
    notifications?.focus().catch(() => console.error('Notification focus cleanup failed')),
  );
  // Bot webpages stay inside Linux; the privileged local renderer must never navigate.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(join(__dirname, '..', 'dist', 'index.html')).catch((error) => {
    dialog.showErrorBox(
      'Daban 启动失败',
      app.isPackaged
        ? '客户端文件无法载入，请重新获取完整安装包。已保存的任务和文件不会被清除。'
        : `无法载入客户端界面。请先运行 npm run build。\n${error.message}`,
    );
    app.quit();
  });
  return window;
}

function focusWindow() {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  const focus = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (windowReady) focus();
  else window.once('ready-to-show', focus);
  return window;
}

let service: ReturnType<typeof runtimeService> | undefined;
let notifications: Notifications | undefined;
let closeNoticeIpc: (() => unknown) | undefined;
let exiting = false;
if (primary) {
  app.on('second-instance', () => {
    if (app.isReady()) focusWindow();
  });
  app
    .whenReady()
    .then(async () => {
      if (process.platform === 'darwin')
        app.dock?.setIcon(join(__dirname, '..', 'dist', 'app-icon.png'));
      const renderer = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;
      notifications = new Notifications(join(app.getPath('userData'), 'notifications.json'), {
        foreground: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
        open: () => {
          focusWindow();
        },
        changed: (message) => {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('daban:notification-message', message);
        },
      });
      closeNoticeIpc = noticeIpc(notifications, renderer);
      if (process.platform === 'win32')
        Notification.handleActivation((details) => {
          if (details.type === 'click')
            notifications
              ?.activate(details.arguments)
              .catch(() => console.error('Notification activation failed'));
        });
      const agentDirectory = app.isPackaged
        ? join(process.resourcesPath, 'agent')
        : join(__dirname, '..', 'resources/agent');
      service = runtimeService(
        app.getPath('userData'),
        pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href,
        app.isPackaged
          ? join(process.resourcesPath, 'environment')
          : join(__dirname, '..', 'resources/environment'),
        (snapshot, scope) => notifications!.observe(snapshot, scope),
        {
          entry: join(agentDirectory, 'main.js'),
          executable: join(agentDirectory, 'node/bin/node'),
        },
      );
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      createWindow();
      if (nativeLaunchId) await notifications.activate(nativeLaunchId);
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
      await service.connect();
    })
    .catch(() => {
      console.error('Daban initialization failed');
      dialog.showErrorBox('Daban 启动失败', '请重新打开客户端；已保存的任务和文件不会被清除。');
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    try {
      closeNoticeIpc?.();
      await notifications?.close();
      await service?.close();
    } catch {
      console.error('Runtime connection cleanup failed');
    } finally {
      app.exit(0);
    }
  });
}
