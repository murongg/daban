import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const protectedRoots = new Set<string>();
let sid: Promise<string> | undefined;
function run(program: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      program,
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 32768 },
      (error, stdout) =>
        error ? reject(new Error('PRIVATE_DIRECTORY_UNAVAILABLE')) : resolve(stdout),
    ),
  );
}
export async function secureDirectory(directory: string) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PRIVATE_DIRECTORY_UNSAFE');
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    sid ??= run(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then((text) => {
      const value = text.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!value) throw new Error('PRIVATE_DIRECTORY_UNAVAILABLE');
      return value;
    });
    const owner = await sid;
    // A private app-owned root supplies inheritable ACLs to its model keys and task metadata.
    if (created)
      await run(path.join(system, 'icacls.exe'), [
        directory,
        '/inheritance:r',
        '/grant:r',
        `*${owner}:(OI)(CI)F`,
      ]);
    const acl = path.join(
      directory,
      `.daban-acl-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await run(path.join(system, 'icacls.exe'), [directory, '/save', acl, '/q']);
      const descriptor = (await readFile(acl)).toString('utf16le');
      const allowed = new Set([
        owner,
        'SY',
        'BA',
        'CO',
        'OW',
        'S-1-5-18',
        'S-1-5-32-544',
        'S-1-3-0',
      ]);
      const entries = [...descriptor.matchAll(/\((A|OA);[^)]*;;;([^;)]+)\)/g)];
      if (!entries.length || entries.some((entry) => !allowed.has(entry[2])))
        throw new Error('PRIVATE_DIRECTORY_UNSAFE');
    } finally {
      await unlink(acl).catch(() => {});
    }
  } else if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error('PRIVATE_DIRECTORY_UNSAFE');
  const canonical = await realpath(directory);
  protectedRoots.add(canonical);
  return canonical;
}
export async function privateMetadata(
  file: string,
  info: Pick<Stats, 'uid' | 'mode'>,
  mode?: number,
) {
  if (process.platform !== 'win32')
    return info.uid === process.getuid?.() && (mode === undefined || (info.mode & 0o777) === mode);
  const canonical = await realpath(file).catch(() => '');
  return (
    canonical.length > 0 &&
    [...protectedRoots].some((root) => {
      const relative = path.relative(root, canonical);
      return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    })
  );
}
