import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isSourceReaderEntry, SourceReader } from './source-reader.js';

const source = { vm: 'mock-old', imageFingerprint: 'a'.repeat(64) };
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
test('importing reader validators into a host entry cannot activate the guest reader role', () => {
  assert.equal(
    isSourceReaderEntry(['/mock/node', '/mock/host.mjs'], 'file:///mock/host.mjs'),
    false,
  );
  assert.equal(
    isSourceReaderEntry(
      ['/mock/node', '/mock/reader.mjs', '--source-reader'],
      'file:///mock/reader.mjs',
    ),
    true,
  );
  assert.equal(
    isSourceReaderEntry(
      ['/mock/node', '/mock/host.mjs', '--source-reader'],
      'file:///mock/reader.mjs',
    ),
    false,
  );
});
test('the standalone helper rejects malformed metadata without printing its bytes', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./source-reader.js', import.meta.url)), '--source-reader'],
    { input: '{"apiKey":"SYNTHETIC-PRIVATE-INPUT"}', encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'SOURCE_READER_FAILED\n');
});
async function fixture(t: { after: (action: () => unknown) => unknown }) {
  const root = await mkdtemp('/tmp/mock-source-reader-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = {
    control: path.join(root, 'model'),
    browser: path.join(root, 'profile'),
    shared: path.join(root, 'shared'),
  };
  for (const value of Object.values(roots)) await mkdir(value, { mode: 0o700 });
  let active = true,
    busy = false;
  let operation: Record<string, unknown> | undefined;
  const actions: string[] = [];
  const request = async (method: string, target: string, data?: Record<string, unknown>) => {
    actions.push(`${method} ${target}`);
    if (target === '/api/state')
      return {
        model: { bots: { 'mock-a': { running: busy } } },
        groups: { items: [] },
        interactions: [{ status: 'pending', marker: 'SYNTHETIC-KEEP-APPROVAL' }],
      };
    if (target === '/api/recovery')
      return {
        available: true,
        revision: Number(operation?.revision || 0),
        ...(operation ? { operation } : {}),
      };
    if (target === '/api/recovery/review')
      return {
        boot: 'mock-boot',
        instance: 'mock-runtime',
        revision: 0,
        digest: 'b'.repeat(64),
        running: [],
        changing: false,
      };
    if (target === '/api/recovery/prepare') {
      operation = {
        id: data?.id,
        revision: 1,
        phase: 'prepared',
        review: {
          boot: 'mock-boot',
          instance: 'mock-runtime',
          revision: 0,
          digest: 'b'.repeat(64),
          running: [],
          changing: false,
        },
      };
      return operation;
    }
    if (target === '/api/recovery/cancel') {
      assert.equal(data?.id, operation?.id);
      operation = { ...operation, phase: 'cancelled', revision: 2 };
      return operation;
    }
    throw new Error('SYNTHETIC-UNEXPECTED-API');
  };
  const reader = new SourceReader(
    { roots, receiptFile: path.join(root, 'receipt.json') },
    {
      request,
      service: async (action) => {
        actions.push(`service ${action}`);
        if (action === 'stop') active = false;
        if (action === 'start') active = true;
        return active ? 'active' : 'inactive';
      },
      recovery: async () => ({ receipt: operation }),
    },
  );
  return {
    root,
    roots,
    reader,
    actions,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setOperation: (value: Record<string, unknown>) => {
      operation = value;
    },
  };
}

test('reader fences only an idle workspace, stops the service and preserves unrelated approvals on rollback', async (t) => {
  const f = await fixture(t);
  f.setBusy(true);
  await assert.rejects(f.reader.quiesce(source, 'mock-migration'), /SOURCE_BUSY/);
  assert.equal(f.actions.includes('service stop'), false);
  f.setBusy(false);
  const prepared = await f.reader.quiesce(source, 'mock-migration');
  assert.equal(prepared.serviceStopped, true);
  assert.equal(prepared.runningModels, 0);
  assert.equal(prepared.runningGroups, 0);
  assert.ok(f.actions.indexOf('POST /api/recovery/prepare') < f.actions.indexOf('service stop'));
  assert.deepEqual(await f.reader.quiesce(source, 'mock-migration'), prepared);
  assert.equal(f.actions.filter((value) => value === 'POST /api/recovery/prepare').length, 1);
  const result = await f.reader.rollback(source, 'mock-migration', prepared);
  assert.equal(result.phase, 'rolled-back');
  await f.reader.dependencies.service!('stop');
  await assert.rejects(f.reader.manifest('control', source, 'mock-migration'), /SOURCE_NOT_FROZEN/);
  assert.equal(f.actions.filter((value) => value.includes('/api/recovery/cancel')).length, 1);
  assert.equal(
    f.actions.some((value) => /interaction|reply|model\/configure/.test(value)),
    false,
  );
});

