import { createHash } from 'node:crypto';
import {
  cp,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BotBundle, botBundleText } from '@daban/protocol';
import { expect, test } from 'vitest';
import { migrateBundlePayloads } from './bundle-migration.js';
import { BotBundles } from './bundles.js';
import { Knowledge } from './knowledge.js';
import { BotProfiles } from './profiles.js';
import { Skills } from './skills.js';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const bundle: BotBundle = {
  format: 'daban.bot',
  version: 1,
  profile: { name: 'Synthetic portable Bot', instructions: '', color: 'mint' },
  preferences: '',
  skills: [],
  knowledge: [],
};
async function fixture(state: 'failed' | 'awaiting' | 'complete' = 'failed', partial = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bundle-rebind-'));
  const directory = path.join(root, 'model');
  await mkdir(path.join(directory, 'bundles'), { recursive: true, mode: 0o700 });
  const full = Buffer.from(botBundleText(bundle));
  const payload = state === 'complete' ? Buffer.alloc(0) : partial ? full.subarray(0, 20) : full;
  const record = {
    version: 1,
    header: { id: 'mock-operation', size: full.length, sha256: digest(full) },
    target: 'mock-import-target',
    state,
    applying: state === 'complete',
    payload: { dev: 47, ino: 48 },
    ...(state === 'failed' ? { error: 'MOCK_INTERRUPTED' } : {}),
  };
  const original = JSON.stringify(record);
  const recordPath = path.join(directory, 'bundles', 'mock-operation.json');
  const payloadPath = path.join(directory, 'bundles', 'mock-operation.bundle');
  await writeFile(recordPath, original, { mode: 0o600 });
  await writeFile(payloadPath, payload, { mode: 0o600 });
  const files = [
    {
      path: 'bundles/mock-operation.json',
      size: Buffer.byteLength(original),
      sha256: digest(original),
    },
    { path: 'bundles/mock-operation.bundle', size: payload.length, sha256: digest(payload) },
  ];
  return {
    root,
    record,
    original,
    recordPath,
    payloadPath,
    options: {
      directory,
      files,
      manifestHash: digest(JSON.stringify(files)),
      journalFile: path.join(root, 'bundle-migration.json'),
    },
  };
}

