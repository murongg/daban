import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { RemoteExecutor } from '@daban/engine/agent';
import { validateVmConnection, vmConnectionTarget } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import { isVmConnection, type VmConnection } from '@daban/protocol';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';
import { Qmp } from './qmp.js';
import { type ExecutorTunnel, openExecutorTunnel, sshEnvironment } from './ssh.js';
import { WindowsHost } from './windows.js';

export interface QemuMachine {
  version: 1;
  connection: VmConnection;
  acceleration: 'whpx' | 'tcg';
  qmpPort: number;
  toolsId: string;
  pid?: number;
  launching?: boolean;
}
interface LaunchOptions {
  env: NodeJS.ProcessEnv;
  directory: string;
}
type Control = Pick<Qmp, 'execute' | 'close'>;
interface Dependencies {
  control?: (machine: QemuMachine, root: string) => Promise<Control>;
  launch?: (program: string, args: string[], options: LaunchOptions) => Promise<number>;
  verify?: (machine: QemuMachine, root: string) => Promise<unknown>;
  alive?: (pid: number) => boolean | undefined | Promise<boolean | undefined>;
  tunnel?: typeof openExecutorTunnel;
  port?: () => Promise<number>;
  ready?: (connection: ExecutorTunnel['connection'], signal: AbortSignal) => Promise<unknown>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const port = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;

export function parseQemuMachine(value: unknown, root: string): QemuMachine {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'connection',
          'acceleration',
          'qmpPort',
          'toolsId',
          'pid',
          'launching',
        ].includes(key),
    ) ||
    value.version !== 1 ||
    !isVmConnection(value.connection) ||
    value.connection.provider !== 'qemu' ||
    value.connection.identityFile !== path.join(root, 'keys/id_ed25519') ||
    !['whpx', 'tcg'].includes(String(value.acceleration)) ||
    !port(value.qmpPort) ||
    value.qmpPort === value.connection.sshPort ||
    typeof value.toolsId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.toolsId) ||
    (value.pid !== undefined &&
      (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1)) ||
    (value.launching !== undefined && typeof value.launching !== 'boolean')
  )
    throw Error('QEMU_CONFIG_INVALID');
  validateVmConnection(value.connection);
  return value as unknown as QemuMachine;
}

function option(value: string) {
  return value.replaceAll('\\', '/').replaceAll(',', ',,');
}
export function qemuArguments(input: QemuMachine, root: string) {
  const machine = parseQemuMachine(input, root);
  return [
    '-no-user-config',
    '-nodefaults',
    '-L',
    path.join(root, 'tools/share'),
    '-machine',
    // This pinned BIOS pauses with WHPX's APIC and host CPU (VP exit 4). Keep CPU acceleration;
    // restore the default IRQ controller only after a newer pinned QEMU passes the BIOS boot check.
    machine.acceleration === 'whpx' ? 'q35,kernel-irqchip=off' : 'q35',
    '-accel',
    machine.acceleration === 'whpx' ? 'whpx' : 'tcg,thread=multi',
    '-cpu',
    machine.acceleration === 'whpx' ? 'host' : 'max',
    '-smp',
    '4',
    '-m',
    '6144',
    '-name',
    `daban-${machine.connection.vmId}`,
    '-uuid',
    machine.connection.vmId,
    '-drive',
    `file=${option(path.join(root, 'disk.qcow2'))},if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap`,
    '-drive',
    `file=${option(path.join(root, 'seed.iso'))},media=cdrom,readonly=on,format=raw`,
    '-device',
    'virtio-net-pci,netdev=network',
    '-netdev',
    `user,id=network,hostfwd=tcp:127.0.0.1:${machine.connection.sshPort}-:22`,
    // The pinned BIOS/GRUB image needs VGA to finish boot, even when Linux desktops use Xvfb.
    '-device',
    'VGA',
    '-display',
    'none',
    '-monitor',
    'none',
    '-serial',
    `file:${path.join(root, 'console.log')}`,
    '-object',
    `tls-creds-x509,id=control,dir=${option(path.join(root, 'tls'))},endpoint=server,verify-peer=on`,
    '-qmp',
    `tcp:127.0.0.1:${machine.qmpPort},server=on,wait=off,tls-creds=control`,
  ];
}

