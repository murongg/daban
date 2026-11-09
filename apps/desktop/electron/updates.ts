import type { PayloadOptions } from '@daban/engine/payload';
import { CancellationToken } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import type { Locale } from '../shared/locale';
import {
  type UpdateCommand,
  type UpdateError,
  type UpdateStatus,
  updateNotesLimit,
} from '../shared/updates';
import { readChangelog } from './changelog';

export type UpdateDriver = Pick<
  AppUpdater,
  | 'on'
  | 'removeListener'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowPrerelease'
  | 'allowDowngrade'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
>;
interface Options {
  version: string;
  supported: boolean;
  driver?: UpdateDriver;
  changelogFetch?: typeof fetch;
  prefetchRuntime?: (reference: unknown, options: PayloadOptions) => Promise<unknown>;
  changed?: (status: UpdateStatus) => unknown;
  save?: () => Promise<unknown>;
  prepare?: () => Promise<unknown>;
  restore?: () => Promise<unknown>;
  installing?: () => unknown;
}
export class Updates {
  private value: UpdateStatus;
  private checking?: Promise<UpdateStatus>;
  private downloading?: Promise<UpdateStatus>;
  private installation?: Promise<UpdateStatus>;
  private cancellation?: CancellationToken;
  private runtimeReference: unknown;
  private changelogRequest?: { version: string; pending: Set<Locale> };
  private closed = false;
  private readonly listeners: [string, (...args: unknown[]) => unknown][] = [];
  constructor(private readonly options: Options) {
    this.value = {
      phase: options.supported && options.driver ? 'idle' : 'unsupported',
      version: options.version,
    };
    const driver = options.driver;
    if (!driver || !options.supported) return;
    // A downloaded Mac ZIP must stay unstaged until the host has safely quiesced.
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    const on = (event: string, callback: (value: unknown) => unknown) => {
      const listener = (...args: unknown[]) => {
        if (!this.closed) callback(args[0]);
      };
      driver.on(event as 'error', listener);
      this.listeners.push([event, listener]);
    };
    on('update-available', (info) => {
      if (
        this.downloading ||
        this.installation ||
        !info ||
        typeof info !== 'object' ||
        !('version' in info) ||
        typeof info.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(info.version)
      )
        return;
      this.runtimeReference =
        'vendor' in info &&
        info.vendor &&
        typeof info.vendor === 'object' &&
        'dabanRuntime' in info.vendor
          ? info.vendor.dabanRuntime
          : undefined;
      const notes =
        'releaseNotes' in info && typeof info.releaseNotes === 'string'
          ? info.releaseNotes.slice(0, updateNotesLimit)
          : undefined;
      this.set({
        phase: 'available',
        nextVersion: info.version,
        notes,
        changelogs: info.version === this.value.nextVersion ? this.value.changelogs : undefined,
        error: undefined,
        percent: undefined,
        downloadTarget: undefined,
      });
      this.loadChangelogs(info.version);
    });
    on('update-not-available', () => this.set({ phase: 'current', error: undefined }));
    on('download-progress', (info) => {
      if (
        this.value.phase !== 'downloading' ||
        this.value.downloadTarget === 'runtime' ||
        !info ||
        typeof info !== 'object' ||
        !('percent' in info) ||
        typeof info.percent !== 'number' ||
        !Number.isFinite(info.percent)
      )
        return;
      this.set({ percent: Math.max(0, Math.min(100, info.percent)) });
    });
    on('error', (error) => {
      // The download promise owns failure and cancellation until both downloads have settled.
      if (!this.downloading && this.value.phase !== 'downloading') this.failed(error);
    });
  }
  private loadChangelogs(version: string) {
    const fetcher = this.options.changelogFetch;
    if (!fetcher) return;
    if (this.changelogRequest?.version !== version)
      this.changelogRequest = { version, pending: new Set() };
    const request = this.changelogRequest;
    for (const locale of ['zh-CN', 'en'] as const) {
      if (request.pending.has(locale) || this.value.changelogs?.[locale]) continue;
      request.pending.add(locale);
      readChangelog(version, locale, fetcher)
        .then((text) => {
          // A slow response cannot replace the notes for a newer update or publish after shutdown.
          if (
            text &&
            !this.closed &&
            this.changelogRequest === request &&
            this.value.nextVersion === version
          )
            this.set({ changelogs: { ...this.value.changelogs, [locale]: text } });
        })
        .catch(() => {
          // Notes are optional. Older releases and offline clients can still use the feed text.
        })
        .finally(() => request.pending.delete(locale));
    }
  }
  private set(patch: Partial<UpdateStatus>) {
    if (this.closed) return;
    this.value = { ...this.value, ...patch };
    this.options.changed?.(this.status());
  }
  status() {
    return { ...this.value };
  }
  private failed(error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (
      ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(code)
    ) {
      this.set({ phase: 'unpublished', error: undefined });
      return;
    }
    const installing = ['preparing', 'installing'].includes(this.value.phase);
    this.set({
      phase: installing ? 'downloaded' : 'error',
      error: installing ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_CHECK_FAILED',
    });
    if (installing && !this.installation)
      this.restore().catch(() => console.error('Update recovery failed'));
  }
  private async restore() {
    try {
      await this.options.restore?.();
    } catch {
      this.set({ phase: 'error', error: 'AGENT_UPDATE_UNAVAILABLE' });
    }
  }
  async invoke(command: Exclude<UpdateCommand, { type: 'saved' }>): Promise<UpdateStatus> {
    if (command.type === 'status') return this.status();
    if (this.closed || this.value.phase === 'unsupported' || !this.options.driver)
      throw Error('UPDATE_UNSUPPORTED');
    const driver = this.options.driver;
    if (command.type === 'check') {
      if (this.checking) return this.checking;
      if (
        this.downloading ||
        this.installation ||
        ['downloaded', 'preparing', 'installing'].includes(this.value.phase)
      )
        return this.status();
      this.cancellation = undefined;
      this.set({ phase: 'checking', error: undefined });
      this.checking = driver
        .checkForUpdates()
        .then((result) => {
          if (result === null) this.set({ phase: 'unsupported', error: undefined });
          return this.status();
        })
        .catch((error) => {
          this.failed(error);
          return this.status();
        })
        .finally(() => {
          this.checking = undefined;
        });
      return this.checking;
    }
    if (command.type === 'cancel') {
      this.cancellation?.cancel();
      return this.downloading ?? this.status();
    }
    if (command.type === 'download') {
      if (this.downloading) return this.downloading;
      if (this.value.phase !== 'available') throw Error('UPDATE_NOT_READY');
      const cancellation = new CancellationToken();
      this.cancellation = cancellation;
      this.downloading = this.download(driver, cancellation, this.runtimeReference).finally(() => {
        this.downloading = undefined;
        this.cancellation = undefined;
        cancellation.dispose();
      });
      return this.downloading;
    }
    if (this.installation) return this.installation;
    if (this.value.phase !== 'downloaded') throw Error('UPDATE_NOT_READY');
    this.installation = this.install().finally(() => {
      this.installation = undefined;
    });
    return this.installation;
  }
  private async download(
    driver: UpdateDriver,
    cancellation: CancellationToken,
    reference: unknown,
  ) {
    const controller = new AbortController();
    cancellation.once('cancel', () => controller.abort());
    let error: UpdateError = 'UPDATE_DOWNLOAD_FAILED';
    this.set({ phase: 'downloading', percent: 0, error: undefined });
    try {
      // The updater's own downloaded event only covers the client installer.
      await driver.downloadUpdate(cancellation);
      controller.signal.throwIfAborted();
      if (reference !== undefined && this.options.prefetchRuntime) {
        error = 'UPDATE_RUNTIME_DOWNLOAD_FAILED';
        this.set({ downloadTarget: 'runtime', percent: 0 });
        await this.options.prefetchRuntime(reference, {
          signal: controller.signal,
          progress: ({ received, total }) => {
            if (!controller.signal.aborted)
              this.set({ percent: Math.floor((received / total) * 100) });
          },
        });
        controller.signal.throwIfAborted();
      }
      this.set({ phase: 'downloaded', percent: 100, downloadTarget: undefined });
    } catch {
      this.set({
        phase: 'available',
        percent: undefined,
        downloadTarget: undefined,
        error: cancellation.cancelled ? undefined : error,
      });
    }
    return this.status();
  }
  private async install() {
    this.set({ phase: 'preparing', error: undefined });
    let preparingHost = false;
    try {
      if (!this.options.save || !this.options.prepare) throw Error('UPDATE_INSTALL_FAILED');
      await this.options.save();
      if (this.value.phase !== 'preparing') throw Error('UPDATE_INSTALL_FAILED');
      preparingHost = true;
      await this.options.prepare();
      if (this.value.phase !== 'preparing') throw Error('UPDATE_INSTALL_FAILED');
      this.options.installing?.();
      this.set({ phase: 'installing' });
      this.options.driver!.quitAndInstall(false, true);
      if (this.status().phase !== 'installing') throw Error('UPDATE_INSTALL_FAILED');
      return this.status();
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const code: UpdateError = [
        'UPDATE_SAVE_FAILED',
        'AGENT_UPDATE_BUSY',
        'AGENT_UPDATE_UNAVAILABLE',
        'AGENT_LEGACY_RESTART_REQUIRED',
      ].includes(raw)
        ? (raw as UpdateError)
        : 'UPDATE_INSTALL_FAILED';
      this.set({ phase: 'downloaded', error: code });
      if (preparingHost && code !== 'AGENT_UPDATE_BUSY') await this.restore();
      throw Error(code);
    }
  }
  close() {
    this.closed = true;
    this.cancellation?.cancel();
    for (const [event, callback] of this.listeners)
      this.options.driver?.removeListener(event as 'error', callback);
  }
}
