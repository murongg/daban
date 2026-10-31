import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isBundleRecord } from './bundles.js';
import { errorCode, Fault } from './control.js';

export interface BundleMigrationFile {
  path: string;
  size: number;
  sha256: string;
}
export interface BundleMigrationOptions {
  directory: string;
  manifestHash: string;
  files: BundleMigrationFile[];
  journalFile: string;
}
export interface BundleMigrationReceipt {
  phase: 'complete';
  files: number;
  manifestHash: string;
}
interface PayloadPlan extends BundleMigrationFile {
  dev: number;
  ino: number;
}
interface Plan {
  path: string;
  oldJsonSha: string;
  newJsonSha: string;
  json: string;
  payload: PayloadPlan;
}
interface Journal {
  version: 1;
  directory: string;
  dev: number;
  ino: number;
  manifestHash: string;
  filesHash: string;
  phase: 'planned' | 'complete';
  plans: Plan[];
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const recordPath = (value: string) => /^bundles\/[a-zA-Z0-9_-]{1,80}\.json$/.test(value);
const blobPath = (value: string) => /^bundles\/[a-zA-Z0-9_-]{1,80}\.bundle$/.test(value);
const active = new Map<string, { fingerprint: string; promise: Promise<BundleMigrationReceipt> }>();
function manifest(files: BundleMigrationFile[]) {
  if (!Array.isArray(files) || files.length > 100000)
    throw new Fault('BUNDLE_MIGRATION_INVALID_MANIFEST');
  const seen = new Set<string>();
  return files
    .map((file) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        file.path.length > 4096 ||
        file.path.includes('\\') ||
        file.path.includes('\0') ||
        file.path.startsWith('/') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !integer(file.size) ||
        file.size > 512 * 1024 * 1024 ||
        !sha(file.sha256) ||
        (file.path.startsWith('bundles/') && !recordPath(file.path) && !blobPath(file.path))
      )
        throw new Fault('BUNDLE_MIGRATION_INVALID_MANIFEST');
      const key = file.path.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new Fault('BUNDLE_MIGRATION_INVALID_MANIFEST');
      seen.add(key);
      return { path: file.path, size: file.size, sha256: file.sha256 };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Fault('BUNDLE_MIGRATION_UNSAFE_DIRECTORY');
  return { path: await realpath(directory), dev: info.dev, ino: info.ino };
}
async function read(file: string, limit: number, content = false) {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > limit
  )
    throw new Fault('BUNDLE_MIGRATION_UNSAFE_FILE');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.nlink !== 1 ||
      info.size !== before.size
    )
      throw new Fault('BUNDLE_MIGRATION_CHANGED');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    for await (const value of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      hash.update(value);
      if (content) chunks.push(Buffer.from(value));
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Fault('BUNDLE_MIGRATION_CHANGED');
    return {
      info,
      sha256: hash.digest('hex'),
      text: content ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : '',
    };
  } finally {
    await handle.close();
  }
}
async function sync(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeAtomic(file: string, text: string, beforeRename?: () => Promise<boolean>) {
  const temporary = `${file}.${randomUUID()}.rebind-tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (beforeRename && !(await beforeRename())) return;
    await rename(temporary, file);
    await sync(path.dirname(file));
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
}
function parseRecord(text: string, file: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Fault('BUNDLE_MIGRATION_INVALID_RECORD');
  }
  if (!isBundleRecord(value) || value.header.id !== path.basename(file, '.json'))
    throw new Fault('BUNDLE_MIGRATION_INVALID_RECORD');
  return value;
}
async function checkedFile(directory: string, file: BundleMigrationFile, text = false) {
  const value = await read(path.join(directory, file.path), text ? 16384 : 512 * 1024 * 1024, text);
  if (value.info.size !== file.size || value.sha256 !== file.sha256)
    throw new Fault('BUNDLE_MIGRATION_CHANGED');
  return value;
}
function validateJournal(
  value: unknown,
  directory: { path: string; dev: number; ino: number },
  manifestHash: string,
  filesHash: string,
  files: BundleMigrationFile[],
): Journal {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.directory !== directory.path ||
    value.dev !== directory.dev ||
    value.ino !== directory.ino ||
    value.manifestHash !== manifestHash ||
    value.filesHash !== filesHash ||
    !['planned', 'complete'].includes(String(value.phase)) ||
    !Array.isArray(value.plans) ||
    value.plans.length > 4096
  )
    throw new Fault('BUNDLE_MIGRATION_TARGET_CHANGED');
  const seen = new Set<string>();
  const index = new Map(files.map((file) => [file.path, file]));
  const plans: Plan[] = value.plans.map((plan) => {
    if (
      !object(plan) ||
      typeof plan.path !== 'string' ||
      !recordPath(plan.path) ||
      seen.has(plan.path) ||
      !sha(plan.oldJsonSha) ||
      !sha(plan.newJsonSha) ||
      typeof plan.json !== 'string' ||
      Buffer.byteLength(plan.json) > 16384 ||
      digest(plan.json) !== plan.newJsonSha ||
      !object(plan.payload) ||
      plan.payload.path !== plan.path.replace(/\.json$/, '.bundle') ||
      !integer(plan.payload.dev) ||
      !integer(plan.payload.ino)
    )
      throw new Fault('BUNDLE_MIGRATION_CORRUPT_JOURNAL');
    const source = index.get(plan.path);
    const payloadPath = plan.payload.path;
    const payload = typeof payloadPath === 'string' ? index.get(payloadPath) : undefined;
    if (
      !source ||
      source.sha256 !== plan.oldJsonSha ||
      !payload ||
      plan.payload.size !== payload.size ||
      plan.payload.sha256 !== payload.sha256
    )
      throw new Fault('BUNDLE_MIGRATION_CORRUPT_JOURNAL');
    const record = parseRecord(plan.json, plan.path);
    if (
      !record.payload ||
      record.payload.dev !== plan.payload.dev ||
      record.payload.ino !== plan.payload.ino
    )
      throw new Fault('BUNDLE_MIGRATION_CORRUPT_JOURNAL');
    seen.add(plan.path);
    return {
      path: plan.path,
      oldJsonSha: plan.oldJsonSha,
      newJsonSha: plan.newJsonSha,
      json: plan.json,
      payload: { ...payload, dev: plan.payload.dev, ino: plan.payload.ino },
    };
  });
  return {
    version: 1,
    directory: directory.path,
    dev: directory.dev,
    ino: directory.ino,
    manifestHash,
    filesHash,
    phase: value.phase as Journal['phase'],
    plans,
  };
}
async function migrate(
  options: BundleMigrationOptions,
  files: BundleMigrationFile[],
): Promise<BundleMigrationReceipt> {
  if (
    !path.isAbsolute(options.directory) ||
    !path.isAbsolute(options.journalFile) ||
    !sha(options.manifestHash)
  )
    throw new Fault('BUNDLE_MIGRATION_INVALID_TARGET');
  const directory = await privateDirectory(options.directory);
  const journalParent = await privateDirectory(path.dirname(options.journalFile), true);
  const journalFile = path.join(journalParent.path, path.basename(options.journalFile));
  const bundles = path.join(directory.path, 'bundles');
  if (journalFile === bundles || journalFile.startsWith(`${bundles}${path.sep}`))
    throw new Fault('BUNDLE_MIGRATION_INVALID_TARGET');
  const filesHash = digest(JSON.stringify(files));
  let journal: Journal;
  let saved: unknown;
  try {
    saved = JSON.parse((await read(journalFile, 160 * 1024 * 1024, true)).text);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new Fault('BUNDLE_MIGRATION_CORRUPT_JOURNAL');
  }
  if (saved !== undefined) {
    journal = validateJournal(saved, directory, options.manifestHash, filesHash, files);
    if (journal.phase === 'complete')
      return { phase: 'complete', files: journal.plans.length, manifestHash: options.manifestHash };
  } else {
    const plans: Plan[] = [];
    const index = new Map(files.map((file) => [file.path, file]));
    if (files.some((file) => file.path.startsWith('bundles/'))) {
      const bundleDirectory = await privateDirectory(bundles);
      if (bundleDirectory.path !== bundles) throw new Fault('BUNDLE_MIGRATION_UNSAFE_DIRECTORY');
      for (const file of files.filter((entry) => blobPath(entry.path)))
        await checkedFile(directory.path, file);
      for (const file of files.filter((entry) => recordPath(entry.path))) {
        const original = await checkedFile(directory.path, file, true);
        const record = parseRecord(original.text, file.path);
        if (!record.payload) continue;
        const payload = index.get(file.path.replace(/\.json$/, '.bundle'));
        if (!payload) throw new Fault('BUNDLE_MIGRATION_MISSING_PAYLOAD');
        const blob = await checkedFile(directory.path, payload);
        // Frozen partial uploads and already-released payloads retain their bytes; full uploads must match the public header.
        if (
          payload.size > record.header.size ||
          (payload.size === record.header.size && payload.sha256 !== record.header.sha256)
        )
          throw new Fault('BUNDLE_MIGRATION_HEADER_MISMATCH');
        const json = JSON.stringify({
          ...record,
          payload: { dev: blob.info.dev, ino: blob.info.ino },
        });
        plans.push({
          path: file.path,
          oldJsonSha: original.sha256,
          newJsonSha: digest(json),
          json,
          payload: { ...payload, dev: blob.info.dev, ino: blob.info.ino },
        });
      }
    }
    if (plans.length > 4096) throw new Fault('BUNDLE_MIGRATION_LIMIT');
    journal = {
      version: 1,
      directory: directory.path,
      dev: directory.dev,
      ino: directory.ino,
      manifestHash: options.manifestHash,
      filesHash,
      phase: 'planned',
      plans,
    };
    // The complete transform is durable before the first source receipt can change.
    await writeAtomic(journalFile, JSON.stringify(journal));
  }
  for (const plan of journal.plans) {
    const root = await privateDirectory(directory.path);
    if (root.dev !== journal.dev || root.ino !== journal.ino)
      throw new Fault('BUNDLE_MIGRATION_TARGET_CHANGED');
    const blob = await checkedFile(directory.path, plan.payload);
    if (blob.info.dev !== plan.payload.dev || blob.info.ino !== plan.payload.ino)
      throw new Fault('BUNDLE_MIGRATION_CHANGED');
    const destination = path.join(directory.path, plan.path);
    const current = await read(destination, 16384, true);
    if (current.sha256 === plan.newJsonSha) continue;
    if (current.sha256 !== plan.oldJsonSha) throw new Fault('BUNDLE_MIGRATION_CHANGED');
    const original = parseRecord(current.text, plan.path);
    const expected = JSON.stringify({
      ...original,
      payload: { dev: plan.payload.dev, ino: plan.payload.ino },
    });
    if (expected !== plan.json) throw new Fault('BUNDLE_MIGRATION_CORRUPT_JOURNAL');
    await writeAtomic(destination, plan.json, async () => {
      const latest = await read(destination, 16384);
      if (latest.sha256 === plan.newJsonSha) return false;
      if (latest.sha256 !== plan.oldJsonSha) throw new Fault('BUNDLE_MIGRATION_CHANGED');
      return true;
    });
  }
  for (const plan of journal.plans)
    if ((await read(path.join(directory.path, plan.path), 16384)).sha256 !== plan.newJsonSha)
      throw new Fault('BUNDLE_MIGRATION_CHANGED');
  // A recovered rename may have new bytes without a durable directory entry yet.
  if (journal.plans.length) await sync(bundles);
  journal.phase = 'complete';
  await writeAtomic(journalFile, JSON.stringify(journal));
  return { phase: 'complete', files: journal.plans.length, manifestHash: options.manifestHash };
}
export function migrateBundlePayloads(
  options: BundleMigrationOptions,
): Promise<BundleMigrationReceipt> {
  let files: BundleMigrationFile[];
  try {
    files = manifest(options.files);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = path.resolve(options.journalFile);
  const fingerprint = digest(JSON.stringify([options.directory, options.manifestHash, files]));
  const existing = active.get(key);
  if (existing)
    return existing.fingerprint === fingerprint
      ? existing.promise
      : Promise.reject(new Fault('BUNDLE_MIGRATION_TARGET_CHANGED'));
  const promise = migrate(options, files).finally(() => active.delete(key));
  active.set(key, { fingerprint, promise });
  return promise;
}
