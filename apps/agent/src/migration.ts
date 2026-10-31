import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export interface MigrationIdentity {
  vm: string;
  imageFingerprint: string;
}
export interface MigrationFile {
  path: string;
  kind: 'file';
  size: number;
  sha256: string;
  mode?: number;
}
export interface MigrationManifest {
  source: MigrationIdentity;
  files: MigrationFile[];
}
export interface ControlDataPort {
  manifest(): Promise<MigrationManifest>;
  read(path: string): AsyncIterable<Uint8Array>;
}
export interface MigrationOptions {
  directory: string;
  journal: string;
  expected: { source: MigrationIdentity; target: MigrationIdentity };
  source: ControlDataPort;
}
export interface MigrationReceipt {
  phase: 'published';
  files: number;
  bytes: number;
  manifestHash: string;
}
type Scope = 'control' | 'browser' | 'shared';
interface Journal {
  version: 1;
  scope: Scope;
  expected: MigrationOptions['expected'];
  directory: string;
  stage: string;
  manifestHash: string;
  files: MigrationFile[];
  phase: 'staging' | 'verified' | 'published';
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fault = (code: string) => Object.assign(new Error(code), { code });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const owner = (uid: number) => process.getuid?.() === uid;
const inside = (root: string, file: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);
function identity(value: unknown): value is MigrationIdentity {
  return (
    object(value) &&
    keys(value, ['vm', 'imageFingerprint']) &&
    typeof value.vm === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.vm) &&
    typeof value.imageFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.imageFingerprint)
  );
}
const sameIdentity = (left: MigrationIdentity, right: MigrationIdentity) =>
  left.vm === right.vm && left.imageFingerprint === right.imageFingerprint;
