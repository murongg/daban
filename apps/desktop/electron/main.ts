import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Notification,
  powerMonitor,
  session,
} from 'electron';
import { type MessageKey, type Parameters, translate } from '../shared/locale';
import { LocalComputer } from './local-computer';
import { localServer } from './local-server';
import { LocalePreferences } from './locale';
import { localeIpc } from './locale-ipc';
import { localizeMenu } from './menu';
import { desktopDriver } from './native';
import { noticeIpc } from './notification-ipc';
import { Notifications } from './notifications';
import { runtimeService } from './service';

app.setName('Daban');
app.setPath('userData', join(app.getPath('appData'), 'daban-preview'));
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('dev.daban.app');
let closeLocaleIpc: (() => unknown) | undefined;
let preferences: LocalePreferences | undefined;
let mainWindow: BrowserWindow | undefined;
let windowReady = false;
let nativeLaunchId: string | undefined;
let localComputer: LocalComputer | undefined;
let closeLocalServer: (() => Promise<unknown>) | undefined;
const localShortcut = 'Control+Alt+Escape';
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

const text = (source: MessageKey, values?: Parameters) =>
  translate(preferences?.current ?? 'zh-CN', source, values);

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
    localComputer?.revoke().catch(() => console.error('Local computer cleanup failed'));
    service?.releaseInputs().catch(() => console.error('Desktop input cleanup failed'));
  });
  window.once('ready-to-show', () => {
    if (mainWindow === window) windowReady = true;
    window.show();
  });
  window.on('focus', () => {
    localComputer?.interrupt().catch(() => console.error('Local computer pause failed'));
    notifications?.focus().catch(() => console.error('Notification focus cleanup failed'));
  });
  // Bot webpages stay inside Linux; the privileged local renderer must never navigate.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(join(__dirname, '..', 'dist', 'index.html')).catch((error) => {
    dialog.showErrorBox(
      text('app.dabanCouldNotStart'),
      app.isPackaged
        ? text('app.appFilesCouldNotLoadedGetComplete')
        : text('app.unableLoadAppInterfaceRunNpmRun', { 0: error.message }),
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
      preferences = new LocalePreferences(join(app.getPath('userData'), 'locale.json'));
      await preferences.ready;
      localizeMenu(preferences.current);
      closeLocaleIpc = localeIpc(preferences, renderer, localizeMenu);
      notifications = new Notifications(join(app.getPath('userData'), 'notifications.json'), {
        locale: () => preferences?.current ?? 'zh-CN',
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
      const shortcut =
        ['darwin', 'win32'].includes(process.platform) &&
        globalShortcut.register(localShortcut, () => {
          localComputer?.interrupt().catch(() => console.error('Local computer pause failed'));
          focusWindow();
        });
      localComputer = new LocalComputer(
        desktopDriver(() => mainWindow),
        shortcut,
      );
      const pauseLocal = () => {
        localComputer?.interrupt().catch(() => console.error('Local computer pause failed'));
      };
      powerMonitor.on('lock-screen', pauseLocal);
      powerMonitor.on('suspend', pauseLocal);
      if (['darwin', 'win32'].includes(process.platform)) {
        try {
          closeLocalServer = await localServer(
            join(app.getPath('userData'), 'agent'),
            localComputer,
          );
        } catch {
          console.error('Local computer bridge unavailable');
        }
      }
      service = runtimeService(
        app.getPath('userData'),
        pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href,
        app.isPackaged
          ? join(process.resourcesPath, 'environment')
          : join(__dirname, '..', 'resources/environment'),
        (snapshot, scope) => notifications!.observe(snapshot, scope),
        {
          entry: join(agentDirectory, 'main.js'),
          executable:
            process.platform === 'win32'
              ? join(agentDirectory, 'node/node.exe')
              : join(agentDirectory, 'node/bin/node'),
        },
        localComputer,
      );
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      createWindow();
      if (nativeLaunchId) await notifications.activate(nativeLaunchId);
      app.on('activate', () => {
        focusWindow();
      });
      await service.connect();
    })
    .catch(() => {
      console.error('Daban initialization failed');
      dialog.showErrorBox(
        text('app.dabanCouldNotStart'),
        text('app.reopenAppSavedTasksFilesWillNot'),
      );
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    try {
      globalShortcut.unregister(localShortcut);
      await closeLocalServer?.();
      closeNoticeIpc?.();
      closeLocaleIpc?.();
      await notifications?.close();
      await service?.close();
    } catch {
      console.error('Runtime connection cleanup failed');
    } finally {
      app.exit(0);
    }
  });
}
