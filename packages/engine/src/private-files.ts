import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const protectedRoots = new Set<string>();
let sid: Promise<string> | undefined;
function privateAcl(descriptor: string, allowed: Set<string>) {
  const lines = descriptor
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length !== 2 || !/^D:(?:P|AI|AR)*(?:\(|$)/.test(lines[1])) return false;
  const body = lines[1].replace(/^D:(?:P|AI|AR)*/, '');
  const entries = [...body.matchAll(/\(([^()]*)\)/g)];
  if (!entries.length || entries.map((entry) => entry[0]).join('') !== body) return false;
  let hasAllow = false;
  for (const entry of entries) {
    const fields = entry[1].split(';');
    if (fields.length !== 6) return false;
    const [type, flags, rights, object, inheritedObject, principal] = fields;
    if (
      !['A', 'OA', 'D', 'OD'].includes(type) ||
      !/^(?:OI|CI|NP|IO|ID)*$/.test(flags) ||
      !/^(?:0x[\da-fA-F]{1,8}|(?:GA|GR|GW|GX|RC|SD|WD|WO|RP|WP|CC|DC|LC|SW|LO|DT|CR|FA|FR|FW|FX|KA|KR|KW|KX|NR|NW|NX)+)$/.test(
        rights,
      ) ||
      !/^(?:[A-Z]{2}|S-1-\d+(?:-\d+)+)$/.test(principal) ||
      [object, inheritedObject].some(
        (guid) => guid && !/^[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}$/.test(guid),
      ) ||
      ((type === 'A' || type === 'D') && (object || inheritedObject))
    )
      return false;
    if (type !== 'A' && type !== 'OA') continue;
    const inheritance = new Set(flags.match(/.{2}/g) ?? []);
    // Inherit-only creator/owner placeholders do not grant access to this object.
    if (
      !allowed.has(principal) &&
      !(inheritance.has('IO') && ['CO', 'OW', 'S-1-3-0'].includes(principal))
    )
      return false;
    if (!object && !inheritedObject) hasAllow = true;
  }
  return hasAllow;
}
function principals(owner: string) {
  // icacls can encode the local Administrator account as LA instead of its numeric SID.
  return new Set([owner, 'SY', 'BA', 'LA', 'S-1-5-18', 'S-1-5-32-544']);
}
function currentSid(system: string) {
  sid ??= run(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then((text) => {
    const value = text.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!value) throw new Error('PRIVATE_DIRECTORY_UNAVAILABLE');
    return value;
  });
  return sid;
}
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
    const owner = await currentSid(system);
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
      const allowed = principals(owner);
      allowed.add('CO').add('OW').add('S-1-3-0');
      // Existing private parents remain readable; each object needs its own ACL check before private access.
      if (!privateAcl(descriptor, allowed)) throw new Error('PRIVATE_DIRECTORY_UNSAFE');
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
  const protectedPath =
    canonical.length > 0 &&
    [...protectedRoots].some((root) => {
      const relative = path.relative(root, canonical);
      return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  if (!protectedPath) return false;
  let temporary: string | undefined;
  let probe: string | undefined;
  let verified = false;
  try {
    temporary = await mkdtemp(path.join(tmpdir(), 'daban-object-acl-'));
    // Keep the query outside the target's parent: a legitimate private object may be read-only.
    probe = await secureDirectory(path.join(temporary, 'private'));
    const acl = path.join(probe, 'object-acl');
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const before = await lstat(canonical);
    await run(path.join(system, 'icacls.exe'), [canonical, '/save', acl, '/q']);
    const descriptor = (await readFile(acl)).toString('utf16le');
    const after = await lstat(canonical);
    // Root registration only limits scope; it cannot certify an existing child's explicit DACL.
    verified =
      privateAcl(descriptor, principals(await currentSid(system))) &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      (await realpath(file)) === canonical;
  } catch {
    verified = false;
  } finally {
    if (probe) protectedRoots.delete(probe);
    if (temporary)
      await rm(temporary, { recursive: true, force: true }).catch(() => {
        verified = false;
      });
  }
  return verified;
}
