import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const context = { commit: 'a'.repeat(40), source: 'b'.repeat(64), release: '1.2.3' };
const receipt = { id: '00000000-0000-4000-8000-000000000001', status: 'Accepted' as const };
const names = [
  'runtime-signed.zip',
  'linux.json',
  'Daban-lima-macos-arm64.tar.gz',
  'Daban-executor-linux-arm64.tar.gz',
];
async function api() {
  const value = await import('./checkpoint.ts').catch(() => undefined);
  expect(value, 'verified release checkpoints are required before jobs can resume').toBeDefined();
  if (!value) throw Error('CHECKPOINT_REQUIRED');
  return value;
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-release-checkpoint-'));
  const directory = path.join(root, 'checkpoint');
  await mkdir(directory);
  for (const name of names) await writeFile(path.join(directory, name), 'SYNTHETIC ' + name);
  return { root, directory };
}

test('freezes accepted preparation with exact source and file digests', async (t) => {
  const checkpoint = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const metadata = { ...context, phase: 'runtime-prepared' as const, cached: false, receipt };
  await checkpoint.writeCheckpoint(f.directory, metadata);
  const saved = await checkpoint.readCheckpoint(f.directory, context, 'runtime-prepared');
  expect(saved).toMatchObject(metadata);
  expect(saved.files.map((file) => file.name).sort()).toStrictEqual([...names].sort());
  for (const file of saved.files) {
    expect(file.sha256).toBe(
      createHash('sha256')
        .update('SYNTHETIC ' + file.name)
        .digest('hex'),
    );
    expect(file.bytes).toBe(Buffer.byteLength('SYNTHETIC ' + file.name));
  }
  await expect(checkpoint.writeCheckpoint(f.directory, metadata)).rejects.toThrow();
});

test('rejects stale source, release, phase and changed frozen bytes', async (t) => {
  const checkpoint = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await checkpoint.writeCheckpoint(f.directory, {
    ...context,
    phase: 'runtime-prepared',
    cached: false,
    receipt,
  });
  for (const changed of [
    { ...context, commit: 'c'.repeat(40) },
    { ...context, source: 'd'.repeat(64) },
    { ...context, release: '1.2.4' },
  ])
    await expect(
      checkpoint.readCheckpoint(f.directory, changed, 'runtime-prepared'),
    ).rejects.toThrow(/CHECKPOINT/);
  await expect(checkpoint.readCheckpoint(f.directory, context, 'runtime-ready')).rejects.toThrow(
    /CHECKPOINT/,
  );
  await writeFile(path.join(f.directory, 'runtime-signed.zip'), 'SYNTHETIC CHANGED BYTES');
  await expect(checkpoint.readCheckpoint(f.directory, context, 'runtime-prepared')).rejects.toThrow(
    /CHECKPOINT/,
  );
});

test.each([false, true])(
  'refuses linked checkpoint files even when bytes match (%s)',
  async (hard) => {
    const checkpoint = await api();
    const f = await fixture();
    try {
      await checkpoint.writeCheckpoint(f.directory, {
        ...context,
        phase: 'runtime-prepared',
        cached: false,
        receipt,
      });
      const outside = path.join(f.root, 'outside.zip');
      await writeFile(outside, 'SYNTHETIC runtime-signed.zip');
      await unlink(path.join(f.directory, 'runtime-signed.zip'));
      if (hard) await link(outside, path.join(f.directory, 'runtime-signed.zip'));
      else await symlink(outside, path.join(f.directory, 'runtime-signed.zip'));
      await expect(
        checkpoint.readCheckpoint(f.directory, context, 'runtime-prepared'),
      ).rejects.toThrow(/CHECKPOINT/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('refuses a checkpoint directory alias before reading frozen files', async (t) => {
  const checkpoint = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await checkpoint.writeCheckpoint(f.directory, {
    ...context,
    phase: 'runtime-prepared',
    cached: false,
    receipt,
  });
  const alias = path.join(f.root, 'alias');
  await symlink(f.directory, alias, 'junction');
  await expect(checkpoint.readCheckpoint(alias, context, 'runtime-prepared')).rejects.toThrow(
    /CHECKPOINT/,
  );
});

test.each(['receipt', 'escape', 'extra', 'missing'])(
  'rejects unsafe checkpoint metadata and unexpected inputs (%s)',
  async (mode) => {
    const checkpoint = await api();
    const f = await fixture();
    try {
      await checkpoint.writeCheckpoint(f.directory, {
        ...context,
        phase: 'runtime-prepared',
        cached: false,
        receipt,
      });
      const file = path.join(f.directory, 'checkpoint.json');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (mode === 'receipt') saved.receipt.status = 'Invalid';
      if (mode === 'escape') saved.files[0].name = '../outside.zip';
      if (mode === 'missing') saved.files.pop();
      if (mode === 'extra')
        await writeFile(
          path.join(f.directory, 'signing.keychain-db'),
          'SYNTHETIC PRIVATE MATERIAL',
        );
      await writeFile(file, JSON.stringify(saved));
      await expect(
        checkpoint.readCheckpoint(f.directory, context, 'runtime-prepared'),
      ).rejects.toThrow(/CHECKPOINT/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('binds client preparation to the exact runtime reference and accepted submission', async (t) => {
  const checkpoint = await api();
  const root = await mkdtemp(path.join(tmpdir(), 'mock-client-checkpoint-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'client-signed.zip'), 'SYNTHETIC SIGNED CLIENT');
  await writeFile(path.join(root, 'Daban-1.2.3-macos-arm64.dmg'), 'SYNTHETIC SIGNED IMAGE');
  const runtime = 'c'.repeat(64);
  await checkpoint.writeCheckpoint(root, {
    ...context,
    phase: 'client-prepared',
    receipt,
    runtime,
  });
  expect(await checkpoint.readCheckpoint(root, context, 'client-prepared')).toMatchObject({
    runtime,
    receipt,
  });
});

test('preserves the generated prerelease update channel in completed client checkpoints', async (t) => {
  const checkpoint = await api();
  const root = await mkdtemp(path.join(tmpdir(), 'mock-prerelease-checkpoint-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const value = {
    ...context,
    release: '1.2.3-beta.1',
    phase: 'client-ready' as const,
    receipt,
    runtime: 'c'.repeat(64),
    update: 'beta-mac.yml',
  };
  for (const name of [
    'Daban-1.2.3-beta.1-macos-arm64.dmg',
    'Daban-1.2.3-beta.1-macos-arm64.zip',
    'Daban-1.2.3-beta.1-macos-arm64.zip.blockmap',
    'beta-mac.yml',
  ])
    await writeFile(path.join(root, name), 'SYNTHETIC DISTRIBUTION');
  await checkpoint.writeCheckpoint(root, value);
  expect(await checkpoint.readCheckpoint(root, value, 'client-ready')).toMatchObject({
    update: 'beta-mac.yml',
  });
});
