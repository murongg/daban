import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { documentLimit, publicUrl, validAgentId } from '@daban/protocol';
import { BrowserWindow, type Rectangle, session, WebContentsView } from 'electron';
import { WebSocket, WebSocketServer } from 'ws';
import { browserPartition } from '../shared/browser';
import { captureBrowser } from './browser-capture';
import { BrowserCdp, type CdpPage } from './browser-cdp';

interface Guard {
  bot: string;
  instance: string;
  epoch: number;
  owner: 'human' | 'agent' | 'handoff';
}
export class BrowserHost {
  private server?: Server;
  private sockets?: WebSocketServer;
  private client?: WebSocket;
  private cdp?: BrowserCdp;
  private partition?: Electron.Session;
  private background?: BrowserWindow;
  private backgroundReady?: Promise<unknown>;
  private readonly token = randomBytes(32).toString('hex');
  private readonly views = new Map<string, WebContentsView>();
  private readonly guests = new Set<WebContentsView>();
  private readonly guards = new Map<string, Guard>();
  private readonly humanViews = new Map<string, WebContentsView>();
  private readonly downloads = new Map<string, Electron.DownloadItem>();
  private downloadPath = '';
  private mounted?: { id: string; view: WebContentsView; window: BrowserWindow; guard: Guard };
  private proxy = '';
  private stopped = false;
  private generation = 0;
  private cycle = 0;
  private pendingMount?: string;
  constructor(private readonly directory: string) {}
  async start() {
    await secureDirectory(this.directory);
    const server = createServer(async (req, res) => {
      if (!this.authorized(req.headers.authorization, req.headers.origin)) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (req.method !== 'POST') throw new Error('INVALID_REQUEST');
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const part of req) {
          size += Buffer.byteLength(part);
          if (size > 4096) throw new Error('INVALID_REQUEST');
          chunks.push(Buffer.from(part));
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('INVALID_REQUEST');
        const data = value as Record<string, unknown>;
        if (req.url === '/configure') {
          if (
            Object.keys(data).length !== 1 ||
            typeof data.proxy !== 'string' ||
            !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(data.proxy)
          )
            throw new Error('INVALID_REQUEST');
          if (this.client || this.views.size) throw new Error('BROWSER_ALREADY_CONNECTED');
          if (!this.partition) {
            const partition = session.fromPartition(browserPartition);
            const storage = partition.getStoragePath();
            if (!storage) throw new Error('BROWSER_STORAGE_UNAVAILABLE');
            await secureDirectory(storage);
            this.partition = partition;
            this.partition.on('will-download', (_event, item, contents) =>
              this.download(item, contents),
            );
          }
          this.downloadPath = await secureDirectory(
            path.join(this.directory, 'browser/profile/.downloads'),
          );
          await this.partition.setProxy({
            proxyRules: data.proxy,
            proxyBypassRules: '<-loopback>',
          });
          this.partition.setPermissionRequestHandler((_contents, _permission, callback) =>
            callback(false),
          );
          this.partition.setPermissionCheckHandler(() => false);
          this.partition.webRequest.onBeforeRequest((details, callback) => {
            let allowed = false;
            try {
              const url = new URL(details.url);
              allowed =
                (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
                  !url.username &&
                  !url.password) ||
                details.url === 'about:blank';
            } catch {
              /* Unknown protocols never leave the dedicated browser session. */
            }
            callback({ cancel: !allowed });
          });
          this.proxy = data.proxy;
        } else if (req.url === '/control') {
          if (
            Object.keys(data).some((key) => !['bot', 'instance', 'epoch', 'owner'].includes(key)) ||
            !validAgentId(data.bot) ||
            !validAgentId(data.instance) ||
            !Number.isSafeInteger(data.epoch) ||
            Number(data.epoch) < 0 ||
            !['human', 'agent', 'handoff'].includes(String(data.owner))
          )
            throw new Error('INVALID_REQUEST');
          await this.guard(data as unknown as Guard);
        } else if (req.url === '/close' && !Object.keys(data).length) {
          this.client?.close();
          this.clear();
        } else throw new Error('INVALID_REQUEST');
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } catch {
        res.writeHead(400).end();
      }
    });
    this.server = server;
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.sockets = sockets;
    server.on('upgrade', (req, socket, head) => {
      if (
        !this.proxy ||
        req.url !== '/cdp' ||
        !this.authorized(req.headers.authorization, req.headers.origin) ||
        this.client
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      sockets.handleUpgrade(req, socket, head, (client) => {
        this.client = client;
        const pending = new Set<Promise<unknown>>();
        const send = (value: Record<string, unknown>) => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
        };
        const cdp = new BrowserCdp(
          send,
          () => this.createPage(),
          (method, params) => this.browserCommand(method, params),
        );
        this.cdp = cdp;
        const ready = this.createPage().then((page) => cdp.add(page));
        ready.catch(() => client.close());
        client.on('message', (bytes) => {
          const work = (async () => {
            let id: unknown;
            let sessionId: string | undefined;
            try {
              const value: unknown = JSON.parse(bytes.toString());
              if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
              const request = value as Record<string, unknown>;
              id = request.id;
              if (
                !Number.isSafeInteger(id) ||
                typeof request.method !== 'string' ||
                (request.sessionId !== undefined && typeof request.sessionId !== 'string')
              )
                throw new Error('INVALID_REQUEST');
              sessionId = request.sessionId as string | undefined;
              await ready;
              const result = await cdp.command(
                request.method,
                request.params as Record<string, unknown> | undefined,
                sessionId,
              );
              send({ id, result, ...(sessionId ? { sessionId } : {}) });
            } catch {
              send({
                id,
                error: { code: -32000, message: 'BROWSER_CDP_FAILED' },
                ...(sessionId ? { sessionId } : {}),
              });
            }
          })();
          pending.add(work);
          work.finally(() => pending.delete(work)).catch(() => {});
        });
        client.on('error', () => client.close());
        client.once('close', () => {
          if (this.client !== client) return;
          this.client = undefined;
          this.clear();
        });
      });
    });
    await new Promise<unknown>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('BROWSER_BRIDGE_FAILED');
    const temporary = path.join(this.directory, `browser-bridge-${randomBytes(8).toString('hex')}`);
    await writeFile(
      temporary,
      JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, token: this.token }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, path.join(this.directory, 'browser-bridge.json'));
  }
  private authorized(auth: unknown, origin: unknown) {
    return (
      !this.stopped &&
      origin === undefined &&
      typeof auth === 'string' &&
      /^Bearer [a-f0-9]{64}$/.test(auth) &&
      timingSafeEqual(Buffer.from(auth.slice(7)), Buffer.from(this.token))
    );
  }
  private async browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.partition) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    // Electron partitions are not CDP-created contexts. Forwarding Storage/Browser
    // commands without a context id would operate on the app's default session.
    if (method === 'Storage.getCookies') {
      const cookies = await this.partition.cookies.get({});
      return {
        cookies: cookies.map((cookie) => ({
          ...cookie,
          expires: cookie.expirationDate ?? -1,
          size: cookie.name.length + cookie.value.length,
          sameSite:
            cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'lax' ? 'Lax' : 'None',
        })),
      };
    }
    if (method === 'Storage.clearCookies') {
      await this.partition.clearStorageData({ storages: ['cookies'] });
      return {};
    }
    if (method === 'Storage.setCookies' && Array.isArray(params.cookies)) {
      for (const value of params.cookies) {
        const cookie = value as Record<string, unknown>;
        if (
          typeof cookie.name !== 'string' ||
          typeof cookie.value !== 'string' ||
          typeof cookie.domain !== 'string'
        )
          throw new Error('BROWSER_CDP_UNSUPPORTED');
        await this.partition.cookies.set({
          url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${typeof cookie.path === 'string' ? cookie.path : '/'}`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          ...(typeof cookie.path === 'string' ? { path: cookie.path } : {}),
          ...(typeof cookie.expires === 'number' && cookie.expires > 0
            ? { expirationDate: cookie.expires }
            : {}),
          secure: cookie.secure === true,
          httpOnly: cookie.httpOnly === true,
          sameSite:
            cookie.sameSite === 'Strict'
              ? 'strict'
              : cookie.sameSite === 'Lax'
                ? 'lax'
                : 'no_restriction',
        });
      }
      return {};
    }
    if (method === 'Browser.setDownloadBehavior' || method === 'Browser.resetPermissions')
      return {};
    if (method === 'Browser.cancelDownload' && typeof params.guid === 'string') {
      this.downloads.get(params.guid)?.cancel();
      return {};
    }
    throw new Error('BROWSER_CDP_UNSUPPORTED');
  }
  private download(item: Electron.DownloadItem, contents: Electron.WebContents) {
    const oversized = () =>
      item.getReceivedBytes() > documentLimit || item.getTotalBytes() > documentLimit;
    if (oversized()) {
      item.cancel();
      return;
    }
    item.on('updated', () => {
      if (oversized()) item.cancel();
    });
    if (this.mounted?.view.webContents === contents && this.mounted.guard.owner === 'human') return;
    item.pause();
    const guid = randomUUID();
    this.downloads.set(guid, item);
    item.setSavePath(path.join(this.downloadPath, guid));
    const progress = (state: 'inProgress' | 'completed' | 'canceled') =>
      this.cdp?.browserEvent('Browser.downloadProgress', {
        guid,
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      });
    item.on('updated', () => progress('inProgress'));
    item.once('done', (_event, state) => {
      progress(state === 'completed' ? 'completed' : 'canceled');
      this.downloads.delete(guid);
    });
    contents.debugger
      .sendCommand('Page.getFrameTree')
      .then((value: { frameTree: { frame: { id: string } } }) => {
        if (!this.cdp || contents.isDestroyed()) {
          item.cancel();
          return;
        }
        this.cdp.browserEvent('Browser.downloadWillBegin', {
          guid,
          frameId: value.frameTree.frame.id,
          url: item.getURL(),
          suggestedFilename: item.getFilename(),
        });
        item.resume();
      })
      .catch(() => item.cancel());
  }
  private async createPage(): Promise<CdpPage> {
    const view = this.newView();
    try {
      return await this.preparePage(view);
    } catch (error) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
      throw error;
    }
  }
  // Background AI pages need animation frames for Playwright's stability checks.
  private preferences(): Electron.WebPreferences {
    return {
      session: this.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      backgroundThrottling: false,
    };
  }
  private newView(existing?: Electron.WebContents) {
    if (!this.partition || this.stopped) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    if (existing && existing.session !== this.partition)
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    // Count allocations before asynchronous CDP attachment; popup bursts cannot race the cap.
    if (this.guests.size >= 129) throw new Error('BROWSER_TAB_LIMIT');
    const view = new WebContentsView({
      ...(existing ? { webContents: existing } : {}),
      webPreferences: this.preferences(),
    });
    this.guests.add(view);
    view.webContents.once('destroyed', () => this.guests.delete(view));
    view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
    this.park(view);
    return view;
  }
  private park(view: WebContentsView) {
    // Windows needs a window-backed compositor for animation frames and Playwright's
    // stability checks. Keep AI pages rendering in a hidden, unfocusable host.
    if (!this.background || this.background.isDestroyed()) {
      this.background = new BrowserWindow({
        width: 960,
        height: 640,
        show: false,
        focusable: false,
        skipTaskbar: true,
        paintWhenInitiallyHidden: true,
        webPreferences: this.preferences(),
      });
      // Initialize the host document before guests depend on its compositor.
      this.backgroundReady = this.background.loadURL('about:blank');
    }
    this.background.contentView.addChildView(view);
    view.setVisible(true);
  }
  private async preparePage(view: WebContentsView, opener?: string): Promise<CdpPage> {
    const cycle = this.cycle;
    const contents = view.webContents;
    await this.backgroundReady;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.debugger.attach('1.3');
    const { targetInfo } = (await contents.debugger.sendCommand('Target.getTargetInfo')) as {
      targetInfo: { targetId: string };
    };
    if (this.stopped || this.cycle !== cycle) {
      contents.close();
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    }
    this.views.set(targetInfo.targetId, view);
    contents.once('destroyed', () => {
      this.hideView(view);
      this.views.delete(targetInfo.targetId);
      this.cdp?.remove(targetInfo.targetId);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if ((url !== 'about:blank' && !publicUrl(url)) || this.guests.size >= 129 || this.stopped)
        return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: this.preferences() },
        createWindow: (options) => {
          // Electron passes the already-created popup WebContents here. Adopting it
          // preserves window.opener/postMessage and avoids leaving a paused orphan.
          const guest = (
            options as Electron.BrowserWindowConstructorOptions & {
              webContents: Electron.WebContents;
            }
          ).webContents;
          const child = this.newView(guest);
          // Electron must finish adopting the popup before its debugger can attach.
          setImmediate(() => {
            this.preparePage(child, targetInfo.targetId)
              .then((page) => this.cdp?.add(page))
              .catch(() => {
                if (!child.webContents.isDestroyed()) child.webContents.close();
              });
          });
          return child.webContents;
        },
      };
    });
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url) && url !== 'about:blank') event.preventDefault();
    });
    if (!opener) await contents.loadURL('about:blank');
    return {
      command: async (method, params, child) => {
        if (method === 'Page.captureScreenshot' && !child)
          return captureBrowser(contents, view.getBounds(), params);
        const result = (await contents.debugger.sendCommand(method, params, child)) as Record<
          string,
          unknown
        >;
        return method === 'Target.getTargetInfo' && opener
          ? { targetInfo: { ...(result.targetInfo as object), openerId: opener } }
          : result;
      },
      listen: (callback) => {
        const listener = (
          _event: Electron.Event,
          method: string,
          params: Record<string, unknown>,
          child: string,
        ) => callback(method, params, child);
        contents.debugger.on('message', listener);
        return () => contents.debugger.removeListener('message', listener);
      },
      close: async () => {
        if (!contents.isDestroyed()) contents.close();
      },
    };
  }
  private async guard(next: Guard) {
    const previous = this.guards.get(next.bot);
    if (previous?.instance === next.instance && previous.epoch > next.epoch) return;
    this.guards.set(next.bot, next);
    if (
      this.mounted?.guard.bot === next.bot &&
      (next.owner !== 'human' ||
        this.mounted.guard.epoch !== next.epoch ||
        this.mounted.guard.instance !== next.instance)
    )
      this.hide(this.mounted.id);
    const view = this.humanViews.get(next.bot);
    if (next.owner !== 'human' && view && !view.webContents.isDestroyed())
      await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
  }
  async present(
    id: string,
    bot: string,
    epoch: number,
    instance: string,
    target: string,
    window: BrowserWindow,
    bounds: Rectangle,
  ) {
    const view = this.views.get(target);
    const guard = this.guards.get(bot);
    if (
      !view ||
      view.webContents.isDestroyed() ||
      !guard ||
      guard.owner !== 'human' ||
      guard.epoch !== epoch ||
      guard.instance !== instance
    )
      throw new Error('BROWSER_TARGET_UNAVAILABLE');
    if (window.isDestroyed()) throw new Error('BROWSER_TARGET_UNAVAILABLE');
    const content = window.getContentBounds();
    const zoom = window.webContents.getZoomFactor();
    const rect = {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    };
    if (
      Object.values(rect).some((value) => !Number.isSafeInteger(value)) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width < 1 ||
      rect.height < 1 ||
      rect.x + rect.width > content.width ||
      rect.y + rect.height > content.height
    )
      throw new Error('BROWSER_VIEW_BOUNDS');
    const ticket = ++this.generation;
    this.pendingMount = id;
    this.humanViews.set(bot, view);
    // Queue both before yielding, so handback's focus update cannot be overtaken by a stale mount.
    await Promise.all([
      view.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'),
      view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: false,
      }),
    ]);
    if (ticket !== this.generation || this.guards.get(bot) !== guard) return false;
    if (this.mounted && (this.mounted.id !== id || this.mounted.view !== view))
      this.hideView(this.mounted.view);
    view.setBounds(rect);
    view.setVisible(true);
    window.contentView.addChildView(view);
    this.mounted = { id, view, window, guard };
    this.pendingMount = undefined;
    return true;
  }
  hide(id: string) {
    if (this.pendingMount === id) {
      this.pendingMount = undefined;
      ++this.generation;
    }
    if (this.mounted?.id === id) this.hideView(this.mounted.view);
  }
  private hideView(view: WebContentsView) {
    if (this.mounted?.view !== view) return;
    const { window } = this.mounted;
    this.mounted = undefined;
    ++this.generation;
    // Detaching a view alone must not leave its hidden renderer receiving keyboard input.
    if (!view.webContents.isDestroyed()) view.setVisible(false);
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.focus();
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
      this.park(view);
    }
  }
  hideAll() {
    this.pendingMount = undefined;
    ++this.generation;
    if (this.mounted) this.hide(this.mounted.id);
  }
  private clear() {
    ++this.cycle;
    this.hideAll();
    this.cdp?.close();
    this.cdp = undefined;
    this.guards.clear();
    this.humanViews.clear();
    for (const download of this.downloads.values()) download.cancel();
    this.downloads.clear();
    for (const view of this.guests) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.guests.clear();
    this.views.clear();
    this.background?.destroy();
    this.background = undefined;
    this.backgroundReady = undefined;
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.clear();
    this.client?.terminate();
    this.sockets?.close();
    this.server?.closeAllConnections();
    if (this.server)
      await new Promise<unknown>((resolve) => this.server!.close(() => resolve(undefined)));
    this.partition?.flushStorageData();
    await this.partition?.cookies.flushStore();
    const file = path.join(this.directory, 'browser-bridge.json');
    const descriptor: unknown = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (
      descriptor &&
      typeof descriptor === 'object' &&
      'token' in descriptor &&
      descriptor.token === this.token
    )
      await unlink(file);
  }
}