test('verified copied payloads get only new filesystem identity and pending import retries work', async () => {
  const f = await fixture();
  const profiles = new BotProfiles(path.join(f.options.directory, 'bots'));
  const skills = new Skills(path.join(f.options.directory, 'skills.sqlite'));
  const knowledge = new Knowledge(path.join(f.options.directory, 'knowledge.sqlite'));
  let transfers = new BotBundles({
    directory: path.join(f.options.directory, 'bundles'),
    profiles,
    skills,
    knowledge,
  });
  try {
    await expect(transfers.retry(f.record.header.id)).rejects.toMatchObject({
      code: 'BOT_IMPORT_STORE',
    });
    await transfers.close();
    const receipt = await migrateBundlePayloads(f.options);
    expect(receipt.phase).toBe('complete');
    expect(receipt.files).toBe(1);
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    const info = await lstat(f.payloadPath);
    expect(record).toStrictEqual({ ...f.record, payload: { dev: info.dev, ino: info.ino } });
    expect((await lstat(f.recordPath)).mode & 0o777).toBe(0o600);
    expect.assert(!JSON.stringify(receipt).includes('mock-import-target'));
    transfers = new BotBundles({
      directory: path.join(f.options.directory, 'bundles'),
      profiles,
      skills,
      knowledge,
    });
    await transfers.retry(f.record.header.id);
    await transfers.settled;
    expect((await transfers.status(f.record.header.id)).state).toBe('complete');
    const changed = await readFile(f.recordPath, 'utf8');
    expect(await migrateBundlePayloads(f.options)).toStrictEqual(receipt);
    expect(await readFile(f.recordPath, 'utf8')).toBe(changed);
    expect((await lstat(f.payloadPath)).size).toBe(0);
  } finally {
    await transfers.close();
    await skills.close();
    await knowledge.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('copied partial uploads and released completed payloads retain their original bytes and state', async () => {
  for (const state of ['awaiting', 'complete'] as const) {
    const f = await fixture(state, true);
    try {
      const bytes = await readFile(f.payloadPath);
      await migrateBundlePayloads(f.options);
      const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
      expect(record.state).toBe(state);
      expect(await readFile(f.payloadPath)).toStrictEqual(bytes);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('changed source bytes and a full payload that disagrees with its header cannot be rebound', async () => {
  for (const change of ['bytes', 'header'] as const) {
    const f = await fixture();
    try {
      if (change === 'bytes')
        await writeFile(f.payloadPath, 'MOCK CHANGED PAYLOAD', { mode: 0o600 });
      else {
        f.record.header.sha256 = 'c'.repeat(64);
        const text = JSON.stringify(f.record);
        await writeFile(f.recordPath, text, { mode: 0o600 });
        f.options.files[0] = {
          ...f.options.files[0],
          size: Buffer.byteLength(text),
          sha256: digest(text),
        };
      }
      const before = await readFile(f.recordPath, 'utf8');
      await expect(migrateBundlePayloads(f.options)).rejects.toThrowError();
      expect(await readFile(f.recordPath, 'utf8')).toBe(before);
      await expect(lstat(f.options.journalFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('a persisted plan precedes every rewrite and resumes after rename before directory sync', async () => {
  const f = await fixture();
  const probe = await open(path.join(f.root, 'mock-probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalWrite = prototype.writeFile;
  const originalSync = prototype.sync;
  const bundleInode = (await lstat(path.dirname(f.recordPath))).ino;
  let observedPlan = false;
  let interrupted = false;
  await probe.close();
  prototype.writeFile = async function (
    this: FileHandle,
    ...args: Parameters<FileHandle['writeFile']>
  ) {
    if (typeof args[0] === 'string') {
      const value = JSON.parse(args[0]);
      if (value.header && value.payload) {
        const journal = JSON.parse(await readFile(f.options.journalFile, 'utf8'));
        expect(journal.phase).toBe('planned');
        expect(journal.plans[0].oldJsonSha).toBe(f.options.files[0].sha256);
        observedPlan = true;
      }
    }
    return originalWrite.apply(this, args);
  };
  prototype.sync = async function (this: FileHandle) {
    const info = await this.stat();
    if (!interrupted && info.isDirectory() && info.ino === bundleInode) {
      interrupted = true;
      throw new Error('MOCK_DIRECTORY_SYNC_FAILURE');
    }
    return originalSync.call(this);
  };
  try {
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError();
    expect(observedPlan).toBe(true);
    expect(interrupted).toBe(true);
    prototype.writeFile = originalWrite;
    let resumedDirectorySync = false;
    prototype.sync = async function (this: FileHandle) {
      const info = await this.stat();
      if (info.isDirectory() && info.ino === bundleInode) resumedDirectorySync = true;
      return originalSync.call(this);
    };
    expect(JSON.parse(await readFile(f.options.journalFile, 'utf8')).phase).toBe('planned');
    expect((await migrateBundlePayloads(f.options)).phase).toBe('complete');
    expect(resumedDirectorySync).toBe(true);
  } finally {
    prototype.writeFile = originalWrite;
    prototype.sync = originalSync;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an interrupted plan never overwrites an unrelated later receipt edit', async () => {
  const f = await fixture();
  const probe = await open(path.join(f.root, 'mock-probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.sync;
  const bundleInode = (await lstat(path.dirname(f.recordPath))).ino;
  await probe.close();
  prototype.sync = async function (this: FileHandle) {
    const info = await this.stat();
    if (info.isDirectory() && info.ino === bundleInode) throw new Error('MOCK_INTERRUPTED_SYNC');
    return original.call(this);
  };
  try {
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError();
    prototype.sync = original;
    const changed = JSON.stringify({
      ...JSON.parse(await readFile(f.recordPath, 'utf8')),
      error: 'MOCK_LATER_USER_EDIT',
    });
    await writeFile(f.recordPath, changed, { mode: 0o600 });
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError(/BUNDLE_MIGRATION_CHANGED/);
    expect(await readFile(f.recordPath, 'utf8')).toBe(changed);
  } finally {
    prototype.sync = original;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('journal replay binds the original manifest and canonical target directory inode', async () => {
  const f = await fixture();
  try {
    await migrateBundlePayloads(f.options);
    await expect(
      migrateBundlePayloads({ ...f.options, manifestHash: 'e'.repeat(64) }),
    ).rejects.toThrowError(/BUNDLE_MIGRATION_TARGET_CHANGED/);
    const backup = path.join(f.root, 'model-backup');
    await rename(f.options.directory, backup);
    await cp(backup, f.options.directory, { recursive: true });
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError(
      /BUNDLE_MIGRATION_TARGET_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a resumed plan cannot change receipt content beyond its payload filesystem identity', async () => {
  const f = await fixture();
  const probe = await open(path.join(f.root, 'mock-probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.writeFile;
  await probe.close();
  prototype.writeFile = async function (
    this: FileHandle,
    ...args: Parameters<FileHandle['writeFile']>
  ) {
    if (typeof args[0] === 'string') {
      const value = JSON.parse(args[0]);
      if (value.header && value.payload) throw new Error('MOCK_BEFORE_RECEIPT_WRITE');
    }
    return original.apply(this, args);
  };
  try {
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError();
    prototype.writeFile = original;
    const journal = JSON.parse(await readFile(f.options.journalFile, 'utf8'));
    journal.plans[0].json = JSON.stringify({
      ...JSON.parse(journal.plans[0].json),
      error: 'MOCK_UNRELATED_EDIT',
    });
    journal.plans[0].newJsonSha = digest(journal.plans[0].json);
    await writeFile(f.options.journalFile, JSON.stringify(journal), { mode: 0o600 });
    await expect(migrateBundlePayloads(f.options)).rejects.toThrowError(
      /BUNDLE_MIGRATION_CORRUPT_JOURNAL/,
    );
    expect(await readFile(f.recordPath, 'utf8')).toBe(f.original);
  } finally {
    prototype.writeFile = original;
    await rm(f.root, { recursive: true, force: true });
  }
});
