import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { componentTag, type LinuxIndex, linuxFilename, linuxIndex } from '@daban/engine/component';
import { environmentImage } from '@daban/protocol';
import { environmentAssets, hashAsset, verifyAsset } from './environment.ts';
import { macVersion } from './release.ts';
import { buildExecutor, packageHost, sealHostPackage, verifyExecutorBuild } from './roles.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
function workspaceDependencies(value: Record<string, unknown>) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = value[field];
    if (record(deps))
      for (const name of Object.keys(deps))
        if (name.startsWith('@daban/')) deps[name] = '<workspace>';
  }
}
function metadata(text: string) {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw Error('COMPONENT_SOURCE');
  // App version bumps and renderer-only edits must not force a new host runtime download.
  delete value.version;
  delete value.scripts;
  delete value.devDependencies;
  workspaceDependencies(value);
  if (record(value.packages))
    for (const [name, item] of Object.entries(value.packages)) {
      if (!record(item)) continue;
      if (
        !name ||
        name.startsWith('vendor/') ||
        (typeof item.name === 'string' && item.name.startsWith('@daban/'))
      ) {
        delete item.version;
        workspaceDependencies(item);
      }
    }
  return JSON.stringify(canonical(value));
}
export async function componentSourceId(root: string) {
  const files: string[] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error('COMPONENT_SOURCE_UNSAFE');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && !/\.(?:test|integration|acceptance)\./.test(name))
        files.push(name);
    }
  }
  for (const directory of [
    'apps/agent/src',
    'apps/runtime/src',
    'packages/engine/src',
    'packages/protocol/src',
    'tools/entitlements',
  ])
    await walk(directory);
  files.push(
    'LICENSE',
    'tools/components.ts',
    'tools/roles.ts',
    'tools/sign.ts',
    'tools/environment.ts',
    'apps/agent/package.json',
    'apps/runtime/package.json',
    'apps/runtime/standalone-lock.json',
    'tools/engine.ts',
    'tsconfig.json',
    'apps/agent/tsconfig.json',
    'apps/runtime/tsconfig.json',
    'packages/engine/tsconfig.json',
    'packages/protocol/tsconfig.json',
    'apps/agent/standalone-lock.json',
    'packages/engine/package.json',
    'packages/protocol/package.json',
  );
  const hash = createHash('sha256');
  for (const name of files.sort()) {
    const file = path.join(root, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('COMPONENT_SOURCE_UNSAFE');
    const text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
    hash.update(name + '\0');
    hash.update(name.endsWith('.json') ? metadata(text) : text);
    hash.update('\0');
  }
  const config = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  hash.update(
    JSON.stringify(
      ['typescript', 'vite', 'rolldown', '@electron/osx-sign', 'electron-builder'].map((name) => [
        name,
        config.devDependencies[name] ?? null,
      ]),
    ),
  );
  return hash.digest('hex');
}