export async function qemuFileHash(file: string) {
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1)
    throw Error('QEMU_ASSET_UNSAFE');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.ino !== named.ino || before.dev !== named.dev) throw Error('QEMU_ASSET_UNSAFE');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error('QEMU_ASSET_UNSAFE');
    return { bytes: before.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function verifyQemuTools(machine: QemuMachine, root: string) {
  const tools = await secureDirectory(path.join(root, 'tools'));
  const file = path.join(tools, 'manifest.json');
  const metadata = await qemuFileHash(file);
  if (metadata.sha256 !== machine.toolsId) throw Error('QEMU_ASSET_INTEGRITY');
  const manifest = await readQemuRecord(file);
  if (
    !record(manifest) ||
    manifest.version !== 1 ||
    !record(manifest.files) ||
    Object.keys(manifest.files).length > 4096 ||
    !('qemu-system-x86_64.exe' in manifest.files) ||
    !('qemu-img.exe' in manifest.files)
  )
    throw Error('QEMU_ASSET_INTEGRITY');
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (
      !/^[a-zA-Z0-9_.,+/-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      !record(expected) ||
      typeof expected.sha256 !== 'string' ||
      typeof expected.bytes !== 'number'
    )
      throw Error('QEMU_ASSET_INTEGRITY');
    const actual = await qemuFileHash(path.join(tools, name));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw Error('QEMU_ASSET_INTEGRITY');
  }
  const declared = new Set(['manifest.json', ...Object.keys(manifest.files)]);
  async function inventory(relative = '') {
    for (const entry of await readdir(path.join(tools, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error('QEMU_ASSET_UNSAFE');
      if (entry.isDirectory()) await inventory(name);
      else if (!entry.isFile() || !declared.has(name)) throw Error('QEMU_ASSET_INTEGRITY');
    }
  }
  await inventory();
}

export async function qemuLock<T>(root: string, action: () => Promise<T>, operation = 'power') {
  const canonical = await realpath(root);
  const id = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .update(operation)
    .digest('hex');
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-qemu-${id}`
      : process.platform === 'linux'
        ? `\0daban-qemu-${id}`
        : path.join(root, `${operation}.sock`);
  // An OS-owned listener excludes other processes and disappears on Windows process exit; it accepts no commands.
  const lock = net.createServer((socket) => socket.destroy());
  await new Promise<unknown>((resolve, reject) => {
    lock.once('error', () => reject(Error('QEMU_POWER_BUSY')));
    lock.listen(address, () => resolve(undefined));
  });
  try {
    return await action();
  } finally {
    await new Promise<unknown>((resolve) => lock.close(() => resolve(undefined)));
  }
}

async function verifyLaunch(machine: QemuMachine, root: string) {
  await verifyQemuTools(machine, root);
  for (const name of [
    'disk.qcow2',
    'seed.iso',
    'tls/ca-cert.pem',
    'tls/server-cert.pem',
    'tls/server-key.pem',
  ]) {
    const file = path.join(root, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw Error('QEMU_STORE_UNSAFE');
  }
}

async function control(machine: QemuMachine, root: string) {
  const keys = await readQemuRecord(path.join(root, 'control.json'));
  if (
    !record(keys) ||
    !['ca', 'clientCert', 'clientKey'].every((name) => typeof keys[name] === 'string')
  )
    throw Error('QEMU_CONTROL_CONFIG');
  return Qmp.open({
    port: machine.qmpPort,
    uuid: machine.connection.vmId,
    ca: String(keys.ca),
    cert: String(keys.clientCert),
    key: String(keys.clientKey),
  });
}
async function launch(program: string, args: string[], options: LaunchOptions) {
  const log = await open(path.join(options.directory, `launch-${randomUUID()}.log`), 'wx', 0o600);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(program, args, {
        env: options.env,
        cwd: options.directory,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      child.once('error', () => reject(Error('QEMU_LAUNCH_FAILED')));
      child.once('spawn', () => {
        if (!child.pid) {
          reject(Error('QEMU_LAUNCH_FAILED'));
          return;
        }
        child.unref();
        resolve(child.pid);
      });
    });
  } finally {
    await log.close();
  }
}
function alive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
      ? false
      : undefined;
  }
}
async function availablePort() {
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

export class QemuLink {
  private readonly host = new WindowsHost();
  private readonly config: VmConnection;
  private readonly root: string;
  private readonly cancellation = new AbortController();
  private starting?: Promise<ExecutorTunnel['connection']>;
  private booting?: Promise<QemuMachine>;
  private stopping?: Promise<unknown>;
  private tunnel?: ExecutorTunnel;
  private closed = false;
  constructor(
    config: VmConnection,
    dataRoot: string,
    private readonly dependencies: Dependencies = {},
  ) {
    validateVmConnection(config);
    if (config.provider !== 'qemu' || !path.isAbsolute(dataRoot))
      throw Error('QEMU_CONFIG_INVALID');
    this.config = Object.freeze(structuredClone(config));
    this.root = path.join(dataRoot, 'qemu');
  }
  private check() {
    if (this.closed) throw Error('EXECUTOR_LINK_CLOSED');
  }
  private alive(pid: number) {
    if (this.dependencies.alive) return this.dependencies.alive(pid);
    return process.platform === 'win32'
      ? this.host.owns(pid, path.join(this.root, 'tools/qemu-system-x86_64.exe'))
      : alive(pid);
  }
  private async machine() {
    this.check();
    const machine = parseQemuMachine(
      await readQemuRecord(path.join(this.root, 'machine.json')),
      this.root,
    );
    if (
      vmConnectionTarget(machine.connection) !== vmConnectionTarget(this.config) ||
      machine.connection.sshPort !== this.config.sshPort ||
      machine.connection.identityFile !== this.config.identityFile
    )
      throw Error('QEMU_IDENTITY_CHANGED');
    return machine;
  }
  private async inspect(machine: QemuMachine): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const qmp = await (this.dependencies.control ?? control)(machine, this.root);
      try {
        const result = await qmp.execute('query-status');
        return record(result) && result.status === 'running' ? 'running' : 'unknown';
      } finally {
        await qmp.close();
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'QEMU_CONTROL_OFFLINE' &&
        !machine.launching &&
        (!machine.pid || (await this.alive(machine.pid)) === false)
      )
        return 'stopped';
      if (error instanceof Error && error.message === 'QEMU_IDENTITY_CHANGED') throw error;
      return 'unknown';
    }
  }
  async state() {
    return this.inspect(await this.machine());
  }
  private async pause() {
    this.check();
    await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(Error('EXECUTOR_LINK_CLOSED'));
      };
      const timer = setTimeout(() => {
        this.cancellation.signal.removeEventListener('abort', abort);
        resolve(undefined);
      }, 500);
      this.cancellation.signal.addEventListener('abort', abort, { once: true });
      if (this.cancellation.signal.aborted) abort();
    });
  }
  boot() {
    if (this.closed) return Promise.reject(Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(Error('EXECUTOR_POWER_BUSY'));
    this.booting ??= qemuLock(this.root, () => this.bootNow()).finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }
  private async bootNow() {
    let machine = await this.machine();
    const state = await this.inspect(machine);
    this.check();
    if (state === 'running') return machine;
    if (state !== 'stopped') throw Error('QEMU_LAUNCH_UNCERTAIN');
    await (this.dependencies.verify ?? verifyLaunch)(machine, this.root);
    this.check();
    await writeQemuRecord(path.join(this.root, 'machine.json'), { ...machine, launching: true });
    const pid = await (this.dependencies.launch ?? launch)(
      path.join(this.root, 'tools/qemu-system-x86_64.exe'),
      qemuArguments(machine, this.root),
      { env: sshEnvironment(), directory: this.root },
    );
    // Persist the accepted process before waiting. A lost acknowledgement must never authorize a second guest.
    machine = { ...machine, pid, launching: false };
    await writeQemuRecord(path.join(this.root, 'machine.json'), machine);
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      this.check();
      if ((await this.inspect(machine)) === 'running') return machine;
      if ((await this.alive(pid)) === false) throw Error('QEMU_LAUNCH_FAILED');
      await this.pause();
    }
    throw Error('QEMU_LAUNCH_UNCERTAIN');
  }
  private async attach(start: boolean) {
    if (start) await this.boot();
    else if ((await this.state()) !== 'running') throw Error('EXECUTOR_OFFLINE');
    this.check();
    await this.tunnel?.close();
    this.tunnel = undefined;
    const until = Date.now() + (start ? 600000 : 0);
    for (;;) {
      this.check();
      let candidate: ExecutorTunnel | undefined;
      try {
        const localPort = await (this.dependencies.port ?? availablePort)();
        const tunnel = await (this.dependencies.tunnel ?? openExecutorTunnel)(
          this.config,
          this.root,
          localPort,
          start,
          this.cancellation.signal,
        );
        candidate = tunnel;
        this.check();
        await (
          this.dependencies.ready ??
          (async (connection, signal) => {
            const executor = new RemoteExecutor({
              url: `${connection.origin}/exec`,
              token: connection.token,
              fetcher: (url, init) =>
                fetch(url, {
                  ...init,
                  signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
                }),
            });
            await executor.ready;
          })
        )(tunnel.connection, this.cancellation.signal);
        this.check();
        this.tunnel = tunnel;
        return tunnel.connection;
      } catch (error) {
        await candidate?.close();
        if (
          this.closed ||
          !(error instanceof Error) ||
          !['EXECUTOR_LINK_UNAVAILABLE', 'EXECUTION_UNAVAILABLE'].includes(error.message) ||
          Date.now() >= until
        )
          throw error;
        await this.pause();
      }
    }
  }
  ensure() {
    if (this.closed) return Promise.reject(Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(Error('EXECUTOR_POWER_BUSY'));
    if (this.tunnel?.alive) return Promise.resolve(this.tunnel.connection);
    this.starting ??= this.attach(true).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  reconnect() {
    if (this.closed) return Promise.reject(Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(Error('EXECUTOR_POWER_BUSY'));
    this.starting ??= this.attach(false).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  startVm() {
    return this.ensure();
  }
  stopVm() {
    this.check();
    this.stopping ??= this.stopNow().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async stopNow() {
    await this.starting?.catch(() => {});
    await this.booting?.catch(() => {});
    this.check();
    return qemuLock(this.root, () => this.powerDown());
  }
  private async powerDown() {
    const machine = await this.machine();
    if ((await this.inspect(machine)) === 'stopped') return;
    await this.tunnel?.close();
    this.tunnel = undefined;
    const qmp = await (this.dependencies.control ?? control)(machine, this.root);
    try {
      await qmp.execute('system_powerdown');
    } finally {
      await qmp.close();
    }
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      if ((await this.state()) === 'stopped') return;
      await this.pause();
    }
    throw Error('QEMU_SHUTDOWN_PENDING');
  }
  async close() {
    this.closed = true;
    this.cancellation.abort();
    await this.starting?.catch(() => {});
    await this.booting?.catch(() => {});
    await this.stopping?.catch(() => {});
    await this.tunnel?.close();
    this.tunnel = undefined;
    // QEMU is detached from the UI and host connection; accepted guest tasks keep their process owner.
  }
}
