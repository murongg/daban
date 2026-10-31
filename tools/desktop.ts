import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentVersions, verifyAsset } from './environment.ts';
import { writeIcon } from './icon.ts';

// Build-time macOS app assembly. Never reuse a user directory or package a Lima home.
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const [payloadArgument, outputArgument] = process.argv.slice(2);
assert.ok(
  payloadArgument && outputArgument,
  'Usage: bundle:desktop -- <environment-pack> <new-output-directory>',
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payload = await realpath(payloadArgument);
const output = path.resolve(outputArgument);
const manifest = JSON.parse(await readFile(path.join(payload, 'manifest.json'), 'utf8')) as {
  platform: string;
  arch: string;
  versions: typeof environmentVersions;
  image: { file: string; bytes: number; sha256: string };
  lima: { file: string; bytes: number; sha256: string };
};
assert.equal(manifest.platform, 'darwin');
assert.equal(manifest.arch, 'arm64');
assert.deepEqual(manifest.versions, environmentVersions);
assert.equal(manifest.image.file, 'system.raw.gz');
assert.equal(manifest.lima.file, 'lima.tar.gz');
for (const asset of [manifest.image, manifest.lima])
  assert.equal(
    await verifyAsset(path.join(payload, asset.file), 'sha256', asset.sha256),
    asset.bytes,
  );
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const electron: string = requireDesktop('electron');
const source = path.resolve(electron, '../../..');
assert.equal(path.basename(source), 'Electron.app');
assert.ok((await stat(path.join(root, 'dist-electron/main.cjs'))).isFile());
assert.ok((await stat(path.join(root, 'dist/index.html'))).isFile());
await mkdir(output, { mode: 0o700 });
const target = path.join(output, 'daban.app');
await cp(source, target, {
  recursive: true,
  verbatimSymlinks: true,
  force: false,
  errorOnExist: true,
  mode: constants.COPYFILE_FICLONE,
});
// Preserve framework links verbatim: Node's default copy otherwise points back into node_modules.
for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const resolved = await realpath(path.join(entry.parentPath, entry.name));
  assert.ok(resolved.startsWith(target + path.sep), 'APP_LINK_ESCAPES_BUNDLE');
}
await rename(
  path.join(target, 'Contents/MacOS/Electron'),
  path.join(target, 'Contents/MacOS/daban'),
);
const resources = path.join(target, 'Contents/Resources');
const app = path.join(resources, 'app');
await mkdir(app);
await cp(path.join(root, 'dist'), path.join(app, 'dist'), {
  recursive: true,
  verbatimSymlinks: true,
  force: false,
  errorOnExist: true,
  mode: constants.COPYFILE_FICLONE,
});
await cp(path.join(root, 'dist-electron'), path.join(app, 'dist-electron'), {
  recursive: true,
  verbatimSymlinks: true,
  force: false,
  errorOnExist: true,
  mode: constants.COPYFILE_FICLONE,
});
const info = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8')) as {
  version: string;
};
await writeFile(
  path.join(app, 'package.json'),
  JSON.stringify(
    { name: 'daban', version: info.version, main: 'dist-electron/main.cjs' },
    null,
    2,
  ) + '\n',
);
const environment = path.join(resources, 'environment');
await mkdir(environment);
for (const file of ['manifest.json', 'system.raw.gz', 'lima.tar.gz', 'COMPONENTS.md'])
  await copyFile(
    path.join(payload, file),
    path.join(environment, file),
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
for (const file of ['LICENSE', 'LICENSES.chromium.html'])
  await copyFile(
    path.join(path.dirname(source), file),
    path.join(resources, file),
    constants.COPYFILE_EXCL,
  );
await writeIcon(
  path.join(root, 'apps/desktop/public/app-icon.png'),
  path.join(resources, 'daban.icns'),
);
const plist = path.join(target, 'Contents/Info.plist');
const frontendNotices = path.join(resources, 'frontend-notices');
await mkdir(frontendNotices);
for (const [name, names] of [
  ['dompurify', ['LICENSE', 'LICENSE-MPL']],
  ['katex', ['LICENSE']],
  ['mermaid', ['LICENSE']],
] as const) {
  const directory = path.dirname(path.dirname(requireDesktop.resolve(name)));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name, name);
  for (const file of names)
    await copyFile(
      path.join(directory, file),
      path.join(frontendNotices, `${name}-${file}`),
      constants.COPYFILE_EXCL,
    );
}
await copyFile(
  path.join(root, 'apps/desktop/licenses/remark-math-LICENSE'),
  path.join(frontendNotices, 'remark-math-LICENSE'),
  constants.COPYFILE_EXCL,
);
await cp(
  path.join(root, 'apps/desktop/licenses/controls'),
  path.join(frontendNotices, 'controls'),
  { recursive: true, force: false, errorOnExist: true },
);
for (const [key, value] of Object.entries({
  CFBundleIdentifier: 'dev.daban.app',
  CFBundleExecutable: 'daban',
  CFBundleName: 'daban',
  CFBundleDisplayName: 'daban',
  CFBundleIconFile: 'daban.icns',
  CFBundleShortVersionString: info.version,
  CFBundleVersion: info.version,
}))
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
// UNNotification requires a valid bundle signature; local ad-hoc signing does not confer Developer ID trust.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
await writeFile(
  path.join(output, 'BUILD.md'),
  '# daban local macOS ARM64 build\n\nOpen daban.app. The environment and Electron are included; no separate Docker, Node or DSH installation is needed. Configure the official model connection after local setup.\n\nThis development build is ad-hoc signed for local validation. It is not Developer ID signed or notarized for public distribution.\n',
);
console.log(
  JSON.stringify({
    app: target,
    environmentBytes: manifest.image.bytes + manifest.lima.bytes,
    platform: 'darwin-arm64',
    publicDistribution: false,
    localSignature: 'adhoc',
  }),
);
