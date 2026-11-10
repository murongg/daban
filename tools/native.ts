import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function packageNative(
  directory: string,
  owner: string,
  platform: NodeJS.Platform = process.platform,
) {
  const dependency =
    platform === 'darwin'
      ? '@computer-use/libnut-darwin'
      : platform === 'win32'
        ? '@computer-use/libnut-win32'
        : undefined;
  if (!dependency) return;
  const versions = new Map<string, string>();
  async function copy(name: string, from: string, optional = false): Promise<unknown> {
    const require = createRequire(from);
    let manifestFile: string | undefined;
    try {
      manifestFile = require.resolve(`${name}/package.json`);
    } catch (error) {
      // ESM packages can hide their manifest behind exports.
      if ((error as NodeJS.ErrnoException).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
        manifestFile = require.resolve
          .paths(name)
          ?.map((directory) => path.join(directory, name, 'package.json'))
          .find((file) => existsSync(file));
      if (!manifestFile && optional) return;
      if (!manifestFile) throw error;
    }
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (versions.has(name)) {
      if (versions.get(name) !== manifest.version) throw new Error('NATIVE_DEPENDENCY_CONFLICT');
      return;
    }
    versions.set(name, manifest.version);
    const source = path.dirname(manifestFile),
      target = path.join(directory, 'node_modules', name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (file) => !path.relative(source, file).split(path.sep).includes('node_modules'),
    });
    for (const dependency of Object.keys(manifest.dependencies || {}))
      await copy(dependency, manifestFile);
    for (const dependency of Object.keys(manifest.optionalDependencies || {}))
      await copy(dependency, manifestFile, true);
  }
  await copy(dependency, owner);
  await copy('@trycua/cua-driver', owner);
  const cuaBinary = platform === 'win32' ? `win32-${process.arch}-msvc` : `darwin-${process.arch}`;
  await copy(`@trycua/cua-driver-${cuaBinary}`, owner);
  await copyFile(
    new URL('../apps/desktop/licenses/cua-driver-LICENSE', import.meta.url),
    path.join(directory, 'node_modules/@trycua/cua-driver/LICENSE'),
  );
  await writeFile(
    path.join(directory, 'NATIVE-NOTICES.md'),
    [
      '# Native desktop dependencies',
      '',
      ...[...versions].map(
        ([name, version]) =>
          `- ${name} ${version}: license and upstream notices are included with its package.`,
      ),
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const owner = new URL('../apps/desktop/package.json', import.meta.url);
  const requireDesktop = createRequire(process.argv[3] ? path.resolve(process.argv[3]) : owner);
  const mode = process.argv[2];
  if (mode === 'transport' || (mode === 'abi' && !process.versions.electron)) {
    const executable: unknown = createRequire(owner)('electron');
    if (typeof executable !== 'string') throw new Error('ELECTRON_EXECUTABLE_UNAVAILABLE');
    const result = spawnSync(
      executable,
      mode === 'transport'
        ? [
            fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
            'run',
            '--project',
            'node',
            '--maxWorkers=1',
            'packages/engine/dist/private-channel.test.js',
          ]
        : [
            '--experimental-strip-types',
            fileURLToPath(import.meta.url),
            'abi',
            ...(process.argv[3] ? [path.resolve(process.argv[3])] : []),
          ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
        timeout: 45000,
      },
    );
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  } else if (mode === 'abi') {
    const name =
      process.platform === 'win32' ? '@computer-use/libnut-win32' : '@computer-use/libnut-darwin';
    const value: unknown = requireDesktop(name);
    for (const method of ['moveMouse', 'keyTap', 'typeString', 'getActiveWindow'])
      if (!value || typeof value !== 'object' || typeof Reflect.get(value, method) !== 'function')
        throw new Error('NATIVE_DRIVER_ABI_UNAVAILABLE');
    console.log('Native module exports verified; no desktop input performed.');
  } else throw new Error('Usage: tools/native.ts <transport|abi>');
}
