import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RestoreFile {
  root: 'browser' | 'shared';
  path: string;
  kind: 'file';
  size: number;
  sha256: string;
  mode: number;
}
export interface PublicRestoreManifest {
  version: 1;
  target: string;
  provision: string;
  source: { vm: string; imageFingerprint: string };
  files: RestoreFile[];
}
export interface RestoreReceipt {
  phase: 'complete';
  files: number;
  bytes: number;
  browserFiles: number;
  sharedFiles: number;
  manifestHash: string;
}
export interface RestoreWorkerOptions {
  archive: string;
  archiveHash: string;
  manifestHash: string;
  target: string;
  provision: string;
  root?: string;
  owner?: { uid: number; gid: number };
}
interface Journal extends Omit<RestoreReceipt, 'phase'> {
  version: 1;
  target: string;
  provision: string;
  phase: 'staging' | 'verified' | 'complete';
  published: { browser: boolean; shared: boolean };
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((name) => names.includes(name));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export function publicPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes('\\') &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)
  );
}
export function publicManifest(value: unknown): PublicRestoreManifest {
  if (
    !object(value) ||
    !fields(value, ['version', 'target', 'provision', 'source', 'files']) ||
    value.version !== 1 ||
    !sha(value.target) ||
    !sha(value.provision) ||
    !object(value.source) ||
    !fields(value.source, ['vm', 'imageFingerprint']) ||
    typeof value.source.vm !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.source.vm) ||
    !sha(value.source.imageFingerprint) ||
    !Array.isArray(value.files) ||
    value.files.length > 200000
  )
    throw new Error('MIGRATION_INVALID_MANIFEST');
  const seen = new Set<string>();
  let total = 0;
  const files = value.files
    .map((entry): RestoreFile => {
      if (
        !object(entry) ||
        !fields(entry, ['root', 'path', 'kind', 'size', 'sha256', 'mode']) ||
        !['browser', 'shared'].includes(String(entry.root)) ||
        entry.kind !== 'file' ||
        !publicPath(entry.path) ||
        !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0 ||
        Number(entry.size) > 512 * 1024 * 1024 ||
        !sha(entry.sha256) ||
        !Number.isSafeInteger(entry.mode) ||
        Number(entry.mode) < 0 ||
        Number(entry.mode) > 0o7777
      )
        throw new Error('MIGRATION_INVALID_MANIFEST');
      const name = `${entry.root}/${entry.path.normalize('NFC').toLowerCase()}`;
      if (seen.has(name)) throw new Error('MIGRATION_DUPLICATE_PATH');
      seen.add(name);
      total += Number(entry.size);
      return {
        root: entry.root as RestoreFile['root'],
        path: entry.path,
        kind: 'file',
        size: Number(entry.size),
        sha256: entry.sha256,
        mode: Number(entry.mode) & 0o777,
      };
    })
    .sort((a, b) =>
      `${a.root}/${a.path}` < `${b.root}/${b.path}`
        ? -1
        : `${a.root}/${a.path}` > `${b.root}/${b.path}`
          ? 1
          : 0,
    );
  if (total > 16 * 1024 ** 3) throw new Error('MIGRATION_LIMIT');
  for (const file of files) {
    const parts = `${file.root}/${file.path.normalize('NFC').toLowerCase()}`.split('/');
    for (let index = 1; index < parts.length; index++)
      if (seen.has(parts.slice(0, index).join('/'))) throw new Error('MIGRATION_DUPLICATE_PATH');
  }
  return {
    version: 1,
    target: value.target,
    provision: value.provision,
    source: { vm: value.source.vm, imageFingerprint: value.source.imageFingerprint },
    files,
  };
}
async function regular(file: string) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('MIGRATION_UNSAFE_PUBLIC');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function hashFile(file: string) {
  const { handle } = await regular(file);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 }))
      hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
