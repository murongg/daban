import { validAgentId } from '@daban/protocol';
import type { ViewerGrants } from './authority.js';
import { type ComputerDriver, type ComputerResource, ComputerStartFailure } from './computers.js';
import type { Control } from './control.js';
import { Fault } from './control.js';
import { Screens } from './desktop.js';
import { Native } from './native.js';
import type { Browser } from './runtime.js';
import { createBrowser } from './runtime.js';

export interface MachineOptions {
  dir: string;
  profileDir: string;
  origin: string;
  viewers?: ViewerGrants;
  displayBase: number;
  fullGuest?: boolean;
}
export class Machine implements ComputerDriver {
  private current?: Browser;
  private starting?: Promise<Browser>;
  private control?: Control;
  private browserAlive = false;
  private closed = false;
  constructor(readonly options: MachineOptions) {}
  private browser(control: Control) {
    if (this.closed) return Promise.reject(new Fault('COMPUTER_SERVICE_CLOSED', 503));
    if (this.control && this.control !== control)
      return Promise.reject(new Fault('INVALID_COMPUTER_STATE', 503));
    this.control = control;
    if (this.current && this.browserAlive && !this.current.closed)
      return Promise.resolve(this.current);
    if (!this.starting)
      this.starting = (async () => {
        const previous = this.current;
        if (previous) await previous.close();
        const browser = await createBrowser({
          profileDir: this.options.profileDir,
          origin: this.options.origin,
          bots: [],
          control,
        });
        this.current = browser;
        this.browserAlive = true;
        browser.context.on('close', () => {
          if (this.current === browser) this.browserAlive = false;
        });
        return browser;
      })().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  hasBrowser(bot: string) {
    return (
      !this.closed &&
      this.browserAlive &&
      !!this.current &&
      !this.current.closed &&
      !!this.current.tabs?.has(bot)
    );
  }
  browserFor(bot: string) {
    if (!this.hasBrowser(bot)) throw new Fault('BROWSER_UNAVAILABLE', 503);
    return this.current!;
  }
  async start(bot: string, slot: number, control: Control): Promise<ComputerResource> {
    if (this.closed || process.platform !== 'linux')
      throw new ComputerStartFailure('COMPUTER_RUNTIME_UNAVAILABLE', true);
    if (!validAgentId(bot) || !Number.isSafeInteger(slot) || slot < 0 || slot > 15)
      throw new ComputerStartFailure('INVALID_COMPUTER_STATE', true);
    control.state(bot);
    const screens = new Screens({
      dir: this.options.dir,
      origin: this.options.origin,
      viewers: this.options.viewers,
      displayBase: this.options.displayBase + slot,
      fullGuest: this.options.fullGuest,
    });
    const resource: ComputerResource = {
      bot,
      native: new Native(control, screens),
      alive: () =>
        !screens.closed &&
        screens.children.length >= 2 &&
        screens.children
          .slice(0, 2)
          .every((child) => child.exitCode === null && child.signalCode === null),
    };
    try {
      await screens.start([bot]);
      resource.instance = screens.instance(bot);
      const browser = await this.browser(control);
      await browser.attach(bot);
      return resource;
    } catch (error) {
      resource.instance ??= screens.bots.get(bot)?.instance;
      const code =
        error instanceof Fault && /^[A-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'COMPUTER_START_FAILED';
      try {
        await this.stop(resource);
      } catch {
        throw new ComputerStartFailure(code, false, resource);
      }
      throw new ComputerStartFailure(code, true);
    }
  }
  async stop(resource: ComputerResource) {
    if (this.current?.pages.has(resource.bot)) await this.current.detach(resource.bot);
    await resource.native.close();
  }
  async close() {
    this.closed = true;
    await this.starting?.catch(() => {});
    await this.current?.close();
  }
}
