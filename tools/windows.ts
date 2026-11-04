import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { componentAsset, componentIndex } from '@daban/engine/component';
import { hashAsset } from './environment.ts';
import { packageNative } from './native.ts';
import { packageNotices } from './notices.ts';

assert.equal(process.platform, 'win32', 'WINDOWS_BUILD_REQUIRED');
assert.equal(process.arch, 'x64', 'WINDOWS_X64_REQUIRED');
const [output, referenceFile, qemuDirectory, runtimeArchive] = process.argv.slice(2);
assert.ok(
  output && referenceFile,
  'Usage: bundle:windows -- <new-output-folder> <runtime-reference.json> [<qemu-environment> <runtime.zip>]',
);
assert.equal(
  !!qemuDirectory,
  !!runtimeArchive,
  'COMPLETE_PACKAGE_REQUIRES_ENVIRONMENT_AND_RUNTIME',
);
const root = fileURLToPath(new URL('..', import.meta.url)),
  target = path.resolve(output);
await mkdir(path.dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const electron = path.join(path.dirname(requireDesktop.resolve('electron/package.json')), 'dist');
for (const entry of await readdir(electron))
  await cp(path.join(electron, entry), path.join(target, entry), {
    recursive: true,
    filter: (file) =>
      path.basename(path.dirname(file)) !== 'locales' ||
      !file.endsWith('.pak') ||
      /^(?:en(?:[-_].*)?|zh[-_]CN(?:_.*)?)\.pak$/i.test(path.basename(file)),
    force: false,
    errorOnExist: true,
  });
await rename(path.join(target, 'electron.exe'), path.join(target, 'Daban.exe'));
const frontend = path.join(target, 'resources/app');
await mkdir(frontend);
await cp(path.join(root, 'dist'), path.join(frontend, 'dist'), { recursive: true });
await cp(path.join(root, 'dist-electron'), path.join(frontend, 'dist-electron'), {
  recursive: true,
});
const manifest = JSON.parse(
  await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'),
) as { version: string };
await writeFile(
  path.join(frontend, 'package.json'),
  JSON.stringify({ name: 'daban', version: manifest.version, main: 'dist-electron/main.cjs' }),
);
await packageNative(frontend, path.join(root, 'apps/desktop/package.json'));
const reference = JSON.parse(await readFile(path.resolve(referenceFile), 'utf8'));
componentIndex(reference, reference.id);
await writeFile(path.join(target, 'resources/runtime.json'), JSON.stringify(reference));
if (qemuDirectory && runtimeArchive) {
  const install: typeof import('../apps/agent/src/qemu-install.ts') = await import(
    pathToFileURL(path.join(root, 'dist-agent/qemu-install.js')).href
  );
  const qemu: typeof import('../apps/agent/src/qemu.ts') = await import(
    pathToFileURL(path.join(root, 'dist-agent/qemu.js')).href
  );
  const source = path.resolve(qemuDirectory),
    bundle = await install.readQemuBundle(source);
  const image = await qemu.qemuFileHash(path.join(source, 'desktop.qcow2.gz'));
  assert.equal(image.bytes, bundle.image.bytes);
  assert.equal(image.sha256, bundle.image.sha256);
  assert.equal(
    (await qemu.qemuFileHash(path.join(source, 'tools/manifest.json'))).sha256,
    bundle.toolsId,
  );
  const asset = componentAsset(componentIndex(reference, reference.id), 'win32', 'x64');
  const runtime = await hashAsset(path.resolve(runtimeArchive), 'sha256');
  assert.equal(runtime.bytes, asset.bytes);
  assert.equal(runtime.digest, asset.sha256);
  const environment = path.join(target, 'resources/environment/qemu');
  await mkdir(environment, { recursive: true });
  for (const name of ['qemu.json', 'desktop.qcow2.gz', 'COMPONENTS.md', 'provenance.json'])
    await copyFile(path.join(source, name), path.join(environment, name));
  await cp(path.join(source, 'tools'), path.join(environment, 'tools'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await copyFile(path.resolve(runtimeArchive), path.join(target, 'resources/runtime.zip'));
}
await rm(path.join(target, 'resources/default_app.asar'), { force: true });
await packageNotices(path.join(target, 'resources'), path.join(root, 'apps/desktop/package.json'));
