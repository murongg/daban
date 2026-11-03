import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { validateVmConnection, vmConnectionTarget } from '@daban/engine/host';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import type { VmConnection } from '@daban/protocol';

interface SshChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  once(event: 'error', listener: (error: Error) => unknown): unknown;
  once(event: 'close', listener: (code: number | null) => unknown): unknown;
  kill(): boolean;
}
interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
}
interface Dependencies {
  spawn?: (program: string, args: string[], options: SpawnOptions) => SshChild;
}
export interface ExecutorTunnel {
  readonly alive: boolean;
  connection: { origin: string; token: string };
  close(): Promise<unknown>;
}

export function sshEnvironment() {
  return Object.fromEntries(
    // Windows OpenSSH needs ProgramData even when its config files are explicitly disabled.
    ['SystemRoot', 'WINDIR', 'USERPROFILE', 'ProgramData', 'HOME', 'TEMP', 'TMP'].flatMap((name) =>
      typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : [],
    ),
  );
}

export async function openExecutorTunnel(
  input: VmConnection,
  directory: string,
  port: number,
  startService: boolean,
  signal: AbortSignal,
  dependencies: Dependencies = {},
): Promise<ExecutorTunnel> {
  const connection = Object.freeze(structuredClone(input));
  validateVmConnection(connection);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('EXECUTOR_PORT_UNAVAILABLE');
  signal.throwIfAborted();
  await secureDirectory(path.dirname(connection.identityFile));
  const identity = await lstat(connection.identityFile);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1 ||
    !(await privateMetadata(connection.identityFile, identity, 0o600))
  )
    throw new Error('EXECUTOR_SSH_IDENTITY');
  const root = await secureDirectory(path.join(directory, 'ssh'));
  const known = path.join(root, `host-${randomUUID()}`);
  const alias = `daban-${vmConnectionTarget(connection)}`;
  await writeFile(known, `${alias} ${connection.hostKey}\n`, { flag: 'wx', mode: 0o600 });
  const windows = process.platform === 'win32';
  const empty = windows ? 'NUL' : '/dev/null';
  const program = windows
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/OpenSSH/ssh.exe')
    : '/usr/bin/ssh';
  const settings = [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'HostKeyAlgorithms=ssh-ed25519',
    `HostKeyAlias=${alias}`,
    `UserKnownHostsFile=${JSON.stringify(known.replaceAll('\\', '/'))}`,
    `GlobalKnownHostsFile=${empty}`,
    'UpdateHostKeys=no',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'ForwardAgent=no',
    'ForwardX11=no',
    'PermitLocalCommand=no',
    'ProxyCommand=none',
    'ProxyJump=none',
    'ExitOnForwardFailure=yes',
    'ConnectTimeout=5',
    'ServerAliveInterval=10',
    'ServerAliveCountMax=3',
  ];
  const script = [
    'set -eu',
    ...(startService
      ? ['systemctl start daban-executor.service']
      : ['systemctl is-active --quiet daban-executor.service']),
    'for i in 1 2 3 4 5 6 7 8 9 10; do test -f /var/lib/daban-executor/token && break; sleep 1; done',
    'test ! -L /var/lib/daban-executor/token',
    "printf 'DABAN_EXECUTOR:'",
    'cat /var/lib/daban-executor/token',
    'exec /bin/cat >/dev/null',
  ].join('; ');
  const args = [
    '-F',
    empty,
    '-T',
    ...settings.flatMap((setting) => ['-o', setting]),
    '-i',
    connection.identityFile,
    '-p',
    String(connection.sshPort),
    '-l',
    connection.user,
    '-L',
    `127.0.0.1:${port}:127.0.0.1:8766`,
    connection.host,
    `sudo -n /bin/sh -c '${script.replaceAll("'", "'\\''")}'`,
  ];
  try {
    signal.throwIfAborted();
    return await new Promise<ExecutorTunnel>((resolve, reject) => {
      const launch: NonNullable<Dependencies['spawn']> =
        dependencies.spawn ?? ((binary, argv, options) => spawn(binary, argv, options));
      const child = launch(program, args, {
        env: sshEnvironment(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let closed = false,
        ready = false,
        output = '',
        diagnostic = '';
      let exited: () => unknown = () => undefined;
      const completion = new Promise<unknown>((done) => {
        exited = () => done(undefined);
      });
      const kill = () => {
        if (!closed && child.exitCode === null) child.kill();
      };
      const failure = (code: string) => {
        clearTimeout(timeout);
        reject(new Error(code));
        kill();
      };
      const abort = () => failure('EXECUTOR_LINK_CLOSED');
      const timeout = setTimeout(() => failure('EXECUTOR_LINK_UNAVAILABLE'), 20000);
      child.stdin.on('error', () => failure('EXECUTOR_LINK_UNAVAILABLE'));
      child.once('error', () => failure('EXECUTOR_LINK_UNAVAILABLE'));
      child.stderr.on('data', (bytes: Buffer) => {
        diagnostic = (diagnostic + bytes.toString('utf8')).slice(-4096);
      });
      child.once('close', () => {
        closed = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        exited();
        if (!ready)
          reject(
            new Error(
              /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
                diagnostic,
              )
                ? 'EXECUTOR_SSH_HOST_KEY'
                : /Permission denied/i.test(diagnostic)
                  ? 'EXECUTOR_SSH_AUTH'
                  : 'EXECUTOR_LINK_UNAVAILABLE',
            ),
          );
      });
      child.stdout.on('data', (bytes: Buffer) => {
        if (ready) return;
        output += bytes.toString('utf8');
        if (
          output.length > 128 ||
          (output.includes('\n') && !/^DABAN_EXECUTOR:[a-f0-9]{64}\n$/.test(output))
        ) {
          failure('EXECUTOR_AUTH_UNAVAILABLE');
          return;
        }
        const token = /^DABAN_EXECUTOR:([a-f0-9]{64})\n$/.exec(output)?.[1];
        if (!token) return;
        // SSH starts the remote command only after its pinned connection and requested forwarding are established.
        ready = true;
        clearTimeout(timeout);
        resolve({
          get alive() {
            return !closed && child.exitCode === null;
          },
          connection: { origin: `http://127.0.0.1:${port}`, token },
          close: async () => {
            signal.removeEventListener('abort', abort);
            kill();
            await completion;
            await unlink(known).catch(() => {});
          },
        });
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } catch (error) {
    await unlink(known).catch(() => {});
    throw error;
  }
}
