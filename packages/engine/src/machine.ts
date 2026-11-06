import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { validAgentId } from '@daban/protocol';
import type { ViewerGrants } from './authority.js';
import { BrowserProfiles } from './browser-profiles.js';
import { type ComputerDriver, type ComputerResource, ComputerStartFailure } from './computers.js';
import type { Control } from './control.js';
import { Fault } from './control.js';
import { Screens } from './desktop.js';
import { Native } from './native.js';
import type { Browser } from './runtime.js';
import { createBrowser } from './runtime.js';
import { WorkspaceFiles } from './workspace.js';

export interface MachineOptions {
  dir: string;
  profileDir: string;
  origin: string;
  viewers?: ViewerGrants;
  displayBase: number;
  fullGuest?: boolean;
}
export class Machine implements ComputerDriver {
  private readonly active = new Map<
    string,
    { profile: string; browser: Browser; alive: boolean }
  >();
  private readonly selected = new Map<
    string,
    { profile?: string; workspace: string; key: string }
  >();
  private closed = false;
  private readonly profiles: BrowserProfiles;
  constructor(readonly options: MachineOptions) {
    this.profiles = new BrowserProfiles(async (profileDir, control) => {
      const canonical =
        profileDir === options.profileDir
          ? await realpath(profileDir)
          : await new WorkspaceFiles(profileDir, profileDir).base();
      return createBrowser({
        profileDir: canonical,
        origin: options.origin,
        bots: [],
        control,
        networkFile: path.resolve(options.profileDir, '../model/network.json'),
      }).catch((error) => {
        if (error instanceof Fault) throw error;
        throw new Fault('BROWSER_PROFILE_UNAVAILABLE', 503);
      });
    });
  }
  checkProfile(profile: string, control: Control) {
    return this.profiles.check(profile, control);
  }
  binding(bot: string) {
    return this.selected.get(bot)?.key ?? 'legacy-shared';
  }
  bind(bot: string, binding?: { profile?: string; workspace: string; key: string }) {
    if (this.active.has(bot)) throw new Fault('PROJECT_BUSY');
    if (binding) this.selected.set(bot, binding);
    else this.selected.delete(bot);
  }
  hasBrowser(bot: string) {
    const active = this.active.get(bot);
    return (
      !this.closed &&
      !!active &&
      active.alive &&
      !active.browser.closed &&
      !!active.browser.tabs?.has(bot)
    );
  }
  browserFor(bot: string) {
    if (!this.hasBrowser(bot)) throw new Fault('BROWSER_UNAVAILABLE', 503);
    return this.active.get(bot)!.browser;
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
      workspace: this.selected.get(bot)?.workspace,
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
      const profile = this.selected.has(bot)
        ? this.selected.get(bot)?.profile
        : this.options.profileDir;
      if (profile) {
        const browser = await this.profiles.acquire(profile, bot, control);
        const active = { profile, browser, alive: true };
        browser.context.on('close', () => {
          active.alive = false;
        });
        this.active.set(bot, active);
      }
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
    const active = this.active.get(resource.bot);
    if (active) {
      await this.profiles.release(active.profile, resource.bot);
      this.active.delete(resource.bot);
    }
    await resource.native.close();
  }
  async close() {
    this.closed = true;
    await this.profiles.close();
    this.active.clear();
  }
}
