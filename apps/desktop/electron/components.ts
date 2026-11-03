import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  type ComponentIndex,
  componentAsset,
  componentIndex,
  componentPayload,
} from '@daban/engine/component';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import { downloadPayload } from '@daban/engine/payload';
import type { SetupStatus } from '@daban/protocol';
import { componentPaths, extractComponent, verifyComponent } from './component-install';

export interface ComponentOptions {
  directory: string;
  reference: ComponentIndex;
  platform: NodeJS.Platform;
  arch: string;
  publisher: string;
  fetcher?: typeof fetch;
}
export interface PreparedAgentFiles {
  entry: string;
  executable: string;
}
export interface RuntimePreparation {
  readonly id: string;
  prepare(changed?: (value: SetupStatus) => unknown): Promise<PreparedAgentFiles>;
  resume(changed?: (value: SetupStatus) => unknown): Promise<PreparedAgentFiles>;
  status(): SetupStatus;
  cancel(): Promise<SetupStatus>;
  close(): Promise<unknown>;
}
const absent = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
async function privateFile(file: string) {
  const info = await lstat(file).catch((error) => {
    if (absent(error)) return undefined;
    throw error;
  });
  if (
    info &&
    (!info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      !(await privateMetadata(file, info, 0o600)))
  )
    throw Error('COMPONENT_STORE');
  return info;
}
async function text(file: string) {
  const identity = await privateFile(file);
  if (!identity) return undefined;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.ino !== identity.ino || info.dev !== identity.dev || info.size > 8192)
      throw Error('COMPONENT_STORE');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