async function copyVmTools(source: string, target: string) {
  const value: unknown = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (
    !record(value) ||
    !record(value.image) ||
    !record(value.lima) ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    value.id !== environmentImage.id ||
    value.image.file !== environmentImage.file ||
    value.image.bytes !== environmentImage.bytes ||
    value.image.sha256 !== environmentImage.sha256 ||
    value.lima.file !== 'lima.tar.gz' ||
    value.lima.sha256 !== environmentAssets.lima.digest ||
    typeof value.lima.bytes !== 'number' ||
    !Number.isSafeInteger(value.lima.bytes) ||
    value.lima.bytes < 1 ||
    value.lima.bytes > 512 * 1024 ** 2
  )
    throw Error('COMPONENT_ENVIRONMENT');
  if (
    (await verifyAsset(
      path.join(source, 'lima.tar.gz'),
      'sha256',
      environmentAssets.lima.digest,
    )) !== value.lima.bytes
  )
    throw Error('COMPONENT_ENVIRONMENT');
  await mkdir(target);
  // The image is downloaded separately; only the pinned tools and their notices enter the host runtime.
  for (const file of ['manifest.json', 'lima.tar.gz', 'COMPONENTS.md'])
    await copyFile(
      path.join(source, file),
      path.join(target, file),
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
}
async function packageExecutor(target: string) {
  const stage = await mkdtemp(path.join(tmpdir(), 'daban-component-executor-'));
  try {
    await buildExecutor(stage);
    execFileSync(
      '/usr/bin/tar',
      [
        '--format=ustar',
        '-czf',
        target,
        '-C',
        stage,
        'main.js',
        'package.json',
        'LICENSE',
        'node_modules',
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    );
    await verifyExecutorBuild(target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function assembleLinux(
  options: { output: string; environmentDirectory: string; id: string },
  sign: (resources: string) => Promise<unknown>,
  dependencies: { tools?: typeof copyVmTools; executor?: typeof packageExecutor } = {},
) {
  const environment = path.join(options.output, 'environment');
  await (dependencies.tools ?? copyVmTools)(options.environmentDirectory, environment);
  const executor = path.join(options.output, linuxFilename('executor'));
  await (dependencies.executor ?? packageExecutor)(executor);
  await sign(options.output);
  const lima = path.join(options.output, linuxFilename('lima'));
  await rename(path.join(environment, 'lima.tar.gz'), lima);
  const describe = async (file: string) => {
    const hash = await hashAsset(file, 'sha256');
    return { bytes: hash.bytes, sha256: hash.digest };
  };
  const reference = linuxIndex(
    { version: 1, id: options.id, lima: await describe(lima), executor: await describe(executor) },
    options.id,
  );
  await writeFile(
    path.join(options.output, 'linux.json'),
    JSON.stringify(reference, null, 2) + '\n',
  );
  return reference;
}
export async function verifyLinux(directory: string, id: string) {
  const reference = linuxIndex(
    JSON.parse(await readFile(path.join(directory, 'linux.json'), 'utf8')),
    id,
  );
  for (const kind of ['lima', 'executor'] as const) {
    const hash = await hashAsset(path.join(directory, linuxFilename(kind)), 'sha256');
    if (hash.bytes !== reference[kind].bytes || hash.digest !== reference[kind].sha256)
      throw Error('COMPONENT_RELEASE_INTEGRITY');
  }
  return reference;
}
interface ComponentBuild {
  output: string;
  nodeDirectory: string;
  environmentDirectory?: string;
  linuxReference?: LinuxIndex;
  platform: 'darwin' | 'win32';
  arch: 'arm64' | 'x64';
  version: string;
  id: string;
}
export async function assembleComponent(
  options: ComponentBuild,
  dependencies: {
    host?: typeof packageHost;
  } = {},
) {
  componentTag(options.id);
  const version = macVersion(options.version);
  if (
    !(
      (options.platform === 'darwin' && options.arch === 'arm64') ||
      (options.platform === 'win32' && options.arch === 'x64')
    )
  )
    throw Error('COMPONENT_PLATFORM');
  await mkdir(options.output, { recursive: false });
  const directory = path.join(
    options.output,
    options.platform === 'darwin' ? 'DabanRuntime.app' : 'DabanRuntime',
  );
  const resources =
    options.platform === 'darwin' ? path.join(directory, 'Contents/Resources') : directory;
  await mkdir(resources, { recursive: true });
  const agent = path.join(resources, 'agent');
  await (dependencies.host ?? packageHost)(agent, options.nodeDirectory);
  await writeFile(
    path.join(resources, 'component.json'),
    JSON.stringify({ version: 1, id: options.id, platform: options.platform, arch: options.arch }),
  );
  if (options.platform === 'darwin') {
    if (!options.environmentDirectory || !options.linuxReference)
      throw Error('COMPONENT_ENVIRONMENT');
    const reference = linuxIndex(options.linuxReference, options.id);
    await writeFile(path.join(agent, 'linux.json'), JSON.stringify(reference, null, 2) + '\n');
    const environment = path.join(resources, 'environment');
    await mkdir(environment);
    // Keep only small, signed metadata in the host; executable payloads have separate pinned downloads.
    for (const file of ['manifest.json', 'COMPONENTS.md'])
      await copyFile(path.join(options.environmentDirectory, file), path.join(environment, file));
    const contents = path.join(directory, 'Contents');
    await mkdir(path.join(contents, 'MacOS'));
    // Apple's main executable must be regular; keep one Node copy inside the signed component.
    await rename(path.join(agent, 'node/bin/node'), path.join(contents, 'MacOS/agent'));
    await writeFile(path.join(contents, 'PkgInfo'), 'APPL????');
    await writeFile(
      path.join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.daban.runtime</string>
<key>CFBundleExecutable</key><string>agent</string>
<key>CFBundleName</key><string>Daban Runtime</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`,
    );
  }
  await sealHostPackage(agent);
  return { directory, resources, agent };
}
