import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { RemoteExecutor } from '@daban/engine/agent';
import { readVmConnection, saveVmConnection } from '@daban/engine/host';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import {
  managedProtocol,
  type QemuMode,
  type SetupStatus,
  type VmConnection,
} from '@daban/protocol';
import {
  parseQemuMachine,
  QemuLink,
  type QemuMachine,
  qemuFileHash,
  qemuLock,
  verifyQemuTools,
} from './qemu.js';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';
import { createQmpCertificates } from './qmp.js';
import { seedImage } from './seed.js';
import { sshEnvironment } from './ssh.js';

export interface QemuImage {
  bytes: number;
  sha256: string;
  expandedBytes: number;
  expandedSha256: string;
}
export interface QemuBundle {
  version: 1;
  protocol: number;
  image: QemuImage;
  toolsId: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bytes = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= limit;
const absent = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
export function parseQemuBundle(value: unknown): QemuBundle {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    value.protocol !== managedProtocol ||
    !digest(value.toolsId) ||
    !record(value.image) ||
    Object.keys(value.image).length !== 4 ||
    !bytes(value.image.bytes, 16 * 1024 ** 3) ||
    !bytes(value.image.expandedBytes, 64 * 1024 ** 3) ||
    !digest(value.image.sha256) ||
    !digest(value.image.expandedSha256)
  )
    throw Error('QEMU_BUNDLE_INVALID');
  return value as unknown as QemuBundle;
}
export async function readQemuBundle(directory: string) {
  const file = path.join(directory, 'qemu.json');
  const named = await lstat(file).catch(() => {
    throw Error('QEMU_BUNDLE_MISSING');
  });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 8192)
    throw Error('QEMU_BUNDLE_INVALID');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.ino !== named.ino || info.dev !== named.dev || info.size > 8192)
      throw Error('QEMU_BUNDLE_INVALID');
    const text = await handle.readFile('utf8');
    return {
      ...parseQemuBundle(JSON.parse(text)),
      id: createHash('sha256').update(text).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

export async function unpackQemuImage(
  directory: string,
  root: string,
  image: QemuImage,
  signal: AbortSignal,
  progress?: (received: number, total: number) => unknown,
) {
  const target = path.join(root, 'disk.qcow2');
  const existing = await lstat(target).catch((error) => {
    if (!absent(error)) throw error;
    return undefined;
  });
  // An initialized disk is mutable user state. Only the pre-launch path may check the original image hash.
  if (existing) {
    const actual = await qemuFileHash(target);
    if (actual.bytes === image.expandedBytes && actual.sha256 === image.expandedSha256) return;
    throw Error('QEMU_EXISTING_DISK');
  }
  signal.throwIfAborted();
  const file = path.join(directory, 'desktop.qcow2.gz');
  const compressed = await qemuFileHash(file);
  if (compressed.bytes !== image.bytes || compressed.sha256 !== image.sha256)
    throw Error('QEMU_ASSET_INTEGRITY');
  const temporary = path.join(root, `.image-${randomUUID()}`);
  const output = await open(temporary, 'wx', 0o600);
  let input: Awaited<ReturnType<typeof open>> | undefined;
  let received = 0;
  const hash = createHash('sha256');
  try {
    input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await input.stat();
    if (opened.size !== image.bytes || !opened.isFile() || opened.nlink !== 1)
      throw Error('QEMU_ASSET_UNSAFE');
    await pipeline(
      input.createReadStream({ autoClose: false }),
      createGunzip(),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received > image.expandedBytes) {
            done(Error('QEMU_ASSET_INTEGRITY'));
            return;
          }
          hash.update(chunk);
          progress?.(received, image.expandedBytes);
          done(null, chunk);
        },
      }),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          // FileHandle.write may return a short write; writeFile consumes the whole buffer at the current offset.
          output.writeFile(chunk).then(() => done(), done);
        },
      }),
      { signal },
    );
    if (received !== image.expandedBytes || hash.digest('hex') !== image.expandedSha256)
      throw Error('QEMU_ASSET_INTEGRITY');
    await output.sync();
    signal.throwIfAborted();
    await output.close();
    // The installer owns this directory and never replaces a disk that has reached machine publication.
    if (
      await lstat(target).then(
        () => true,
        (error) => {
          if (!absent(error)) throw error;
          return false;
        },
      )
    )
      throw Error('QEMU_EXISTING_DISK');
    await rename(temporary, target);
  } finally {
    await input?.close();
    await output.close();
    await unlink(temporary).catch((error) => {
      if (!absent(error)) throw error;
    });
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
  if (!address || typeof address === 'string') throw Error('EXECUTOR_PORT_UNAVAILABLE');
  return address.port;
}
async function publicKey(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192)
    throw Error('QEMU_STORE_UNSAFE');
  return (await readFile(file, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
}
async function immutableFile(file: string, content: string | Buffer) {
  try {
    await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      !(await privateMetadata(file, info, 0o600)) ||
      !(await readFile(file)).equals(Buffer.from(content))
    )
      throw Error('QEMU_STORE_UNSAFE');
  }
}
export interface QemuInstallOptions {
  dataRoot: string;
  vmConfigFile: string;
  bundleDirectory: string;
  mode: QemuMode;
  signal: AbortSignal;
  changed: (value: Partial<SetupStatus>) => Promise<unknown>;
}
export async function installQemu(options: QemuInstallOptions) {
  const root = await secureDirectory(path.join(options.dataRoot, 'qemu'));
  return qemuLock(root, () => installNow(options), 'install');
}
async function installNow(options: QemuInstallOptions) {
  const { signal, changed } = options;
  const root = await secureDirectory(path.join(options.dataRoot, 'qemu'));
  const originFile = path.join(root, 'origin.json');
  const origin = await readQemuRecord(originFile);
  if (origin !== undefined && (!record(origin) || origin.version !== 1 || !digest(origin.bundle)))
    throw Error('QEMU_STORE_UNSAFE');
  const saved = await readQemuRecord(path.join(root, 'machine.json'));
  let machine: QemuMachine;
  if (saved !== undefined) {
    machine = parseQemuMachine(saved, root);
    // Published machines own mutable user data and pinned private tools, independent of later app bundles.
    if (!origin || machine.acceleration !== options.mode) throw Error('QEMU_MODE_CHANGED');
  } else {
    const bundle = await readQemuBundle(options.bundleDirectory);
    if (record(origin) && origin.bundle !== bundle.id) throw Error('QEMU_BUNDLE_CHANGED');
    if (!origin) {
      const names = await readdir(root);
      if (names.length) throw Error('QEMU_SETUP_UNCERTAIN');
      await writeQemuRecord(originFile, { version: 1, bundle: bundle.id });
    }
    const space = await statfs(root);
    if (space.bavail * space.bsize < bundle.image.expandedBytes + 4 * 1024 ** 3)
      throw Error('QEMU_DISK_SPACE');
    await changed({ phase: 'extracting', progress: undefined });
    await unpackQemuImage(options.bundleDirectory, root, bundle.image, signal);
    const tools = await secureDirectory(path.join(root, 'tools'));
    const source = path.join(options.bundleDirectory, 'tools');
    const manifest = await qemuFileHash(path.join(source, 'manifest.json'));
    if (manifest.sha256 !== bundle.toolsId) throw Error('QEMU_ASSET_INTEGRITY');
    async function copy(relative = '') {
      for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
        signal.throwIfAborted();
        const name = path.join(relative, entry.name),
          target = path.join(tools, name);
        if (entry.isSymbolicLink()) throw Error('QEMU_ASSET_UNSAFE');
        if (entry.isDirectory()) {
          await secureDirectory(target);
          await copy(name);
        } else if (entry.isFile()) {
          const original = await qemuFileHash(path.join(source, name));
          try {
            await copyFile(path.join(source, name), target, constants.COPYFILE_EXCL);
          } catch (error) {
            if (
              !error ||
              typeof error !== 'object' ||
              !('code' in error) ||
              error.code !== 'EEXIST'
            )
              throw error;
          }
          const local = await qemuFileHash(target);
          if (local.sha256 !== original.sha256 || local.bytes !== original.bytes)
            throw Error('QEMU_ASSET_INTEGRITY');
        } else throw Error('QEMU_ASSET_UNSAFE');
      }
    }
    await copy();
    await changed({ phase: 'creating', progress: undefined });
    const keys = path.join(root, 'keys');
    if (
      !(await lstat(keys).catch((error) => {
        if (!absent(error)) throw error;
        return undefined;
      }))
    ) {
      const stage = await secureDirectory(path.join(root, `.keys-${randomUUID()}`));
      const keygen = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/OpenSSH/ssh-keygen.exe',
      );
      const execute = promisify(execFile);
      for (const name of ['id_ed25519', 'host_ed25519'])
        await execute(
          keygen,
          ['-q', '-t', 'ed25519', '-N', '', '-C', 'daban', '-f', path.join(stage, name)],
          { windowsHide: true, timeout: 15000, env: sshEnvironment(), signal },
        );
      await rename(stage, keys);
    }
    await secureDirectory(keys);
    const hostKey = await publicKey(path.join(keys, 'host_ed25519.pub'));
    const identityFile = path.join(keys, 'id_ed25519');
    const identity = await lstat(identityFile);
    if (!(await privateMetadata(identityFile, identity, 0o600))) throw Error('QEMU_STORE_UNSAFE');
    const pems =
      (await readQemuRecord(path.join(root, 'control.json'))) ?? (await createQmpCertificates());
    if (
      !record(pems) ||
      !['ca', 'serverCert', 'serverKey', 'clientCert', 'clientKey'].every(
        (key) => typeof pems[key] === 'string',
      )
    )
      throw Error('QEMU_CONTROL_CONFIG');
    await writeQemuRecord(path.join(root, 'control.json'), pems);
    const tls = await secureDirectory(path.join(root, 'tls'));
    for (const [name, value] of [
      ['ca-cert.pem', pems.ca],
      ['server-cert.pem', pems.serverCert],
      ['server-key.pem', pems.serverKey],
    ])
      await immutableFile(path.join(tls, String(name)), String(value));
    let request = await readQemuRecord(path.join(root, 'instance.json'));
    if (request === undefined) {
      const sshPort = await freePort();
      let qmpPort = await freePort();
      while (qmpPort === sshPort) qmpPort = await freePort();
      const connection: VmConnection = {
        provider: 'qemu',
        enabled: true,
        vmId: randomUUID(),
        host: '127.0.0.1',
        sshPort,
        user: 'daban',
        identityFile,
        hostKey,
      };
      request = {
        version: 1,
        connection,
        qmpPort,
        toolsId: bundle.toolsId,
        acceleration: options.mode,
      };
      await writeQemuRecord(path.join(root, 'instance.json'), request);
    }
    machine = parseQemuMachine(request, root);
    if (machine.acceleration !== options.mode) throw Error('QEMU_MODE_CHANGED');
    const cloud = {
      hostname: 'daban',
      manage_etc_hosts: true,
      users: [
        {
          name: 'daban',
          shell: '/bin/bash',
          lock_passwd: true,
          ssh_authorized_keys: [await publicKey(path.join(keys, 'id_ed25519.pub'))],
        },
      ],
      ssh_pwauth: false,
      disable_root: true,
      ssh_deletekeys: false,
      ssh_keys: {
        ed25519_private: await readFile(path.join(keys, 'host_ed25519'), 'utf8'),
        ed25519_public: hostKey,
      },
      runcmd: [['systemctl', 'enable', '--now', 'ssh.service', 'daban-executor.service']],
    };
    await immutableFile(
      path.join(root, 'seed.iso'),
      seedImage(
        `#cloud-config\n${JSON.stringify(cloud)}\n`,
        `${JSON.stringify({ 'instance-id': `daban-${machine.connection.vmId}`, 'local-hostname': 'daban' })}\n`,
      ),
    );
    await verifyQemuTools(machine, root);
    signal.throwIfAborted();
    await writeQemuRecord(path.join(root, 'machine.json'), machine);
  }
  const owner = new QemuLink(machine.connection, options.dataRoot);
  const abort = () => {
    owner.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await changed({ phase: 'starting' });
    await owner.boot();
    await changed({ phase: 'connecting' });
    const connection = await owner.ensure();
    const executor = new RemoteExecutor({
      url: `${connection.origin}/exec`,
      token: connection.token,
    });
    await executor.ready;
    signal.throwIfAborted();
    const existing = await readVmConnection(options.vmConfigFile);
    if (existing && existing.vmId !== machine.connection.vmId) throw Error('QEMU_IDENTITY_CHANGED');
    await saveVmConnection(options.vmConfigFile, machine.connection);
  } finally {
    signal.removeEventListener('abort', abort);
    await owner.close();
  }
}
