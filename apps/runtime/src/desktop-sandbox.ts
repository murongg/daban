import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault } from './control.js';

interface CommandScreen {
  directory: string;
  root: string;
  rootFd: number;
  tempFd: number;
  display: string;
  env: NodeJS.ProcessEnv;
}
const source = path.dirname(fileURLToPath(import.meta.url));
export function desktopCommand(screen: CommandScreen, program: string, args: string[]) {
  const environment: Record<string, string> = {
    PATH: `${screen.root}/shared/.local/bin:/usr/bin:/bin`,
    HOME: path.join(screen.root, 'shared'),
    LANG: 'C.UTF-8',
    DISPLAY: screen.display,
    XAUTHORITY: path.join(screen.directory, 'Xauthority'),
    XDG_CONFIG_HOME: path.join(screen.directory, 'config'),
    XDG_CACHE_HOME: path.join(screen.directory, 'cache'),
    XDG_DATA_HOME: path.join(screen.directory, 'data'),
    XDG_RUNTIME_DIR: path.join(screen.directory, 'runtime'),
  };
  if (screen.env.DBUS_SESSION_BUS_ADDRESS)
    environment.DBUS_SESSION_BUS_ADDRESS = screen.env.DBUS_SESSION_BUS_ADDRESS;
  return {
    program: 'bwrap',
    args: [
      '--die-with-parent',
      '--new-session',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--disable-userns',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/sbin',
      '/sbin',
      ...[
        'fonts',
        'ssl',
        'gtk-3.0',
        'xdg',
        'passwd',
        'group',
        'nsswitch.conf',
        'hosts',
        'resolv.conf',
        'localtime',
        'machine-id',
        'os-release',
        'ld.so.cache',
      ].flatMap((name) => ['--ro-bind-try', `/etc/${name}`, `/etc/${name}`]),
      '--ro-bind',
      path.dirname(path.dirname(process.execPath)),
      '/engine',
      ...['desktop.py', 'viewer.py', 'desktop-files.js'].flatMap((name) => [
        '--ro-bind',
        path.join(source, name),
        `/app/${name === 'desktop-files.js' ? 'files.mjs' : name}`,
      ]),
      '--proc',
      '/proc',
      '--remount-ro',
      '/proc',
      '--dev',
      '/dev',
      '--bind-fd',
      String(screen.tempFd),
      '/tmp',
      // Bind desktop paths after /tmp; synthetic and portable homes may themselves live under /tmp.
      '--bind-fd',
      String(screen.rootFd),
      screen.root,
      '--clearenv',
      ...Object.entries(environment).flatMap(([name, value]) => ['--setenv', name, value]),
      '--remount-ro',
      '/',
      '--chdir',
      screen.root,
      '--',
      program,
      ...args,
    ],
  };
}
export class DesktopSandbox {
  private root?: FileHandle;
  private temp?: FileHandle;
  constructor(
    readonly directory: string,
    readonly privateDirectory: string,
  ) {}
  async start() {
    const overlaps = [
      path.relative(this.directory, this.privateDirectory),
      path.relative(this.privateDirectory, this.directory),
    ];
    if (
      overlaps.some(
        (value) => value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value),
      )
    )
      throw new Fault('DESKTOP_SANDBOX_UNSAFE', 503);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.privateDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.privateDirectory);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700
    )
      throw new Fault('DESKTOP_SANDBOX_UNSAFE', 503);
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    this.root = await open(this.directory, flags);
    try {
      this.temp = await open(this.privateDirectory, flags);
      if (
        (await realpath(`/proc/self/fd/${this.root.fd}`)) !== this.directory ||
        (await realpath(`/proc/self/fd/${this.temp.fd}`)) !== this.privateDirectory
      )
        throw new Fault('DESKTOP_SANDBOX_UNSAFE', 503);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  command(
    screen: Pick<CommandScreen, 'directory' | 'display' | 'env'>,
    program: string,
    args: string[],
  ) {
    if (!this.root || !this.temp) throw new Fault('DESKTOP_SANDBOX_UNAVAILABLE', 503);
    // Bubblewrap consumes the inherited directory FDs; paths writable by desktop apps are never rebound by name.
    return {
      ...desktopCommand({ ...screen, root: this.directory, rootFd: 3, tempFd: 4 }, program, args),
      fds: [this.root.fd, this.temp.fd],
    };
  }
  async io(
    screen: Pick<CommandScreen, 'directory' | 'display' | 'env'>,
    request: {
      op: 'mkdir' | 'read' | 'write';
      file: string;
      text?: string;
      mode?: number;
      exclusive?: boolean;
    },
  ) {
    const output = (
      await this.exec(
        screen,
        '/engine/bin/node',
        ['/app/files.mjs'],
        JSON.stringify({ root: this.directory, ...request }),
      )
    ).stdout.toString('utf8');
    const result = JSON.parse(output) as { ok?: unknown; value?: unknown; error?: unknown };
    if (result.ok !== true)
      throw new Fault(
        typeof result.error === 'string' && /^[A-Z_]+$/.test(result.error)
          ? result.error
          : 'DESKTOP_IO_FAILED',
      );
    return typeof result.value === 'string' ? result.value : '';
  }
  async exec(
    screen: Pick<CommandScreen, 'directory' | 'display' | 'env'>,
    program: string,
    args: string[],
    input?: string,
  ) {
    const command = this.command(screen, program, args);
    return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const child = spawn(command.program, command.args, {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe', ...command.fds],
        timeout: 6000,
        killSignal: 'SIGKILL',
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0;
      for (const [stream, chunks] of [
        [child.stdout!, stdout],
        [child.stderr!, stderr],
      ] as const)
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) child.kill('SIGKILL');
          else chunks.push(chunk);
        });
      child.once('error', () => reject(new Fault('DESKTOP_SANDBOX_UNAVAILABLE', 503)));
      child.once('close', (code) =>
        code === 0 && bytes <= 8 * 1024 * 1024
          ? resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
          : reject(
              new Fault(
                'DESKTOP_COMMAND_FAILED',
                503,
                Buffer.concat(stderr).toString('utf8').slice(0, 2000) || 'Desktop command failed',
              ),
            ),
      );
      // A closed input pipe is reported by the helper result or child exit; it must not crash the service as an unhandled stream error.
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    });
  }
  async close() {
    const handles = [this.root, this.temp];
    this.root = undefined;
    this.temp = undefined;
    for (const handle of handles) await handle?.close();
  }
}
