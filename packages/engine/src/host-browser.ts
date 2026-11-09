import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type HostBrowserRequest, type HostBrowserStatus, validAgentId } from '@daban/protocol';
import type { BrowserDriver } from './browser-tools.js';
import type { ComputerFacade } from './computer-tools.js';
import { Control, errorCode, Fault } from './control.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { type Browser, type BrowserOptions, createBrowser } from './runtime.js';

function chromeExecutable() {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter((value): value is string => !!value)
            .flatMap((root) => [
              path.join(root, 'Google/Chrome/Application/chrome.exe'),
              path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
            ])
        : [];
  return candidates.find((file) => existsSync(file));
}

export interface HostBrowserOptions {
  directory: string;
  launch?: (options: BrowserOptions) => Promise<Browser>;
}

export class HostBrowser {
  readonly control = new Control([]);
  private current?: Browser;
  private alive = false;
  private readonly connected = new Set<string>();
  private operations: Promise<unknown> = Promise.resolve();
  private error = '';
  private closed = false;
  private permissions?: Promise<string>;
  readonly facade: ComputerFacade;

  constructor(readonly options: HostBrowserOptions) {
    const unavailable = async (): Promise<never> => {
      throw new Fault('HOST_DESKTOP_UNAVAILABLE');
    };
    const tabs: BrowserDriver = {
      navigate: (...args) => this.browser(args[0]).tabs!.navigate(...args),
      snapshot: (...args) => this.browser(args[0]).tabs!.snapshot(...args),
      act: (...args) => this.browser(args[0]).tabs!.act(...args),
      command: (...args) => this.browser(args[0]).tabs!.command(...args),
      upload: (...args) => this.browser(args[0]).tabs!.upload(...args),
      download: (...args) => this.browser(args[0]).tabs!.download(...args),
    };
    this.facade = {
      available: (bot) => this.selected(bot),
      control: this.control,
      frame: unavailable,
      screens: { input: unavailable, openApp: unavailable },
      browser: {
        available: (bot) => this.selected(bot),
        autoStart: {
          allowed: (bot) => this.autoStartAllowed(bot),
          open: (bot, scope, signal) =>
            this.change(async () => {
              signal.throwIfAborted();
              if (scope === 'bot' && !(await this.autoStartAllowed(bot)))
                throw new Fault('HOST_BROWSER_NOT_CONNECTED', 503);
              if (this.selected(bot)) return undefined;
              await this.open(bot, 'agent', signal);
              if (scope !== 'task' || !this.selected(bot)) return undefined;
              const browser = this.browser(bot);
              return () =>
                this.change(async () => {
                  if (this.current === browser && this.selected(bot))
                    await this.disconnect(bot, browser);
                });
            }),
        },
        tabs,
        frame: (bot) => this.browser(bot).tabs!.frame(bot, true),
        view: (bot) => this.browser(bot).view(bot, true),
        input: (bot, epoch, input, actor, binding) =>
          this.browser(bot).input(bot, epoch, input, actor, binding),
      },
    };
  }
  selected(bot: string) {
    return (
      !this.closed &&
      this.alive &&
      this.connected.has(bot) &&
      !this.current?.closed &&
      !!this.current?.tabs?.has(bot)
    );
  }
  private browser(bot: string) {
    if (!this.selected(bot)) throw new Fault('HOST_BROWSER_NOT_CONNECTED', 503);
    return this.current!;
  }
  private change<T>(operation: () => Promise<T>) {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }
  async status(): Promise<HostBrowserStatus> {
    const connections = [];
    for (const bot of this.connected) {
      if (!this.selected(bot)) continue;
      try {
        connections.push({
          bot,
          ...this.control.state(bot),
          state: await this.current!.tabs!.state(bot),
        });
      } catch {
        /* A crashed optional browser must not make ordinary chat unavailable. */
      }
    }
    return {
      available: !this.closed,
      connections,
      ...(this.current?.embedded ? { embedded: true } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  private async permissionFile(bot: string) {
    if (!validAgentId(bot)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    this.permissions ??= secureDirectory(this.options.directory)
      .then((directory) => secureDirectory(path.join(directory, 'auto-start')))
      .catch((error: unknown) => {
        this.permissions = undefined;
        throw error;
      });
    // Bot IDs are case-sensitive even on filesystems where names are not.
    return path.join(await this.permissions, createHash('sha256').update(bot).digest('hex'));
  }
  private async autoStartAllowed(bot: string) {
    const file = await this.permissionFile(bot);
    try {
      const info = await lstat(file);
      return info.isFile() && info.size === 0 && (await privateMetadata(file, info, 0o600));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }
  private async autoStart(bot: string, enabled?: boolean) {
    const allowed = await this.autoStartAllowed(bot);
    if (enabled === undefined || enabled === allowed) return { bot, enabled: allowed };
    const file = await this.permissionFile(bot);
    if (enabled) await writeFile(file, '', { flag: 'wx', mode: 0o600 });
    else {
      // Persist revocation before closing tabs, even if browser teardown fails.
      await unlink(file);
      if (this.selected(bot)) await this.disconnect(bot, this.browser(bot));
    }
    return { bot, enabled };
  }
  private async disconnect(bot: string, browser: Browser) {
    await this.control.revoke(bot);
    this.connected.delete(bot);
    await browser.detach(bot);
  }
  private async open(bot: string, owner: 'human' | 'agent' = 'human', signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Fault('HOST_BROWSER_UNAVAILABLE', 503);
    // Auto-start cannot take over a connection the human already controls.
    if (this.selected(bot)) return this.status();
    if (this.connected.size >= 16) throw new Fault('BROWSER_TAB_LIMIT');
    this.control.register(bot);
    this.error = '';
    try {
      if (!this.current || !this.alive || this.current.closed) {
        await this.current?.close();
        const directory = await secureDirectory(this.options.directory);
        const profileDir = await secureDirectory(path.join(directory, 'profile'));
        const executablePath = this.options.launch ? undefined : chromeExecutable();
        const browser = await (this.options.launch ?? createBrowser)({
          profileDir,
          endpointFile: path.resolve(this.options.directory, '../browser-bridge.json'),
          origin: 'http://127.0.0.1:8766',
          bots: [],
          control: this.control,
          publicOnly: true,
          networkFile: path.resolve(this.options.directory, '../model/network.json'),
          ...(executablePath ? { executablePath } : {}),
        });
        this.current = browser;
        this.alive = true;
        browser.context.on('close', () => {
          if (this.current !== browser || this.closed) return;
          this.alive = false;
          this.error = 'HOST_BROWSER_DISCONNECTED';
          for (const id of this.connected) this.control.revoke(id).catch(() => {});
          this.connected.clear();
        });
      }
      if (this.closed) throw new Fault('HOST_BROWSER_UNAVAILABLE', 503);
      signal?.throwIfAborted();
      this.control.activate(bot);
      await this.current.attach(bot);
      signal?.throwIfAborted();
      if (owner === 'human')
        await this.current.transfer(bot, this.control.state(bot).epoch, 'human');
      this.connected.add(bot);
      return this.status();
    } catch {
      await this.control.revoke(bot).catch(() => {});
      await this.current?.detach(bot).catch(() => {});
      signal?.throwIfAborted();
      this.error = 'HOST_BROWSER_START_FAILED';
      throw new Fault(this.error, 503);
    }
  }
  async request(request: HostBrowserRequest): Promise<unknown> {
    if (!validAgentId(request.bot)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    if (request.action === 'open') return this.change(() => this.open(request.bot));
    if (request.action === 'autoStart')
      return this.change(() => this.autoStart(request.bot, request.enabled));
    const browser = this.browser(request.bot),
      tabs = browser.tabs!;
    if (request.action === 'close' || request.action === 'control') {
      const check = () => {
        if (this.browser(request.bot) !== browser || browser.tabs!.instance !== request.instance)
          throw new Fault('BROWSER_VIEW_STALE');
        if (this.control.state(request.bot).epoch !== request.epoch)
          throw new Fault('STALE_CONTROL');
      };
      if (request.action === 'control') {
        check();
        return browser.transfer(request.bot, request.epoch, request.owner);
      }
      return this.change(async () => {
        check();
        await this.disconnect(request.bot, browser);
        return this.status();
      });
    }
    if (request.action === 'state') return tabs.state(request.bot);
    if (request.action === 'view') return browser.view(request.bot);
    if (request.action === 'target')
      return browser.target(request.bot, request.epoch, request.binding);
    if (request.action === 'command') return tabs.human(request.bot, request.request);
    if (request.action === 'answer') return tabs.answer(request.bot, request.request);
    if (request.action === 'receipt') return tabs.receipt(request.bot, request.id);
    if (request.action === 'input') {
      await browser.boundInput(request.bot, request.epoch, request.binding, request.input);
      return { ok: true };
    }
    throw new Fault('INVALID_BROWSER_REQUEST', 400);
  }
  async close() {
    this.closed = true;
    await this.operations;
    for (const bot of this.connected) await this.control.revoke(bot);
    this.connected.clear();
    await this.current?.close();
  }
}
