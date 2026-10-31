import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MigrationManifest } from './migration.js';
import {
  type PublicRestoreManifest,
  publicManifest,
  type RestoreFile,
  type RestoreReceipt,
} from './restore-worker.js';
import type { VmConfig } from './vm.js';

export async function scanPublicSecrets(chunks: AsyncIterable<Uint8Array>, key: string) {
  if (!key || Buffer.byteLength(key) > 16384) throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
  const patterns = [Buffer.from(key, 'utf8'), Buffer.from(key, 'utf16le')];
  const retained = Math.max(...patterns.map((pattern) => pattern.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const chunk of chunks) {
    if (
      !ArrayBuffer.isView(chunk) ||
      Object.prototype.toString.call(chunk) !== '[object Uint8Array]'
    )
      throw new Error('MIGRATION_INVALID_CHUNK');
    for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
      const window = Buffer.concat([tail, chunk.subarray(offset, offset + 65536)]);
      if (patterns.some((pattern) => window.includes(pattern)))
        throw new Error('MIGRATION_SECRET_IN_PUBLIC');
      // Encoded keys can straddle arbitrary file-stream chunks, including a split UTF-16 code unit.
      tail = window.subarray(Math.max(0, window.length - retained));
    }
  }
}

export interface RestoreOptions {
  config: VmConfig;
  directory: string;
  browser: MigrationManifest;
  shared: MigrationManifest;
  credentialFile?: string;
  helperEntry: string;
  cacheDirectory: string;
}
interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
export interface RestoreDependencies {
  run?: (
    program: string,
    args: string[],
    options: RunOptions,
  ) => Promise<{ code: number; stdout: string }>;
}
interface Journal {
  version: 1;
  target: string;
  provision: string;
  manifestHash: string;
  phase: 'staging' | 'prepared' | 'complete';
  archiveHash?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const execute = (program: string, args: string[], options: RunOptions) =>
  new Promise<{ code: number; stdout: string }>((done, reject) => {
    execFile(program, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('MIGRATION_TRANSPORT_FAILED'));
      else done({ code: error ? Number(error.code) : 0, stdout });
    });
  });
