import { access } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RemoteAccess } from '@daban/engine/remote';
import { isLocalComputerStatus, modelCatalog } from '@daban/protocol';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Notification,
  powerMonitor,
  session,
} from 'electron';
import { type MessageKey, type Parameters, translate } from '../shared/locale';
import { Components, readComponentReference } from './components';
import { HostAdmin } from './host-admin';
import { trustedSender } from './ipc';
import { LocalComputer } from './local-computer';
import { localServer } from './local-server';
import { LocalePreferences } from './locale';
import { localeIpc } from './locale-ipc';
import { localizeMenu } from './menu';
import { desktopDriver } from './native';
import { noticeIpc } from './notification-ipc';
import { Notifications } from './notifications';
import { PeerWorker } from './peer';
import { nativeMediaCurrent, RemoteConsent } from './remote-consent';
import { runtimeService } from './service';
import { controlSocket } from './socket';
import { titlebarIpc, titlebarOptions } from './titlebar';
import { updateIpc } from './update-ipc';
import { UpdateSave } from './update-save';
import { Updates } from './updates';

app.setName('Daban');
// Honor Electron's explicit profile switch so acceptance can run without touching the user's saved workspace.
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
app.setPath(
  'userData',
  requestedProfile ? resolve(requestedProfile) : join(app.getPath('appData'), 'daban-preview'),
);
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('dev.daban.app');
let closeLocaleIpc: (() => unknown) | undefined;
let closeTitlebarIpc: (() => unknown) | undefined;
let preferences: LocalePreferences | undefined;
let mainWindow: BrowserWindow | undefined;
let windowReady = false;
let nativeLaunchId: string | undefined;
let localComputer: LocalComputer | undefined;
let closeLocalServer: (() => Promise<unknown>) | undefined;
let remoteAccess: RemoteAccess | undefined;
let peerWorker: PeerWorker | undefined;
let remoteConsent: RemoteConsent | undefined;
let hostAdmin: HostAdmin | undefined;
const hostOnly = app.commandLine.hasSwitch('host-only');
if (hostOnly && process.platform !== 'linux') throw Error('REMOTE_HOST_PLATFORM');
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
    ...titlebarOptions(process.platform),
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
    if (!remoteAccess?.state().hosting)
      localComputer?.revoke().catch(() => console.error('Local computer cleanup failed'));
    service?.releaseInputs().catch(() => console.error('Desktop input cleanup failed'));
    // An idle peer window must not keep a controller alive after its visible window closes.
    if (!mainWindow && process.platform !== 'darwin' && !remoteAccess?.state().hosting) app.quit();
  });
  window.once('ready-to-show', () => {
    if (mainWindow === window) windowReady = true;
    window.show();
  });
  window.on('focus', () => {
    remoteConsent?.pause();
    remoteAccess?.stopMedia('native').catch(() => console.error('Remote viewing pause failed'));
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
let updateQuitting = false;
let updates: Updates | undefined;
let closeUpdateIpc: (() => unknown) | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;
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
      closeTitlebarIpc = titlebarIpc(renderer);
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
        ['darwin', 'win32', 'linux'].includes(process.platform) &&
        globalShortcut.register(localShortcut, () => {
          remoteConsent?.pause();
          remoteAccess
            ?.stopMedia('native')
            .catch(() => console.error('Remote viewing pause failed'));
          localComputer?.interrupt().catch(() => console.error('Local computer pause failed'));
          if (!hostOnly) focusWindow();
        });
      localComputer = new LocalComputer(
        desktopDriver(() => mainWindow ?? peerWorker?.companionWindow),
        shortcut,
      );
      const pauseLocal = () => {
        remoteConsent?.pause();
        remoteAccess?.stopMedia('native').catch(() => console.error('Remote viewing pause failed'));
        localComputer?.interrupt().catch(() => console.error('Local computer pause failed'));
      };
      powerMonitor.on('lock-screen', pauseLocal);
      powerMonitor.on('suspend', pauseLocal);
      if (['darwin', 'win32', 'linux'].includes(process.platform)) {
        try {
          closeLocalServer = await localServer(
            join(app.getPath('userData'), 'agent'),
            localComputer,
          );
        } catch {
          console.error('Local computer bridge unavailable');
        }
      }
      const reference = await readComponentReference(join(process.resourcesPath, 'runtime.json'));
      const agentSource = hostOnly
        ? {
            entry: resolve(
              process.env.DABAN_AGENT_ENTRY ?? join(__dirname, '..', 'dist-agent/main.js'),
            ),
            executable: resolve(process.env.DABAN_AGENT_NODE ?? '/usr/local/bin/node'),
          }
        : reference
          ? {
              runtime: new Components({
                directory: join(app.getPath('userData'), 'components'),
                reference,
                platform: process.platform,
                arch: process.arch,
                publisher:
                  process.platform === 'darwin'
                    ? join(process.resourcesPath, '../..')
                    : app.getPath('exe'),
                ...(process.platform === 'win32' &&
                (await access(join(process.resourcesPath, 'runtime.zip')).then(
                  () => true,
                  () => false,
                ))
                  ? { bundledArchive: join(process.resourcesPath, 'runtime.zip') }
                  : {}),
              }),
            }
          : {
              entry: join(agentDirectory, 'main.js'),
              executable:
                process.platform === 'win32'
                  ? join(agentDirectory, 'node/node.exe')
                  : join(agentDirectory, 'node/bin/node'),
            };
      service = runtimeService(
        app.getPath('userData'),
        pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href,
        app.isPackaged
          ? join(process.resourcesPath, 'environment')
          : join(__dirname, '..', 'resources/environment'),
        (snapshot, scope) => notifications!.observe(snapshot, scope),
        { ...agentSource, nativeFirst: true },
        localComputer,
        process.platform,
        {
          request: (command, host) =>
            remoteAccess
              ? remoteAccess.request(command, host)
              : Promise.reject(Error('REMOTE_UNAVAILABLE')),
        },
      );
      peerWorker = new PeerWorker({
        page: join(__dirname, '..', 'dist', 'peer.html'),
        preload: join(__dirname, 'peer-preload.cjs'),
        renderer,
        window: () => mainWindow,
        allowCapture: async () => {
          const permissions = localComputer?.status().permissions;
          if (!permissions?.screen) return false;
          if (localComputer?.status().session?.owner === 'agent') await localComputer.interrupt();
          if (hostOnly) return true;
          const answer = await dialog.showMessageBox({
            type: 'question',
            title: text('remote.viewTitle'),
            message: text('remote.viewConfirm'),
            buttons: [text('common.cancel'), text('remote.allowView')],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1;
        },
      });
      remoteConsent = new RemoteConsent(
        () => localComputer?.status().session,
        async (device, scope) => {
          const model = service?.localSnapshot().model;
          const entry = modelCatalog(model?.connections).find((entry) => entry.id === scope.model);
          const provider = model?.connections?.find((provider) => provider.id === entry?.provider);
          let recipient = provider?.name ?? model?.provider ?? scope.model;
          if (provider) {
            try {
              recipient += ` (${new URL(provider.baseURL).origin})`;
            } catch {}
          }
          if (localComputer?.status().session?.owner === 'agent') await localComputer.interrupt();
          if (hostOnly)
            return (
              hostAdmin?.review({
                kind: 'native',
                device: device.id,
                bot: scope.bot,
                model: scope.model,
                recipient,
              }) ?? false
            );
          const answer = await dialog.showMessageBox({
            type: 'question',
            title: text('remote.nativeTitle'),
            message: text('remote.nativeConfirm', { 0: device.name, 1: scope.bot }),
            detail: text('remote.nativeDetails', { 0: recipient, 1: scope.model, 2: device.id }),
            buttons: [text('common.cancel'), text('remote.allowNative')],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1;
        },
      );
      remoteAccess = new RemoteAccess({
        directory: join(app.getPath('userData'), 'remote'),
        name: hostname(),
        platform: process.platform,
        peer: peerWorker,
        dispatch: async (command, device) => {
          if (!service) throw Error('RUNTIME_OFFLINE');
          const result = await service.invokeLocal(command);
          if (
            device &&
            (command.type === 'local.connect' || command.type === 'local.resume') &&
            isLocalComputerStatus(result) &&
            result.session
          )
            remoteConsent?.granted(device.id, result.session);
          return result;
        },
        authorize: (device, command) =>
          remoteConsent
            ? remoteConsent.authorize(device, command)
            : Promise.reject(Error('REMOTE_NATIVE_AUTH_REQUIRED')),
        revoke: async (device) => {
          if (remoteConsent?.revoke(device)) await localComputer?.revoke();
        },
        snapshot: (value, host) => service?.publishRemote(value, host),
        media: async (device, request) => {
          if (request.surface !== 'native' || !peerWorker) throw Error('REMOTE_MEDIA_UNAVAILABLE');
          const current = localComputer?.status().session;
          if (
            !current ||
            current.bot !== request.bot ||
            current.id !== request.session ||
            current.revision !== request.revision
          )
            throw Error('LOCAL_SESSION_STALE');
          await remoteConsent?.authorize(device, {
            type: 'local.preview',
            session: request.session,
            revision: request.revision,
          });
          if (
            hostOnly &&
            !(await hostAdmin?.review({
              kind: 'view',
              device: device.id,
              bot: current.bot,
              model: current.model,
            }))
          )
            throw Error('REMOTE_CAPTURE_NOT_ALLOWED');
          return peerWorker;
        },
        currentMedia: (request) => {
          const snapshot = service?.localSnapshot();
          const profile = snapshot?.profiles.find((item) => item.id === request.bot);
          return nativeMediaCurrent(
            request,
            localComputer?.status().session,
            snapshot && profile && !profile.archived
              ? {
                  bot: request.bot,
                  model: profile.model || snapshot.model.model,
                  modelRevision: snapshot.model.revision ?? 0,
                }
              : undefined,
          );
        },
      });
      try {
        await remoteAccess.ready;
      } catch {
        // Pairing state must never prevent the existing local workspace from opening.
        await remoteAccess.close().catch(() => {});
        remoteAccess = undefined;
        if (hostOnly) throw Error('REMOTE_HOST_UNAVAILABLE');
        console.error(
          'Remote device state could not be opened. Local workspace remains available.',
        );
      }
      remoteAccess?.subscribe((state) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send('daban:remote-state', state);
      });
      ipcMain.handle('daban:remote', async (event, command: unknown) => {
        const frame = event.senderFrame;
        if (
          !trustedSender(
            {
              url: frame?.url ?? '',
              mainFrame: frame === event.sender.mainFrame,
              owned: BrowserWindow.getAllWindows().some(
                (window) => window.webContents === event.sender,
              ),
            },
            renderer,
          )
        )
          throw Error('UNTRUSTED_SENDER');
        if (!remoteAccess) throw Error('REMOTE_UNAVAILABLE');
        return remoteAccess.command(command);
      });
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
        callback(peerWorker?.permission(contents, permission) ?? false),
      );
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission) => peerWorker?.permission(contents, permission) ?? false,
      );
      if (hostOnly) {
        if (!remoteAccess) throw Error('REMOTE_HOST_UNAVAILABLE');
        hostAdmin = new HostAdmin({
          socket: controlSocket(
            join(app.getPath('userData'), 'remote', 'admin.sock'),
            'remote-admin',
          ),
          command: (command) => remoteAccess!.command(command),
          status: () => ({
            remote: remoteAccess!.state(),
            computer: localComputer?.status(),
            runtime: service?.localSnapshot().phase,
          }),
          pause: async () => {
            remoteConsent?.pause();
            await remoteAccess!.stopMedia();
            return localComputer?.interrupt();
          },
        });
        await hostAdmin.listen();
        await remoteAccess
          .command({
            type: 'host',
            enabled: true,
            server: app.commandLine.getSwitchValue('connect-server'),
          })
          .catch(() => console.error('Remote signaling unavailable; Host will reconnect.'));
      } else createWindow();
      const updateSupported =
        app.isPackaged &&
        ['darwin', 'win32'].includes(process.platform) &&
        (await access(join(process.resourcesPath, 'app-update.yml')).then(
          () => true,
          () => false,
        ));
      const updateDriver = updateSupported
        ? (await import('electron-updater')).autoUpdater
        : undefined;
      const save = new UpdateSave(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return undefined;
        const target = mainWindow.webContents;
        return { id: target.id, send: (message) => target.send('daban:update-message', message) };
      });
      updates = new Updates({
        version: app.getVersion(),
        supported: updateSupported,
        driver: updateDriver,
        save: () => save.request(),
        prepare: async () => {
          if (!service) throw Error('AGENT_UPDATE_UNAVAILABLE');
          await service.prepareUpdate();
        },
        restore: async () => {
          updateQuitting = false;
          await service?.resumeAfterUpdate();
        },
        installing: () => {
          updateQuitting = true;
        },
        changed: (status) => {
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('daban:update-message', { type: 'status', status });
        },
      });
      closeUpdateIpc = updateIpc(updates, save, renderer);
      if (updateSupported)
        updateTimer = setTimeout(() => {
          updates?.invoke({ type: 'check' }).catch(() => console.error('Update check unavailable'));
        }, 20000);
      if (nativeLaunchId) await notifications.activate(nativeLaunchId);
      app.on('activate', () => {
        focusWindow();
      });
      await service.connect();
    })
    .catch(() => {
      console.error('Daban initialization failed');
      if (hostOnly) {
        app.quit();
        return;
      }
      dialog.showErrorBox(
        text('app.dabanCouldNotStart'),
        text('app.reopenAppSavedTasksFilesWillNot'),
      );
    });
  app.on('window-all-closed', () => {
    if (remoteAccess?.state().hosting) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    try {
      globalShortcut.unregister(localShortcut);
      await hostAdmin?.close();
      await closeLocalServer?.();
      closeNoticeIpc?.();
      closeLocaleIpc?.();
      closeTitlebarIpc?.();
      if (updateTimer) clearTimeout(updateTimer);
      closeUpdateIpc?.();
      updates?.close();
      ipcMain.removeHandler('daban:remote');
      await remoteAccess?.close();
      await peerWorker?.dispose();
      await notifications?.close();
      await service?.close();
    } catch {
      console.error('Runtime connection cleanup failed');
    } finally {
      // Updater installers depend on Electron's normal quit event; app.exit bypasses that path.
      if (updateQuitting) app.quit();
      else app.exit(0);
    }
  });
}
