import { constants } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

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
    let manifestFile: string;
    try {
      manifestFile = createRequire(from).resolve(`${name}/package.json`);
    } catch (error) {
      if (optional) return;
      throw error;
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