test('another recovery intent cannot be replaced or cancelled by the migration reader', async (t) => {
  const f = await fixture(t);
  f.setOperation({ id: 'mock-unrelated-intent', phase: 'prepared', revision: 1 });
  await assert.rejects(f.reader.quiesce(source, 'mock-migration'), /SOURCE_RECOVERY_CHANGED/);
  assert.equal(f.actions.includes('service stop'), false);
  assert.equal(
    f.actions.some((value) => value.startsWith('POST ')),
    false,
  );
});

test('control snapshots exclude execution/session authority and stream credentials as bytes only after close', async (t) => {
  const f = await fixture(t);
  const credential = Buffer.from([0, 255, 47, 83, 89, 78, 84, 72, 69, 84, 73, 67]);
  await writeFile(path.join(f.roots.control, 'credentials.json'), credential, { mode: 0o600 });
  await writeFile(path.join(f.roots.control, 'profiles.sqlite'), 'SYNTHETIC-SQLITE');
  await writeFile(path.join(f.roots.control, 'profiles.sqlite-wal'), 'SYNTHETIC-WAL');
  await writeFile(path.join(f.roots.control, 'control-token'), 'SYNTHETIC-TOKEN');
  await writeFile(path.join(f.roots.control, 'recovery.json'), 'SYNTHETIC-RECOVERY');
  for (const name of ['dsh', 'runs', 'autoload']) {
    await mkdir(path.join(f.roots.control, name));
    await writeFile(path.join(f.roots.control, name, 'private.json'), 'SYNTHETIC-EXCLUDED');
  }
  await assert.rejects(f.reader.manifest('control', source, 'mock-copy'), /SOURCE_NOT_FROZEN/);
  await f.reader.quiesce(source, 'mock-copy');
  const manifest = await f.reader.manifest('control', source, 'mock-copy');
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['credentials.json', 'profiles.sqlite', 'profiles.sqlite-wal'],
  );
  const entry = manifest.files[0];
  assert.equal(entry.sha256, digest(credential));
  const output: Buffer[] = [];
  for await (const chunk of f.reader.read('control', source, 'mock-copy', entry))
    output.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(output), credential);
  assert.equal(
    (await readFile(path.join(f.root, 'receipt.json'), 'utf8')).includes('SYNTHETIC-TOKEN'),
    false,
  );
});

test('public snapshots keep hidden regular tools, skip only Chrome transient links and reject moved files', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.roots.shared, '.local/bin'), { recursive: true });
  await writeFile(path.join(f.roots.shared, '.local/bin/mock-tool'), '#!/bin/sh\n', {
    mode: 0o755,
  });
  await writeFile(path.join(f.roots.browser, 'Cookies'), 'SYNTHETIC-COOKIE');
  await symlink('/mock/transient-socket', path.join(f.roots.browser, 'SingletonSocket'));
  await f.reader.quiesce(source, 'mock-public');
  const shared = await f.reader.manifest('shared', source, 'mock-public');
  assert.equal(shared.files[0].path, '.local/bin/mock-tool');
  assert.equal(shared.files[0].mode, 0o755);
  const browser = await f.reader.manifest('browser', source, 'mock-public');
  assert.deepEqual(
    browser.files.map((file) => file.path),
    ['Cookies'],
  );
  await rename(
    path.join(f.roots.browser, 'Cookies'),
    path.join(f.roots.browser, 'Cookies-retained'),
  );
  await symlink(
    path.join(f.roots.browser, 'Cookies-retained'),
    path.join(f.roots.browser, 'Cookies'),
  );
  await assert.rejects(async () => {
    for await (const _chunk of f.reader.read('browser', source, 'mock-public', browser.files[0])) {
      /* Consume the guarded stream. */
    }
  }, /SOURCE_/);
  await assert.rejects(f.reader.manifest('browser', source, 'mock-public'), /SOURCE_/);
});
