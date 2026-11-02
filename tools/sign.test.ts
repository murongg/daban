import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isMachO, sealSignedLima, signApplication } from './sign.ts';

test('detects native macOS code without treating scripts and Linux guests as signable', () => {
  for (const hex of ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf'])
    assert.equal(isMachO(Buffer.from(hex, 'hex')), true);
  for (const data of [Buffer.from('#!/bin/sh'), Buffer.from('7f454c46', 'hex'), Buffer.alloc(2)])
    assert.equal(isMachO(data), false);
});

test('pins the re-signed Lima archive in both the environment and host code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-signed-lima-'));
  try {
    await mkdir(path.join(root, 'environment'));
    await mkdir(path.join(root, 'agent'));
    await writeFile(path.join(root, 'environment/lima.tar.gz'), 'SYNTHETIC SIGNED ARCHIVE');
    await writeFile(
      path.join(root, 'environment/manifest.json'),
      JSON.stringify({
        image: { sha256: 'synthetic-unchanged-image' },
        lima: { file: 'lima.tar.gz', bytes: 1, sha256: 'old' },
      }),
    );
    const result = await sealSignedLima(root);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'environment/manifest.json'), 'utf8'),
    );
    assert.deepEqual(manifest.image, { sha256: 'synthetic-unchanged-image' });
    assert.deepEqual(manifest.lima, { file: 'lima.tar.gz', ...result });
    assert.equal(
      await readFile(path.join(root, 'agent/assets.js'), 'utf8'),
      `export const limaDigest = '${result.sha256}';\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshes the host integrity seal after nested signing and before the outer signature', async () => {
  const events: string[] = [];
  await signApplication(
    '/synthetic/Daban.app',
    {
      identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
      keychain: '/synthetic/keychain',
    },
    {
      sign: async (options) => {
        assert.equal(options.identity, 'Developer ID Application: Synthetic (TESTTEAM01)');
        assert.equal(options.platform, 'darwin');
        assert.equal(options.preAutoEntitlements, false);
        assert.equal(
          options.optionsForFile?.('/synthetic/file', { platform: 'darwin' }).hardenedRuntime,
          true,
        );
        events.push('nested');
      },
      seal: async (directory) => {
        assert.equal(directory, path.join('/synthetic/Daban.app', 'Contents/Resources/agent'));
        events.push('seal');
      },
      run: async (program, args) => {
        assert.equal(program, '/usr/bin/codesign');
        if (args.includes('--sign')) {
          assert.ok(args.includes('--timestamp'));
          assert.ok(args.includes('runtime'));
          assert.equal(args.includes('--deep'), false);
          events.push('outer');
        } else {
          assert.ok(args.includes('--verify'));
          events.push('verify');
        }
        return '';
      },
    },
  );
  assert.deepEqual(events, ['nested', 'seal', 'outer', 'verify']);
});

test('release signing rejects ad-hoc identities before touching an artifact', async () => {
  await assert.rejects(
    signApplication('/synthetic/Daban.app', { identity: '-' }),
    /DEVELOPER_ID_REQUIRED/,
  );
});
