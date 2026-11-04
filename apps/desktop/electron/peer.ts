import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  isPeerEvent,
  type PeerCommand,
  type PeerDescription,
  type PeerEvent,
  type RemoteIceServer,
  type RemotePeerPort,
} from '@daban/protocol';
import { BrowserWindow, desktopCapturer, ipcMain, screen, type WebContents } from 'electron';
import { peerPermission } from '../shared/peer-permissions';
import { trustedSender } from './ipc';

export class PeerWorker implements RemotePeerPort {
  private hidden?: BrowserWindow;
  get companionWindow() {
    return this.hidden && !this.hidden.isDestroyed() ? this.hidden : undefined;
  }
  private readonly targets = new Map<string, WebContents>();
  private readonly pending = new Map<
    string,
    {
      target: number;
      resolve(): unknown;
      reject(error: Error): unknown;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<
    (event: Exclude<PeerEvent, { type: 'result' }>) => unknown
  >();
  private captureSession?: string;
  private readonly listener: Parameters<typeof ipcMain.on>[1];
  constructor(
    private readonly options: {
      page: string;
      preload: string;
      renderer: string;
      window(): BrowserWindow | undefined;
      allowCapture?(session: string): Promise<boolean>;
      diagnostic?(message: string): unknown;
    },
  ) {
    this.listener = (event, value: unknown) => {
      const frame = event.senderFrame;
      const expected =
        event.sender === this.hidden?.webContents
          ? pathToFileURL(options.page).href
          : options.renderer;
      if (
        !trustedSender(
          {
            url: frame?.url ?? '',
            mainFrame: frame === event.sender.mainFrame,
            owned: BrowserWindow.getAllWindows().some(
              (window) => window.webContents === event.sender,
            ),
          },
          expected,
        ) ||
        !isPeerEvent(value)
      )
        return;
      if (value.type === 'result') {
        const pending = this.pending.get(value.id);
        if (!pending || pending.target !== event.sender.id) return;
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        value.ok ? pending.resolve() : pending.reject(Error(value.error ?? 'REMOTE_PEER_FAILED'));
      } else if (this.targets.get(value.session) === event.sender) {
        if (value.type === 'message' && Buffer.byteLength(value.data) > 144 * 1024 * 1024) return;
        for (const listener of this.listeners) listener(value);
      }
    };
    ipcMain.on('daban:peer-event', this.listener);
  }
  private async target(initiator: boolean) {
    const visible = initiator ? this.options.window() : undefined;
    if (visible && !visible.isDestroyed()) return visible.webContents;
    if (!this.hidden || this.hidden.isDestroyed()) {
      const window = new BrowserWindow({
        show: false,
        width: 320,
        height: 200,
        skipTaskbar: true,
        webPreferences: {
          preload: this.options.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: 'daban-remote-peer',
          backgroundThrottling: false,
        },
      });
      this.hidden = window;
      window.webContents.on('console-message', (event) => {
        if (event.message.startsWith('DABAN_RTC_DIAGNOSTIC'))
          this.options.diagnostic?.(event.message);
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.session.setPermissionCheckHandler((contents, permission) =>
        this.permission(contents, permission),
      );
      window.webContents.session.setPermissionRequestHandler((contents, permission, callback) =>
        callback(this.permission(contents, permission)),
      );
      window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
        if (!this.captureSession || this.targets.get(this.captureSession) !== window.webContents) {
          callback({});
          return;
        }
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            if (!this.captureSession || window.isDestroyed()) {
              callback({});
              return;
            }
            const primary = String(screen.getPrimaryDisplay().id);
            const source =
              sources.find((item) => item.display_id === primary) ??
              (sources.length === 1 ? sources[0] : undefined);
            callback(source ? { video: source } : {});
          })
          .catch(() => callback({}));
      });
      await window.loadFile(this.options.page);
    }
    return this.hidden.webContents;
  }
  async open(session: string, initiator: boolean, ice: RemoteIceServer[], media = false) {
    if (this.targets.has(session)) throw Error('REMOTE_DUPLICATE_SESSION');
    const target = await this.target(initiator);
    this.targets.set(session, target);
    target.once('destroyed', () => {
      if (this.targets.get(session) !== target) return;
      this.targets.delete(session);
      for (const listener of this.listeners) listener({ type: 'state', session, state: 'closed' });
    });
    await this.invoke({ id: randomUUID(), type: 'open', session, initiator, ice, media });
  }
  signal(session: string, payload: PeerDescription) {
    return this.invoke({ id: randomUUID(), type: 'signal', session, payload });
  }
  send(session: string, data: string, channel?: 'events') {
    return this.invoke({ id: randomUUID(), type: 'send', session, data, channel });
  }
  async capture(session: string) {
    if (this.captureSession || !(await this.options.allowCapture?.(session)))
      throw Error('REMOTE_CAPTURE_NOT_ALLOWED');
    this.captureSession = session;
    try {
      await this.invoke({ id: randomUUID(), type: 'capture', session });
    } finally {
      this.captureSession = undefined;
    }
  }
  async close(session: string) {
    const target = this.targets.get(session);
    if (!target || target.isDestroyed()) {
      this.targets.delete(session);
      return;
    }
    try {
      await this.invoke({ id: randomUUID(), type: 'close', session });
    } finally {
      this.targets.delete(session);
    }
  }
  private async invoke(command: PeerCommand) {
    const target = this.targets.get(command.session);
    if (!target || target.isDestroyed()) throw Error('REMOTE_PEER_UNAVAILABLE');
    return new Promise<undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(Error('REMOTE_PEER_TIMEOUT'));
      }, 20_000);
      this.pending.set(command.id, {
        target: target.id,
        resolve: () => resolve(undefined),
        reject,
        timer,
      });
      target.send('daban:peer-command', command);
    });
  }
  subscribe(listener: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  permission(contents: WebContents | null, permission: string) {
    if (!contents || contents.isDestroyed()) return false;
    const active = [...this.targets.values()].some((target) => target === contents);
    const expected =
      contents === this.hidden?.webContents
        ? pathToFileURL(this.options.page).href
        : this.options.renderer;
    return (
      contents.getURL() === expected &&
      peerPermission(
        permission,
        active,
        !!this.captureSession && this.targets.get(this.captureSession) === contents,
      )
    );
  }
  async dispose() {
    for (const session of [...this.targets.keys()]) await this.close(session).catch(() => {});
    ipcMain.removeListener('daban:peer-event', this.listener);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('REMOTE_PEER_CLOSED'));
    }
    this.pending.clear();
    this.hidden?.destroy();
  }
}