function relative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes('\\') &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    value
      .split('/')
      .every((part) => !!part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)
  );
}
function controlFile(file: string) {
  if (file === 'credentials.json' || file === 'network.json') return true;
  if (/^[a-z][a-z0-9-]{0,60}\.sqlite(?:-wal|-shm)?$/.test(file)) return true;
  return (
    /^(?:bots|task-journal|interactions)\/[a-zA-Z0-9_-]{1,80}\.json$/.test(file) ||
    /^bundles\/[a-zA-Z0-9_-]{1,80}\.(?:json|bundle)$/.test(file)
  );
}
export function isControlDataPath(value: unknown): value is string {
  return relative(value) && controlFile(value);
}
function files(value: unknown, scope: Scope): MigrationFile[] {
  if (
    !Array.isArray(value) ||
    value.length > 100000 ||
    Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024
  )
    throw fault('MIGRATION_INVALID_MANIFEST');
  const seen = new Set<string>();
  let total = 0;
  const result = value
    .map((entry) => {
      if (
        !object(entry) ||
        !keys(entry, ['path', 'kind', 'size', 'sha256', 'mode']) ||
        entry.kind !== 'file' ||
        !relative(entry.path) ||
        (scope === 'control' && !isControlDataPath(entry.path)) ||
        !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0 ||
        Number(entry.size) > 512 * 1024 * 1024 ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (entry.mode !== undefined &&
          (!Number.isSafeInteger(entry.mode) ||
            Number(entry.mode) < 0 ||
            Number(entry.mode) > 0o7777))
      )
        throw fault('MIGRATION_INVALID_MANIFEST');
      const normalized = entry.path.normalize('NFC').toLowerCase();
      if (seen.has(normalized)) throw fault('MIGRATION_DUPLICATE_PATH');
      seen.add(normalized);
      total += Number(entry.size);
      return {
        path: entry.path,
        kind: 'file' as const,
        size: Number(entry.size),
        sha256: entry.sha256,
        ...(entry.mode === undefined ? {} : { mode: Number(entry.mode) }),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (total > 8 * 1024 * 1024 * 1024) throw fault('MIGRATION_LIMIT');
  for (const file of result) {
    const parts = file.path.normalize('NFC').toLowerCase().split('/');
    for (let count = 1; count < parts.length; count++)
      if (seen.has(parts.slice(0, count).join('/'))) throw fault('MIGRATION_DUPLICATE_PATH');
    if (
      scope === 'control' &&
      /\.sqlite-(?:wal|shm)$/.test(file.path) &&
      !seen.has(file.path.replace(/-(?:wal|shm)$/, '').toLowerCase())
    )
      throw fault('MIGRATION_INCOMPLETE_SQLITE');
  }
  return result;
}
async function metadata(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !owner(info.uid) ||
    (info.mode & 0o777) !== 0o700
  )
    throw fault('MIGRATION_UNSAFE_DIRECTORY');
  return realpath(directory);
}
async function parentDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !owner(info.uid) || (info.mode & 0o022) !== 0)
    throw fault('MIGRATION_UNSAFE_DIRECTORY');
  return realpath(directory);
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncTree(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await syncTree(path.join(directory, entry.name));
  await syncDirectory(directory);
}
async function journalAt(file: string): Promise<unknown> {
  const info = await metadata(file);
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !owner(info.uid) ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 32 * 1024 * 1024
  )
    throw fault('MIGRATION_UNSAFE_JOURNAL');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw fault('MIGRATION_CORRUPT_JOURNAL');
  }
}
async function commit(file: string, value: Journal) {
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
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
function fingerprint(
  scope: Scope,
  expected: MigrationOptions['expected'],
  entries: MigrationFile[],
) {
  return hash(
    JSON.stringify({
      scope,
      source: { vm: expected.source.vm, imageFingerprint: expected.source.imageFingerprint },
      target: { vm: expected.target.vm, imageFingerprint: expected.target.imageFingerprint },
      files: entries,
    }),
  );
}
function receipt(journal: Journal): MigrationReceipt {
  return {
    phase: 'published',
    files: journal.files.length,
    bytes: journal.files.reduce((total, file) => total + file.size, 0),
    manifestHash: journal.manifestHash,
  };
}
async function matches(root: string, entry: MigrationFile) {
  const file = path.join(root, entry.path);
  const info = await metadata(file);
  if (!info) return false;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !owner(info.uid) ||
    !inside(root, await realpath(file))
  )
    throw fault('MIGRATION_UNSAFE_FILE');
  if (info.size !== entry.size || (info.mode & 0o777) !== 0o600) return false;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      !opened.isFile() ||
      opened.nlink !== 1
    )
      throw fault('MIGRATION_FILE_CHANGED');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    }))
      digest.update(chunk);
    return digest.digest('hex') === entry.sha256;
  } finally {
    await handle.close();
  }
}
async function verifyTree(directory: string, entries: MigrationFile[]) {
  const root = await privateDirectory(directory);
  const expected = new Set(entries.map((entry) => entry.path));
  const actual = new Set<string>();
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await privateDirectory(file);
        await walk(file);
      } else if (entry.isFile()) actual.add(path.relative(root, file).split(path.sep).join('/'));
      else throw fault('MIGRATION_UNSAFE_FILE');
    }
  }
  await walk(root);
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file)))
    return false;
  for (const entry of entries) if (!(await matches(root, entry))) return false;
  return true;
}
async function parentFor(root: string, relativeFile: string) {
  let parent = root;
  for (const part of relativeFile.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (!object(error) || error.code !== 'EEXIST') throw error;
    }
    const canonical = await privateDirectory(parent);
    if (!inside(root, canonical)) throw fault('MIGRATION_UNSAFE_DIRECTORY');
  }
  return parent;
}
async function stageFile(root: string, entry: MigrationFile, source: ControlDataPort) {
  await parentFor(root, entry.path);
  if (await matches(root, entry)) return;
  const destination = path.join(root, entry.path);
  const previous = await metadata(destination);
  if (previous) {
    if (
      !previous.isFile() ||
      previous.isSymbolicLink() ||
      previous.nlink !== 1 ||
      !owner(previous.uid)
    )
      throw fault('MIGRATION_UNSAFE_FILE');
    // Only a journal-owned staging file may be replaced after an interrupted copy.
    await unlink(destination);
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of source.read(entry.path)) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 * 1024)
          throw fault('MIGRATION_INVALID_CHUNK');
        size += chunk.byteLength;
        if (size > entry.size) throw fault('MIGRATION_SIZE_MISMATCH');
        await handle.writeFile(chunk);
        digest.update(chunk);
      }
    } catch (error) {
      if (object(error) && typeof error.code === 'string' && error.code.startsWith('MIGRATION_'))
        throw error;
      throw fault('MIGRATION_SOURCE_UNAVAILABLE');
    }
    if (size !== entry.size || digest.digest('hex') !== entry.sha256)
      throw fault('MIGRATION_INTEGRITY_FAILED');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
