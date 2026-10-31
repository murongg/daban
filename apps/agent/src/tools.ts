import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

interface ToolOptions {
  dataRoot: string;
  vmConfigFile: string;
  packDirectory: string;
}
interface ToolDependencies {
  digest?: string;
  run?: (program: string, args: string[]) => Promise<{ code: number }>;
}
const expectedLima = '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
async function json(file: string, privateFile: boolean): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024 ||
      (privateFile && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))
    )
      throw new Error('AGENT_VM_CONFIG');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
async function executable(file: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('AGENT_LIMA_UNAVAILABLE');
  await access(file, constants.X_OK);
  return file;
}
async function ownedExecutable(file: string) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error('AGENT_TOOLS_UNSAFE');
  return executable(file);
}
async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error('AGENT_TOOLS_UNSAFE');
}
async function validTree(root: string) {
  const canonical = await realpath(root);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink() && !(await realpath(file)).startsWith(canonical + path.sep))
      throw new Error('AGENT_TOOLS_UNSAFE');
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink())
      throw new Error('AGENT_TOOLS_UNSAFE');
  }
}
const run = (program: string, args: string[]) =>
  new Promise<{ code: number }>((resolve, reject) => {
    execFile(
      program,
      args,
      {
        timeout: 180000,
        maxBuffer: 1024,
        env: { PATH: '/usr/bin:/bin', HOME: homedir(), LANG: 'C' },
      },
      (error) => {
        if (error && typeof error.code !== 'number') reject(new Error('AGENT_TOOLS_UNAVAILABLE'));
        else resolve({ code: error ? Number(error.code) : 0 });
      },
    );
  });
export async function ensureLima(options: ToolOptions, dependencies: ToolDependencies = {}) {
  let existing: unknown;
  try {
    existing = await json(options.vmConfigFile, true);
  } catch (error) {
    if (!object(error) || error.code !== 'ENOENT') throw new Error('AGENT_VM_CONFIG');
  }
  if (existing !== undefined) {
    if (
      !object(existing) ||
      Object.keys(existing).some((key) => !['limactl', 'limaHome', 'vm', 'port'].includes(key)) ||
      typeof existing.limactl !== 'string' ||
      !path.isAbsolute(existing.limactl) ||
      path.basename(existing.limactl) !== 'limactl' ||
      /[\0\r\n]/.test(existing.limactl) ||
      typeof existing.limaHome !== 'string' ||
      !path.isAbsolute(existing.limaHome) ||
      /[\0\r\n]/.test(existing.limaHome) ||
      typeof existing.vm !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(existing.vm) ||
      !Number.isSafeInteger(existing.port) ||
      Number(existing.port) < 1024 ||
      Number(existing.port) > 65535
    )
      throw new Error('AGENT_VM_CONFIG');
    // The original path identifies the legacy source; launchd must execute only the private verified tools.
  }
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  await privateDirectory(options.dataRoot);
  const tools = path.join(options.dataRoot, 'tools');
  const present = await lstat(tools).catch((error) => {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (present) {
    await privateDirectory(tools);
    return ownedExecutable(path.join(tools, 'bin/limactl'));
  }
  const manifest = await json(path.join(options.packDirectory, 'manifest.json'), false);
  const expected = dependencies.digest ?? expectedLima;
  if (
    !object(manifest) ||
    !object(manifest.lima) ||
    manifest.lima.file !== 'lima.tar.gz' ||
    manifest.lima.sha256 !== expected ||
    !Number.isSafeInteger(manifest.lima.bytes) ||
    Number(manifest.lima.bytes) < 1 ||
    Number(manifest.lima.bytes) > 512 * 1024 * 1024
  )
    throw new Error('AGENT_TOOLS_INTEGRITY');
  const archive = path.join(options.packDirectory, 'lima.tar.gz');
  const handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== manifest.lima.bytes)
      throw new Error('AGENT_TOOLS_INTEGRITY');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    if (
      digest.digest('hex') !== expected ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('AGENT_TOOLS_INTEGRITY');
  } finally {
    await handle.close();
  }
  const temporary = path.join(options.dataRoot, `tools-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const claimed = await lstat(temporary);
  try {
    // Extraction is restricted to the release-pinned official tool archive; model/customer data never uses tar.
    const result = await (dependencies.run ?? run)('/usr/bin/tar', [
      'xzf',
      archive,
      '--no-same-owner',
      '-C',
      temporary,
    ]);
    if (result.code !== 0) throw new Error('AGENT_TOOLS_UNAVAILABLE');
    const extracted = await lstat(temporary);
    if (
      !extracted.isDirectory() ||
      extracted.isSymbolicLink() ||
      extracted.ino !== claimed.ino ||
      extracted.dev !== claimed.dev
    )
      throw new Error('AGENT_TOOLS_UNSAFE');
    await chmod(temporary, 0o700);
    await privateDirectory(temporary);
    await validTree(temporary);
    await ownedExecutable(path.join(temporary, 'bin/limactl'));
    await rename(temporary, tools);
    return path.join(tools, 'bin/limactl');
  } finally {
    const current = await lstat(temporary).catch(() => undefined);
    if (current?.ino === claimed.ino && current.dev === claimed.dev)
      await rm(temporary, { recursive: true });
  }
}
