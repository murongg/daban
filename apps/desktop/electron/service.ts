import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  type RebootStatus,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  recoveryBlocked,
  recoveryReader,
  type SetupStatus,
} from '@daban/protocol';
import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { loadHost, type ManagedHost } from './host';
import { parseCommand, trustedSender } from './ipc';
import type { RuntimeClient } from './runtime';
import { Setup } from './setup';

export function runtimeService(
  userData: string,
  rendererUrl: string,
  resources = join(__dirname, '..', 'resources/environment'),
  onSnapshot?: (snapshot: RuntimeSnapshot, scope?: string) => Promise<unknown>,
) {
  let setup: Setup | undefined;
  let setupState: SetupStatus | undefined;
  function installation() {
    if (closed) throw new Error('RUNTIME_CLOSED');
    setup ??= new Setup({
      userData,
      resources,
      onChange: (next) => {
        if (closed) return;
        setupState = next;
        publish(state);
        if (next.phase === 'complete')
          connect().catch(() => console.error('Installed runtime connection failed'));
      },
    });
    return setup;
  }
  let host: ManagedHost | undefined;
  let loadingHost: Promise<ManagedHost> | undefined;
  let client: RuntimeClient | undefined;
  let state: RuntimeSnapshot = disconnected('connecting');
  let reboot: RebootStatus | undefined;
  let recovering = false;
  let connecting: Promise<RuntimeSnapshot> | undefined;
  let polling = false;
  let closed = false;
  let requested = 0,
    published = 0,
    lastPoll = 0;
  async function managed() {
    if (closed) throw new Error('RUNTIME_CLOSED');
    if (host) return host;
    loadingHost ??= loadHost(join(userData, 'runtime.json'), join(userData, 'runtime-tunnel.sock'))
      .then(async (loaded) => {
        // Closing during config IO must not let a late owner start the VM after Electron has quit.
        if (closed) {
          await loaded.close();
          throw new Error('RUNTIME_CLOSED');
        }
        host = loaded;
        return loaded;
      })
      .finally(() => {
        loadingHost = undefined;
      });
    return loadingHost;
  }
  function publish(next: RuntimeSnapshot) {
    if (closed) return;
    if (reboot) next = { ...next, reboot };
    if (setupState) next = { ...next, setup: setupState };
    const changed = JSON.stringify(state) !== JSON.stringify(next);
    state = next;
    if (changed && onSnapshot) {
      const scope = host?.config
        ? createHash('sha256')
            .update(JSON.stringify([host.config.limaHome, host.config.vm]))
            .digest('hex')
        : undefined;
      try {
        onSnapshot(state, scope).catch(() => console.error('Desktop notice observation failed'));
      } catch {
        console.error('Desktop notice observation failed');
      }
    }
    if (changed)
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('daban:runtime-state', state);
  }
  async function refreshReboot() {
    if (!host) return;
    const next = await host.recoveryStatus();
    if (JSON.stringify(next) !== JSON.stringify(reboot)) {
      reboot = next;
      publish(state);
    }
  }
  async function refresh() {
    if (!client) return state;
    const current = client,
      ticket = ++requested;
    const next = await current.status();
    // A slow poll started before a mutation/reconnect cannot roll back its newer snapshot.
    if (current === client && ticket >= published) {
      published = ticket;
      publish(next);
    }
    return state;
  }
  async function connect(): Promise<RuntimeSnapshot> {
    if (connecting) return connecting;
    connecting = (async () => {
      published = ++requested;
      publish(disconnected('connecting'));
      try {
        const owner = await managed();
        await refreshReboot();
        client = await owner.connect();
        await refresh();
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          setupState = await installation().status();
        publish(disconnected('offline', '本地运行环境未连接，请在设置中重试。'));
      }
      return state;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function dispatch(command: RuntimeCommand): Promise<unknown> {
    if (command.type === 'clipboard.write') {
      clipboard.writeText(command.text);
      return { copied: true };
    }
    if (command.type === 'link.open') {
      // A human link click opens an ordinary browser; it never navigates this privileged renderer or grants agent fetch access.
      await shell.openExternal(new URL(command.url).href);
      return { opened: true };
    }
    if (
      command.type === 'setup.status' ||
      command.type === 'setup.start' ||
      command.type === 'setup.cancel'
    ) {
      const owner = installation();
      const value =
        command.type === 'setup.start'
          ? await owner.start()
          : command.type === 'setup.cancel'
            ? await owner.cancel()
            : await owner.status();
      setupState = value;
      publish(state);
      return value;
    }
    if (command.type === 'connect') return connect();
    if (command.type === 'status') return state;
    if (
      command.type === 'recovery.status' ||
      command.type === 'recovery.review' ||
      command.type === 'recovery.restart' ||
      command.type === 'recovery.inspect' ||
      command.type === 'recovery.cancel' ||
      command.type === 'recovery.start'
    ) {
      const owner = await managed();
      if (command.type === 'recovery.status') {
        await refreshReboot();
        return reboot;
      }
      if (command.type === 'recovery.review') return owner.recoveryReview();
      recovering = true;
      published = ++requested;
      try {
        const result =
          command.type === 'recovery.restart'
            ? await owner.recover(command.request)
            : command.type === 'recovery.inspect'
              ? await owner.inspectRecovery(command.id)
              : command.type === 'recovery.cancel'
                ? await owner.cancelRecovery(command.id)
                : command.type === 'recovery.start'
                  ? await owner.startRecovery(command.id)
                  : undefined;
        if (!result) throw new Error('INVALID_COMMAND');
        if (owner.connection) client = owner.connection;
        await refreshReboot();
        if (result.available && result.operation?.stage === 'complete' && client) await refresh();
        return result;
      } finally {
        recovering = false;
        await refreshReboot();
      }
    }
    if (command.type === 'runtime.inspect') {
      let owner: ManagedHost;
      try {
        owner = await managed();
      } catch (error) {
        if (closed) throw new Error('RUNTIME_CLOSED');
        const missing =
          !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
        return {
          scope: 'host',
          checkedAt: new Date().toISOString(),
          checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => ({
            id,
            state:
              id === 'configuration' ? (missing ? 'unconfigured' : 'unavailable') : 'unchecked',
          })),
        } satisfies DiagnosticReport;
      }
      return owner.inspect();
    }
    if (!client || state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
    if (!recoveryReader(command)) {
      await refreshReboot();
      if (recoveryBlocked({ ...state, reboot })) throw new Error('RUNTIME_RECOVERY_PENDING');
    }
    const result = await client.invoke(command);
    if (!['frame', 'files.list', 'files.read'].includes(command.type)) await refresh();
    return result;
  }
  ipcMain.handle('daban:runtime', async (event, value): Promise<RuntimeReply> => {
    const frame = event.senderFrame;
    if (
      !trustedSender(
        {
          url: frame?.url || '',
          mainFrame: frame === event.sender.mainFrame,
          owned: BrowserWindow.getAllWindows().some((w) => w.webContents === event.sender),
        },
        rendererUrl,
      )
    )
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    try {
      return { ok: true, value: await dispatch(parseCommand(value)) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'RUNTIME_UNAVAILABLE',
      };
    }
  });
  const timer = setInterval(async () => {
    if (closed || polling) return;
    polling = true;
    try {
      await refreshReboot();
      if (!client || connecting || recovering) return;
      const interval = Object.values(state.agents).some(
        (task) => task.running && !['waiting', 'paused'].includes(task.phase),
      )
        ? 250
        : 1000;
      if (Date.now() - lastPoll < interval) return;
      lastPoll = Date.now();
      await refresh();
    } finally {
      polling = false;
    }
  }, 250);
  async function releaseInputs() {
    try {
      await client?.releaseInputs();
    } catch {
      console.error('Unable to release desktop input; ownership remains with the user.');
    }
  }
  return {
    connect,
    releaseInputs,
    async close() {
      closed = true;
      clearInterval(timer);
      ipcMain.removeHandler('daban:runtime');
      await setup?.close();
      host?.abort();
      await releaseInputs();
      await loadingHost?.catch(() => {});
      await host?.close();
    },
  };
}
