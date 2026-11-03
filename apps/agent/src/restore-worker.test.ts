import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { restoreWorker } from './restore-worker.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function entry(name: string, bytes: Buffer, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [
    [100, 8, 0o600],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, bytes.length],
    [136, 12, 0],
  ])
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-public-worker-'));
  const directory = path.join(root, 'var/lib/daban-executor');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const provision = Buffer.from('{"id":"mock-provision","image":"synthetic"}');
  await fs.writeFile(path.join(directory, 'provision.json'), provision, { mode: 0o600 });
  const browser = Buffer.from('SYNTHETIC BROWSER SESSION'),
    shared = Buffer.from('SYNTHETIC EXECUTABLE DATA');
  const manifest = {
    version: 1,
    target: 'b'.repeat(64),
    provision: digest(provision),
    source: { vm: 'mock-frozen', imageFingerprint: 'a'.repeat(64) },
    files: [
      {
        root: 'browser',
        path: 'Default/Preferences',
        kind: 'file',
        size: browser.length,
        sha256: digest(browser),
        mode: 0o600,
      },
      {
        root: 'shared',
        path: 'bin/mock-tool.sh',
        kind: 'file',
        size: shared.length,
        sha256: digest(shared),
        mode: 0o4755,
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const archive = path.join(root, 'public.tar');
  const make = (extra: Buffer[] = [], altered = false) =>
    Buffer.concat([
      entry('public.json', bytes),
      entry(
        'browser/Default/Preferences',
        altered ? Buffer.from('SYNTHETIC CHANGED CONTENT') : browser,
      ),
      entry('shared/bin/mock-tool.sh', shared),
      ...extra,
      Buffer.alloc(1024),
    ]);
  const data = make();
  await fs.writeFile(archive, data, { mode: 0o600 });
  return {
    root,
    directory,
    provision,
    browser,
    shared,
    manifest,
    archive,
    make,
    options: {
      root,
      archive,
      archiveHash: digest(data),
      manifestHash: digest(bytes),
      target: manifest.target,
      provision: manifest.provision,
      owner: { uid: process.getuid!(), gid: process.getgid!() },
    },
    browserTarget: path.join(root, 'var/lib/bot-prototype/profile/Default/Preferences'),
    sharedTarget: path.join(root, 'var/lib/bot-prototype/desktops/shared/bin/mock-tool.sh'),
  };
}

test('guest public restore verifies both roots, strips privileged mode bits and never resets completed user edits', async () => {
  const f = await fixture();
  try {
    const result = await restoreWorker(f.options);
    expect(result.files).toBe(2);
    expect(result.browserFiles).toBe(1);
    expect(result.sharedFiles).toBe(1);
    expect(result.manifestHash).toBe(f.options.manifestHash);
    expect(await fs.readFile(f.browserTarget)).toStrictEqual(f.browser);
    expect(await fs.readFile(f.sharedTarget)).toStrictEqual(f.shared);
    expect((await fs.lstat(f.sharedTarget)).mode & 0o7777).toBe(0o755);
    expect(await fs.readFile(path.join(f.directory, 'provision.json'))).toStrictEqual(f.provision);
    await fs.writeFile(f.browserTarget, 'SYNTHETIC LATER USER EDIT');
    await fs.chmod(f.sharedTarget, 0o644);
    await fs.unlink(f.archive);
    expect(await restoreWorker(f.options)).toStrictEqual(result);
    expect(await fs.readFile(f.browserTarget, 'utf8')).toBe('SYNTHETIC LATER USER EDIT');
    expect((await fs.lstat(f.sharedTarget)).mode & 0o777).toBe(0o644);
    await expect(restoreWorker({ ...f.options, target: 'c'.repeat(64) })).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_TARGET_CHANGED$/),
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('guest public restore rejects links, unknown archive paths and changed payloads before publication', async () => {
  for (const extra of [
    [entry('shared/link', Buffer.alloc(0), '2')],
    [entry('../outside', Buffer.from('SYNTHETIC ESCAPE'))],
  ]) {
    const f = await fixture();
    try {
      const archive = f.make(extra);
      await fs.writeFile(f.archive, archive, { mode: 0o600 });
      await expect(
        restoreWorker({ ...f.options, archiveHash: digest(archive) }),
      ).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringMatching(/^MIGRATION_UNSAFE_ARCHIVE$/),
      });
      await expect(fs.lstat(f.browserTarget)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(f.directory, 'provision.json'))).toStrictEqual(
        f.provision,
      );
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
  const f = await fixture();
  try {
    const bad = f.make([], true);
    await fs.writeFile(f.archive, bad, { mode: 0o600 });
    await expect(restoreWorker({ ...f.options, archiveHash: digest(bad) })).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_INTEGRITY_FAILED$/),
    });
    await fs.writeFile(f.archive, f.make(), { mode: 0o600 });
    expect((await restoreWorker(f.options)).phase).toBe('complete');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('guest public restore resumes a same-manifest partial publication and refuses a changed manifest', async () => {
  const f = await fixture();
  const rename = fs.rename.bind(fs);
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && String(to).endsWith('/desktops/shared')) {
      failed = true;
      throw new Error('SYNTHETIC INTERRUPTED PUBLICATION');
    }
    return rename(from, to);
  };
  try {
    await expect(restoreWorker(f.options)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_RESTORE_FAILED$/),
    });
    expect(await fs.readFile(f.browserTarget)).toStrictEqual(f.browser);
    await expect(
      restoreWorker({ ...f.options, manifestHash: 'd'.repeat(64) }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_MANIFEST_CHANGED$/),
    });
    fs.rename = rename;
    expect((await restoreWorker(f.options)).phase).toBe('complete');
    expect(await fs.readFile(f.sharedTarget)).toStrictEqual(f.shared);
  } finally {
    fs.rename = rename;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a verified partial restore rechecks staged bytes before publishing the remaining root', async () => {
  const f = await fixture();
  const rename = fs.rename.bind(fs);
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && String(to).endsWith('/desktops/shared')) {
      failed = true;
      throw new Error('SYNTHETIC INTERRUPT');
    }
    return rename(from, to);
  };
  try {
    await expect(restoreWorker(f.options)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_RESTORE_FAILED$/),
    });
    fs.rename = rename;
    const staged = path.join(
      f.directory,
      `.public-import-${f.options.manifestHash.slice(0, 24)}/shared/bin/mock-tool.sh`,
    );
    await fs.writeFile(staged, Buffer.alloc(f.shared.length, 120));
    await expect(restoreWorker(f.options)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_DESTINATION_CHANGED$/),
    });
    await expect(fs.lstat(f.sharedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    fs.rename = rename;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('partial replay still verifies archive file checksums even when the stage was already verified', async () => {
  const f = await fixture();
  const rename = fs.rename.bind(fs);
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && String(to).endsWith('/desktops/shared')) {
      failed = true;
      throw new Error('SYNTHETIC INTERRUPT');
    }
    return rename(from, to);
  };
  try {
    await expect(restoreWorker(f.options)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_RESTORE_FAILED$/),
    });
    fs.rename = rename;
    const changed = f.make([], true);
    await fs.writeFile(f.archive, changed, { mode: 0o600 });
    await expect(
      restoreWorker({ ...f.options, archiveHash: digest(changed) }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MIGRATION_INTEGRITY_FAILED$/),
    });
    await expect(fs.lstat(f.sharedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    fs.rename = rename;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('public data parents are assigned to the runtime account so the shared root stays traversable', async () => {
  const f = await fixture();
  const chown = fs.chown.bind(fs);
  const owners: { file: string; uid: number; gid: number }[] = [];
  fs.chown = async (file, uid, gid) => {
    owners.push({ file: String(file), uid, gid });
    return chown(file, uid, gid);
  };
  try {
    await restoreWorker(f.options);
    for (const suffix of ['/var/lib/bot-prototype', '/var/lib/bot-prototype/desktops'])
      expect.assert(
        owners.some(
          (entry) =>
            entry.file.endsWith(suffix) &&
            entry.uid === f.options.owner.uid &&
            entry.gid === f.options.owner.gid,
        ),
      );
  } finally {
    fs.chown = chown;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
