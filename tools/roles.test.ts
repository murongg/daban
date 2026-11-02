import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as roles from './roles.ts';
import { hostPackageFile, moduleGraph, sealHostPackage } from './roles.ts';

test('desktop executor overrides must match the current compiled role instead of silently shipping stale DNS code', async () => {
  const verify = Reflect.get(roles, 'verifyExecutorBuild') as
    | ((archive: string, root: string) => Promise<unknown>)
    | undefined;
  assert.equal(typeof verify, 'function', 'executor override verification is required');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-executor-build-'));
  try {
    const guest = path.join(root, 'guest');
    const engine = path.join(root, 'packages/engine/dist');
    const protocol = path.join(root, 'packages/protocol/dist');
    const archivedEngine = path.join(guest, 'node_modules/@daban/engine/dist');
    await mkdir(engine, { recursive: true });
    await mkdir(protocol, { recursive: true });
    await mkdir(path.join(root, 'dist-runtime'));
    await mkdir(archivedEngine, { recursive: true });
    await mkdir(path.join(guest, 'node_modules/@daban/protocol/dist'), { recursive: true });
    for (const name of [
      'executor.js',
      'extract.js',
      'desktop-files.js',
      'app.js',
      'fixture.js',
      'web.js',
    ]) {
      const source =
        name === 'executor.js' ? "import './web.js';" : 'export const value="SYNTHETIC CURRENT";';
      await writeFile(path.join(engine, name), source);
      await writeFile(path.join(archivedEngine, name), source);
    }
    for (const file of [
      path.join(protocol, 'index.js'),
      path.join(guest, 'node_modules/@daban/protocol/dist/index.js'),
      path.join(root, 'dist-runtime/main.js'),
      path.join(guest, 'main.js'),
    ])
      await writeFile(file, 'export const mock=1;');
    const archive = path.join(root, 'executor.tar.gz');
    const pack = () =>
      execFileSync('tar', ['-czf', archive, '-C', guest, 'main.js', 'node_modules']);
    pack();
    await verify!(archive, root);
    await writeFile(path.join(archivedEngine, 'web.js'), 'export const value="SYNTHETIC OLD";');
    pack();
    await assert.rejects(verify!(archive, root), /EXECUTOR_BUILD_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host packaging excludes source directories but preserves web and runtime modules in dist', () => {
  const root = '/mock/src/engine';
  assert.equal(hostPackageFile(root, `${root}/dist/web.js`), true);
  assert.equal(hostPackageFile(root, `${root}/dist/web.d.ts`), true);
  assert.equal(hostPackageFile(root, `${root}/web/diagnostic.test.ts`), false);
  assert.equal(hostPackageFile(root, `${root}/src/model.ts`), false);
  assert.equal(hostPackageFile(root, `${root}/dist/model.test.js`), false);
  assert.equal(hostPackageFile(root, `${root}/dist/documents.fixture.js`), false);
  assert.equal(hostPackageFile(root, `${root}/dist/images.fixture.d.ts`), false);
  assert.equal(hostPackageFile(root, `${root}/dist/tls.fixture.js`), false);
  assert.equal(hostPackageFile(root, `${root}/node_modules/mock/index.js`), false);
});

test('role graph follows actual compiled edges and refuses cross-role root escape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-role-'));
  try {
    await writeFile(
      path.join(root, 'main.js'),
      "import './safe.js'; export const role='executor';",
    );
    await writeFile(path.join(root, 'safe.js'), 'export const mock=1;');
    assert.deepEqual(await moduleGraph(root, ['main.js']), ['main.js', 'safe.js']);
    await writeFile(path.join(root, 'main.js'), "import '../host.js';");
    await assert.rejects(moduleGraph(root, ['main.js']), /ROLE_IMPORT_ESCAPE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host seals cover late Guest archives and changed native bytes without hashing themselves', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-seal-'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(path.join(root, 'node/bin'), { recursive: true });
    await writeFile(path.join(root, 'main.js'), 'SYNTHETIC HOST MODULE');
    await writeFile(path.join(root, 'node/bin/node'), 'SYNTHETIC UNSIGNED NATIVE BYTES');
    await sealHostPackage(root);
    await writeFile(path.join(root, 'executor.tar.gz'), 'SYNTHETIC GUEST ARCHIVE');
    await writeFile(path.join(root, 'node/bin/node'), 'SYNTHETIC SIGNED NATIVE BYTES');
    const sealed = await sealHostPackage(root);
    assert.equal(sealed.node, '24.22.1');
    assert.equal(sealed.dsh, '0.2.1-rc.3');
    assert.equal(sealed.files['executor.tar.gz'], hash('SYNTHETIC GUEST ARCHIVE'));
    assert.equal(
      sealed.files[path.join('node', 'bin', 'node')],
      hash('SYNTHETIC SIGNED NATIVE BYTES'),
    );
    assert.equal(Object.hasOwn(sealed.files, 'manifest.json'), false);
    assert.deepEqual(await sealHostPackage(root), sealed);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')), sealed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host sealing rejects escaping links and never overwrites an external manifest target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-seal-link-'));
  const target = path.join(root, 'package');
  const outside = path.join(root, 'outside.txt');
  await mkdir(target);
  await writeFile(outside, 'SYNTHETIC PRESERVED OUTSIDE FILE');
  try {
    await symlink(outside, path.join(target, 'escape'));
    await assert.rejects(sealHostPackage(target), /HOST_PACKAGE_LINK_ESCAPE/);
    await assert.rejects(lstat(path.join(target, 'manifest.json')), { code: 'ENOENT' });
    await rm(path.join(target, 'escape'));
    await symlink(outside, path.join(target, 'manifest.json'));
    await assert.rejects(sealHostPackage(target), /HOST_PACKAGE_(?:LINK_ESCAPE|MANIFEST_UNSAFE)/);
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC PRESERVED OUTSIDE FILE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host sealing accepts internal links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-seal-special-'));
  try {
    await writeFile(path.join(root, 'safe.js'), 'SYNTHETIC SAFE MODULE');
    await symlink('safe.js', path.join(root, 'alias.js'));
    const sealed = await sealHostPackage(root);
    assert.ok(sealed.files['safe.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Named pipes are not filesystem entries on Windows; its private pipe coverage lives in private-channel.test.
test('Host sealing rejects POSIX filesystem socket entries', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-seal-socket-'));
  const server = net.createServer();
  try {
    await new Promise<unknown>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(root, 'socket'), () => resolve(undefined));
    });
    await assert.rejects(sealHostPackage(root), /HOST_PACKAGE_ENTRY_UNSAFE/);
  } finally {
    if (server.listening)
      await new Promise<unknown>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    await rm(root, { recursive: true, force: true });
  }
});
