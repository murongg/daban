import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { isSetupStatus, type SetupStatus } from '@daban/protocol';
import { parseVmConfig, readSetupRecord, writeSetupRecord } from './bootstrap.js';

interface Options {
  dataRoot: string;
  vmConfigFile: string;
  prepare: (signal: AbortSignal) => Promise<unknown>;
}
const working = new Set([
  'verifying',
  'downloading',
  'extracting',
  'creating',
  'starting',
  'connecting',
]);
export class Environment {
  private active?: Promise<unknown>;
  // Serialize user intents so a late start cannot erase a newer pause marker.
  private operations: Promise<unknown> = Promise.resolve();
  private change<T>(operation: () => Promise<T>) {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => {});
    return next;
  }
  private cancellation?: AbortController;
  private closed = false;
  private failed = false;
  private readonly ready: Promise<unknown>;
  settled: Promise<unknown> = Promise.resolve();
  constructor(readonly options: Options) {
    this.ready = secureDirectory(options.dataRoot).catch(() => {
      this.failed = true;
    });
  }
  get busy() {
    return !!this.active;
  }
  private file(name: string) {
    return path.join(this.options.dataRoot, name);
  }
  private async cancelled() {
    const marker = await readSetupRecord(this.file('cancel.json'));
    if (marker === undefined) return false;
    if (
      !marker ||
      typeof marker !== 'object' ||
      Object.keys(marker).length !== 1 ||
      !('cancelled' in marker) ||
      marker.cancelled !== true
    )
      throw Error('SETUP_STORE');
    return true;
  }
  private async progress() {
    const value = await readSetupRecord(this.file('progress.json'));
    if (value === undefined) return { required: true, phase: 'available' } as SetupStatus;
    if (!isSetupStatus(value) || value.target === 'agent') throw Error('SETUP_STORE');
    return value;
  }
  async status(): Promise<SetupStatus> {
    await this.ready;
    if (this.failed)
      return { required: true, target: 'linux', phase: 'failed', error: 'SETUP_STORE' };
    try {
      const configured = await readSetupRecord(this.options.vmConfigFile);
      const progress = await this.progress();
      if (configured !== undefined) {
        parseVmConfig(configured);
        return {
          required: false,
          target: 'linux',
          phase: progress.phase === 'complete' ? 'complete' : 'existing',
        };
      }
      if (await this.cancelled())
        return { required: true, target: 'linux', phase: this.busy ? 'cancelling' : 'cancelled' };
      return { ...progress, required: true, target: 'linux' };
    } catch {
      return { required: true, target: 'linux', phase: 'failed', error: 'SETUP_STORE' };
    }
  }
  start() {
    return this.change(() => this.startNow());
  }
  private async startNow() {
    await this.ready;
    if (this.closed) throw Error('SETUP_CLOSED');
    const current = await this.status();
    if (this.failed || this.busy || !current.required || current.error === 'SETUP_STORE')
      return current;
    await writeSetupRecord(this.file('environment-request.json'), { requested: true });
    await this.cancelled();
    await unlink(this.file('cancel.json')).catch((error) => {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    });
    await writeSetupRecord(this.file('progress.json'), { required: true, phase: 'verifying' });
    this.begin();
    return this.status();
  }
  private begin() {
    if (this.active || this.closed) return;
    this.cancellation = new AbortController();
    const signal = this.cancellation.signal;
    this.active = (async () => {
      try {
        await this.options.prepare(signal);
        signal.throwIfAborted();
        parseVmConfig(await readSetupRecord(this.options.vmConfigFile));
        await writeSetupRecord(this.file('progress.json'), { required: false, phase: 'complete' });
      } catch (error) {
        if (this.closed) return;
        const paused = signal.aborted || (await this.cancelled());
        const code =
          error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
            ? error.message
            : 'SETUP_CONNECT';
        await writeSetupRecord(
          this.file('progress.json'),
          paused
            ? { required: true, phase: 'cancelled' }
            : { required: true, phase: 'failed', error: code },
        );
      }
    })()
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.settled = this.active;
  }
  resumePending() {
    return this.change(() => this.resumeNow());
  }
  private async resumeNow() {
    await this.ready;
    if (this.closed || this.failed || this.busy) return this.status();
    const requested = await readSetupRecord(this.file('environment-request.json'));
    if (requested === undefined) return this.status();
    if (
      !requested ||
      typeof requested !== 'object' ||
      Object.keys(requested).length !== 1 ||
      !('requested' in requested) ||
      requested.requested !== true
    )
      throw Error('SETUP_STORE');
    const current = await this.status();
    // Only the owning server resumes an explicit, interrupted installation, never an observer or a cancelled request.
    if (current.required && working.has(current.phase) && !(await this.cancelled())) this.begin();
    return this.status();
  }
  cancel() {
    return this.change(() => this.cancelNow());
  }
  private async cancelNow() {
    await this.ready;
    const current = await this.status();
    if (this.closed) throw Error('SETUP_CLOSED');
    if (this.failed || !current.required) return current;
    await writeSetupRecord(this.file('cancel.json'), { cancelled: true });
    this.cancellation?.abort();
    return this.status();
  }
  async close() {
    this.closed = true;
    await this.operations;
    this.cancellation?.abort();
    await this.active;
  }
}
