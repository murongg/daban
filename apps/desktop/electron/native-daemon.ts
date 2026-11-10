import { spawn } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { privateMetadata, secureDirectory } from '@daban/engine/local-computer';
import type { RuntimeSnapshot } from '@daban/protocol';
import { type DaemonConfig, daemonScope } from './daemon';
import { RuntimeClient } from './runtime';
import { readAgentToken, unixFetch } from './unix';

export class NativeDaemon {
  private readonly abort = new AbortController();
  private starting?: Promise<{ client: RuntimeClient; snapshot: RuntimeSnapshot }>;
  constructor(
    readonly config: DaemonConfig,
    readonly mode: 'native' | 'vm' = 'native',
  ) {}
  private client() {
    return new RuntimeClient({
      origin: 'http://127.0.0.1:8766',
      agent: true,
      tokenProvider: () => readAgentToken(this.config.dataRoot),
      fetcher: unixFetch(this.config.socketPath, {
        certificateFile: path.join(this.config.dataRoot, 'model/control-certificate.pem'),
      }),
    });
  }
  private async inspect() {
    const fetcher = unixFetch(this.config.socketPath, {
      certificateFile: path.join(this.config.dataRoot, 'model/control-certificate.pem'),
      maxBytes: 65536,
    });
    const response = await fetcher('http://127.0.0.1:8766/agent/identity', {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1500)]),
    });
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      !('scope' in value) ||
      value.scope !== daemonScope(this.config.dataRoot, this.config.vmConfig) ||
      !('dataRoot' in value) ||
      value.dataRoot !== this.config.dataRoot ||
      !('socketPath' in value) ||
      value.socketPath !== this.config.socketPath
    )
      throw new Error('AGENT_DAEMON_SCOPE_MISMATCH');
    const client = this.client();
    const snapshot = await client.status();
    if (snapshot.phase !== 'ready') throw new Error('AGENT_NOT_READY');
    if (this.mode === 'vm' && snapshot.agent?.execution !== 'linux-vm')
      throw new Error('AGENT_DAEMON_MODE_MISMATCH');
    return { client, snapshot };
  }
  ensure() {
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async failure() {
    const file = path.join(this.config.dataRoot, 'progress.json');
    const info = await lstat(file).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 16384 ||
      !(await privateMetadata(file, info, 0o600))
    )
      throw new Error('VM_CONFIG_UNSAFE');
    const handle = await open(file, 'r');
    try {
      const current = await handle.stat();
      if (current.ino !== info.ino || current.dev !== info.dev) throw new Error('VM_CONFIG_UNSAFE');
      const stamp = `${current.ino}:${current.mtimeMs}:${current.ctimeMs}:${current.size}`;
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      return {
        stamp,
        code:
          value &&
          typeof value === 'object' &&
          'phase' in value &&
          value.phase === 'failed' &&
          'error' in value &&
          typeof value.error === 'string' &&
          /^(?:AGENT|EXECUTOR|EXECUTION|RECOVERY|VM|QEMU)_[A-Z0-9_]{1,80}$/.test(value.error)
            ? value.error
            : undefined,
      };
    } finally {
      await handle.close();
    }
  }
  private async start() {
    await secureDirectory(this.config.dataRoot);
    this.abort.signal.throwIfAborted();
    try {
      return await this.inspect();
    } catch (error) {
      if (
        error instanceof Error &&
        ['AGENT_DAEMON_SCOPE_MISMATCH', 'AGENT_DAEMON_MODE_MISMATCH'].includes(error.message)
      )
        throw error;
    }
    for (const file of [this.config.entry, this.config.executable]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('AGENT_PAYLOAD_UNAVAILABLE');
    }
    await mkdir(this.config.dataRoot, { recursive: true });
    const previousFailure = this.mode === 'vm' ? (await this.failure())?.stamp : undefined;
    const output = await open(path.join(this.config.dataRoot, 'agent.log'), 'a', 0o600);
    try {
      const names = [
        'PATH',
        'Path',
        'PATHEXT',
        'SystemRoot',
        'WINDIR',
        'USERPROFILE',
        'APPDATA',
        'ProgramData',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'HOMEDRIVE',
        'HOMEPATH',
        // The host's filtered PowerShell children need these to load Windows CIM modules.
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramW6432',
        'COMSPEC',
        'COMPUTERNAME',
        'PSModulePath',
        'LANG',
      ];
      const env = Object.fromEntries(
        names.flatMap((name) =>
          typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : [],
        ),
      );
      const child = spawn(
        this.config.executable,
        [
          this.config.entry,
          '--data',
          this.config.dataRoot,
          '--socket',
          this.config.socketPath,
          '--vm-config',
          this.config.vmConfig,
          ...(this.mode === 'native' ? ['--mode', 'native'] : []),
          ...(this.config.qemuBundle ? ['--qemu-bundle', this.config.qemuBundle] : []),
        ],
        {
          cwd: this.config.dataRoot,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          detached: true,
          windowsHide: true,
          stdio: ['ignore', output.fd, output.fd],
        },
      );
      await new Promise<unknown>((resolve, reject) => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', reject);
      });
      child.unref();
    } finally {
      await output.close();
    }
    const until = Date.now() + (this.mode === 'vm' ? 180000 : 30000);
    while (Date.now() < until) {
      this.abort.signal.throwIfAborted();
      try {
        return await this.inspect();
      } catch (error) {
        if (
          error instanceof Error &&
          ['AGENT_DAEMON_SCOPE_MISMATCH', 'AGENT_DAEMON_MODE_MISMATCH'].includes(error.message)
        )
          throw error;
      }
      if (this.mode === 'vm') {
        const failure = await this.failure();
        // A retained failure from an earlier launch must not reject a newly admitted retry.
        if (failure?.code && failure.stamp !== previousFailure) throw new Error(failure.code);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('AGENT_NATIVE_UNAVAILABLE');
  }
  async close() {
    this.abort.abort();
  }
}
