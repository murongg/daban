import { createHash } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ControlDataPort, MigrationManifest } from './migration.js';
import { isControlDataPath, migrateControlData, migratePublicData } from './migration.js';

const identity = { vm: 'mock-frozen-vm', imageFingerprint: 'a'.repeat(64) };
const target = { vm: 'mock-full-vm', imageFingerprint: 'b'.repeat(64) };
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function source(files: Record<string, Buffer>) {
  const manifest: MigrationManifest = {
    source: identity,
    files: Object.entries(files).map(([name, data]) => ({
      path: name,
      kind: 'file',
      size: data.byteLength,
      sha256: digest(data),
    })),
  };
  let reads = 0;
  const port: ControlDataPort = {
    manifest: async () => structuredClone(manifest),
    async *read(name) {
      reads++;
      const data = files[name];
      for (let offset = 0; offset < data.length; offset += 3)
        yield data.subarray(offset, offset + 3);
    },
  };
  return { manifest, port, reads: () => reads };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-migration-'));
  return {
    root,
    directory: path.join(root, 'model'),
    journal: path.join(root, 'migration.json'),
    expected: { source: identity, target },
  };
}

test('control migration streams exact private originals and SQLite sidecars before atomic publication', async () => {
  const options = await fixture();
  const input = source({
    'credentials.json': Buffer.from('{"apiKey":"synthetic-migration-key"}'),
    'notes.sqlite': Buffer.from([0, 1, 2, 3]),
    'notes.sqlite-wal': Buffer.from([4, 5, 6]),
    'bots/mock-bot.json': Buffer.from('{"name":"Synthetic Bot"}'),
  });
  try {
    const result = await migrateControlData({ ...options, source: input.port });
    expect(result.phase).toBe('published');
    expect(result.files).toBe(4);
    expect(result.bytes).toBe(input.manifest.files.reduce((total, file) => total + file.size, 0));
    expect.assert(!JSON.stringify(result).includes('synthetic-migration-key'));
    for (const file of input.manifest.files) {
      const actual = path.join(options.directory, file.path);
      expect(digest(await readFile(actual))).toBe(file.sha256);
      expect((await lstat(actual)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(options.directory)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(options.journal, 'utf8')).phase).toBe('published');
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('unsafe paths, private VM authority, code, links and duplicate names are rejected before any file read', async () => {
  for (const name of [
    '../escape',
    '/absolute',
    'bots/../escape.json',
    'bots\\escape.json',
    'bad\0name',
    'control-token',
    'recovery.json',
    'dsh/mock.json',
    'runs/mock/result.json',
    'autoload/mock.ts',
    'foreign.js',
  ]) {
    const options = await fixture();
    const input = source({ [name]: Buffer.from('mock') });
    try {
      await expect(migrateControlData({ ...options, source: input.port })).rejects.toThrowError();
      expect(input.reads()).toBe(0);
    } finally {
      await rm(options.root, { recursive: true, force: true });
    }
  }
  const options = await fixture();
  const input = source({ 'bots/mock.json': Buffer.from('mock') });
  input.manifest.files.push({ ...input.manifest.files[0] });
  try {
    await expect(migrateControlData({ ...options, source: input.port })).rejects.toThrowError();
    expect(input.reads()).toBe(0);
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('incomplete staging remains unpublished and resumes from the same frozen manifest', async () => {
  const options = await fixture();
  const input = source({
    'credentials.json': Buffer.from('mock private original'),
    'notes.sqlite': Buffer.from('mock sqlite bytes'),
  });
  let failed = false;
  const interrupted: ControlDataPort = {
    manifest: input.port.manifest,
    async *read(name) {
      for await (const bytes of input.port.read(name)) {
        yield bytes;
        if (!failed) {
          failed = true;
          throw new Error('MOCK_SOURCE_DISCONNECTED');
        }
      }
    },
  };
  try {
    await expect(migrateControlData({ ...options, source: interrupted })).rejects.toThrowError();
    await expect(lstat(options.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(options.journal, 'utf8')).phase).toBe('staging');
    const result = await migrateControlData({ ...options, source: input.port });
    expect(result.phase).toBe('published');
    expect(digest(await readFile(path.join(options.directory, 'notes.sqlite')))).toBe(
      input.manifest.files[1].sha256,
    );
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('wrong file hashes and missing SQLite mains cannot publish a host model directory', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock') });
  input.manifest.files[0].sha256 = 'c'.repeat(64);
  try {
    await expect(migrateControlData({ ...options, source: input.port })).rejects.toThrowError();
    await expect(lstat(options.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
  const next = await fixture();
  const sidecar = source({ 'notes.sqlite-wal': Buffer.from('mock wal') });
  try {
    await expect(migrateControlData({ ...next, source: sidecar.port })).rejects.toThrowError();
    expect(sidecar.reads()).toBe(0);
  } finally {
    await rm(next.root, { recursive: true, force: true });
  }
});

test('existing different host state and symlink destinations are preserved', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock source key') });
  try {
    await mkdir(options.directory, { mode: 0o700 });
    await writeFile(path.join(options.directory, 'credentials.json'), 'mock existing host key', {
      mode: 0o600,
    });
    await expect(migrateControlData({ ...options, source: input.port })).rejects.toThrowError();
    expect(await readFile(path.join(options.directory, 'credentials.json'), 'utf8')).toBe(
      'mock existing host key',
    );
    expect(input.reads()).toBe(0);
    const outside = path.join(options.root, 'outside');
    await mkdir(outside);
    const link = path.join(options.root, 'model-link');
    await symlink(outside, link);
    await expect(
      migrateControlData({ ...options, directory: link, source: input.port }),
    ).rejects.toThrowError();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('publication interrupted before its final journal commit is recovered by inspection', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock source key') });
  try {
    const original = await migrateControlData({ ...options, source: input.port });
    const journal = JSON.parse(await readFile(options.journal, 'utf8'));
    journal.phase = 'verified';
    await writeFile(options.journal, JSON.stringify(journal), { mode: 0o600 });
    const noReplay = {
      manifest: input.port.manifest,
      read() {
        throw new Error('Source must not be read after publication');
      },
    };
    expect(await migrateControlData({ ...options, source: noReplay })).toStrictEqual(original);
    expect(JSON.parse(await readFile(options.journal, 'utf8')).phase).toBe('published');
    await writeFile(path.join(options.directory, 'credentials.json'), 'mock later host edit', {
      mode: 0o600,
    });
    expect(await migrateControlData({ ...options, source: noReplay })).toStrictEqual(original);
    expect(await readFile(path.join(options.directory, 'credentials.json'), 'utf8')).toBe(
      'mock later host edit',
    );
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('the journal binds source and target VM image identities', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock') });
  try {
    await migrateControlData({ ...options, source: input.port });
    await expect(
      migrateControlData({
        ...options,
        expected: { ...options.expected, target: { ...target, imageFingerprint: 'd'.repeat(64) } },
        source: input.port,
      }),
    ).rejects.toThrowError();
    await expect(
      migrateControlData({
        ...options,
        expected: { ...options.expected, source: { ...identity, vm: 'mock-foreign-vm' } },
        source: input.port,
      }),
    ).rejects.toThrowError();
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('public VM data is received only under a fixed browser or shared root label', async () => {
  const options = await fixture();
  const input = source({ 'Default/Preferences': Buffer.from('mock browser preference') });
  try {
    const result = await migratePublicData({
      ...options,
      directory: path.join(options.root, 'public'),
      root: 'browser',
      source: input.port,
    });
    expect(result.files).toBe(1);
    expect(
      await readFile(
        path.join(options.root, 'public', 'browser', 'Default', 'Preferences'),
        'utf8',
      ),
    ).toBe('mock browser preference');
    await expect(
      migratePublicData({
        ...options,
        directory: path.join(options.root, 'public'),
        root: '../model' as 'shared',
        source: input.port,
      }),
    ).rejects.toThrowError();
    await expect(lstat(options.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('identity ordering and a safe existing host parent do not change migration ownership', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock private bytes') });
  input.manifest.source = { imageFingerprint: identity.imageFingerprint, vm: identity.vm };
  try {
    await chmod(options.root, 0o755);
    const first = await migrateControlData({ ...options, source: input.port });
    const result = await migrateControlData({
      ...options,
      expected: { target, source: identity },
      source: input.port,
    });
    expect(result).toStrictEqual(first);
    expect((await lstat(options.root)).mode & 0o777).toBe(0o755);
    expect((await lstat(options.directory)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('manifest links and file-name collisions cannot become host filesystem entries', async () => {
  for (const variant of ['link', 'case', 'prefix']) {
    const options = await fixture();
    const input = source({ 'bots/mock.json': Buffer.from('mock') });
    if (variant === 'link') input.manifest.files[0].kind = 'symlink' as 'file';
    if (variant === 'case')
      input.manifest.files.push({ ...input.manifest.files[0], path: 'bots/MOCK.json' });
    if (variant === 'prefix')
      input.manifest.files.push({ ...input.manifest.files[0], path: 'bots/mock.json/nested.json' });
    try {
      await expect(migrateControlData({ ...options, source: input.port })).rejects.toThrowError();
      expect(input.reads()).toBe(0);
    } finally {
      await rm(options.root, { recursive: true, force: true });
    }
  }
});

test('nested staged directory entries are synced before their tree is published', async () => {
  const options = await fixture();
  const input = source({ 'bots/mock.json': Buffer.from('mock bot') });
  const probe = await open(path.join(options.root, 'mock-probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.sync;
  const directories = new Set<number>();
  await probe.close();
  prototype.sync = async function (this: FileHandle) {
    const info = await this.stat();
    if (info.isDirectory()) directories.add(info.ino);
    return original.call(this);
  };
  try {
    await migrateControlData({ ...options, source: input.port });
    expect.assert(directories.has((await lstat(options.directory)).ino));
    expect.assert(directories.has((await lstat(path.join(options.directory, 'bots'))).ino));
  } finally {
    prototype.sync = original;
    await rm(options.root, { recursive: true, force: true });
  }
});

test('verified staging is published through its journal without rereading the source', async () => {
  const options = await fixture();
  const input = source({ 'credentials.json': Buffer.from('mock verified bytes') });
  try {
    const expected = await migrateControlData({ ...options, source: input.port });
    const journal = JSON.parse(await readFile(options.journal, 'utf8'));
    await rename(options.directory, journal.stage);
    journal.phase = 'verified';
    await writeFile(options.journal, JSON.stringify(journal), { mode: 0o600 });
    const unavailable: ControlDataPort = {
      async manifest() {
        throw new Error('MOCK_SOURCE_OFFLINE');
      },
      read() {
        throw new Error('MOCK_SOURCE_OFFLINE');
      },
    };
    expect(await migrateControlData({ ...options, source: unavailable })).toStrictEqual(expected);
    expect(await readFile(path.join(options.directory, 'credentials.json'), 'utf8')).toBe(
      'mock verified bytes',
    );
    journal.phase = 'verified';
    await writeFile(options.journal, JSON.stringify(journal), { mode: 0o600 });
    await rename(options.directory, path.join(options.root, 'mock-preserved-copy'));
    await expect(migrateControlData({ ...options, source: unavailable })).rejects.toThrowError(
      /MIGRATION_PUBLICATION_UNKNOWN/,
    );
    expect(
      await readFile(path.join(options.root, 'mock-preserved-copy', 'credentials.json'), 'utf8'),
    ).toBe('mock verified bytes');
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});

test('pending portable bundle receipts and flat payloads are retained while private SDK state stays excluded', async () => {
  const options = await fixture();
  const receipt = Buffer.from('{"version":1,"state":"awaiting","payload":{"dev":47,"ino":48}}');
  const payload = Buffer.from('SYNTHETIC PENDING BUNDLE PAYLOAD');
  const input = source({
    'bundles/mock-pending.json': receipt,
    'bundles/mock-pending.bundle': payload,
    'bots/mock-bot.json': Buffer.from('{"mock":"profile"}'),
    'task-journal/mock-run.json': Buffer.from('{"mock":"receipt"}'),
    'interactions/mock-decision.json': Buffer.from('{"mock":"approval"}'),
    'network.json': Buffer.from('{"mock":"proxy"}'),
  });
  try {
    for (const entry of input.manifest.files) expect(isControlDataPath(entry.path)).toBe(true);
    for (const entry of [
      'bundles/imports/mock.json',
      'bundles/mock-pending.uuid.tmp',
      'runs/mock/result.json',
      'dsh/mock/session.json',
      'autoload/mock.js',
      'control-token',
      'recovery.json',
    ])
      expect(isControlDataPath(entry)).toBe(false);
    const result = await migrateControlData({ ...options, source: input.port });
    expect(result.files).toBe(6);
    expect(await readFile(path.join(options.directory, 'bundles/mock-pending.json'))).toStrictEqual(
      receipt,
    );
    expect(
      await readFile(path.join(options.directory, 'bundles/mock-pending.bundle')),
    ).toStrictEqual(payload);
  } finally {
    await rm(options.root, { recursive: true, force: true });
  }
});
