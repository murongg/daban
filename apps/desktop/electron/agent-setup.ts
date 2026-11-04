import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { isSetupStatus, type SetupStatus } from '@daban/protocol';
import { Daemon, type DaemonConfig } from './daemon';
import { readSetupRecord } from './setup-record';

interface SetupDaemon {
  ensure(): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface AgentSetupOptions {
  config: DaemonConfig;
  onChange?: (value: SetupStatus) => unknown;
  daemon?: (config: DaemonConfig) => SetupDaemon;
  pollMs?: number;
}
const busy = new Set([
  'downloading',
  'verifying',
  'extracting',
  'creating',
  'starting',
  'connecting',
  'cancelling',
]);
const terminal = new Set(['failed', 'unavailable', 'cancelled']);
async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
export class AgentSetup {
  private value: SetupStatus = { required: true, phase: 'available' };
  private closed = false;
  private cancelled = false;
  private active = false;
  private polling = false;
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private observation = new AbortController();
  private starting?: Promise<SetupStatus>;
  private readonly ready: Promise<unknown>;
  settled: Promise<unknown> = Promise.resolve();
  constructor(readonly options: AgentSetupOptions) {
    this.ready = this.initialize().catch(() =>
      this.publish({ required: true, phase: 'failed', error: 'SETUP_STORE' }),
    );
  }
  private publish(value: SetupStatus) {
    const changed = JSON.stringify(this.value) !== JSON.stringify(value);
    this.value = { ...value };
    if (!this.closed && changed) this.options.onChange?.({ ...value });
    return { ...this.value };
  }
  private async directory() {
    try {
      await secureDirectory(this.options.config.dataRoot);
    } catch {
      throw new Error('SETUP_STORE');
    }
  }
  private async read(name: 'progress.json' | 'cancel.json') {
    return (await readSetupRecord(this.options.config.dataRoot, name))?.value;
  }
  private async marker() {
    const value = await this.read('cancel.json');
    if (value === undefined) return false;
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 1 ||
      !('cancelled' in value) ||
      value.cancelled !== true
    )
      throw new Error('SETUP_STORE');
    return true;
  }
  private async save(name: 'progress.json' | 'cancel.json', value: unknown) {
    await this.directory();
    await this.read(name);
    const file = join(this.options.config.dataRoot, name),
      temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  private async initialize() {
    await this.directory();
    if (await this.marker()) {
      this.cancelled = true;
      this.publish({ required: true, phase: 'cancelled' });
      return;
    }
    const progress = await this.read('progress.json');
    if (progress !== undefined && !isSetupStatus(progress)) throw new Error('SETUP_STORE');
    const configured = await exists(this.options.config.vmConfig);
    if (
      configured &&
      (!progress || progress.phase === 'complete' || progress.phase === 'existing')
    ) {
      this.publish({ required: false, phase: 'existing' });
      return;
    }
    try {
      await fs.access(this.options.config.entry, constants.R_OK);
      await fs.access(this.options.config.executable, constants.X_OK);
    } catch {
      this.publish({ required: true, phase: 'unavailable', error: 'SETUP_MISSING' });
      return;
    }
    if (progress) {
      this.publish({
        ...progress,
        required: true,
        ...(progress.phase === 'complete' ? { phase: 'connecting' as const } : {}),
      });
      if (busy.has(progress.phase) || progress.phase === 'complete') this.watch();
    }
  }
  private watch() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.poll()
        .catch(() => {
          if (!this.closed && !this.cancelled && this.value.required) {
            this.publish({ required: true, phase: 'failed', error: 'SETUP_STORE' });
            this.observation.abort();
            this.stopWatching();
          }
        })
        .finally(() => {
          this.polling = false;
        });
    }, this.options.pollMs ?? 250);
  }
  private stopWatching() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async poll() {
    const generation = this.generation;
    if (this.closed || this.cancelled || !this.value.required) return;
    const progress = await this.read('progress.json');
    // Completion is authoritative; an earlier progress read must never reopen its observer.
    if (
      this.closed ||
      this.cancelled ||
      !this.value.required ||
      generation !== this.generation ||
      progress === undefined
    )
      return;
    if (!isSetupStatus(progress)) throw new Error('SETUP_STORE');
    if (progress.phase === 'complete') {
      this.publish({ required: true, phase: 'connecting' });
      // A reopened UI can verify an already-created environment without authorizing fresh VM creation.
      if (!this.active && (await exists(this.options.config.vmConfig))) this.observe();
    } else {
      this.publish({ ...progress, required: true });
      if (terminal.has(progress.phase)) {
        this.observation.abort();
        this.stopWatching();
      }
    }
  }
  private observe() {
    if (this.closed || this.cancelled || !this.value.required || this.active) return;
    this.active = true;
    this.observation = new AbortController();
    this.watch();
    const signal = this.observation.signal;
    let abort: () => unknown = () => {};
    const cancelled = new Promise<unknown>((_done, reject) => {
      abort = () => reject(new Error('SETUP_CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    this.settled = (async () => {
      let owner: SetupDaemon | undefined;
      try {
        owner = (this.options.daemon ?? ((config) => new Daemon(config)))(this.options.config);
        await Promise.race([owner.ensure(), cancelled]);
        if (this.closed || this.cancelled || signal.aborted) return;
        if (!(await exists(this.options.config.vmConfig))) throw new Error('SETUP_CONNECT');
        if (this.closed || this.cancelled || signal.aborted) return;
        await this.save('progress.json', { required: false, phase: 'complete' });
        if (this.closed || this.cancelled || signal.aborted) return;
        this.publish({ required: false, phase: 'complete' });
      } catch {
        if (!this.closed && !terminal.has(this.value.phase))
          this.publish(
            this.cancelled
              ? { required: true, phase: 'cancelled' }
              : { required: true, phase: 'failed', error: 'SETUP_CONNECT' },
          );
      } finally {
        signal.removeEventListener('abort', abort);
        this.stopWatching();
        // Supervisor.close releases only this UI wait; it never unloads the launchd job.
        await owner?.close();
        this.active = false;
      }
    })();
  }
  async status() {
    await this.ready;
    return { ...this.value };
  }
  start() {
    this.starting ??= this.begin().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async begin() {
    await this.ready;
    if (this.closed) throw new Error('SETUP_CLOSED');
    if (
      this.active ||
      !this.value.required ||
      this.value.phase === 'unavailable' ||
      this.value.error === 'SETUP_STORE'
    )
      return this.status();
    await this.settled;
    await this.directory();
    await this.marker();
    await fs.rm(join(this.options.config.dataRoot, 'cancel.json'), { force: true });
    this.cancelled = false;
    this.generation++;
    await this.save('progress.json', { required: true, phase: 'verifying' });
    if (this.closed) return this.status();
    this.publish({ required: true, phase: 'verifying' });
    this.observe();
    return this.status();
  }
  async cancel() {
    await this.ready;
    await this.starting?.catch(() => {});
    if (this.closed) throw new Error('SETUP_CLOSED');
    if (!this.value.required) return this.status();
    // This is a pause request checked between bootstrap phases, never a process or VM kill.
    await this.save('cancel.json', { cancelled: true });
    this.cancelled = true;
    this.generation++;
    this.observation.abort();
    this.stopWatching();
    return this.publish({ required: true, phase: 'cancelled' });
  }
  async close() {
    this.closed = true;
    this.generation++;
    this.observation.abort();
    this.stopWatching();
    await this.settled;
  }
}