async function metadata(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function directory(root: string, relative: string) {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!object(error) || error.code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MIGRATION_UNSAFE_PUBLIC');
    const inside = path.relative(root, await fs.realpath(current));
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
      throw new Error('MIGRATION_UNSAFE_PUBLIC');
  }
  return current;
}
async function syncDirectory(file: string) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function save(file: string, value: Journal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function receipt(value: Journal): RestoreReceipt {
  return {
    phase: 'complete',
    files: value.files,
    bytes: value.bytes,
    browserFiles: value.browserFiles,
    sharedFiles: value.sharedFiles,
    manifestHash: value.manifestHash,
  };
}
async function loadJournal(file: string) {
  if (!(await metadata(file))) return undefined;
  const { handle, info } = await regular(file);
  try {
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 4096)
      throw new Error('MIGRATION_UNSAFE_JOURNAL');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (
      !object(value) ||
      !fields(value, [
        'version',
        'target',
        'provision',
        'phase',
        'published',
        'manifestHash',
        'files',
        'bytes',
        'browserFiles',
        'sharedFiles',
      ]) ||
      value.version !== 1 ||
      !sha(value.target) ||
      !sha(value.provision) ||
      !sha(value.manifestHash) ||
      !['staging', 'verified', 'complete'].includes(String(value.phase)) ||
      !object(value.published) ||
      !fields(value.published, ['browser', 'shared']) ||
      typeof value.published.browser !== 'boolean' ||
      typeof value.published.shared !== 'boolean' ||
      !['files', 'bytes', 'browserFiles', 'sharedFiles'].every(
        (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
      )
    )
      throw new Error('MIGRATION_UNSAFE_JOURNAL');
    return value as unknown as Journal;
  } finally {
    await handle.close();
  }
}
async function exact(handle: FileHandle, position: number, size: number) {
  const bytes = Buffer.alloc(size);
  let copied = 0;
  while (copied < size) {
    const result = await handle.read(bytes, copied, size - copied, position + copied);
    if (!result.bytesRead) throw new Error('MIGRATION_INTEGRITY_FAILED');
    copied += result.bytesRead;
  }
  return bytes;
}
function octal(bytes: Buffer) {
  const text = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
  return number;
}
function text(bytes: Buffer) {
  return bytes
    .subarray(0, bytes.indexOf(0) === -1 ? bytes.length : bytes.indexOf(0))
    .toString('utf8');
}
function pax(bytes: Buffer) {
  let offset = 0,
    file: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (space === -1 || !/^[1-9]\d*$/.test(lengthText)) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
    const length = Number(lengthText),
      end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 10)
      throw new Error('MIGRATION_UNSAFE_ARCHIVE');
    const record = bytes.subarray(space + 1, end - 1).toString('utf8');
    if (!record.startsWith('path=') || file !== undefined)
      throw new Error('MIGRATION_UNSAFE_ARCHIVE');
    file = record.slice(5);
    offset = end;
  }
  if (!file) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
  return file;
}
interface TarFile {
  name: string;
  size: number;
  position: number;
}
async function* tar(handle: FileHandle, length: number): AsyncIterable<TarFile> {
  let offset = 0,
    extended: string | undefined;
  while (offset + 512 <= length) {
    const header = await exact(handle, offset, 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      for (let position = offset; position < length; position += 65536)
        if (
          !(await exact(handle, position, Math.min(65536, length - position))).every(
            (byte) => byte === 0,
          )
        )
          throw new Error('MIGRATION_UNSAFE_ARCHIVE');
      return;
    }
    const expected = octal(header.subarray(148, 156));
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (expected !== checksum || text(header.subarray(257, 263)) !== 'ustar')
      throw new Error('MIGRATION_UNSAFE_ARCHIVE');
    const size = octal(header.subarray(124, 136));
    const kind = String.fromCharCode(header[156] || 48);
    const prefix = text(header.subarray(345, 500));
    const name =
      extended ??
      (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    const next = offset + Math.ceil(size / 512) * 512;
    if (next > length || !Number.isSafeInteger(next)) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
    if (kind === 'x') {
      if (extended !== undefined || size > 65536) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
      extended = pax(await exact(handle, offset, size));
    } else {
      if (kind !== '0' || !publicPath(name) || text(header.subarray(157, 257)))
        throw new Error('MIGRATION_UNSAFE_ARCHIVE');
      extended = undefined;
      yield { name, size, position: offset };
    }
    offset = next;
  }
  throw new Error('MIGRATION_UNSAFE_ARCHIVE');
}
async function verifyTree(root: string, files: RestoreFile[], scope: RestoreFile['root']) {
  const info = await metadata(root);
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error('MIGRATION_DESTINATION_CHANGED');
  const expected = new Map(
    files.filter((file) => file.root === scope).map((file) => [file.path, file]),
  );
  let count = 0;
  const walk = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const relative = path.relative(root, file).split(path.sep).join('/');
        const wanted = expected.get(relative),
          actual = await fs.lstat(file);
        if (
          !entry.isFile() ||
          !wanted ||
          actual.nlink !== 1 ||
          actual.size !== wanted.size ||
          (await hashFile(file)) !== wanted.sha256
        )
          throw new Error('MIGRATION_DESTINATION_CHANGED');
        count++;
      }
    }
  };
  await walk(root);
  if (count !== expected.size) throw new Error('MIGRATION_DESTINATION_CHANGED');
}
async function account(): Promise<{ uid: number; gid: number }> {
  const id = (flag: string) =>
    new Promise<number>((done, reject) => {
      execFile(
        '/usr/bin/id',
        [flag, 'bot-prototype'],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 },
        (error, output) => {
          if (error || !/^\d+\s*$/.test(output)) reject(new Error('MIGRATION_RESTORE_ACCOUNT'));
          else done(Number(output.trim()));
        },
      );
    });
  return { uid: await id('-u'), gid: await id('-g') };
}
async function perform(options: RestoreWorkerOptions): Promise<RestoreReceipt> {
  if (
    !sha(options.archiveHash) ||
    !sha(options.manifestHash) ||
    !sha(options.target) ||
    !sha(options.provision) ||
    !path.isAbsolute(options.archive) ||
    (!options.root && process.getuid?.() !== 0)
  )
    throw new Error('MIGRATION_INVALID_TARGET');
  const root = await fs.realpath(options.root ?? '/');
  const markerRoot = await directory(root, 'var/lib/daban-executor');
  if ((await hashFile(path.join(markerRoot, 'provision.json'))) !== options.provision)
    throw new Error('MIGRATION_TARGET_CHANGED');
  const marker = path.join(markerRoot, 'public-import.json');
  let journal = await loadJournal(marker);
  if (journal && (journal.target !== options.target || journal.provision !== options.provision))
    throw new Error('MIGRATION_TARGET_CHANGED');
  if (journal && journal.manifestHash !== options.manifestHash)
    throw new Error('MIGRATION_MANIFEST_CHANGED');
  // A completed receipt owns the import, not the files: later browser and user edits must survive every replay.
  if (journal?.phase === 'complete') return receipt(journal);
  const { handle, info } = await regular(options.archive);
  try {
    if (
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await hashFile(options.archive)) !== options.archiveHash
    )
      throw new Error('MIGRATION_INTEGRITY_FAILED');
    let manifest: PublicRestoreManifest | undefined;
    let expected = new Map<string, RestoreFile>();
    const stage = path.join(markerRoot, `.public-import-${options.manifestHash.slice(0, 24)}`);
    const staged = await metadata(stage);
    if (!journal) {
      if (staged) throw new Error('MIGRATION_UNOWNED_STAGING');
    } else if (journal.phase === 'staging' && staged) {
      if (!staged.isDirectory() || staged.isSymbolicLink() || staged.uid !== process.getuid?.())
        throw new Error('MIGRATION_UNSAFE_PUBLIC');
      await fs.rm(stage, { recursive: true });
    }
    const seen = new Set<string>();
    for await (const item of tar(handle, info.size)) {
      if (!manifest) {
        if (item.name !== 'public.json' || item.size > 64 * 1024 * 1024)
          throw new Error('MIGRATION_UNSAFE_ARCHIVE');
        const bytes = await exact(handle, item.position, item.size);
        if (digest(bytes) !== options.manifestHash) throw new Error('MIGRATION_MANIFEST_CHANGED');
        manifest = publicManifest(JSON.parse(bytes.toString('utf8')));
        expected = new Map(manifest.files.map((file) => [`${file.root}/${file.path}`, file]));
        if (manifest.target !== options.target || manifest.provision !== options.provision)
          throw new Error('MIGRATION_TARGET_CHANGED');
        if (!journal) {
          journal = {
            version: 1,
            target: options.target,
            provision: options.provision,
            manifestHash: options.manifestHash,
            phase: 'staging',
            published: { browser: false, shared: false },
            files: manifest.files.length,
            bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
            browserFiles: manifest.files.filter((file) => file.root === 'browser').length,
            sharedFiles: manifest.files.filter((file) => file.root === 'shared').length,
          };
          await save(marker, journal);
        }
        if (journal.phase === 'staging') {
          await directory(root, path.relative(root, stage));
          await directory(stage, 'browser');
          await directory(stage, 'shared');
        }
        continue;
      }
      const file = expected.get(item.name);
      if (!file || seen.has(item.name)) throw new Error('MIGRATION_UNSAFE_ARCHIVE');
      seen.add(item.name);
      if (item.size !== file.size) throw new Error('MIGRATION_INTEGRITY_FAILED');
      let output: FileHandle | undefined;
      if (journal?.phase === 'staging') {
        const parent = await directory(stage, path.posix.dirname(item.name));
        const destination = path.join(parent, path.posix.basename(item.name));
        output = await fs.open(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      }
      const hash = createHash('sha256');
      try {
        for (let offset = 0; offset < item.size; offset += 65536) {
          const bytes = await exact(
            handle,
            item.position + offset,
            Math.min(65536, item.size - offset),
          );
          hash.update(bytes);
          await output?.writeFile(bytes);
        }
        if (hash.digest('hex') !== file.sha256) throw new Error('MIGRATION_INTEGRITY_FAILED');
        await output?.sync();
      } finally {
        await output?.close();
      }
    }
    if (!manifest || !journal || seen.size !== manifest.files.length)
      throw new Error('MIGRATION_INTEGRITY_FAILED');
    const owner = options.owner ?? (await account());
    if (
      !Number.isSafeInteger(owner.uid) ||
      owner.uid < 0 ||
      !Number.isSafeInteger(owner.gid) ||
      owner.gid < 0
    )
      throw new Error('MIGRATION_RESTORE_ACCOUNT');
    if (journal.phase === 'staging') {
      await verifyTree(path.join(stage, 'browser'), manifest.files, 'browser');
      await verifyTree(path.join(stage, 'shared'), manifest.files, 'shared');
      for (const file of manifest.files) {
        const name = path.join(stage, file.root, file.path);
        await fs.chown(name, owner.uid, owner.gid);
        await fs.chmod(name, file.mode & 0o777);
      }
      const directories = async (current: string) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true }))
          if (entry.isDirectory()) await directories(path.join(current, entry.name));
        await fs.chown(current, owner.uid, owner.gid);
        await fs.chmod(current, 0o700);
        await syncDirectory(current);
      };
      await directories(path.join(stage, 'browser'));
      await directories(path.join(stage, 'shared'));
      journal.phase = 'verified';
      await save(marker, journal);
    }
    // The service account must be able to traverse its data parents, not only the restored leaf roots.
    for (const relative of ['var/lib/bot-prototype', 'var/lib/bot-prototype/desktops']) {
      const parent = await directory(root, relative);
      await fs.chown(parent, owner.uid, owner.gid);
      await fs.chmod(parent, 0o700);
    }
    for (const scope of ['browser', 'shared'] as const) {
      const relative =
        scope === 'browser'
          ? 'var/lib/bot-prototype/profile'
          : 'var/lib/bot-prototype/desktops/shared';
      const parent = await directory(root, path.posix.dirname(relative));
      const destination = path.join(parent, path.posix.basename(relative));
      const from = path.join(stage, scope),
        source = await metadata(from),
        existing = await metadata(destination);
      if (journal.published[scope] || !source) {
        await verifyTree(destination, manifest.files, scope);
      } else {
        await verifyTree(from, manifest.files, scope);
        if (
          existing &&
          (!existing.isDirectory() ||
            existing.isSymbolicLink() ||
            (await fs.readdir(destination)).length)
        )
          throw new Error('MIGRATION_DESTINATION_EXISTS');
        await fs.rename(from, destination);
        await syncDirectory(parent);
      }
      journal.published[scope] = true;
      await save(marker, journal);
    }
    journal.phase = 'complete';
    await save(marker, journal);
    await fs.rm(stage, { recursive: true, force: true });
    return receipt(journal);
  } finally {
    await handle.close();
  }
}
export async function restoreWorker(options: RestoreWorkerOptions) {
  try {
    return await perform(options);
  } catch (error) {
    if (error instanceof Error && /^MIGRATION_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('MIGRATION_RESTORE_FAILED');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1] || '';
  if (
    process.getuid?.() !== 0 ||
    args.length !== 10 ||
    !args.every(
      (arg, index) =>
        index % 2 ||
        ['--archive', '--archive-hash', '--manifest-hash', '--target', '--provision'].includes(arg),
    )
  ) {
    process.stderr.write('MIGRATION_INVALID_TARGET\n');
    process.exitCode = 1;
  } else
    restoreWorker({
      archive: value('--archive'),
      archiveHash: value('--archive-hash'),
      manifestHash: value('--manifest-hash'),
      target: value('--target'),
      provision: value('--provision'),
    })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(() => {
        process.stderr.write('MIGRATION_RESTORE_FAILED\n');
        process.exitCode = 1;
      });
}
