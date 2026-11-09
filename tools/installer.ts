import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { componentAsset, componentIndex } from '@daban/engine/component';
import { Arch, build, type Configuration, Platform } from 'electron-builder';
import { sealHostPackage } from './roles.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function writeUpdateConfig(resources: string) {
  await writeFile(
    path.join(resources, 'app-update.yml'),
    'provider: github\nowner: murongg\nrepo: daban\nupdaterCacheDirName: daban-updater\n',
    { flag: 'wx' },
  );
}
function configuration(
  version: string,
  output: string,
  platform: 'darwin' | 'win32',
): Configuration {
  return {
    appId: 'dev.daban.app',
    productName: 'Daban',
    extraMetadata: { version },
    directories: { app: path.join(root, 'apps/desktop'), output },
    publish: [{ provider: 'github', owner: 'murongg', repo: 'daban', releaseType: 'release' }],
    artifactName:
      platform === 'darwin'
        ? 'Daban-${version}-macos-${arch}.${ext}'
        : 'Daban-${version}-windows-${arch}-setup.${ext}',
    mac: { identity: null, target: ['zip'] },
    win: { target: ['nsis'] },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: false,
      runAfterFinish: true,
    },
    compression: 'maximum',
    npmRebuild: false,
  };
}
export async function attachRuntimeReference(
  output: string,
  resources: string,
  platform: 'darwin' | 'win32',
) {
  const source = await readFile(path.join(resources, 'runtime.json'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (source === undefined) return; // Legacy clients bundled their runtime.
  const reference = componentIndex(JSON.parse(source));
  componentAsset(reference, platform, platform === 'darwin' ? 'arm64' : 'x64');
  // The builder writes channel metadata at finalization and may omit it from its artifact result.
  const feeds = (await readdir(output)).filter((name) =>
    platform === 'darwin'
      ? /^[a-zA-Z0-9][a-zA-Z0-9.-]*-mac\.yml$/.test(name)
      : name === 'latest.yml',
  );
  assert.equal(feeds.length, 1, 'CLIENT_UPDATE_CHANNEL');
  // Extend only the generated feed, with the exact reference the signed client will trust after restart.
  await appendFile(
    path.join(output, feeds[0]),
    `\nvendor:\n  dabanRuntime: ${JSON.stringify(reference)}\n`,
  );
}
export async function packageMacUpdate(app: string, output: string) {
  const resources = path.join(app, 'Contents/Resources');
  const version = JSON.parse(await readFile(path.join(resources, 'app/package.json'), 'utf8'))
    .version as string;
  await readFile(path.join(resources, 'app-update.yml'), 'utf8');
  // Prepackaged mode only archives the already signed/stapled app; it must not mutate its resource seal.
  const artifacts = await build({
    projectDir: root,
    prepackaged: app,
    publish: 'never',
    targets: Platform.MAC.createTarget(['zip'], Arch.arm64),
    config: configuration(version, output, 'darwin'),
  });
  await attachRuntimeReference(output, resources, 'darwin');
  return artifacts;
}
export async function packageWindowsInstaller(portable: string, output: string) {
  assert.equal(process.platform, 'win32');
  const version = JSON.parse(
    await readFile(path.join(portable, 'resources/app/package.json'), 'utf8'),
  ).version as string;
  await mkdir(output, { recursive: false });
  const staging = await mkdtemp(path.join(tmpdir(), 'daban-installer-'));
  try {
    const app = path.join(staging, 'app');
    const resources = path.join(app, 'resources');
    // npm file: dependencies can be junctions. Materialize them so installers never retain a build-machine path.
    await cp(portable, app, { recursive: true, dereference: true });
    await writeUpdateConfig(resources);
    if (
      await import('node:fs/promises').then((fs) =>
        fs.access(path.join(app, 'resources/agent')).then(
          () => true,
          () => false,
        ),
      )
    )
      await sealHostPackage(path.join(app, 'resources/agent'));
    const artifacts = await build({
      projectDir: root,
      prepackaged: app,
      publish: 'never',
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      config: configuration(version, output, 'win32'),
    });
    await attachRuntimeReference(output, resources, 'win32');
    return artifacts;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'Usage: tools/installer.ts <portable-app> <new-installer-output>');
  await packageWindowsInstaller(path.resolve(input), path.resolve(output));
}
