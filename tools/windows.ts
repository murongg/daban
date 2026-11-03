import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentIndex } from '@daban/engine/component';
import { packageNative } from './native.ts';
import { packageNotices } from './notices.ts';

assert.equal(process.platform, 'win32', 'WINDOWS_BUILD_REQUIRED');
assert.equal(process.arch, 'x64', 'WINDOWS_X64_REQUIRED');
const [output, referenceFile] = process.argv.slice(2);
assert.ok(
  output && referenceFile,
  'Usage: bundle:windows -- <new-output-folder> <runtime-reference.json>',
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
await rm(path.join(target, 'resources/default_app.asar'), { force: true });
await packageNotices(path.join(target, 'resources'), path.join(root, 'apps/desktop/package.json'));
