import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export interface Manifest {
  version: 1;
  id: string;
  platform: 'darwin';
  arch: 'arm64';
  versions: { lima: string; node: string; dsh: string; protocol: number };
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  user: { name: string; uid: number };
  image: { file: string; bytes: number; sha256: string; rawBytes: number; rawSha256: string };
  lima: { file: string; bytes: number; sha256: string };
}
export interface ProcessIdentity {
  pid: number;
  started: string;
}
export interface Preparation {
  kind: 'image' | 'tools';
  name: string;
  dev: number;
  ino: number;
}
type PreparationWriter = (value?: Preparation) => Promise<unknown>;
export function isPreparation(value: unknown): value is Preparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) => ['kind', 'name', 'dev', 'ino'].includes(key)) &&
    (item.kind === 'image' || item.kind === 'tools') &&
    typeof item.name === 'string' &&
    new RegExp(
      `^${item.kind === 'image' ? 'image' : 'tools'}-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}${item.kind === 'image' ? '\\.part' : ''}$`,
    ).test(item.name) &&
    Number.isSafeInteger(item.dev) &&
    Number(item.dev) >= 0 &&
    Number.isSafeInteger(item.ino) &&
    Number(item.ino) > 0
  );
}
export type Run = (
  program: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    permit?: (process: ProcessIdentity) => Promise<unknown>;
  },
) => Promise<{ code: number; stdout: string }>;
export const run: Run = async (program, args, options = {}) => {
  if (!options.permit)
    return new Promise((resolve, reject) => {
      execFile(
        program,
        args,
        {
          env: options.env,
          signal: options.signal,
          timeout: 180000,
          maxBuffer: 256 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error && typeof error.code !== 'number') reject(error);
          else resolve({ code: error ? Number(error.code) : 0, stdout });
        },
      );
    });
  // The child cannot touch the VM until its identity has been durably recorded by its owner.
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'IFS= read -r permit && [ "$permit" = GO ] && exec "$@"',
      'daban-setup',
      program,
      ...args,
    ],
    {
      env: options.env,
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  const done = new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: '' }));
  });
  try {
    if (!child.pid) throw new Error('SETUP_COMMAND');
    // A restarted app may have a different language or time zone.
    const fingerprint = await run('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (fingerprint.code || !fingerprint.stdout.trim()) throw new Error('SETUP_COMMAND');
    await options.permit({ pid: child.pid, started: fingerprint.stdout.trim() });
    child.stdin.end('GO\n');
    return await done;
  } catch (error) {
    child.stdin.destroy();
    await done.catch(() => {});
    throw error;
  }
};
export async function present(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
export async function directory(file: string, create = false) {
  if (create) {
    try {
      await mkdir(file, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
    }
  }
  const info = await lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('SETUP_STORE');
  return realpath(file);
}
async function preparationInfo(root: string, receipt: Preparation) {
  if (!isPreparation(receipt)) throw new Error('SETUP_STORE');
  await directory(root);
  const file = path.join(root, receipt.name);
  if (!(await present(file))) return undefined;
  const info = await lstat(file);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.dev !== receipt.dev ||
    info.ino !== receipt.ino ||
    (receipt.kind === 'tools' ? !info.isDirectory() : !info.isFile())
  )
    throw new Error('SETUP_STORE');
  if (receipt.kind === 'image' && info.nlink !== 1) {
    // A crash can leave the exclusive publication link beside its still-owned staging name.
    if (info.nlink !== 2 || !(await present(path.join(root, 'system.raw'))))
      throw new Error('SETUP_STORE');
    const target = await lstat(path.join(root, 'system.raw'));
    if (!target.isFile() || target.dev !== info.dev || target.ino !== info.ino)
      throw new Error('SETUP_STORE');
  }
  return info;
}
export async function cleanupPreparation(root: string, receipt: Preparation) {
  const info = await preparationInfo(root, receipt);
  if (info) {
    const file = path.join(root, receipt.name);
    if (receipt.kind === 'image') await unlink(file);
    else await rm(file, { recursive: true });
  }
  const parent = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function json(file: string, privateFile = true): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 64 * 1024 ||
      (privateFile && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error('SETUP_STORE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
export async function save(file: string, value: unknown, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
    const parent = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function manifest(resources: string): Promise<Manifest> {
  const value = await json(path.join(resources, 'manifest.json'), false);
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const size = (v: unknown, maximum: number) =>
    Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= maximum;
  if (
    !record(value) ||
    value.version !== 1 ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    value.cpus !== 2 ||
    value.memoryGiB !== 3 ||
    value.diskGiB !== 16 ||
    !record(value.versions) ||
    value.versions.lima !== '2.2.1' ||
    value.versions.node !== '24.22.1' ||
    value.versions.dsh !== '0.2.1-rc.3' ||
    ![26, 27, 28, 29, 30, 31].includes(Number(value.versions.protocol)) ||
    !Number.isInteger(value.versions.protocol) ||
    !record(value.user) ||
    value.user.name !== 'daban' ||
    value.user.uid !== 2000 ||
    !record(value.image) ||
    !record(value.lima) ||
    value.image.file !== 'system.raw.gz' ||
    value.lima.file !== 'lima.tar.gz' ||
    !digest(value.image.sha256) ||
    !digest(value.image.rawSha256) ||
    !digest(value.lima.sha256) ||
    !size(value.image.bytes, 4 * 1024 ** 3) ||
    !size(value.lima.bytes, 128 * 1024 ** 2) ||
    !size(value.image.rawBytes, 16 * 1024 ** 3) ||
    value.id !== `daban-${value.versions.protocol}-${String(value.image.sha256).slice(0, 16)}`
  )
    throw new Error('SETUP_PAYLOAD');
  return value as unknown as Manifest;
}
export async function verify(file: string, bytes: number, digest: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== bytes)
      throw new Error('SETUP_INTEGRITY');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      hash.digest('hex') !== digest
    )
      throw new Error('SETUP_INTEGRITY');
  } finally {
    await handle.close();
  }
}
export async function resourcesReady(
  resources: string,
  root: string,
  value: Manifest,
  signal: AbortSignal,
  execute: Run,
  own?: PreparationWriter,
) {
  const archive = path.join(resources, value.lima.file);
  await verify(archive, value.lima.bytes, value.lima.sha256, signal);
  const tools = path.join(root, 'tools');
  if (!(await present(tools))) {
    const temporary = path.join(root, `tools-${randomUUID()}`);
    // Only a newly allocated directory belongs to this attempt's cleanup.
    await mkdir(temporary, { mode: 0o700 });
    const info = await lstat(temporary);
    const receipt: Preparation = {
      kind: 'tools',
      name: path.basename(temporary),
      dev: info.dev,
      ino: info.ino,
    };
    try {
      // A restarted owner must know this inode before the child can populate it.
      await own?.(receipt);
      const result = await execute('/usr/bin/tar', ['xzf', archive, '-C', temporary], { signal });
      if (result.code) throw new Error('SETUP_COMMAND');
      if (!(await preparationInfo(root, receipt))) throw new Error('SETUP_STORE');
      await chmod(temporary, 0o700);
      await rename(temporary, tools);
    } finally {
      await cleanupPreparation(root, receipt);
      await own?.();
    }
  }
  await directory(tools);
  const binary = path.join(tools, 'bin/limactl');
  const info = await lstat(binary);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.())
    throw new Error('SETUP_STORE');
  await access(binary, constants.X_OK);
  signal.throwIfAborted();
  return binary;
}
export async function unpack(
  resources: string,
  root: string,
  value: Manifest,
  signal: AbortSignal,
  progress: (value: number) => unknown,
  own?: PreparationWriter,
) {
  const target = path.join(root, 'system.raw');
  if (await present(target)) {
    await verify(target, value.image.rawBytes, value.image.rawSha256, signal);
    return;
  }
  const source = path.join(resources, value.image.file);
  await verify(source, value.image.bytes, value.image.sha256, signal);
  const temporary = path.join(root, `image-${randomUUID()}.part`);
  // Claim ownership before entering cleanup; a colliding file must remain untouched.
  const output = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const metadata = await output.stat();
  const receipt: Preparation = {
    kind: 'image',
    name: path.basename(temporary),
    dev: metadata.dev,
    ino: metadata.ino,
  };
  let input: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0,
    last = -1;
  const hash = createHash('sha256');
  try {
    // Persist the empty file's identity before it can accumulate a multi-gigabyte image.
    await own?.(receipt);
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    await pipeline(
      input.createReadStream(),
      createGunzip(),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > value.image.rawBytes) throw new Error('SETUP_INTEGRITY');
          hash.update(chunk);
          const percent = Math.floor((bytes / value.image.rawBytes) * 100);
          if (percent !== last) {
            progress(percent);
            last = percent;
          }
          yield chunk;
        }
      },
      output.createWriteStream(),
      { signal },
    );
    if (bytes !== value.image.rawBytes || hash.digest('hex') !== value.image.rawSha256)
      throw new Error('SETUP_INTEGRITY');
    const completed = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await completed.stat();
      if (info.dev !== receipt.dev || info.ino !== receipt.ino || info.nlink !== 1)
        throw new Error('SETUP_STORE');
      await completed.sync();
    } finally {
      await completed.close();
    }
    await link(temporary, target);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.message === 'SETUP_STORE')) throw error;
    throw new Error('SETUP_INTEGRITY');
  } finally {
    await input?.close();
    await output.close();
    await cleanupPreparation(root, receipt);
    await own?.();
  }
}
export async function freeSpace(root: string) {
  const info = await statfs(root);
  return info.bavail * info.bsize;
}
