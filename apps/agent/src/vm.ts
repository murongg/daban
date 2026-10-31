import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface VmConfig {
  limactl: string;
  limaHome: string;
  vm: string;
  port: number;
}
interface ProcessOptions {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout: number;
  maxBuffer: number;
}
type Run = (program: string, args: string[], options: ProcessOptions) => Promise<unknown>;
type Probe = (
  program: string,
  args: string[],
  options: ProcessOptions,
) => Promise<{ code: number; stdout: string }>;
interface VmDependencies {
  run?: Run;
  probe?: Probe;
  port?: (preferred: number) => Promise<number>;
  absent?: (socketPath: string, signal: AbortSignal) => Promise<boolean>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
}
interface Connection {
  origin: string;
  token: string;
}
const run: Run = (program, args, options) =>
  new Promise((done, reject) => {
    // A forked SSH master must not inherit output pipes that keep the startup command pending.
    const child = spawn(program, args, {
      env: options.env,
      signal: options.signal,
      timeout: options.timeout,
      stdio: 'ignore',
    });
    child.once('error', () => reject(new Error('EXECUTOR_LINK_UNAVAILABLE')));
    child.once('close', (code) =>
      code === 0 ? done(undefined) : reject(new Error('EXECUTOR_LINK_UNAVAILABLE')),
    );
  });
const probe: Probe = (program, args, options) =>
  new Promise((done, reject) => {
    execFile(program, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('EXECUTOR_LINK_UNAVAILABLE'));
      else done({ code: error ? Number(error.code) : 0, stdout });
    });
  });
