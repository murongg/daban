import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyComponentTree, verifyHostFiles } from '@daban/engine/component-files';

const execute = promisify(execFile);
type Run = (
  program: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;
const run: Run = (program, args, signal) =>
  execute(program, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
const tar = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe');
export function componentDirectory(directory: string, platform: string) {
  if (platform === 'darwin') return path.join(directory, 'DabanRuntime.app');
  if (platform === 'win32') return path.join(directory, 'DabanRuntime');
  throw Error('COMPONENT_PLATFORM');
}
export function componentPaths(directory: string, platform: string) {
  const root = componentDirectory(directory, platform);
  return platform === 'darwin'
    ? {
        entry: path.join(root, 'Contents/Resources/agent/main.js'),
        executable: path.join(root, 'Contents/MacOS/agent'),
      }
    : {
        entry: path.join(root, 'agent/main.js'),
        executable: path.join(root, 'agent/node/node.exe'),
      };
}
export async function extractComponent(
  archive: string,
  directory: string,
  platform: string,
  signal?: AbortSignal,
) {
  if (platform === 'darwin') await run('/usr/bin/ditto', ['-x', '-k', archive, directory], signal);
  else if (platform === 'win32') await run(tar(), ['-xf', archive, '-C', directory], signal);
  else throw Error('COMPONENT_PLATFORM');
}
export interface ComponentInstallation {
  directory: string;
  id: string;
  platform: string;
  arch: string;
  archive: string;
  publisher: string;
  signal?: AbortSignal;
}
export async function verifyComponent(
  options: ComponentInstallation,
  dependencies: { run?: Run } = {},
) {
  const root = componentDirectory(options.directory, options.platform);
  await verifyComponentTree(root, options.signal);
  const resources = options.platform === 'darwin' ? path.join(root, 'Contents/Resources') : root;
  const handle = await open(
    path.join(resources, 'component.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw Error('COMPONENT_INTEGRITY');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('id' in value) ||
      value.id !== options.id ||
      !('platform' in value) ||
      value.platform !== options.platform ||
      !('arch' in value) ||
      value.arch !== options.arch
    )
      throw Error('COMPONENT_INTEGRITY');
  } catch {
    throw Error('COMPONENT_INTEGRITY');
  } finally {
    await handle.close();
  }
  const files = componentPaths(options.directory, options.platform);
  for (const file of [files.entry, files.executable]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw Error('COMPONENT_INTEGRITY');
  }
  const command = dependencies.run ?? run;
  if (options.platform === 'darwin') {
    try {
      const publisher = await command(
        '/usr/bin/codesign',
        ['-d', '--verbose=4', options.publisher],
        options.signal,
      );
      const team = /^TeamIdentifier=([A-Z0-9]{10})\s*$/m.exec(publisher.stderr)?.[1];
      if (!team) throw Error('COMPONENT_SIGNATURE');
      await command(
        '/usr/bin/codesign',
        [
          '--verify',
          '--deep',
          '--strict',
          '-R',
          // codesign treats plain text as a file path; '=' selects an inline requirement.
          `=anchor apple generic and identifier "dev.daban.runtime" and certificate leaf[subject.OU] = "${team}"`,
          root,
        ],
        options.signal,
      );
      await command(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'execute', '--verbose=2', root],
        options.signal,
      );
    } catch {
      throw Error('COMPONENT_SIGNATURE');
    }
  } else if (options.platform === 'win32') {
    const trusted = await command(
      tar(),
      ['-xOf', options.archive, 'DabanRuntime/agent/manifest.json'],
      options.signal,
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(trusted.stdout);
    } catch {
      throw Error('COMPONENT_INTEGRITY');
    }
    await verifyHostFiles(path.join(root, 'agent'), manifest, options.signal);
  } else throw Error('COMPONENT_PLATFORM');
}