async function metadata(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function privateDirectory(file: string, create = false) {
  if (create) await fs.mkdir(file, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('MIGRATION_UNSAFE_PUBLIC');
  return fs.realpath(file);
}
async function regular(file: string, privateFile = true) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (privateFile && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) ||
      (!privateFile && (info.mode & 0o022) !== 0)
    )
      throw new Error('MIGRATION_UNSAFE_PUBLIC');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function* fileChunks(file: string, expected?: RestoreFile) {
  const { handle, info } = await regular(file);
  try {
    if (expected && info.size !== expected.size) throw new Error('MIGRATION_INTEGRITY_FAILED');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      hash.update(bytes);
      yield bytes;
    }
    const actual = hash.digest('hex');
    if (expected && (size !== expected.size || actual !== expected.sha256))
      throw new Error('MIGRATION_INTEGRITY_FAILED');
  } finally {
    await handle.close();
  }
}
async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fileChunks(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function keyAt(file?: string) {
  if (!file) return undefined;
  try {
    const { handle, info } = await regular(file);
    try {
      if (info.size > 65536) throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (
        !object(value) ||
        typeof value.apiKey !== 'string' ||
        !/^[!-~]{10,512}$/.test(value.apiKey)
      )
        throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
      return value.apiKey;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
  }
}
function manifestFor(options: RestoreOptions, target: string, provision: string) {
  const entries: RestoreFile[] = [];
  for (const root of ['browser', 'shared'] as const) {
    const manifest = options[root];
    if (
      !object(manifest) ||
      Object.keys(manifest).some((key) => !['source', 'files'].includes(key)) ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 100000 ||
      !object(manifest.source) ||
      Object.keys(manifest.source).some((key) => !['vm', 'imageFingerprint'].includes(key)) ||
      manifest.source.vm !== options.browser.source.vm ||
      manifest.source.imageFingerprint !== options.browser.source.imageFingerprint
    )
      throw new Error('MIGRATION_INVALID_MANIFEST');
    for (const file of manifest.files) {
      if (
        !object(file) ||
        Object.keys(file).some((key) => !['path', 'kind', 'size', 'sha256', 'mode'].includes(key))
      )
        throw new Error('MIGRATION_INVALID_MANIFEST');
      entries.push({
        root,
        path: file.path as string,
        kind: file.kind as 'file',
        size: file.size as number,
        sha256: file.sha256 as string,
        mode: file.mode === undefined ? 0o600 : (file.mode as number),
      });
    }
  }
  return publicManifest({
    version: 1,
    target,
    provision,
    source: options.browser.source,
    files: entries,
  });
}
async function verifyPublic(directory: string, manifest: PublicRestoreManifest, key?: string) {
  await privateDirectory(directory);
  for (const root of ['browser', 'shared'] as const) {
    const base = await privateDirectory(path.join(directory, root));
    const expected = new Map(
      manifest.files.filter((file) => file.root === root).map((file) => [file.path, file]),
    );
    let count = 0;
    const walk = async (current: string) => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await privateDirectory(file);
          await walk(file);
        } else {
          const relative = path.relative(base, file).split(path.sep).join('/'),
            wanted = expected.get(relative);
          if (!entry.isFile() || !wanted) throw new Error('MIGRATION_UNSAFE_PUBLIC');
          const chunks = fileChunks(file, wanted);
          if (key) await scanPublicSecrets(chunks, key);
          else
            for await (const _chunk of chunks) {
              /* Integrity is checked by the iterator. */
            }
          count++;
        }
      }
    };
    await walk(base);
    if (count !== expected.size) throw new Error('MIGRATION_INTEGRITY_FAILED');
  }
  if (key) {
    const bytes = Buffer.from(JSON.stringify(manifest));
    await scanPublicSecrets(
      (async function* () {
        yield bytes;
      })(),
      key,
    );
    for (const file of manifest.files)
      await scanPublicSecrets(
        (async function* () {
          yield Buffer.from(file.path);
        })(),
        key,
      );
  }
}
function header(name: string, size: number, type = '0') {
  if (Buffer.byteLength(name) > 100) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100);
  for (const [offset, length, number] of [
    [100, 8, 0o600],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, size],
    [136, 12, 0],
  ])
    bytes.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  bytes.fill(32, 148, 156);
  bytes.write(type, 156, 1);
  bytes.write('ustar\0', 257, 6);
  bytes.write('00', 263, 2);
  bytes.write(
    `${bytes
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  );
  return bytes;
}
function paxPath(name: string) {
  const body = `path=${name}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const record = `${length} ${body}`,
      actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}
