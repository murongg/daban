import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MigrationFile, MigrationIdentity, MigrationManifest } from './migration.js';
import { isControlDataPath } from './migration.js';

export type SourceScope = 'control' | 'browser' | 'shared';
export interface PreparedSource {
  version: 1;
  phase: 'prepared';
  source: MigrationIdentity;
  id: string;
  revision: number;
  boot: string;
  instance: string;
  review: string;
  serviceStopped: true;
  runningModels: 0;
  runningGroups: 0;
}
interface ReaderDependencies {
  request?: (method: string, target: string, data?: Record<string, unknown>) => Promise<unknown>;
  service?: (action: 'status' | 'start' | 'stop') => Promise<string>;
  recovery?: () => Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fault = (code: string) => Object.assign(new Error(code), { code });
export const isSourceIdentity = (value: unknown): value is MigrationIdentity =>
  object(value) &&
  keys(value, ['vm', 'imageFingerprint']) &&
  id(value.vm) &&
  sha(value.imageFingerprint);
const sameSource = (a: MigrationIdentity, b: MigrationIdentity) =>
  a.vm === b.vm && a.imageFingerprint === b.imageFingerprint;
export function isSourcePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\\') &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    value
      .split('/')
      .every((part) => part !== '.' && part !== '..' && !!part && Buffer.byteLength(part) <= 255)
  );
}
export function isPreparedSource(value: unknown): value is PreparedSource {
  return (
    object(value) &&
    keys(value, [
      'version',
      'phase',
      'source',
      'id',
      'revision',
      'boot',
      'instance',
      'review',
      'serviceStopped',
      'runningModels',
      'runningGroups',
    ]) &&
    value.version === 1 &&
    value.phase === 'prepared' &&
    isSourceIdentity(value.source) &&
    id(value.id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    id(value.boot) &&
    id(value.instance) &&
    sha(value.review) &&
    value.serviceStopped === true &&
    value.runningModels === 0 &&
    value.runningGroups === 0
  );
}
export function isSourceManifest(
  value: unknown,
  expected: MigrationIdentity,
  scope: SourceScope,
): value is MigrationManifest {
  if (
    !object(value) ||
    !keys(value, ['source', 'files']) ||
    !isSourceIdentity(value.source) ||
    !sameSource(value.source, expected) ||
    !Array.isArray(value.files) ||
    value.files.length > 100000
  )
    return false;
  const seen = new Set<string>();
  let bytes = 0;
  return value.files.every((entry) => {
    if (
      !object(entry) ||
      !keys(entry, ['path', 'kind', 'size', 'sha256', 'mode']) ||
      entry.kind !== 'file' ||
      !isSourcePath(entry.path) ||
      (scope === 'control' && !isControlDataPath(entry.path)) ||
      !Number.isSafeInteger(entry.size) ||
      Number(entry.size) < 0 ||
      Number(entry.size) > 512 * 1024 * 1024 ||
      !sha(entry.sha256) ||
      !Number.isInteger(entry.mode) ||
      Number(entry.mode) < 0 ||
      Number(entry.mode) > 0o777
    )
      return false;
    const normalized = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    bytes += Number(entry.size);
    return bytes <= 8 * 1024 ** 3;
  });
}
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw fault('SOURCE_METADATA_INVALID');
  }
}
async function safeJson(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw fault('SOURCE_METADATA_INVALID');
    return parsed(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
async function store(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function service(action: 'status' | 'start' | 'stop') {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/systemctl',
      action === 'status'
        ? ['show', '-p', 'ActiveState', '--value', 'bot-browser.service']
        : [action, 'bot-browser.service'],
      {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60000,
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', () => reject(fault('SOURCE_SERVICE_FAILED')));
    child.once('close', (code) =>
      code || bytes > 128
        ? reject(fault('SOURCE_SERVICE_FAILED'))
        : resolve(action === 'status' ? Buffer.concat(chunks).toString('utf8').trim() : 'ok'),
    );
  });
}
async function request(method: string, target: string, data?: Record<string, unknown>) {
  const tokenFile = await open(
    '/var/lib/bot-prototype/model/control-token',
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let token: string;
  try {
    const info = await tokenFile.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128) throw fault('SOURCE_AUTH_FAILED');
    token = (await tokenFile.readFile('utf8')).trim();
  } finally {
    await tokenFile.close();
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw fault('SOURCE_AUTH_FAILED');
  try {
    const response = await fetch(`http://127.0.0.1:8766${target}`, {
      method,
      headers: {
        'x-prototype-token': token,
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.body) throw fault('SOURCE_API_FAILED');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw fault('SOURCE_API_FAILED');
      chunks.push(chunk);
    }
    return parsed(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fault('SOURCE_API_FAILED');
  }
}
const fdPath = (handle: FileHandle, fallback: string) =>
  process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback;
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
export class SourceReader {
  readonly roots: Record<SourceScope, string>;
  constructor(
    readonly options: { roots?: Record<SourceScope, string>; receiptFile: string },
    readonly dependencies: ReaderDependencies = {},
  ) {
    this.roots = options.roots || {
      control: '/var/lib/bot-prototype/model',
      browser: '/var/lib/bot-prototype/profile',
      shared: '/var/lib/bot-prototype/desktops/shared',
    };
  }
  private api(method: string, target: string, data?: Record<string, unknown>) {
    return (this.dependencies.request || request)(method, target, data);
  }
  private state(action: 'status' | 'start' | 'stop') {
    return (this.dependencies.service || service)(action);
  }
  private async receipt(source: MigrationIdentity, operation: string) {
    const value = await safeJson(this.options.receiptFile, 65536);
    if (!isPreparedSource(value) || !sameSource(value.source, source) || value.id !== operation)
      throw fault('SOURCE_NOT_FROZEN');
    return value;
  }
  private async frozen(source: MigrationIdentity, operation: string) {
    if (!isSourceIdentity(source) || !id(operation)) throw fault('SOURCE_INVALID_REQUEST');
    if ((await this.state('status')) !== 'inactive') throw fault('SOURCE_NOT_FROZEN');
    try {
      return await this.receipt(source, operation);
    } catch {
      throw fault('SOURCE_NOT_FROZEN');
    }
  }
  private async idle() {
    const value = await this.api('GET', '/api/state');
    if (
      !object(value) ||
      !object(value.model) ||
      !object(value.model.bots) ||
      !object(value.groups) ||
      !Array.isArray(value.groups.items)
    )
      throw fault('SOURCE_API_INVALID');
    const bots = [
      ...Object.values(value.model.bots),
      ...(object(value.agents) ? Object.values(value.agents) : []),
    ];
    if (
      bots.some((bot) => !object(bot) || bot.running === true) ||
      value.groups.items.some((group) => !object(group) || group.running === true)
    )
      throw fault('SOURCE_BUSY');
  }
  async quiesce(source: MigrationIdentity, operation: string): Promise<PreparedSource> {
    if (!isSourceIdentity(source) || !id(operation)) throw fault('SOURCE_INVALID_REQUEST');
    let saved: PreparedSource | undefined;
    try {
      saved = await this.receipt(source, operation);
    } catch (error) {
      if (!(object(error) && error.code === 'ENOENT')) {
        if (
          await lstat(this.options.receiptFile).then(
            () => true,
            () => false,
          )
        )
          throw fault('SOURCE_RECOVERY_CHANGED');
      }
    }
    if ((await this.state('status')) === 'inactive') {
      if (saved) return saved;
      throw fault('SOURCE_NOT_RUNNING');
    }
    await this.idle();
    const status = await this.api('GET', '/api/recovery');
    if (!object(status) || status.available !== true) throw fault('SOURCE_RECOVERY_UNAVAILABLE');
    let current = object(status.operation) ? status.operation : undefined;
    if (
      current &&
      ['prepared', 'claimed'].includes(String(current.phase)) &&
      current.id !== operation
    )
      throw fault('SOURCE_RECOVERY_CHANGED');
    if (!current || current.id !== operation) {
      const review = await this.api('GET', '/api/recovery/review');
      if (
        !object(review) ||
        !id(review.boot) ||
        !id(review.instance) ||
        !sha(review.digest) ||
        !Number.isSafeInteger(review.revision) ||
        !Array.isArray(review.running) ||
        review.running.length ||
        review.changing !== false
      )
        throw fault('SOURCE_BUSY');
      const prepared = await this.api('POST', '/api/recovery/prepare', {
        id: operation,
        revision: review.revision,
        review: review.digest,
        confirmation: 'restart-all-apps',
      });
      if (!object(prepared)) throw fault('SOURCE_RECOVERY_INVALID');
      current = prepared;
    }
    if (
      current.id !== operation ||
      current.phase !== 'prepared' ||
      !Number.isSafeInteger(current.revision) ||
      !object(current.review) ||
      !id(current.review.boot) ||
      !id(current.review.instance) ||
      !sha(current.review.digest) ||
      !Array.isArray(current.review.running) ||
      current.review.running.length ||
      current.review.changing !== false
    )
      throw fault('SOURCE_RECOVERY_CHANGED');
    await this.idle();
    const result: PreparedSource = {
      version: 1,
      phase: 'prepared',
      source,
      id: operation,
      revision: Number(current.revision),
      boot: current.review.boot,
      instance: current.review.instance,
      review: current.review.digest,
      serviceStopped: true,
      runningModels: 0,
      runningGroups: 0,
    };
    if (saved && JSON.stringify(saved) !== JSON.stringify(result))
      throw fault('SOURCE_RECOVERY_CHANGED');
    // Persist the binding before stopping, so a lost stop acknowledgement never creates a new intent.
    await store(this.options.receiptFile, result);
    await this.state('stop');
    if ((await this.state('status')) !== 'inactive') throw fault('SOURCE_NOT_FROZEN');
    return result;
  }
  async rollback(source: MigrationIdentity, operation: string, expected?: PreparedSource) {
    if (!isSourceIdentity(source) || !id(operation)) throw fault('SOURCE_INVALID_REQUEST');
    const saved = expected || (await this.receipt(source, operation));
    if (!isPreparedSource(saved) || !sameSource(saved.source, source) || saved.id !== operation)
      throw fault('SOURCE_RECOVERY_CHANGED');
    const disk = await (
      this.dependencies.recovery ||
      (() => safeJson('/var/lib/bot-prototype/model/recovery.json', 128 * 1024))
    )();
    const receipt = object(disk) && object(disk.receipt) ? disk.receipt : undefined;
    if (
      !receipt ||
      receipt.id !== operation ||
      !['prepared', 'cancelled'].includes(String(receipt.phase))
    )
      throw fault('SOURCE_RECOVERY_CHANGED');
    await this.state('start');
    let status: unknown;
    for (let count = 0; count < 30; count++) {
      try {
        status = await this.api('GET', '/api/recovery');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!object(status) || !object(status.operation) || status.operation.id !== operation)
      throw fault('SOURCE_RECOVERY_CHANGED');
    if (status.operation.phase === 'prepared') {
      const cancelled = await this.api('POST', '/api/recovery/cancel', {
        id: operation,
        revision: status.operation.revision,
      });
      if (!object(cancelled) || cancelled.id !== operation || cancelled.phase !== 'cancelled')
        throw fault('SOURCE_ROLLBACK_UNKNOWN');
    } else if (status.operation.phase !== 'cancelled') throw fault('SOURCE_RECOVERY_CHANGED');
    await store(this.options.receiptFile, {
      version: 1,
      source,
      id: operation,
      phase: 'rolled-back',
    });
    return { source, id: operation, phase: 'rolled-back' as const };
  }
  private async root(scope: SourceScope) {
    if (!['control', 'browser', 'shared'].includes(scope)) throw fault('SOURCE_INVALID_REQUEST');
    const root = this.roots[scope];
    const handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const canonical = await realpath(fdPath(handle, root));
    if ((await realpath(root)) !== canonical) {
      await handle.close();
      throw fault('SOURCE_ROOT_CHANGED');
    }
    return { root, canonical, handle };
  }
  private async file(root: string, canonical: string, relative: string) {
    if (!isSourcePath(relative)) throw fault('SOURCE_INVALID_PATH');
    const target = path.join(root, relative);
    const info = await lstat(target);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 512 * 1024 * 1024
    )
      throw fault('SOURCE_UNSAFE_FILE');
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const actual = await handle.stat(),
        opened = await realpath(fdPath(handle, target));
      if (
        !actual.isFile() ||
        actual.size > 512 * 1024 * 1024 ||
        actual.nlink !== 1 ||
        actual.ino !== info.ino ||
        actual.dev !== info.dev ||
        opened !== path.join(canonical, relative) ||
        !inside(canonical, opened)
      )
        throw fault('SOURCE_FILE_CHANGED');
      return { handle, info: actual };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async manifest(
    scope: SourceScope,
    source: MigrationIdentity,
    operation: string,
  ): Promise<MigrationManifest> {
    await this.frozen(source, operation);
    const root = await this.root(scope),
      files: MigrationFile[] = [];
    let total = 0;
    const walk = async (directory: string, relative: string, depth: number): Promise<undefined> => {
      if (depth > 32 || files.length > 100000) throw fault('SOURCE_LIMIT');
      for (const name of await readdir(directory)) {
        const relativeFile = relative ? `${relative}/${name}` : name;
        if (
          scope === 'control' &&
          !isControlDataPath(relativeFile) &&
          !['bots', 'task-journal', 'interactions', 'bundles'].includes(relativeFile)
        )
          continue;
        const target = path.join(directory, name),
          info = await lstat(target);
        if (
          scope === 'browser' &&
          !relative &&
          info.isSymbolicLink() &&
          ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name)
        )
          continue;
        if (info.isSymbolicLink()) throw fault('SOURCE_UNSAFE_FILE');
        if (info.isDirectory()) {
          const child = await open(
            target,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            if (!inside(root.canonical, await realpath(fdPath(child, target))))
              throw fault('SOURCE_ROOT_CHANGED');
            await walk(fdPath(child, target), relativeFile, depth + 1);
          } finally {
            await child.close();
          }
        } else {
          if (
            !isSourcePath(relativeFile) ||
            (scope === 'control' && !isControlDataPath(relativeFile))
          )
            throw fault('SOURCE_INVALID_PATH');
          const file = await this.file(
            fdPath(root.handle, root.root),
            root.canonical,
            relativeFile,
          );
          try {
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of file.handle.createReadStream({
              autoClose: false,
              highWaterMark: 65536,
            })) {
              bytes += chunk.length;
              if (bytes > file.info.size) throw fault('SOURCE_FILE_CHANGED');
              hash.update(chunk);
            }
            const after = await file.handle.stat();
            if (
              bytes !== file.info.size ||
              file.info.size !== after.size ||
              file.info.mtimeMs !== after.mtimeMs ||
              file.info.ctimeMs !== after.ctimeMs
            )
              throw fault('SOURCE_FILE_CHANGED');
            total += after.size;
            if (total > 8 * 1024 ** 3) throw fault('SOURCE_LIMIT');
            files.push({
              path: relativeFile,
              kind: 'file',
              size: after.size,
              sha256: hash.digest('hex'),
              mode: after.mode & 0o777,
            });
          } finally {
            await file.handle.close();
          }
        }
      }
    };
    try {
      await walk(fdPath(root.handle, root.root), '', 0);
      if ((await realpath(root.root)) !== root.canonical) throw fault('SOURCE_ROOT_CHANGED');
    } finally {
      await root.handle.close();
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const result = { source, files };
    if (
      !isSourceManifest(result, source, scope) ||
      Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024 - 1
    )
      throw fault('SOURCE_INVALID_MANIFEST');
    if (
      scope === 'control' &&
      files.some(
        (entry) =>
          /\.sqlite-(wal|shm)$/.test(entry.path) &&
          !files.some((main) => main.path === entry.path.replace(/-(wal|shm)$/, '')),
      )
    )
      throw fault('SOURCE_SQLITE_INCOMPLETE');
    return result;
  }
  async *read(
    scope: SourceScope,
    source: MigrationIdentity,
    operation: string,
    entry: MigrationFile,
  ): AsyncIterable<Uint8Array> {
    await this.frozen(source, operation);
    if (!isSourceManifest({ source, files: [entry] }, source, scope))
      throw fault('SOURCE_INVALID_REQUEST');
    const root = await this.root(scope);
    try {
      const file = await this.file(fdPath(root.handle, root.root), root.canonical, entry.path);
      try {
        if (file.info.size !== entry.size || (file.info.mode & 0o777) !== entry.mode)
          throw fault('SOURCE_FILE_CHANGED');
        const digest = createHash('sha256');
        let checked = 0;
        for await (const chunk of file.handle.createReadStream({
          start: 0,
          autoClose: false,
          highWaterMark: 65536,
        })) {
          checked += chunk.length;
          if (checked > entry.size) throw fault('SOURCE_FILE_CHANGED');
          digest.update(chunk);
        }
        if (checked !== entry.size || digest.digest('hex') !== entry.sha256)
          throw fault('SOURCE_FILE_CHANGED');
        const streamed = createHash('sha256');
        let emitted = 0;
        for await (const chunk of file.handle.createReadStream({
          start: 0,
          autoClose: false,
          highWaterMark: 65536,
        })) {
          emitted += chunk.length;
          if (emitted > entry.size) throw fault('SOURCE_FILE_CHANGED');
          streamed.update(chunk);
          yield chunk;
        }
        const after = await file.handle.stat();
        if (
          emitted !== entry.size ||
          streamed.digest('hex') !== entry.sha256 ||
          after.size !== file.info.size ||
          after.mtimeMs !== file.info.mtimeMs ||
          after.ctimeMs !== file.info.ctimeMs ||
          (await realpath(root.root)) !== root.canonical
        )
          throw fault('SOURCE_FILE_CHANGED');
      } finally {
        await file.handle.close();
      }
    } finally {
      await root.handle.close();
    }
  }
}
async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw fault('SOURCE_INVALID_REQUEST');
    chunks.push(Buffer.from(chunk));
  }
  const value = parsed(Buffer.concat(chunks).toString('utf8'));
  if (
    !object(value) ||
    !keys(value, ['method', 'source', 'id', 'scope', 'entry', 'expected']) ||
    !isSourceIdentity(value.source) ||
    !id(value.id)
  )
    throw fault('SOURCE_INVALID_REQUEST');
  const reader = new SourceReader({
    receiptFile: path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipt.json'),
  });
  let result: unknown;
  if (value.method === 'quiesce') result = await reader.quiesce(value.source, value.id);
  else if (value.method === 'rollback')
    result = await reader.rollback(
      value.source,
      value.id,
      isPreparedSource(value.expected) ? value.expected : undefined,
    );
  else if (value.method === 'manifest')
    result = await reader.manifest(value.scope as SourceScope, value.source, value.id);
  else if (value.method === 'read') {
    for await (const chunk of reader.read(
      value.scope as SourceScope,
      value.source,
      value.id,
      value.entry as MigrationFile,
    ))
      await new Promise<unknown>((resolve, reject) =>
        process.stdout.write(chunk, (error) =>
          error ? reject(fault('SOURCE_WRITE_FAILED')) : resolve(undefined),
        ),
      );
    return;
  } else throw fault('SOURCE_INVALID_REQUEST');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
export function isSourceReaderEntry(argv: readonly string[], moduleUrl: string) {
  return (
    argv[2] === '--source-reader' &&
    !!argv[1] &&
    moduleUrl === pathToFileURL(path.resolve(argv[1])).href
  );
}
if (isSourceReaderEntry(process.argv, import.meta.url))
  main().catch(() => {
    process.stderr.write('SOURCE_READER_FAILED\n');
    process.exitCode = 1;
  });