async function receive(options: MigrationOptions, scope: Scope): Promise<MigrationReceipt> {
  if (
    !identity(options.expected?.source) ||
    !identity(options.expected?.target) ||
    !path.isAbsolute(options.directory) ||
    !path.isAbsolute(options.journal) ||
    path.dirname(options.directory) === options.directory
  )
    throw fault('MIGRATION_INVALID_TARGET');
  const parent = await parentDirectory(path.dirname(options.directory));
  const directory = path.join(parent, path.basename(options.directory));
  const journalParent = await parentDirectory(path.dirname(options.journal));
  const journalFile = path.join(journalParent, path.basename(options.journal));
  if (inside(directory, journalFile)) throw fault('MIGRATION_INVALID_TARGET');
  let journal: Journal;
  const saved = await journalAt(journalFile);
  if (saved !== undefined) {
    if (
      !object(saved) ||
      saved.version !== 1 ||
      saved.scope !== scope ||
      saved.directory !== directory ||
      !object(saved.expected) ||
      !identity(saved.expected.source) ||
      !identity(saved.expected.target) ||
      !sameIdentity(saved.expected.source, options.expected.source) ||
      !sameIdentity(saved.expected.target, options.expected.target) ||
      !['staging', 'verified', 'published'].includes(String(saved.phase))
    )
      throw fault('MIGRATION_TARGET_CHANGED');
    const entries = files(saved.files, scope);
    const manifestHash = fingerprint(scope, options.expected, entries);
    const stage = path.join(
      parent,
      `.${path.basename(directory)}-migration-${manifestHash.slice(0, 24)}`,
    );
    if (saved.manifestHash !== manifestHash || saved.stage !== stage)
      throw fault('MIGRATION_CORRUPT_JOURNAL');
    journal = {
      version: 1,
      scope,
      expected: options.expected,
      directory,
      stage,
      manifestHash,
      files: entries,
      phase: saved.phase as Journal['phase'],
    };
    if (journal.phase === 'published') {
      await privateDirectory(directory);
      return receipt(journal);
    }
    if (await metadata(directory)) {
      if (!(await verifyTree(directory, entries))) throw fault('MIGRATION_DESTINATION_EXISTS');
      journal.phase = 'published';
      await commit(journalFile, journal);
      return receipt(journal);
    }
    if (journal.phase === 'verified') {
      if (!(await metadata(stage)) || !(await verifyTree(stage, entries)))
        throw fault('MIGRATION_PUBLICATION_UNKNOWN');
      await rename(stage, directory);
      await syncDirectory(parent);
      journal.phase = 'published';
      await commit(journalFile, journal);
      return receipt(journal);
    }
  } else {
    let manifest: MigrationManifest;
    try {
      manifest = await options.source.manifest();
    } catch {
      throw fault('MIGRATION_SOURCE_UNAVAILABLE');
    }
    if (
      !object(manifest) ||
      !keys(manifest, ['source', 'files']) ||
      !identity(manifest.source) ||
      !sameIdentity(manifest.source, options.expected.source)
    )
      throw fault('MIGRATION_SOURCE_CHANGED');
    const entries = files(manifest.files, scope);
    const manifestHash = fingerprint(scope, options.expected, entries);
    journal = {
      version: 1,
      scope,
      expected: options.expected,
      directory,
      stage: path.join(
        parent,
        `.${path.basename(directory)}-migration-${manifestHash.slice(0, 24)}`,
      ),
      manifestHash,
      files: entries,
      phase: 'staging',
    };
    if (await metadata(directory)) {
      if (!(await verifyTree(directory, entries))) throw fault('MIGRATION_DESTINATION_EXISTS');
      journal.phase = 'published';
      await commit(journalFile, journal);
      return receipt(journal);
    }
    if (await metadata(journal.stage)) throw fault('MIGRATION_UNOWNED_STAGING');
    await commit(journalFile, journal);
  }
  if (saved !== undefined) {
    let manifest: MigrationManifest;
    try {
      manifest = await options.source.manifest();
    } catch {
      throw fault('MIGRATION_SOURCE_UNAVAILABLE');
    }
    if (
      !object(manifest) ||
      !keys(manifest, ['source', 'files']) ||
      !identity(manifest.source) ||
      !sameIdentity(manifest.source, options.expected.source) ||
      fingerprint(scope, options.expected, files(manifest.files, scope)) !== journal.manifestHash
    )
      throw fault('MIGRATION_SOURCE_CHANGED');
  }
  const stage = await privateDirectory(journal.stage, true);
  for (const entry of journal.files) await stageFile(stage, entry, options.source);
  if (!(await verifyTree(stage, journal.files))) throw fault('MIGRATION_INTEGRITY_FAILED');
  await syncTree(stage);
  await syncDirectory(parent);
  // Persist verified bytes before rename; recovery can inspect either side without replaying source actions.
  journal.phase = 'verified';
  await commit(journalFile, journal);
  if (await metadata(directory)) throw fault('MIGRATION_DESTINATION_EXISTS');
  await rename(stage, directory);
  await syncDirectory(parent);
  journal.phase = 'published';
  await commit(journalFile, journal);
  return receipt(journal);
}
export function migrateControlData(options: MigrationOptions) {
  return receive(options, 'control');
}
export function migratePublicData(options: MigrationOptions & { root: 'browser' | 'shared' }) {
  if (!['browser', 'shared'].includes(options.root))
    return Promise.reject(fault('MIGRATION_INVALID_PUBLIC_ROOT'));
  return receive(
    { ...options, directory: path.join(options.directory, options.root) },
    options.root,
  );
}