async function atomic(file: string, value: unknown) {
  await privateFile(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!absent(error)) throw error;
    });
  }
}
export class Components implements RuntimePreparation {
  readonly id: string;
  private readonly asset;
  private readonly payload;
  private value: SetupStatus = { required: true, target: 'agent', phase: 'available' };
  private active?: Promise<PreparedAgentFiles>;
  private initialize?: Promise<unknown>;
  private cancellation?: AbortController;
  private changed?: (value: SetupStatus) => unknown;
  private root = '';
  private slot = '';
  private archive = '';
  private closed = false;
  constructor(
    readonly options: ComponentOptions,
    private readonly dependencies: {
      extract?: typeof extractComponent;
      verify?: typeof verifyComponent;
    } = {},
  ) {
    if (!path.isAbsolute(options.directory)) throw Error('COMPONENT_STORE');
    const index = componentIndex(options.reference, options.reference.id);
    this.id = index.id;
    this.asset = componentAsset(index, options.platform, options.arch);
    this.payload = componentPayload(this.id, this.asset);
  }
  status() {
    return { ...this.value };
  }
  private publish(patch: Partial<SetupStatus>) {
    this.value = { ...this.value, ...patch };
    if (!this.closed) this.changed?.(this.status());
    return this.status();
  }
  private init() {
    this.initialize ??= (async () => {
      this.root = await secureDirectory(this.options.directory);
      this.slot = await secureDirectory(
        path.join(this.root, `${this.id.slice(0, 24)}-${this.asset.platform}-${this.asset.arch}`),
      );
      const downloads = await secureDirectory(path.join(this.root, 'downloads'));
      this.archive = path.join(downloads, this.payload.sha256 + '.zip');
    })();
    return this.initialize;
  }
  prepare(changed?: (value: SetupStatus) => unknown): Promise<PreparedAgentFiles> {
    if (changed) this.changed = changed;
    if (this.closed) return Promise.reject(Error('COMPONENT_CLOSED'));
    if (this.active) return this.active;
    this.cancellation = new AbortController();
    this.active = this.install(this.cancellation.signal)
      .catch((error) => {
        if (
          this.cancellation?.signal.aborted ||
          (error instanceof Error && error.message === 'COMPONENT_PAUSED')
        ) {
          this.publish({ required: true, phase: 'cancelled', error: undefined });
          throw Error(this.closed ? 'COMPONENT_CLOSED' : 'COMPONENT_PAUSED');
        }
        const code =
          error instanceof Error && /^COMPONENT_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'COMPONENT_PREPARE_FAILED';
        this.publish({ required: true, phase: 'failed', error: code });
        throw Error(code);
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  async resume(changed?: (value: SetupStatus) => unknown) {
    await this.active?.catch(() => {});
    await this.init();
    const marker = path.join(this.root, 'paused.json');
    if (await privateFile(marker)) await unlink(marker);
    return this.prepare(changed);
  }
  private async verify(directory: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await (this.dependencies.verify ?? verifyComponent)({
      directory,
      id: this.id,
      platform: this.options.platform,
      arch: this.options.arch,
      archive: this.archive,
      publisher: this.options.publisher,
      signal,
    });
    signal.throwIfAborted();
    return componentPaths(directory, this.options.platform);
  }
  private async download(signal: AbortSignal) {
    this.publish({ required: true, phase: 'downloading', error: undefined, progress: undefined });
    await downloadPayload(this.archive, this.payload, {
      fetcher: this.options.fetcher,
      signal,
      progress: ({ received, total }) =>
        this.publish({
          downloaded: received,
          total,
          progress: Math.floor((received / total) * 100),
        }),
    });
  }
  private async install(signal: AbortSignal) {
    await this.init();
    if ((await text(path.join(this.root, 'paused.json'))) !== undefined)
      throw Error('COMPONENT_PAUSED');
    this.publish({ required: true, phase: 'verifying', error: undefined });
    const pointer = await text(path.join(this.slot, 'current.json'));
    let archiveReady = false;
    if (pointer && this.options.platform === 'win32') {
      await this.download(signal);
      archiveReady = true;
    }
    if (pointer) {
      let saved: unknown;
      try {
        saved = JSON.parse(pointer);
      } catch {
        saved = undefined;
      }
      if (
        saved &&
        typeof saved === 'object' &&
        'id' in saved &&
        saved.id === this.id &&
        'sha256' in saved &&
        saved.sha256 === this.payload.sha256 &&
        'directory' in saved &&
        typeof saved.directory === 'string' &&
        /^install-[A-Za-z0-9]{6}$/.test(saved.directory)
      ) {
        try {
          const files = await this.verify(path.join(this.slot, saved.directory), signal);
          this.publish({ required: false, phase: 'complete', error: undefined });
          return files;
        } catch {
          signal.throwIfAborted();
        }
      }
    }
    if (!archiveReady) await this.download(signal);
    this.publish({ phase: 'extracting', progress: undefined });
    const stage = await mkdtemp(path.join(this.slot, 'install-'));
    const identity = await lstat(stage);
    let published = false;
    try {
      await (this.dependencies.extract ?? extractComponent)(
        this.archive,
        stage,
        this.options.platform,
        signal,
      );
      signal.throwIfAborted();
      this.publish({ phase: 'verifying' });
      const files = await this.verify(stage, signal);
      await atomic(path.join(this.slot, 'current.json'), {
        version: 1,
        id: this.id,
        sha256: this.payload.sha256,
        directory: path.basename(stage),
      });
      published = true;
      // A pause may arrive while the pointer is being flushed. Keep the verified cache, but do not launch it.
      signal.throwIfAborted();
      this.publish({ required: false, phase: 'complete', error: undefined });
      return files;
    } finally {
      if (!published) {
        const current = await lstat(stage).catch(() => undefined);
        // Preserve the preparation error and never remove a staging path whose owner changed.
        if (
          current?.isDirectory() &&
          !current.isSymbolicLink() &&
          identity.ino === current.ino &&
          identity.dev === current.dev
        )
          await rm(stage, { recursive: true, force: true }).catch(() =>
            console.error('Runtime staging cleanup deferred'),
          );
        else console.error('Runtime staging cleanup deferred');
      }
    }
  }
  async cancel() {
    if (!this.value.required) return this.status();
    await this.init();
    await atomic(path.join(this.root, 'paused.json'), { paused: true });
    this.cancellation?.abort();
    await this.active?.catch(() => {});
    return this.publish({ required: true, phase: 'cancelled', error: undefined });
  }
  async close() {
    this.closed = true;
    this.cancellation?.abort();
    await this.active?.catch(() => {});
  }
}

export async function readComponentReference(file: string) {
  const info = await lstat(file).catch((error) => {
    if (absent(error)) return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw Error('COMPONENT_REFERENCE');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.size > 16384)
      throw Error('COMPONENT_REFERENCE');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string')
      throw Error('COMPONENT_REFERENCE');
    return componentIndex(value, value.id);
  } finally {
    await handle.close();
  }
}
