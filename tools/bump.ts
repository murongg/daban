import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export async function syncVersions(root: string) {
  const read = async <T>(file: string) =>
    JSON.parse(await readFile(path.join(root, file), 'utf8')) as T;
  const write = async (file: string, value: unknown) => {
    await writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  const project = await read<Manifest & { workspaces: string[] }>('package.json');
  const manifests = await Promise.all(
    project.workspaces.map(async (directory) => ({
      file: `${directory}/package.json`,
      value: await read<Manifest>(`${directory}/package.json`),
    })),
  );
  const names = new Set([project.name, ...manifests.map(({ value }) => value.name)]);
  const sync = (manifest: Manifest) => {
    manifest.version = project.version;
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ] as const) {
      const dependencies = manifest[field];
      if (!dependencies) continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        // Standalone installs resolve vendored packages through these relative paths.
        if (names.has(name) && !specifier.startsWith('file:')) dependencies[name] = project.version;
      }
    }
  };
  for (const { file, value } of [{ file: 'package.json', value: project }, ...manifests]) {
    sync(value);
    await write(file, value);
  }
  for (const file of [
    'package-lock.json',
    'apps/agent/standalone-lock.json',
    'apps/runtime/standalone-lock.json',
  ]) {
    const lock = await read<Manifest & { packages: Record<string, Manifest> }>(file);
    sync(lock);
    for (const manifest of Object.values(lock.packages))
      if (names.has(manifest.name)) sync(manifest);
    await write(file, lock);
  }
}
