import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isMachO,
  notarizeDistribution,
  sealSignedLima,
  signApplication,
  signRuntime,
} from './sign.ts';

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

test('signs native code and bundles while treating compressed guest images as data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-signing-files-'));
  try {
    const app = path.join(root, 'Synthetic.app');
    await mkdir(app);
    const native = path.join(app, 'synthetic.node');
    const image = path.join(app, 'system.raw.gz');
    await writeFile(native, Buffer.from('cffaedfe00000000', 'hex'));
    await writeFile(image, Buffer.from('1f8b080000000000', 'hex'));
    await signApplication(
      app,
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      {
        sign: async (options) => {
          assert.equal(typeof options.ignore, 'function');
          if (typeof options.ignore !== 'function') throw Error('SIGNING_FILTER_MISSING');
          assert.equal(options.ignore(app), false);
          assert.equal(options.ignore(native), false);
          assert.equal(options.ignore(image), true);
        },
        seal: async () => undefined,
        run: async () => '',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('submits only the outer disk image and validates tickets for both download formats', async () => {
  const events: string[] = [];
  await notarizeDistribution(
    '/synthetic/Daban.app',
    '/synthetic/Daban.dmg',
    {
      identity: 'Developer ID Application: Synthetic (TESTTEAM01)',
    },
    {
      submit: async (file) => {
        events.push(`submit:${file}`);
      },
      run: async (_program, args) => {
        events.push(args.join(' '));
        return '';
      },
    },
  );
  assert.equal(events.filter((event) => event.startsWith('submit:')).length, 1);
  assert.equal(events[0], 'submit:/synthetic/Daban.dmg');
  for (const file of ['/synthetic/Daban.app', '/synthetic/Daban.dmg']) {
    assert.ok(events.includes(`stapler staple ${file}`));
    assert.ok(events.includes(`stapler validate ${file}`));
    assert.ok(events.some((event) => event.startsWith('--assess') && event.endsWith(file)));
  }
});

test('reports bounded signing command output without dumping unrelated process metadata', async () => {
  const { signingDiagnostics } = await import('./sign.ts');
  const failure = Object.assign(new Error('Synthetic signing command failed'), {
    stdout: 'Synthetic ticket validation detail',
    stderr: 'Synthetic command error',
    env: { SYNTHETIC_PRIVATE_VALUE: 'must-not-be-dumped' },
  });
  assert.deepEqual(signingDiagnostics(failure), [
    'stdout:\nSynthetic ticket validation detail',
    'stderr:\nSynthetic command error',
  ]);
  assert.deepEqual(signingDiagnostics(new Error('Synthetic ordinary error')), []);
  assert.deepEqual(signingDiagnostics(null), []);
  const output = signingDiagnostics({ stdout: 'x'.repeat(20000), stderr: undefined });
  assert.equal(output[0].length, 'stdout:\n'.length + 16000);
});

test('signs the runtime code, refreshes its host manifest, then seals the outer runtime app', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-sign-runtime-'));
  try {
    const app = path.join(root, 'DabanRuntime.app');
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(app, 'Contents/MacOS/agent'), Buffer.from('cffaedfe00000000', 'hex'));
    const events: string[] = [];
    await signRuntime(
      app,
      { identity: 'Developer ID Application: Synthetic (TESTTEAM01)' },
      {
        run: async (_program, args) => {
          events.push(
            args.includes('--verify') ? 'verify' : args.at(-1) === app ? 'outer' : 'native',
          );
          return '';
        },
        seal: async () => {
          events.push('seal');
        },
      },
    );
    assert.deepEqual(events, ['native', 'seal', 'outer', 'verify']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
