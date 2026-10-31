import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MigrationManifest } from './migration.js';
import { restorePublicData, scanPublicSecrets } from './restore.js';
import { restoreWorker } from './restore-worker.js';

async function* chunks(bytes: Buffer, size = 7) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
test('public-data scanning detects provider keys across UTF-8 and UTF-16LE chunk boundaries', async () => {
  const key = 'sk-synthetic-public-boundary';
  for (const encoding of ['utf8', 'utf16le'] as const) {
    const bytes = Buffer.concat([
      Buffer.from('synthetic prefix'),
      Buffer.from(key, encoding),
      Buffer.from('suffix'),
    ]);
    await assert.rejects(
      scanPublicSecrets(chunks(bytes), key),
      /^Error: MIGRATION_SECRET_IN_PUBLIC$/,
    );
  }
  await scanPublicSecrets(chunks(Buffer.from('synthetic public browser/session data')), key);
});

test('secret scanning handles a large public metadata chunk without rejecting safe payloads', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 32),
    key = 'sk-synthetic-large-chunk';
  await scanPublicSecrets(
    (async function* () {
      yield bytes;
    })(),
    key,
  );
  Buffer.from(key).copy(bytes, bytes.length - key.length);
  await assert.rejects(
    scanPublicSecrets(
      (async function* () {
        yield bytes;
      })(),
      key,
    ),
    /^Error: MIGRATION_SECRET_IN_PUBLIC$/,
  );
});

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(secret = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-public-restore-'));
  const directory = path.join(root, 'public'),
    cacheDirectory = path.join(root, 'cache');
  for (const name of ['browser/Default', 'shared/bin'])
    await fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
  const key = 'sk-synthetic-restore-private';
  const browserBytes = Buffer.from('SYNTHETIC BROWSER LOGIN');
  const sharedBytes = secret
    ? Buffer.concat([Buffer.alloc(65530, 32), Buffer.from(key, 'utf16le')])
    : Buffer.from('SYNTHETIC EXECUTABLE CONTENT');
  const browserFile = path.join(directory, 'browser/Default/Preferences'),
    sharedFile = path.join(directory, 'shared/bin/mock.sh');
  await fs.writeFile(browserFile, browserBytes, { mode: 0o600 });
  await fs.writeFile(sharedFile, sharedBytes, { mode: 0o600 });
  const credentialFile = path.join(root, 'credentials.json'),
    helperEntry = path.join(root, 'restore-worker.mjs');
  await fs.writeFile(credentialFile, JSON.stringify({ apiKey: key }), { mode: 0o600 });
  await fs.writeFile(helperEntry, '// SYNTHETIC PUBLIC WORKER ARTIFACT\n', { mode: 0o600 });
  const source = { vm: 'mock-frozen', imageFingerprint: 'a'.repeat(64) };
  const browser: MigrationManifest = {
    source,
    files: [
      {
        path: 'Default/Preferences',
        kind: 'file',
        size: browserBytes.length,
        sha256: hash(browserBytes),
        mode: 0o600,
      },
    ],
  };
  const shared: MigrationManifest = {
    source,
    files: [
      {
        path: 'bin/mock.sh',
        kind: 'file',
        size: sharedBytes.length,
        sha256: hash(sharedBytes),
        mode: 0o755,
      },
    ],
  };
  const guest = path.join(root, 'guest');
  await fs.mkdir(path.join(guest, 'var/lib/daban-executor'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(guest, 'var/lib/daban-executor/provision.json'),
    '{"id":"mock-fresh-image"}',
    { mode: 0o600 },
  );
  const calls: { program: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const physical = (file: string) => path.join(guest, file.replace(/^\//, ''));
  let temporary = 0;
  const run = async (program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    calls.push({ program, args, env: settings.env });
    assert.equal(program, '/mock/tools/limactl');
    if (args.includes('sha256sum'))
      return { code: 0, stdout: `${hash(await fs.readFile(physical(args.at(-1)!)))}  synthetic\n` };
    if (args.includes('mktemp')) {
      const name = `/tmp/daban-restore.MOCK${String(++temporary).padStart(12, '0')}`;
      await fs.mkdir(physical(name), { recursive: true, mode: 0o700 });
      return { code: 0, stdout: `${name}\n` };
    }
    if (args[0] === 'copy') {
      await fs.copyFile(args[1], physical(args[2].slice(args[2].indexOf(':') + 1)));
      return { code: 0, stdout: '' };
    }
    if (args.includes('chmod')) {
      await fs.chmod(physical(args.at(-1)!), Number.parseInt(args.at(-2)!, 8));
      return { code: 0, stdout: '' };
    }
    if (args.includes('--manifest-hash')) {
      const value = (flag: string) => args[args.indexOf(flag) + 1];
      const result = await restoreWorker({
        root: guest,
        archive: physical(value('--archive')),
        archiveHash: value('--archive-hash'),
        manifestHash: value('--manifest-hash'),
        target: value('--target'),
        provision: value('--provision'),
        owner: { uid: process.getuid!(), gid: process.getgid!() },
      });
      return { code: 0, stdout: JSON.stringify(result) };
    }
    if (args.includes('rm')) {
      await fs.rm(physical(args.at(-1)!), { recursive: true, force: true });
      return { code: 0, stdout: '' };
    }
    return { code: 0, stdout: '' };
  };
  return {
    root,
    directory,
    guest,
    key,
    browserBytes,
    sharedBytes,
    sharedFile,
    calls,
    run,
    options: {
      config: {
        limactl: '/mock/tools/limactl',
        limaHome: '/mock/lima',
        vm: 'mock-fresh',
        port: 19890,
      },
      directory,
      cacheDirectory,
      browser,
      shared,
      credentialFile,
      helperEntry,
    },
  };
}

test('host sends only verified public data to the fresh guest and completed replay preserves later edits', async () => {
  const f = await fixture();
  try {
    const result = await restorePublicData(f.options, { run: f.run });
    assert.equal(result.files, 2);
    assert.equal(result.browserFiles, 1);
    assert.equal(result.sharedFiles, 1);
    const browser = path.join(f.guest, 'var/lib/bot-prototype/profile/Default/Preferences');
    const script = path.join(f.guest, 'var/lib/bot-prototype/desktops/shared/bin/mock.sh');
    assert.deepEqual(await fs.readFile(browser), f.browserBytes);
    assert.deepEqual(await fs.readFile(script), f.sharedBytes);
    assert.equal((await fs.lstat(script)).mode & 0o777, 0o755);
    assert.equal(JSON.stringify(f.calls).includes(f.key), false);
    assert.equal(
      f.calls.some((call) => call.args[0] === 'start' || call.args[0] === 'stop'),
      false,
    );
    const copies = f.calls.filter((call) => call.args[0] === 'copy').length;
    await fs.writeFile(browser, 'SYNTHETIC LATER USER EDIT');
    assert.deepEqual(await restorePublicData(f.options, { run: f.run }), result);
    assert.equal(await fs.readFile(browser, 'utf8'), 'SYNTHETIC LATER USER EDIT');
    assert.equal(f.calls.filter((call) => call.args[0] === 'copy').length, copies);
    await assert.rejects(
      restorePublicData(
        { ...f.options, config: { ...f.options.config, vm: 'mock-other' } },
        { run: f.run },
      ),
      /^Error: MIGRATION_TARGET_CHANGED$/,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('provider key bytes in public files block all uploads and no private payload enters command arguments', async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(
      restorePublicData(f.options, { run: f.run }),
      /^Error: MIGRATION_SECRET_IN_PUBLIC$/,
    );
    assert.equal(
      f.calls.some((call) => call.args[0] === 'copy'),
      false,
    );
    assert.equal(JSON.stringify(f.calls).includes(f.key), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('unlisted links and changed source hashes are rejected before archive upload', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.sharedFile, 'SYNTHETIC CHANGED SOURCE');
    await assert.rejects(
      restorePublicData(f.options, { run: f.run }),
      /^Error: MIGRATION_INTEGRITY_FAILED$/,
    );
    assert.equal(
      f.calls.some((call) => call.args[0] === 'copy'),
      false,
    );
    await fs.writeFile(f.sharedFile, f.sharedBytes);
    await fs.symlink(f.options.credentialFile, path.join(f.directory, 'browser/linked-private'));
    await assert.rejects(
      restorePublicData(f.options, { run: f.run }),
      /^Error: MIGRATION_UNSAFE_PUBLIC$/,
    );
    assert.equal(
      f.calls.some((call) => call.args[0] === 'copy'),
      false,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('public manifests and worker receipts use semantic fields rather than JSON property order', async () => {
  const f = await fixture();
  f.options.shared.source = {
    imageFingerprint: f.options.shared.source.imageFingerprint,
    vm: f.options.shared.source.vm,
  };
  try {
    const result = await restorePublicData(f.options, {
      run: async (program, args, options) => {
        const reply = await f.run(program, args, options);
        if (args.includes('--manifest-hash'))
          reply.stdout = JSON.stringify(
            Object.fromEntries(Object.entries(JSON.parse(reply.stdout)).reverse()),
          );
        return reply;
      },
    });
    assert.equal(result.phase, 'complete');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('canonical PAX transfer preserves long Unicode public paths without adding private metadata', async () => {
  const f = await fixture();
  const name = `bin/${'合成目录-'.repeat(12)}tool.sh`;
  await fs.rename(f.sharedFile, path.join(f.directory, 'shared', name));
  f.options.shared.files[0].path = name;
  try {
    await restorePublicData(f.options, { run: f.run });
    assert.deepEqual(
      await fs.readFile(path.join(f.guest, 'var/lib/bot-prototype/desktops/shared', name)),
      f.sharedBytes,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
