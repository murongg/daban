import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { readVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  isSetupStatus,
  type QemuMode,
  type SetupStatus,
  type WindowsAcceleration,
  type WindowsSetup,
} from '@daban/protocol';
import { parseQemuMachine } from './qemu.js';
import { qemuResources, withQemuAssets } from './qemu-assets.js';
import { installQemu, type QemuInstallOptions } from './qemu-install.js';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';
import { WindowsHost } from './windows.js';

interface Options {
  dataRoot: string;
  vmConfigFile: string;
  bundleDirectory: string;
}
interface Dependencies {
  probe?: () => Promise<WindowsAcceleration>;
  enable?: () => Promise<unknown>;
  resources?: () => Promise<
    Pick<WindowsSetup, 'requiredBytes' | 'availableBytes' | 'downloadBytes'>
  >;
  prepare?: (options: QemuInstallOptions) => Promise<unknown>;
  download?: typeof withQemuAssets;
}
interface Request {
  version: 1;
  mode: QemuMode;
  paused: boolean;
}
export class QemuSetup {
  private readonly host = new WindowsHost();
  private readonly ready: Promise<unknown>;
  private operations: Promise<unknown> = Promise.resolve();
  private active?: Promise<unknown>;
  private cancellation?: AbortController;
  private closed = false;
  private failed = false;
  private observation?: { at: number; value: WindowsAcceleration };
  settled: Promise<unknown> = Promise.resolve();
  constructor(
    readonly options: Options,
    private readonly dependencies: Dependencies = {},
  ) {
    this.ready = secureDirectory(path.dirname(options.vmConfigFile))
      .then(() => secureDirectory(options.dataRoot))
      .catch(() => {
        this.failed = true;
      });
  }
  get busy() {
    return !!this.active;
  }
  private file(name: string) {
    return path.join(this.options.dataRoot, name);
  }
  private change<T>(action: () => Promise<T>) {
    const next = this.operations.then(action);
    this.operations = next.catch(() => {});
    return next;
  }
  private async request(): Promise<Request | undefined> {
    const value = await readQemuRecord(this.file('qemu-request.json'));
    if (value === undefined) return undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 3 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('mode' in value) ||
      (value.mode !== 'whpx' && value.mode !== 'tcg') ||
      !('paused' in value) ||
      typeof value.paused !== 'boolean'
    )
      throw Error('QEMU_STORE_UNSAFE');
    return value as Request;
  }
  private async windows(mode?: QemuMode): Promise<WindowsSetup> {
    const root = path.join(this.options.dataRoot, 'qemu');
    const saved = await readQemuRecord(path.join(root, 'machine.json'));
    const installed = saved === undefined ? undefined : parseQemuMachine(saved, root);
    mode ??= installed?.acceleration;
    if (!this.observation || Date.now() - this.observation.at > 30000)
      this.observation = {
        at: Date.now(),
        value: await (this.dependencies.probe ?? (() => this.host.probe()))(),
      };
    const acceleration = this.observation.value;
    const resources = await (
      this.dependencies.resources ??
      (async () => {
        const resources = installed
          ? { requiredBytes: 0, downloadBytes: 0 }
          : await qemuResources(this.options);
        const space = await statfs(this.options.dataRoot);
        return {
          ...resources,
          availableBytes: space.bavail * space.bsize,
        };
      })
    )();
    return { acceleration, ...(mode ? { mode } : {}), memoryMiB: 6144, diskGiB: 64, ...resources };
  }
  async status(): Promise<SetupStatus> {
    await this.ready;
    if (this.failed)
      return { required: true, target: 'linux', phase: 'failed', error: 'QEMU_STORE_UNSAFE' };
    try {
      const request = await this.request();
      const connection = await readVmConnection(this.options.vmConfigFile);
      if (connection?.enabled) return { required: false, target: 'linux', phase: 'complete' };
      const windows = await this.windows(request?.mode);
      const progress = await readQemuRecord(this.file('qemu-progress.json'));
      if (progress !== undefined && (!isSetupStatus(progress) || progress.target !== 'linux'))
        throw Error('QEMU_STORE_UNSAFE');
      if (request?.paused)
        return {
          required: true,
          target: 'linux',
          phase: this.busy ? 'cancelling' : 'cancelled',
          windows,
        };
      return {
        ...(progress ?? { phase: 'available' }),
        required: true,
        target: 'linux',
        windows,
      } as SetupStatus;
    } catch (error) {
      return {
        required: true,
        target: 'linux',
        phase: 'failed',
        error:
          error instanceof Error && /^QEMU_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'QEMU_STORE_UNSAFE',
      };
    }
  }
  private async publish(value: Partial<SetupStatus>) {
    const previous = await readQemuRecord(this.file('qemu-progress.json'));
    const next: SetupStatus = {
      required: true,
      target: 'linux',
      phase: 'verifying',
      ...(isSetupStatus(previous) ? previous : {}),
      ...value,
    };
    if (!isSetupStatus(next)) throw Error('QEMU_STORE_UNSAFE');
    await writeQemuRecord(this.file('qemu-progress.json'), next);
  }
  start(mode?: QemuMode) {
    return this.change(() => this.startNow(mode));
  }
  private async startNow(mode?: QemuMode) {
    await this.ready;
    if (this.closed) throw Error('SETUP_CLOSED');
    if (this.failed || this.busy) return this.status();
    const current = await this.status();
    if (!current.required || current.error === 'QEMU_STORE_UNSAFE') return current;
    const previous = await this.request();
    const selected = mode ?? previous?.mode ?? current.windows?.mode ?? 'whpx';
    const windows = await this.windows(selected);
    if (windows.acceleration === 'unsupported') throw Error('QEMU_PLATFORM_UNSUPPORTED');
    if (previous && previous.mode !== selected) {
      const machine = await readQemuRecord(path.join(this.options.dataRoot, 'qemu/machine.json'));
      const instance = await readQemuRecord(path.join(this.options.dataRoot, 'qemu/instance.json'));
      if (machine || instance) throw Error('QEMU_MODE_CHANGED');
    }
    await writeQemuRecord(this.file('qemu-request.json'), {
      version: 1,
      mode: selected,
      paused: false,
    });
    if (selected === 'whpx' && windows.acceleration !== 'ready') {
      await this.publish({ phase: 'waiting', error: undefined });
      return this.status();
    }
    if ((windows.availableBytes ?? Infinity) < (windows.requiredBytes ?? 0))
      throw Error('QEMU_DISK_SPACE');
    await this.publish({ phase: 'verifying', progress: undefined, error: undefined });
    this.begin(selected);
    return this.status();
  }
  private track(action: () => Promise<unknown>) {
    this.active = action()
      .catch(async (error) => {
        if (this.closed) return;
        const detail =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : error instanceof Error
              ? error.message
              : '';
        console.error('[qemu-setup]', /^[A-Z0-9_]{1,80}$/.test(detail) ? detail : 'UNEXPECTED');
        await this.publish({
          phase: this.cancellation?.signal.aborted ? 'cancelled' : 'failed',
          error: this.cancellation?.signal.aborted
            ? undefined
            : /^(?:PAYLOAD_INTEGRITY|ARCHIVE_[A-Z_]+)$/.test(detail)
              ? 'QEMU_ASSET_INTEGRITY'
              : /^PAYLOAD_[A-Z_]+$/.test(detail)
                ? 'QEMU_DOWNLOAD_FAILED'
                : error instanceof Error &&
                    /^(QEMU|EXECUTOR|EXECUTION)_[A-Z_]+$/.test(error.message)
                  ? error.message
                  : 'QEMU_SETUP_FAILED',
        });
      })
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.settled = this.active;
  }
  private begin(mode: QemuMode) {
    this.cancellation = new AbortController();
    const signal = this.cancellation.signal;
    this.track(async () => {
      // Download callbacks are synchronous; drain their writes before any later phase, including cancellation.
      let writes: Promise<unknown> = Promise.resolve();
      let writeError: unknown;
      const drain = async () => {
        await writes;
        if (writeError) throw writeError;
      };
      const prepare = async (bundleDirectory: string) => {
        await drain();
        signal.throwIfAborted();
        await (this.dependencies.prepare ?? installQemu)({
          ...this.options,
          bundleDirectory,
          mode,
          signal,
          changed: (value) => this.publish(value),
        });
      };
      const root = path.join(this.options.dataRoot, 'qemu');
      const saved = await readQemuRecord(path.join(root, 'machine.json'));
      try {
        // A published machine owns its disk and tools, even if its first connection was interrupted.
        if (saved !== undefined) {
          parseQemuMachine(saved, root);
          await prepare(this.options.bundleDirectory);
        } else
          await (this.dependencies.download ?? withQemuAssets)(
            {
              ...this.options,
              signal,
              progress: ({ received, total }) => {
                writes = writes
                  .then(() =>
                    this.publish({
                      phase: 'downloading',
                      downloaded: received,
                      total,
                      progress: Math.floor((received / total) * 100),
                    }),
                  )
                  .catch((error) => {
                    writeError ??= error;
                  });
              },
              extracting: async () => {
                await drain();
                signal.throwIfAborted();
                await this.publish({ phase: 'extracting', progress: undefined });
              },
            },
            prepare,
          );
      } finally {
        await drain();
      }
      signal.throwIfAborted();
      const connection = await readVmConnection(this.options.vmConfigFile);
      if (connection?.provider !== 'qemu' || !connection.enabled)
        throw Error('QEMU_SETUP_UNCERTAIN');
      await this.publish({ phase: 'complete', required: false, error: undefined });
    });
  }
  enable() {
    return this.change(async () => {
      await this.ready;
      if (this.closed) throw Error('SETUP_CLOSED');
      if (this.busy || this.failed) return this.status();
      const current = await this.status();
      if (!current.required) return current;
      await writeQemuRecord(this.file('qemu-request.json'), {
        version: 1,
        mode: 'whpx',
        paused: false,
      });
      this.cancellation = new AbortController();
      await this.publish({ phase: 'verifying', error: undefined });
      this.track(async () => {
        await (this.dependencies.enable ?? (() => this.host.enable()))();
        this.observation = undefined;
        await this.publish({ phase: 'waiting', error: undefined });
      });
      return this.status();
    });
  }
  resumePending() {
    return this.change(async () => {
      await this.ready;
      if (this.failed || this.closed || this.busy) return this.status();
      const request = await this.request(),
        status = await this.status();
      if (!request || request.paused || !status.required || status.error || !status.windows)
        return status;
      if (request.mode === 'tcg' || status.windows.acceleration === 'ready')
        return this.startNow(request.mode);
      return status;
    });
  }
  cancel() {
    return this.change(async () => {
      await this.ready;
      if (this.closed) throw Error('SETUP_CLOSED');
      const request = await this.request();
      if (!request || !(await this.status()).required) return this.status();
      await writeQemuRecord(this.file('qemu-request.json'), { ...request, paused: true });
      this.cancellation?.abort();
      return this.status();
    });
  }
  async close() {
    this.closed = true;
    await this.operations;
    this.cancellation?.abort();
    await this.active;
  }
}
