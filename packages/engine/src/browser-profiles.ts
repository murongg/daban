import type { Control } from './control.js';
import { Fault } from './control.js';
import type { Browser } from './runtime.js';

export class BrowserProfiles {
  private readonly entries = new Map<
    string,
    { control: Control; users: Set<string>; browser: Promise<Browser> }
  >();
  private closed = false;
  constructor(private readonly create: (profile: string, control: Control) => Promise<Browser>) {}
  async check(profile: string, control: Control) {
    if (this.closed) throw new Fault('COMPUTER_SERVICE_CLOSED');
    const active = this.entries.get(profile);
    if (active) {
      await active.browser;
      return;
    }
    const browser = await this.create(profile, control);
    await browser.close();
  }
  async acquire(profile: string, bot: string, control: Control) {
    if (this.closed) throw new Fault('COMPUTER_SERVICE_CLOSED');
    let entry = this.entries.get(profile);
    if (entry && entry.control !== control) throw new Fault('INVALID_COMPUTER_STATE');
    if (!entry) {
      entry = { control, users: new Set(), browser: this.create(profile, control) };
      this.entries.set(profile, entry);
    }
    entry.users.add(bot);
    try {
      const browser = await entry.browser;
      await browser.attach(bot);
      return browser;
    } catch (error) {
      entry.users.delete(bot);
      if (!entry.users.size) {
        this.entries.delete(profile);
        await entry.browser.then((browser) => browser.close()).catch(() => {});
      }
      throw error;
    }
  }
  async release(profile: string, bot: string) {
    const entry = this.entries.get(profile);
    if (!entry) return;
    const browser = await entry.browser;
    await browser.detach(bot);
    entry.users.delete(bot);
    if (!entry.users.size) {
      this.entries.delete(profile);
      await browser.close();
    }
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => (await entry.browser).close()),
    );
    this.entries.clear();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
