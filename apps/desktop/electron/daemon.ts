import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { prepareSocket } from './socket';

export interface DaemonConfig {
  dataRoot: string;
  socketPath: string;
  vmConfig: string;
  executable: string;
  entry: string;
}
export interface DaemonIdentity {
  role: 'agent';
  scope: string;
  dataRoot: string;
  socketPath: string;
}
interface CommandOptions {
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}
type Run = (
  program: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ code: number; stdout: string }>;
interface DaemonDependencies {
  run?: Run;
  inspect?: (socketPath: string, signal: AbortSignal) => Promise<unknown>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  platform?: NodeJS.Platform;
  uid?: number;
}
const runCommand: Run = (program, args, options) =>
  new Promise((done, reject) => {
    execFile(program, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('AGENT_DAEMON_UNAVAILABLE'));
      else done({ code: error ? Number(error.code) : 0, stdout });
    });
  });
const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<unknown>((done, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('AGENT_DAEMON_CLOSED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      done(undefined);
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
function inspect(socketPath: string, signal: AbortSignal) {
  return new Promise<unknown>((done, reject) => {
    const connection = request(
      {
        socketPath,
        agent: false,
        path: '/agent/identity',
        method: 'GET',
        headers: { host: '127.0.0.1:8766' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            reject(new Error('AGENT_DAEMON_UNAVAILABLE'));
            connection.destroy(new Error('AGENT_DAEMON_UNAVAILABLE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', () => reject(new Error('AGENT_DAEMON_UNAVAILABLE')));
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('AGENT_DAEMON_UNAVAILABLE');
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('AGENT_DAEMON_UNAVAILABLE'));
          }
        });
      },
    );
    connection.once('error', (error) => {
      if ('code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code)))
        done(undefined);
      else reject(new Error('AGENT_DAEMON_UNAVAILABLE'));
    });
    connection.end();
  });
}
export function daemonScope(dataRoot: string, vmConfig: string) {
  return createHash('sha256')
    .update(JSON.stringify([resolve(dataRoot), resolve(vmConfig)]))
    .digest('hex');
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character]!,
  );

export class Daemon {
  readonly scope: string;
  readonly label: string;
  private readonly uid: number;
  private readonly cancellation = new AbortController();
  private starting?: Promise<DaemonIdentity>;
  private closed = false;
  constructor(
    readonly config: DaemonConfig,
    private readonly dependencies: DaemonDependencies = {},
  ) {
    this.uid = dependencies.uid ?? process.getuid?.() ?? -1;
    if (
      (dependencies.platform ?? process.platform) !== 'darwin' ||
      !Number.isSafeInteger(this.uid) ||
      this.uid < 0 ||
      Object.values(config).some(
        (value) => typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value),
      ) ||
      Buffer.byteLength(config.socketPath) > 103
    )
      throw new Error('AGENT_DAEMON_CONFIG_INVALID');
    this.scope = daemonScope(config.dataRoot, config.vmConfig);
    this.label = `dev.daban.agent.${this.scope.slice(0, 32)}`;
  }
  private checkOpen() {
    if (this.closed) throw new Error('AGENT_DAEMON_CLOSED');
  }
  private async privateFile(file: string, content: string) {
    try {
      await writeFile(file, content, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
        throw error;
    }
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== this.uid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error('AGENT_DAEMON_PATH_UNSAFE');
  }
  private async prepare() {
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    const folder = await lstat(this.config.dataRoot);
    if (
      !folder.isDirectory() ||
      folder.isSymbolicLink() ||
      folder.uid !== this.uid ||
      (folder.mode & 0o777) !== 0o700
    )
      throw new Error('AGENT_DAEMON_PATH_UNSAFE');
    try {
      await prepareSocket(this.config.socketPath);
    } catch {
      throw new Error('AGENT_DAEMON_PATH_UNSAFE');
    }
  }
  private async identity() {
    this.checkOpen();
    const value = await (this.dependencies.inspect ?? inspect)(
      this.config.socketPath,
      this.cancellation.signal,
    );
    this.checkOpen();
    if (value === undefined) return undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      !('role' in value) ||
      value.role !== 'agent' ||
      !('scope' in value) ||
      value.scope !== this.scope ||
      !('dataRoot' in value) ||
      value.dataRoot !== this.config.dataRoot ||
      !('socketPath' in value) ||
      value.socketPath !== this.config.socketPath
    )
      throw new Error('AGENT_DAEMON_SCOPE_MISMATCH');
    return value as DaemonIdentity;
  }
  private async command(args: string[]) {
    this.checkOpen();
    return (this.dependencies.run ?? runCommand)('/bin/launchctl', args, {
      signal: this.cancellation.signal,
      timeout: 8000,
      maxBuffer: 64 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
  }
  private async launch() {
    await this.prepare();
    const existing = await this.identity();
    if (existing) return existing;
    const domain = `gui/${this.uid}`;
    const target = `${domain}/${this.label}`;
    if ((await this.command(['print', target])).code !== 0) {
      const log = join(this.config.dataRoot, 'agent.log');
      await this.privateFile(log, '');
      const plist = join(this.config.dataRoot, 'agent.plist');
      await this.privateFile(plist, '');
      const args = [
        '--expose-internals',
        this.config.entry,
        '--data',
        this.config.dataRoot,
        '--socket',
        this.config.socketPath,
        '--vm-config',
        this.config.vmConfig,
      ];
      const content =
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        `<key>Label</key><string>${xml(this.label)}</string>` +
        `<key>ProgramArguments</key><array>${[this.config.executable, ...args].map((argument) => `<string>${xml(argument)}</string>`).join('')}</array>` +
        '<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>' +
        `<key>WorkingDirectory</key><string>${xml(this.config.dataRoot)}</string>` +
        `<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>` +
        '<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ProcessType</key><string>Background</string></dict></plist>\n';
      const temporary = `${plist}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await rename(temporary, plist);
      } finally {
        await rm(temporary, { force: true });
      }
      this.checkOpen();
      const result = await this.command(['bootstrap', domain, plist]);
      // Another UI process can register the same scoped job while this one prepares its plist.
      if (result.code !== 0 && (await this.command(['print', target])).code !== 0)
        throw new Error('AGENT_DAEMON_UNAVAILABLE');
    }
    await this.command(['kickstart', target]);
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await this.prepare();
      const current = await this.identity();
      if (current) return current;
      await (this.dependencies.wait ?? wait)(500, this.cancellation.signal);
    }
    throw new Error('AGENT_DAEMON_UNAVAILABLE');
  }
  ensure() {
    this.checkOpen();
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async inactive() {
    this.checkOpen();
    if (this.starting) return false;
    // A missing socket alone can mean launchd is still booting the host. Both owners must be absent.
    const result = await this.command(['print', `gui/${this.uid}/${this.label}`]);
    if (result.code === 0) return false;
    if (result.code !== 113) throw new Error('AGENT_DAEMON_UNAVAILABLE');
    return (await this.identity()) === undefined;
  }
  async close() {
    // The session service owns task lifetime; closing a UI must never unload or signal its launchd job.
    this.closed = true;
    this.cancellation.abort();
  }
}
