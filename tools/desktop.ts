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
import { packageNative } from './native.ts';
import { packageNotices } from './notices.ts';
import { macVersion } from './release.ts';
import { buildExecutor, packageHost, sealHostPackage, verifyExecutorBuild } from './roles.ts';

// Build-time macOS app assembly. Never reuse a user directory or package a Lima home.
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const [payloadArgument, outputArgument, nodeArgument, executorArgument] = process.argv.slice(2);
assert.ok(
  payloadArgument && outputArgument && nodeArgument,
  'Usage: bundle:desktop -- <clean-environment-pack> <new-output-directory> <node-24.22.1-directory>',
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
// The sealed, credential-free base is deliberately independent of the overlaid execution protocol.
assert.deepEqual(manifest.versions, { ...environmentVersions, protocol: 38 });
assert.equal(
  manifest.image.sha256,
  '0b2c13631d75438214b32ebe5f016b625e27c993d602019b83eee47e044ebde9',
);
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
const target = path.join(output, 'Daban.app');
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
await packageNative(app, path.join(root, 'apps/desktop/package.json'));
const environment = path.join(resources, 'environment');
await mkdir(environment);
for (const file of ['manifest.json', 'system.raw.gz', 'lima.tar.gz', 'COMPONENTS.md'])
  await copyFile(
    path.join(payload, file),
    path.join(environment, file),
    constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
  );
const agent = path.join(resources, 'agent');
await packageHost(agent, await realpath(nodeArgument));
if (executorArgument)
  await copyFile(await realpath(executorArgument), path.join(agent, 'executor.tar.gz'));
else {
  const executor = path.join(output, 'executor');
  await buildExecutor(executor);
  execFileSync(
    '/usr/bin/tar',
    [
      '--format=ustar',
      '-czf',
      path.join(agent, 'executor.tar.gz'),
      '-C',
      executor,
      'main.js',
      'package.json',
      'LICENSE',
      'node_modules',
    ],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
}
await verifyExecutorBuild(path.join(agent, 'executor.tar.gz'));
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
// Deep signing can change native payload bytes; seal the final archive and signed files before the outer resource seal.
await sealHostPackage(agent);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', target]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
await writeFile(
  path.join(output, 'BUILD.md'),
  '# Daban local macOS ARM64 build\n\nOpen Daban.app. The environment and Electron are included; no separate Docker, Node or DSH installation is needed. Configure the official model connection after local setup.\n\nThis development build is ad-hoc signed for local validation. It is not Developer ID signed or notarized for public distribution.\n',
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
