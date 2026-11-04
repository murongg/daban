import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentIndex } from '@daban/engine/component';
import { verifyBundleLinks } from './bundle.ts';
import { writeIcon } from './icon.ts';
import { writeUpdateConfig } from './installer.ts';
import { packageNative } from './native.ts';
import { packageNotices } from './notices.ts';
import { macVersion } from './release.ts';

// Build-time macOS app assembly. Never reuse a user directory or package a Lima home.
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const [referenceArgument, outputArgument] = process.argv.slice(2);
assert.ok(
  referenceArgument && outputArgument,
  'Usage: bundle:desktop -- <runtime-reference.json> <new-output-directory>',
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(outputArgument);
const reference = JSON.parse(await readFile(await realpath(referenceArgument), 'utf8'));
componentIndex(reference, reference.id);
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const electron: string = requireDesktop('electron');
const source = path.resolve(electron, '../../..');
assert.equal(path.basename(source), 'Electron.app');
assert.ok((await stat(path.join(root, 'dist-electron/main.cjs'))).isFile());
assert.ok((await stat(path.join(root, 'dist/index.html'))).isFile());
await mkdir(output, { mode: 0o700 });
const target = path.join(output, 'Daban.app');
await cp(source, target, {
  recursive: true,
  verbatimSymlinks: true,
  force: false,
  errorOnExist: true,
  mode: constants.COPYFILE_FICLONE,
  // Keep the two supported UI languages, their regional/gender variants and native shared resources.
  filter: (file) =>
    !file.endsWith('.lproj') ||
    /^(?:en(?:_|\.lproj)|zh_CN(?:_|\.lproj)|Base\.lproj)/.test(path.basename(file)),
});
// Preserve framework links verbatim: Node's default copy otherwise points back into node_modules.
await verifyBundleLinks(target);
await rename(
  path.join(target, 'Contents/MacOS/Electron'),
  path.join(target, 'Contents/MacOS/daban'),
);
const resources = path.join(target, 'Contents/Resources');
await writeUpdateConfig(resources);
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
await packageNative(app, path.join(root, 'apps/desktop/package.json'));
await writeFile(path.join(resources, 'runtime.json'), JSON.stringify(reference));
await rm(path.join(resources, 'default_app.asar'), { force: true });
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
await packageNotices(resources, path.join(root, 'apps/desktop/package.json'));
for (const [key, value] of Object.entries({
  CFBundleIdentifier: 'dev.daban.app',
  CFBundleExecutable: 'daban',
  CFBundleName: 'Daban',
  CFBundleDisplayName: 'Daban',
  CFBundleIconFile: 'daban.icns',
  CFBundleShortVersionString: macVersion(info.version),
  CFBundleVersion: macVersion(info.version),
}))
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
// UNNotification requires a valid bundle signature; local ad-hoc signing does not confer Developer ID trust.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', target]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
await writeFile(
  path.join(output, 'BUILD.md'),
  '# Daban local macOS ARM64 build\n\nOpen Daban.app. Core runtime components download on first use. Linux is optional and downloads only when requested.\n\nThis development build is ad-hoc signed for local validation. It is not Developer ID signed or notarized for public distribution.\n',
);
console.log(
  JSON.stringify({
    app: target,
    runtimeBundled: false,
    imageBundled: false,
    platform: 'darwin-arm64',
    publicDistribution: false,
    localSignature: 'adhoc',
  }),
);