function availablePort(preferred: number): Promise<number> {
  return new Promise((done, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (preferred && error.code === 'EADDRINUSE') availablePort(0).then(done, reject);
      else reject(new Error('EXECUTOR_PORT_UNAVAILABLE'));
    });
    server.listen(preferred, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === 'string')
          reject(new Error('EXECUTOR_PORT_UNAVAILABLE'));
        else done(address.port);
      });
    });
  });
}
function socketAbsent(socketPath: string, signal: AbortSignal) {
  return new Promise<boolean>((done) => {
    const channel = net.createConnection(socketPath);
    const finish = (absent: boolean) => {
      channel.destroy();
      signal.removeEventListener('abort', abort);
      done(absent);
    };
    const abort = () => finish(false);
    channel.once('connect', () => finish(false));
    channel.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'),
    );
    channel.setTimeout(1000, () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<unknown>((done, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('EXECUTOR_LINK_CLOSED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      done(undefined);
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
async function metadata(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error('EXECUTOR_SOCKET_UNSAFE');
  }
}

export class VmLink {
  readonly socketPath: string;
  private readonly target: string;
  private readonly uid: number;
  private readonly cancellation = new AbortController();
  private starting?: Promise<Connection>;
  private connection?: Connection;
  private closing?: Promise<unknown>;
  private stopping?: Promise<unknown>;
  private detaching?: Promise<unknown>;
  private tunnel = false;
  private closed = false;
  constructor(
    readonly config: VmConfig,
    socketPath: string,
    private readonly dependencies: VmDependencies = {},
  ) {
    if (
      !config ||
      typeof config.limactl !== 'string' ||
      !isAbsolute(config.limactl) ||
      basename(config.limactl) !== 'limactl' ||
      typeof config.limaHome !== 'string' ||
      !isAbsolute(config.limaHome) ||
      typeof config.vm !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(config.vm) ||
      !Number.isSafeInteger(config.port) ||
      config.port < 1024 ||
      config.port > 65535 ||
      typeof socketPath !== 'string' ||
      !isAbsolute(socketPath) ||
      [config.limactl, config.limaHome, socketPath].some((value) => /[\0\r\n]/.test(value))
    )
      throw new Error('INVALID_VM_CONFIG');
    this.uid = process.getuid?.() ?? -1;
    if (this.uid < 0) throw new Error('EXECUTOR_SOCKET_UNSAFE');
    this.target = createHash('sha256')
      .update(
        JSON.stringify([resolve(config.limactl), resolve(config.limaHome), config.vm, config.port]),
      )
      .digest('hex');
    // Leave room for OpenSSH's temporary suffix within macOS's 104-byte Unix socket address limit.
    this.socketPath =
      Buffer.byteLength(socketPath) <= 80
        ? socketPath
        : join(
            '/tmp',
            `daban-executor-${this.uid}-${createHash('sha256')
              .update(JSON.stringify([resolve(socketPath), this.target]))
              .digest('hex')
              .slice(0, 24)}`,
            's',
          );
  }
  private checkOpen() {
    if (this.closed) throw new Error('EXECUTOR_LINK_CLOSED');
  }
  private options(timeout = 20000, cleanup = false): ProcessOptions {
    return {
      env: {
        PATH: `${dirname(this.config.limactl)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: homedir(),
        LANG: 'C',
        LIMA_HOME: this.config.limaHome,
      },
      ...(cleanup ? {} : { signal: this.cancellation.signal }),
      timeout,
      maxBuffer: 1024,
    };
  }
  private ssh(args: string[]) {
    return [
      '-F',
      join(this.config.limaHome, this.config.vm, 'ssh.config'),
      '-S',
      this.socketPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      ...args,
      `lima-${this.config.vm}`,
    ];
  }
  private async execute(program: string, args: string[], timeout = 20000, cleanup = false) {
    if (!cleanup) this.checkOpen();
    try {
      await (this.dependencies.run ?? run)(program, args, this.options(timeout, cleanup));
    } catch {
      if (!cleanup) this.checkOpen();
      throw new Error('EXECUTOR_LINK_UNAVAILABLE');
    }
    if (!cleanup) this.checkOpen();
  }
  private async probe(program: string, args: string[], maxBuffer = 1024) {
    this.checkOpen();
    try {
      const result = await (this.dependencies.probe ?? probe)(program, args, {
        ...this.options(8000),
        maxBuffer,
      });
      this.checkOpen();
      return result;
    } catch {
      this.checkOpen();
      throw new Error('EXECUTOR_LINK_UNAVAILABLE');
    }
  }
  private async checkSocket() {
    const folder = await metadata(dirname(this.socketPath));
    const file = await metadata(this.socketPath);
    if (
      !folder?.isDirectory() ||
      folder.isSymbolicLink() ||
      folder.uid !== this.uid ||
      (folder.mode & 0o777) !== 0o700 ||
      (file &&
        (!file.isSocket() ||
          file.uid !== this.uid ||
          file.nlink !== 1 ||
          (file.mode & 0o077) !== 0))
    )
      throw new Error('EXECUTOR_SOCKET_UNSAFE');
  }
  private async prepare() {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await this.checkSocket();
    this.checkOpen();
  }
  private async savedPort() {
    const file = join(dirname(this.socketPath), `${basename(this.socketPath)}.json`);
    const info = await metadata(file);
    if (!info) return undefined;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== this.uid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 4096
    )
      throw new Error('EXECUTOR_TUNNEL_STATE_INVALID');
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('target' in value) ||
        value.target !== this.target ||
        !('port' in value) ||
        typeof value.port !== 'number' ||
        !Number.isSafeInteger(value.port) ||
        value.port < 1024 ||
        value.port > 65535
      )
        throw new Error('EXECUTOR_TUNNEL_STATE_INVALID');
      return value.port;
    } catch {
      throw new Error('EXECUTOR_TUNNEL_STATE_INVALID');
    }
  }
  private async savePort(port: number) {
    const file = join(dirname(this.socketPath), `${basename(this.socketPath)}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ target: this.target, port }), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async readToken() {
    const file = '/var/lib/daban-executor/token';
    const command = `if [ ! -e ${file} ] && [ ! -L ${file} ]; then exit 44; fi; if [ ! -f ${file} ] || [ -L ${file} ]; then exit 43; fi; exec /bin/cat ${file}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      const args = this.ssh(['-o', 'ControlMaster=no']);
      const result = await this.probe('/usr/bin/ssh', [
        ...args,
        'sudo',
        '-n',
        '--',
        '/bin/sh',
        '-c',
        `'${command}'`,
      ]);
      if (result.code === 0 && /^[a-f0-9]{64}\n?$/.test(result.stdout)) return result.stdout.trim();
      if (result.code !== 44) throw new Error('EXECUTOR_AUTH_UNAVAILABLE');
      await (this.dependencies.wait ?? wait)(100, this.cancellation.signal);
    }
    throw new Error('EXECUTOR_AUTH_UNAVAILABLE');
  }
  private async start() {
    await this.prepare();
    const saved = await this.savedPort();
    // Only executor credentials cross this link; provider keys stay outside every guest process environment.
    await this.execute(this.config.limactl, ['start', '--tty=false', this.config.vm], 120000);
    await this.execute(
      this.config.limactl,
      ['shell', this.config.vm, 'sudo', '-n', 'systemctl', 'start', 'daban-executor.service'],
      120000,
    );
    return this.attach(saved);
  }
  private async attach(saved: number | undefined) {
    this.checkOpen();
    const existing = await this.probe('/usr/bin/ssh', this.ssh(['-O', 'check']));
    let port: number;
    if (existing.code === 0) {
      if (saved === undefined) throw new Error('EXECUTOR_TUNNEL_UNVERIFIED');
      port = saved;
    } else {
      if (
        existing.code !== 255 ||
        !(await (this.dependencies.absent ?? socketAbsent)(
          this.socketPath,
          this.cancellation.signal,
        ))
      )
        throw new Error('EXECUTOR_TUNNEL_UNVERIFIED');
      this.checkOpen();
      port = await (this.dependencies.port ?? availablePort)(this.config.port);
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
        throw new Error('EXECUTOR_PORT_UNAVAILABLE');
      await this.savePort(port);
      // A fork may finish after cancellation; shutdown must still close the scoped master it may have created.
      this.tunnel = true;
      await this.execute(
        '/usr/bin/ssh',
        this.ssh([
          '-M',
          '-o',
          'ControlMaster=yes',
          '-o',
          'ControlPersist=yes',
          '-o',
          'ExitOnForwardFailure=yes',
          '-fNT',
          '-L',
          `127.0.0.1:${port}:127.0.0.1:8766`,
        ]),
      );
    }
    this.tunnel = true;
    const token = await this.readToken();
    this.checkOpen();
    this.connection = { origin: `http://127.0.0.1:${port}`, token };
    return this.connection;
  }
  ensure(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(new Error('EXECUTOR_POWER_BUSY'));
    if (this.connection) return Promise.resolve(this.connection);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  reconnect(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(new Error('EXECUTOR_POWER_BUSY'));
    this.connection = undefined;
    this.starting ??= (async () => {
      await this.prepare();
      const saved = await this.savedPort();
      // Status recovery may attach to a running VM; only explicit startup/power operations may wake one.
      if ((await this.state()) !== 'running') throw new Error('EXECUTOR_OFFLINE');
      this.checkOpen();
      return this.attach(saved);
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async state(): Promise<'running' | 'stopped' | 'unknown'> {
    this.checkOpen();
    try {
      const result = await this.probe(
        this.config.limactl,
        ['list', '--format=json', this.config.vm],
        64 * 1024,
      );
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (result.code !== 0 || lines.length !== 1) return 'unknown';
      const value: unknown = JSON.parse(lines[0]);
      if (
        !value ||
        typeof value !== 'object' ||
        !('name' in value) ||
        value.name !== this.config.vm ||
        !('status' in value)
      )
        return 'unknown';
      return value.status === 'Running'
        ? 'running'
        : value.status === 'Stopped'
          ? 'stopped'
          : 'unknown';
    } catch {
      this.checkOpen();
      return 'unknown';
    }
  }
  startVm() {
    this.checkOpen();
    this.connection = undefined;
    return this.ensure();
  }
  private detach() {
    this.detaching ??= (async () => {
      this.connection = undefined;
      if (this.tunnel) {
        await this.checkSocket();
        await this.execute('/usr/bin/ssh', this.ssh(['-O', 'exit']), 8000, true);
        this.tunnel = false;
      }
    })().finally(() => {
      this.detaching = undefined;
    });
    return this.detaching;
  }
  stopVm() {
    this.checkOpen();
    this.stopping ??= (async () => {
      await this.starting?.catch(() => {});
      this.checkOpen();
      await this.detach();
      this.checkOpen();
      await this.execute(this.config.limactl, ['stop', '--tty=false', this.config.vm], 120000);
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  close() {
    this.closed = true;
    this.cancellation.abort();
    this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      await this.detach();
    })();
    return this.closing;
  }
}
