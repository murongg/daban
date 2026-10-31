import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostPackageFile, moduleGraph, sealHostPackage } from './roles.ts';

test('host packaging excludes source directories but preserves web and runtime modules in dist', () => {
  const root = '/mock/src/engine';
  assert.equal(hostPackageFile(root, `${root}/dist/web.js`), true);
  assert.equal(hostPackageFile(root, `${root}/dist/web.d.ts`), true);
  assert.equal(hostPackageFile(root, `${root}/web/diagnostic.test.ts`), false);
  assert.equal(hostPackageFile(root, `${root}/src/model.ts`), false);
  assert.equal(hostPackageFile(root, `${root}/dist/model.test.js`), false);
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
    assert.equal(sealed.files['node/bin/node'], hash('SYNTHETIC SIGNED NATIVE BYTES'));
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

test('Host sealing accepts internal links and rejects special filesystem entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-seal-special-'));
  const server = net.createServer();
  try {
    await writeFile(path.join(root, 'safe.js'), 'SYNTHETIC SAFE MODULE');
    await symlink('safe.js', path.join(root, 'alias.js'));
    const sealed = await sealHostPackage(root);
    assert.ok(sealed.files['safe.js']);
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