async function archiveAt(directory: string, file: string, manifest: PublicRestoreManifest) {
  const temporary = `${file}.${randomUUID()}.tmp`,
    output = await fs.open(temporary, 'wx', 0o600);
  const padding = async (size: number) => {
    const length = (512 - (size % 512)) % 512;
    if (length) await output.writeFile(Buffer.alloc(length));
  };
  try {
    const metadata = Buffer.from(JSON.stringify(manifest));
    await output.writeFile(header('public.json', metadata.length));
    await output.writeFile(metadata);
    await padding(metadata.length);
    for (const [index, entry] of manifest.files.entries()) {
      const name = `${entry.root}/${entry.path}`;
      if (Buffer.byteLength(name) > 100) {
        const extended = paxPath(name);
        await output.writeFile(header(`PaxHeaders/${index}`, extended.length, 'x'));
        await output.writeFile(extended);
        await padding(extended.length);
      }
      await output.writeFile(
        header(Buffer.byteLength(name) > 100 ? `entry-${index}` : name, entry.size),
      );
      for await (const chunk of fileChunks(path.join(directory, entry.root, entry.path), entry))
        await output.writeFile(chunk);
      await padding(entry.size);
    }
    await output.writeFile(Buffer.alloc(1024));
    await output.sync();
  } catch (error) {
    await output.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await fs.rename(temporary, file);
}
async function loadJournal(file: string) {
  if (!(await metadata(file))) return undefined;
  const { handle, info } = await regular(file);
  try {
    if (info.size > 4096) throw new Error('MIGRATION_UNSAFE_JOURNAL');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (
      !object(value) ||
      Object.keys(value).some(
        (key) =>
          !['version', 'target', 'provision', 'manifestHash', 'phase', 'archiveHash'].includes(key),
      ) ||
      value.version !== 1 ||
      !sha(value.target) ||
      !sha(value.provision) ||
      !sha(value.manifestHash) ||
      !['staging', 'prepared', 'complete'].includes(String(value.phase)) ||
      (value.archiveHash !== undefined && !sha(value.archiveHash))
    )
      throw new Error('MIGRATION_UNSAFE_JOURNAL');
    return value as unknown as Journal;
  } finally {
    await handle.close();
  }
}
async function saveJournal(file: string, value: Journal) {
  const temporary = `${file}.${randomUUID()}.tmp`,
    handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    const parent = await fs.open(
      path.dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function perform(
  options: RestoreOptions,
  dependencies: RestoreDependencies,
): Promise<RestoreReceipt> {
  const config = Object.freeze({ ...options.config });
  if (
    !config ||
    typeof config.vm !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.vm) ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    ![
      config.limactl,
      config.limaHome,
      options.directory,
      options.helperEntry,
      options.cacheDirectory,
      ...(options.credentialFile ? [options.credentialFile] : []),
    ].every(
      (value) => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value),
    ) ||
    path.basename(config.limactl) !== 'limactl' ||
    !options.helperEntry.endsWith('.mjs')
  )
    throw new Error('MIGRATION_INVALID_TARGET');
  const relative = path.relative(options.directory, options.cacheDirectory);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('MIGRATION_INVALID_TARGET');
  await privateDirectory(options.cacheDirectory, true);
  const journalFile = path.join(options.cacheDirectory, 'restore.json');
  let journal = await loadJournal(journalFile);
  const target = digest(
    JSON.stringify([
      path.resolve(config.limactl),
      path.resolve(config.limaHome),
      config.vm,
      config.port,
    ]),
  );
  if (journal && journal.target !== target) throw new Error('MIGRATION_TARGET_CHANGED');
  const run = async (args: string[], timeout = 1200000) => {
    try {
      const result = await (dependencies.run ?? execute)(config.limactl, args, {
        env: {
          PATH: `${path.dirname(config.limactl)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: homedir(),
          LANG: 'C',
          LIMA_HOME: config.limaHome,
        },
        timeout,
        maxBuffer: 65536,
      });
      if (result.code !== 0) throw new Error('MIGRATION_TRANSPORT_FAILED');
      return result.stdout;
    } catch {
      throw new Error('MIGRATION_TRANSPORT_FAILED');
    }
  };
  const provision = (
    await run([
      'shell',
      config.vm,
      'sudo',
      '-n',
      'sha256sum',
      '/var/lib/daban-executor/provision.json',
    ])
  )
    .trim()
    .split(/\s+/)[0];
  if (!sha(provision) || (journal && journal.provision !== provision))
    throw new Error('MIGRATION_TARGET_CHANGED');
  const manifest = manifestFor(options, target, provision),
    manifestHash = digest(JSON.stringify(manifest));
  const result: RestoreReceipt = {
    phase: 'complete',
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    browserFiles: manifest.files.filter((file) => file.root === 'browser').length,
    sharedFiles: manifest.files.filter((file) => file.root === 'shared').length,
    manifestHash,
  };
  if (journal && journal.manifestHash !== manifestHash)
    throw new Error('MIGRATION_MANIFEST_CHANGED');
  // Completed host receipts never republish frozen bytes over a guest's subsequent browser/user changes.
  if (journal?.phase === 'complete') return result;
  if (!journal) {
    journal = { version: 1, target, provision, manifestHash, phase: 'staging' };
    await saveJournal(journalFile, journal);
  }
  const key = await keyAt(options.credentialFile);
  const { handle: helperHandle, info: helperInfo } = await regular(options.helperEntry, false);
  let helper: Buffer;
  try {
    if (helperInfo.size > 16 * 1024 * 1024) throw new Error('MIGRATION_UNSAFE_HELPER');
    helper = await helperHandle.readFile();
  } finally {
    await helperHandle.close();
  }
  if (key)
    await scanPublicSecrets(
      (async function* () {
        yield helper;
      })(),
      key,
    );
  const helperHash = digest(helper),
    frozenHelper = path.join(options.cacheDirectory, `restore-worker-${helperHash}.mjs`);
  if (!(await metadata(frozenHelper)))
    await fs.writeFile(frozenHelper, helper, { mode: 0o600, flag: 'wx' });
  if ((await hashFile(frozenHelper)) !== helperHash) throw new Error('MIGRATION_CACHE_CHANGED');
  const archive = path.join(options.cacheDirectory, `public-${manifestHash}.tar`);
  if (journal.phase === 'staging') {
    await verifyPublic(options.directory, manifest, key);
    await archiveAt(options.directory, archive, manifest);
    journal.archiveHash = await hashFile(archive);
    if (key) await scanPublicSecrets(fileChunks(archive), key);
    journal.phase = 'prepared';
    await saveJournal(journalFile, journal);
  } else {
    if (!sha(journal.archiveHash) || (await hashFile(archive)) !== journal.archiveHash)
      throw new Error('MIGRATION_CACHE_CHANGED');
    if (key) await scanPublicSecrets(fileChunks(archive), key);
  }
  let remote: string | undefined;
  try {
    remote = (
      await run(['shell', config.vm, 'mktemp', '-d', '/tmp/daban-restore.XXXXXXXXXXXX'])
    ).trim();
    if (!/^\/tmp\/daban-restore\.[A-Za-z0-9]{10,32}$/.test(remote))
      throw new Error('MIGRATION_INVALID_TARGET');
    const remoteHelper = `${remote}/restore-worker.mjs`,
      remoteArchive = `${remote}/public.tar`;
    await run(['copy', frozenHelper, `${config.vm}:${remoteHelper}`]);
    await run(['copy', archive, `${config.vm}:${remoteArchive}`]);
    await run(['shell', config.vm, 'sudo', '-n', 'chown', '-R', 'root:root', remote]);
    await run(['shell', config.vm, 'sudo', '-n', 'chmod', '700', remote]);
    for (const file of [remoteHelper, remoteArchive])
      await run(['shell', config.vm, 'sudo', '-n', 'chmod', '600', file]);
    if (
      (await run(['shell', config.vm, 'sudo', '-n', 'sha256sum', remoteHelper]))
        .trim()
        .split(/\s+/)[0] !== helperHash
    )
      throw new Error('MIGRATION_HELPER_CHANGED');
    const output = await run([
      'shell',
      config.vm,
      'sudo',
      '-n',
      '/opt/bot-prototype/node/bin/node',
      remoteHelper,
      '--archive',
      remoteArchive,
      '--archive-hash',
      journal.archiveHash!,
      '--manifest-hash',
      manifestHash,
      '--target',
      target,
      '--provision',
      provision,
    ]);
    const received: unknown = JSON.parse(output);
    if (
      !object(received) ||
      Object.keys(received).length !== Object.keys(result).length ||
      Object.entries(result).some(([key, value]) => received[key] !== value)
    )
      throw new Error('MIGRATION_RESTORE_UNCONFIRMED');
    journal.phase = 'complete';
    await saveJournal(journalFile, journal);
    return result;
  } finally {
    if (remote && /^\/tmp\/daban-restore\.[A-Za-z0-9]{10,32}$/.test(remote))
      await run(['shell', config.vm, 'sudo', '-n', 'rm', '-rf', '--', remote], 30000).catch(
        () => {},
      );
  }
}
export async function restorePublicData(
  options: RestoreOptions,
  dependencies: RestoreDependencies = {},
) {
  try {
    return await perform(options, dependencies);
  } catch (error) {
    if (error instanceof Error && /^MIGRATION_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('MIGRATION_RESTORE_FAILED');
  }
}
