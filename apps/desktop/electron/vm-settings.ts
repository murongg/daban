import { readVmConnection, saveVmConnection, validateVmConnection } from '@daban/engine/host';
import type { VmConnectionStatus } from '@daban/protocol';

interface Options {
  file: string;
  platform?: NodeJS.Platform;
  handoff(): Promise<unknown>;
  reconnect(): Promise<unknown>;
}

export class VmSettings {
  private active = false;
  constructor(private readonly options: Options) {}
  private get supported() {
    return (this.options.platform ?? process.platform) === 'win32';
  }
  async status(): Promise<VmConnectionStatus> {
    if (!this.supported) return { supported: false };
    const connection = await readVmConnection(this.options.file);
    return { supported: true, ...(connection ? { connection } : {}) };
  }
  async native() {
    if (!this.supported) throw new Error('VM_PLATFORM_UNSUPPORTED');
    if (this.active) throw new Error('VM_SETTINGS_BUSY');
    this.active = true;
    try {
      const next = (await this.status()).connection;
      if (!next) return this.status();
      validateVmConnection(next);
      // The host atomically fences new admissions and refuses this handoff while tasks or recovery are busy.
      await this.options.handoff();
      try {
        await saveVmConnection(this.options.file, { ...next, enabled: false });
      } finally {
        // A failed disk write must also allow the original execution mode to start again.
        await this.options.reconnect();
      }
      return this.status();
    } finally {
      this.active = false;
    }
  }
}
