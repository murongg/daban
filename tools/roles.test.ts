import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import * as roles from './roles.ts';
import { hostPackageFile, materializeHost, moduleGraph, sealHostPackage } from './roles.ts';

test('desktop executor overrides must match the current compiled role instead of silently shipping stale DNS code', async () => {
  const verify = Reflect.get(roles, 'verifyExecutorBuild') as
    | ((archive: string, root: string) => Promise<unknown>)
    | undefined;
  expect(typeof verify, 'executor override verification is required').toBe('function');
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
    await expect(verify!(archive, root)).rejects.toThrowError(/EXECUTOR_BUILD_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host packaging excludes source directories but preserves web and runtime modules in dist', () => {
  const root = '/mock/src/engine';
  expect(hostPackageFile(root, `${root}/dist/web.js`)).toBe(true);
  expect(hostPackageFile(root, `${root}/dist/web.d.ts`)).toBe(true);
  expect(hostPackageFile(root, `${root}/web/diagnostic.test.ts`)).toBe(false);
  expect(hostPackageFile(root, `${root}/src/model.ts`)).toBe(false);
  expect(hostPackageFile(root, `${root}/dist/model.test.js`)).toBe(false);
  expect(hostPackageFile(root, `${root}/dist/documents.fixture.js`)).toBe(false);
  expect(hostPackageFile(root, `${root}/dist/images.fixture.d.ts`)).toBe(false);
  expect(hostPackageFile(root, `${root}/dist/tls.fixture.js`)).toBe(false);
  expect(hostPackageFile(root, `${root}/node_modules/mock/index.js`)).toBe(false);
  expect(hostPackageFile(root, `${root}/drizzle/chats/0000_baseline/migration.sql`)).toBe(false);
});

test('role graph follows actual compiled edges and refuses cross-role root escape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-role-'));
  try {
    await writeFile(
      path.join(root, 'main.js'),
      "import './safe.js'; export const role='executor';",
    );
    await writeFile(path.join(root, 'safe.js'), 'export const mock=1;');
    expect(await moduleGraph(root, ['main.js'])).toStrictEqual(['main.js', 'safe.js']);
    await writeFile(path.join(root, 'main.js'), "import '../host.js';");
    await expect(moduleGraph(root, ['main.js'])).rejects.toThrowError(/ROLE_IMPORT_ESCAPE/);
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
    expect(sealed.node).toBe('24.22.1');
    expect(sealed.dsh).toBe('0.2.1-rc.3');
    expect(sealed.files['executor.tar.gz']).toBe(hash('SYNTHETIC GUEST ARCHIVE'));
    expect(sealed.files[path.join('node', 'bin', 'node')]).toBe(
      hash('SYNTHETIC SIGNED NATIVE BYTES'),
    );
    expect(Object.hasOwn(sealed.files, 'manifest.json')).toBe(false);
    expect(await sealHostPackage(root)).toStrictEqual(sealed);
    expect(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))).toStrictEqual(
      sealed,
    );
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
    await expect(sealHostPackage(target)).rejects.toThrowError(/HOST_PACKAGE_LINK_ESCAPE/);
    await expect(lstat(path.join(target, 'manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(path.join(target, 'escape'));
    await symlink(outside, path.join(target, 'manifest.json'));
    await expect(sealHostPackage(target)).rejects.toThrowError(
      /HOST_PACKAGE_(?:LINK_ESCAPE|MANIFEST_UNSAFE)/,
    );
    expect(await readFile(outside, 'utf8')).toBe('SYNTHETIC PRESERVED OUTSIDE FILE');
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
    expect.assert(sealed.files['safe.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializes npm junctions without replacing untouched runtime files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-materialize-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vendor = path.join(root, 'vendor/mock-module');
  await mkdir(vendor, { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'main.js'), 'SYNTHETIC MAIN');
  await writeFile(path.join(vendor, 'index.js'), 'SYNTHETIC DEPENDENCY');
  const nested = path.join(root, 'vendor/mock-base');
  await mkdir(nested);
  await writeFile(path.join(nested, 'base.js'), 'SYNTHETIC NESTED DEPENDENCY');
  await mkdir(path.join(vendor, 'node_modules'));
  await symlink(nested, path.join(vendor, 'node_modules/mock-base'), 'junction');
  await symlink(vendor, path.join(root, 'node_modules/mock-module'), 'junction');
  const original = await lstat(path.join(root, 'main.js'));
  await materializeHost(root);
  expect((await lstat(path.join(root, 'node_modules/mock-module'))).isSymbolicLink()).toBe(false);
  expect(await readFile(path.join(root, 'node_modules/mock-module/index.js'), 'utf8')).toBe(
    'SYNTHETIC DEPENDENCY',
  );
  const installed = path.join(root, 'node_modules/mock-module/node_modules/mock-base');
  expect((await lstat(installed)).isSymbolicLink()).toBe(false);
  expect(await readFile(path.join(installed, 'base.js'), 'utf8')).toBe(
    'SYNTHETIC NESTED DEPENDENCY',
  );
  await writeFile(path.join(vendor, 'index.js'), 'SYNTHETIC LATER VENDOR EDIT');
  expect(await readFile(path.join(root, 'node_modules/mock-module/index.js'), 'utf8')).toBe(
    'SYNTHETIC DEPENDENCY',
  );
  const after = await lstat(path.join(root, 'main.js'));
  expect([after.dev, after.ino, after.mtimeMs]).toStrictEqual([
    original.dev,
    original.ino,
    original.mtimeMs,
  ]);
});

test('materialization refuses external junctions without copying or changing their targets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-materialize-escape-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'package');
  const outside = path.join(root, 'outside');
  await mkdir(target);
  await mkdir(outside);
  await writeFile(path.join(outside, 'preserved.txt'), 'SYNTHETIC OUTSIDE');
  await symlink(outside, path.join(target, 'escape'), 'junction');
  await expect(materializeHost(target)).rejects.toThrowError(/HOST_PACKAGE_LINK_ESCAPE/);
  expect((await lstat(path.join(target, 'escape'))).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(outside, 'preserved.txt'), 'utf8')).toBe('SYNTHETIC OUTSIDE');
});

test('validates nested links before replacing any npm junction', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-nested-materialize-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'package');
  const vendor = path.join(root, 'vendor/mock-module');
  const outside = path.join(directory, 'outside');
  await mkdir(vendor, { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(outside);
  await writeFile(path.join(outside, 'preserved.txt'), 'SYNTHETIC OUTSIDE');
  const junction = path.join(root, 'node_modules/mock-module');
  await symlink(vendor, junction, 'junction');
  await symlink(outside, path.join(vendor, 'escape'), 'junction');
  await expect(materializeHost(root)).rejects.toThrowError(/HOST_PACKAGE_LINK_ESCAPE/);
  expect((await lstat(junction)).isSymbolicLink()).toBe(true);
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
    await expect(sealHostPackage(root)).rejects.toThrowError(/HOST_PACKAGE_ENTRY_UNSAFE/);
  } finally {
    if (server.listening)
      await new Promise<unknown>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    await rm(root, { recursive: true, force: true });
  }
});
